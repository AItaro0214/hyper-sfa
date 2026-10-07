// 議事録への質問（docs/minutes-design.md §16、docs/core-api.md §15）。
// 渡すのは文字起こしと資料の全文（pptx / xlsx。PDF は名前だけ）だけ。議事録（要約）は、その解釈に答えが引きずられないよう渡さない。
import { formatMaterialsFullText } from './materials.js';

const pad = (n) => String(n).padStart(2, '0');

// 日時は JST の「YYYY-MM-DD HH:MM」。バックエンドの buildVars と同じ見え方にする
function jstText(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
}

/**
 * renderPrompt(DEFAULT_PROMPTS.qa, ...) に渡す差し込み値。
 * minute は { title, heldAt | held_at, counterparts: [{company, department, name}], attendees: [string | {name}], memo }。
 */
export function buildQaContext({ transcript, materials, minute } = {}) {
  const m = minute ?? {};
  const counterparts = (m.counterparts ?? [])
    .map((c) => [c.company, c.department, c.name].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('、');
  const attendees = (m.attendees ?? []).map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean).join('、');
  return {
    TITLE: m.title || '',
    DATE: jstText(m.heldAt ?? m.held_at),
    COUNTERPARTS: counterparts,
    ATTENDEES: attendees,
    MEMO: m.memo || '',
    MATERIALS: (materials ?? []).length ? formatMaterialsFullText(materials, { pdfAttached: false }) : '（資料なし）',
    TRANSCRIPT: transcript ?? '',
  };
}

/**
 * モデルに渡す直近のやり取り。最後の max 件（既定 20 件 = 10 往復）。
 * 先頭が assistant になると Gemini が受け付けないので、user から始まるまで先頭を落とす。
 */
export function trimTurns(turns, max = 20) {
  let out = (turns ?? []).slice(-Math.max(0, max));
  while (out.length && out[0].role !== 'user') out = out.slice(1);
  return out;
}
