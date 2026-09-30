// 管理コンソール: 部署設定（追加、名前の変更、並び替え、使用停止）。
import { api } from '../../api.js';
import { state } from '../../state.js';
import { esc, toast, errorMessage } from '../../ui.js';
import { navigate } from '../../router.js';
import { settingsNav } from '../settingsNav.js';
import { resetDepartmentCache } from '../cardEdit.js';

export async function renderAdminDepartments(container) {
  if (!state.config.features.departments) { navigate('/admin/users', { replace: true }); return; }
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);
  page.innerHTML = `${settingsNav('/admin/departments')}<h1>部署設定</h1>
    <form class="inline" data-add><input name="name" placeholder="新しい部署名" required><button class="btn btn-primary" type="submit">追加</button></form>
    <div data-list></div>`;
  let items = [];

  const patch = async (id, body) => {
    try { await api.patch(`/api/admin/departments/${encodeURIComponent(id)}`, body); resetDepartmentCache(); await load(); }
    catch (e) { toast(errorMessage(e), 'error'); }
  };
  function draw() {
    page.querySelector('[data-list]').innerHTML = `<table class="table"><thead><tr><th>順</th><th>部署名</th><th>状態</th><th></th></tr></thead><tbody>
      ${items.map((d, i) => `<tr data-id="${esc(d.id)}" data-i="${i}"><td class="nowrap">
        <button type="button" class="btn btn-small" data-up ${i === 0 ? 'disabled' : ''} aria-label="上へ">↑</button>
        <button type="button" class="btn btn-small" data-down ${i === items.length - 1 ? 'disabled' : ''} aria-label="下へ">↓</button></td>
        <td><input value="${esc(d.name)}" data-name aria-label="部署名"></td>
        <td>${d.active === false ? '使用停止' : '使用中'}</td>
        <td class="nowrap"><button type="button" class="btn btn-small" data-rename>名前を保存</button>
          <button type="button" class="btn btn-small" data-active>${d.active === false ? '再開する' : '使用停止'}</button></td></tr>`).join('')}</tbody></table>`;
  }
  page.querySelector('[data-list]').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const i = +tr.dataset.i, d = items[i];
    if (e.target.closest('[data-rename]')) patch(d.id, { name: tr.querySelector('[data-name]').value.trim(), order: d.order, active: d.active !== false });
    else if (e.target.closest('[data-active]')) patch(d.id, { name: d.name, order: d.order, active: d.active === false });
    else if (e.target.closest('[data-up]') || e.target.closest('[data-down]')) {
      // 並び順は隣と入れ替える。order の値そのものを交換する。
      const j = e.target.closest('[data-up]') ? i - 1 : i + 1;
      const o = items[j];
      try {
        await api.patch(`/api/admin/departments/${encodeURIComponent(d.id)}`, { name: d.name, order: o.order, active: d.active !== false });
        await api.patch(`/api/admin/departments/${encodeURIComponent(o.id)}`, { name: o.name, order: d.order, active: o.active !== false });
        resetDepartmentCache();
        await load();
      } catch (ex) { toast(errorMessage(ex), 'error'); }
    }
  });
  page.querySelector('[data-add]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = e.target.elements.name;
    try {
      await api.post('/api/admin/departments', { name: inp.value.trim(), order: items.length + 1, active: true });
      inp.value = '';
      resetDepartmentCache();
      await load();
    } catch (ex) { toast(errorMessage(ex), 'error'); }
  });
  async function load() {
    try { items = ((await api.get('/api/admin/departments')).items || []).sort((a, b) => a.order - b.order); draw(); }
    catch (e) { page.querySelector('[data-list]').innerHTML = `<p class="alert alert-error">${esc(e.message)}</p>`; }
  }
  await load();
}
