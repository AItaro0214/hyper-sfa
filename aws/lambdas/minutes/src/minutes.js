// 文字起こし・議事録・ダウンロード用の音声。docs/minutes-design.md §5, §6, §7, §10, §11。
// DynamoDB / S3 / fetch / ffmpeg は deps で受け取る（テストで差し替えるため）。
import {
  renderPrompt, DEFAULT_PROMPTS, DEFAULT_MODELS, DEFAULT_SELECTION,
  buildGenerateRequest, parseGenerateResponse, classifyGeminiError,
  buildTranscriptionRequest, parseTranscriptionResponse,
  buildChatRequest, parseChatResponse, classifyOpenAIError,
  offsetTimestamps, joinSegments, usageEvent,
  extractJson, OUTLINE_SCHEMA, MATERIAL_SUMMARY_SCHEMA, outlineFromExtract, formatMaterialsForPrompt, normalizeMapping,
  toGeminiSchema, buildOpenAIFileUploadRequest, parseOpenAIFileResponse, buildOpenAIFileDeleteRequest,
  buildResponsesRequest, parseResponsesResponse,
} from '@hyper-sfa/core';
import { runPool } from './pool.js';
import { ffmpegPath, splitAudio, planSplit, concatToM4a } from './ffmpeg.js';

const FETCH_TIMEOUT_MS = 60_000;
const CONCURRENCY = 4;
const TRANSCRIBE_MAX_TOKENS = 16000;
const SUMMARIZE_MAX_TOKENS = 8000;
const OUTLINE_MAX_TOKENS = 16000;
const MATERIAL_SUMMARY_MAX_TOKENS = 16000;
const OUTLINE_CONCURRENCY = 3;
// Gemini の inlineData はリクエスト全体で 20MB。base64 で 4/3 倍になるので、元のファイルは 14MB までにする
const GEMINI_INLINE_MAX_BYTES = 14 * 1024 * 1024;
const TRANSIENT_DELAYS_MS = [2000, 5000];
const STALE_MS = 20 * 60 * 1000;
const TEST_TTL_SEC = 24 * 3600;

const MESSAGES = {
  provider: '混み合っていて処理できませんでした',
  blocked: 'この内容は処理できませんでした',
  truncated: '出力が途中で止まりました',
  not_configured: '設定に問題があります。開発者に連絡してください',
  audio_expired: '音声は削除されました',
  timeout: '処理が長く止まっていたため、失敗として扱いました',
  no_audio: '音声の区切りがありません',
  no_transcript: '文字起こしがありません',
  no_materials: '資料がありません',
};

class MinutesError extends Error {
  constructor(kind, { transient = false, message } = {}) {
    super(message ?? MESSAGES[kind] ?? MESSAGES.provider);
    this.kind = kind;
    this.transient = transient;
    // 何度やっても同じ結果になるものには「もう一度試す」を出さない
    this.retryable = !['not_configured', 'blocked', 'audio_expired', 'no_audio', 'no_materials'].includes(kind);
  }
}

export async function runMinutes(event, deps) {
  if (event.test) return runTest(event, deps);
  const id = String(event.minuteId ?? '');
  const target = event.target;
  if (!id || !['generate', 'summary', 'transcript'].includes(target)) return { ok: false };

  let ctx = null;
  try {
    const meta = await get(deps, deps.K.minute(id));
    if (!meta) {
      console.log('minutes: not found');
      return { ok: false };
    }
    ctx = { id, target, deps, meta, step: 'transcribe', mirrors: null, tmpDirs: [], withMaterials: target === 'summary' && event.withMaterials === true };

    // 処理中のまま止まっているものは失敗として扱い、この呼び出しで再開する。
    // 動いている最中なら二重起動なので何もしない。
    if (meta.status === 'transcribing' || meta.status === 'summarizing') {
      const age = deps.now().getTime() - Date.parse(meta.updatedAt ?? 0);
      if (age < STALE_MS) {
        console.log('minutes: already running');
        return { ok: true, skipped: true };
      }
      const step = meta.status === 'transcribing' ? 'transcribe' : 'summarize';
      meta.status = 'failed';
      meta.failure = { step, kind: 'timeout', message: MESSAGES.timeout, retryable: true };
    }

    await pipeline(ctx);
    return { ok: true };
  } catch (e) {
    const err = e instanceof MinutesError ? e : new MinutesError('provider');
    if (!(e instanceof MinutesError)) console.error('minutes: unexpected', e?.name);
    console.log(`minutes: failed step=${ctx?.step} kind=${err.kind}`);
    if (ctx) {
      try {
        await setMeta(ctx, {
          status: 'failed',
          failure: { step: ctx.step, kind: err.kind, message: err.message, retryable: err.retryable },
        });
        await syncMirrors(ctx, 'failed');
      } catch (e2) {
        console.error('minutes: saveFailure failed', e2?.name);
      }
    }
    return { ok: false, failure: { step: ctx?.step, kind: err.kind } };
  } finally {
    if (ctx) for (const d of ctx.tmpDirs) await deps.io.rm(d).catch(() => {});
  }
}

