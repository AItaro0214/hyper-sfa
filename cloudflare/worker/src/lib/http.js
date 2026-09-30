// HTTP まわりの純粋な関数（D1 や Worker の環境に依存しない）。テストしやすいように分けてある。

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// 変更を伴うメソッドの Origin 確認（CSRF 対策。SameSite=Lax に加える二重の守り）。
// Origin があれば同じオリジンであること。無ければ、ブラウザ以外（curl など）か古いブラウザなので、
// Sec-Fetch-Site が付いている場合に限って same-origin / none だけを通す。
export function isSameOrigin({ method, origin, secFetchSite, url }) {
  if (SAFE_METHODS.has(String(method).toUpperCase())) return true;
  if (origin) {
    try {
      return new URL(origin).origin === new URL(url).origin;
    } catch {
      return false;
    }
  }
  if (secFetchSite === undefined || secFetchSite === null || secFetchSite === '') return true;
  return secFetchSite === 'same-origin' || secFetchSite === 'none';
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

// ローカル（http://localhost）では Secure を付けると Cookie が保存されないので外す
export function serializeSessionCookie(value, { maxAgeSec, secure }) {
  const parts = [`sid=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function isSecureRequest(url) {
  return new URL(url).protocol === 'https:';
}

export function clientIp(headers) {
  return headers.get('cf-connecting-ip') || headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}

// 数値の設定値。空や不正なら既定値
export function envNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 議事録側が使う名前。ApiError と同じもの（status, code, message）
export { ApiError as HttpError } from './errors.js';
