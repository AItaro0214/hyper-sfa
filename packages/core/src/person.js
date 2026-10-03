// 同じ人の判定（docs/design.md §5.5b）。名刺 1 枚から作る突き合わせ用のキーと、2 枚の関係の分類。
// 両バックエンドが同じ判定をするよう、ここに 1 つだけ置く。引き表の作り方（メモリ内の索引、D1 の列）は各バックエンドが持つ。
import { normalizeText, phoneDigits } from './search.js';
import { companyKey } from './company.js';

const uniq = (list) => [...new Set(list.filter(Boolean))];
const compact = (s) => normalizeText(s).replace(/ /g, '');

/**
 * 突き合わせ用のキー。
 * - emails: 正規化したメール
 * - phones: 電話 + 携帯の数字だけ（引き表の検索用）
 * - mobiles: 携帯の数字だけ（「同じ人」の根拠にするのは携帯だけ。代表番号は別人でも同じになるため）
 * - nameN: 氏名（空白を除いて正規化）
 * - companyKeyName: 取引先キー + '|' + 氏名。どちらかが空なら空文字（空同士が一致して「同じ人」にならないように）
 */
export function matchKeys(card) {
  const c = card ?? {};
  const mobiles = uniq((c.mobiles ?? []).map(phoneDigits));
  const phones = uniq([...(c.phones ?? []).map(phoneDigits), ...mobiles]);
  const nameN = compact(c.name);
  const ck = companyKey(c.company);
  return {
    emails: uniq((c.emails ?? []).map(normalizeText)),
    phones,
    mobiles,
    nameN,
    companyN: ck,
    companyKeyName: ck && nameN ? `${ck}|${nameN}` : '',
    titleN: normalizeText(c.title),
  };
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const hits = (a, b) => a.some((x) => b.includes(x));

/**
 * 2 枚の関係。mine は新しく撮った名刺の matchKeys、other は既存の名刺の matchKeys。
 * @returns {{ kind: 'same_card'|'same_person'|'same_name', reason: string } | null}
 *   reason: email / mobile / company_name / name
 */
export function classifyMatch(mine, other) {
  if (!mine || !other) return null;
  const sameName = mine.nameN !== '' && mine.nameN === other.nameN;
  // 同じ名刺: 氏名と会社が同じで、連絡先（電話・携帯・メール）と役職も全部同じ
  if (
    sameName &&
    mine.companyN === other.companyN &&
    mine.titleN === other.titleN &&
    sameSet(mine.phones, other.phones) &&
    sameSet(mine.emails, other.emails)
  ) {
    return { kind: 'same_card', reason: 'company_name' };
  }
  if (hits(mine.emails, other.emails)) return { kind: 'same_person', reason: 'email' };
  if (hits(mine.mobiles, other.mobiles)) return { kind: 'same_person', reason: 'mobile' };
  if (mine.companyKeyName !== '' && mine.companyKeyName === other.companyKeyName) return { kind: 'same_person', reason: 'company_name' };
  if (sameName) return { kind: 'same_name', reason: 'name' };
  return null;
}

const KIND_RANK = { same_card: 0, same_person: 1, same_name: 2 };
const REASON_RANK = { email: 0, mobile: 1, company_name: 2, phone: 3, name: 4 };

/** 強い順（種類 → 根拠 → 新しい順）に並べて max 件。list の要素は { kind, reason, createdAt? }。 */
export function rankMatches(list, { max = 5 } = {}) {
  return [...(list ?? [])]
    .map((x, i) => ({ x, i }))
    .sort(
      (a, b) =>
        (KIND_RANK[a.x.kind] ?? 9) - (KIND_RANK[b.x.kind] ?? 9) ||
        (REASON_RANK[a.x.reason] ?? 9) - (REASON_RANK[b.x.reason] ?? 9) ||
        (String(a.x.createdAt ?? '') < String(b.x.createdAt ?? '') ? 1 : String(a.x.createdAt ?? '') > String(b.x.createdAt ?? '') ? -1 : 0) ||
        a.i - b.i,
    )
    .slice(0, max)
    .map((s) => s.x);
}
