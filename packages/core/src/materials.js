// 会議の資料（PDF / pptx / xlsx）まわりの純粋なロジック（docs/core-api.md §13、docs/minutes-design.md §15）。
// pptx / xlsx の目次はモデルを使わず機械的に作る。モデルに任せると数値を丸めたり落としたりするため。

export const MATERIAL_LIMITS = Object.freeze({
  maxFiles: 5,
  maxBytes: 20 * 1024 * 1024,
  maxExtractBytes: 2 * 1024 * 1024,
  kinds: Object.freeze(['pdf', 'pptx', 'xlsx']),
});

/** 拡張子 → 種類。.ppt / .xls などの古い形式は対象外なので null。 */
export function materialKindOf(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename ?? '').trim());
  const ext = m ? m[1].toLowerCase() : '';
  return MATERIAL_LIMITS.kinds.includes(ext) ? ext : null;
}

// type は小文字で書く。Gemini に渡すときは gemini.js の toGeminiSchema が大文字にする
export const OUTLINE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          title: { type: 'string' },
          summary: { type: 'string' },
          figures: { type: 'array', items: { type: 'string' } },
          keywords: { type: 'array', items: { type: 'string' } },
        },
        required: ['page', 'title', 'summary', 'figures', 'keywords'],
      },
    },
  },
  required: ['sections'],
});

export const MATERIAL_SUMMARY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    mapping: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          material: { type: 'integer' },
          page: { type: 'integer' },
          start: { type: 'string' },
          end: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['material', 'page', 'start', 'end', 'confidence'],
      },
    },
    markdown: { type: 'string' },
  },
  required: ['mapping', 'markdown'],
});

// ---- 目次 ----

const SUMMARY_MAX = 600;
const KEYWORDS_MAX = 10;
const XLSX_SUMMARY_ROWS = 30;

const CHART_LABELS = [
  ['bar', '棒グラフ'], ['column', '棒グラフ'], ['line', '折れ線グラフ'], ['pie', '円グラフ'], ['doughnut', 'ドーナツグラフ'],
  ['area', '面グラフ'], ['scatter', '散布図'], ['radar', 'レーダーチャート'], ['bubble', 'バブルチャート'],
];

function chartLabel(type) {
  const t = String(type ?? '').toLowerCase();
  for (const [k, label] of CHART_LABELS) if (t.includes(k)) return label;
  return 'グラフ';
}

/** グラフ → 「棒グラフ「売上」: 系列「2025」 関東 120 / 関西 95 / 九州 40」。系列が複数なら「; 」でつなぐ。 */
function chartToString(chart) {
  const head = chartLabel(chart?.type) + (chart?.title ? `「${chart.title}」` : '');
  const cats = Array.isArray(chart?.categories) ? chart.categories : [];
  const series = (Array.isArray(chart?.series) ? chart.series : []).map((s) => {
    const values = Array.isArray(s?.values) ? s.values : [];
    const n = Math.max(cats.length, values.length);
    const cells = [];
    for (let i = 0; i < n; i++) {
      const v = values[i] ?? '';
      cells.push(cats[i] != null && cats[i] !== '' ? `${cats[i]} ${v}` : String(v));
    }
    return `系列「${s?.name ?? ''}」 ${cells.join(' / ')}`;
  });
  return series.length ? `${head}: ${series.join('; ')}` : head;
}

/** 固有名詞らしい語: カタカナ語、英数字の語（英字を含むもの）、「株式会社」を含む語。出てきた順で重複なし。 */
function extractKeywords(text) {
  const re = /株式会社[^\s、。,，．.「」()（）]{1,20}|[^\s、。,，．.「」()（）]{1,20}株式会社|[ァ-ヶー]{3,}|[A-Za-z0-9][A-Za-z0-9._-]*/g;
  const out = [];
  for (const m of String(text ?? '').matchAll(re)) {
    const w = m[0].replace(/[._-]+$/, '');
    // 数字だけ・1 文字の英数字は固有名詞ではない
    if (/^[A-Za-z0-9]+$/.test(w) && (!/[A-Za-z]/.test(w) || w.length < 2)) continue;
    if (!out.includes(w)) out.push(w);
    if (out.length >= KEYWORDS_MAX) break;
  }
  return out;
}

const cell = (v) => (v == null ? '' : String(v).replace(/[\t\r\n]+/g, ' '));

