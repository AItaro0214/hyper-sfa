// pptx / xlsx から、文字とグラフの元データを JSON に抜く（minutes-design §15.3）。
// サーバーでファイルを変換しない方針なので、ここで全部やる。XML は名前空間の接頭辞が
// ファイルによって違うことがあるため、必ず localName で探す。
import { readZip } from './zip.js';

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 500;
const MAX_COLS = 50;

export class UnsupportedMaterialError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedMaterialError'; }
}

export function materialKind(name) {
  const ext = (String(name).match(/\.([^.]+)$/) || [])[1];
  const e = (ext || '').toLowerCase();
  if (e === 'pdf' || e === 'pptx' || e === 'xlsx') return e;
  if (e === 'ppt' || e === 'xls' || e === 'doc' || e === 'docx') {
    throw new UnsupportedMaterialError('古い形式（.ppt / .xls）や Word は読めません。PowerPoint / Excel で .pptx / .xlsx に保存し直すか、PDF に書き出して添付してください。');
  }
  throw new UnsupportedMaterialError('添付できるのは PDF / pptx / xlsx です。');
}

export async function extractMaterial(file) {
  const kind = materialKind(file.name);
  const buf = await file.arrayBuffer();
  if (kind === 'pdf') return pdfInfo(buf);
  // 画像や動画は読まないので展開しない（20MB の pptx でも速く済ませるため）
  const zip = await readZip(buf, { filter: (n) => /\.(xml|rels)$/i.test(n) });
  return limitSize(kind === 'pptx' ? extractPptx(zip) : extractXlsx(zip));
}

// ---- 共通 ----
const dec = new TextDecoder('utf-8');
function parseXml(zip, path) {
  const bytes = zip.get(path);
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(dec.decode(bytes), 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}
const all = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const kids = (node) => Array.from(node.children);
const named = (node, name) => kids(node).find((c) => c.localName === name) || null;
const relId = (el) => el.getAttributeNS(R_NS, 'id') || el.getAttribute('r:id') || '';

// 'ppt/slides/slide1.xml' + '../charts/chart1.xml' → 'ppt/charts/chart1.xml'
function resolvePath(baseFile, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseFile.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop(); else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}
function readRels(zip, partPath) {
  const i = partPath.lastIndexOf('/');
  const relPath = `${partPath.slice(0, i + 1)}_rels/${partPath.slice(i + 1)}.rels`;
  const doc = parseXml(zip, relPath);
  if (!doc) return [];
  return all(doc, 'Relationship')
    .filter((r) => r.getAttribute('TargetMode') !== 'External')
    .map((r) => ({ id: r.getAttribute('Id'), type: r.getAttribute('Type') || '', target: resolvePath(partPath, r.getAttribute('Target') || '') }));
}
const relType = (r, t) => r.type.endsWith(`/${t}`);

// 段落（a:p）の文字。a:br は改行、a:t はそのまま。
function paragraphText(p) {
  let s = '';
  (function walk(n) {
    for (const c of kids(n)) {
      if (c.localName === 't') s += c.textContent;
      else if (c.localName === 'br') s += '\n';
      else walk(c);
    }
  })(p);
  return s;
}
const textOfParas = (root) => all(root, 'p').map(paragraphText);

// ---- グラフ（pptx / xlsx 共通）----
const CHART_TYPES = { bar: 'bar', bar3D: 'bar', line: 'line', line3D: 'line', stock: 'line', pie: 'pie', pie3D: 'pie', ofPie: 'pie', area: 'area', area3D: 'area', scatter: 'scatter', doughnut: 'doughnut' };

// キャッシュ（c:strCache / c:numCache）の c:pt を、idx の位置に並べて配列にする
function cachePoints(el, numeric) {
  if (!el) return [];
  const scope = all(el, 'lvl')[0] || el; // 多段の項目は最初の段（一番下の階層）だけ使う
  const out = [];
  for (const pt of all(scope, 'pt')) {
    const i = Number(pt.getAttribute('idx'));
    const v = (named(pt, 'v') || {}).textContent;
    if (!Number.isInteger(i) || i < 0 || i > 100000) continue;
    out[i] = numeric ? (v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v)) : (v ?? '');
  }
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = numeric ? null : '';
  return out;
}

