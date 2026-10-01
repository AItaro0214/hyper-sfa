// 文字起こし → 結合 → 議事録 の本体（Workflows の step.do に載せる処理）。
// workflows/minutes.js のクラスから呼ぶ。core と settings は deps で受け取る。
// なぜ deps にするか: `cloudflare:workers` や @hyper-sfa/core に依存しないので、node --test で
// step.do を即時実行する偽物と fetch/D1/R2 の偽物だけで流れを確かめられる。
//
// 決まり:
// - 音声の中身は Worker で読まない。R2 の body を Gemini の Files API へそのまま流す。
// - API キーはステップの返り値に入れない（Workflows は返り値を保存するため）。使うステップの中で読む。
// - ステップの失敗は minutes.status = 'failed' と failure に書き、run は正常終了させる。
//   画面の「もう一度試す」が generate を呼べば、done の区切りを飛ばして続きから動く。
// - 区切りは順に実行する（2 時間 = 12 区切り × 数十秒）。並行にするなら子 Workflow に分ける。

const RETRY = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '5 minutes' };
const SMALL = { retries: { limit: 1, delay: '2 seconds' }, timeout: '1 minute' };
const POLL_MAX = 15;
// 何度やっても同じ結果になる失敗。ステップの再試行をさせない
const NON_RETRYABLE = new Set(['blocked', 'not_configured', 'audio_missing', 'material_missing']);
// Gemini は音声を 1 秒 32 トークンで数える。inputTokens には音声分が含まれるので、費用の二重計上を避けるために引く
const GEMINI_AUDIO_TOKENS_PER_SEC = 32;

export class StepError extends Error {
  constructor(kind, message, retryable = true) {
    // step.do が再試行を使い切って投げ直すと、独自のプロパティは失われる。message から戻せるよう kind を埋める
    super(`[${kind}] ${message}`);
    this.kind = kind;
    this.userMessage = message;
    this.retryable = retryable && !NON_RETRYABLE.has(kind);
  }
}

/** 例外を { kind, message, retryable } にする。音声や本文は message に入れない */
function toFailure(e) {
  if (e instanceof StepError) return { kind: e.kind, message: e.userMessage, retryable: e.retryable };
  if (e instanceof TypeError) return { kind: 'provider', message: '通信に失敗しました', retryable: true };
  return { kind: 'internal', message: '内部エラーが起きました', retryable: true };
}
function fromThrown(e) {
  const m = /^\[(\w+)\] ([\s\S]*)$/.exec(String(e?.message ?? ''));
  if (m) return { kind: m[1], message: m[2], retryable: !NON_RETRYABLE.has(m[1]) };
  return { kind: 'internal', message: '内部エラーが起きました', retryable: true };
}

const nowIso = () => new Date().toISOString();
const baseMime = (m) => String(m || 'audio/webm').split(';')[0].trim();
const jst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
const num = (u, ...keys) => {
  for (const k of keys) if (u?.[k] != null) return Number(u[k]) || 0;
  return 0;
};

export function buildVars(minute, counterparts, attendees) {
  return {
    TITLE: minute.title || '',
    DATE: minute.held_at ? jst(minute.held_at) : '',
    COUNTERPARTS: counterparts.map((c) => [c.company, c.department, c.name].filter(Boolean).join(' ')).join('、'),
    ATTENDEES: attendees.join('、'),
    MEMO: minute.memo || '',
  };
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
function geminiError(deps, status, json) {
  const c = deps.classifyGeminiError({ status, json });
  // c.message は提供元の文言なので、利用者に見せる文は種類から作る
  return new StepError(c.kind, providerMessage(c.kind), c.retryable);
}
function openaiError(deps, status, json) {
  const c = deps.classifyOpenAIError({ status, json });
  return new StepError(c.kind, providerMessage(c.kind), c.retryable);
}
function providerMessage(kind) {
  switch (kind) {
    case 'not_configured':
      return '設定に問題があります。開発者に連絡してください';
    case 'blocked':
      return 'AI が内容を処理できませんでした';
    case 'rate_limited':
      return 'AI サービスが混み合っています';
    default:
      return 'AI サービスでエラーが起きました';
  }
}

/**
 * Gemini の Files API に R2 の音声をストリームで預ける（Worker は中身を読まない）。
 * 戻り値は { name, uri, mimeType, state }。
 */
export async function uploadToGemini({ env, deps, apiKey, key, mimeType, displayName, bucket }) {
  const f = deps.fetch ?? fetch;
  // 音声は AUDIO、資料は DATA。どちらも Worker は中身を読まない
  const obj = await (bucket ?? env.AUDIO).get(key);
  if (!obj) {
    throw bucket
      ? new StepError('material_missing', '資料が見つかりません（削除された可能性があります）', false)
      : new StepError('audio_missing', '音声が見つかりません（削除された可能性があります）', false);
  }
  const sizeBytes = obj.size;
  const startReq = deps.buildFilesUploadRequest({ apiKey, mimeType, displayName, sizeBytes });
  const startRes = await f(startReq.url, { method: startReq.method, headers: startReq.headers, body: startReq.body });
  if (!startRes.ok) throw geminiError(deps, startRes.status, await readJson(startRes));
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new StepError('provider', 'ファイルの預け先が取得できませんでした');
  // 長さ不明のストリームは fetch に渡せないので FixedLengthStream で長さを明示し、R2 の body をそのまま流す
  let body = obj.body;
  if (typeof FixedLengthStream !== 'undefined') {
    const fls = new FixedLengthStream(sizeBytes);
    obj.body.pipeTo(fls.writable).catch(() => {});
    body = fls.readable;
  }
  const upRes = await f(uploadUrl, { method: 'POST', headers: deps.buildFilesUploadBodyHeaders({ sizeBytes }), body });
  if (!upRes.ok) throw geminiError(deps, upRes.status, await readJson(upRes));
  const json = await readJson(upRes);
  const file = json?.file ?? json ?? {};
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || mimeType, state: file.state || 'PROCESSING' };
}