/**
 * pptx / xlsx の抜いた JSON → 目次 `{ sections }`。
 * @returns {{ sections: Array<{page:number,title:string,summary:string,figures:string[],keywords:string[]}> }}
 */
export function outlineFromExtract(extract, { name } = {}) {
  void name;
  if (extract?.kind === 'pptx') {
    const sections = (extract.slides ?? []).map((s, i) => {
      const body = [s?.text, s?.notes].map((x) => String(x ?? '').trim()).filter(Boolean).join('\n');
      return {
        page: Number.isInteger(s?.no) ? s.no : i + 1,
        title: String(s?.title ?? '').trim() || `スライド ${i + 1}`,
        summary: body.slice(0, SUMMARY_MAX),
        figures: (s?.charts ?? []).map(chartToString),
        keywords: extractKeywords(body),
      };
    });
    return { sections };
  }
  if (extract?.kind === 'xlsx') {
    const sections = (extract.sheets ?? []).map((sh, i) => {
      const rows = (sh?.rows ?? []).slice(0, XLSX_SUMMARY_ROWS).map((r) => (Array.isArray(r) ? r : []).map(cell).join('\t'));
      return {
        page: i + 1,
        title: String(sh?.name ?? '').trim() || `シート ${i + 1}`,
        summary: rows.join('\n'),
        figures: (sh?.charts ?? []).map(chartToString),
        keywords: [],
      };
    });
    return { sections };
  }
  return { sections: [] };
}

// ---- プロンプトへの差し込み ----

const MATERIAL_TEXT_MAX = 30000;
const UNIT = { pdf: 'ページ', pptx: 'スライド', xlsx: 'シート' };

/** {{MATERIALS}} に差し込む文字列。1 資料 3 万字で切る（2 時間の文字起こしと一緒に 1 回で渡すため）。 */
export function formatMaterialsForPrompt(materials) {
  const blocks = (materials ?? []).map((m) => {
    const unit = UNIT[m.kind] ?? 'ページ';
    const lines = [`資料 ${m.seq}: ${m.name}`];
    const sections = m.outline?.sections ?? [];
    if (!sections.length) lines.push('  （目次なし）');
    for (const s of sections) {
      lines.push(`  ${unit} ${s.page}${s.title ? `「${s.title}」` : ''}`);
      if (s.summary) lines.push(...String(s.summary).split('\n').map((l) => `    ${l}`));
      for (const f of s.figures ?? []) lines.push(`    図: ${f}`);
      if (s.keywords?.length) lines.push(`    キーワード: ${s.keywords.join('、')}`);
    }
    const text = lines.join('\n');
    return text.length > MATERIAL_TEXT_MAX ? `${text.slice(0, MATERIAL_TEXT_MAX)}\n  …（長いので以降は省略）` : text;
  });
  return blocks.join('\n\n');
}

// ---- 対応表 ----

/** 「HH:MM:SS」「MM:SS」「秒数」→ 秒。読めなければ null。 */
function toSeconds(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  const s = String(v ?? '').trim().replace(/[.,]\d+$/, '');
  if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return null;
  const p = s.split(':').map(Number);
  while (p.length < 3) p.unshift(0); // MM:SS には 00: を補う
  return p[0] * 3600 + p[1] * 60 + p[2];
}

const pad = (n) => String(n).padStart(2, '0');
const hhmmss = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;

/**
 * モデルの出力の対応表を整える。読めない行（資料番号が無い、時刻が読めない）は捨てる。
 * materials を渡したときは、その seq に無い資料番号も捨てる。
 */
export function normalizeMapping(mapping, materials) {
  const seqs = Array.isArray(materials) ? new Set(materials.map((m) => Number(m.seq))) : null;
  const out = [];
  for (const r of Array.isArray(mapping) ? mapping : []) {
    const material = parseInt(r?.material, 10);
    const page = parseInt(r?.page, 10);
    let start = toSeconds(r?.start);
    let end = toSeconds(r?.end);
    if (!Number.isInteger(material) || !Number.isInteger(page) || start == null || end == null) continue;
    if (seqs && !seqs.has(material)) continue;
    if (start > end) [start, end] = [end, start];
    const c = String(r?.confidence ?? '').toLowerCase();
    out.push({ material, page, start: hhmmss(start), end: hhmmss(end), confidence: ['high', 'medium', 'low'].includes(c) ? c : 'medium' });
  }
  return out;
}