function parseChart(doc) {
  const chart = all(doc, 'chart')[0];
  if (!chart) return null;
  const plotArea = named(chart, 'plotArea');
  const plots = plotArea ? kids(plotArea).filter((c) => /Chart$/.test(c.localName)) : [];
  const first = plots[0];
  const type = first ? (CHART_TYPES[first.localName.replace(/Chart$/, '')] || 'other') : 'other';
  const titleEl = named(chart, 'title'); // 軸のタイトルではなく、グラフ直下のもの
  const title = titleEl ? textOfParas(titleEl).join('').trim() : '';
  let categories = [];
  let catRef = '';
  const series = [];
  // c:f（セル参照の式）。キャッシュが無いファイル（プログラムで作った xlsx など）では、
  // 後でシートの値から引けるように参照を残しておく
  const formulaOf = (el) => (el && (all(el, 'f')[0] || {}).textContent) || '';
  for (const plot of plots) {
    for (const ser of kids(plot).filter((c) => c.localName === 'ser')) {
      const tx = named(ser, 'tx');
      const name = tx ? ((all(tx, 'v')[0] || {}).textContent || '') : '';
      const catEl = named(ser, 'cat') || named(ser, 'xVal');
      const valEl = named(ser, 'val') || named(ser, 'yVal');
      if (!categories.length && catEl) {
        categories = cachePoints(all(catEl, 'strCache')[0] || all(catEl, 'multiLvlStrCache')[0] || all(catEl, 'numCache')[0], false);
        if (!catRef) catRef = formulaOf(catEl);
      }
      series.push({ name, values: cachePoints(valEl && all(valEl, 'numCache')[0], true), nameRef: formulaOf(tx), valRef: formulaOf(valEl) });
    }
  }
  return { type, title, categories, series, catRef };
}

// 'シート名'!$B$2:$B$4 のような参照を、読み込んだシートの値に解決する。範囲は行優先で 1 列に並べる
function cellsByRef(sheetsByName, formula) {
  const m = /^(?:'((?:[^']|'')*)'|([^!]+))!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(String(formula || '').trim());
  if (!m) return null;
  const sheet = sheetsByName.get((m[1] ?? m[2] ?? '').replace(/''/g, "'"));
  if (!sheet) return null;
  const c1 = colIndex(m[3] + '1'); const r1 = Number(m[4]) - 1;
  const c2 = m[5] ? colIndex(m[5] + '1') : c1; const r2 = m[6] ? Number(m[6]) - 1 : r1;
  const out = [];
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) out.push((sheet.rows[r] || [])[c] ?? '');
  }
  return out;
}

// キャッシュが空だったグラフの項目・系列名・値を、セル参照からシートの値で埋める（xlsx だけ）
function fillChartsFromSheets(sheets) {
  const byName = new Map(sheets.map((s) => [s.name, s]));
  for (const sh of sheets) {
    for (const ch of sh.charts) {
      if (!ch.categories.length && ch.catRef) ch.categories = (cellsByRef(byName, ch.catRef) || []).map((v) => String(v));
      for (const se of ch.series) {
        if (!se.name && se.nameRef) se.name = String((cellsByRef(byName, se.nameRef) || [''])[0] ?? '');
        if (!se.values.length && se.valRef) se.values = (cellsByRef(byName, se.valRef) || []).map((v) => (v === '' || isNaN(Number(v)) ? null : Number(v)));
        delete se.nameRef; delete se.valRef;
      }
      delete ch.catRef;
    }
  }
}

// pptx のグラフには参照の解決先が無いので、参照の情報だけ落とす
function stripChartRefs(charts) {
  for (const ch of charts) {
    delete ch.catRef;
    for (const se of ch.series) { delete se.nameRef; delete se.valRef; }
  }
  return charts;
}

