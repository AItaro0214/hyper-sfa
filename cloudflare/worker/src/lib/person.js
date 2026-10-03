// 同じ人の名刺（docs/design.md §5.5b）の SQL と判定のつなぎ。D1 を呼ばない関数だけを置く。
// 候補は索引の効く = / IN だけで引く（LIKE で全件を走査しない）。判定そのものは core の classifyMatch。
import { classifyMatch, matchKeys, rankMatches } from '../core.js';
import { safeJson } from './time.js';

const CANDIDATE_LIMIT = 50;

/** 名刺の行 → 突き合わせ用のキー。 */
export function rowMatchKeys(row) {
  return matchKeys({
    company: row.company,
    name: row.name,
    title: row.title,
    phones: safeJson(row.phones, []),
    mobiles: safeJson(row.mobiles, []),
    emails: safeJson(row.emails, []),
  });
}

const marks = (n) => Array(n).fill('?').join(',');

/**
 * 候補を引く SQL。氏名（idx_cards_name_n）・メール・電話（card_contacts の主キー）の 3 つを UNION し、
 * 引いた ID だけ cards を主キーで読む。現在の名刺（is_current = 1）だけ。引く手掛かりが無ければ null。
 * 取引先 + 氏名の一致は氏名が同じことを含むので、氏名の索引で足りる（最後に classifyMatch が確かめる）。
 */
export function buildMatchQuery(mine, { selfId, limit = CANDIDATE_LIMIT } = {}) {
  const parts = [];
  const params = [];
  if (mine.nameN) {
    parts.push('SELECT id FROM cards WHERE name_n = ?');
    params.push(mine.nameN);
  }
  if (mine.emails.length) {
    parts.push(`SELECT card_id FROM card_contacts WHERE kind = 'e' AND k IN (${marks(mine.emails.length)})`);
    params.push(...mine.emails);
  }
  if (mine.phones.length) {
    parts.push(`SELECT card_id FROM card_contacts WHERE kind = 'p' AND k IN (${marks(mine.phones.length)})`);
    params.push(...mine.phones);
  }
  if (!parts.length) return null;
  // CROSS JOIN は結合の順番を固定する書き方。これが無いと、削除されていない名刺を先に全部読む計画になる
  const sql = `SELECT c.* FROM (${parts.join(' UNION ')}) AS m CROSS JOIN cards c ON c.id = m.id
    WHERE c.deleted_at IS NULL AND c.is_current = 1 AND c.status IN ('review', 'confirmed') AND c.id != ?
    LIMIT ?`;
  params.push(selfId ?? '', limit);
  return { sql, params };
}

/** 候補の行を判定して、強い順に最大 5 件。確認待ちの名刺は「更新」の相手にできないので、同じ人としては出さない。 */
export function matchesFromRows(rows, mine, { max = 5 } = {}) {
  const out = [];
  for (const row of rows) {
    const r = classifyMatch(mine, rowMatchKeys(row));
    if (!r) continue;
    if (r.kind === 'same_person' && row.status !== 'confirmed') continue;
    out.push({
      id: row.id,
      company: row.company,
      department: row.department,
      title: row.title ?? '',
      name: row.name,
      createdAt: row.created_at,
      kind: r.kind,
      reason: r.reason,
    });
  }
  return rankMatches(out, { max });
}

/** card_contacts の作り直し（削除 + 追加）。電話は固定と携帯をまとめた数字、メールは正規化したもの。 */
export function contactStatements(db, cardId, keys) {
  const rows = [
    ...(keys.emailsN ?? []).map((k) => ['e', k]),
    ...(keys.phonesDigits ?? []).map((k) => ['p', k]),
  ];
  const out = [db.prepare('DELETE FROM card_contacts WHERE card_id = ?').bind(cardId)];
  // D1 は 1 つの文に束縛できる値が 100 個まで。3 つ組を 30 行ずつ
  for (let i = 0; i < rows.length; i += 30) {
    const part = rows.slice(i, i + 30);
    out.push(
      db
        .prepare(`INSERT OR IGNORE INTO card_contacts (kind, k, card_id) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}`)
        .bind(...part.flatMap(([kind, k]) => [kind, k, cardId])),
    );
  }
  return out;
}

/**
 * 直前の UPDATE が 1 行も変えていなければ、わざと壊れた JSON を読ませてエラーにする。
 * D1 の batch はエラーで全体を巻き戻すが、WHERE に合わなかった UPDATE（0 行）はエラーにならず、
 * 「前の名刺だけ過去になって、新しい名刺は変わらない」という中途半端な状態が残ってしまうため。
 */
export const GUARD_SQL = "SELECT CASE WHEN changes() >= 1 THEN 1 ELSE json('!') END";
export const isGuardError = (e) => /malformed JSON/i.test(String(e?.message ?? e));

const byCreated = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1);

/**
 * 人に残る名刺の中で「現在」にすべきものと、フラグを変える必要のある名刺。
 * rows: [{ id, created_at, is_current, version, status }]（外す / 消す名刺を除く）。一番新しい確認済みが現在。
 * @returns {{ top: object|null, flips: Array<{ id, version, current: boolean }> }}
 */
export function planCurrent(rows) {
  const confirmed = rows.filter((r) => r.status === 'confirmed').sort(byCreated);
  const top = confirmed.at(-1) ?? null;
  const flips = [];
  for (const r of rows) {
    const want = top != null && r.id === top.id;
    if (want !== (r.is_current !== 0)) flips.push({ id: r.id, version: r.version, current: want });
  }
  return { top, flips };
}

/** `person.cards` の形。古い順。 */
export function personCardsOf(rows) {
  return [...rows].sort(byCreated).map((r) => ({
    id: r.id,
    company: r.company,
    department: r.department,
    title: r.title ?? '',
    name: r.name,
    createdAt: r.created_at,
    isCurrent: r.is_current !== 0,
  }));
}
