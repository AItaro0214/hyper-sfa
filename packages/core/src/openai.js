// OpenAI API のリクエストの組み立てと、応答・エラーの読み取り。通信は呼び出し側。
//
// 実機で確かめる点:
//   - gpt-transcribe など新しい文字起こしモデルが /v1/audio/transcriptions で使えるか、prompt / language を受けるか
//   - gpt-6 系が max_completion_tokens と reasoning_effort を受けるか
//   - 文字起こしの音声の上限（公式の上限が確認できていない）

const BASE = 'https://api.openai.com';

const EXT = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/x-m4a': 'm4a' };

const auth = (apiKey) => ({ Authorization: `Bearer ${apiKey}` });

/**
 * 文字起こし（multipart）。Content-Type は FormData が境界付きで付けるので、ここでは指定しない。
 * @param {Blob|ArrayBuffer|Uint8Array} audio
 */
export function buildTranscriptionRequest({ model, apiKey, audio, mimeType = 'audio/webm', prompt, language = 'ja' }) {
  const blob = audio instanceof Blob ? audio : new Blob([audio], { type: mimeType });
  const base = String(mimeType).split(';')[0].trim();
  const form = new FormData();
  form.append('file', blob, `audio.${EXT[base] ?? 'webm'}`);
  form.append('model', model);
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);
  form.append('response_format', 'json');
  return { url: `${BASE}/v1/audio/transcriptions`, method: 'POST', headers: auth(apiKey), body: form };
}

/** usage は tokens 型（入出力トークン）と duration 型（秒）のどちらも来うる。 */
export function parseTranscriptionResponse(json) {
  const u = json?.usage;
  const usage = u
    ? {
        inputTokens: u.input_tokens ?? u.prompt_tokens ?? 0,
        outputTokens: u.output_tokens ?? u.completion_tokens ?? 0,
        seconds: u.seconds ?? null,
      }
    : undefined;
  return { text: json?.text ?? '', usage };
}

/** /v1/chat/completions。reasoningEffort を渡せるモデルだけ渡す。 */
export function buildChatRequest({ model, apiKey, system, user, maxOutputTokens, reasoningEffort }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const body = { model, messages };
  if (maxOutputTokens) body.max_completion_tokens = maxOutputTokens;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  return {
    url: `${BASE}/v1/chat/completions`,
    method: 'POST',
    headers: { ...auth(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function parseChatResponse(json) {
  const choice = json?.choices?.[0];
  const u = json?.usage ?? {};
  return {
    text: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason ?? null,
    usage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      thoughtTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

export function buildListModelsRequest({ apiKey }) {
  return { url: `${BASE}/v1/models`, method: 'GET', headers: auth(apiKey) };
}

export function parseListModels(json) {
  return (json?.data ?? []).map((m) => m.id).filter(Boolean).sort();
}

/** エラーの分類。Gemini 側と同じ kind にそろえ、画面と再試行の判断を共通にする。 */
export function classifyOpenAIError({ status, json } = {}) {
  const message = json?.error?.message ?? (status ? `HTTP ${status}` : 'unknown');
  const code = json?.error?.code;
  if (status === 429) {
    // 残高不足も 429 で来る。何度やっても直らないので試し直さない
    if (code === 'insufficient_quota') return { kind: 'not_configured', retryable: false, message };
    return { kind: 'rate_limited', retryable: true, message };
  }
  if (status === 401 || status === 403 || status === 404) return { kind: 'not_configured', retryable: false, message };
  if (code === 'content_policy_violation' || code === 'content_filter') return { kind: 'blocked', retryable: false, message };
  if (status === 408 || status === 504 || (status >= 500 && status < 600)) return { kind: 'provider', retryable: true, message };
  return { kind: 'provider', retryable: false, message };
}

// ---- Files API と Responses API（資料の PDF を渡すとき用。docs/core-api.md §14） ----
// 実機で確かめる点:
//   - /v1/responses の input の形（role: 'user' の content に input_text / input_file を並べる）と file_id のキー名
//   - text.format の json_schema（strict: false）を gpt-6 系が受けるか
//   - purpose 'user_data' の PDF を input_file で読めるか、1 ファイル・1 リクエストの上限

/**
 * /v1/files の multipart。ファイル本体は大きいので、呼び出し側が prefix + ファイル + suffix の順でストリームに流す。
 * filename は `"` と改行だけ除く（ヘッダーを壊されないため）。UTF-8 のまま入れる。
 */
export function buildOpenAIFileUploadRequest({ apiKey, filename, contentType = 'application/octet-stream', purpose = 'user_data', boundary }) {
  const b = boundary ?? `----hypersfa${(globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2)).replace(/-/g, '')}`;
  const safeName = String(filename ?? 'file').replace(/["\r\n]/g, '');
  const enc = new TextEncoder();
  const prefix = enc.encode(
    `--${b}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n` +
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const suffix = enc.encode(`\r\n--${b}--\r\n`);
  return {
    url: `${BASE}/v1/files`,
    method: 'POST',
    headers: { ...auth(apiKey), 'Content-Type': `multipart/form-data; boundary=${b}` },
    boundary: b,
    prefix,
    suffix,
  };
}

export function parseOpenAIFileResponse(json) {
  return { id: json?.id ?? null, bytes: json?.bytes ?? 0 };
}

/** 預けた資料は、目次を作り終えたらすぐ消す（OpenAI 側に残さないため）。 */
export function buildOpenAIFileDeleteRequest({ apiKey, fileId }) {
  return { url: `${BASE}/v1/files/${encodeURIComponent(fileId)}`, method: 'DELETE', headers: auth(apiKey) };
}

/**
 * /v1/responses。parts: [{ type: 'input_text', text } | { type: 'input_file', fileId }]。
 */
export function buildResponsesRequest({ model, apiKey, instructions, parts = [], jsonSchema, schemaName = 'result', maxOutputTokens, reasoningEffort }) {
  const content = parts.map((p) => (p.type === 'input_file' ? { type: 'input_file', file_id: p.fileId } : { type: 'input_text', text: p.text }));
  const body = { model, input: [{ role: 'user', content }] };
  if (instructions) body.instructions = instructions;
  if (jsonSchema) body.text = { format: { type: 'json_schema', name: schemaName, schema: jsonSchema, strict: false } };
  if (maxOutputTokens) body.max_output_tokens = maxOutputTokens;
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  return { url: `${BASE}/v1/responses`, method: 'POST', headers: { ...auth(apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * 本文は output[] の message の content[] のうち output_text を連結する。
 * status が incomplete のときは finishReason に理由（max_output_tokens など）を入れ、incomplete も true にする。
 */
export function parseResponsesResponse(json) {
  const text = (json?.output ?? [])
    .flatMap((o) => (Array.isArray(o?.content) ? o.content : []))
    .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
  const incomplete = json?.status === 'incomplete';
  const u = json?.usage ?? {};
  return {
    text,
    finishReason: incomplete ? json?.incomplete_details?.reason ?? 'incomplete' : json?.status ?? null,
    incomplete,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      thoughtTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}
