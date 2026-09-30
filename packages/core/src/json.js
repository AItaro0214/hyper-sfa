// モデルの応答は「壊れているかもしれない文字列」として扱う（docs/design.md §5.5〜§5.6）。
// 構造化出力を指定しても、前後の説明文、コードブロック、途中切れは起こり得る。
// ここは Gemini を呼ばずに試せる純粋な処理なので、崩れた応答の見本を test/fixtures に集めてテストする。

export class JsonExtractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonExtractError';
    this.code = 'parse';
  }
}

const CLOSER = { '{': '}', '[': ']' };
// 文字列の開始として扱う全角・飾りの引用符。文字列の「外」にあるものだけ半角にする。
const CURLY_QUOTES = '“”„‟＂';

function tryParse(text) {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' ? { value: v } : null;
  } catch {
    return null;
  }
}

/**
 * 最初の `{` から、対応する `}` までを切り出す（3 段目）。
 * 備考に `}` や `{` が書かれていても切れないよう、文字列の中かどうかを 1 文字ずつ見て数える。
 * 正規表現の貪欲一致だと、説明文に `}` が混ざったときに壊れる。
 * @returns {number} 対応する `}` の位置。無ければ -1
 */
function findBalancedEnd(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 4 段目と 5 段目の共通部分。1 文字ずつ読みながら、よくある崩れを直した文字列を作る。
 * 文字列の中身には手を触れず、外側の記号だけを直す（例: 備考の中の `//` や全角の `：` は残す）。
 * 途中で終わっていた場合に備えて、区切り（`,` と開き括弧）の位置とそのときの括弧の積み方を覚えておく。
 */
function repairScan(src) {
  const repairs = new Set();
  const stack = [];
  const cuts = [];
  let out = '';
  let i = 0;
  let expectKey = false;
  let closed = false;
  let inStr = false;
  const n = src.length;

  const readString = (open) => {
    // 半角の " と ' は自分自身でしか閉じない。飾りの引用符は開きと閉じが混ざることがあるので、どれでも閉じる。
    const isCurly = CURLY_QUOTES.includes(open);
    if (open === "'") repairs.add('quotes');
    if (isCurly) repairs.add('fullwidth');
    out += '"';
    inStr = true;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        const next = src[i + 1];
        if (next === undefined) {
          i++; // 途中で切れた。孤立した \ は捨てる
          continue;
        }
        if (next === "'") out += "'";
        else if ('"\\/bfnrtu'.includes(next)) out += '\\' + next;
        else out += '\\\\' + next; // 不正なエスケープは、\ そのものを文字として残す
        i += 2;
        continue;
      }
      const closes = isCurly ? CURLY_QUOTES.includes(c) || c === '"' : c === open;
      if (closes) {
        out += '"';
        i++;
        inStr = false;
        return;
      }
      if (c === '"') out += '\\"'; // ' で開いた文字列の中の "
      else if (c === '\n') {
        out += '\\n';
        repairs.add('newline');
      } else if (c === '\r') {
        if (src[i + 1] !== '\n') {
          out += '\\n';
          repairs.add('newline');
        }
      } else if (c === '\t') out += '\\t';
      else if (c < ' ') out += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      else out += c;
      i++;
    }
  };

  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      out += c;
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      repairs.add('comments');
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      repairs.add('comments');
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === '"' || c === "'" || CURLY_QUOTES.includes(c)) {
      i++;
      readString(c);
    } else if (c === ':' || c === '：') {
      if (c === '：') repairs.add('fullwidth');
      out += ':';
      expectKey = false;
      i++;
    } else if (c === ',' || c === '，') {
      if (c === '，') repairs.add('fullwidth');
      cuts.push({ len: out.length, stack: stack.join('') });
      out += ',';
      expectKey = stack[stack.length - 1] === '{';
      i++;
    } else if (c === '{' || c === '｛' || c === '[' || c === '［') {
      if (c === '｛' || c === '［') repairs.add('fullwidth');
      const open = c === '｛' ? '{' : c === '［' ? '[' : c;
      stack.push(open);
      out += open;
      expectKey = open === '{';
      cuts.push({ len: out.length, stack: stack.join('') });
      i++;
    } else if (c === '}' || c === '｝' || c === ']' || c === '］') {
      if (c === '｝' || c === '］') repairs.add('fullwidth');
      const trimmed = out.replace(/,\s*$/, '');
      if (trimmed.length !== out.length) {
        repairs.add('trailing_comma');
        out = trimmed;
      }
      const top = stack.pop();
      out += top ? CLOSER[top] : c === '｝' ? '}' : c === '］' ? ']' : c;
      i++;
      if (stack.length === 0) {
        closed = true;
        break;
      }
      expectKey = false;
    } else {
      // 引用符の無い語。キーの位置なら引用符で囲み、値の位置（true / null / 数値）ならそのまま
      let j = i;
      while (j < n && !/[\s:：,，\]\}\[\{"'“”„‟＂/]/.test(src[j])) j++;
      if (j === i) {
        out += c; // 単独の / など。読めない文字はそのまま渡して JSON.parse に判断させる
        i++;
        continue;
      }
      const word = src.slice(i, j);
      if (expectKey && stack[stack.length - 1] === '{') {
        out += JSON.stringify(word);
        repairs.add('quotes');
      } else out += word;
      i = j;
    }
  }
  return { out, closed, inStr, stack, cuts, repairs };
}

