// 画面共通の小さな部品。外から来た文字列は必ず esc() を通す。
import { icon } from './icons.js';

// 設定に名前が無いときに画面へ出す名前
export const APP_NAME = '名刺とミーティング';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = el(`<div class="toast toast-${esc(kind)}" role="status">${esc(message)}</div>`);
  box.appendChild(t);
  // 消えるときも動かすため、いったん out のクラスを付けてから外す
  setTimeout(() => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 220); }, kind === 'error' ? 6000 : 3500);
}

// 上端の進行バー。短い通信でちらつかないよう、150ms たってから出す。
let inflight = 0, showTimer = 0;
export function progressStart() {
  inflight++;
  if (inflight === 1) {
    clearTimeout(showTimer);
    showTimer = setTimeout(() => document.getElementById('progress')?.classList.add('on'), 150);
  }
}
export function progressDone() {
  inflight = Math.max(0, inflight - 1);
  if (inflight === 0) {
    clearTimeout(showTimer);
    document.getElementById('progress')?.classList.remove('on');
  }
}

// 読み込み中の骨組み。n 行ぶんの名刺カードの形をしたシマー。
export function skeletonRows(n = 6) {
  return Array.from({ length: n }, () => '<div class="skel-row" aria-hidden="true"><div class="skel skel-thumb"></div><div class="skel-lines"><div class="skel" style="width:55%"></div><div class="skel" style="width:35%"></div><div class="skel" style="width:70%"></div></div></div>').join('');
}

// テーマ（ダーク / ライト）。保存が無ければ OS の設定に従う。
export function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark' || t === 'light') return t;
  return window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* 保存できなくても、このタブでは切り替わる */ }
  return next;
}

// 日時は API が UTC で返すので、表示だけ日本時間に直す。
const jst = (d, opt) => {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hourCycle: 'h23', ...opt }).formatToParts(d)) parts[p.type] = p.value;
  return parts;
};
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = jst(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}
export function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = jst(d, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
export function formatDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function debounce(fn, ms = 300) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// モーダルは重ねられる（編集の中で確認を出すため）。
const stack = [];
export function openModal(content, { title = '', wide = false, onClose } = {}) {
  const overlay = el(`<div class="modal-overlay"><div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="閉じる">${icon('close')}</button></div>
    <div class="modal-body"></div></div></div>`);
  const body = overlay.querySelector('.modal-body');
  if (typeof content === 'string') body.innerHTML = content; else body.appendChild(content);
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-close]')) closeModal(); });
  document.body.appendChild(overlay);
  stack.push({ overlay, onClose });
  return body;
}
export function closeModal() {
  const top = stack.pop();
  if (!top) return;
  top.overlay.remove();
  if (top.onClose) top.onClose();
}

export function confirmDialog(message, { okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const body = openModal(`<p class="pre">${esc(message)}</p>
      <div class="actions"><button type="button" class="btn" data-no>キャンセル</button>
      <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(okLabel)}</button></div>`,
      { onClose: () => finish(false) });
    body.querySelector('[data-yes]').addEventListener('click', () => { finish(true); closeModal(); });
    body.querySelector('[data-no]').addEventListener('click', () => closeModal());
  });
}

export function chip(label, onRemove) {
  const c = el(`<span class="chip">${esc(label)}${onRemove ? '<button type="button" aria-label="外す">×</button>' : ''}</span>`);
  if (onRemove) c.querySelector('button').addEventListener('click', onRemove);
  return c;
}

// 日本語入力の変換中は検索を走らせない。compositionend は addEventListener で付ける。
export function onTextInput(input, handler, ms = 400) {
  let composing = false;
  const run = debounce(() => handler(input.value), ms);
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; run(); });
  input.addEventListener('input', () => { if (!composing) run(); });
}

export function errorMessage(e) {
  return (e && e.message) || '失敗しました';
}

export function setBusy(btn, busy) {
  if (btn) btn.disabled = busy;
}

export function usd(n) { return '$' + (Number(n) || 0).toFixed(2); }
