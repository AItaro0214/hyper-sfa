// 管理コンソール: 登録履歴・編集履歴と、人ごと・部署ごとの集計。
import { api } from '../../api.js';
import { state } from '../../state.js';
import { esc, errorMessage, toast } from '../../ui.js';
import { settingsNav } from '../settingsNav.js';
import { historyItemHtml, TYPE_LABEL } from '../cardDetail.js';

export async function renderAdminHistory(container) {
  const useDepts = !!state.config.features.departments;
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);
  const thisMonth = new Date().toISOString().slice(0, 7);
  page.innerHTML = `${settingsNav('/admin/history')}<h1>履歴</h1>
    <form class="filters" data-f>
      <div class="field"><span>種類</span><div class="pills" data-types>
        <button type="button" class="pill on" data-type="">すべて</button>
        ${['create', 'edit', 'rescan', 'delete'].map((t) => `<button type="button" class="pill" data-type="${t}">${TYPE_LABEL[t]}</button>`).join('')}</div></div>
      <div class="field"><span>期間</span><div class="range"><input type="date" name="from"><span>〜</span><input type="date" name="to"></div></div>
      <label class="field"><span>操作した人</span><select name="actor"><option value="">すべて</option></select></label>
      ${useDepts ? '<label class="field"><span>部署</span><select name="dept"><option value="">すべて</option></select></label>' : ''}
    </form>
    <div data-list></div><div class="more-row"><button type="button" class="btn" data-more hidden>もっと見る</button></div>
    <section><h2>登録枚数の集計</h2>
      <div class="range"><input type="month" data-sfrom value="${thisMonth}"><span>〜</span><input type="month" data-sto value="${thisMonth}"></div>
      <div data-summary></div></section>`;
  const f = page.querySelector('[data-f]');
  const listEl = page.querySelector('[data-list]');
  const moreBtn = page.querySelector('[data-more]');
  let type = '', cursor = null, seq = 0;

  api.get('/api/directory').then((r) => {
    f.elements.actor.insertAdjacentHTML('beforeend', (r.items || []).map((u) => `<option value="${esc(u.id)}">${esc(u.displayName)}</option>`).join(''));
  }).catch(() => {});
  if (useDepts) api.get('/api/admin/departments').then((r) => {
    f.elements.dept.insertAdjacentHTML('beforeend', (r.items || []).map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join(''));
  }).catch(() => {});

  async function load(reset) {
    const my = ++seq;
    if (reset) { cursor = null; listEl.innerHTML = '<p class="muted">読み込んでいます…</p>'; }
    try {
      const r = await api.get('/api/admin/history', { type, from: f.elements.from.value, to: f.elements.to.value, actor: f.elements.actor.value, dept: f.elements.dept?.value, cursor });
      if (my !== seq) return;
      const html = (r.items || []).map((h) => historyItemHtml(h, { withCard: true })).join('');
      if (reset) listEl.innerHTML = html ? `<ul class="plain">${html}</ul>` : '<p class="empty">履歴はありません。</p>';
      else listEl.querySelector('ul')?.insertAdjacentHTML('beforeend', html);
      cursor = r.nextCursor || null;
      moreBtn.hidden = !cursor;
    } catch (e) { if (my === seq) listEl.innerHTML = `<p class="alert alert-error">${esc(e.message)}</p>`; }
  }
  f.addEventListener('change', () => load(true));
  f.querySelector('[data-types]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    type = b.dataset.type;
    f.querySelectorAll('[data-type]').forEach((x) => x.classList.toggle('on', x === b));
    load(true);
  });
  moreBtn.addEventListener('click', () => load(false));

  async function summary() {
    const box = page.querySelector('[data-summary]');
    try {
      const r = await api.get('/api/admin/history/summary', { from: page.querySelector('[data-sfrom]').value, to: page.querySelector('[data-sto]').value });
      const tbl = (rows, cols) => `<table class="table"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
      box.innerHTML = '<h3>人ごと</h3>' + tbl((r.byUser || []).map((u) => `<tr><td>${esc(u.name)}</td>${useDepts ? `<td>${esc(u.deptName)}</td>` : ''}<td class="num">${esc(u.count)}</td></tr>`).join(''), ['氏名', ...(useDepts ? ['部署'] : []), '枚数'])
        + (useDepts ? '<h3>部署ごと</h3>' + tbl((r.byDept || []).map((d) => `<tr><td>${esc(d.name)}</td><td class="num">${esc(d.count)}</td></tr>`).join(''), ['部署', '枚数']) : '');
    } catch (e) { box.innerHTML = `<p class="muted">${esc(errorMessage(e))}</p>`; }
  }
  page.querySelector('[data-sfrom]').addEventListener('change', summary);
  page.querySelector('[data-sto]').addEventListener('change', summary);
  await Promise.all([load(true), summary()]);
  void toast;
}
