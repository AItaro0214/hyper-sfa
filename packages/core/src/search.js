// 検索キー（docs/design.md §3.1）。
// 全角 / 半角、大文字 / 小文字、ひらがな / カタカナ、空白の違いを区別しないよう、
// 保存時と検索時の両方で同じ正規化を通す。

/** NFKC、小文字、カタカナ → ひらがな、連続する空白を 1 つに、前後の空白を除く。 */
export function normalizeText(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 数字だけを残す。国番号 +81 は先頭の 0 に戻す（`+81 3-1234-5678` → `0312345678`）。
 * ハイフンの有無や +81 表記の違いで検索に漏れないようにするため。
 */
export function phoneDigits(s) {
  const digits = String(s ?? '')
    .normalize('NFKC')
    .replace(/\D/g, '');
  if (digits.startsWith('81') && digits.length >= 11) return '0' + digits.slice(2);
  return digits;
}

// 氏名の間の空白を区別しないため、空白は全部除いて持つ。
// 検索語は空白で分けるので、語が空白を含むことは無く、除いても当たり方は変わらない。
const compact = (s) => normalizeText(s).replace(/ /g, '');

/** 名刺 1 枚の検索キー。名刺の保存時に作って持つ。 */
export function searchKeys(card) {
  const c = card ?? {};
  const phones = [...(c.phones ?? []), ...(c.mobiles ?? [])];
  return {
    companyN: compact(c.company),
    nameN: compact(c.name),
    readingN: compact(c.nameReading),
    departmentN: compact(c.department),
    phonesDigits: phones.map(phoneDigits).filter(Boolean),
    emailsN: (c.emails ?? []).map(normalizeText).filter(Boolean),
    titleN: normalizeText(c.title),
    noteN: normalizeText(c.note),
  };
}

const terms = (v) => normalizeText(v).split(' ').filter(Boolean);

/**
 * 検索条件の各欄を、空白で分けた語の配列にする。
 * @returns {{ company: string[], name: string[], department: string[], phone: string[], email: string[], note: string[] }}
 */
export function parseQuery(params) {
  const p = params ?? {};
  return {
    company: terms(p.company),
    name: terms(p.name),
    department: terms(p.department),
    phone: terms(p.phone).map(phoneDigits).filter(Boolean),
    email: terms(p.email),
    note: terms(p.note),
  };
}

/**
 * すべての条件を満たすか（AND）。部分一致。語が空の欄は条件にならない。
 * 氏名の欄は、氏名の読み（ふりがな）にも当てる。名刺に読みがあれば、ひらがなで探せる。
 */
export function matchCard(keys, query) {
  const q = query ?? {};
  const all = (words, test) => (words ?? []).every(test);
  return (
    all(q.company, (w) => keys.companyN.includes(w)) &&
    all(q.name, (w) => keys.nameN.includes(w) || keys.readingN.includes(w)) &&
    all(q.department, (w) => keys.departmentN.includes(w)) &&
    // 電話番号の欄は固定と携帯の両方を探す（searchKeys が 1 つの配列にまとめている）
    all(q.phone, (w) => keys.phonesDigits.some((d) => d.includes(w))) &&
    all(q.email, (w) => keys.emailsN.some((e) => e.includes(w))) &&
    // 役職は独立した項目だが、検索の欄は増やさない。備考の欄の語を役職にも当てる
    all(q.note, (w) => keys.noteN.includes(w) || (keys.titleN ?? '').includes(w))
  );
}
