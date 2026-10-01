// 開発コンソール（/api/dev/*。docs/api-contract.md §6）のうち、キー・モデル・プロンプト・試し・役職。
// 利用状況、監査ログ、CSV 出力は reports.js。
import * as core from '@hyper-sfa/core';
import {
  ddb, K, audit, putApiKey, getApiKey, getKeyMeta, getSelection, getPrompt, getModel, clearSettingsCache,
  loadPositions, clearPositionsCache, invalidateUser, invokeAsync, invokeSync,
  HttpError, notFound, conflict, validation, readJson,
} from '@hyper-sfa/aws-shared';
import { me, listUserItems, emailOf } from './common.js';

const { DEFAULT_MODELS, LEVELS, levelFor, normalizeText, ulid } = core;
const PROVIDERS = ['gemini', 'openai'];
const KINDS = ['card', 'transcribe', 'summarize'];
const PROMPT_MAX = 20_000;
const TEST_TTL_SEC = 24 * 3600;

const provider = (c) => {
  const p = c.req.param('provider') ?? c.req.query('provider');
  if (!PROVIDERS.includes(p)) throw validation('provider は gemini か openai です', [{ field: 'provider', message: 'gemini / openai' }]);
  return p;
};
const kindOf = (c) => {
  const k = c.req.param('kind');
  if (!KINDS.includes(k)) throw notFound('用途が見つかりません');
  return k;
};

// ---- プロバイダーへの問い合わせ（モデル一覧） ----

// gemini.js と openai.js の buildListModelsRequest は名前が重なるので、core は OpenAI 側に別名を付けている
function listModelsRequest(p, apiKey) {
  return p === 'gemini' ? core.buildListModelsRequest({ apiKey }) : core.buildOpenAIListModelsRequest({ apiKey });
}

async function fetchModelIds(p, apiKey) {
  const req = listModelsRequest(p, apiKey);
  let res;
  try {
    res = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers, body: req.body, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(502, 'provider_error', '接続できませんでした。しばらくしてからもう一度お試しください');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const cls = p === 'gemini' ? core.classifyGeminiError({ status: res.status, json }) : core.classifyOpenAIError({ status: res.status, json });
    if (cls.kind === 'not_configured') throw new HttpError(502, 'provider_error', 'API キーが無効です。キーを確かめてください');
    throw new HttpError(502, 'provider_error', cls.message || '接続テストに失敗しました');
  }
  return p === 'gemini' ? core.parseListModels(json) : core.parseOpenAIListModels(json);
}

// ---- 設定の書き込み ----

async function updateGeminiSetting(fn) {
  const k = K.setting('gemini');
  const cur = (await ddb.get(k.pk, k.sk)) ?? {};
  await ddb.put({ ...cur, ...k, ...fn(cur) });
  clearSettingsCache();
}

async function settingsBody() {
  const [gemini, openai, models, card, transcribe, summarize] = await Promise.all([
    getKeyMeta('gemini'), getKeyMeta('openai'), getSelection(), getPrompt('card'), getPrompt('transcribe'), getPrompt('summarize'),
  ]);
  return {
    keys: { gemini, openai },
    models: { card: models.card, transcribe: models.transcribe, summarize: models.summarize },
    prompts: { card: { version: card.version }, transcribe: { version: transcribe.version }, summarize: { version: summarize.version } },
  };
}

// ---- モデル ----

const presentModel = (m) => ({
  id: m.id,
  provider: m.provider,
  label: m.label ?? m.id,
  uses: m.uses ?? [],
  pricing: m.pricing ?? {},
  thinkingLevel: m.thinkingLevel ?? null,
  maxAudioMinutes: m.maxAudioMinutes ?? null,
  shutdownAt: m.shutdownAt ?? null,
  tier: m.tier ?? null,
  status: m.status ?? 'stable',
  note: m.note ?? '',
  active: m.active !== false,
  builtin: m.builtin === true,
});