function closersFor(stackStr) {
  let s = '';
  for (let k = stackStr.length - 1; k >= 0; k--) s += CLOSER[stackStr[k]];
  return s;
}

/**
 * 5 段目。途中で切れた応答の、開いたままの文字列・配列・オブジェクトを閉じる。
 * 「"name": "山田」のように値の途中で切れたものは、読めた分まで残す。
 * キーだけ、または `:` の後で切れたものは閉じても JSON にならないので、直前の区切りまで戻る。
 */
function closeTruncated(scan) {
  let s = scan.out;
  if (scan.inStr) {
    s = s.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
    s += '"';
  }
  s = s.replace(/[\s,]+$/, '');
  const direct = tryParse(s + closersFor(scan.stack.join('')));
  if (direct) return direct.value;
  for (let k = scan.cuts.length - 1; k >= 0; k--) {
    const cut = scan.cuts[k];
    const head = scan.out.slice(0, cut.len).replace(/[\s,]+$/, '');
    const r = tryParse(head + closersFor(cut.stack));
    if (r) return r.value;
  }
  return null;
}

/**
 * 応答の文字列から JSON を取り出す（docs/design.md §5.6 の 5 段階）。取り出せた時点で返す。
 * @returns {{ value: object, repairs: string[], truncated: boolean }}
 */
