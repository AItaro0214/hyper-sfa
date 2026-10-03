// 名刺の検索 SQL の組み立て（docs/design.md §3.1）。D1 を呼ばない純粋な関数なので単体で試せる。
// 検索は「正規化済みの列に LIKE '%語%' を AND でつなぐ」だけ。5,000 件なら数ミリ秒。

// LIKE の特殊文字を文字どおりに探す（ESCAPE '\' と対で使う）
export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

const pattern = (w) => `%${escapeLike(w)}%`;

export const CARD_LIST_LIMIT_DEFAULT = 50;
export const CARD_LIST_LIMIT_MAX = 200;

export function clampLimit(value, fallback = CARD_LIST_LIMIT_DEFAULT, max = CARD_LIST_LIMIT_MAX) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * @param filters.terms  正規化済みの語の配列（company / name / department / phone / email / note）。
 *                       core の parseQuery の結果をそのまま渡す。phone は数字だけ。
 * @param filters.ownerId  登録者
 * @param filters.fromIso / toIso  登録日時の範囲（from 以上、to 未満）
 * @param filters.status   指定があればその状態だけ。無ければ「確認待ち」と「確認済み」
 * @param filters.viewerId 読み取り中 / 失敗は登録した本人にしか見せない
 * @param opts.cursor      前のページの最後の ID（ID は時刻順に並ぶ ULID）
 * @returns {{ listSql, listParams, countSql, countParams }}
 */
export function buildCardSearch(
  filters = {},
  { cursor = null, limit = CARD_LIST_LIMIT_DEFAULT, prefix = '', select = 'SELECT *', from = 'cards' } = {},
) {
  // prefix: JOIN するとき列名の前に付ける別名（例 'c.'）
  const col = (name) => prefix + name;
  const like = (name) => `${col(name)} LIKE ? ESCAPE '\\'`;
  const terms = filters.terms ?? {};
  // 一覧・検索は人ごとの「現在」の名刺だけ。過去の名刺は詳細の「この人の名刺の変遷」からたどる
  const where = [`${col('deleted_at')} IS NULL`, `${col('is_current')} = 1`];
  const params = [];

  if (filters.status) {
    where.push(`${col('status')} = ?`);
    params.push(filters.status);
    // 読み取り中 / 失敗は、まだ「登録」になっていない。登録した本人だけの一覧に出す
    if (filters.status === 'processing' || filters.status === 'failed') {
      where.push(`${col('created_by')} = ?`);
      params.push(filters.viewerId ?? '');
    }
  } else {
    where.push(`${col('status')} IN ('review', 'confirmed')`);
  }

  for (const w of terms.company ?? []) {
    where.push(like('company_n'));
    params.push(pattern(w));
  }
  // 氏名の欄は読みにも当てる（ふりがながあれば、ひらがなで探せる）
  for (const w of terms.name ?? []) {
    where.push(`(${like('name_n')} OR ${like('reading_n')})`);
    params.push(pattern(w), pattern(w));
  }
  for (const w of terms.department ?? []) {
    where.push(like('department_n'));
    params.push(pattern(w));
  }
  for (const w of terms.phone ?? []) {
    where.push(like('phones_digits'));
    params.push(pattern(w));
  }
  for (const w of terms.email ?? []) {
    where.push(like('emails_n'));
    params.push(pattern(w));
  }
  for (const w of terms.note ?? []) {
    // 役職は独立した列だが、検索の欄は備考と共通（契約の検索パラメータを増やさない）
    where.push(`(${like('note_n')} OR ${like('title_n')})`);
    params.push(pattern(w), pattern(w));
  }
  if (filters.ownerId) {
    where.push(`${col('created_by')} = ?`);
    params.push(filters.ownerId);
  }
  if (filters.fromIso) {
    where.push(`${col('created_at')} >= ?`);
    params.push(filters.fromIso);
  }
  if (filters.toIso) {
    where.push(`${col('created_at')} < ?`);
    params.push(filters.toIso);
  }

  const whereSql = where.join(' AND ');
  const listWhere = cursor ? `${whereSql} AND ${col('id')} < ?` : whereSql;
  const listParams = cursor ? [...params, cursor] : [...params];
  // 1 件多く読んで、次のページがあるかを知る
  listParams.push(limit + 1);

  return {
    listSql: `${select} FROM ${from} WHERE ${listWhere} ORDER BY ${col('id')} DESC LIMIT ?`,
    listParams,
    countSql: `SELECT COUNT(*) AS n FROM ${from} WHERE ${whereSql}`,
    countParams: params,
  };
}