// 初期一覧（core の DEFAULT_MODELS）で、後から足した説明の項目。既に DynamoDB にある初期モデルにはこれだけを補う。
// 単価・有効 / 無効・用途は開発コンソールで変えられるので、上書きしない
const META_KEYS = ['label', 'tier', 'status', 'note'];

/** core の初期一覧を DynamoDB に揃える。無いモデルは足し、ある初期モデルには説明の項目だけ補う。以後は開発コンソールで変えられる（§5.2）。 */
async function listModels() {
  let items = await ddb.queryAll({ pk: 'ORG', skPrefix: 'MODEL#' });
  const idOf = (i) => i.id ?? String(i.sk).slice('MODEL#'.length);
  const byId = new Map(items.map((i) => [idOf(i), i]));
  const writes = [];
  for (const m of DEFAULT_MODELS) {
    const cur = byId.get(m.id);
    if (!cur) {
      // 初期一覧に後から足したモデル（大型モデルなど）が、既に運用中の環境にも出るように
      writes.push(ddb.put({ ...K.model(m.id), ...m, active: m.active !== false }, { condition: 'attribute_not_exists(pk)' }).catch(() => {}));
      continue;
    }
    const patch = {};
    for (const k of META_KEYS) if (cur[k] == null && m[k] != null) patch[k] = m[k];
    if (Object.keys(patch).length) writes.push(ddb.update('ORG', `MODEL#${m.id}`, { set: patch }).catch(() => {}));
  }
  if (writes.length) {
    await Promise.all(writes);
    items = await ddb.queryAll({ pk: 'ORG', skPrefix: 'MODEL#' });
  }
  return items.map((i) => ({ ...i, id: idOf(i) })).sort((a, b) => a.id.localeCompare(b.id));
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function cleanPricing(p, errors) {
  if (p == null || typeof p !== 'object') {
    errors.push({ field: 'pricing', message: '単価を指定してください' });
    return {};
  }
  const out = {};
  for (const f of ['input', 'output', 'audioInput', 'perMinute']) {
    if (p[f] === undefined) continue;
    if (!isNum(p[f])) errors.push({ field: `pricing.${f}`, message: '0 以上の数で指定してください' });
    else out[f] = p[f];
  }
  if (p.changesAt !== undefined) {
    if (!isDate(p.changesAt)) errors.push({ field: 'pricing.changesAt', message: 'YYYY-MM-DD で指定してください' });
    else out.changesAt = p.changesAt;
  }
  if (p.next !== undefined) {
    if (p.next && typeof p.next === 'object' && isNum(p.next.input) && isNum(p.next.output)) out.next = { input: p.next.input, output: p.next.output };
    else errors.push({ field: 'pricing.next', message: 'input と output を指定してください' });
  }
  if (out.input === undefined && out.perMinute === undefined) errors.push({ field: 'pricing', message: 'input か perMinute が必要です' });
  return out;
}

function cleanModelFields(b, errors, { partial }) {
  const out = {};
  const has = (f) => b[f] !== undefined;
  if (!partial || has('label')) {
    if (typeof b.label !== 'string' || !b.label.trim() || b.label.length > 100) errors.push({ field: 'label', message: '1〜100 文字で入力してください' });
    else out.label = b.label.trim();
  }
  if (!partial || has('uses')) {
    if (!Array.isArray(b.uses) || b.uses.length === 0 || b.uses.some((u) => !KINDS.includes(u))) errors.push({ field: 'uses', message: 'card / transcribe / summarize から選んでください' });
    else out.uses = [...new Set(b.uses)];
  }
  if (!partial || has('pricing')) out.pricing = cleanPricing(b.pricing, errors);
  if (has('thinkingLevel')) out.thinkingLevel = b.thinkingLevel === null ? null : String(b.thinkingLevel).slice(0, 30);
  if (has('maxAudioMinutes')) {
    if (b.maxAudioMinutes !== null && !(Number.isInteger(b.maxAudioMinutes) && b.maxAudioMinutes > 0)) errors.push({ field: 'maxAudioMinutes', message: '正の整数で指定してください' });
    else out.maxAudioMinutes = b.maxAudioMinutes;
  }
  if (has('shutdownAt')) {
    if (b.shutdownAt !== null && !isDate(b.shutdownAt)) errors.push({ field: 'shutdownAt', message: 'YYYY-MM-DD で指定してください' });
    else out.shutdownAt = b.shutdownAt;
  }
  if (has('active')) out.active = b.active === true;
  return out;
}

export function registerDevRoutes(app) {
  // ---- API キー ----

  app.get('/api/dev/settings', async (c) => c.json(await settingsBody()));

  app.put('/api/dev/keys/:provider', async (c) => {
    const actor = me(c);
    const p = provider(c);
    const b = await readJson(c);
    const key = typeof b.key === 'string' ? b.key.trim() : '';
    if (key.length < 8 || key.length > 512 || /\s/.test(key)) throw validation('API キーの形式が正しくありません', [{ field: 'key', message: '空白を含まない 8〜512 文字' }]);
    await putApiKey(p, key, { id: actor.id, name: actor.displayName });
    // 記録に残すのは「誰がいつどの系統を更新したか」だけ。キーの値は書かない
    await audit(actor, 'apikey.update', { provider: p });
    return c.json(await settingsBody());
  });

  app.post('/api/dev/keys/:provider/test', async (c) => {
    const p = provider(c);
    const apiKey = await getApiKey(p);
    if (!apiKey) throw new HttpError(503, 'not_configured', 'API キーがまだ登録されていません');
    const ids = await fetchModelIds(p, apiKey);
    return c.json({ ok: true, models: ids.length });
  });

  // ---- モデル ----

  app.get('/api/dev/models', async (c) => c.json({ items: (await listModels()).map(presentModel) }));

  app.post('/api/dev/models', async (c) => {
    const actor = me(c);
    const b = await readJson(c);
    const errors = [];
    if (typeof b.id !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(b.id)) errors.push({ field: 'id', message: '英数字と . _ : - の 1〜80 文字' });
    if (!PROVIDERS.includes(b.provider)) errors.push({ field: 'provider', message: 'gemini か openai' });
    const fields = cleanModelFields(b, errors, { partial: false });
    if (errors.length) throw validation('入力を確かめてください', errors);
    const item = { ...K.model(b.id), id: b.id, provider: b.provider, builtin: false, active: true, thinkingLevel: null, maxAudioMinutes: null, shutdownAt: null, ...fields };
    try {
      await ddb.put(item, { condition: 'attribute_not_exists(pk)' });
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') throw conflict('同じ ID のモデルがすでにあります');
      throw e;
    }
    await audit(actor, 'model.create', { modelId: b.id });
    return c.json(presentModel(item), 201);
  });

  app.patch('/api/dev/models/:id', async (c) => {
    const actor = me(c);
    const id = c.req.param('id');
    const b = await readJson(c);
    const errors = [];
    const fields = cleanModelFields(b, errors, { partial: true });
    if (errors.length) throw validation('入力を確かめてください', errors);
    const cur = await getModel(id);
    const k = K.model(id);
    const stored = await ddb.get(k.pk, k.sk);
    if (!cur) throw notFound('モデルが見つかりません');
    if (fields.active === false) {
      const sel = await getSelection();
      if (Object.values(sel).includes(id)) throw conflict('選択中のモデルは無効にできません。先に別のモデルを選んでください');
    }
    // 初期一覧のモデルが DynamoDB にまだ無い場合も、この更新で書き込む
    const item = { ...(stored ?? { ...DEFAULT_MODELS.find((m) => m.id === id) }), ...k, id, ...fields };
    await ddb.put(item);
    await audit(actor, 'model.update', { modelId: id, changed: Object.keys(fields) });
    return c.json(presentModel(item));
  });

  app.get('/api/dev/models/available', async (c) => {
    const p = provider(c);
    const apiKey = await getApiKey(p);
    if (!apiKey) throw new HttpError(503, 'not_configured', 'API キーがまだ登録されていません');
    return c.json({ items: await fetchModelIds(p, apiKey) });
  });

  app.put('/api/dev/model', async (c) => {
    const actor = me(c);
    const b = await readJson(c);
    if (!KINDS.includes(b.use)) throw validation('use が正しくありません', [{ field: 'use', message: KINDS.join(' / ') }]);
    const model = typeof b.modelId === 'string' ? await getModel(b.modelId) : null;
    if (!model || model.active === false) throw validation('選べないモデルです', [{ field: 'modelId', message: '無い、または無効です' }]);
    if (!(model.uses ?? []).includes(b.use)) throw validation('このモデルはその用途に使えません', [{ field: 'modelId', message: `${b.use} に使えるモデルを選んでください` }]);
    // 名刺の読み取りは Gemini の画像入力だけに対応している
    if (b.use === 'card' && model.provider !== 'gemini') throw validation('名刺の読み取りに使えるのは Gemini のモデルだけです', [{ field: 'modelId', message: 'gemini のモデルを選んでください' }]);
    await updateGeminiSetting((cur) => ({ models: { ...(selectionOf(cur)), [b.use]: b.modelId } }));
    await audit(actor, 'model.select', { use: b.use, modelId: b.modelId });
    return c.json(await settingsBody());
  });

  // ---- プロンプト ----

  const promptBody = async (kind) => {
    const p = await getPrompt(kind);
    return { kind, text: p.text, version: p.version, savedBy: p.savedBy, savedAt: p.savedAt, isDefault: p.isDefault };
  };

  app.get('/api/dev/prompts/:kind', async (c) => c.json(await promptBody(kindOf(c))));

  app.put('/api/dev/prompts/:kind', async (c) => {
    const actor = me(c);
    const kind = kindOf(c);
    const b = await readJson(c);
    if (typeof b.text !== 'string' || b.text.length > PROMPT_MAX) throw validation(`プロンプトは ${PROMPT_MAX} 文字までです`, [{ field: 'text', message: '文字列で指定してください' }]);
    if (!b.text.trim()) {
      // 空にすると初期値に戻る
      await updateGeminiSetting((cur) => ({ promptVersion: { ...(cur.promptVersion ?? {}), [kind]: 0 } }));
      await audit(actor, 'prompt.reset', { kind });
      return c.json(await promptBody(kind));
    }
    const latest = await ddb.query({ pk: 'ORG', skPrefix: `PROMPT#${kind}#`, forward: false, limit: 1 });
    const version = latest.items.length ? Number(latest.items[0].version ?? String(latest.items[0].sk).split('#').pop()) + 1 : 1;
    await ddb.put({ ...K.prompt(kind, version), kind, version, text: b.text, savedBy: actor.id, savedByName: actor.displayName, savedAt: new Date().toISOString() });
    await updateGeminiSetting((cur) => ({ promptVersion: { ...(cur.promptVersion ?? {}), [kind]: version } }));
    await audit(actor, 'prompt.update', { kind, version });
    return c.json(await promptBody(kind));
  });

  app.get('/api/dev/prompts/:kind/history', async (c) => {
    const kind = kindOf(c);
    const items = await ddb.queryAll({ pk: 'ORG', skPrefix: `PROMPT#${kind}#`, forward: false });
    return c.json({ items: items.map((i) => ({ version: i.version, savedBy: i.savedByName || i.savedBy || '', savedAt: i.savedAt ?? null, text: i.text })) });
  });

  app.post('/api/dev/prompts/:kind/revert', async (c) => {
    const actor = me(c);
    const kind = kindOf(c);
    const b = await readJson(c);
    const version = Number(b.version);
    if (!Number.isInteger(version) || version < 0) throw validation('version が正しくありません', [{ field: 'version', message: '0 以上の整数' }]);
    if (version > 0) {
      const k = K.prompt(kind, version);
      if (!(await ddb.get(k.pk, k.sk))) throw notFound('その版はありません');
    }
    await updateGeminiSetting((cur) => ({ promptVersion: { ...(cur.promptVersion ?? {}), [kind]: version } }));
    await audit(actor, 'prompt.revert', { kind, version });
    return c.json(await promptBody(kind));
  });

  // ---- 試し ----

  app.post('/api/dev/scan-test', async (c) => {
    const actor = me(c);
    const b = await readJson(c);
    const re = /^cards\/[0-9A-Za-z]{26}\/(front|back)\.jpg$/;
    const errors = [];
    if (typeof b.frontKey !== 'string' || !re.test(b.frontKey)) errors.push({ field: 'frontKey', message: '画像の場所が正しくありません' });
    if (b.backKey != null && (typeof b.backKey !== 'string' || !re.test(b.backKey))) errors.push({ field: 'backKey', message: '画像の場所が正しくありません' });
    if (b.promptText != null && (typeof b.promptText !== 'string' || b.promptText.length > PROMPT_MAX)) errors.push({ field: 'promptText', message: `${PROMPT_MAX} 文字までです` });
    if (b.modelId != null && typeof b.modelId !== 'string') errors.push({ field: 'modelId', message: '文字列で指定してください' });
    if (errors.length) throw validation('入力を確かめてください', errors);

    let r;
    try {
      // API Gateway は 29 秒で打ち切るので、こちらもそれに合わせて待つのをやめる
      r = await invokeSync('SCAN_FUNCTION_NAME', {
        test: true, frontKey: b.frontKey, backKey: b.backKey ?? undefined, promptText: b.promptText || undefined, modelId: b.modelId || undefined, actor: actor.id,
      }, { timeoutMs: 28_000 });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new HttpError(502, 'provider_error', timedOut ? '29 秒以内に読み取りが終わりませんでした' : '試し読みを実行できませんでした');
    }
    if (!r?.ok) {
      const f = r?.failure ?? {};
      const status = f.kind === 'not_configured' ? 503 : 502;
      const code = f.kind === 'not_configured' ? 'not_configured' : 'provider_error';
      // 開発者が原因を調べられるよう、壊れた応答の一部を添える（開発者だけが呼べる API）
      const details = r?.raw ? [{ field: 'raw', message: String(r.raw).slice(0, 4000) }] : undefined;
      throw new HttpError(status, code, f.message || '読み取りに失敗しました', details);
    }
    return c.json({ card: r.card, raw: r.raw, repairs: r.repairs ?? [], usage: r.usage, elapsedMs: r.elapsedMs });
  });

  app.post('/api/dev/minutes-test', async (c) => {
    const actor = me(c);
    const b = await readJson(c);
    const errors = [];
    if (b.kind !== 'transcribe' && b.kind !== 'summarize') errors.push({ field: 'kind', message: 'transcribe か summarize' });
    if (b.kind === 'transcribe' && !(typeof b.audioKey === 'string' && /^tests\/[0-9A-Za-z]{26}\/audio\.webm$/.test(b.audioKey))) errors.push({ field: 'audioKey', message: '音声の場所が正しくありません' });
    if (b.kind === 'summarize' && (typeof b.transcript !== 'string' || !b.transcript.trim() || b.transcript.length > 300_000)) errors.push({ field: 'transcript', message: '文字起こしを入力してください' });
    if (b.promptText != null && (typeof b.promptText !== 'string' || b.promptText.length > PROMPT_MAX)) errors.push({ field: 'promptText', message: `${PROMPT_MAX} 文字までです` });
    if (errors.length) throw validation('入力を確かめてください', errors);

    const jobId = ulid();
    const now = new Date();
    await ddb.put({
      ...K.setting(`test#${jobId}`), status: 'queued', createdBy: actor.id, updatedAt: now.toISOString(),
      ttl: Math.floor(now.getTime() / 1000) + TEST_TTL_SEC,
    });
    await invokeAsync('MINUTES_FUNCTION_NAME', {
      test: true, jobId, kind: b.kind, audioKey: b.audioKey, mime: 'audio/webm',
      durationSec: Number.isFinite(b.durationSec) ? b.durationSec : undefined,
      transcript: b.transcript, promptText: b.promptText || undefined, modelId: b.modelId || undefined, actor: actor.id,
    });
    return c.json({ jobId }, 202);
  });

  app.get('/api/dev/minutes-test/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    if (!/^[0-9A-Za-z]{26}$/.test(jobId)) throw notFound();
    const k = K.setting(`test#${jobId}`);
    const item = await ddb.get(k.pk, k.sk);
    if (!item) throw notFound('結果が見つかりません（24 時間で消えます）');
    if (item.status === 'done') return c.json({ status: 'done', ...item.result });
    if (item.status === 'failed') return c.json({ status: 'failed', error: item.failure ?? { kind: 'provider', message: '失敗しました' } });
    return c.json({ status: item.status === 'running' ? 'running' : 'queued' });
  });

  // ---- 役職と権限の段階 ----

  const positionsBody = async () => ({
    items: (await loadPositions()).map((p, i) => ({ name: p.name, level: p.level, order: p.order ?? i + 1 })),
  });

  app.get('/api/dev/positions', async (c) => c.json(await positionsBody()));

  app.put('/api/dev/positions', async (c) => {
    const actor = me(c);
    const b = await readJson(c);
    const errors = [];
    const list = Array.isArray(b.items) ? b.items : [];
    if (list.length === 0 || list.length > 50) errors.push({ field: 'items', message: '1〜50 件で指定してください' });
    const seen = new Set();
    const items = [];
    list.forEach((p, i) => {
      const name = typeof p?.name === 'string' ? p.name.trim() : '';
      if (!name || name.length > 30) errors.push({ field: `items[${i}].name`, message: '1〜30 文字' });
      else if (seen.has(normalizeText(name))) errors.push({ field: `items[${i}].name`, message: '重複しています' });
      else seen.add(normalizeText(name));
      if (!LEVELS.includes(p?.level)) errors.push({ field: `items[${i}].level`, message: LEVELS.join(' / ') });
      items.push({ name, level: p?.level, order: Number.isFinite(p?.order) ? Math.trunc(p.order) : i + 1 });
    });
    if (errors.length) throw validation('入力を確かめてください', errors);

    // 使われている役職を消したり、最後の開発者・管理者の段階を落としたりしない
    const users = await listUserItems();
    const active = users.filter((u) => u.status === 'active');
    for (const u of users) {
      if (!levelFor(u.position, items)) throw conflict('使われている役職は消せません。先にその人たちの役職を変えてください');
    }
    const levels = active.map((u) => levelFor(u.position, items));
    if (!levels.includes('dev')) throw conflict('開発者が 1 人もいなくなる変更はできません');
    if (!levels.some((l) => l === 'dev' || l === 'org_admin')) throw conflict('管理コンソールに入れる人が 1 人もいなくなる変更はできません');
    // 自分自身が管理側から落ちる変更もさせない（戻せなくなる）
    if (levelFor(actor.position, items) !== 'dev') throw conflict('自分自身が開発者の段階でなくなる変更はできません');

    const existing = await ddb.queryAll({ pk: 'ORG', skPrefix: 'POSITION#' });
    const keep = new Set(items.map((p) => p.name));
    await Promise.all([
      ...items.map((p) => ddb.put({ ...K.position(p.name), name: p.name, level: p.level, order: p.order })),
      ...existing.filter((e) => !keep.has(e.name ?? String(e.sk).slice('POSITION#'.length))).map((e) => ddb.del(e.pk, e.sk)),
    ]);
    clearPositionsCache();
    for (const u of users) invalidateUser(emailOf(u));
    await audit(actor, 'positions.update', { count: items.length });
    return c.json(await positionsBody());
  });
}

// updateGeminiSetting の中で選択中のモデルを補う（初期値と、保存済みの選択を重ねる）
function selectionOf(cur) {
  return { ...core.DEFAULT_SELECTION, ...(cur.models ?? {}) };
}
