// console の共通部品。管理コンソール（/api/admin）と開発コンソール（/api/dev）で使う。
import { levelFor } from '@hyper-sfa/core';
import { ddb, loadPositions, forbidden } from '@hyper-sfa/aws-shared';

export const me = (c) => c.get('auth').user;

/** 管理コンソールに入れる段階（役員・GM・SMG と開発者）。 */
export const isAdminLevel = (level) => level === 'dev' || level === 'org_admin';

export async function listUserItems() {
  return ddb.queryAll({ pk: 'ORG', skPrefix: 'USER#' });
}

export const emailOf = (item) => String(item.sk).slice('USER#'.length);

export async function listDeptItems() {
  const items = await ddb.queryAll({ pk: 'ORG', skPrefix: 'DEPT#' });
  return items
    .map((i) => ({ id: String(i.sk).slice('DEPT#'.length), name: i.name ?? '', order: i.order ?? 0, active: i.active !== false }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ja'));
}

/** 有効なユーザーのうち、条件に当たる人数。except のメールアドレスは数えない。 */
export async function countActive(pred, exceptEmail) {
  const [items, positions] = await Promise.all([listUserItems(), loadPositions()]);
  return items.filter((i) => i.status === 'active' && emailOf(i) !== exceptEmail && pred(levelFor(i.position, positions))).length;
}

/** 同時実行数を絞って順に処理する（DynamoDB の書き込みを一度に流し込まないため）。 */
export async function mapPool(list, size, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(...(await Promise.all(list.slice(i, i + size).map(fn))));
  return out;
}

/** 'YYYY-MM' の配列（from 〜 to、両端を含む）。不正なら既定（直近 n か月）。新しい月が先頭。 */
export function monthRange(from, to, defaultMonths = 3, now = new Date()) {
  const ok = (s) => /^\d{4}-\d{2}/.test(String(s ?? ''));
  const cur = now.toISOString().slice(0, 7);
  const end = ok(to) ? String(to).slice(0, 7) : cur;
  let start = ok(from) ? String(from).slice(0, 7) : null;
  if (!start) {
    const d = new Date(`${end}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - (defaultMonths - 1));
    start = d.toISOString().slice(0, 7);
  }
  const out = [];
  const d = new Date(`${end}-01T00:00:00Z`);
  for (let i = 0; i < 60 && d.toISOString().slice(0, 7) >= start; i++) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

export function requireCap(c, cap) {
  if (!c.get('auth').capabilities[cap]) throw forbidden();
}

/** 履歴の 1 件を API の形にする（画面・CSV 共通）。 */
export function presentHist(h) {
  return {
    id: h.sk,
    type: h.type,
    at: h.at,
    actor: { id: h.actorUserId, name: h.actorName ?? '', deptName: h.actorDeptName ?? '' },
    source: h.source ?? null,
    card: { id: String(h.pk).slice('CARD#'.length), company: h.cardCompany ?? '', name: h.cardName ?? '' },
    changes: h.changes ?? [],
  };
}

/**
 * 月ごとに区切られた記録（履歴、監査ログ）を、新しい月から順に limit 件ずつ返す。
 * @param {object} o
 * @param {string[]} o.months 新しい月が先頭
 * @param {(month: string, startKey?: object) => Promise<{items: object[], lastKey?: object}>} o.page 1 ページ読む（新しい順）
 * @param {(item: object) => boolean} o.keep 条件に合うか
 * @param {(item: object) => object} o.map API の形にする
 * @param {(item: object) => object} o.keyOf ExclusiveStartKey にできるキー
 * @param {{m: string, k: object}|null} [o.cursor]
 * @returns {Promise<{ items: object[], cursor: {m: string, k: object}|null }>}
 */
export async function pageMonths({ months, page, keep, map, keyOf, limit, cursor = null }) {
  const out = [];
  let started = !cursor;
  for (const month of months) {
    if (!started && cursor.m !== month) continue;
    let startKey = started ? undefined : cursor.k;
    started = true;
    do {
      const r = await page(month, startKey);
      for (const it of r.items) {
        if (!keep(it)) continue;
        out.push(map(it));
        if (out.length >= limit) return { items: out, cursor: { m: month, k: keyOf(it) } };
      }
      startKey = r.lastKey;
    } while (startKey);
  }
  return { items: out, cursor: null };
}