export async function getGeminiFileState({ deps, apiKey, name }) {
  const f = deps.fetch ?? fetch;
  const req = deps.buildFileGetRequest({ apiKey, name });
  const res = await f(req.url, { method: req.method, headers: req.headers });
  if (!res.ok) throw geminiError(deps, res.status, await readJson(res));
  return await readJson(res);
}

export async function deleteGeminiFile({ deps, apiKey, name }) {
  const f = deps.fetch ?? fetch;
  const req = deps.buildFileDeleteRequest({ apiKey, name });
  await f(req.url, { method: req.method, headers: req.headers });
}

/** generateContent を呼んで { text, usage } を返す。失敗は StepError */
export async function callGemini({ deps, apiKey, model, prompt, parts, maxOutputTokens, schema }) {
  const f = deps.fetch ?? fetch;
  const req = deps.buildGenerateRequest({
    model: model.id,
    apiKey,
    prompt,
    parts,
    schema,
    thinkingLevel: model.thinkingLevel,
    maxOutputTokens,
  });
  const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body });
  const json = await readJson(res);
  if (!res.ok) throw geminiError(deps, res.status, json);
  const r = deps.parseGenerateResponse(json);
  if (r.blocked) throw new StepError('blocked', providerMessage('blocked'), false);
  // 上限で打ち切られた応答は途中で切れた文字起こしになる。失敗にして再試行する
  if (r.finishReason === 'MAX_TOKENS') throw new StepError('truncated', '出力が途中で切れました');
  if (!r.text || !r.text.trim()) throw new StepError('empty', '結果が空でした');
  return {
    text: r.text,
    usage: { inputTokens: num(r.usage, 'inputTokens'), outputTokens: num(r.usage, 'outputTokens') + num(r.usage, 'thoughtTokens') },
  };
}

export async function callOpenAIChat({ deps, apiKey, model, prompt, maxOutputTokens }) {
  const f = deps.fetch ?? fetch;
  const req = deps.buildChatRequest({ model: model.id, apiKey, system: '', user: prompt, maxOutputTokens, reasoningEffort: model.thinkingLevel });
  const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body });
  const json = await readJson(res);
  if (!res.ok) throw openaiError(deps, res.status, json);
  const r = deps.parseChatResponse(json);
  if (r.finishReason === 'length') throw new StepError('truncated', '出力が途中で切れました');
  if (!r.text || !r.text.trim()) throw new StepError('empty', '結果が空でした');
  return { text: r.text, usage: { inputTokens: num(r.usage, 'inputTokens'), outputTokens: num(r.usage, 'outputTokens') } };
}

/**
 * OpenAI の Responses API。PDF は /v1/files に預けた file_id で渡す。出力は JSON スキーマで縛れる。
 * 思考に使ったトークンも出力として数える（Gemini の thoughtTokens と同じ扱い）。
 */
export async function callOpenAIResponses({ deps, apiKey, model, parts, jsonSchema, schemaName, maxOutputTokens }) {
  const f = deps.fetch ?? fetch;
  const req = deps.buildResponsesRequest({ model: model.id, apiKey, parts, jsonSchema, schemaName, maxOutputTokens, reasoningEffort: model.thinkingLevel });
  const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body });
  const json = await readJson(res);
  if (!res.ok) throw openaiError(deps, res.status, json);
  const r = deps.parseResponsesResponse(json);
  if (r.incomplete || /max_output|length/i.test(String(r.finishReason ?? ''))) throw new StepError('truncated', '出力が途中で切れました');
  if (!r.text || !r.text.trim()) throw new StepError('empty', '結果が空でした');
  return {
    text: r.text,
    usage: { inputTokens: num(r.usage, 'inputTokens'), outputTokens: num(r.usage, 'outputTokens') + num(r.usage, 'thoughtTokens') },
  };
}

/**
 * OpenAI の Files API に R2 の資料をストリームで預ける（Worker は中身を読まない）。戻り値は file_id。
 * multipart の本文は「prefix + ファイルのバイト列 + suffix」。prefix と suffix は TransformStream の start / flush で
 * 1 回ずつ足すだけで、ファイルの中身は R2 → OpenAI へ素通しする。長さは足し算で分かるので FixedLengthStream で明示する。
 */
export async function uploadToOpenAI({ env, deps, apiKey, key, filename, contentType }) {
  const f = deps.fetch ?? fetch;
  const obj = await env.DATA.get(key);
  if (!obj) throw new StepError('material_missing', '資料が見つかりません（削除された可能性があります）', false);
  const req = deps.buildOpenAIFileUploadRequest({ apiKey, filename, contentType, purpose: 'user_data' });
  const framed = new TransformStream({
    start(controller) {
      controller.enqueue(req.prefix);
    },
    flush(controller) {
      controller.enqueue(req.suffix);
    },
  });
  obj.body.pipeTo(framed.writable).catch(() => {});
  let body = framed.readable;
  if (typeof FixedLengthStream !== 'undefined') {
    const fls = new FixedLengthStream(req.prefix.length + obj.size + req.suffix.length);
    framed.readable.pipeTo(fls.writable).catch(() => {});
    body = fls.readable;
  }
  const res = await f(req.url, { method: req.method, headers: req.headers, body, duplex: 'half' });
  const json = await readJson(res);
  if (!res.ok) throw openaiError(deps, res.status, json);
  const id = deps.parseOpenAIFileResponse(json)?.id;
  if (!id) throw new StepError('provider', 'ファイルの預け先が取得できませんでした');
  return id;
}