async function pipeline(ctx) {
  const { deps, target, meta } = ctx;
  const owner = meta.ownerEmail;
  const retry = target === 'transcript';

  // 要約だけ失敗していたなら、残っている文字起こしを使って要約からやり直す
  const resumeSummary = target === 'generate' && meta.status === 'failed'
    && meta.failure?.step === 'summarize' && meta.transcript?.key;

  if (target === 'transcript' || (target === 'generate' && !resumeSummary)) {
    if (target === 'transcript' && (meta.audioDeleted || expired(meta, deps))) {
      ctx.step = 'transcribe';
      throw new MinutesError('audio_expired');
    }
    ctx.step = 'transcribe';
    // 状態を書き換える前に、途中からの再開かどうかを決める
    ctx.resumeVersion = meta.status === 'failed' && meta.failure?.step === 'transcribe' ? meta.transcriptWork?.version : undefined;
    await setMeta(ctx, { status: 'transcribing', step: 'transcribe', failure: null });
    await syncMirrors(ctx, 'transcribing');
    await transcribeAll(ctx, owner, retry);
  }

  ctx.step = 'summarize';
  await setMeta(ctx, { status: 'summarizing', step: 'summarize', failure: null });
  await syncMirrors(ctx, 'summarizing');
  if (ctx.withMaterials) await summarizeWithMaterials(ctx, owner, true);
  else await summarizeStep(ctx, owner, target === 'summary');

  await setMeta(ctx, { status: 'done', step: null, failure: null });
  await syncMirrors(ctx, 'done');

  // ダウンロード用の 1 本。失敗しても議事録は完了のまま
  if (target === 'generate' && !meta.downloadKey && !meta.audio?.downloadFailed && !meta.audioDeleted) {
    await buildDownloadAudio(ctx);
  }
}

// ---- 文字起こし ----

async function transcribeAll(ctx, owner, retry) {
  const { deps, id, meta } = ctx;
  const cfg = await loadConfig(deps, 'transcribe', {});
  const apiKey = await keyFor(deps, cfg.model);

  const segs = await loadSegments(deps, id);
  if (segs.length === 0) throw new MinutesError('no_audio');

  // 前回の途中から再開するなら同じ版で続ける（済んだ区切りを飛ばすため）
  const version = ctx.resumeVersion ?? (meta.transcript?.version ?? 0) + 1;
  await setMeta(ctx, { transcriptWork: { version }, progress: { segmentsDone: 0, segmentsTotal: segs.length } });

  const vars = promptVars(meta);
  const texts = new Map();
  let done = 0;
  const todo = [];
  for (const seg of segs) {
    if (seg.transcriptStatus === 'done' && seg.transcriptVersion === version) {
      done++;
    } else {
      todo.push(seg);
    }
  }
  await setMeta(ctx, { progress: { segmentsDone: done, segmentsTotal: segs.length } });

  let fatal = false;
  const results = await runPool(todo, CONCURRENCY, async (seg) => {
    const acc = { inputTokens: 0, outputTokens: 0 };
    try {
      const text = await transcribeSegment(ctx, { seg, cfg, apiKey, vars, acc });
      await deps.s3.putObject({
        bucket: deps.env.DATA_BUCKET, key: segKey(id, seg.seq, version), body: text, contentType: 'text/plain; charset=utf-8',
      });
      const k = deps.K.minuteSeg(id, seg.seq);
      await deps.ddb.update(k.pk, k.sk, { set: { transcriptStatus: 'done', transcriptVersion: version } });
      texts.set(seg.seq, text);
      await usage(deps, 'transcribe', owner, cfg.model.id, acc, seg.durationSec, true, null, retry);
      done++;
      await setMeta(ctx, { progress: { segmentsDone: done, segmentsTotal: segs.length } });
      console.log(`minutes: segment ${seg.seq} done (${done}/${segs.length})`);
    } catch (e) {
      const err = e instanceof MinutesError ? e : new MinutesError('provider');
      console.log(`minutes: segment ${seg.seq} failed kind=${err.kind}`);
      if (err.kind === 'not_configured') fatal = true;
      const k = deps.K.minuteSeg(id, seg.seq);
      await deps.ddb.update(k.pk, k.sk, { set: { transcriptStatus: 'failed' } }).catch(() => {});
      await usage(deps, 'transcribe', owner, cfg.model.id, acc, seg.durationSec, false, err.kind, retry);
      throw err;
    }
  }, () => fatal);

  const failures = results.filter((r) => r && !r.ok).map((r) => r.error);
  if (failures.length > 0) {
    // 設定の問題のように直らないものを優先して見せる
    throw failures.find((f) => !f.retryable) ?? failures[0];
  }

  // 済んでいた区切りの文章は S3 から戻す
  const parts = [];
  for (const seg of segs) {
    let text = texts.get(seg.seq);
    if (text === undefined) {
      const buf = await deps.s3.getObjectBuffer({ bucket: deps.env.DATA_BUCKET, key: segKey(id, seg.seq, version) });
      text = Buffer.from(buf).toString('utf8');
    }
    parts.push({ startSec: seg.startSec ?? 0, text });
  }
  // joinSegments が区切りの開始時刻を足して通しの時刻にそろえる
  const full = joinSegments(parts);
  const key = `minutes/${id}/transcript-v${version}.txt`;
  await deps.s3.putObject({ bucket: deps.env.DATA_BUCKET, key, body: full, contentType: 'text/plain; charset=utf-8' });

  await setMeta(ctx, {
    transcript: {
      key, version, createdAt: iso(deps), modelId: cfg.model.id, promptVersion: cfg.promptVersion,
      previousKey: meta.transcript?.key ?? null,
    },
    progress: { segmentsDone: segs.length, segmentsTotal: segs.length },
  }, { remove: ['transcriptWork'] });
  ctx.transcriptText = full;
}