function chartsFromRels(zip, rels, partDoc) {
  // 部品の中に出てくる順（r:id）に並べる。見つからなければ rels の順
  const order = partDoc ? all(partDoc, 'chart').map(relId).filter(Boolean) : [];
  const byId = new Map(rels.filter((r) => relType(r, 'chart')).map((r) => [r.id, r]));
  const list = order.length ? order.map((id) => byId.get(id)).filter(Boolean) : Array.from(byId.values());
  const out = [];
  for (const r of list) {
    const doc = parseXml(zip, r.target);
    const c = doc && parseChart(doc);
    if (c) out.push(c);
  }
  return out;
}

// ---- pptx ----
function phType(sp) {
  const nv = named(sp, 'nvSpPr');
  const nvPr = nv && named(nv, 'nvPr');
  const ph = nvPr && named(nvPr, 'ph');
  return ph ? (ph.getAttribute('type') || 'body') : null;
}
const shapeParas = (sp) => { const tb = named(sp, 'txBody'); return tb ? kids(tb).filter((c) => c.localName === 'p').map(paragraphText) : []; };

// 図形をグループの中まで順に辿る。表は行ごとに「セル | セル」の 1 行にする。
function collectSlide(root) {
  const res = { title: '', paras: [] };
  (function walk(node) {
    for (const c of kids(node)) {
      switch (c.localName) {
        case 'sp': {
          const t = phType(c);
          const paras = shapeParas(c);
          if (t === 'title' || t === 'ctrTitle') { if (!res.title) res.title = paras.join(' ').trim(); } else if (t !== 'sldNum' && t !== 'dt' && t !== 'ftr') res.paras.push(...paras);
          break;
        }
        case 'grpSp': case 'spTree': walk(c); break;
        case 'AlternateContent': { const ch = named(c, 'Choice') || named(c, 'Fallback'); if (ch) walk(ch); break; }
        case 'graphicFrame': {
          for (const tr of all(c, 'tr')) {
            const cells = all(tr, 'tc').map((tc) => textOfParas(tc).join(' ').trim());
            if (cells.some(Boolean)) res.paras.push(cells.join(' | '));
          }
          break;
        }
        default: break;
      }
    }
  })(root);
  return res;
}

function extractPptx(zip) {
  const pres = parseXml(zip, 'ppt/presentation.xml');
  if (!pres) throw new UnsupportedMaterialError('pptx として読めませんでした。');
  const presRels = new Map(readRels(zip, 'ppt/presentation.xml').map((r) => [r.id, r.target]));
  const slidePaths = all(pres, 'sldId').map((s) => presRels.get(relId(s))).filter(Boolean);
  const slides = slidePaths.map((path, i) => {
    const doc = parseXml(zip, path);
    const rels = readRels(zip, path);
    const spTree = doc && all(doc, 'spTree')[0];
    const got = spTree ? collectSlide(spTree) : { title: '', paras: [] };
    // SmartArt の文字は図形ではなく別の部品に入っている
    for (const r of rels.filter((x) => relType(x, 'diagramData'))) {
      const d = parseXml(zip, r.target);
      if (d) got.paras.push(...textOfParas(d).filter(Boolean));
    }
    let notes = '';
    const nr = rels.find((r) => relType(r, 'notesSlide'));
    const nd = nr && parseXml(zip, nr.target);
    if (nd) {
      const body = all(nd, 'sp').filter((sp) => phType(sp) === 'body');
      notes = body.flatMap(shapeParas).join('\n').trim();
    }
    return { no: i + 1, title: got.title, text: got.paras.join('\n').trim(), notes, charts: doc ? stripChartRefs(chartsFromRels(zip, rels, doc)) : [] };
  });
  return { kind: 'pptx', slides };
}

