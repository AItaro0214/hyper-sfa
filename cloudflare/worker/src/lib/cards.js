// 名刺の行 ↔ API の形、差分、失敗の文言。D1 を呼ばない関数だけを置く。
import { safeJson } from './time.js';


// 上限。外から来た値（Gemini の応答も含む）を切り詰め、DB とレスポンスが膨らまないようにする
const MAX = { company: 200, department: 200, name: 100, nameReading: 200, note: 2000, rawText: 10000, item: 200, items: 10 };

const cut = (s, n) => String(s ?? '').trim().slice(0, n);

// 名刺の内容だけを取り出して長さをそろえる。メールは小文字にする（docs/design.md §5.5）
export function sanitizeCard(input) {
  const list = (v, lower = false) =>
    (Array.isArray(v) ? v : [])
      .map((x) => cut(lower ? String(x ?? '').toLowerCase() : x, MAX.item))
      .filter(Boolean)
      .slice(0, MAX.items);
  return {
    company: cut(input.company, MAX.company),
    department: cut(input.department, MAX.department),
    name: cut(input.name, MAX.name),
    nameReading: cut(input.nameReading, MAX.nameReading),
    phones: list(input.phones),
    mobiles: list(input.mobiles),
    emails: list(input.emails, true),
    note: cut(input.note, MAX.note),
  };
}

export const cutRawText = (s) => cut(s, MAX.rawText);

// core の searchKeys の結果 → cards の検索用の列。配列は空白でつなぐ（検索語は空白を含まない）
export function keyColumns(keys) {
  return {
    company_n: keys.companyN ?? '',
    name_n: keys.nameN ?? '',
    reading_n: keys.readingN ?? '',
    department_n: keys.departmentN ?? '',
    phones_digits: (keys.phonesDigits ?? []).join(' '),
    emails_n: (keys.emailsN ?? []).join(' '),
    note_n: keys.noteN ?? '',
  };
}

// 読み取りの失敗の種類と、画面に出す文言（docs/design.md §5.7）
const FAILURES = {
  parse: { message: '読み取り結果を受け取れませんでした', retryable: true },
  truncated: { message: '読み取りが途中で止まりました', retryable: true },
  provider: { message: '混み合っていて読み取れませんでした', retryable: true },
  empty: { message: '名刺の文字を読み取れませんでした', retryable: true },
  blocked: { message: 'この写真は読み取れませんでした', retryable: false },
  not_configured: { message: '設定に問題があります。開発者に連絡してください', retryable: false },
};

export function failureFor(kind) {
  const f = FAILURES[kind] ?? FAILURES.provider;
  return { kind: FAILURES[kind] ? kind : 'provider', message: f.message, retryable: f.retryable };
}

export function imageUrls(row) {
  const u = (kind, key) => (key ? `/api/cards/${row.id}/images/${kind}` : null);
  return { thumb: u('thumb', row.thumb_key), front: u('front', row.image_front_key), back: u('back', row.image_back_key) };
}

const who = (id, name) => (id ? { id, name: name || '' } : null);

// SELECT c.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name の行を想定
export function rowToCard(row, { detail = false } = {}) {
  const card = {
    id: row.id,
    status: row.status,
    company: row.company,
    department: row.department,
    name: row.name,
    nameReading: row.name_reading,
    phones: safeJson(row.phones, []),
    mobiles: safeJson(row.mobiles, []),
    emails: safeJson(row.emails, []),
    note: row.note,
    deptIds: [],
    departments: [],
    imageUrls: imageUrls(row),
    createdBy: who(row.created_by, row.created_by_name),
    createdAt: row.created_at,
    updatedBy: who(row.updated_by, row.updated_by_name),
    updatedAt: row.updated_at,
    editCount: row.edit_count,
    scanCount: row.scan_count,
    version: row.version,
    failure: safeJson(row.failure, null),
  };
  if (detail) card.rawText = row.raw_text;
  return card;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 項目ごとの差分（履歴の changes）。変わっていない項目は入れない
export function diffCards(before, after) {
  const changes = [];
  for (const field of ['company', 'department', 'name', 'nameReading', 'phones', 'mobiles', 'emails', 'note']) {
    if (!same(before[field], after[field])) changes.push({ field, before: before[field], after: after[field] });
  }
  return changes;
}

// 重複の知らせ。メールが 1 つでも同じ、または会社名と氏名が同じ
export function classifyDuplicates(card, candidates) {
  const mine = new Set((card.emailsN ?? []).filter(Boolean));
  const out = [];
  for (const c of candidates) {
    const theirs = (c.emails_n || '').split(' ').filter(Boolean);
    if (theirs.some((e) => mine.has(e))) out.push({ id: c.id, company: c.company, name: c.name, reason: 'email' });
    else out.push({ id: c.id, company: c.company, name: c.name, reason: 'company_name' });
  }
  return out;
}