async function transcribeSegment(ctx, { seg, cfg, apiKey, vars, acc }) {
  const { deps } = ctx;
  const buf = await deps.s3.getObjectBuffer({ bucket: deps.env.AUDIO_BUCKET, key: seg.key });
  const mime = seg.mime || 'audio/webm';
  const maxSec = cfg.model.maxAudioMinutes ? cfg.model.maxAudioMinutes * 60 : 0;
  const plan = planSplit({ size: buf.length, durationSec: seg.durationSec ?? 0, maxSec });

  if (!plan) {
    return transcribeOne(deps, { cfg, apiKey, buf, mime, vars, acc });
  }

  // モデルの上限（長さ）か 20MB を超えるので、ffmpeg で短く分ける
  const ffmpeg = ffmpegPath(deps.env);
  if (!(await deps.io.exists(ffmpeg))) throw new MinutesError('not_configured', { message: '区切りが長すぎます' });
  const dir = await deps.io.mkdtemp();
  ctx.tmpDirs.push(dir);
  const inFile = `${dir}/in.${extOf(seg.key, mime)}`;
  await deps.io.writeFile(inFile, buf);
  const splitSec = plan.splitSec;
  let files;
  let partMime;
  try {
    ({ files, mime: partMime } = await splitAudio(deps.io, ffmpeg, dir, inFile, splitSec, mime));
  } catch {
    throw new MinutesError('not_configured', { message: '区切りが長すぎます' });
  }
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const partBuf = await deps.io.readFile(files[i]);
    const text = await transcribeOne(deps, { cfg, apiKey, buf: partBuf, mime: partMime, vars, acc });
    out.push(offsetTimestamps(text, i * splitSec));
  }
  return out.join('\n');
}

async function transcribeOne(deps, { cfg, apiKey, buf, mime, vars, acc }) {
  const model = cfg.model;
  return withRetry(deps, async () => {
    if (model.provider === 'openai') {
      const hint = [vars.COUNTERPARTS, vars.ATTENDEES].filter(Boolean).join('、').slice(0, 200);
      const req = buildTranscriptionRequest({
        model: model.id, apiKey, audio: new Blob([buf], { type: mime }), mimeType: mime, prompt: hint, language: 'ja',
      });
      const json = await post(deps, req, 'openai');
      const r = parseTranscriptionResponse(json);
      acc.inputTokens += r.usage?.inputTokens ?? 0;
      acc.outputTokens += r.usage?.outputTokens ?? 0;
      return r.text ?? '';
    }
    const req = buildGenerateRequest({
      model: model.id, apiKey, prompt: renderPrompt(cfg.prompt, vars),
      parts: [{ inlineData: { mimeType: mime, data: Buffer.from(buf).toString('base64') } }],
      thinkingLevel: model.thinkingLevel, maxOutputTokens: TRANSCRIBE_MAX_TOKENS,
    });
    const json = await post(deps, req, 'gemini');
    const p = parseGenerateResponse(json);
    acc.inputTokens += p.usage?.inputTokens ?? 0;
    acc.outputTokens += (p.usage?.outputTokens ?? 0) + (p.usage?.thoughtTokens ?? 0);
    if (p.blocked) throw new MinutesError('blocked');
    // 途中で切れた区切りは失敗にして、withRetry が 1 回だけやり直す
    if (p.finishReason === 'MAX_TOKENS') throw new MinutesError('truncated');
    return p.text ?? '';
  });
}

// ---- 議事録 ----

