// 開発コンソール: 監査ログ。
import { api } from '../../api.js';
import { esc, formatDateTime } from '../../ui.js';
import { settingsNav } from '../settingsNav.js';

export async function renderDevAudit(container) {
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);
  page.innerHTML = `${settingsNav('/developer/audit')}<h1>監査ログ</h1>
    <div class="range"><input type="date" data-from><span>〜</span><input type="date" data-to></div>
    <table class="table"><thead><tr><th>日時</th><th>操作した人</th><th>操作</th><th>内容</th></tr></thead><tbody data-rows></tbody></table>
    <div class="more-row"><button type="button" class="btn" data-more hidden>もっと見る</button></div>`;
  const rows = page.querySelector('[data-rows]'), more = page.querySelector('[data-more]');
  let cursor = null;
  async function load(reset) {
    if (reset) { cursor = null; rows.innerHTML = ''; }
    try {
      const r = await api.get('/api/dev/audit', { from: page.querySelector('[data-from]').value, to: page.querySelector('[data-to]').value, cursor });
      const actor = (a) => (a && typeof a === 'object' ? a.name || a.id : a);
      const detail = (d) => (d && typeof d === 'object' ? JSON.stringify(d) : d);
      rows.insertAdjacentHTML('beforeend', (r.items || []).map((x) => `<tr><td class="nowrap">${esc(formatDateTime(x.at))}</td><td>${esc(actor(x.actor))}</td><td>${esc(x.action)}</td><td>${esc(detail(x.detail))}</td></tr>`).join(''));
      cursor = r.nextCursor || null;
      more.hidden = !cursor;
      if (!rows.children.length) rows.innerHTML = '<tr><td colspan="4" class="empty">記録がありません。</td></tr>';
    } catch (e) { rows.innerHTML = `<tr><td colspan="4" class="alert alert-error">${esc(e.message)}</td></tr>`; }
  }
  more.addEventListener('click', () => load(false));
  page.querySelector('[data-from]').addEventListener('change', () => load(true));
  page.querySelector('[data-to]').addEventListener('change', () => load(true));
  await load(true);
}
