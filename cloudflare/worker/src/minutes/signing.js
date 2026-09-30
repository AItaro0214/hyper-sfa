// 土台の lib/sign.js への薄い包み。
// 土台側の引数の形が私の想定と違っても、直すのはここ 1 か所で済むようにしている。
// 想定: signedPath(env, path, ttlSec) → '/api/...?exp=...&sig=...'、verifySignedPath(env, pathWithQuery) → boolean
import { signedPath, verifySignedPath } from '../lib/sign.js';

export async function sign(env, path, ttlSec) {
  return await signedPath(env, path, ttlSec);
}

/** リクエストの URL の署名を確かめる。download=1 は署名の対象外（<a download> 用に後から足すため）。 */
export async function verify(env, requestUrl) {
  try {
    const u = new URL(requestUrl);
    u.searchParams.delete('download');
    return Boolean(await verifySignedPath(env, u.pathname + u.search));
  } catch {
    return false;
  }
}
