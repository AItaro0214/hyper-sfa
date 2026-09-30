// Gemini の呼び出し（名刺の読み取り）。Workflow と開発コンソールの試し読みの両方が使う。
// 画像は Worker の中で読まない: R2 の本文（ストリーム）をそのまま Files API に流す（CPU 10ms のため）。
// ストリームを fetch の body に渡すとき、Node では duplex: 'half' が要るが、Workers では不要。
import {
  gemini,
  CARD_RESPONSE_SCHEMA,
  extractJson,
  normalizeCard,
  isEmptyCard,
  searchKeys,
} from '../core.js';
import { cutRawText, sanitizeCard } from './cards.js';

// 1 回の待ち時間（docs/design.md §5.2）
export const GEMINI_TIMEOUT_MS = 40000;
export const CARD_MAX_OUTPUT_TOKENS = 4000;

// kind は failureFor() の種類（provider / blocked / not_configured）。retryable なら自動で試し直す
export class ProviderError extends Error {
  constructor(kind, retryable, message) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = retryable;
  }
}

function toProviderError(cls) {
  // レート制限は「混み合っている」と同じ扱い
  const kind = cls.kind === 'rate_limited' ? 'provider' : cls.kind;
  return new ProviderError(kind, cls.retryable, cls.message);
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function guardedFetch(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS) });
  } catch {
    throw new ProviderError('provider', true, 'Gemini への接続がタイムアウトしました');
  }
}

/** R2 のオブジェクトを Files API に預け、{ name, uri, mimeType } を返す。 */
export async function uploadToFilesApi({ apiKey, object, displayName, mimeType = 'image/jpeg' }) {
  const start = gemini.buildFilesUploadRequest({ apiKey, mimeType, displayName, sizeBytes: object.size });
  const startRes = await guardedFetch(start.url, { method: start.method, headers: start.headers, body: start.body });
  if (!startRes.ok) throw toProviderError(gemini.classifyGeminiError({ status: startRes.status, json: await readJson(startRes) }));
  const { uploadUrl } = gemini.parseFilesUploadStart(startRes.headers);
  if (!uploadUrl) throw new ProviderError('provider', true, 'Files API の送り先を受け取れませんでした');

  const res = await guardedFetch(uploadUrl, {
    method: 'POST',
    headers: gemini.buildFilesUploadBodyHeaders({ sizeBytes: object.size }),
    body: object.body,
  });
  const json = await readJson(res);
  if (!res.ok) throw toProviderError(gemini.classifyGeminiError({ status: res.status, json }));
  const file = gemini.parseFileResponse(json);
  if (!file.uri) throw new ProviderError('provider', true, 'Files API の応答が読めませんでした');
  return file;
}

// 読み取りが終わったら明示的に消す（Files API は 48 時間で消えるが、預けっぱなしにしない）。失敗しても無視
export async function deleteFromFilesApi({ apiKey, name }) {
  try {
    const req = gemini.buildFileDeleteRequest({ apiKey, name });
    await fetch(req.url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(10000) });
  } catch {
    // 48 時間で自動的に消える
  }
}

/** generateContent を呼ぶ。成功なら parseGenerateResponse の結果、失敗なら ProviderError。 */
export async function generateCard({ apiKey, model, prompt, files }) {
  const req = gemini.buildGenerateRequest({
    model: model.id,
    apiKey,
    prompt,
    parts: files.map((f) => ({ fileData: { mimeType: f.mimeType || 'image/jpeg', fileUri: f.uri } })),
    schema: CARD_RESPONSE_SCHEMA,
    thinkingLevel: model.thinkingLevel ?? undefined,
    maxOutputTokens: CARD_MAX_OUTPUT_TOKENS,
  });
  const res = await guardedFetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const json = await readJson(res);
  if (!res.ok) throw toProviderError(gemini.classifyGeminiError({ status: res.status, json }));
  return gemini.parseGenerateResponse(json);
}

/**
 * 応答の処理（docs/design.md §5.5, §5.6）: 拒否 → JSON の取り出し → 形をそろえる → 空の判定 → 検索キー。
 * @returns 成功 { ok: true, card, keys, repairs, coerced }
 *          失敗 { ok: false, kind, retryable, card? }（truncated のときは読めた項目を card に付ける）
 */
export function interpretCardResponse(gen) {
  if (gen.blocked) return { ok: false, kind: 'blocked', retryable: false };
  let extracted;
  try {
    extracted = extractJson(gen.text ?? '');
  } catch {
    return { ok: false, kind: 'parse', retryable: true };
  }
  const normalized = normalizeCard(extracted.value);
  const truncated = extracted.truncated || gen.finishReason === 'MAX_TOKENS';
  if (isEmptyCard(normalized)) return { ok: false, kind: truncated ? 'truncated' : 'empty', retryable: true };

  const card = { ...sanitizeCard(normalized), rawText: cutRawText(normalized.rawText) };
  const keys = searchKeys(card);
  const repairs = extracted.repairs ?? [];
  const coerced = normalized.coerced ?? [];
  if (truncated) return { ok: false, kind: 'truncated', retryable: true, card, keys, repairs, coerced };
  return { ok: true, card, keys, repairs, coerced };
}