export async function deleteOpenAIFile({ deps, apiKey, fileId }) {
  const f = deps.fetch ?? fetch;
  const req = deps.buildOpenAIFileDeleteRequest({ apiKey, fileId });
  await f(req.url, { method: req.method, headers: req.headers });
}

/**
 * OpenAI の文字起こし。multipart に Blob が要るので、ここだけ音声を Worker のメモリに読む。
 * 区切りは 2.4MB ほどで、blob() は CPU をほとんど使わない（コピーだけ）ので許容する。
 */
export async function callOpenAITranscribe({ env, deps, apiKey, model, key, mimeType, prompt }) {
  const f = deps.fetch ?? fetch;
  const obj = await env.AUDIO.get(key);
  if (!obj) throw new StepError('audio_missing', '音声が見つかりません（削除された可能性があります）', false);
  const blob = await obj.blob();
  const req = deps.buildTranscriptionRequest({ model: model.id, apiKey, audio: blob, mimeType, prompt, language: 'ja' });
  const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body });
  const json = await readJson(res);
  if (!res.ok) throw openaiError(deps, res.status, json);
  const r = deps.parseTranscriptionResponse(json);
  if (!r.text || !r.text.trim()) throw new StepError('empty', '結果が空でした');
  return { text: r.text, usage: { inputTokens: num(r.usage, 'inputTokens'), outputTokens: num(r.usage, 'outputTokens') } };
}

/** 利用量の記録。失敗しても処理は止めない */
async function recordUse(env, deps, o) {
  try {
    const inputTokens = o.usage?.inputTokens ?? 0;
    const outputTokens = o.usage?.outputTokens ?? 0;
    const audioSeconds = o.audioSeconds ?? 0;
    let cost = 0;
    if (o.ok || inputTokens || outputTokens) {
      const nonAudioIn =
        o.model.provider === 'gemini' && audioSeconds > 0
          ? Math.max(0, inputTokens - audioSeconds * GEMINI_AUDIO_TOKENS_PER_SEC)
          : inputTokens;
      cost = deps.estimateCost({ model: o.model, inputTokens: nonAudioIn, outputTokens, audioSeconds, date: new Date() });
    }
    const ev = deps.usageEvent({
      kind: o.kind,
      userId: o.userId,
      modelId: o.model.id,
      inputTokens,
      outputTokens,
      audioSeconds,
      ok: o.ok,
      failureKind: o.failureKind ?? null,
      retry: Boolean(o.retry),
      cost,
    });
    await deps.recordUsage(env, { ...ev, cost });
  } catch {
    // 無視
  }
}

