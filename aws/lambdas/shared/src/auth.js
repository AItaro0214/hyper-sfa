// 関門 3（docs/design.md §9.6）。API Gateway の JWT オーソライザーが検証済みの claims から
// メールアドレスを取り、リクエストのたびに DynamoDB のユーザーを読んで登録・無効・役職・所属を確かめる。
// 60 秒だけ Lambda の中で持つので、無効化や役職の変更は 1 分以内に効く（§9.4）。
import { levelFor, capabilitiesFor, DEFAULT_POSITIONS } from '@hyper-sfa/core';
import { ddb } from './ddb.js';
import { K } from './keys.js';
import { HttpError } from './errors.js';

const TTL_MS = 60 * 1000;
const users = new Map(); // email -> { at, item }
let positionsCache = null; // { at, list }

export function invalidateUser(email) {
  users.delete(String(email ?? '').toLowerCase());
}

/** 役職と段階の対応。DynamoDB に無ければ core の初期値。 */
export async function loadPositions() {
  if (positionsCache && Date.now() - positionsCache.at < TTL_MS) return positionsCache.list;
  const items = await ddb.queryAll({ pk: 'ORG', skPrefix: 'POSITION#' });
  const list = items.length
    ? items.map((i) => ({ name: i.name ?? String(i.sk).slice('POSITION#'.length), level: i.level, order: i.order ?? 0 })).sort((a, b) => a.order - b.order)
    : DEFAULT_POSITIONS.map((p) => ({ ...p }));
  positionsCache = { at: Date.now(), list };
  return list;
}

export function clearPositionsCache() {
  positionsCache = null;
}

async function loadUserItem(email) {
  const hit = users.get(email);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.item;
  const k = K.user(email);
  const item = await ddb.get(k.pk, k.sk);
  users.set(email, { at: Date.now(), item });
  return item;
}

/**
 * @param {object} event API Gateway (HTTP API v2) のイベント
 * @returns {Promise<{ user: object, level: string, capabilities: object }>}
 *   user は { id(=メールアドレス), email, displayName, position, deptIds, status, googleSub, level, capabilities }
 * 未登録・無効・役職が不明は 403。
 */
export async function currentUser(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims ?? {};
  const email = String(claims.email ?? '').trim().toLowerCase();
  if (!email) throw new HttpError(401, 'unauthorized', 'ログインし直してください');
  const item = await loadUserItem(email);
  if (!item || item.status !== 'active') {
    throw new HttpError(403, 'forbidden', 'このアカウントは登録されていません。管理者に連絡してください。');
  }
  const level = levelFor(item.position, await loadPositions());
  if (!level) throw new HttpError(403, 'forbidden', '役職の設定に問題があります。管理者に連絡してください。');
  const capabilities = capabilitiesFor(level);
  const user = {
    id: email,
    email,
    displayName: item.displayName || (typeof claims.name === 'string' ? claims.name : '') || email,
    position: item.position,
    deptIds: Array.isArray(item.deptIds) ? item.deptIds : [],
    status: item.status,
    googleSub: item.googleSub ?? null,
    level,
    capabilities,
  };
  return { user, level, capabilities };
}
