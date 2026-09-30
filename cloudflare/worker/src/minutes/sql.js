// 議事録の一覧に使う SQL の組み立て。D1 にも core にも依存しない純粋な関数だけを置く。
// なぜ切り出すか: 条件の組み合わせ（relation、会社名、cardId、cursor）が多く、
// node --test で SQL 文字列と bind 値を直接確かめたいため。

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100; // D1 は 1 クエリの bind が 100 個までなので、IN (...) を使う側と揃えて 100 に抑える

/** LIKE のワイルドカードを文字として扱うためのエスケープ（ESCAPE '\' と対で使う） */
export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/** 空白（全角含む）で分けた語の配列。空なら [] */
export function splitTerms(s) {
  return String(s ?? '')
    .split(/[\s　]+/)
    .filter(Boolean);
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** cursor は `held_at|id`。壊れていたら null（先頭から返す） */
export function encodeCursor(row) {
  return `${row.held_at}|${row.id}`;
}
export function decodeCursor(cursor) {
  if (typeof cursor !== 'string') return null;
  const i = cursor.lastIndexOf('|');
  if (i <= 0 || i === cursor.length - 1) return null;
  return { heldAt: cursor.slice(0, i), id: cursor.slice(i + 1) };
}

/**
 * 日付（YYYY-MM-DD、日本時間の日）を UTC の ISO に直す。to は翌日 0 時（排他的）にする。
 * 画面は日本時間の日付で絞るが、held_at は UTC で保存しているため。
 */
export function jstDayStartIso(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd ?? '')) return null;
  const t = new Date(`${ymd}T00:00:00+09:00`);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}
export function jstNextDayStartIso(ymd) {
  const start = jstDayStartIso(ymd);
  if (!start) return null;
  return new Date(new Date(start).getTime() + 24 * 3600 * 1000).toISOString();
}

/**
 * 一覧の SQL を組み立てる。
 * - 見られるのは「作った人」か「minute_shares にいる人」だけ（役職は関係ない）。
 * - company / name / cardId は同じ相手の 1 行に対して AND（「アシスト 山田」は同じ人を指す）。
 * - 1 ページ分より 1 件多く取り、次があるかを呼び出し側が判断する。
 *
 * @param {object} p
 * @param {string} p.userId 見ている人
 * @param {'owner'|'shared'|'all'} [p.relation]
 * @param {(s:string)=>string} [p.normalize] 検索用の正規化（core の normalizeText を渡す）
 */
export function buildListQuery(p) {
  const normalize = p.normalize ?? ((s) => String(s).toLowerCase());
  const relation = ['owner', 'shared', 'all'].includes(p.relation) ? p.relation : 'all';
  const limit = Math.min(Math.max(parseInt(p.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const where = ['m.deleted_at IS NULL'];
  const params = [];

  const sharedExists =
    'EXISTS (SELECT 1 FROM minute_shares s WHERE s.minute_id = m.id AND s.user_id = ?)';
  if (relation === 'owner') {
    where.push('m.owner_id = ?');
    params.push(p.userId);
  } else if (relation === 'shared') {
    where.push(sharedExists);
    params.push(p.userId);
  } else {
    where.push(`(m.owner_id = ? OR ${sharedExists})`);
    params.push(p.userId, p.userId);
  }

  // 相手（同じ行に対して全条件を AND）
  const cpConds = [];
  const cpParams = [];
  for (const t of splitTerms(p.company)) {
    cpConds.push("c.company_n LIKE ? ESCAPE '\\'");
    cpParams.push(`%${escapeLike(normalize(t))}%`);
  }
  for (const t of splitTerms(p.name)) {
    cpConds.push("c.name_n LIKE ? ESCAPE '\\'");
    cpParams.push(`%${escapeLike(normalize(t))}%`);
  }
  if (p.cardId) {
    cpConds.push('c.card_id = ?');
    cpParams.push(p.cardId);
  }
  if (cpConds.length) {
    where.push(
      `EXISTS (SELECT 1 FROM minute_counterparts c WHERE c.minute_id = m.id AND ${cpConds.join(' AND ')})`,
    );
    params.push(...cpParams);
  }

  if (p.attendee) {
    where.push('EXISTS (SELECT 1 FROM minute_attendees a WHERE a.minute_id = m.id AND a.user_id = ?)');
    params.push(p.attendee);
  }
  if (p.owner) {
    where.push('m.owner_id = ?');
    params.push(p.owner);
  }
  const from = p.from ? jstDayStartIso(p.from) : null;
  if (from) {
    where.push('m.held_at >= ?');
    params.push(from);
  }
  const to = p.to ? jstNextDayStartIso(p.to) : null;
  if (to) {
    where.push('m.held_at < ?');
    params.push(to);
  }
  for (const t of splitTerms(p.title)) {
    where.push("m.title LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(t)}%`);
  }

  const cur = decodeCursor(p.cursor);
  if (cur) {
    where.push('(m.held_at < ? OR (m.held_at = ? AND m.id < ?))');
    params.push(cur.heldAt, cur.heldAt, cur.id);
  }

  const sql =
    'SELECT m.*, u.display_name AS owner_name FROM minutes m JOIN users u ON u.id = m.owner_id ' +
    `WHERE ${where.join(' AND ')} ORDER BY m.held_at DESC, m.id DESC LIMIT ?`;
  params.push(limit + 1);
  return { sql, params, limit };
}
