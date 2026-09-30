// 共通の小さな道具。node: の API は使わない（ブラウザと Worker でも動かすため）。

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID を作る。先頭 10 文字が時刻（ミリ秒）で、辞書順に並べると作成順になる。
 * 一覧を「新しい順」に読むキーとして使うため、時刻を先頭に置く。
 * @param {number} [now] テスト用に時刻を差し替えられる
 */
export function ulid(now = Date.now()) {
  let t = Math.floor(now);
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = '';
  // 1 バイトを 32 で割った余りは偏りなく 32 通りになる（256 が 32 の倍数のため）
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return time + rand;
}

/** 文字列の SHA-256 を 16 進で返す。 */
export async function sha256Hex(str) {
  const data = new TextEncoder().encode(String(str));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 厳密な RFC 5322 ではなく、明らかな誤りを弾く程度にする。
// 名刺の読み取り結果には崩れたアドレスが混ざるため、確認画面で印を付ける用途。
const EMAIL_RE = /^[A-Za-z0-9._%+'!#$&*/=?^`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isValidEmail(s) {
  if (typeof s !== 'string') return false;
  const v = s.trim();
  return v.length <= 254 && EMAIL_RE.test(v) && !v.includes('..');
}

/** 上限を超えたら切り詰める。サロゲートペアを割らないよう、コードポイント単位で数える。 */
export function truncate(s, max) {
  const str = s == null ? '' : String(s);
  const chars = Array.from(str);
  return chars.length <= max ? str : chars.slice(0, max).join('');
}