export async function markFailed(env, minuteId, failStep, failure) {
  await env.DB.prepare("UPDATE minutes SET status = 'failed', step = NULL, failure = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify({ step: failStep, ...failure }), nowIso(), minuteId)
    .run();
}

/**
 * Workflow の本体。event.payload = { minuteId, target } か、{ test: true, ... }。
 * step は Workflows の step（do / sleep）。
 */
export async function runMinutesPipeline({ env, deps, event, step }) {
  const payload = event.payload ?? {};
  if (payload.test) return await runTest({ env, deps, payload, step });
  const { minuteId } = payload;
  const target = payload.target ?? 'generate';
  // 資料を踏まえた議事録は、議事録だけの作り直しのときだけ（文字起こしは触らない）
  const withMaterials = target === 'summary' && payload.withMaterials === true;
  let counter = 0;

  /** step.do を包む。再試行しても無駄な失敗は ok:false で返し、再試行を使い切った失敗も ok:false にする */
  const guarded = async (name, config, fn) => {
    try {
      return await step.do(name, config, async () => {
        try {
          return { ok: true, value: await fn() };
        } catch (e) {
          const f = toFailure(e);
          if (!f.retryable) return { ok: false, failure: f };
          throw new Error(`[${f.kind}] ${f.message}`);
        }
      });
    } catch (e) {
      return { ok: false, failure: fromThrown(e) };
    }
  };
  const fail = async (failStep, failure) => {
    await step.do(`fail-${failStep}-${++counter}`, SMALL, async () => {
      await markFailed(env, minuteId, failStep, failure);
      return true;
    });
  };

  try {
    // ---- load: 設定・モデル・プロンプト・区切りの一覧。API キーはここでは返さない ----
    const loaded = await step.do('load', SMALL, async () => {
      const m = await env.DB.prepare('SELECT * FROM minutes WHERE id = ? AND deleted_at IS NULL').bind(minuteId).first();
      if (!m) return { missing: true };
      const segs = (
        await env.DB.prepare(
          'SELECT seq, key, mime, start_sec, duration_sec, size, transcript_key, transcript_status FROM minute_segments WHERE minute_id = ? AND uploaded = 1 ORDER BY seq',
        )
          .bind(minuteId)
          .all()
      ).results;
      const cps = (
        await env.DB.prepare('SELECT company, department, name FROM minute_counterparts WHERE minute_id = ? ORDER BY seq')
          .bind(minuteId)
          .all()
      ).results;
      const ats = (
        await env.DB.prepare('SELECT u.display_name FROM minute_attendees a JOIN users u ON u.id = a.user_id WHERE a.minute_id = ?')
          .bind(minuteId)
          .all()
      ).results.map((r) => r.display_name);
      const tModel = await deps.getModel(env, await deps.getSelectedModel(env, 'transcribe'));
      const sModel = await deps.getModel(env, await deps.getSelectedModel(env, 'summarize'));
      const configErr = async (model, label) => {
        if (!model) return `${label}のモデルが設定されていません`;
        const k = await deps.getApiKey(env, model.provider);
        return k ? null : `${model.provider} の API キーが登録されていません`;
      };
      const err = (target !== 'summary' ? await configErr(tModel, '文字起こし') : null) ?? (await configErr(sModel, '議事録'));
      const tPrompt = await deps.getPrompt(env, 'transcribe');
      const sPrompt = await deps.getPrompt(env, 'summarize');
      let materials = [];
      let oPrompt = null;
      let smPrompt = null;
      if (withMaterials) {
        materials = (
          await env.DB.prepare(
            "SELECT id, seq, name, kind, size, pages, key, extract_key, outline_key, outline_status FROM minute_materials WHERE minute_id = ? AND outline_status != 'uploading' ORDER BY seq",
          )
            .bind(minuteId)
            .all()
        ).results;
        oPrompt = (await deps.getPrompt(env, 'outline')).text;
        smPrompt = (await deps.getPrompt(env, 'summarize_materials')).text;
      }
      return {
        missing: false,
        configError: err,
        owner: m.owner_id,
        tVersion: (m.transcript_version ?? 0) + 1,
        sVersion: (m.summary_version ?? 0) + 1,
        // すでに版があれば、これは「やり直し」として数える
        transcribeIsRetry: (m.transcript_version ?? 0) > 0,
        summarizeIsRetry: (m.summary_version ?? 0) > 0,
        segments: segs,
        vars: buildVars(m, cps, ats),
        tModel,
        sModel,
        tPrompt: tPrompt.text,
        sPrompt: sPrompt.text,
        materials,
        oPrompt,
        smPrompt,
      };
    });
    if (loaded.missing) return { ok: false, reason: 'missing' };
    if (loaded.configError) {
      await fail(target === 'summary' ? 'summarize' : 'transcribe', {
        kind: 'not_configured',
        message: `設定に問題があります。開発者に連絡してください（${loaded.configError}）`,
        retryable: false,
      });
      return { ok: false, reason: 'config' };
    }

    const total = loaded.segments.length;

    // ---- 文字起こし（区切りごと。done は飛ばす） ----
    if (target !== 'summary') {
      if (total === 0) {
        await fail('transcribe', { kind: 'empty', message: '音声がありません', retryable: false });
        return { ok: false, reason: 'no_segments' };
      }
      const model = loaded.tModel;
      const transcribePrompt = deps.renderPrompt(loaded.tPrompt, loaded.vars);
      let done = loaded.segments.filter((s) => s.transcript_status === 'done').length;
      await step.do('status-transcribing', SMALL, async () => {
        await env.DB.prepare(
          "UPDATE minutes SET status = 'transcribing', step = 'transcribe', failure = NULL, progress = ?, updated_at = ? WHERE id = ?",
        )
          .bind(JSON.stringify({ segmentsDone: done, segmentsTotal: total }), nowIso(), minuteId)
          .run();
        return true;
      });

      for (const seg of loaded.segments) {
        if (seg.transcript_status === 'done') continue;
        const mimeType = baseMime(seg.mime);
        let file = null;

        if (model.provider === 'gemini') {
          const up = await guarded(`upload-${seg.seq}`, RETRY, async () => {
            const apiKey = await deps.getApiKey(env, 'gemini');
            return await uploadToGemini({ env, deps, apiKey, key: seg.key, mimeType, displayName: `${minuteId}-${seg.seq}` });
          });
          if (!up.ok) {
            await recordUse(env, deps, { kind: 'transcribe', userId: loaded.owner, model, ok: false, failureKind: up.failure.kind, retry: loaded.transcribeIsRetry });
            await fail('transcribe', up.failure);
            return { ok: false, reason: 'upload' };
          }
          file = up.value;
          // 預けた直後は PROCESSING のことがある。ACTIVE になるまで、寝てから確かめる
          for (let i = 0; file.state !== 'ACTIVE' && file.state !== 'FAILED' && i < POLL_MAX; i++) {
            await step.sleep(`wait-${seg.seq}-${i}`, '3 seconds');
            const cur = file;
            const st = await guarded(`check-${seg.seq}-${i}`, SMALL, async () => {
              const apiKey = await deps.getApiKey(env, 'gemini');
              const j = await getGeminiFileState({ deps, apiKey, name: cur.name });
              return { ...cur, state: j?.state ?? cur.state };
            });
            if (!st.ok) {
              await fail('transcribe', st.failure);
              return { ok: false, reason: 'check' };
            }
            file = st.value;
          }
          if (file.state !== 'ACTIVE') {
            await fail('transcribe', { kind: 'provider', message: '音声の準備が終わりませんでした', retryable: true });
            return { ok: false, reason: 'not_active' };
          }
        }

        const tr = await guarded(`transcribe-${seg.seq}`, RETRY, async () => {
          const apiKey = await deps.getApiKey(env, model.provider);
          let r;
          try {
            if (model.provider === 'gemini') {
              r = await callGemini({
                deps,
                apiKey,
                model,
                prompt: transcribePrompt,
                parts: [{ fileData: { fileUri: file.uri, mimeType: file.mimeType || mimeType } }],
                maxOutputTokens: 16384,
              });
            } else {
              // OpenAI のプロンプトは短い手がかりだけ（長いと受け付けないモデルがある）
              const hint = `会議: ${loaded.vars.TITLE}。相手: ${loaded.vars.COUNTERPARTS}。同席: ${loaded.vars.ATTENDEES}`.slice(0, 400);
              r = await callOpenAITranscribe({ env, deps, apiKey, model, key: seg.key, mimeType, prompt: hint });
            }
          } catch (e) {
            await recordUse(env, deps, { kind: 'transcribe', userId: loaded.owner, model, ok: false, failureKind: toFailure(e).kind, retry: loaded.transcribeIsRetry });
            throw e;
          }
          const outKey = `minutes/${minuteId}/seg-${seg.seq}-v${loaded.tVersion}.txt`;
          await env.DATA.put(outKey, r.text);
          // 再試行で二重に数えないよう、done は D1 の値から数え直す
          await env.DB.prepare("UPDATE minute_segments SET transcript_key = ?, transcript_status = 'done' WHERE minute_id = ? AND seq = ?")
            .bind(outKey, minuteId, seg.seq)
            .run();
          const cnt = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM minute_segments WHERE minute_id = ? AND uploaded = 1 AND transcript_status = 'done'",
          )
            .bind(minuteId)
            .first();
          done = cnt?.n ?? done + 1;
          await env.DB.prepare('UPDATE minutes SET progress = ?, updated_at = ? WHERE id = ?')
            .bind(JSON.stringify({ segmentsDone: done, segmentsTotal: total }), nowIso(), minuteId)
            .run();
          await recordUse(env, deps, { kind: 'transcribe', userId: loaded.owner, model, ok: true, usage: r.usage, audioSeconds: seg.duration_sec, retry: loaded.transcribeIsRetry });
          return { key: outKey };
        });
        if (file?.name) {
          // 預けたファイルは使い終わったら消す（48 時間で自動でも消える）。失敗しても続ける
          const name = file.name;
          await step.do(`cleanup-${seg.seq}`, SMALL, async () => {
            try {
              await deleteGeminiFile({ deps, apiKey: await deps.getApiKey(env, 'gemini'), name });
            } catch {
              // 無視
            }
            return true;
          });
        }
        if (!tr.ok) {
          await fail('transcribe', tr.failure);
          return { ok: false, reason: 'transcribe' };
        }
      }

      // ---- join ----
      const joined = await guarded('join', SMALL, async () => {
        const rows = (
          await env.DB.prepare(
            "SELECT seq, start_sec, transcript_key FROM minute_segments WHERE minute_id = ? AND uploaded = 1 AND transcript_status = 'done' ORDER BY seq",
          )
            .bind(minuteId)
            .all()
        ).results;
        const parts = [];
        for (const r of rows) {
          const o = await env.DATA.get(r.transcript_key);
          parts.push({ startSec: r.start_sec, text: o ? await o.text() : '' });
        }
        // joinSegments が区切りの開始時刻を足して通しの時刻にそろえる（ここで先に offsetTimestamps すると二重に足される）
        const text = deps.joinSegments(parts);
        const newKey = `minutes/${minuteId}/transcript-v${loaded.tVersion}.txt`;
        await env.DATA.put(newKey, text);
        const cur = await env.DB.prepare('SELECT transcript_key, transcript_prev_key FROM minutes WHERE id = ?').bind(minuteId).first();
        // 再試行されても prev を壊さないよう、すでに新しい版になっていれば触らない
        if (cur.transcript_key !== newKey) {
          await env.DB.prepare(
            'UPDATE minutes SET transcript_prev_key = transcript_key, transcript_key = ?, transcript_version = ?, transcript_model = ?, transcript_at = ?, updated_at = ? WHERE id = ?',
          )
            .bind(newKey, loaded.tVersion, model.id, nowIso(), nowIso(), minuteId)
            .run();
          // 2 つ前の版は戻れないので消す
          if (cur.transcript_prev_key && cur.transcript_prev_key !== newKey) await env.DATA.delete(cur.transcript_prev_key);
        }
        return { key: newKey };
      });
      if (!joined.ok) {
        await fail('transcribe', joined.failure);
        return { ok: false, reason: 'join' };
      }
    }

    // ---- 議事録 ----
    const sum = withMaterials
      ? await summarizeWithMaterials({ env, deps, step, guarded, loaded, minuteId })
      : await guarded('summarize', RETRY, async () => {
      const model = loaded.sModel;
      const cur = await env.DB.prepare('SELECT transcript_key, summary_key, summary_prev_key, summary_prev_mapping_key FROM minutes WHERE id = ?').bind(minuteId).first();
      if (!cur?.transcript_key) throw new StepError('empty', '文字起こしがありません', false);
      await env.DB.prepare("UPDATE minutes SET status = 'summarizing', step = 'summarize', failure = NULL, updated_at = ? WHERE id = ?")
        .bind(nowIso(), minuteId)
        .run();
      const o = await env.DATA.get(cur.transcript_key);
      const transcript = o ? await o.text() : '';
      const prompt = deps.renderPrompt(loaded.sPrompt, { ...loaded.vars, TRANSCRIPT: transcript });
      const apiKey = await deps.getApiKey(env, model.provider);
      let r;
      try {
        r =
          model.provider === 'gemini'
            ? await callGemini({ deps, apiKey, model, prompt, parts: [], maxOutputTokens: 16384 })
            : await callOpenAIChat({ deps, apiKey, model, prompt, maxOutputTokens: 16384 });
      } catch (e) {
        await recordUse(env, deps, { kind: 'summarize', userId: loaded.owner, model, ok: false, failureKind: toFailure(e).kind, retry: loaded.summarizeIsRetry });
        throw e;
      }
      const newKey = `minutes/${minuteId}/summary-v${loaded.sVersion}.md`;
      await env.DATA.put(newKey, r.text);
      await saveSummary({ env, minuteId, cur, newKey, version: loaded.sVersion, modelId: model.id, withMaterials: false });
      await recordUse(env, deps, { kind: 'summarize', userId: loaded.owner, model, ok: true, usage: r.usage, retry: loaded.summarizeIsRetry });
      return { key: newKey };
    });
    if (!sum.ok) {
      await fail('summarize', sum.failure);
      return { ok: false, reason: 'summarize' };
    }

    await step.do('finish', SMALL, async () => {
      await env.DB.prepare("UPDATE minutes SET status = 'done', step = NULL, failure = NULL, updated_at = ? WHERE id = ?")
        .bind(nowIso(), minuteId)
        .run();
      return true;
    });
    return { ok: true };
  } catch (e) {
    // 想定外の例外でも Workflow を失敗で終わらせず、画面に「もう一度試す」を出す
    try {
      await markFailed(env, minuteId, target === 'summary' ? 'summarize' : 'transcribe', toFailure(e));
    } catch {
      // 無視
    }
    return { ok: false, reason: 'exception' };
  }
}

