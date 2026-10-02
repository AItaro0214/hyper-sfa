// Gemini REST API のリクエストの組み立てと、応答・エラーの読み取り。
// ここでは通信しない（fetch は呼び出し側）。モデルごとの違いを 1 か所で吸収するため、組み立てをこの部品にまとめる。
//
// 実機で確かめる点:
//   - responseSchema の名前と型の書き方（OBJECT / STRING の大文字か、object / string の小文字か）
//   - thinkingConfig の形（thinkingLevel に MINIMAL / LOW を渡せるか。モデルごとに使える値が違う）
//   - mediaResolution の値の書き方
//   - Files API の再開可能アップロードのヘッダー名
// 設計書は 2026-09-30 時点の公式ページに基づく。食い違ったらこのファイルと設計書を一緒に直す。

const BASE = 'https://generativelanguage.googleapis.com';

const modelPath = (model) => encodeURIComponent(String(model).replace(/^models\//, ''));

/**
 * スキーマの type を大文字にする（object → OBJECT）。コード側のスキーマは小文字で書くので、Gemini に渡す直前に直す。
 * 既に大文字のものはそのまま。元のオブジェクトは変更しない。
 */
export function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'type' && typeof v === 'string') out[k] = v.toUpperCase();
      else if (k === 'properties' && v && typeof v === 'object') {
        // properties のキーに "type" という項目名があっても型指定と取り違えないよう、値だけ変換する
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
      } else out[k] = toGeminiSchema(v);
    }
    return out;
  }
  return schema;
}

/**
 * generateContent のリクエストを作る。
 * @param {object} o
 * @param {Array<{inlineData?: {mimeType: string, data: string}, fileData?: {mimeType: string, fileUri: string}}>} [o.parts]
 * @param {object} [o.schema] 構造化出力のスキーマ。無ければ JSON 指定を入れない（文字起こしや議事録は文章で返す）
 * @param {string} [o.thinkingLevel] 'minimal' | 'low' など。大文字にして渡す
 */
export function buildGenerateRequest({ model, apiKey, prompt, parts = [], schema, thinkingLevel, maxOutputTokens, mediaResolution, safetySettings }) {
  const generationConfig = {};
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = toGeminiSchema(schema);
  }
  if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: String(thinkingLevel).toUpperCase() };
  if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;
  if (mediaResolution) generationConfig.mediaResolution = mediaResolution;

  const body = {
    contents: [{ role: 'user', parts: [...parts, { text: prompt }] }],
    generationConfig,
  };
  if (safetySettings) body.safetySettings = safetySettings;
  return {
    url: `${BASE}/v1beta/models/${modelPath(model)}:generateContent`,
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * 会話（質問への答え）用の generateContent。systemText はシステム指示、turns は過去のやり取り（最後が今回の質問）。
 * Gemini の role は user / model なので、assistant を model に写す。
 * @param {Array<{role: 'user' | 'assistant', text: string}>} o.turns
 */
export function buildChatGenerateRequest({ model, apiKey, systemText, turns = [], thinkingLevel, maxOutputTokens, safetySettings }) {
  const generationConfig = {};
  if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: String(thinkingLevel).toUpperCase() };
  if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;
  const body = {
    systemInstruction: { parts: [{ text: String(systemText ?? '') }] },
    contents: turns.map((t) => ({ role: t.role === 'assistant' || t.role === 'model' ? 'model' : 'user', parts: [{ text: String(t.text ?? '') }] })),
    generationConfig,
  };
  if (safetySettings) body.safetySettings = safetySettings;
  return {
    url: `${BASE}/v1beta/models/${modelPath(model)}:generateContent`,
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// 安全フィルタを止める設定（商談の音声が誤って止まるのを減らす）。safetySettings に渡す
export const SAFETY_BLOCK_NONE = [
  'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

// 応答が拒否されたことを示す finishReason
const BLOCKED_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'RECITATION']);

/**
 * generateContent の応答を読む。
 * finishReason が MAX_TOKENS なら、呼び出し側は「途中で切れた」として扱う（名刺は読めた分を表示、文字起こしはやり直し）。
 */
export function parseGenerateResponse(json) {
  const candidate = json?.candidates?.[0];
  // 思考の要約（thought: true）は本文に混ぜない
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => typeof p?.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  const finishReason = candidate?.finishReason ?? null;
  const blockReason = json?.promptFeedback?.blockReason ?? null;
  const u = json?.usageMetadata ?? {};
  return {
    text,
    finishReason,
    blocked: Boolean(blockReason) || BLOCKED_FINISH.has(finishReason),
    blockReason,
    usage: {
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: u.candidatesTokenCount ?? 0,
      thoughtTokens: u.thoughtsTokenCount ?? 0,
    },
  };
}

// ---- Files API（再開可能アップロード。大きい音声を Gemini に預けるとき用） ----

/**
 * アップロードの開始リクエスト。応答ヘッダーの `x-goog-upload-url` に、続けて本体を送る。
 */
export function buildFilesUploadRequest({ apiKey, mimeType, displayName, sizeBytes }) {
  return {
    url: `${BASE}/upload/v1beta/files`,
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(sizeBytes),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  };
}

/** 開始の応答から、本体の送り先を取り出す。 */
export function parseFilesUploadStart(headers) {
  const get = (k) => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k]);
  return { uploadUrl: get('x-goog-upload-url') ?? null };
}

