// 取引先の表記ゆれの吸収と、会社 → 部署 → 人の集計（docs/core-api.md §16）。
import { normalizeText } from './search.js';

// 日本語の法人格。長い語から除く。括弧付きの略称（(株) など）は、記号を除く前に消さないと「株」だけが残って
// 社名の中の「株」と区別できなくなるので別に持つ（NFKC で ㈱ → (株)、全角括弧 → 半角括弧になっている）。
const PAREN_CORPS = ['(株)', '(有)'];
const JP_CORPS = [
  '株式会社', '有限会社', '合同会社', '合資会社', '合名会社',
  '一般社団法人', '一般財団法人', '公益社団法人', '公益財団法人', '特定非営利活動法人', 'npo法人',
  '学校法人', '医療法人', '社会福祉法人', '独立行政法人', '国立大学法人',
].sort((a, b) => b.length - a.length);
// 英字の法人格（Inc、Inc.、Co.,Ltd.、Co.Ltd、Ltd、LLC、Corp、Corporation、K.K.、KK）。
// 社名の途中（「mincing」の中の inc など）を削らないよう、英字以外に挟まれた語のときだけ除く。
const LATIN_CORP = /(^|[^a-z])(?:co\s*\.?\s*,?\s*ltd|corporation|corp|inc|ltd|llc|k\s*\.?\s*k)\s*\.?(?![a-z])/g;

const stripSymbols = (s) => s.replace(/[\s・，．,.()（）「」『』【】\-－ー〜~/／&＆'"”“’‘!！?？:：;；_＿]/g, '');

/** 会社名を突き合わせ用の文字列にする。「株式会社アシスト」「アシスト（株）」が同じ値になる。 */
export function companyKey(name) {
  let s = normalizeText(name);
  for (const w of PAREN_CORPS) s = s.split(w).join('');
  s = s.replace(LATIN_CORP, '$1');
  s = stripSymbols(s);
  for (const w of JP_CORPS) s = s.split(w).join('');
  return s;
}

function bigrams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let hit = 0;
  for (const [g, n] of A) hit += Math.min(n, B.get(g) ?? 0);
  return (2 * hit) / (a.length - 1 + (b.length - 1));
}

const DICE_MIN = 0.6;

/**
 * 既存の会社の中から、`name` と同じ会社らしいものを近い順に返す。
 * 完全一致（key が同じ）→ 片方がもう片方を含む → Dice 係数 0.6 以上。表記まで同じものは除く。
 */
export function similarCompanies(name, companies, { limit = 5 } = {}) {
  const key = companyKey(name);
  if (!key) return [];
  const scored = [];
  (companies ?? []).forEach((x, i) => {
    if (!x || x.company === name) return;
    const k = x.key ?? companyKey(x.company);
    if (!k) return;
    let rank;
    let score = 0;
    if (k === key) rank = 0;
    else if (k.includes(key) || key.includes(k)) rank = 1;
    else {
      score = dice(key, k);
      if (score < DICE_MIN) return;
      rank = 2;
    }
    scored.push({ x, k, rank, score, i });
  });
  scored.sort((a, b) => a.rank - b.rank || b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => ({ ...s.x, key: s.k }));
}

// 一番多い表記。同数なら先に出たもの（Map は挿入順を保つ）
function mostCommon(counts) {
  let best = '';
  let max = 0;
  for (const [v, n] of counts) {
    if (n > max) {
      best = v;
      max = n;
    }
  }
  return best;
}
const bump = (m, v) => m.set(v, (m.get(v) ?? 0) + 1);
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** 名刺を `GET /api/companies` の応答の形（会社 → 部署 → 人）にまとめる。 */
export function groupByCompany(cards, { q, limit = 20 } = {}) {
  const want = q ? companyKey(q) : '';
  const max = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 100);
  const companies = new Map();
  for (const c of cards ?? []) {
    if (!c || c.status !== 'confirmed' || c.deletedAt) continue;
    const company = String(c.company ?? '').trim();
    if (!company) continue;
    const key = companyKey(company);
    if (!key || (want && !key.includes(want))) continue;
    let g = companies.get(key);
    if (!g) companies.set(key, (g = { key, names: new Map(), count: 0, depts: new Map() }));
    g.count += 1;
    bump(g.names, company);
    const dept = String(c.department ?? '').trim();
    const dk = normalizeText(dept);
    let d = g.depts.get(dk);
    if (!d) g.depts.set(dk, (d = { names: new Map(), people: [] }));
    if (dept) bump(d.names, dept);
    d.people.push({ id: c.id, name: String(c.name ?? ''), title: String(c.title ?? '') });
  }
  const items = [...companies.values()].map((g) => ({
    company: mostCommon(g.names),
    key: g.key,
    count: g.count,
    departments: [...g.depts.values()]
      .map((d) => ({ name: mostCommon(d.names), count: d.people.length, people: d.people.sort(byName) }))
      .sort(byName),
  }));
  items.sort((a, b) => b.count - a.count || (a.company < b.company ? -1 : a.company > b.company ? 1 : 0));
  return items.slice(0, max);
}