/**
 * 新しい議事録の版を保存する。前の版は prev に回し、2 つ前は消す。
 * 資料を踏まえた版かどうか・対応表も prev に回す（「前の内容に戻す」で一緒に戻るように）。
 * 再試行されても prev を壊さないよう、すでに新しい版になっていれば触らない。SET の右辺は更新前の値で評価される。
 */
async function saveSummary({ env, minuteId, cur, newKey, version, modelId, withMaterials, materialIds = [], mappingKey = null }) {
  if (cur.summary_key === newKey) return;
  await env.DB.prepare(
    `UPDATE minutes SET summary_prev_key = summary_key, summary_key = ?, summary_version = ?, summary_model = ?, summary_at = ?, updated_at = ?,
       summary_prev_with_materials = summary_with_materials, summary_prev_mapping_key = summary_mapping_key,
       summary_with_materials = ?, summary_material_ids = ?, summary_mapping_key = ? WHERE id = ?`,
  )
    .bind(newKey, version, modelId, nowIso(), nowIso(), withMaterials ? 1 : 0, JSON.stringify(materialIds), mappingKey, minuteId)
    .run();
  if (cur.summary_prev_key && cur.summary_prev_key !== newKey) await env.DATA.delete(cur.summary_prev_key);
  if (cur.summary_prev_mapping_key && cur.summary_prev_mapping_key !== mappingKey) await env.DATA.delete(cur.summary_prev_mapping_key);
}

