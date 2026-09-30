// 監査ログ（docs/design.md §11）。2 年で消える。
// detail には件数や種類などの数値・区分だけを入れる。名刺の内容、議事録のタイトル、API キーは入れない。
import { ddb } from './ddb.js';
import { K } from './keys.js';

const TTL_SEC = 2 * 365 * 24 * 3600;

/** actor は { id, name } またはメールアドレス（ログイン前の拒否など、ユーザーが無いとき）。 */
export async function audit(actor, action, detail = {}) {
  const at = new Date().toISOString();
  const id = Math.random().toString(36).slice(2, 10);
  const a = typeof actor === 'string' ? { id: actor, name: '' } : { id: actor?.id ?? actor?.email ?? '', name: actor?.name ?? actor?.displayName ?? '' };
  await ddb.put({
    ...K.audit(at.slice(0, 7), at, id),
    action,
    actor: a,
    detail,
    at,
    ttl: Math.floor(Date.parse(at) / 1000) + TTL_SEC,
  });
}