async function summarizeStep(ctx, owner, retry) {
  const { deps, id, meta } = ctx;
  const cfg = await loadConfig(deps, 'summarize', {});
  const apiKey = await keyFor(deps, cfg.model);

  let transcript = ctx.transcriptText;
  if (transcript === undefined) {
    if (!meta.transcript?.key) throw new MinutesError('no_transcript');
    const buf = await deps.s3.getObjectBuffer({ bucket: deps.env.DATA_BUCKET, key: meta.transcript.key });
    transcript = Buffer.from(buf).toString('utf8');
  }

  const acc = { inputTokens: 0, outputTokens: 0 };
  let text;
  try {
    text = await summarizeText(deps, { cfg, apiKey, vars: { ...promptVars(meta), TRANSCRIPT: transcript }, acc });
  } catch (e) {
    const err = e instanceof MinutesError ? e : new MinutesError('provider');
    await usage(deps, 'summarize', owner, cfg.model.id, acc, 0, false, err.kind, retry);
    throw err;
  }
  await usage(deps, 'summarize', owner, cfg.model.id, acc, 0, true, null, retry);

  const version = (meta.summary?.version ?? 0) + 1;
  const key = `minutes/${id}/summary-v${version}.md`;
  await deps.s3.putObject({ bucket: deps.env.DATA_BUCKET, key, body: text, contentType: 'text/markdown; charset=utf-8' });
  await setMeta(ctx, {
    summary: {
      key, version, createdAt: iso(deps), modelId: cfg.model.id, promptVersion: cfg.promptVersion,
      previousKey: meta.summary?.key ?? null,
      ...materialFields(meta, { withMaterials: false, materialIds: [], mappingKey: null }),
    },
  });
}

// revert が本文と一緒に入れ替えられるよう、前の版の資料情報も持つ
function materialFields(meta, { withMaterials, materialIds, mappingKey }) {
  const prev = meta.summary ?? {};
  return {
    withMaterials, materialIds, mappingKey,
    previousWithMaterials: Boolean(prev.withMaterials),
    previousMaterialIds: prev.materialIds ?? [],
    previousMappingKey: prev.mappingKey ?? null,
  };
}

// ---- 資料を踏まえた議事録（§15.4, §15.5） ----

async function summarizeWithMaterials(ctx, owner, retry) {
  const { deps, id, meta } = ctx;
  const cfg = await loadConfig(deps, 'summarize', {});
  const apiKey = await keyFor(deps, cfg.model);
  const outlinePrompt = await resolvePrompt(deps, 'outline');
  const summaryPrompt = await resolvePrompt(deps, 'summarize_materials');

  const r = await deps.ddb.query({ pk: deps.K.minute(id).pk, skPrefix: 'MAT#' });
  const mats = (Array.isArray(r) ? r : (r?.items ?? []))
    .filter((m) => m.state === 'ready')
    .sort((a, b) => a.seq - b.seq);
  if (mats.length === 0) throw new MinutesError('no_materials');

  let transcript = ctx.transcriptText;
  if (transcript === undefined) {
    if (!meta.transcript?.key) throw new MinutesError('no_transcript');
    transcript = Buffer.from(await deps.s3.getObjectBuffer({ bucket: deps.env.DATA_BUCKET, key: meta.transcript.key })).toString('utf8');
  }

  // 目次化と議事録の利用量は、1 回の「議事録」としてまとめて記録する（§15.5）
  const acc = { inputTokens: 0, outputTokens: 0 };
  let text;
  let mapping;
  try {
    await setMeta(ctx, { step: 'outline' });
    const outlines = await buildOutlines(ctx, { cfg, apiKey, prompt: outlinePrompt.prompt, mats, acc });

    await setMeta(ctx, { step: 'summarize_materials' });
    const list = mats.map((m) => ({ seq: m.seq, name: m.name, kind: m.kind, outline: outlines.get(m.seq) ?? null }));
    const vars = { ...promptVars(meta), MATERIALS: formatMaterialsForPrompt(list), TRANSCRIPT: transcript };
    const out = await summarizeMaterialsText(deps, { cfg, apiKey, prompt: renderPrompt(summaryPrompt.prompt, vars), acc });
    text = out.markdown;
    mapping = normalizeMapping(out.mapping, list);
  } catch (e) {
    const err = e instanceof MinutesError ? e : new MinutesError('provider');
    await usage(deps, 'summarize', owner, cfg.model.id, acc, 0, false, err.kind, retry);
    throw err;
  }
  await usage(deps, 'summarize', owner, cfg.model.id, acc, 0, true, null, retry);

  const version = (meta.summary?.version ?? 0) + 1;
  const key = `minutes/${id}/summary-v${version}.md`;
  const mappingKey = `minutes/${id}/summary-mapping-v${version}.json`;
  await deps.s3.putObject({ bucket: deps.env.DATA_BUCKET, key, body: text, contentType: 'text/markdown; charset=utf-8' });
  await deps.s3.putObject({ bucket: deps.env.DATA_BUCKET, key: mappingKey, body: JSON.stringify(mapping), contentType: 'application/json' });
  await setMeta(ctx, {
    summary: {
      key, version, createdAt: iso(deps), modelId: cfg.model.id, promptVersion: summaryPrompt.promptVersion,
      previousKey: meta.summary?.key ?? null,
      ...materialFields(meta, { withMaterials: true, materialIds: mats.map((m) => m.id), mappingKey }),
    },
  });
}

