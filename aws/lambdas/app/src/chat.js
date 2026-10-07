// 議事録への質問（docs/minutes-design.md §16、api-contract.md「質問」）。
// 渡すのは文字起こしの全文と資料の全文（pptx / xlsx。PDF は名前だけ）、会議の情報だけ。議事録（要約）は渡さない（要約の解釈に引きずられず、元の発言から答えさせるため）。
// 30 秒の API Gateway の中で答えを返す同期の処理なので、モデルの呼び出しは app から直接行い、25 秒で打ち切る。
import {
  renderPrompt, DEFAULT_MODELS, DEFAULT_SELECTION, DEFAULT_PROMPTS,
  buildChatGenerateRequest, parseGenerateResponse, classifyGeminiError,
  buildResponsesRequest, parseResponsesResponse, classifyOpenAIError,
  buildQaContext, trimTurns, usageEvent,
} from '@hyper-sfa/core';
import {
  ddb, K, s3, recordUsage, getSelection, getModel, getPrompt, getApiKey,
  HttpError, isConditionFailed, validation, readJson,
} from '@hyper-sfa/aws-shared';
import { access, loadMaterials } from './minutes.js';
import { consumeQa } from './rate.js';

const TEXT_MAX = 2000;
const HISTORY_ITEMS = 20; // 直近 10 往復
const MAX_OUTPUT_TOKENS = 4000;
// API Gateway は 30 秒で打ち切る。その手前で自分から切って、画面に provider_error を返せるようにする
const FETCH_TIMEOUT_MS = 25_000;
const SAVE_ATTEMPTS = 3;

const nowIso = () => new Date().toISOString();

const present = (i) => ({
  seq: i.seq,
  role: i.role,
  text: i.text,
  modelId: i.modelId ?? null,
  createdAt: i.createdAt,
});

const providerError = (message = '混み合っていて答えられませんでした。もう一度お試しください') => new HttpError(502, 'provider_error', message);

/**
 * @param {import('hono').Hono} app
 * @param {{ fetch?: typeof fetch, getApiKey?: Function, now?: () => Date }} [deps] テストで差し替える
 */