const outlineKeyOf = (minuteId, m) => m.outline_key || `minutes/${minuteId}/materials/${m.id}.outline.json`;

/** 目次の JSON を取り出す。sections が無ければ失敗（空の目次を保存しない）。途中で切れていれば読めた分を使う */
function parseOutline(deps, text) {
  let v;
  try {
    v = deps.extractJson(text).value;
  } catch {
    throw new StepError('empty', '目次を読み取れませんでした');
  }
  if (!v || !Array.isArray(v.sections) || v.sections.length === 0) throw new StepError('empty', '目次が空でした');
  return v;
}

/** PDF 1 件の目次化。失敗しても例外にせず、その資料を failed にして呼び出し元は続行する */
async function outlinePdf({ env, deps, step, guarded, loaded, minuteId, m }) {
  const model = loaded.sModel;
  const outlineKey = outlineKeyOf(minuteId, m);
  const prompt = deps.renderPrompt(loaded.oPrompt, { NAME: m.name, KIND: m.kind });
  let file = null;
  let failure = null;

  if (model.provider === 'gemini') {
    const up = await guarded(`outline-upload-${m.seq}`, RETRY, async () => {
      const apiKey = await deps.getApiKey(env, 'gemini');
      return await uploadToGemini({ env, deps, apiKey, key: m.key, mimeType: 'application/pdf', displayName: `${minuteId}-mat-${m.seq}`, bucket: env.DATA });
    });
    if (up.ok) {
      file = up.value;
      // 預けた直後は PROCESSING のことがある。ACTIVE になるまで、寝てから確かめる
      for (let i = 0; file.state !== 'ACTIVE' && file.state !== 'FAILED' && i < POLL_MAX; i++) {
        await step.sleep(`outline-wait-${m.seq}-${i}`, '3 seconds');
        const cur = file;
        const st = await guarded(`outline-check-${m.seq}-${i}`, SMALL, async () => {
          const apiKey = await deps.getApiKey(env, 'gemini');
          const j = await getGeminiFileState({ deps, apiKey, name: cur.name });
          return { ...cur, state: j?.state ?? cur.state };
        });
        if (!st.ok) {
          failure = st.failure;
          break;
        }
        file = st.value;
      }
      if (!failure && file.state !== 'ACTIVE') failure = { kind: 'provider', message: '資料の準備が終わりませんでした', retryable: true };
    } else {
      failure = up.failure;
    }
  }

  if (!failure) {
    const r = await guarded(`outline-${m.seq}`, RETRY, async () => {
      const apiKey = await deps.getApiKey(env, model.provider);
      let out;
      let openaiFileId = null;
      try {
        if (model.provider === 'gemini') {
          out = await callGemini({
            deps,
            apiKey,
            model,
            prompt,
            parts: [{ fileData: { fileUri: file.uri, mimeType: file.mimeType || 'application/pdf' } }],
            schema: deps.OUTLINE_SCHEMA, // buildGenerateRequest が Gemini 向けに type を大文字にする
            maxOutputTokens: 32768,
          });
        } else {
          openaiFileId = await uploadToOpenAI({ env, deps, apiKey, key: m.key, filename: m.name, contentType: 'application/pdf' });
          out = await callOpenAIResponses({
            deps,
            apiKey,
            model,
            parts: [{ type: 'input_file', fileId: openaiFileId }, { type: 'input_text', text: prompt }],
            jsonSchema: deps.OUTLINE_SCHEMA,
            schemaName: 'outline',
            maxOutputTokens: 32768,
          });
        }
      } catch (e) {
        await recordUse(env, deps, { kind: 'summarize', userId: loaded.owner, model, ok: false, failureKind: toFailure(e).kind, retry: true });
        throw e;
      } finally {
        // 預けた資料は使い終わったらすぐ消す。失敗しても続ける
        if (openaiFileId) await deleteOpenAIFile({ deps, apiKey, fileId: openaiFileId }).catch(() => {});
      }
      const outline = parseOutline(deps, out.text);
      await env.DATA.put(outlineKey, JSON.stringify(outline));
      await env.DB.prepare("UPDATE minute_materials SET outline_key = ?, outline_status = 'done' WHERE id = ?").bind(outlineKey, m.id).run();
      await recordUse(env, deps, { kind: 'summarize', userId: loaded.owner, model, ok: true, usage: out.usage, retry: true });
      return { key: outlineKey };
    });
    if (!r.ok) failure = r.failure;
  }

  if (file?.name) {
    const name = file.name;
    await step.do(`outline-cleanup-${m.seq}`, SMALL, async () => {
      try {
        await deleteGeminiFile({ deps, apiKey: await deps.getApiKey(env, 'gemini'), name });
      } catch {
        // 無視
      }
      return true;
    });
  }
  if (failure) {
    // 目次が作れなくても議事録は作る。その資料は名前だけ渡す
    await step.do(`outline-failed-${m.seq}`, SMALL, async () => {
      await env.DB.prepare("UPDATE minute_materials SET outline_status = 'failed' WHERE id = ?").bind(m.id).run();
      return true;
    });
  }
}