// ---- xlsx ----
const colIndex = (ref) => {
  const m = /^([A-Za-z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function extractXlsx(zip) {
  const wb = parseXml(zip, 'xl/workbook.xml');
  if (!wb) throw new UnsupportedMaterialError('xlsx として読めませんでした。');
  const wbRels = new Map(readRels(zip, 'xl/workbook.xml').map((r) => [r.id, r.target]));
  const sst = parseXml(zip, 'xl/sharedStrings.xml');
  const shared = sst ? all(sst, 'si').map((si) => {
    // ふりがな（rPh）は本文ではないので飛ばす
    let s = '';
    (function walk(n) { for (const c of kids(n)) { if (c.localName === 't') s += c.textContent; else if (c.localName !== 'rPh') walk(c); } })(si);
    return s;
  }) : [];

  const sheets = [];
  for (const sh of all(wb, 'sheet')) {
    const path = wbRels.get(relId(sh));
    const doc = path && parseXml(zip, path);
    if (!doc || !/worksheets\//.test(path)) continue; // グラフシートなどは対象外
    const rows = [];
    let truncated = false;
    for (const row of all(doc, 'row')) {
      const rIdx = Number(row.getAttribute('r')) - 1;
      if (!(rIdx >= 0)) continue;
      if (rIdx >= MAX_ROWS) { truncated = true; continue; }
      const out = rows[rIdx] || (rows[rIdx] = []);
      for (const c of kids(row).filter((x) => x.localName === 'c')) {
        const ci = colIndex(c.getAttribute('r'));
        if (ci < 0) continue;
        if (ci >= MAX_COLS) { truncated = true; continue; }
        const t = c.getAttribute('t');
        const v = named(c, 'v');
        let val = '';
        if (t === 's') val = v ? (shared[Number(v.textContent)] ?? '') : '';
        else if (t === 'inlineStr') { const is = named(c, 'is'); val = is ? all(is, 't').map((x) => x.textContent).join('') : ''; } else if (v) {
          if (t === 'b') val = v.textContent === '1';
          else if (t === 'str' || t === 'e') val = v.textContent;
          else { const num = Number(v.textContent); val = isNaN(num) ? v.textContent : num; }
        }
        if (val === '') continue;
        for (let k = out.length; k < ci; k++) out[k] = '';
        out[ci] = val;
      }
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();

    // シート → 描画（drawing）→ グラフ
    const charts = [];
    for (const dr of readRels(zip, path).filter((r) => relType(r, 'drawing'))) {
      const dd = parseXml(zip, dr.target);
      charts.push(...chartsFromRels(zip, readRels(zip, dr.target), dd));
    }
    sheets.push({ name: sh.getAttribute('name') || '', rows, truncated, charts });
  }
  fillChartsFromSheets(sheets);
  return { kind: 'xlsx', sheets };
}

// ---- PDF ----
// 中身は読まない（モデルが直接読む）。ページ数だけ、/Type /Page の数から推定する。
// PDF 1.5 以降で目次が圧縮されていると数えられないので、0 のときは省く。
function pdfInfo(buf) {
  const text = new TextDecoder('latin1').decode(new Uint8Array(buf));
  const n = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  return n > 0 ? { kind: 'pdf', pages: n } : { kind: 'pdf' };
}

// ---- 2MB の上限 ----
const byteLen = (o) => new TextEncoder().encode(JSON.stringify(o)).length;
const cut = (s, n) => (s.length > n ? s.slice(0, n) : s);

// 超えたら、本文を段階的に短くする。順番や名前は残す（対応付けの手がかりになるため）。
function limitSize(data) {
  if (byteLen(data) <= MAX_JSON_BYTES) return data;
  data.truncated = true;
  for (const lim of [4000, 2000, 1000, 500, 200, 50]) {
    const keep = Math.max(20, Math.floor(lim / 10));
    if (data.kind === 'pptx') {
      for (const s of data.slides) {
        s.text = cut(s.text, lim); s.notes = cut(s.notes, lim);
        for (const c of s.charts) for (const se of c.series) se.values = se.values.slice(0, keep);
      }
    } else {
      const maxRows = Math.max(5, Math.floor(lim / 8));
      for (const sh of data.sheets) {
        if (sh.rows.length > maxRows) { sh.rows = sh.rows.slice(0, maxRows); sh.truncated = true; }
        for (const c of sh.charts) for (const se of c.series) se.values = se.values.slice(0, keep);
      }
    }
    if (byteLen(data) <= MAX_JSON_BYTES) break;
  }
  return data;
}
