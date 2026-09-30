// 期限付きの署名 URL。R2 の署名付き URL は使わず（鍵の管理が増えるため）、Worker 自身が
// HMAC で「このパスを、この期限まで」を保証する。extra に利用者 ID を入れると、その人専用になる。
import { hmacHex, verifyHmac } from './crypto.js';

export async function signedPath(env, path, ttlSec, extra = '') {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await hmacHex(env.KEY_ENCRYPTION_KEY, `url|${path}|${exp}|${extra}`);
  return `${path}?exp=${exp}&sig=${sig}`;
}

// pathWithQuery: '/api/...?exp=...&sig=...'（ほかのクエリがあっても署名の対象は path と exp だけ）
export async function verifySignedPath(env, pathWithQuery, extra = '') {
  const u = new URL(pathWithQuery, 'http://x');
  const exp = Number(u.searchParams.get('exp'));
  const sig = u.searchParams.get('sig');
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return verifyHmac(env.KEY_ENCRYPTION_KEY, `url|${u.pathname}|${exp}|${extra}`, sig);
}