/**
 * 資料を踏まえた議事録（minutes-design.md §15.4 / §15.5）。guarded と同じ { ok, value | failure } を返す。
 * 1 段目: PDF はモデルで、pptx / xlsx は抜いた JSON から機械的に、資料ごとの目次にする。
 * 2 段目: 目次 + 文字起こしから、対応表と議事録を JSON で 1 回で出させる。
 */
async function summarizeWithMaterials({ env, deps, step, guarded, loaded, minuteId }) {
  const model = loaded.sModel;
  const mats = loaded.materials ?? [];
  if (mats.length === 0) return { ok: false, failure: { kind: 'empty', message: '資料がありません', retryable: false } };

  await step.do('status-outline', SMALL, async () => {
    await env.DB.prepare("UPDATE minutes SET status = 'summarizing', step = 'outline', failure = NULL, updated_at = ? WHERE id = ?")
      .bind(nowIso(), minuteId)
      .run();
    return true;
  });

  for (const m of mats) {
    if (m.kind === 'pdf') {
      // done は作り直さない。failed は、利用者が「作り直す」を押したので、もう一度試す
      if (m.outline_status !== 'pending' && m.outline_status !== 'failed') continue;
      await outlinePdf({ env, deps, step, guarded, loaded, minuteId, m });
    } else if (m.extract_key) {
      // 文章の JSON なので Worker で読んでよい。モデルは使わない。失敗しても名前だけ渡して続ける
      await guarded(`outline-${m.seq}`, SMALL, async () => {
        const o = await env.DATA.get(m.extract_key);
        if (!o) throw new StepError('material_missing', '抜いた内容が見つかりません', false);
        const outline = deps.outlineFromExtract(JSON.parse(await o.text()), { name: m.name });
        await env.DATA.put(outlineKeyOf(minuteId, m), JSON.stringify(outline));
        return true;
      });
    }
  }

  return await guarded('summarize-materials', { ...RETRY, timeout: '10 minutes' }, async () => {
    const cur = await env.DB.prepare('SELECT transcript_key, summary_key, summary_prev_key, summary_prev_mapping_key FROM minutes WHERE id = ?').bind(minuteId).first();
    if (!cur?.transcript_key) throw new StepError('empty', '文字起こしがありません', false);
    await env.DB.prepare("UPDATE minutes SET status = 'summarizing', step = 'summarize_materials', failure = NULL, updated_at = ? WHERE id = ?")
      .bind(nowIso(), minuteId)
      .run();
    const to = await env.DATA.get(cur.transcript_key);
    const transcript = to ? await to.text() : '';
    // 目次が作れていない資料は outline: null（名前だけ渡る）
    const withOutline = [];
    for (const m of mats) {
      let outline = null;
      const o = await env.DATA.get(outlineKeyOf(minuteId, m));
      if (o) {
        try {
          outline = JSON.parse(await o.text());
        } catch {
          outline = null;
        }
      }
      withOutline.push({ seq: m.seq, name: m.name, kind: m.kind, outline });
    }
    const prompt = deps.renderPrompt(loaded.smPrompt, {
      ...loaded.vars,
      MATERIALS: deps.formatMaterialsForPrompt(withOutline),
      TRANSCRIPT: transcript,
    });
    const apiKey = await deps.getApiKey(env, model.provider);
    let r;
    try {
      r =
        model.provider === 'gemini'
          ? await callGemini({ deps, apiKey, model, prompt, parts: [], schema: deps.MATERIAL_SUMMARY_SCHEMA, maxOutputTokens: 32768 })
          : await callOpenAIResponses({
              deps,
              apiKey,
              model,
              parts: [{ type: 'input_text', text: prompt }],
              jsonSchema: deps.MATERIAL_SUMMARY_SCHEMA,
              schemaName: 'material_summary',
              maxOutputTokens: 32768,
            });
    } catch (e) {
      await recordUse(env, deps, { kind: 'summarize', userId: loaded.owner, model, ok: false, failureKind: toFailure(e).kind, retry: true });
      throw e;
    }
    let parsed;
    try {
      const ex = deps.extractJson(r.text);
      if (ex.truncated) throw new Error('truncated');
      parsed = ex.value;
    } catch {
      await recordUse(env, deps, { kind: 'summarize', userId: loaded.owner, model, ok: false, failureKind: 'empty', retry: true, usage: r.usage });
      throw new StepError('empty', '結果を読み取れませんでした');
    }
    if (typeof parsed?.markdown !== 'string' || !parsed.markdown.trim()) {
      await recordUse(env, deps, { kind: 'summarize', userId: loaded.owner, model, ok: false, failureKind: 'empty', retry: true, usage: r.usage });
      throw new StepError('empty', '結果が空でした');
    }
    const nameBySeq = new Map(mats.map((m) => [Number(m.seq), m.name]));
    // 資料を後から消されても名前が出せるよう、対応表に名前を持たせる
    const mapping = deps.normalizeMapping(parsed.mapping, mats).map((x) => ({ ...x, materialName: nameBySeq.get(x.material) ?? '' }));
    const newKey = `minutes/${minuteId}/summary-v${loaded.sVersion}.md`;
    const mappingKey = `minutes/${minuteId}/summary-mapping-v${loaded.sVersion}.json`;
    await env.DATA.put(newKey, parsed.markdown);
    await env.DATA.put(mappingKey, JSON.stringify(mapping));
    await saveSummary({
      env,
      minuteId,
      cur,
      newKey,
      version: loaded.sVersion,
      modelId: model.id,
      withMaterials: true,
      materialIds: mats.map((m) => m.id),
      mappingKey,
    });
    await recordUse(env, deps, { kind: 'summarize', userId: loaded.owner, model, ok: true, usage: r.usage, retry: true });
    return { key: newKey };
  });
}

