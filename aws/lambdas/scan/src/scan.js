// 名刺の読み取り本体。docs/design.md §4, §5。
// DynamoDB / S3 / fetch は deps で受け取る（テストで差し替えるため）。
import {
  extractJson, normalizeCard, isEmptyCard, CARD_RESPONSE_SCHEMA, searchKeys,
  DEFAULT_PROMPTS, DEFAULT_MODELS, DEFAULT_SELECTION,
  buildGenerateRequest, parseGenerateResponse, classifyGeminiError, usageEvent,
} from '@hyper-sfa/core';

const FETCH_TIMEOUT_MS = 40_000;
const MAX_OUTPUT_TOKENS = 4000;
const TRANSIENT_DELAYS_MS = [2000, 5000]; // 混雑・時間切れは 2 回まで
const CONTENT_RETRIES = 1; // parse / empty は 1 回だけ
const FAILED_RAW_MAX_BYTES = 8 * 1024;
const FAILED_RAW_TTL_SEC = 30 * 24 * 3600;

// 画面に出す文言（docs/design.md §5.7）。名刺の中身は入れない。
const MESSAGES = {
  parse: '読み取り結果を受け取れませんでした',
  truncated: '読み取りが途中で止まりました',
  provider: '混み合っていて読み取れませんでした',
  empty: '名刺の文字を読み取れませんでした',
  blocked: 'この写真は読み取れませんでした',
  not_configured: '設定に問題があります。開発者に連絡してください',
};

class ScanError extends Error {
  constructor(kind, { transient = false, rawText = '', partialCard = null } = {}) {
    super(MESSAGES[kind] ?? MESSAGES.provider);
    this.kind = kind;
    this.transient = transient;
    this.rawText = rawText;
    this.partialCard = partialCard;
    this.usage = { inputTokens: 0, outputTokens: 0, thoughtTokens: 0 };
    // 何度やっても同じ結果になるものには「もう一度読み取る」を出さない
    this.retryable = kind !== 'not_configured' && kind !== 'blocked';
  }
}

export async function runScan(event, deps) {
  if (event.test) return runTest(event, deps);
  if (!event.cardId) return { ok: false };
  const cardId = String(event.cardId);
  try {
    const card = await get(deps, deps.K.card(cardId));
    if (!card) {
      console.log('scan: card not found');
      return { ok: false };
    }
    // Lambda の二重起動で、読み取り済みの名刺を上書きしない
    if (card.status === 'review' || card.status === 'confirmed') {
      console.log('scan: already done');
      return { ok: true, skipped: true };
    }
    let r;
    try {
      r = await scanCard(cardId, card, deps);
    } catch (e) {
      const err = e instanceof ScanError ? e : new ScanError('provider');
      if (!(e instanceof ScanError)) console.error('scan: unexpected', e?.name);
      await saveFailure(cardId, card, err, deps);
      return { ok: false, failure: { kind: err.kind, retryable: err.retryable } };
    }
    return { ok: true, elapsedMs: r.elapsedMs };
  } catch (e) {
    // 失敗の保存自体に失敗した場合。ここで止める（Lambda の再試行はしない）
    console.error('scan: fatal', e?.name);
    return { ok: false };
  }
}

async function scanCard(cardId, card, deps) {
  const cfg = await loadConfig(deps, {});
  const apiKey = await deps.getApiKey('gemini');
  if (!apiKey) throw new ScanError('not_configured');

  const images = await loadImages(deps, card.imageFrontKey, card.imageBackKey);
  const r = await readCard({ deps, cfg, apiKey, images });
  const at = iso(deps);

  const c = r.card;
  const k = deps.K.card(cardId);
  await deps.ddb.update(k.pk, k.sk, {
    set: {
      status: 'review',
      company: c.company, department: c.department, title: c.title, name: c.name, nameReading: c.nameReading,
      phones: c.phones, mobiles: c.mobiles, emails: c.emails, note: c.note, rawText: c.rawText,
      keys: searchKeys(c),
      failure: null,
      extraction: {
        modelId: cfg.model.id,
        promptVersion: cfg.promptVersion,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        thoughtTokens: r.usage.thoughtTokens,
        elapsedMs: r.elapsedMs,
        repairs: r.repairs,
        attempts: r.attempts,
      },
      updatedAt: at,
      // gsi1 の写し。分割番号は名刺 ID から決まるので、既にあればそのまま使う
      gsi1pk: card.gsi1pk ?? `IDX#${shardOf(cardId)}`,
      gsi1sk: `${at}#${cardId}`,
    },
    add: { scanCount: 1 },
  });
  await track(deps, cfg.model.id, card.createdBy, r.usage, true, null, 'card');
  console.log(`scan: done elapsedMs=${r.elapsedMs} attempts=${r.attempts}`);
  return r;
}

