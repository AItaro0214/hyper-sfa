// CSV の出力と読み込み（docs/design.md §10、docs/minutes-design.md §7.2）。

const DANGEROUS = /^[=+\-@\t\r]/;

/** 配列は ';' でつなぐ（電話番号、メールアドレス、担当部署）。 */
function cellText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (x == null ? '' : String(x))).join(';');
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * 数式として実行されないようにする。名前や備考は外から来た値なので、`=` `+` `-` `@` `\t` `\r` で始まる値は
 * 先頭に ' を付ける。電話番号（+81 など）は ' が付くと見た目が悪いので、phone 列だけは
 * ="+81..." の形（文字列を返す数式）にする。どちらも Excel で実行されない。
 */
function guard(text, isString, type) {
  if (!isString || !text || !DANGEROUS.test(text)) return text;
  if (type === 'phone') return `="${text.replace(/"/g, '""')}"`;
  return `'${text}`;
}

const quote = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * BOM 付き UTF-8、CRLF。Excel でそのまま開ける。
 * @param {object[]} rows
 * @param {Array<{ key: string, label: string, type?: 'phone' }>} columns
 */
export function buildCsv(rows, columns) {
  const lines = [columns.map((c) => quote(c.label)).join(',')];
  for (const row of rows ?? []) {
    lines.push(
      columns
        .map((c) => {
          const v = row?.[c.key];
          const text = cellText(v);
          return quote(guard(text, typeof v === 'string' || Array.isArray(v), c.type));
        })
        .join(','),
    );
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * カンマとタブを自動判定して読む。引用符と、引用符の中の改行に対応。
 * 判定は 1 行目（引用符の外）の数で行う。
 */
export function parseCsv(text) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  let inQ = false;
  let commas = 0;
  let tabs = 0;
  for (const c of s) {
    if (c === '"') inQ = !inQ;
    else if (!inQ) {
      if (c === '\n' || c === '\r') break;
      if (c === ',') commas++;
      else if (c === '\t') tabs++;
    }
  }
  const delim = tabs > commas ? '\t' : ',';

  const rows = [];
  let row = [];
  let cell = '';
  inQ = false;
  let touched = false; // その行に何か書かれているか（空行を捨てるため）
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (touched || row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    touched = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"') {
      inQ = true;
      touched = true;
    } else if (c === delim) {
      endCell();
      touched = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      endRow();
    } else cell += c;
  }
  if (cell !== '' || row.length > 0 || touched) endRow();
  return rows;
}

/**
 * ArrayBuffer を文字列にする。UTF-8（BOM の有無）と Shift_JIS を見分ける。
 * Excel が保存した CSV は Shift_JIS のことが多いため。UTF-8 として読めなければ Shift_JIS とみなす。
 */
export function detectAndDecode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

// ---- 列の定義 ----

export const CARD_CSV_COLUMNS = Object.freeze([
  { key: 'company', label: '会社名' },
  { key: 'department', label: '部署名' },
  { key: 'name', label: '氏名' },
  { key: 'nameReading', label: '氏名の読み' },
  { key: 'phones', label: '電話番号', type: 'phone' },
  { key: 'mobiles', label: '携帯電話番号', type: 'phone' },
  { key: 'emails', label: 'メールアドレス' },
  { key: 'note', label: '備考' },
  { key: 'deptNames', label: '担当部署' },
  { key: 'createdByName', label: '登録者' },
  { key: 'createdByDepts', label: '登録者の部署' },
  { key: 'createdByPosition', label: '登録者の役職' },
  { key: 'createdAt', label: '登録日時' },
  { key: 'updatedByName', label: '最終編集者' },
  { key: 'updatedAt', label: '最終編集日時' },
  { key: 'editCount', label: '編集回数' },
  { key: 'editHistory', label: '編集履歴' },
  { key: 'scanCount', label: '読み取り回数' },
  { key: 'scanModel', label: '読み取りに使ったモデル' },
  { key: 'status', label: '状態' },
  { key: 'id', label: '名刺ID' },
]);

export const HISTORY_CSV_COLUMNS = Object.freeze([
  { key: 'at', label: '日時' },
  { key: 'typeLabel', label: '種類' },
  { key: 'actorName', label: '操作した人' },
  { key: 'actorDept', label: '操作した人の部署' },
  { key: 'sourceLabel', label: '編集した画面' },
  { key: 'cardId', label: '名刺ID' },
  { key: 'company', label: '会社名' },
  { key: 'name', label: '氏名' },
  { key: 'fieldLabel', label: '変更した項目' },
  { key: 'before', label: '変更前' },
  { key: 'after', label: '変更後' },
]);

