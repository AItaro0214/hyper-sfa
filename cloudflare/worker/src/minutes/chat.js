// 議事録への質問（docs/minutes-design.md §16、api-contract.md「質問」）。
// 渡すのは文字起こしの全文と資料の全文（pptx / xlsx。PDF は名前だけ）、会議の情報だけ。議事録（要約）は渡さない（要約の解釈に引きずられず、元の発言から答えさせるため）。
//
// CPU について: Worker の CPU 時間は 1 回 10 ミリ秒（無料プラン）。ここで Worker の中で読むのは文字起こし（文章）と
// 資料の抜き出し（pptx / xlsx の JSON）だけで、数十 KB の文字列を読んで結合し、プロンプトに差し込むだけ。モデルの応答待ちは CPU に数えられない。
// 音声や PDF の本体など、重いものは読まない。
import { DEFAULT_SELECTION, gemini, openai, renderPrompt, buildQaContext, trimTurns } from '../core.js';
import { getApiKey, getModel, getPrompt, getSelectedModel } from '../lib/settings.js';
import { recordUsage } from '../lib/usage.js';
import { jstDay } from '../lib/time.js';
import { envNumber } from '../lib/http.js';
import { ApiError, providerError, notConfigured, rateLimited } from '../lib/errors.js';
import { validationError } from './errors.js';
import { hydrate, loadVisible, safeJson } from './store.js';

const TEXT_MAX = 2000;
const HISTORY_ITEMS = 20; // 直近 10 往復
const MAX_OUTPUT_TOKENS = 4000;
// AWS 版（API Gateway の 30 秒）と同じ待ち時間にそろえる。超えたら provider_error で、もう一度送れる
const FETCH_TIMEOUT_MS = 25_000;
const SAVE_ATTEMPTS = 3;

const nowIso = () => new Date().toISOString();

const present = (r) => ({ seq: r.seq, role: r.role, text: r.text, modelId: r.model_id ?? null, createdAt: r.created_at });

/**
 * @param {import('hono').Hono} app
 * @param {object} [deps] テストで差し替える（fetch / getApiKey / getModel / getSelectedModel / getPrompt / recordUsage）
 */
export function chatRoutes(app, deps = {}) {
  const d = { fetch: (...a) => fetch(...a), getApiKey, getModel, getSelectedModel, getPrompt, recordUsage, ...deps };

  app.get('/api/minutes/:id/chat', async (c) => {
    const user = c.get('user');
    const { row } = await loadVisible(c.env, c.req.param('id'), user.id);
    const { results } = await c.env.DB.prepare(
      'SELECT seq, role, text, model_id, created_at FROM minute_chats WHERE minute_id = ? AND user_id = ? ORDER BY seq',
    )
      .bind(row.id, user.id)
      .all();
    const modelId = (await d.getSelectedModel(c.env, 'qa')) || DEFAULT_SELECTION.qa;
    const model = await d.getModel(c.env, modelId);
    return c.json({
      items: results.map(present),
      modelLabel: model?.label ?? modelId,
      available: Boolean(row.transcript_key),
    });
  });

  app.delete('/api/minutes/:id/chat', async (c) => {
    const user = c.get('user');
    const { row } = await loadVisible(c.env, c.req.param('id'), user.id);
    await c.env.DB.prepare('DELETE FROM minute_chats WHERE minute_id = ? AND user_id = ?').bind(row.id, user.id).run();
    return c.body(null, 204);
  });

  app.post('/api/minutes/:id/chat', async (c) => {
    const user = c.get('user');
    const { row } = await loadVisible(c.env, c.req.param('id'), user.id);
    let body = {};
    try {
      body = await c.req.json();
    } catch {
      throw validationError('リクエストの形が正しくありません');
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) throw validationError('質問を入力してください', [{ field: 'text', message: '空です' }]);
    if (text.length > TEXT_MAX) throw validationError(`質問は ${TEXT_MAX} 文字までです`, [{ field: 'text', message: `${TEXT_MAX} 文字まで` }]);
    if (!row.transcript_key) throw validationError('文字起こしがまだ無いため、質問できません');

    // 上限は、モデルを呼ぶ前に数える（失敗しても数えたままにして、連打で費用が膨らむのを防ぐ）
    await takeQaQuota(c.env, user.id);

    const system = await buildSystemText(c.env, row, user.id);
    const history = await recentTurns(c.env, row.id, user.id);
    // trimTurns は、先頭が assistant（窓の切れ目の半端）なら落とす。Gemini は先頭が user でないと受け付けない
    const turns = [...trimTurns(history, HISTORY_ITEMS), { role: 'user', text }];

    const modelId = (await d.getSelectedModel(c.env, 'qa')) || DEFAULT_SELECTION.qa;
    const model = await d.getModel(c.env, modelId);
    if (!model) throw notConfigured('質問に使うモデルが見つかりません');
    const provider = model.provider === 'openai' ? 'openai' : 'gemini';
    const apiKey = await d.getApiKey(c.env, provider);
    if (!apiKey) throw notConfigured('API キーがまだ登録されていません');

    const { answer, inputTokens, outputTokens } = await ask(d, { provider, model, apiKey, system, turns });

    const at = nowIso();
    const saved = await saveExchange(c.env, row.id, user.id, { question: text, answer, modelId: model.id, inputTokens, outputTokens, at });
    try {
      await d.recordUsage(c.env, { kind: 'qa', userId: user.id, modelId: model.id, model, inputTokens, outputTokens, ok: true, at });
    } catch {
      // 答えは返す。利用量の記録の失敗で利用者に失敗を見せない
      console.error('chat: recordUsage failed');
    }
    return c.json({ question: present(saved.question), answer: present(saved.answer), usage: { inputTokens, outputTokens } });
  });

  // ---- 文脈 ----

  async function buildSystemText(env, row, userId) {
    const tObj = await env.DATA.get(row.transcript_key);
    if (!tObj) throw validationError('文字起こしが見つかりません');
    const transcript = await tObj.text();

    const { results: mats } = await env.DB.prepare(
      "SELECT * FROM minute_materials WHERE minute_id = ? AND outline_status != 'uploading' ORDER BY seq",
    )
      .bind(row.id)
      .all();
    // pptx / xlsx は、ブラウザが抜いた JSON の全文を渡す。PDF は同期の応答に収めるため名前だけ（添付しない）
    const materials = [];
    for (const m of mats) {
      const extract = m.kind !== 'pdf' && m.extract_key ? await readJsonObject(env, m.extract_key) : null;
      materials.push({ seq: m.seq, name: m.name, kind: m.kind, extract });
    }

    const [minute] = await hydrate(env, [row], userId);
    const prompt = await d.getPrompt(env, 'qa');
    return renderPrompt(prompt.text, buildQaContext({ transcript, materials, minute }));
  }
}