/** 資料ごとの目次。作れなかった資料は null（名前だけをモデルに渡す）。seq → 目次 */
async function buildOutlines(ctx, { cfg, apiKey, prompt, mats, acc }) {
  const { deps } = ctx;
  const out = new Map();
  const todo = [];
  for (const m of mats) {
    if (m.kind === 'pdf') {
      if (m.outlineStatus === 'done' && m.outlineKey) {
        out.set(m.seq, await readJsonObject(deps, m.outlineKey));
      } else {
        todo.push(m);
      }
    } else if (m.extractKey) {
      // pptx / xlsx はモデルを使わず、ブラウザが抜いた JSON から機械的に作る
      const extract = await readJsonObject(deps, m.extractKey);
      out.set(m.seq, extract ? outlineFromExtract(extract, { name: m.name }) : null);
    } else {
      out.set(m.seq, null);
    }
  }
  await runPool(todo, OUTLINE_CONCURRENCY, async (m) => {
    try {
      const outline = await outlinePdf(deps, { cfg, apiKey, prompt, mat: m, acc });
      const outlineKey = `minutes/${ctx.id}/materials/${m.id}.outline.json`;
      await deps.s3.putObject({ bucket: deps.env.DATA_BUCKET, key: outlineKey, body: JSON.stringify(outline), contentType: 'application/json' });
      await deps.ddb.update(m.pk, m.sk, { set: { outlineStatus: 'done', outlineKey } });
      out.set(m.seq, outline);
    } catch (e) {
      // 目次にできない資料があっても議事録は作る。その資料は名前だけを渡す
      console.log(`minutes: outline failed kind=${e instanceof MinutesError ? e.kind : 'unexpected'}`);
      await deps.ddb.update(m.pk, m.sk, { set: { outlineStatus: 'failed' } }).catch(() => {});
      out.set(m.seq, null);
    }
  });
  return out;
}

async function readJsonObject(deps, key) {
  try {
    const buf = await deps.s3.getObjectBuffer({ bucket: deps.env.DATA_BUCKET, key });
    return JSON.parse(Buffer.from(buf).toString('utf8'));
  } catch {
    return null;
  }
}

// PDF 1 件を、モデルに読ませて目次にする。100 ページ超の分割は実機で必要になったときに足す（§15.4）
async function outlinePdf(deps, { cfg, apiKey, prompt, mat, acc }) {
  const model = cfg.model;
  const buf = Buffer.from(await deps.s3.getObjectBuffer({ bucket: deps.env.DATA_BUCKET, key: mat.key }));
  const text = renderPrompt(prompt, { NAME: mat.name, KIND: mat.kind });
  const raw = await withRetry(deps, async () => {
    if (model.provider === 'openai') return outlineViaOpenAI(deps, { model, apiKey, buf, mat, text, acc });
    if (buf.length >= GEMINI_INLINE_MAX_BYTES) throw new MinutesError('provider', { message: 'PDF が大きすぎます' });
    const req = buildGenerateRequest({
      model: model.id, apiKey, prompt: text,
      parts: [{ inlineData: { mimeType: 'application/pdf', data: buf.toString('base64') } }],
      schema: toGeminiSchema(OUTLINE_SCHEMA), thinkingLevel: model.thinkingLevel, maxOutputTokens: OUTLINE_MAX_TOKENS,
    });
    const p = parseGenerateResponse(await post(deps, req, 'gemini'));
    acc.inputTokens += p.usage?.inputTokens ?? 0;
    acc.outputTokens += (p.usage?.outputTokens ?? 0) + (p.usage?.thoughtTokens ?? 0);
    if (p.blocked) throw new MinutesError('blocked');
    if (p.finishReason === 'MAX_TOKENS') throw new MinutesError('truncated');
    return p.text ?? '';
  });
  const parsed = parseJsonOrTruncated(raw);
  if (!Array.isArray(parsed.sections)) throw new MinutesError('truncated');
  return parsed;
}

// OpenAI は /v1/files に預けて input_file で渡し、使い終えたら消す（預けたファイルを残さないため）
async function outlineViaOpenAI(deps, { model, apiKey, buf, mat, text, acc }) {
  const up = buildOpenAIFileUploadRequest({ apiKey, filename: `${mat.id}.pdf`, contentType: 'application/pdf' });
  const body = Buffer.concat([Buffer.from(up.prefix), buf, Buffer.from(up.suffix)]);
  const { id: fileId } = parseOpenAIFileResponse(await post(deps, { url: up.url, method: up.method, headers: up.headers, body }, 'openai'));
  try {
    const req = buildResponsesRequest({
      model: model.id, apiKey, jsonSchema: OUTLINE_SCHEMA, schemaName: 'outline',
      parts: [{ type: 'input_file', fileId }, { type: 'input_text', text }],
      maxOutputTokens: OUTLINE_MAX_TOKENS, reasoningEffort: model.reasoningEffort,
    });
    const p = parseResponsesResponse(await post(deps, req, 'openai'));
    acc.inputTokens += p.usage?.inputTokens ?? 0;
    acc.outputTokens += p.usage?.outputTokens ?? 0;
    if (/max_output_tokens|length/.test(String(p.finishReason ?? ''))) throw new MinutesError('truncated');
    return p.text ?? '';
  } finally {
    try {
      const del = buildOpenAIFileDeleteRequest({ apiKey, fileId });
      await deps.fetch(del.url, { method: del.method, headers: del.headers });
    } catch {
      console.error('minutes: openai file delete failed');
    }
  }
}

