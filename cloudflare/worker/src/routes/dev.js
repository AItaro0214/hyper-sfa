// /api/dev/*（管理者 = 開発者）。API キー、モデル、プロンプト、試し読み、CSV、利用状況、監査ログ。
// minutes-test は議事録側の担当。
import {
  CARD_CSV_COLUMNS,
  DEFAULT_PROMPTS,
  HISTORY_CSV_COLUMNS,
  MINUTES_USAGE_CSV_COLUMNS,
  buildCsv,
  cardToCsvRow,
  gemini,
  historyToCsvRows,
  minutesUsageToCsvRow,
  openai,
  parseQuery,
  ulid,
} from '../core.js';
import { rowToCard } from '../lib/cards.js';
import { ApiError, notConfigured, notFound, providerError, validation } from '../lib/errors.js';
import { ProviderError, deleteFromFilesApi, generateCard, interpretCardResponse, uploadToFilesApi } from '../lib/gemini-run.js';
import { buildCardSearch, clampLimit } from '../lib/search.js';
import {
  PROVIDERS,
  USES,
  currentPrompt,
  getApiKey,
  getModel,
  keyStatus,
  listModels,
  saveApiKey,
  savePrompt,
  selection,
} from '../lib/settings.js';
import { signedPath, verifySignedPath } from '../lib/sign.js';
import { jstDayStart, jstMonthStart, jstNextDayStart, jstNextMonthStart, nowIso, safeJson } from '../lib/time.js';
import { MINUTES_USAGE_KINDS, audit, recordUsage } from '../lib/usage.js';
import { Check, readJson } from '../lib/validate.js';
import { historyItem } from './admin.js';
import { KEY_PATTERN } from './cards.js';

const EXPORT_TTL_SEC = 300;
const EXPORT_MAX_ROWS = 20000;
const thisMonth = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);

function assertProvider(check, provider) {
  if (!PROVIDERS.includes(provider)) throw notFound('提供元が見つかりません');
}

async function settingsResponse(env) {
  const [gem, oai, sel] = await Promise.all([keyStatus(env, 'gemini'), keyStatus(env, 'openai'), selection(env)]);
  const prompts = {};
  for (const kind of USES) prompts[kind] = { version: (await currentPrompt(env, kind)).version };
  return { keys: { gemini: gem, openai: oai }, models: sel, prompts };
}

// キー付きのモデル一覧の問い合わせ。キーそのものは応答にもログにも出さない
async function fetchProviderModels(env, provider) {
  const apiKey = await getApiKey(env, provider);
  if (!apiKey) throw notConfigured('API キーが登録されていません');
  const mod = provider === 'openai' ? openai : gemini;
  const req = mod.buildListModelsRequest({ apiKey });
  let res;
  try {
    res = await fetch(req.url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(15000) });
  } catch {
    throw providerError('接続できませんでした。しばらくしてからもう一度お試しください');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw providerError(`API キーが使えませんでした（HTTP ${res.status}）`);
  return mod.parseListModels(json);
}

function readModelInput(check, body, { partial }) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('label')) out.label = check.str(body.label, 'label', { required: true, max: 100, label: '表示名' });
  if (!partial || has('uses')) {
    const uses = check.strList(body.uses, 'uses', { maxItems: 3, maxLen: 20, label: '用途' });
    if (!uses.length || !uses.every((u) => USES.includes(u))) check.fail('uses', '用途は card / transcribe / summarize から選んでください');
    out.uses = uses;
  }
  if (!partial || has('pricing')) {
    const p = body.pricing;
    if (!p || typeof p !== 'object' || Array.isArray(p)) check.fail('pricing', '単価はオブジェクトで指定してください');
    else out.pricing = p;
  }
  if (has('thinkingLevel')) out.thinkingLevel = body.thinkingLevel ? check.str(body.thinkingLevel, 'thinkingLevel', { max: 20 }) : null;
  if (has('maxAudioMinutes')) {
    if (body.maxAudioMinutes === null) out.maxAudioMinutes = null;
    else if (Number.isInteger(body.maxAudioMinutes) && body.maxAudioMinutes > 0) out.maxAudioMinutes = body.maxAudioMinutes;
    else check.fail('maxAudioMinutes', '1 回に渡せる音声の長さは正の整数で指定してください');
  }
  if (has('shutdownAt')) {
    if (body.shutdownAt === null || body.shutdownAt === '') out.shutdownAt = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(body.shutdownAt)) out.shutdownAt = body.shutdownAt;
    else check.fail('shutdownAt', '提供終了日は YYYY-MM-DD の形で指定してください');
  }
  if (has('active')) out.active = body.active ? 1 : 0;
  return out;
}

