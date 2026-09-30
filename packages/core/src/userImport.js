// ユーザーの一括登録（docs/design.md §3.3）。
// 登録の前に必ず確認画面を挟む。無い部署を自動で作るので、部署名の書き間違いがそのまま新しい部署になるため。
// ここは「何が起きるか」の計画だけを作り、保存はしない（AWS 版は DynamoDB、画面はプレビュー表示に使う）。

import { normalizeText } from './search.js';
import { DEFAULT_POSITIONS } from './permissions.js';
import { isValidEmail } from './util.js';

export const MAX_IMPORT_ROWS = 1000;

const cell = (v) => String(v ?? '').normalize('NFKC').trim();

/**
 * CSV を読んだ string[][] を行のオブジェクトにする。列は 部署, アドレス, 役職 の順で、4 列目は氏名（任意）。
 * 1 行目にメールアドレスの形のものが無ければ見出しとみなして飛ばす。
 * row は元のファイルでの行番号（1 始まり）。エラー表示でそのまま使う。
 */
export function parseUserRows(rows) {
  const out = [];
  (rows ?? []).forEach((r, idx) => {
    if (!Array.isArray(r) || r.every((c) => !String(c ?? '').trim())) return;
    if (idx === 0 && !r.some((c) => isValidEmail(cell(c)))) return;
    out.push({ department: cell(r[0]), email: cell(r[1]), position: cell(r[2]), displayName: String(r[3] ?? '').trim(), row: idx + 1 });
  });
  return out;
}

const compactKey = (s) => normalizeText(s).replace(/ /g, '');
const deptNamesOf = (u) => (u?.departments ?? u?.deptNames ?? []).map((d) => (typeof d === 'string' ? d : d?.name)).filter(Boolean);

/**
 * @param {object} o
 * @param {Array<string[]|object>} o.rows 文字列の行、または parseUserRows の結果
 * @param {Array} o.existingUsers [{ email, position, departments: [名前 or { name }], displayName }]
 * @param {Array<{name: string}|string>} o.departments 既存の部署
 * @param {Array<{name: string, level: string}>} [o.positions]
 * @param {string|string[]} [o.companyDomain]
 * @param {boolean} [o.actorIsDev]
 */
export function planUserImport({ rows, existingUsers = [], departments = [], positions = DEFAULT_POSITIONS, companyDomain, actorIsDev = false }) {
  const list = Array.isArray(rows?.[0]) ? parseUserRows(rows) : (rows ?? []).map((r, i) => ({ ...r, row: r.row ?? i + 1 }));
  const errors = [];
  const err = (r, email, message) => errors.push({ row: r.row, email: email || '', message });

  if (list.length > MAX_IMPORT_ROWS) {
    errors.push({ row: 0, email: '', message: `1 回に取り込めるのは ${MAX_IMPORT_ROWS} 行までです` });
  }

  const domains = [companyDomain].flat().filter(Boolean).map((d) => cell(d).replace(/^@/, '').toLowerCase());
  const posByKey = new Map(positions.map((p) => [normalizeText(p.name), p]));
  const existingDepts = departments.map((d) => (typeof d === 'string' ? d : d.name));
  const deptByKey = new Map(existingDepts.map((n) => [normalizeText(n), n]));
  const deptByCompact = new Map(existingDepts.map((n) => [compactKey(n), n]));

  // 1. 行ごとの検査。通った行を、アドレスごとにまとめる（同じアドレスの複数行は部署を合わせて 1 人に）
  const byEmail = new Map();
  for (const r of list) {
    const email = cell(r.email).toLowerCase();
    let ok = true;
    if (!isValidEmail(email)) {
      err(r, email, 'メールアドレスの形式が正しくありません');
      continue;
    }
    if (domains.length && !domains.includes(email.split('@')[1])) {
      err(r, email, '会社のドメインではありません');
      ok = false;
    }
    const pos = posByKey.get(normalizeText(r.position));
    if (!pos) {
      err(r, email, `役職「${cell(r.position)}」が一覧にありません`);
      ok = false;
    } else if (pos.level === 'dev' && !actorIsDev) {
      err(r, email, '「開発者」を指定できるのは開発者だけです');
      ok = false;
    }
    const depts = String(r.department ?? '')
      .split(/[;；]/)
      .map((d) => cell(d))
      .filter(Boolean);
    if (depts.length === 0) {
      err(r, email, '部署が空です');
      ok = false;
    }
    if (!ok) continue;

    const entry = byEmail.get(email);
    if (!entry) {
      byEmail.set(email, { email, position: pos.name, depts: [...depts], displayName: String(r.displayName ?? '').trim(), rows: [r.row], broken: false });
    } else {
      if (entry.position !== pos.name && !entry.broken) {
        // 同じアドレスで役職が食い違う。どちらが正しいか分からないので、その人は登録しない
        entry.broken = true;
        err(r, email, `同じアドレスで役職が食い違っています（${entry.position} / ${pos.name}）`);
      }
      entry.depts.push(...depts);
      entry.displayName ||= String(r.displayName ?? '').trim();
      entry.rows.push(r.row);
    }
  }

  // 2. 部署名を既存に合わせる。無ければ新しい部署にする
  const newDepts = new Map(); // key -> { name, users: Set, similarTo }
  const resolveDept = (name, email) => {
    const key = normalizeText(name);
    if (deptByKey.has(key)) return deptByKey.get(key);
    let nd = newDepts.get(key);
    if (!nd) {
      const similar = deptByCompact.get(compactKey(name)) ?? null;
      nd = { name, users: new Set(), similarTo: similar };
      newDepts.set(key, nd);
    }
    nd.users.add(email);
    return nd.name;
  };

  const existingByEmail = new Map(existingUsers.map((u) => [cell(u.email).toLowerCase(), u]));
  const create = [];
  const update = [];
  const unchanged = [];
  for (const e of byEmail.values()) {
    if (e.broken) continue;
    const seen = new Set();
    const deptNames = [];
    for (const d of e.depts) {
      const resolved = resolveDept(d, e.email);
      const k = normalizeText(resolved);
      if (!seen.has(k)) {
        seen.add(k);
        deptNames.push(resolved);
      }
    }
    const prev = existingByEmail.get(e.email);
    const after = { email: e.email, position: e.position, departments: deptNames, displayName: e.displayName || (prev?.displayName ?? ''), row: e.rows[0] };
    if (!prev) {
      create.push(after);
      continue;
    }
    const before = { email: e.email, position: prev.position, departments: deptNamesOf(prev), displayName: prev.displayName ?? '' };
    const sameDepts =
      before.departments.length === deptNames.length &&
      before.departments.every((d) => seen.has(normalizeText(d)));
    const samePos = normalizeText(before.position) === normalizeText(e.position);
    const sameName = !e.displayName || e.displayName === before.displayName;
    if (sameDepts && samePos && sameName) unchanged.push({ ...before, row: e.rows[0] });
    else update.push({ before, after });
  }

  // 新しい部署は、一覧の見出しにそのまま出せる形にする。似た既存の部署があれば similarTo で警告
  const newDepartments = [...newDepts.values()].map((d) => ({
    name: d.name,
    count: d.users.size,
    ...(d.similarTo ? { similarTo: d.similarTo } : {}),
  }));

  errors.sort((a, b) => a.row - b.row);
  return { create, update, unchanged, errors, newDepartments };
}