// 試し読み。DynamoDB の名刺は書かない。
async function runTest(event, deps) {
  let cfg = null;
  try {
    cfg = await loadConfig(deps, { modelId: event.modelId, promptText: event.promptText });
    const apiKey = await deps.getApiKey('gemini');
    if (!apiKey) throw new ScanError('not_configured');
    const images = await loadImages(deps, event.frontKey, event.backKey);
    const r = await readCard({ deps, cfg, apiKey, images });
    await track(deps, cfg.model.id, event.actor, r.usage, true, null, 'test');
    return { ok: true, card: r.card, raw: r.rawResponse, repairs: r.repairs, usage: r.usage, elapsedMs: r.elapsedMs };
  } catch (e) {
    const err = e instanceof ScanError ? e : new ScanError('provider');
    if (cfg && err.kind !== 'not_configured') await track(deps, cfg.model.id, event.actor, err.usage, false, err.kind, 'test');
    return {
      ok: false,
      failure: { kind: err.kind, message: err.message, retryable: err.retryable },
      raw: err.rawText, card: err.partialCard ?? undefined, usage: err.usage,
    };
  }
}

// ---- 設定 ----

async function loadConfig(deps, { modelId, promptText }) {
  const setting = (await get(deps, deps.K.setting('gemini'))) ?? {};
  const id = modelId || setting.models?.card || DEFAULT_SELECTION.card;
  const stored = await get(deps, deps.K.model(id));
  const fallback = (DEFAULT_MODELS ?? []).find((m) => m.id === id);
  const model = { ...(fallback ?? {}), ...(stored ?? {}), id };

  let prompt = DEFAULT_PROMPTS.card;
  let promptVersion = 0; // 0 は初期値
  const v = setting.promptVersion?.card;
  if (v != null) {
    const p = await get(deps, deps.K.prompt('card', v));
    if (p?.text) {
      prompt = p.text;
      promptVersion = v;
    }
  }
  if (promptText) {
    prompt = promptText;
    promptVersion = 'test';
  }
  return { model, prompt, promptVersion };
}

async function loadImages(deps, frontKey, backKey) {
  const bucket = deps.env.IMAGE_BUCKET;
  const out = [];
  for (const key of [frontKey, backKey]) {
    if (!key) continue;
    const buf = await deps.s3.getObjectBuffer({ bucket, key });
    out.push({ inlineData: { mimeType: 'image/jpeg', data: Buffer.from(buf).toString('base64') } });
  }
  if (out.length === 0) throw new ScanError('empty');
  return out;
}

// ---- 読み取りと自動の試し直し（docs/design.md §5.7）----

async function readCard({ deps, cfg, apiKey, images }) {
  const started = deps.now().getTime();
  const usage = { inputTokens: 0, outputTokens: 0, thoughtTokens: 0 };
  let transient = 0;
  let content = 0;
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      const r = await callOnce({ deps, cfg, apiKey, images, usage });
      return { ...r, usage: { ...usage }, attempts, elapsedMs: deps.now().getTime() - started };
    } catch (e) {
      if (!(e instanceof ScanError)) throw e;
      // 失敗した試行の分も費用はかかっているので、累計を持たせる
      e.usage = { ...usage };
      if (e.transient && transient < TRANSIENT_DELAYS_MS.length) {
        await deps.sleep(TRANSIENT_DELAYS_MS[transient++]);
        continue;
      }
      if ((e.kind === 'parse' || e.kind === 'empty') && content < CONTENT_RETRIES) {
        content++;
        continue;
      }
      throw e;
    }
  }
}