// JSON が取り出せない、または途中で切れている応答は truncated 扱い（withRetry が 1 回だけやり直す）
function parseJsonOrTruncated(raw) {
  let r;
  try {
    r = extractJson(raw);
  } catch {
    throw new MinutesError('truncated');
  }
  if (r.truncated || !r.value || typeof r.value !== 'object') throw new MinutesError('truncated');
  return r.value;
}

async function summarizeMaterialsText(deps, { cfg, apiKey, prompt, acc }) {
  const model = cfg.model;
  return withRetry(deps, async () => {
    let raw;
    if (model.provider === 'openai') {
      const req = buildResponsesRequest({
        model: model.id, apiKey, parts: [{ type: 'input_text', text: prompt }], jsonSchema: MATERIAL_SUMMARY_SCHEMA,
        schemaName: 'material_summary', maxOutputTokens: MATERIAL_SUMMARY_MAX_TOKENS, reasoningEffort: model.reasoningEffort,
      });
      const p = parseResponsesResponse(await post(deps, req, 'openai'));
      acc.inputTokens += p.usage?.inputTokens ?? 0;
      acc.outputTokens += p.usage?.outputTokens ?? 0;
      if (/max_output_tokens|length/.test(String(p.finishReason ?? ''))) throw new MinutesError('truncated');
      raw = p.text ?? '';
    } else {
      const req = buildGenerateRequest({
        model: model.id, apiKey, prompt, parts: [], schema: toGeminiSchema(MATERIAL_SUMMARY_SCHEMA),
        thinkingLevel: model.thinkingLevel, maxOutputTokens: MATERIAL_SUMMARY_MAX_TOKENS,
      });
      const p = parseGenerateResponse(await post(deps, req, 'gemini'));
      acc.inputTokens += p.usage?.inputTokens ?? 0;
      acc.outputTokens += (p.usage?.outputTokens ?? 0) + (p.usage?.thoughtTokens ?? 0);
      if (p.blocked) throw new MinutesError('blocked');
      if (p.finishReason === 'MAX_TOKENS') throw new MinutesError('truncated');
      raw = p.text ?? '';
    }
    const v = parseJsonOrTruncated(raw);
    if (typeof v.markdown !== 'string' || !v.markdown.trim()) throw new MinutesError('truncated');
    return { markdown: v.markdown, mapping: Array.isArray(v.mapping) ? v.mapping : [] };
  });
}

async function summarizeText(deps, { cfg, apiKey, vars, acc }) {
  const model = cfg.model;
  const prompt = renderPrompt(cfg.prompt, vars);
  return withRetry(deps, async () => {
    if (model.provider === 'openai') {
      const req = buildChatRequest({
        model: model.id, apiKey, user: prompt, maxOutputTokens: SUMMARIZE_MAX_TOKENS, reasoningEffort: model.reasoningEffort,
      });
      const json = await post(deps, req, 'openai');
      const p = parseChatResponse(json);
      acc.inputTokens += p.usage?.inputTokens ?? 0;
      acc.outputTokens += p.usage?.outputTokens ?? 0;
      if (p.finishReason === 'length') throw new MinutesError('truncated');
      return p.text ?? '';
    }
    const req = buildGenerateRequest({
      model: model.id, apiKey, prompt, parts: [], thinkingLevel: model.thinkingLevel, maxOutputTokens: SUMMARIZE_MAX_TOKENS,
    });
    const json = await post(deps, req, 'gemini');
    const p = parseGenerateResponse(json);
    acc.inputTokens += p.usage?.inputTokens ?? 0;
    acc.outputTokens += (p.usage?.outputTokens ?? 0) + (p.usage?.thoughtTokens ?? 0);
    if (p.blocked) throw new MinutesError('blocked');
    if (p.finishReason === 'MAX_TOKENS') throw new MinutesError('truncated');
    return p.text ?? '';
  });
}

// ---- ダウンロード用の音声 ----

async function buildDownloadAudio(ctx) {
  const { deps, id, meta } = ctx;
  const markFailed = async () => {
    try {
      await setMeta(ctx, { downloadKey: null, audio: { ...(meta.audio ?? {}), downloadFailed: true } });
    } catch (e) {
      console.error('minutes: audio mark failed', e?.name);
    }
  };
  try {
    const ffmpeg = ffmpegPath(deps.env);
    if (!(await deps.io.exists(ffmpeg))) {
      console.log('minutes: ffmpeg not found');
      return markFailed();
    }
    const segs = await loadSegments(deps, id);
    if (segs.length === 0) return markFailed();
    const dir = await deps.io.mkdtemp();
    ctx.tmpDirs.push(dir);
    const files = [];
    for (const seg of segs) {
      const buf = await deps.s3.getObjectBuffer({ bucket: deps.env.AUDIO_BUCKET, key: seg.key });
      const f = `${dir}/seg-${seg.seq}.${extOf(seg.key, seg.mime)}`;
      await deps.io.writeFile(f, buf);
      files.push(f);
    }
    const out = `${dir}/audio.m4a`;
    await concatToM4a(deps.io, ffmpeg, dir, files, out);
    const key = `minutes/${id}/audio.m4a`;
    await deps.s3.putObject({ bucket: deps.env.AUDIO_BUCKET, key, body: await deps.io.readFile(out), contentType: 'audio/mp4' });
    await setMeta(ctx, { downloadKey: key });
  } catch (e) {
    console.error('minutes: download audio failed', e?.name);
    await markFailed();
  }
}