async function readJsonObject(env, key) {
  try {
    const o = await env.DATA.get(key);
    return o ? safeJson(await o.text(), null) : null;
  } catch {
    return null;
  }
}

async function recentTurns(env, minuteId, userId) {
  const { results } = await env.DB.prepare(
    'SELECT seq, role, text FROM minute_chats WHERE minute_id = ? AND user_id = ? ORDER BY seq DESC LIMIT ?',
  )
    .bind(minuteId, userId, HISTORY_ITEMS)
    .all();
  return results.reverse().map((r) => ({ role: r.role, text: r.text }));
}

// 1 日の質問回数。超えていれば加算せずに 429（名刺の読み取りの takeScanQuota と同じ作り）
async function takeQaQuota(env, userId) {
  const limit = envNumber(env.QA_PER_DAY, 200);
  const res = await env.DB.prepare(
    `INSERT INTO qa_quota (user_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1 WHERE count < ?
     RETURNING count`,
  )
    .bind(userId, jstDay(), limit)
    .first();
  if (!res) throw rateLimited(`質問は 1 日 ${limit} 回までです`);
}

// ---- モデルの呼び出し ----

function failure(kind) {
  if (kind === 'not_configured') return providerError('API キーが無効です。管理者にお知らせください');
  if (kind === 'blocked') return providerError('答えを作れませんでした。言い方を変えてお試しください');
  return providerError('混み合っていて答えられませんでした。もう一度お試しください');
}

async function ask(d, { provider, model, apiKey, system, turns }) {
  const req = provider === 'openai'
    ? openai.buildResponsesRequest({ model: model.id, apiKey, instructions: system, turns, maxOutputTokens: MAX_OUTPUT_TOKENS, reasoningEffort: model.reasoningEffort })
    : gemini.buildChatGenerateRequest({ model: model.id, apiKey, systemText: system, turns, thinkingLevel: model.thinkingLevel, maxOutputTokens: MAX_OUTPUT_TOKENS });
  let res;
  let json = null;
  try {
    res = await d.fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    json = await res.json().catch(() => null);
  } catch {
    throw providerError('答えが時間内に返りませんでした。もう一度お試しください');
  }
  if (res.status < 200 || res.status >= 300) {
    const cls = provider === 'openai' ? openai.classifyOpenAIError({ status: res.status, json }) : gemini.classifyGeminiError({ status: res.status, json });
    throw failure(cls.kind);
  }
  if (provider === 'openai') {
    const p = openai.parseResponsesResponse(json);
    if (!p.text) throw failure('provider');
    return { answer: p.text, inputTokens: p.usage?.inputTokens ?? 0, outputTokens: p.usage?.outputTokens ?? 0 };
  }
  const p = gemini.parseGenerateResponse(json);
  if (p.blocked) throw failure('blocked');
  if (!p.text) throw failure('provider');
  return { answer: p.text, inputTokens: p.usage?.inputTokens ?? 0, outputTokens: (p.usage?.outputTokens ?? 0) + (p.usage?.thoughtTokens ?? 0) };
}

// ---- 保存 ----

// 連番は利用者ごと。最後の連番の次から、質問と答えを 1 回の batch（1 トランザクション）で置く。
// 同じ人が同時に 2 件送って連番がぶつかったら（主キーの重複）、数え直して置き直す
async function saveExchange(env, minuteId, userId, { question, answer, modelId, inputTokens, outputTokens, at }) {
  let lastError;
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const last = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM minute_chats WHERE minute_id = ? AND user_id = ?')
      .bind(minuteId, userId)
      .first();
    const seq = (last?.m ?? 0) + 1;
    const q = { seq, role: 'user', text: question, model_id: null, created_at: at };
    const a = { seq: seq + 1, role: 'assistant', text: answer, model_id: modelId, created_at: at };
    const ins = env.DB.prepare(
      'INSERT INTO minute_chats (minute_id, user_id, seq, role, text, model_id, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    try {
      await env.DB.batch([
        ins.bind(minuteId, userId, q.seq, q.role, q.text, null, 0, 0, at),
        ins.bind(minuteId, userId, a.seq, a.role, a.text, modelId, inputTokens, outputTokens, at),
      ]);
      return { question: q, answer: a };
    } catch (e) {
      lastError = e;
    }
  }
  console.error('chat: save failed', lastError?.name);
  throw new ApiError(409, 'conflict', '同時に送られたため保存できませんでした。もう一度お試しください');
}
