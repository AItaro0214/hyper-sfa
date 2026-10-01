// サーバーとの通信は全部ここを通す。失敗は ApiError にそろえて、画面は message をそのまま見せられるようにする。
import { getAuthHeader, refreshSession } from './auth.js';
import { progressStart, progressDone } from './ui.js';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

function buildUrl(path, query) {
  if (!query) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

// ログイン操作そのものの 401 は「ID かパスワードの誤り」なので、ログイン画面へ戻さない。
const AUTH_PATHS = ['/api/auth/login', '/api/auth/setup', '/api/auth/change-password'];

// 状態の確認（ポーリング）は繰り返し呼ばれるので、進行バーを出さない。
async function request(method, path, opts = {}) {
  const quiet = path.endsWith('/status');
  if (!quiet) progressStart();
  try { return await requestInner(method, path, opts); } finally { if (!quiet) progressDone(); }
}

async function requestInner(method, path, { query, body, retried = false } = {}) {
  const headers = { Accept: 'application/json', ...(await getAuthHeader()) };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(buildUrl(path, query), init);
  } catch {
    throw new ApiError(0, 'network', '通信に失敗しました。ネットワークを確かめてください。');
  }
  if (res.status === 401 && !AUTH_PATHS.includes(path)) {
    if (!retried && (await refreshSession())) return requestInner(method, path, { query, body, retried: true });
    onUnauthorized();
  }
  if (res.status === 204) return null;
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    const e = data && data.error;
    throw new ApiError(res.status, (e && e.code) || 'error', (e && e.message) || `エラーが発生しました（${res.status}）`, e && e.details);
  }
  return data;
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  post: (path, body) => request('POST', path, { body: body ?? {} }),
  put: (path, body) => request('PUT', path, { body: body ?? {} }),
  patch: (path, body) => request('PATCH', path, { body: body ?? {} }),
  del: (path) => request('DELETE', path),
  // 署名付き URL（AWS 版）には Authorization を付けない。付けると署名が合わなくなる。
  async upload(url, blob, headers = {}) {
    const h = { ...headers };
    if (url.startsWith('/')) Object.assign(h, await getAuthHeader());
    let res;
    try { res = await fetch(url, { method: 'PUT', headers: h, body: blob }); }
    catch { throw new ApiError(0, 'network', 'アップロードに失敗しました。ネットワークを確かめてください。'); }
    if (!res.ok) throw new ApiError(res.status, 'upload_failed', `アップロードに失敗しました（${res.status}）`);
  },
};