// ---- 利用状況の集計 ----

const USE_OF = { transcribe_retry: 'transcribe', summarize_retry: 'summarize' };
const zeroUse = () => ({ count: 0, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0 });

function monthRange(q) {
  const from = q.from || thisMonth();
  const to = q.to || from;
  const start = jstMonthStart(from);
  const end = jstNextMonthStart(to);
  if (!start || !end) throw validation([{ field: 'from', message: '期間は YYYY-MM の形で指定してください' }]);
  return { from, to, start, end };
}

async function minutesUsage(env, q) {
  const { from, to } = monthRange(q);
  const kinds = MINUTES_USAGE_KINDS.map(() => '?').join(',');
  const [users, rows] = await Promise.all([
    env.DB.prepare('SELECT id, login_id, display_name, status FROM users ORDER BY display_name, login_id').all(),
    env.DB.prepare(
      `SELECT user_id, kind, SUM(count) AS count, SUM(failed) AS failed, SUM(seconds) AS seconds,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost) AS cost, MAX(last_used_at) AS last_used_at
       FROM usage_monthly WHERE year_month >= ? AND year_month <= ? AND kind IN (${kinds}) GROUP BY user_id, kind`,
    )
      .bind(from, to, ...MINUTES_USAGE_KINDS)
      .all(),
  ]);
  const byUser = new Map();
  for (const r of rows.results) {
    const u = byUser.get(r.user_id) ?? {
      recordings: 0, recordedSec: 0, transcribe: { first: 0, retry: 0 }, summarize: { first: 0, retry: 0 },
      failed: 0, transcribedSec: 0, inputTokens: 0, outputTokens: 0, cost: 0, lastUsedAt: null,
    };
    if (r.kind === 'recording') {
      u.recordings += r.count;
      u.recordedSec += r.seconds;
    } else {
      const [use, retry] = r.kind.endsWith('_retry') ? [r.kind.replace('_retry', ''), 'retry'] : [r.kind, 'first'];
      u[use][retry] += r.count;
      u.failed += r.failed;
      if (use === 'transcribe') u.transcribedSec += r.seconds;
      u.inputTokens += r.input_tokens;
      u.outputTokens += r.output_tokens;
      u.cost += r.cost;
    }
    if (r.last_used_at && (!u.lastUsedAt || r.last_used_at > u.lastUsedAt)) u.lastUsedAt = r.last_used_at;
    byUser.set(r.user_id, u);
  }
  const empty = () => ({
    recordings: 0, recordedSec: 0, transcribe: { first: 0, retry: 0 }, summarize: { first: 0, retry: 0 },
    failed: 0, transcribedSec: 0, inputTokens: 0, outputTokens: 0, cost: 0, lastUsedAt: null,
  });
  const includeUnused = q.includeUnused === 'true' || q.includeUnused === '1';
  const items = [];
  const total = { ...empty(), transcribe: { first: 0, retry: 0 }, summarize: { first: 0, retry: 0 } };
  for (const u of users.results) {
    const usage = byUser.get(u.id);
    if (!usage && !includeUnused) continue;
    const item = { user: { id: u.id, name: u.display_name || u.login_id, departments: [], status: u.status }, ...(usage ?? empty()) };
    items.push(item);
    total.recordings += item.recordings;
    total.recordedSec += item.recordedSec;
    for (const use of ['transcribe', 'summarize']) for (const k of ['first', 'retry']) total[use][k] += item[use][k];
    for (const k of ['failed', 'transcribedSec', 'inputTokens', 'outputTokens', 'cost']) total[k] += item[k];
  }
  items.sort((a, b) => b.recordedSec - a.recordedSec);
  return { items, total };
}

