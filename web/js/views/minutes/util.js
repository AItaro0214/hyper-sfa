// 議事録の画面で共有する小さな部品。
// モーダルと確認は ui.js の openModal / confirmDialog の引数に依存しないよう、ここで持っている。
import { esc } from '../../ui.js';

export { esc };

export const STATUS_LABEL = {
  recording: '録音中',
  uploaded: '作成待ち',
  queued: '順番待ち',
  transcribing: '文字起こし中',
  summarizing: '議事録を作成中',
  outlining: '資料を踏まえて作成中', // 古い版の状態。いまは使わない
  done: '完了',
  failed: '失敗',
};

export function isProcessing(status) {
  return status === 'queued' || status === 'transcribing' || status === 'outlining' || status === 'summarizing';
}

export function statusText(m) {
  let base = STATUS_LABEL[m.status] || m.status;
  // 資料つきの作り直し（資料をそのまま渡して 1 回で作る）。契約に step の名前が無いので、値を広めに見る
  const step = (m.progress && m.progress.step) || m.step || '';
  if (m.status === 'summarizing' || m.status === 'outlining') {
    if (m.status === 'outlining' || step === 'summarize_materials' || (m.progress && m.progress.withMaterials)) base = '資料を踏まえて作成中';
  }
  if (m.status === 'transcribing' && m.progress && m.progress.segmentsTotal) {
    return `${base}（${m.progress.segmentsDone} / ${m.progress.segmentsTotal}）`;
  }
  return base;
}

export function statusChipHtml(m) {
  const cls = m.status === 'done' ? 'ok' : m.status === 'failed' ? 'ng' : isProcessing(m.status) || m.status === 'recording' ? 'run' : 'wait';
  return `<span class="mn-status mn-status-${cls}">${esc(statusText(m))}</span>`;
}

// 音声ファイルから作った議事録の印
export function modeBadgeHtml(m) {
  return m && m.mode === 'upload' ? '<span class="mn-badge mn-badge-file">ファイル</span>' : '';
}

// 2:05:09 / 12:05 の形。
export function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

// 1 時間 12 分 の形。
export function durationJa(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} 時間 ${m} 分`;
  if (m) return `${m} 分`;
  return `${sec} 秒`;
}

export function counterpartLabel(c) {
  const name = c.name || '';
  const company = c.company || '';
  if (name && company) return `${name}（${company}）`;
  return name || company || '（名前なし）';
}

export function toQuery(obj) {
  const q = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') q[k] = v;
  return q;
}

export function itemsOf(r) {
  return Array.isArray(r) ? r : (r && r.items) || [];
}

export function deptNames(u) {
  return (u.departments || []).map((d) => (typeof d === 'string' ? d : d.name)).filter(Boolean).join('、');
}

export function errMessage(e, fallback = 'うまくいきませんでした。もう一度試してください。') {
  return (e && e.message) || fallback;
}

// ---- Markdown（見出し、箇条書き、番号付き、太字、段落だけ。raw HTML は出さない） ----
// 行の中の書式。先にエスケープするので、Markdown 中の < > はそのまま文字として出る。
// コードの中身は他の書式に巻き込まないよう、いったん置き換えてから最後に戻す
function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // 斜体は * だけ（_ は日本語の文中の記号や変数名とぶつかりやすいので使わない）
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    // リンクは http / https だけ。javascript: などは文字のまま残す
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

// 表の 1 行を、| で区切ったセルの配列にする（先頭と末尾の | は省略可）
function tableCells(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * 議事録・質問の答えに使う Markdown の表示。モデルが出しがちな書式だけに絞って対応する:
 * 見出し、箇条書き（入れ子は字下げで表す）、番号付き、チェックボックス、表、引用、区切り線、
 * コードのまとまり、太字・斜体・取り消し線・コード・リンク。HTML の直書きは文字として出す。
 */
export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  let quote = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); closeList(); flushQuote(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    let m;
    // コードのまとまり（``` で囲む）。中は書式を解釈しない
    if (/^\s*```/.test(line)) {
      flushAll();
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre class="mn-pre"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) { flushPara(); closeList(); quote.push(m[1]); continue; }
    flushQuote();
    if (!line.trim()) { flushPara(); closeList(); continue; }
    // 表: 見出しの行の次が |---|---| の区切りなら表として読む
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushAll();
      const head = tableCells(line);
      const align = tableCells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(tableCells(lines[i]));
      i--;
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
      out.push(`<div class="mn-table-wrap"><table class="mn-table"><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushPara(); closeList();
      const lv = Math.min(6, m[1].length + 1); // 画面の見出し（h1）と混ざらないよう 1 段下げる
      out.push(`<h${lv}>${inline(m[2].replace(/\s+#+$/, ''))}</h${lv}>`);
    } else if ((m = /^(\s*)[-*・]\s+(.*)$/.exec(line))) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      const ind = Math.min(2, Math.floor(m[1].length / 2));
      const cb = /^\[([ xX])\]\s+(.*)$/.exec(m[2]);
      out.push(cb
        ? `<li class="mn-ind${ind} mn-task${cb[1] === ' ' ? '' : ' done'}"><span class="mn-check" aria-hidden="true">${cb[1] === ' ' ? '' : '✓'}</span>${inline(cb[2])}</li>`
        : `<li class="mn-ind${ind}">${inline(m[2])}</li>`);
    } else if ((m = /^(\s*)\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li class="mn-ind${Math.min(2, Math.floor(m[1].length / 2))}">${inline(m[2])}</li>`);
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushAll();
  return out.join('\n');
}

// ---- モーダル ----
let modalSeq = 0;
export function showModal({ title, html = '', wide = false, onClose } = {}) {
  const id = `mn-modal-${++modalSeq}`;
  const el = document.createElement('div');
  el.className = 'mn-modal';
  el.innerHTML = `<div class="mn-modal-back" data-close="1"></div>
    <div class="mn-modal-box${wide ? ' mn-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}-t">
      <div class="mn-modal-head"><h2 id="${id}-t">${esc(title || '')}</h2><button class="mn-icon-btn" data-close="1" aria-label="閉じる">×</button></div>
      <div class="mn-modal-body">${html}</div>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add('mn-modal-open');
  const close = (result) => {
    if (!el.isConnected) return;
    el.remove();
    if (!document.querySelector('.mn-modal')) document.body.classList.remove('mn-modal-open');
    if (onClose) onClose(result);
  };
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(null); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
  return { el, body: el.querySelector('.mn-modal-body'), close };
}

export function ask(message, { title = '確認', okLabel = 'OK', cancelLabel = 'やめる', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = showModal({
      title,
      html: `<p class="mn-pre">${esc(message)}</p>
        <div class="mn-row mn-end"><button class="mn-btn" data-close="1">${esc(cancelLabel)}</button>
        <button class="mn-btn ${danger ? 'mn-btn-danger' : 'mn-btn-primary'}" data-ok="1">${esc(okLabel)}</button></div>`,
      onClose: () => done(false),
    });
    m.el.querySelector('[data-ok]').addEventListener('click', () => { done(true); m.close(); });
    m.el.querySelector('[data-ok]').focus();
  });
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy') ? resolve() : reject(new Error('copy')); } catch (e) { reject(e); } finally { ta.remove(); }
  });
}