export function registerChatRoutes(app, deps = {}) {
  const me = (c) => c.get('auth').user;
  const doFetch = (...a) => (deps.fetch ?? globalThis.fetch)(...a);
  const apiKeyOf = deps.getApiKey ?? getApiKey;
  const clock = deps.now ?? (() => new Date());
  const prefixOf = (userId) => `CHAT#${String(userId).toLowerCase()}#`;

  /** 自分のスレッドの直近 n 件を古い順で。 */
  async function recent(id, userId, n) {
    const r = await ddb.query({ pk: K.minute(id).pk, skPrefix: prefixOf(userId), forward: false, limit: n });
    return r.items.slice().reverse();
  }

  async function modelLabel() {
    const sel = await getSelection();
    const m = await getModel(sel.qa ?? DEFAULT_SELECTION.qa);
    return m?.label ?? m?.id ?? '';
  }

  app.get('/api/minutes/:id/chat', async (c) => {
    const user = me(c);
    const { meta } = await access(user, c.req.param('id'));
    const items = await ddb.queryAll({ pk: K.minute(meta.id).pk, skPrefix: prefixOf(user.id) });
    return c.json({
      items: items.map(present),
      modelLabel: await modelLabel(),
      available: Boolean(meta.transcript?.key),
    });
  });

  app.delete('/api/minutes/:id/chat', async (c) => {
    const user = me(c);
    const { meta } = await access(user, c.req.param('id'));
    const items = await ddb.queryAll({ pk: K.minute(meta.id).pk, skPrefix: prefixOf(user.id) });
    for (let i = 0; i < items.length; i += 25) {
      await Promise.all(items.slice(i, i + 25).map((x) => ddb.del(x.pk, x.sk)));
    }
    // 他の削除 API と同じく本文なし（画面の api.del は 204 を null として扱う）
    return c.body(null, 204);
  });

  app.post('/api/minutes/:id/chat', async (c) => {
    const user = me(c);
    const { meta } = await access(user, c.req.param('id'));
    const body = await readJson(c);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw validation('質問を入力してください', [{ field: 'text', message: '空です' }]);
    if (text.length > TEXT_MAX) throw validation(`質問は ${TEXT_MAX} 文字までです`, [{ field: 'text', message: `${TEXT_MAX} 文字まで` }]);
    if (!meta.transcript?.key) throw validation('文字起こしがまだ無いため、質問できません');

    // 上限は、モデルを呼ぶ前に数える（失敗しても数えたままにして、連打で費用が膨らむのを防ぐ）
    await consumeQa(user.id, clock());

    const history = await recent(meta.id, user.id, HISTORY_ITEMS);
    const system = await buildSystemText(meta);

    const sel = await getSelection();
    const modelId = sel.qa ?? DEFAULT_SELECTION.qa;
    const stored = await getModel(modelId);
    const model = { provider: 'gemini', ...(DEFAULT_MODELS.find((m) => m.id === modelId) ?? {}), ...(stored ?? {}), id: modelId };
    const provider = model.provider === 'openai' ? 'openai' : 'gemini';
    const apiKey = await apiKeyOf(provider);
    if (!apiKey) throw new HttpError(503, 'not_configured', 'API キーがまだ登録されていません');

    // trimTurns は、先頭が assistant（窓の切れ目の半端）なら落とす。Gemini は先頭が user でないと受け付けない
    const past = trimTurns(history.map((h) => ({ role: h.role, text: h.text })), HISTORY_ITEMS);
    const turns = [...past, { role: 'user', text }];

    const { answer, inputTokens, outputTokens } = await ask({ provider, model, apiKey, system, turns });

    const at = nowIso();
    const saved = await saveExchange(meta.id, user.id, { question: text, answer, modelId, inputTokens, outputTokens, at });

    try {
      await recordUsage(usageEvent({ kind: 'qa', userId: user.id, modelId, inputTokens, outputTokens, ok: true, at }));
    } catch (e) {
      // 答えは返す。利用量の記録の失敗で利用者に失敗を見せない
      console.error('chat: recordUsage failed', e?.name);
    }
    return c.json({ question: present(saved.question), answer: present(saved.answer), usage: { inputTokens, outputTokens } });
  });

  // ---- 文脈 ----

  async function readData(key) {
    return Buffer.from(await s3.getObjectBuffer({ bucket: 'data', key })).toString('utf8');
  }
  async function readJsonOrNull(key) {
    try {
      return JSON.parse(await readData(key));
    } catch {
      return null;
    }
  }

  async function buildSystemText(meta) {
    const transcript = await readData(meta.transcript.key);
    const mats = await loadMaterials(meta.id);
    // pptx / xlsx は、ブラウザが抜いた JSON の全文を渡す。PDF は同期の 25 秒に収めるため名前だけ（添付しない）
    const materials = await Promise.all(mats.map(async (m) => ({
      seq: m.seq, name: m.name, kind: m.kind,
      extract: m.kind !== 'pdf' && m.extractKey ? await readJsonOrNull(m.extractKey) : null,
    })));
    const prompt = await getPrompt('qa');
    return renderPrompt(prompt.text ?? DEFAULT_PROMPTS.qa, buildQaContext({ transcript, materials, minute: meta }));
  }

  // ---- モデルの呼び出し ----

  async function ask({ provider, model, apiKey, system, turns }) {
    const req = provider === 'openai'
      ? buildResponsesRequest({ model: model.id, apiKey, instructions: system, turns, maxOutputTokens: MAX_OUTPUT_TOKENS, reasoningEffort: model.reasoningEffort })
      : buildChatGenerateRequest({ model: model.id, apiKey, systemText: system, turns, thinkingLevel: model.thinkingLevel, maxOutputTokens: MAX_OUTPUT_TOKENS });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let status;
    let json;
    try {
      const res = await doFetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ac.signal });
      status = res.status;
      json = await res.json().catch(() => null);
    } catch {
      throw providerError('答えが時間内に返りませんでした。もう一度お試しください');
    } finally {
      clearTimeout(timer);
    }
    if (status < 200 || status >= 300) {
      const k = (provider === 'openai' ? classifyOpenAIError({ status, json }) : classifyGeminiError({ status, json })).kind;
      if (k === 'not_configured') throw providerError('API キーが無効です。管理者にお知らせください');
      throw providerError();
    }
    if (provider === 'openai') {
      const p = parseResponsesResponse(json);
      if (!p.text) throw providerError('答えを作れませんでした。もう一度お試しください');
      return { answer: p.text, inputTokens: p.usage?.inputTokens ?? 0, outputTokens: p.usage?.outputTokens ?? 0 };
    }
    const p = parseGenerateResponse(json);
    if (p.blocked || !p.text) throw providerError('答えを作れませんでした。言い方を変えてお試しください');
    return { answer: p.text, inputTokens: p.usage?.inputTokens ?? 0, outputTokens: (p.usage?.outputTokens ?? 0) + (p.usage?.thoughtTokens ?? 0) };
  }

  // ---- 保存 ----

  // 連番は利用者ごと。最後の連番の次から、質問と答えを 1 回の書き込みで置く。
  // 同じ人が同時に 2 件送ったときに連番がぶつかったら、数え直して置き直す
  async function saveExchange(id, userId, { question, answer, modelId, inputTokens, outputTokens, at }) {
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      const last = (await recent(id, userId, 1))[0];
      const seq = (last?.seq ?? 0) + 1;
      const q = { ...K.minuteChat(id, userId, seq), seq, role: 'user', text: question, createdAt: at };
      const a = { ...K.minuteChat(id, userId, seq + 1), seq: seq + 1, role: 'assistant', text: answer, modelId, inputTokens, outputTokens, createdAt: at };
      try {
        await ddb.transact([
          { put: q, condition: 'attribute_not_exists(pk)' },
          { put: a, condition: 'attribute_not_exists(pk)' },
        ]);
        return { question: q, answer: a };
      } catch (e) {
        if (!isConditionFailed(e)) throw e;
      }
    }
    throw new HttpError(409, 'conflict', '同時に送られたため保存できませんでした。もう一度お試しください');
  }
}