export function devRoutes(app) {
  app.get('/api/dev/settings', async (c) => c.json(await settingsResponse(c.env)));

  // ---- API キー ----
  app.put('/api/dev/keys/:provider', async (c) => {
    const provider = c.req.param('provider');
    assertProvider(null, provider);
    const body = await readJson(c);
    const check = new Check();
    const key = check.str(body.key, 'key', { required: true, min: 10, max: 400, pattern: /^\S+$/, label: 'API キー' });
    check.done();
    await saveApiKey(c.env, provider, key, c.get('user').id);
    await audit(c.env, c.get('user').id, 'key.update', { provider });
    return c.json(await settingsResponse(c.env));
  });

  app.post('/api/dev/keys/:provider/test', async (c) => {
    const provider = c.req.param('provider');
    assertProvider(null, provider);
    const models = await fetchProviderModels(c.env, provider);
    return c.json({ ok: true, models: models.length });
  });

  // ---- モデル ----
  app.get('/api/dev/models', async (c) => c.json({ items: await listModels(c.env) }));

  app.get('/api/dev/models/available', async (c) => {
    const provider = c.req.query('provider') || 'gemini';
    assertProvider(null, provider);
    return c.json({ items: await fetchProviderModels(c.env, provider) });
  });

  app.post('/api/dev/models', async (c) => {
    const body = await readJson(c);
    const check = new Check();
    const id = check.str(body.id, 'id', { required: true, max: 100, pattern: /^[A-Za-z0-9._:/-]+$/, label: 'モデル ID' });
    const provider = check.oneOf(body.provider, PROVIDERS, 'provider', '提供元');
    const input = readModelInput(check, body, { partial: false });
    check.done();
    if (await getModel(c.env, id)) throw new ApiError(409, 'conflict', 'このモデル ID はすでに登録されています');
    await c.env.DB.prepare(
      `INSERT INTO models (id, provider, label, uses, pricing, thinking_level, max_audio_minutes, shutdown_at, active, builtin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
      .bind(id, provider, input.label, JSON.stringify(input.uses), JSON.stringify(input.pricing), input.thinkingLevel ?? null, input.maxAudioMinutes ?? null, input.shutdownAt ?? null, input.active ?? 1)
      .run();
    await audit(c.env, c.get('user').id, 'model.create', { modelId: id });
    return c.json(await getModel(c.env, id), 201);
  });

  app.patch('/api/dev/models/:id', async (c) => {
    const id = c.req.param('id');
    const current = await getModel(c.env, id);
    if (!current) throw notFound('モデルが見つかりません');
    const body = await readJson(c);
    const check = new Check();
    const input = readModelInput(check, body, { partial: true });
    check.done();
    const next = {
      label: input.label ?? current.label,
      uses: input.uses ?? current.uses,
      pricing: input.pricing ?? current.pricing,
      thinkingLevel: 'thinkingLevel' in input ? input.thinkingLevel : current.thinkingLevel,
      maxAudioMinutes: 'maxAudioMinutes' in input ? input.maxAudioMinutes : current.maxAudioMinutes,
      shutdownAt: 'shutdownAt' in input ? input.shutdownAt : current.shutdownAt,
      active: input.active ?? (current.active ? 1 : 0),
    };
    await c.env.DB.prepare(
      'UPDATE models SET label = ?, uses = ?, pricing = ?, thinking_level = ?, max_audio_minutes = ?, shutdown_at = ?, active = ? WHERE id = ?',
    )
      .bind(next.label, JSON.stringify(next.uses), JSON.stringify(next.pricing), next.thinkingLevel, next.maxAudioMinutes, next.shutdownAt, next.active, id)
      .run();
    await audit(c.env, c.get('user').id, 'model.update', { modelId: id });
    return c.json(await getModel(c.env, id));
  });

  app.put('/api/dev/model', async (c) => {
    const body = await readJson(c);
    const check = new Check();
    const use = check.oneOf(body.use, USES, 'use', '用途');
    const modelId = check.str(body.modelId, 'modelId', { required: true, max: 100, label: 'モデル' });
    check.done();
    const model = await getModel(c.env, modelId);
    if (!model || !model.active) throw validation([{ field: 'modelId', message: '使えないモデルです' }]);
    if (!model.uses.includes(use)) throw validation([{ field: 'modelId', message: 'このモデルはこの用途に使えません' }]);
    await c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
      .bind(`model:${use}`, modelId, c.get('user').id, nowIso())
      .run();
    await audit(c.env, c.get('user').id, 'model.select', { use, modelId });
    return c.json(await settingsResponse(c.env));
  });

  // ---- プロンプト ----
  const kindOf = (c) => {
    const kind = c.req.param('kind');
    if (!USES.includes(kind)) throw notFound('プロンプトが見つかりません');
    return kind;
  };

  app.get('/api/dev/prompts/:kind', async (c) => c.json(await currentPrompt(c.env, kindOf(c))));

  app.put('/api/dev/prompts/:kind', async (c) => {
    const kind = kindOf(c);
    const body = await readJson(c);
    const check = new Check();
    // 空文字は「初期値に戻す」
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (typeof body.text !== 'string') check.fail('text', 'text が必要です');
    if (text.length > 30000) check.fail('text', 'プロンプトは 30,000 文字以内にしてください');
    check.done();
    await savePrompt(c.env, kind, text, c.get('user').id);
    await audit(c.env, c.get('user').id, 'prompt.update', { kind, reset: text === '' });
    return c.json(await currentPrompt(c.env, kind));
  });

  app.get('/api/dev/prompts/:kind/history', async (c) => {
    const kind = kindOf(c);
    const { results } = await c.env.DB.prepare(
      `SELECT p.version, p.text, p.saved_at, u.display_name, u.login_id FROM prompts p
       LEFT JOIN users u ON u.id = p.saved_by WHERE p.kind = ? ORDER BY p.version DESC LIMIT 100`,
    )
      .bind(kind)
      .all();
    return c.json({
      items: results.map((r) => ({
        version: r.version,
        savedBy: r.display_name || r.login_id || null,
        savedAt: r.saved_at,
        text: r.text === '' ? DEFAULT_PROMPTS[kind] : r.text,
      })),
    });
  });

  app.post('/api/dev/prompts/:kind/revert', async (c) => {
    const kind = kindOf(c);
    const body = await readJson(c);
    if (!Number.isInteger(body.version)) throw validation([{ field: 'version', message: 'version が必要です' }]);
    const row = await c.env.DB.prepare('SELECT text FROM prompts WHERE kind = ? AND version = ?').bind(kind, body.version).first();
    if (!row) throw notFound('その版はありません');
    await savePrompt(c.env, kind, row.text, c.get('user').id);
    await audit(c.env, c.get('user').id, 'prompt.revert', { kind, fromVersion: body.version });
    return c.json(await currentPrompt(c.env, kind));
  });

  // ---- 試し読み（同期。Workflow を通さない） ----
  app.post('/api/dev/scan-test', async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const check = new Check();
    const front = check.str(body.frontKey, 'frontKey', { required: true });
    const back = check.str(body.backKey, 'backKey');
    for (const [f, k] of [['frontKey', front], ['backKey', back]]) if (k && !KEY_PATTERN.test(k)) check.fail(f, '画像のキーが正しくありません');
    const promptText = typeof body.promptText === 'string' ? body.promptText.trim() : '';
    check.done();

    const modelId = body.modelId || (await selection(c.env)).card;
    const model = await getModel(c.env, modelId);
    if (!model || model.provider !== 'gemini') throw validation([{ field: 'modelId', message: '名刺の読み取りには Gemini のモデルを選んでください' }]);
    const apiKey = await getApiKey(c.env, 'gemini');
    if (!apiKey) throw notConfigured('Gemini の API キーが登録されていません');
    const prompt = promptText || (await currentPrompt(c.env, 'card')).text;

    const started = Date.now();
    const files = [];
    try {
      // R2 の本文をそのまま Files API に流す（Worker の中で画像を読まない）
      for (const [side, key] of [['front', front], ['back', back]]) {
        if (!key) continue;
        const object = await c.env.IMAGES.get(key);
        if (!object) throw notFound('画像が見つかりません');
        files.push(await uploadToFilesApi({ apiKey, object, displayName: `test-${side}` }));
      }
      const gen = await generateCard({ apiKey, model, prompt, files });
      const interp = interpretCardResponse(gen);
      const usage = { inputTokens: gen.usage.inputTokens, outputTokens: gen.usage.outputTokens + (gen.usage.thoughtTokens ?? 0) };
      await recordUsage(c.env, { kind: 'test', userId: user.id, modelId: model.id, model, ok: interp.ok, failureKind: interp.ok ? null : interp.kind, ...usage });
      return c.json({
        card: interp.card ? { ...interp.card } : null,
        raw: gen.text,
        repairs: interp.repairs ?? [],
        ok: interp.ok,
        failureKind: interp.ok ? null : interp.kind,
        usage,
        elapsedMs: Date.now() - started,
      });
    } catch (e) {
      if (e instanceof ProviderError) {
        if (e.kind === 'not_configured') throw notConfigured('API キーまたはモデルが使えません。設定を確かめてください');
        throw providerError(e.message);
      }
      throw e;
    } finally {
      if (files.length) c.executionCtx.waitUntil(Promise.all(files.map((f) => deleteFromFilesApi({ apiKey, name: f.name }))));
    }
  });

  // ---- CSV ----
  app.post('/api/dev/export', async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const check = new Check();
    const kind = check.oneOf(body.kind, ['cards', 'history', 'minutes-usage'], 'kind', '種類');
    check.done();
    const filters = body.filters && typeof body.filters === 'object' ? body.filters : {};

    let csv;
    let rowCount;
    if (kind === 'cards') {
      const built = buildCardSearch(
        {
          terms: parseQuery(filters),
          ownerId: filters.owner || null,
          fromIso: filters.from ? jstDayStart(filters.from) : null,
          toIso: filters.to ? jstNextDayStart(filters.to) : null,
          status: ['review', 'confirmed'].includes(filters.status) ? filters.status : null,
          viewerId: user.id,
        },
        { limit: EXPORT_MAX_ROWS, prefix: 'c.', from: 'cards c', select: 'SELECT c.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name' },
      );
      const sql = built.listSql.replace(
        ' FROM cards c WHERE',
        ' FROM cards c LEFT JOIN users cu ON cu.id = c.created_by LEFT JOIN users uu ON uu.id = c.updated_by WHERE',
      );
      const [cards, edits] = await Promise.all([
        c.env.DB.prepare(sql).bind(...built.listParams).all(),
        c.env.DB.prepare("SELECT card_id, at, actor_name, changes FROM card_history WHERE type = 'edit' ORDER BY at").all(),
      ]);
      const editsByCard = new Map();
      for (const e of edits.results) {
        const list = editsByCard.get(e.card_id) ?? [];
        list.push({ at: e.at, actor: { name: e.actor_name }, changes: safeJson(e.changes, []) });
        editsByCard.set(e.card_id, list);
      }
      const rows = cards.results.slice(0, EXPORT_MAX_ROWS).map((r) => {
        const card = rowToCard(r);
        card.scanModel = safeJson(r.extraction, {}).modelId ?? '';
        return cardToCsvRow(card, { editEvents: editsByCard.get(r.id) ?? [] });
      });
      csv = buildCsv(rows, CARD_CSV_COLUMNS);
      rowCount = rows.length;
    } else if (kind === 'history') {
      const where = ['1 = 1'];
      const params = [];
      if (['create', 'edit', 'rescan', 'delete', 'restore'].includes(filters.type)) (where.push('h.type = ?'), params.push(filters.type));
      const from = filters.from ? jstDayStart(filters.from) : null;
      const to = filters.to ? jstNextDayStart(filters.to) : null;
      if (from) (where.push('h.at >= ?'), params.push(from));
      if (to) (where.push('h.at < ?'), params.push(to));
      if (filters.actor) (where.push('h.actor_id = ?'), params.push(filters.actor));
      const { results } = await c.env.DB.prepare(
        `SELECT h.*, c.company, c.name FROM card_history h LEFT JOIN cards c ON c.id = h.card_id
         WHERE ${where.join(' AND ')} ORDER BY h.id DESC LIMIT ?`,
      )
        .bind(...params, EXPORT_MAX_ROWS)
        .all();
      const rows = results.flatMap((r) => historyToCsvRows(historyItem(r)));
      csv = buildCsv(rows, HISTORY_CSV_COLUMNS);
      rowCount = rows.length;
    } else {
      const { items } = await minutesUsage(c.env, { ...filters, includeUnused: filters.includeUnused ? 'true' : 'false' });
      csv = buildCsv(items.map(minutesUsageToCsvRow), MINUTES_USAGE_CSV_COLUMNS);
      rowCount = items.length;
    }

    const id = ulid();
    await c.env.DATA.put(`exports/${id}.csv`, csv, { httpMetadata: { contentType: 'text/csv; charset=utf-8' }, customMetadata: { kind } });
    await audit(c.env, user.id, 'export', { kind, rows: rowCount });
    return c.json({
      url: await signedPath(c.env, `/api/dev/exports/${id}`, EXPORT_TTL_SEC, user.id),
      expiresAt: new Date(Date.now() + EXPORT_TTL_SEC * 1000).toISOString(),
      rows: rowCount,
    });
  });

  app.get('/api/dev/exports/:id', async (c) => {
    const url = new URL(c.req.url);
    const id = c.req.param('id');
    if (!/^[0-9A-Z]{26}$/.test(id) || !(await verifySignedPath(c.env, url.pathname + url.search, c.get('user').id))) {
      throw new ApiError(403, 'forbidden', 'ダウンロード用の URL が正しくないか、期限が切れています');
    }
    const object = await c.env.DATA.get(`exports/${id}.csv`);
    if (!object) throw notFound('ファイルが見つかりません');
    const kind = object.customMetadata?.kind ?? 'export';
    return new Response(object.body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="hyper-sfa-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  });

  // ---- 利用状況 ----
  app.get('/api/dev/usage', async (c) => {
    const q = c.req.query();
    const { from, to, start, end } = monthRange(q);
    const [monthly, models] = await Promise.all([
      c.env.DB.prepare(
        `SELECT year_month, kind, SUM(count) AS count, SUM(failed) AS failed, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost) AS cost
         FROM usage_monthly WHERE year_month >= ? AND year_month <= ? GROUP BY year_month, kind`,
      )
        .bind(from, to)
        .all(),
      c.env.DB.prepare(
        `SELECT substr(at, 1, 7) AS month, model_id, COUNT(*) AS count, SUM(1 - ok) AS failed, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost) AS cost
         FROM usage_events WHERE at >= ? AND at < ? AND model_id IS NOT NULL GROUP BY month, model_id`,
      )
        .bind(start, end)
        .all(),
    ]);
    const months = new Map();
    const slot = (m) => {
      if (!months.has(m)) months.set(m, { month: m, byUse: {}, byModel: [] });
      return months.get(m);
    };
    for (const r of monthly.results) {
      if (r.kind === 'recording') continue;
      const use = USE_OF[r.kind] ?? r.kind;
      const u = (slot(r.year_month).byUse[use] ??= zeroUse());
      u.count += r.count;
      u.failed += r.failed;
      u.inputTokens += r.i;
      u.outputTokens += r.o;
      u.cost += r.cost;
    }
    for (const r of models.results) {
      slot(r.month).byModel.push({ modelId: r.model_id, count: r.count, failed: r.failed, inputTokens: r.i, outputTokens: r.o, cost: r.cost });
    }
    return c.json({ months: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)) });
  });

  app.get('/api/dev/usage/minutes', async (c) => c.json(await minutesUsage(c.env, c.req.query())));

  app.get('/api/dev/usage/minutes/:userId', async (c) => {
    const userId = c.req.param('userId');
    const kinds = MINUTES_USAGE_KINDS.map(() => '?').join(',');
    const [monthly, events] = await Promise.all([
      c.env.DB.prepare(
        `SELECT year_month, kind, count, failed, seconds, input_tokens, output_tokens, cost FROM usage_monthly
         WHERE user_id = ? AND kind IN (${kinds}) ORDER BY year_month DESC`,
      )
        .bind(userId, ...MINUTES_USAGE_KINDS)
        .all(),
      c.env.DB.prepare(
        `SELECT at, kind, duration_sec, model_id, ok, failure_kind, input_tokens, output_tokens, cost FROM usage_events
         WHERE user_id = ? AND kind IN (${kinds}) ORDER BY at DESC LIMIT 200`,
      )
        .bind(userId, ...MINUTES_USAGE_KINDS)
        .all(),
    ]);
    const months = new Map();
    for (const r of monthly.results) {
      const m = months.get(r.year_month) ?? { month: r.year_month, byKind: {} };
      m.byKind[r.kind] = { count: r.count, failed: r.failed, seconds: r.seconds, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cost: r.cost };
      months.set(r.year_month, m);
    }
    return c.json({
      months: [...months.values()],
      events: events.results.map((e) => ({
        at: e.at, kind: e.kind, durationSec: e.duration_sec, modelId: e.model_id, ok: Boolean(e.ok),
        failureKind: e.failure_kind, inputTokens: e.input_tokens, outputTokens: e.output_tokens, cost: e.cost,
      })),
    });
  });

  app.get('/api/dev/audit', async (c) => {
    const q = c.req.query();
    const where = ['1 = 1'];
    const params = [];
    const from = q.from ? jstDayStart(q.from) : null;
    const to = q.to ? jstNextDayStart(q.to) : null;
    if (from) (where.push('a.at >= ?'), params.push(from));
    if (to) (where.push('a.at < ?'), params.push(to));
    if (q.cursor) (where.push('a.id < ?'), params.push(q.cursor));
    const limit = clampLimit(q.limit);
    const { results } = await c.env.DB.prepare(
      `SELECT a.*, u.display_name, u.login_id FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`,
    )
      .bind(...params, limit + 1)
      .all();
    const page = results.slice(0, limit);
    return c.json({
      items: page.map((r) => ({
        at: r.at,
        actor: r.actor_id ? { id: r.actor_id, name: r.display_name || r.login_id || '' } : null,
        action: r.action,
        detail: safeJson(r.detail, {}),
      })),
      nextCursor: results.length > limit ? page[page.length - 1].id : null,
    });
  });

  // 役職は AWS 版だけ
  app.all('/api/dev/positions', () => {
    throw notFound();
  });
}