// ---- 開発コンソールの試し ----

async function runTest(event, deps) {
  const jobId = String(event.jobId ?? '');
  if (!jobId) return { ok: false };
  const k = deps.K.setting(`test#${jobId}`);
  const started = deps.now().getTime();
  const ttl = Math.floor(started / 1000) + TEST_TTL_SEC;
  const write = (body) => deps.ddb.put({ ...k, ...body, updatedAt: iso(deps), ttl });
  const acc = { inputTokens: 0, outputTokens: 0 };
  let modelId = '';
  let audioSeconds = 0;
  try {
    await write({ status: 'running' });
    const kind = event.kind === 'summarize' ? 'summarize' : 'transcribe';
    const cfg = await loadConfig(deps, kind, { modelId: event.modelId, promptText: event.promptText });
    modelId = cfg.model.id;
    const apiKey = await keyFor(deps, cfg.model);
    let text;
    if (kind === 'transcribe') {
      const buf = await deps.s3.getObjectBuffer({ bucket: deps.env.AUDIO_BUCKET, key: event.audioKey });
      audioSeconds = Number(event.durationSec) || 0;
      text = await transcribeOne(deps, { cfg, apiKey, buf, mime: event.mime || 'audio/webm', vars: promptVars({}), acc });
    } else {
      text = await summarizeText(deps, { cfg, apiKey, vars: { ...promptVars({}), TRANSCRIPT: String(event.transcript ?? '') }, acc });
    }
    const elapsedMs = deps.now().getTime() - started;
    await usage(deps, 'test', event.actor, modelId, acc, audioSeconds, true, null, false);
    const result = { text, usage: { ...acc }, elapsedMs };
    await write({ status: 'done', result });
    return { ok: true, ...result };
  } catch (e) {
    const err = e instanceof MinutesError ? e : new MinutesError('provider');
    if (modelId) await usage(deps, 'test', event.actor, modelId, acc, audioSeconds, false, err.kind, false);
    const failure = { kind: err.kind, message: err.message, retryable: err.retryable };
    try {
      await write({ status: 'failed', failure });
    } catch (e2) {
      console.error('minutes: test write failed', e2?.name);
    }
    return { ok: false, failure };
  }
}

// ---- 設定・呼び出し ----

async function loadConfig(deps, kind, { modelId, promptText }) {
  const setting = (await get(deps, deps.K.setting('gemini'))) ?? {};
  const id = modelId || setting.models?.[kind] || DEFAULT_SELECTION[kind];
  const stored = await get(deps, deps.K.model(id));
  const fallback = (DEFAULT_MODELS ?? []).find((m) => m.id === id);
  const model = { provider: 'gemini', ...(fallback ?? {}), ...(stored ?? {}), id };

  const { prompt, promptVersion } = await resolvePrompt(deps, kind, promptText, setting);
  return { model, prompt, promptVersion };
}

// 編集済みのプロンプトがあればそれ、無ければ初期値。モデルとは別に引けるのは、
// 資料の目次化と資料つきの議事録が「議事録」のモデルを使い、プロンプトだけ別だから
async function resolvePrompt(deps, kind, promptText, setting) {
  const st = setting ?? (await get(deps, deps.K.setting('gemini'))) ?? {};
  let prompt = DEFAULT_PROMPTS[kind];
  let promptVersion = 0; // 0 は初期値
  const v = st.promptVersion?.[kind];
  if (v != null) {
    const p = await get(deps, deps.K.prompt(kind, v));
    if (p?.text) {
      prompt = p.text;
      promptVersion = v;
    }
  }
  if (promptText) {
    prompt = promptText;
    promptVersion = 'test';
  }
  return { prompt, promptVersion };
}

async function keyFor(deps, model) {
  const key = await deps.getApiKey(model.provider === 'openai' ? 'openai' : 'gemini');
  if (!key) throw new MinutesError('not_configured');
  return key;
}

// 混雑・時間切れは 2 回まで（2 秒、5 秒）、途中で切れたものは 1 回だけ
async function withRetry(deps, fn) {
  let transient = 0;
  let truncated = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof MinutesError)) throw e;
      if (e.transient && transient < TRANSIENT_DELAYS_MS.length) {
        await deps.sleep(TRANSIENT_DELAYS_MS[transient++]);
        continue;
      }
      if (e.kind === 'truncated' && truncated < 1) {
        truncated++;
        continue;
      }
      throw e;
    }
  }
}