async function callOnce({ deps, cfg, apiKey, images, usage }) {
  const req = buildGenerateRequest({
    model: cfg.model.id,
    apiKey,
    prompt: cfg.prompt,
    parts: images,
    schema: CARD_RESPONSE_SCHEMA,
    thinkingLevel: cfg.model.thinkingLevel,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let status;
  let json;
  try {
    const res = await deps.fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ac.signal });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch {
    // 時間切れ、通信エラー
    throw new ScanError('provider', { transient: true });
  } finally {
    clearTimeout(timer);
  }

  if (status < 200 || status >= 300) {
    const c = classifyGeminiError({ status, json });
    const kind = c.kind === 'rate_limited' ? 'provider' : c.kind;
    throw new ScanError(kind, { transient: status === 429 || status >= 500 });
  }

  const p = parseGenerateResponse(json);
  usage.inputTokens += p.usage?.inputTokens ?? 0;
  usage.outputTokens += p.usage?.outputTokens ?? 0;
  usage.thoughtTokens += p.usage?.thoughtTokens ?? 0;
  if (p.blocked) throw new ScanError('blocked');

  let ex;
  try {
    ex = extractJson(p.text ?? '');
  } catch {
    throw new ScanError('parse', { rawText: p.text ?? '' });
  }
  const normalized = normalizeCard(ex.value);
  const card = finalizeCard(normalized);
  const repairs = [...(ex.repairs ?? []), ...(normalized.coerced ?? [])];

  if (p.finishReason === 'MAX_TOKENS' || ex.truncated) {
    // 読めた項目は捨てずに保存する
    throw new ScanError('truncated', { rawText: p.text ?? '', partialCard: card });
  }
  if (isEmptyCard(normalized)) throw new ScanError('empty', { rawText: p.text ?? '' });
  return { card, rawResponse: p.text ?? '', repairs };
}

// 保存前の整形（docs/design.md §5.5）。メールは小文字、長すぎる値は切り詰める。
function finalizeCard(n) {
  const s = (v, max) => String(v ?? '').slice(0, max);
  const a = (v, max) => (Array.isArray(v) ? v : []).map((x) => s(x, max).trim()).filter(Boolean).slice(0, 10);
  return {
    company: s(n.company, 200), department: s(n.department, 200), title: s(n.title, 100), name: s(n.name, 100), nameReading: s(n.nameReading, 100),
    phones: a(n.phones, 50), mobiles: a(n.mobiles, 50),
    emails: a(n.emails, 254).map((e) => e.toLowerCase()),
    note: s(n.note, 1000), rawText: s(n.rawText, 3000),
  };
}

// ---- 保存 ----

async function saveFailure(cardId, card, err, deps) {
  const at = iso(deps);
  const k = deps.K.card(cardId);
  const set = {
    status: 'failed',
    failure: { kind: err.kind, message: err.message, retryable: err.retryable, at },
    updatedAt: at,
  };
  // 途中で切れた応答は、読めた項目を残す
  if (err.kind === 'truncated' && err.partialCard) {
    const c = err.partialCard;
    Object.assign(set, {
      company: c.company, department: c.department, title: c.title, name: c.name, nameReading: c.nameReading,
      phones: c.phones, mobiles: c.mobiles, emails: c.emails, note: c.note, rawText: c.rawText,
    });
  }
  await deps.ddb.update(k.pk, k.sk, { set });
  if (err.rawText) {
    // 原因調査用。開発コンソールからだけ見る。30 日で消える
    await deps.ddb.put({
      ...deps.K.setting(`failedscan#${cardId}`),
      text: cutBytes(err.rawText, FAILED_RAW_MAX_BYTES),
      kind: err.kind,
      savedAt: at,
      ttl: Math.floor(deps.now().getTime() / 1000) + FAILED_RAW_TTL_SEC,
    });
  }
  let modelId = '';
  try {
    modelId = (await loadConfig(deps, {})).model.id;
  } catch { /* 利用量の記録のためだけなので無視 */ }
  await track(deps, modelId, card.createdBy, err.usage, false, err.kind, 'card');
}

// 利用量の記録に失敗しても、読み取りの結果には影響させない
async function track(deps, modelId, userId, usage, ok, failureKind, kind) {
  try {
    await deps.recordUsage(usageEvent({
      kind, userId, modelId,
      inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
      audioSeconds: 0, ok, failureKind: failureKind ?? undefined, at: iso(deps),
    }));
  } catch (e) {
    console.error('scan: recordUsage failed', e?.name);
  }
}

// ---- 小物 ----

async function get(deps, k) {
  return (await deps.ddb.get(k.pk, k.sk)) ?? null;
}
function iso(deps) {
  return deps.now().toISOString();
}
function shardOf(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 8;
}
// UTF-8 で max バイト以内に収める（文字の途中では切らない）
function cutBytes(s, max) {
  const enc = new TextEncoder();
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = enc.encode(ch).length;
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}
