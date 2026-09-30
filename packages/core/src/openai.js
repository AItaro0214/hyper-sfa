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