/** 本体を送るときのヘッダー（開始の応答で受け取った URL へ POST する）。 */
export function buildFilesUploadBodyHeaders({ sizeBytes }) {
  return {
    'Content-Length': String(sizeBytes),
    'X-Goog-Upload-Offset': '0',
    'X-Goog-Upload-Command': 'upload, finalize',
  };
}

/** アップロード完了、または取得の応答から、使う値を取り出す。state は PROCESSING / ACTIVE / FAILED。 */
export function parseFileResponse(json) {
  const f = json?.file ?? json ?? {};
  return { name: f.name ?? null, uri: f.uri ?? null, mimeType: f.mimeType ?? null, state: f.state ?? null };
}

/** name は `files/abc123` の形。 */
export function buildFileGetRequest({ apiKey, name }) {
  return { url: `${BASE}/v1beta/${name}`, method: 'GET', headers: { 'x-goog-api-key': apiKey } };
}

/** 預けた音声は使い終わったらすぐ消す（Gemini 側に残さないため）。 */
export function buildFileDeleteRequest({ apiKey, name }) {
  return { url: `${BASE}/v1beta/${name}`, method: 'DELETE', headers: { 'x-goog-api-key': apiKey } };
}

// ---- モデル一覧 ----

export function buildListModelsRequest({ apiKey }) {
  return { url: `${BASE}/v1beta/models?pageSize=1000`, method: 'GET', headers: { 'x-goog-api-key': apiKey } };
}

/** generateContent に対応しているモデルの ID だけ。 */
export function parseListModels(json) {
  return (json?.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => String(m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);
}

/**
 * エラーの分類（docs/design.md §5.7）。retryable は「自動で試し直す価値があるか」。
 * API キーの誤りのように何度やっても同じ結果になるものは false。
 */
export function classifyGeminiError({ status, json } = {}) {
  const message = json?.error?.message ?? (status ? `HTTP ${status}` : 'unknown');
  const errStatus = json?.error?.status;
  if (json?.promptFeedback?.blockReason) {
    return { kind: 'blocked', retryable: false, message: `blocked: ${json.promptFeedback.blockReason}` };
  }
  if (status === 429 || errStatus === 'RESOURCE_EXHAUSTED') return { kind: 'rate_limited', retryable: true, message };
  if (status === 401 || status === 403 || errStatus === 'PERMISSION_DENIED' || errStatus === 'UNAUTHENTICATED') {
    return { kind: 'not_configured', retryable: false, message };
  }
  if (status === 404 || errStatus === 'NOT_FOUND') return { kind: 'not_configured', retryable: false, message };
  // キーが無効な場合、Gemini は 403 ではなく 400 INVALID_ARGUMENT で返すことがある
  if (status === 400 && /api key/i.test(message)) return { kind: 'not_configured', retryable: false, message };
  if (status === 408 || status === 504 || (status >= 500 && status < 600)) return { kind: 'provider', retryable: true, message };
  return { kind: 'provider', retryable: false, message };
}
