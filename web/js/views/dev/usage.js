// 開発コンソール: 利用状況。月ごと・用途ごと・モデルごとと、議事録のユーザーごとの一覧（minutes-design §7.2）。
import { api } from '../../api.js';
import { state } from '../../state.js';
import { esc, toast, formatDate, formatDateTime, formatDuration, usd, errorMessage } from '../../ui.js';
import { settingsNav } from '../settingsNav.js';

const USE_LABEL = { card: '名刺の読み取り', transcribe: '文字起こし', summarize: '議事録の作成', test: '試し' };
const EVENT_LABEL = { transcribe: '文字起こし', summarize: '議事録', test: '試し', 'transcribe-retry': '文字起こし（やり直し）', 'summarize-retry': '議事録（作り直し）' };
const num = (n) => Number(n || 0).toLocaleString('ja-JP');
const hm = (sec) => `${Math.floor((sec || 0) / 3600)}:${String(Math.floor(((sec || 0) % 3600) / 60)).padStart(2, '0')}`;
const deptNames = (u) => (u.departments || []).map((d) => (typeof d === 'string' ? d : d.name)).join('、');

export async function renderDevUsage(container) {
  const page = document.createElement('div');
  page.className = 'page wide';
  container.appendChild(page);
  const month = new Date().toISOString().slice(0, 7);
  const useDepts = !!state.config.features.departments;
  const monthsAgo = (n) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7); };
  page.innerHTML = `${settingsNav('/developer/usage')}<h1>利用状況</h1>
    <section><h2>月ごと</h2>
      <div class="range"><input type="month" data-m-from value="${monthsAgo(2)}"><span>〜</span><input type="month" data-m-to value="${month}"></div>
      <div data-months></div></section>
    ${state.config.features.minutes ? `<section><h2>議事録: ユーザーごと</h2>
      <div class="filters">
        <div class="range"><input type="month" data-u-from value="${month}"><span>〜</span><input type="month" data-u-to value="${month}"></div>
        ${useDepts ? '<label class="field inline-field"><span>部署</span><select data-u-dept><option value="">すべて</option></select></label>' : ''}
        <label class="check"><input type="checkbox" data-u-unused> 使っていない人も出す</label>
        <button type="button" class="btn" data-u-csv>CSV で出力</button></div>
      <div class="table-wrap" data-users></div><div data-detail></div></section>` : ''}
    <p><a href="/developer/audit">監査ログを見る</a></p>`;

  // ---- 月ごと ----
  async function loadMonths() {
    const box = page.querySelector('[data-months]');
    try {
      const r = await api.get('/api/dev/usage', { from: page.querySelector('[data-m-from]').value, to: page.querySelector('[data-m-to]').value });
      box.innerHTML = (r.months || []).map((m) => `<h3>${esc(m.month)}</h3>
        <table class="table"><thead><tr><th>用途</th><th>回数</th><th>失敗</th><th>入力トークン</th><th>出力トークン</th><th>概算費用</th></tr></thead><tbody>
        ${Object.entries(m.byUse || {}).map(([u, v]) => `<tr><td>${esc(USE_LABEL[u] || u)}</td><td class="num">${num(v.count)}</td><td class="num">${num(v.failed)}</td><td class="num">${num(v.inputTokens)}</td><td class="num">${num(v.outputTokens)}</td><td class="num">${usd(v.cost)}</td></tr>`).join('')}</tbody></table>
        ${(m.byModel || []).length ? `<table class="table"><thead><tr><th>モデル</th><th>回数</th><th>失敗</th><th>入力トークン</th><th>出力トークン</th><th>概算費用</th></tr></thead><tbody>
        ${m.byModel.map((v) => `<tr><td>${esc(v.modelId || v.model || v.id)}</td><td class="num">${num(v.count)}</td><td class="num">${num(v.failed)}</td><td class="num">${num(v.inputTokens)}</td><td class="num">${num(v.outputTokens)}</td><td class="num">${usd(v.cost)}</td></tr>`).join('')}</tbody></table>` : ''}`).join('') || '<p class="empty">記録がありません。</p>';
    } catch (e) { box.innerHTML = `<p class="alert alert-error">${esc(e.message)}</p>`; }
  }
  page.querySelector('[data-m-from]').addEventListener('change', loadMonths);
  page.querySelector('[data-m-to]').addEventListener('change', loadMonths);

  // ---- ユーザーごと ----
  if (!state.config.features.minutes) { await loadMonths(); return; }
  let data = { items: [], total: null }, sortKey = 'recordedSec', sortDir = -1;
  const COLS = [
    ['name', '氏名', (u) => u.user.name, 'str'],
    ['dept', '部署', (u) => deptNames(u.user), 'str'],
    ['recordings', '録音本数', (u) => u.recordings],
    ['recordedSec', '録音時間', (u) => u.recordedSec],
    ['tFirst', '文字起こし 初回', (u) => u.transcribe?.first],
    ['tRetry', 'やり直し', (u) => u.transcribe?.retry],
    ['sFirst', '議事録 初回', (u) => u.summarize?.first],
    ['sRetry', '作り直し', (u) => u.summarize?.retry],
    ['failed', '失敗', (u) => u.failed],
    ['cost', '概算費用', (u) => u.cost],
    ['lastUsedAt', '最後に使った日', (u) => u.lastUsedAt || '', 'str'],
  ];
  const cell = (k, v, u) => (k === 'name' ? `${esc(v)}${u.user.status === 'disabled' ? ' <span class="badge">無効</span>' : ''}` : k === 'recordedSec' ? hm(v) : k === 'cost' ? usd(v) : k === 'lastUsedAt' ? esc(formatDate(v)) : k === 'dept' ? esc(v) : num(v));
  function drawUsers() {
    const col = COLS.find((c) => c[0] === sortKey);
    const rows = [...data.items].sort((a, b) => {
      const x = col[2](a), y = col[2](b);
      return (col[3] === 'str' ? String(x).localeCompare(String(y), 'ja') : (x || 0) - (y || 0)) * sortDir;
    });
    const t = data.total || {};
    page.querySelector('[data-users]').innerHTML = `<table class="table sortable"><thead><tr>${COLS.map(([k, l]) => `<th><button type="button" class="th-btn" data-sort="${k}">${esc(l)}${k === sortKey ? (sortDir < 0 ? ' ▼' : ' ▲') : ''}</button></th>`).join('')}</tr></thead><tbody>
      ${rows.map((u) => `<tr data-uid="${esc(u.user.id)}" class="clickable">${COLS.map(([k, , g, ty]) => `<td class="${ty === 'str' ? '' : 'num'}">${cell(k, g(u), u)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${COLS.length}" class="empty">記録がありません。</td></tr>`}</tbody>
      ${rows.length ? `<tfoot><tr><td>合計（${rows.length} 人）</td><td></td><td class="num">${num(t.recordings)}</td><td class="num">${hm(t.recordedSec)}</td><td class="num">${num(t.transcribe?.first)}</td><td class="num">${num(t.transcribe?.retry)}</td><td class="num">${num(t.summarize?.first)}</td><td class="num">${num(t.summarize?.retry)}</td><td class="num">${num(t.failed)}</td><td class="num">${usd(t.cost)}</td><td></td></tr></tfoot>` : ''}</table>`;
  }
  const uq = () => ({ from: page.querySelector('[data-u-from]').value, to: page.querySelector('[data-u-to]').value, dept: page.querySelector('[data-u-dept]')?.value, includeUnused: page.querySelector('[data-u-unused]').checked ? 1 : undefined });
  async function loadUsers() {
    try { data = await api.get('/api/dev/usage/minutes', uq()); drawUsers(); }
    catch (e) { page.querySelector('[data-users]').innerHTML = `<p class="alert alert-error">${esc(e.message)}</p>`; }
  }
  page.querySelector('[data-users]').addEventListener('click', async (e) => {
    const s = e.target.closest('[data-sort]');
    if (s) { if (sortKey === s.dataset.sort) sortDir *= -1; else { sortKey = s.dataset.sort; sortDir = -1; } drawUsers(); return; }
    const tr = e.target.closest('tr[data-uid]');
    if (tr) showDetail(tr.dataset.uid);
  });
  for (const sel of ['[data-u-from]', '[data-u-to]', '[data-u-dept]', '[data-u-unused]']) page.querySelector(sel)?.addEventListener('change', loadUsers);
  page.querySelector('[data-u-csv]').addEventListener('click', async () => {
    try { const q = uq(); const r = await api.post('/api/dev/export', { kind: 'minutes-usage', filters: q }); window.open(r.url, '_blank', 'noopener'); }
    catch (ex) { toast(errorMessage(ex), 'error'); }
  });
  if (useDepts) api.get('/api/admin/departments').then((r) => {
    page.querySelector('[data-u-dept]').insertAdjacentHTML('beforeend', (r.items || []).map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join(''));
  }).catch(() => {});

  async function showDetail(uid) {
    const box = page.querySelector('[data-detail]');
    box.innerHTML = '<p class="muted">読み込んでいます…</p>';
    try {
      const r = await api.get(`/api/dev/usage/minutes/${encodeURIComponent(uid)}`);
      const u = data.items.find((x) => x.user.id === uid);
      box.innerHTML = `<h3>${esc(u ? u.user.name : '')}${u ? `（${esc(deptNames(u.user))}）` : ''}</h3>
        <h4>月ごとの推移</h4><table class="table"><thead><tr><th>月</th><th>録音時間</th><th>文字起こし</th><th>概算費用</th></tr></thead><tbody>
        ${(r.months || []).map((m) => `<tr><td>${esc(m.month)}</td><td class="num">${hm(m.recordedSec)}</td><td class="num">${num(m.transcribeCount ?? m.transcribes)}</td><td class="num">${usd(m.cost)}</td></tr>`).join('')}</tbody></table>
        <h4>記録</h4><table class="table"><thead><tr><th>日時</th><th>種類</th><th>録音時間</th><th>モデル</th><th>結果</th><th>トークン（入力 / 出力）</th></tr></thead><tbody>
        ${(r.events || []).map((ev) => `<tr><td>${esc(formatDateTime(ev.at))}</td><td>${esc(EVENT_LABEL[ev.kind] || ev.kind)}</td><td class="num">${ev.durationSec ? formatDuration(ev.durationSec) : ''}</td><td>${esc(ev.modelId)}</td>
          <td>${ev.ok ? '成功' : `失敗 ${esc(ev.failureKind || '')}`}</td><td class="num">${num(ev.inputTokens)} / ${num(ev.outputTokens)}</td></tr>`).join('')}</tbody></table>
        <p class="muted">議事録のタイトルや本文は、ここには出ません。</p>`;
    } catch (ex) { box.innerHTML = `<p class="alert alert-error">${esc(ex.message)}</p>`; }
  }
  await Promise.all([loadMonths(), loadUsers()]);
}
