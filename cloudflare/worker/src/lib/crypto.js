// パスワード、セッション、署名、API キーの暗号化。Web Crypto だけを使う（Node 22 でも Worker でも動く）。
// CPU 10 ミリ秒の枠のため、重いのは PBKDF2 の 1 回だけにしている。

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toB64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomHex(n) {
  return toHex(randomBytes(n));
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

// 定数時間に近い文字列比較。長さが違っても最後まで回す
export function timingSafeEqualStr(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ---- パスワード（PBKDF2-SHA256 + ソルト + pepper） ----

// pepper はパスワードに連結して鍵素材にする。DB が漏れても pepper が無ければ総当たりできない
async function pbkdf2(password, pepper, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password + pepper), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, keyMaterial, 256);
  return toB64(bits);
}

export async function hashPassword(password, { pepper, iterations, salt } = {}) {
  if (!pepper) throw new Error('pepper is required');
  const saltBytes = salt ?? randomBytes(16);
  const hash = await pbkdf2(password, pepper, saltBytes, iterations);
  return { hash, salt: toB64(saltBytes), iterations };
}

// 第 2 引数は hashPassword の戻り値（hash）でも、users 表の行（password_hash）でもよい。
// ログイン処理は DB の行をそのまま渡すので、列名の違いをここで吸収する（これを見落として
// ログインが常に失敗する不具合があった）
export async function verifyPassword(password, record, pepper) {
  if (!pepper) throw new Error('pepper is required');
  const hash = record?.hash ?? record?.password_hash;
  const { salt, iterations } = record ?? {};
  if (!hash || !salt || !iterations) return false;
  const actual = await pbkdf2(password, pepper, fromB64(salt), iterations);
  return timingSafeEqualStr(actual, hash);
}

// 紛らわしい文字（0/O、1/l/I）を除いた仮パスワード。偏りが出ないよう乱数は棄却して引く
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function generateTempPassword(length = 12) {
  const limit = 256 - (256 % TEMP_ALPHABET.length);
  for (;;) {
    let out = '';
    while (out.length < length) {
      for (const b of randomBytes(length * 2)) {
        if (b < limit && out.length < length) out += TEMP_ALPHABET[b % TEMP_ALPHABET.length];
      }
    }
    if (/[a-z]/.test(out) && /[A-Z]/.test(out) && /[0-9]/.test(out)) return out;
  }
}

// ---- 署名（アップロード / ダウンロードの URL） ----

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(`sign:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

export async function hmacHex(secret, message) {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message)));
}

export async function verifyHmac(secret, message, sigHex) {
  if (typeof sigHex !== 'string') return false;
  return timingSafeEqualStr(await hmacHex(secret, message), sigHex);
}

// ---- API キーの暗号化（AES-GCM） ----

// 鍵は Secret を SHA-256 して 32 バイトにする（Secret の長さを問わないため）
async function aesKey(secret) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`aes:${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// aad（追加認証データ）に用途を入れ、別の設定行へ暗号文を貼り替えられても復号できないようにする
export async function encryptSecret(plain, secret, aad) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    await aesKey(secret),
    enc.encode(plain),
  );
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptSecret({ iv, ct }, secret, aad) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(iv), additionalData: enc.encode(aad) },
    await aesKey(secret),
    fromB64(ct),
  );
  return dec.decode(plain);
}