export function extractJson(text) {
  if (typeof text !== 'string') throw new JsonExtractError('応答が文字列ではありません');
  const repairs = [];
  const add = (name) => {
    if (!repairs.includes(name)) repairs.push(name);
  };
  const done = (value, truncated = false) => ({ value, repairs, truncated });

  // 1. そのまま
  let r = tryParse(text);
  if (r) return done(r.value);

  // 2. 見えない文字（BOM、ゼロ幅の空白）と、前後のコードブロックの記号
  const s = text
    .replace(/[﻿​-‍⁠]/g, '')
    .trim()
    .replace(/^```[\w-]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?[ \t]*```$/, '')
    .trim();
  if (s !== text) {
    add('fence');
    r = tryParse(s);
    if (r) return done(r.value);
  }

  // 3. 最初の { から、対応する } まで
  const start = s.search(/[{\[｛［]/);
  if (start === -1) throw new JsonExtractError('JSON が見つかりません');
  let body = s.slice(start);
  // 前置きの説明文に「{」が混じることがあるので、最初の「{」だけでなく候補を順に試す。
  // 対応する「}」まで切り出せて JSON として読めた最初のものを採る。候補は多くても 20 個まで。
  let braceStart = s.indexOf('{');
  for (let tries = 0; braceStart !== -1 && tries < 20; tries++) {
    const end = findBalancedEnd(s, braceStart);
    if (end === -1) break; // 閉じていない = 途中で切れている。4〜5 段目に回す
    const candidate = s.slice(braceStart, end + 1);
    r = tryParse(candidate);
    if (r) {
      if (candidate !== s) add('slice');
      return done(r.value);
    }
    if (tries === 0) body = candidate;
    braceStart = s.indexOf('{', braceStart + 1);
  }
  if (braceStart === -1 && start > 0) add('slice');
  else if (start > 0) add('slice');

  // 4. よくある崩れを直してから読む
  const scan = repairScan(body);
  if (scan.closed) {
    r = tryParse(scan.out);
    if (r) {
      for (const name of scan.repairs) add(name);
      return done(r.value);
    }
  } else {
    // 5. 途中で切れている
    const value = closeTruncated(scan);
    if (value) {
      for (const name of scan.repairs) add(name);
      add('truncated');
      return done(value, true);
    }
  }
  throw new JsonExtractError('JSON として読めませんでした');
}

// ---- 名刺の形にそろえる ----

const ARRAY_KEYS = ['phones', 'mobiles', 'emails'];
const STRING_KEYS = ['company', 'department', 'name', 'nameReading', 'note', 'rawText'];

// 別名の表。キーは小文字で比べる（大文字小文字は無視）。
const ALIASES = {
  emails: ['email', 'mail', 'e-mail', 'メール', 'メールアドレス'],
  phones: ['phone', 'tel', 'telephone', '電話', '電話番号'],
  mobiles: ['mobile', 'cell', '携帯', '携帯電話', '携帯電話番号'],
  company: ['company_name', 'organization', '会社名', '会社'],
  department: ['dept', '部署', '部署名'],
  name: ['full_name', '氏名', '名前'],
  nameReading: ['name_reading', 'reading', 'kana', 'furigana', 'ふりがな', '読み'],
  note: ['notes', 'remarks', '備考'],
  rawText: ['raw_text', 'text', 'full_text', '全文'],
};
const ALIAS_MAP = new Map();
for (const canonical of [...ARRAY_KEYS, ...STRING_KEYS]) ALIAS_MAP.set(canonical.toLowerCase(), canonical);
for (const [canonical, names] of Object.entries(ALIASES)) {
  for (const nm of names) ALIAS_MAP.set(nm.toLowerCase(), canonical);
}
// 外側が 1 つ多いときの包み。名刺のキーと衝突しない名前だけ
const WRAPPER_KEYS = new Set(['result', 'results', 'data', 'card', 'output', 'response']);

function canonicalKey(key) {
  const k = String(key).trim().toLowerCase();
  return ALIAS_MAP.get(k) ?? ALIAS_MAP.get(k.replace(/[\s-]+/g, '_')) ?? null;
}

function toStringValue(v, key, coerced) {
  if (v == null) {
    if (v === null) coerced.push(`null_to_empty:${key}`);
    return '';
  }
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) {
    coerced.push(`array_to_string:${key}`);
    return v
      .map((x) => (x == null || typeof x === 'object' ? '' : String(x).trim()))
      .filter(Boolean)
      .join(' ');
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    coerced.push(`scalar_to_string:${key}`);
    return String(v);
  }
  return '';
}

function toArrayValue(v, key, coerced) {
  if (v == null) {
    if (v === null) coerced.push(`null_to_empty:${key}`);
    return [];
  }
  if (Array.isArray(v)) {
    return v.flatMap((x) => (x == null || typeof x === 'object' ? [] : [String(x).trim()])).filter(Boolean);
  }
  if (typeof v === 'string' || typeof v === 'number') {
    coerced.push(`string_to_array:${key}`);
    return String(v)
      .split(/[,;/、，；\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * 取り出した JSON を名刺の形にそろえる。知らないキーは捨て、別名は正しいキーに読み替える。
 * どう直したかを `coerced` に残す（モデルやプロンプトごとの崩れの増減を利用状況で見るため）。
 */
export function normalizeCard(value) {
  const coerced = [];
  let v = value;
  // 配列や result で包まれている間、中身を取り出す
  for (let depth = 0; depth < 5; depth++) {
    if (Array.isArray(v)) {
      const first = v.find((x) => x && typeof x === 'object' && !Array.isArray(x));
      coerced.push('unwrap:array');
      v = first ?? {};
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      const hasCardKey = keys.some((k) => canonicalKey(k));
      const wrapper = keys.find((k) => WRAPPER_KEYS.has(k.toLowerCase()) && v[k] && typeof v[k] === 'object');
      if (!hasCardKey && wrapper) {
        coerced.push(`unwrap:${wrapper}`);
        v = v[wrapper];
      } else break;
    } else break;
  }
  const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};

  const card = { company: '', department: '', name: '', nameReading: '', phones: [], mobiles: [], emails: [], note: '', rawText: '' };
  for (const [key, raw] of Object.entries(src)) {
    const canonical = canonicalKey(key);
    if (!canonical) {
      coerced.push(`drop:${key}`);
      continue;
    }
    if (canonical !== key) coerced.push(`alias:${key}->${canonical}`);
    if (ARRAY_KEYS.includes(canonical)) {
      // 別名が重なった場合（tel と phone の両方など）は足し合わせる
      for (const x of toArrayValue(raw, canonical, coerced)) {
        if (!card[canonical].includes(x)) card[canonical].push(x);
      }
    } else {
      const str = toStringValue(raw, canonical, coerced);
      if (str && !card[canonical]) card[canonical] = str;
    }
  }
  card.coerced = coerced;
  return card;
}

/** 名刺の中身がすべて空か（読み取れなかった応答の判定に使う）。 */
export function isEmptyCard(card) {
  if (!card) return true;
  return (
    STRING_KEYS.every((k) => !String(card[k] ?? '').trim()) &&
    ARRAY_KEYS.every((k) => !(Array.isArray(card[k]) && card[k].some((x) => String(x).trim())))
  );
}

// Gemini の構造化出力に渡すスキーマ（docs/design.md §5.3）。キー名は設計書どおり snake_case で、
// 返ってきた後に normalizeCard が camelCase に読み替える。
const str = (description) => ({ type: 'STRING', description });
const strArray = (description) => ({ type: 'ARRAY', items: { type: 'STRING' }, description });

export const CARD_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    company: str('会社名'),
    department: str('部署名'),
    name: str('氏名'),
    phones: strArray('電話番号（固定電話）'),
    mobiles: strArray('携帯電話番号'),
    emails: strArray('メールアドレス'),
    note: str('備考'),
    name_reading: str('氏名の読み（名刺に書かれている場合だけ）'),
    raw_text: str('名刺に書かれている文字の全文'),
  },
  required: ['company', 'department', 'name', 'phones', 'mobiles', 'emails', 'note', 'name_reading', 'raw_text'],
};
