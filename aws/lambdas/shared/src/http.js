// Hono の共通部品。ルーターは各 Lambda が持ち、ここには入出力の決まりごとだけ置く。
import { HttpError, errorResponse, validation } from './errors.js';

/** app.onError に渡す。ログにはエラーの名前と状態だけを書く（message に入力値が混ざり得るため）。 */
export function errorHandler(err, c) {
  const { status, body } = errorResponse(err);
  if (status >= 500) console.error(JSON.stringify({ level: 'error', name: err?.name, status }));
  return c.json(body, status);
}

/** 本文の JSON をオブジェクトとして読む。配列や壊れた JSON は validation。 */
export async function readJson(c, { optional = false } = {}) {
  let v;
  try {
    const text = await c.req.text();
    if (!text.trim()) {
      if (optional) return {};
      throw new Error('empty');
    }
    v = JSON.parse(text);
  } catch {
    throw validation('リクエストの形が正しくありません');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw validation('リクエストの形が正しくありません');
  return v;
}

export function parseLimit(value, def = 50, max = 200) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

/** カーソルは中身を画面に意味づけさせないため base64url にする。改ざんされても検索の続きが変わるだけ。 */
export function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

export function decodeCursor(s) {
  if (!s) return null;
  try {
    return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
  } catch {
    throw validation('cursor が正しくありません');
  }
}

export { HttpError };