// 成功すれば応答の JSON を返す。失敗は MinutesError にして投げる
async function post(deps, req, provider) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let status;
  let json;
  try {
    const res = await deps.fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ac.signal });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch {
    throw new MinutesError('provider', { transient: true });
  } finally {
    clearTimeout(timer);
  }
  if (status >= 200 && status < 300) return json;
  const c = provider === 'openai' ? classifyOpenAIError({ status, json }) : classifyGeminiError({ status, json });
  throw new MinutesError(c.kind === 'rate_limited' ? 'provider' : c.kind, { transient: status === 429 || status >= 500 });
}

async function usage(deps, kind, userId, modelId, acc, audioSeconds, ok, failureKind, retry) {
  try {
    const ev = usageEvent({
      kind, userId, modelId,
      inputTokens: acc.inputTokens, outputTokens: acc.outputTokens,
      audioSeconds: audioSeconds || 0, ok, failureKind: failureKind ?? undefined, at: iso(deps),
    });
    await deps.recordUsage(Object.assign(ev, { retry: Boolean(retry) }));
  } catch (e) {
    console.error('minutes: recordUsage failed', e?.name);
  }
}

// ---- DynamoDB の読み書き ----

async function loadSegments(deps, id) {
  const r = await deps.ddb.query({ pk: deps.K.minute(id).pk, skPrefix: 'SEG#' });
  const items = Array.isArray(r) ? r : (r?.items ?? []);
  return items
    .map((it) => ({ ...it, seq: Number(it.seq ?? String(it.sk).slice(4)) }))
    .sort((a, b) => a.seq - b.seq);
}

// META を更新し、メモリ上の写しにも反映する。処理の開始・進行のたびに updatedAt を書く
async function setMeta(ctx, set, { remove } = {}) {
  const { deps, id, meta } = ctx;
  const at = iso(deps);
  const k = deps.K.minute(id);
  const ops = { set: { ...set, updatedAt: at } };
  if (remove?.length) ops.remove = remove;
  await deps.ddb.update(k.pk, k.sk, ops);
  Object.assign(meta, set, { updatedAt: at });
  for (const r of remove ?? []) delete meta[r];
}

// 「見られる議事録」（作った人と共有された人）と名刺側の写しの status。
// 存在しない項目を update で作ってしまわないよう、あるものだけ更新する。
async function syncMirrors(ctx, status) {
  const { deps, id, meta } = ctx;
  try {
    if (!ctx.mirrors) {
      const keys = [];
      if (meta.ownerEmail) keys.push(deps.K.userMinute(meta.ownerEmail, meta.heldAt, id));
      const r = await deps.ddb.query({ pk: deps.K.minute(id).pk, skPrefix: 'SHARE#' });
      for (const it of Array.isArray(r) ? r : (r?.items ?? [])) {
        keys.push(deps.K.userMinute(String(it.sk).slice('SHARE#'.length), meta.heldAt, id));
      }
      for (const c of meta.counterparts ?? []) {
        if (c?.cardId) keys.push(deps.K.cardMinute(c.cardId, meta.heldAt, id));
      }
      ctx.mirrors = keys;
    }
    for (const k of ctx.mirrors) {
      if (await get(deps, k)) await deps.ddb.update(k.pk, k.sk, { set: { status } });
    }
  } catch (e) {
    console.error('minutes: syncMirrors failed', e?.name);
  }
}

// ---- 小物 ----

async function get(deps, k) {
  return (await deps.ddb.get(k.pk, k.sk)) ?? null;
}
function iso(deps) {
  return deps.now().toISOString();
}
function expired(meta, deps) {
  return Boolean(meta.audioExpiresAt) && Date.parse(meta.audioExpiresAt) < deps.now().getTime();
}
function segKey(id, seq, version) {
  return `minutes/${id}/seg-${seq}-v${version}.txt`;
}
function extOf(key, mime) {
  const m = /\.([a-z0-9]+)$/i.exec(String(key ?? ''));
  if (m) return m[1];
  return /mp4|m4a|aac/.test(mime ?? '') ? 'm4a' : 'webm';
}

// プロンプトに差し込む値。日時は日本時間で書く
function promptVars(meta) {
  let date = '';
  if (meta.heldAt) {
    try {
      date = new Date(meta.heldAt).toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16);
    } catch { /* 日時が読めなければ空 */ }
  }
  const join = (a) => (a ?? []).filter(Boolean).join(' ');
  return {
    TITLE: meta.title ?? '',
    DATE: date,
    COUNTERPARTS: (meta.counterparts ?? []).map((c) => join([c.company, c.department, c.name])).filter(Boolean).join('、'),
    ATTENDEES: (meta.attendees ?? []).map((a) => (a.department ? `${a.name}（${a.department}）` : a.name)).filter(Boolean).join('、'),
    MEMO: meta.memo ?? '',
  };
}