export const MINUTES_USAGE_CSV_COLUMNS = Object.freeze([
  { key: 'userName', label: '氏名' },
  { key: 'departments', label: '部署' },
  { key: 'status', label: '状態' },
  { key: 'recordings', label: '録音本数' },
  { key: 'recordedSec', label: '録音時間（秒）' },
  { key: 'transcribeFirst', label: '文字起こし（初回）' },
  { key: 'transcribeRetry', label: '文字起こし（やり直し）' },
  { key: 'summarizeFirst', label: '議事録の作成（初回）' },
  { key: 'summarizeRetry', label: '議事録の作成（作り直し）' },
  { key: 'failed', label: '失敗' },
  { key: 'transcribedSec', label: '文字起こしした音声（秒）' },
  { key: 'inputTokens', label: '入力トークン数' },
  { key: 'outputTokens', label: '出力トークン数' },
  { key: 'cost', label: '概算費用（USD）' },
  { key: 'lastUsedAt', label: '最後に使った日' },
]);

const FIELD_LABELS = {
  company: '会社名',
  department: '部署名',
  name: '氏名',
  nameReading: '氏名の読み',
  phones: '電話番号',
  mobiles: '携帯電話番号',
  emails: 'メールアドレス',
  note: '備考',
  deptIds: '担当部署',
};
const TYPE_LABELS = { create: '登録', edit: '編集', rescan: '読み取り直し', delete: '削除', restore: '復元' };
const SOURCE_LABELS = { review: '確認画面', search: '検索画面', detail: '詳細画面' };

const names = (list) => (list ?? []).map((d) => (typeof d === 'string' ? d : d?.name)).filter(Boolean);

/** 履歴の 1 件を、編集履歴の 1 セル用の文字列にする。 */
function editHistoryCell(events) {
  return (events ?? [])
    .map((e) => {
      const fields = (e.changes ?? []).map((c) => FIELD_LABELS[c.field] ?? c.field).join(', ');
      return `${String(e.at ?? '').slice(0, 16).replace('T', ' ')} ${e.actor?.name ?? ''}: ${fields}`;
    })
    .join(' / ');
}

/** 名刺（API の形。docs/api-contract.md §4）を CSV の 1 行にする。 */
export function cardToCsvRow(card, extra = {}) {
  const c = card ?? {};
  return {
    company: c.company,
    department: c.department,
    name: c.name,
    nameReading: c.nameReading,
    phones: c.phones,
    mobiles: c.mobiles,
    emails: c.emails,
    note: c.note,
    deptNames: names(c.departments),
    createdByName: c.createdBy?.name ?? c.createdByName,
    createdByDepts: extra.createdByDepts ?? c.createdByDepts,
    createdByPosition: extra.createdByPosition ?? c.createdByPosition,
    createdAt: c.createdAt,
    updatedByName: c.updatedBy?.name ?? c.updatedByName,
    updatedAt: c.updatedAt,
    editCount: c.editCount ?? 0,
    editHistory: extra.editEvents ? editHistoryCell(extra.editEvents) : c.editHistory,
    scanCount: c.scanCount ?? 0,
    scanModel: c.scanModel ?? c.extraction?.model,
    status: c.status,
    id: c.id,
  };
}

const historyText = (v) => (Array.isArray(v) ? v.join(';') : v == null ? '' : String(v));

/** 履歴 1 件を CSV の行にする。項目ごとの変更が 2 つなら 2 行。変更が無い（登録、削除など）は 1 行。 */
export function historyToCsvRows(event) {
  const e = event ?? {};
  const base = {
    at: e.at,
    typeLabel: TYPE_LABELS[e.type] ?? e.type,
    actorName: e.actor?.name,
    actorDept: e.actor?.deptName,
    sourceLabel: SOURCE_LABELS[e.source] ?? e.source ?? '',
    cardId: e.card?.id,
    company: e.card?.company,
    name: e.card?.name,
  };
  const changes = e.changes ?? [];
  if (changes.length === 0) return [{ ...base, fieldLabel: '', before: '', after: '' }];
  return changes.map((c) => ({
    ...base,
    fieldLabel: FIELD_LABELS[c.field] ?? c.field,
    before: historyText(c.before),
    after: historyText(c.after),
  }));
}

/** 利用状況（docs/api-contract.md §6 の usage/minutes の 1 行）を CSV の行にする。 */
export function minutesUsageToCsvRow(item) {
  const i = item ?? {};
  return {
    userName: i.user?.name,
    departments: names(i.user?.departments),
    status: i.user?.status,
    recordings: i.recordings ?? 0,
    recordedSec: i.recordedSec ?? 0,
    transcribeFirst: i.transcribe?.first ?? 0,
    transcribeRetry: i.transcribe?.retry ?? 0,
    summarizeFirst: i.summarize?.first ?? 0,
    summarizeRetry: i.summarize?.retry ?? 0,
    failed: i.failed ?? 0,
    transcribedSec: i.transcribedSec ?? 0,
    inputTokens: i.inputTokens ?? 0,
    outputTokens: i.outputTokens ?? 0,
    cost: typeof i.cost === 'number' ? i.cost.toFixed(4) : i.cost,
    lastUsedAt: i.lastUsedAt,
  };
}