/** 開発コンソールの「試し」。結果は settings の test:<jobId> に書く */
async function runTest({ env, deps, payload, step }) {
  const { jobId, kind, audioKey, transcript, promptText, modelId, userId } = payload;
  const key = `test:${jobId}`;
  const write = (obj) =>
    env.DB.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?').bind(JSON.stringify(obj), nowIso(), key).run();
  const started = Date.now();
  const model = await step.do('test-load', SMALL, async () => (await deps.getModel(env, modelId)) ?? null);
  if (!model) {
    await step.do('test-fail', SMALL, async () => {
      await write({ status: 'error', userId, error: { kind: 'not_configured', message: 'モデルが見つかりません' } });
      return true;
    });
    return { ok: false };
  }
  const emptyVars = { TITLE: '', DATE: '', COUNTERPARTS: '', ATTENDEES: '', MEMO: '' };
  const needKey = async (provider) => {
    const k = await deps.getApiKey(env, provider);
    if (!k) throw new StepError('not_configured', 'API キーが登録されていません', false);
    return k;
  };
  let result;
  try {
    if (kind === 'summarize') {
      result = await step.do('test-summarize', RETRY, async () => {
        const apiKey = await needKey(model.provider);
        const prompt = deps.renderPrompt(promptText, { ...emptyVars, TRANSCRIPT: transcript ?? '' });
        const out =
          model.provider === 'gemini'
            ? await callGemini({ deps, apiKey, model, prompt, parts: [], maxOutputTokens: 16384 })
            : await callOpenAIChat({ deps, apiKey, model, prompt, maxOutputTokens: 16384 });
        return { text: out.text, usage: out.usage, audioSeconds: 0 };
      });
    } else {
      const prompt = deps.renderPrompt(promptText, emptyVars);
      let file = null;
      let mimeType = 'audio/webm';
      if (model.provider === 'gemini') {
        file = await step.do('test-upload', RETRY, async () => {
          const apiKey = await needKey('gemini');
          const head = await env.AUDIO.head(audioKey);
          if (!head) throw new StepError('audio_missing', '音声が見つかりません', false);
          const mime = baseMime(head.httpMetadata?.contentType);
          const f = await uploadToGemini({ env, deps, apiKey, key: audioKey, mimeType: mime, displayName: `test-${jobId}` });
          return f;
        });
        mimeType = file.mimeType || mimeType;
        for (let i = 0; file.state !== 'ACTIVE' && file.state !== 'FAILED' && i < POLL_MAX; i++) {
          await step.sleep(`test-wait-${i}`, '3 seconds');
          const cur = file;
          file = await step.do(`test-check-${i}`, SMALL, async () => {
            const j = await getGeminiFileState({ deps, apiKey: await needKey('gemini'), name: cur.name });
            return { ...cur, state: j?.state ?? cur.state };
          });
        }
      }
      result = await step.do('test-transcribe', RETRY, async () => {
        const apiKey = await needKey(model.provider);
        const out =
          model.provider === 'gemini'
            ? await callGemini({ deps, apiKey, model, prompt, parts: [{ fileData: { fileUri: file.uri, mimeType } }], maxOutputTokens: 16384 })
            : await callOpenAITranscribe({ env, deps, apiKey, model, key: audioKey, mimeType, prompt: prompt.slice(0, 400) });
        return { text: out.text, usage: out.usage, audioSeconds: 0 };
      });
    }
  } catch (e) {
    result = { error: fromThrown(e) };
  }
  await step.do('test-finish', SMALL, async () => {
    if (result.error) {
      await recordUse(env, deps, { kind: 'test', userId, model, ok: false, failureKind: result.error.kind });
      await write({ status: 'error', userId, error: result.error });
    } else {
      await recordUse(env, deps, { kind: 'test', userId, model, ok: true, usage: result.usage, audioSeconds: result.audioSeconds });
      await write({ status: 'done', userId, text: result.text, usage: result.usage, elapsedMs: Date.now() - started });
    }
    return true;
  });
  return { ok: !result.error };
}
