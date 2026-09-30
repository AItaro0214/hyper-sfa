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
  done: '完了',
  failed: '失敗',
};

export function isProcessing(status) {
  return status === 'queued' || status === 'transcribing' || status === 'summarizing';
}

export function statusText(m) {
  const base = STATUS_LABEL[m.status] || m.status;
  if (m.status === 'transcribing' && m.progress && m.progress.segmentsTotal) {
    return `${base}（${m.progress.segmentsDone} / ${m.progress.segmentsTotal}）`;
  }
  return base;
}

export function statusChipHtml(m) {
  const cls = m.status === 'done' ? 'ok' : m.status === 'failed' ? 'ng' : isProcessing(m.status) || m.status === 'recording' ? 'run' : 'wait';
  return `<span class="mn-status mn-status-${cls}">${esc(statusText(m))}</span>`;
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
function inline(text) {
  // 先にエスケープするので、Markdown 中の < > はそのまま文字として出る
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushPara(); closeList();
      const lv = Math.min(6, m[1].length + 1); // 画面の見出し（h1）と混ざらないよう 1 段下げる
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
    } else if ((m = /^(\s*)[-*・]\s+(.*)$/.exec(line))) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li class="mn-ind${Math.min(2, Math.floor(m[1].length / 2))}">${inline(m[2])}</li>`);
    } else if ((m = /^(\s*)\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li class="mn-ind${Math.min(2, Math.floor(m[1].length / 2))}">${inline(m[2])}</li>`);
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara(); closeList();
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
