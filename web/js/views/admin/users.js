// 管理コンソール: ユーザーの登録（1 人ずつ）と一覧。AWS 版はメール + 部署 + 役職、Cloudflare 版は ID + 役割。
import { DEFAULT_POSITIONS } from '/core/index.js';
import { api } from '../../api.js';
import { state } from '../../state.js';
import { esc, toast, confirmDialog, openModal, closeModal, formatDateTime, errorMessage } from '../../ui.js';
import { settingsNav } from '../settingsNav.js';
import { resetDepartmentCache } from '../cardEdit.js';

const STATUS = { invited: '未ログイン', active: '利用中', disabled: '無効' };

async function loadPositions() {
  const caps = state.me.capabilities || {};
  let list = DEFAULT_POSITIONS.map((p) => p.name);
  if (caps.dev) {
    try { list = ((await api.get('/api/dev/positions')).items || []).sort((a, b) => a.order - b.order).map((p) => p.name); } catch { /* 既定の一覧を使う */ }
  }
  // 「開発者」を付けられるのは開発者だけ。
  return caps.dev ? list : list.filter((n) => n !== '開発者');
}

function tempPasswordModal(loginId, pw) {
  const body = openModal(`<p><strong>${esc(loginId)}</strong> の仮パスワードです。<b>この画面を閉じると二度と表示されません。</b>本人に伝えてください。</p>
    <p><code class="temp-pw">${esc(pw)}</code></p>
    <div class="actions"><button type="button" class="btn" data-copy>コピー</button><button type="button" class="btn btn-primary" data-close>閉じる</button></div>`, { title: '仮パスワード' });
  body.querySelector('[data-copy]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pw); toast('コピーしました'); } catch { toast('コピーできませんでした。手で控えてください。', 'error'); }
  });
  body.querySelector('[data-close]').addEventListener('click', closeModal);
}

export async function renderAdminUsers(container) {
  const aws = state.config.edition !== 'cloudflare' && state.config.authMode !== 'password';
  const useDepts = !!state.config.features.departments;
  const useImport = !!state.config.features.userImport;
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);
  const [positions, depts] = await Promise.all([
    aws ? loadPositions() : [],
    useDepts ? api.get('/api/admin/departments').then((r) => (r.items || []).filter((d) => d.active !== false)).catch(() => []) : [],
  ]);
  let users = [];

  page.innerHTML = `${settingsNav('/admin/users')}<h1>ユーザー</h1>
    <section><h2>登録する</h2><div data-add></div></section>
    <section><h2>一覧</h2><div class="table-wrap" data-list></div></section>`;

  // 部署・役職などをボタンで選ぶ部品。
  function pillGroup(items, selectedSet, multi, onChange) {
    const box = document.createElement('div');
    box.className = 'pills';
    const draw = () => {
      box.innerHTML = items.map((it) => `<button type="button" class="pill ${selectedSet.has(it.id) ? 'on' : ''}" data-v="${esc(it.id)}" aria-pressed="${selectedSet.has(it.id)}">${esc(it.name)}</button>`).join('');
    };
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      const v = b.dataset.v;
      if (multi) { if (selectedSet.has(v)) selectedSet.delete(v); else selectedSet.add(v); }
      else { selectedSet.clear(); selectedSet.add(v); }
      draw();
      if (onChange) onChange();
    });
    draw();
    box.redraw = draw;
    return box;
  }

  function buildAddForm() {
    const box = page.querySelector('[data-add]');
    const chosenDepts = new Set(), chosenPos = new Set();
    const newDepts = [];
    if (aws) {
      box.innerHTML = `<form class="stack" novalidate>
        <label class="field"><span>メールアドレス</span><input name="email" type="email" autocapitalize="none" required></label>
        <label class="field"><span>氏名（任意）</span><input name="displayName"></label>
        <div class="field"><span>部署（複数選べます）</span><div data-depts></div>
          <div class="inline"><button type="button" class="btn btn-small" data-newdept>＋ 新しい部署</button>
          <span data-newbox hidden><input data-newname placeholder="部署名"><button type="button" class="btn btn-small" data-newadd>追加</button></span></div></div>
        <div class="field"><span>役職</span><div data-pos></div></div>
        <p class="alert alert-error" data-err hidden></p>
        <div class="actions"><button class="btn btn-primary" type="submit">登録する</button></div></form>`;
      const dg = pillGroup(depts, chosenDepts, true);
      box.querySelector('[data-depts]').appendChild(dg);
      const newAsItems = [];
      box.querySelector('[data-newdept]').addEventListener('click', () => { box.querySelector('[data-newbox]').hidden = false; box.querySelector('[data-newname]').focus(); });
      box.querySelector('[data-newadd]').addEventListener('click', () => {
        const inp = box.querySelector('[data-newname]');
        const name = inp.value.trim();
        if (!name) return;
        if (!newDepts.includes(name)) { newDepts.push(name); depts.push({ id: `new:${name}`, name: `${name}（新規）` }); newAsItems.push(name); chosenDepts.add(`new:${name}`); }
        inp.value = '';
        dg.redraw();
      });
      box.querySelector('[data-pos]').appendChild(pillGroup(positions.map((n) => ({ id: n, name: n })), chosenPos, false));
      box.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target, err = box.querySelector('[data-err]');
        err.hidden = true;
        const deptIds = [...chosenDepts].filter((x) => !x.startsWith('new:'));
        const nd = [...chosenDepts].filter((x) => x.startsWith('new:')).map((x) => x.slice(4));
        if (!f.elements.email.value.trim() || !chosenPos.size || (!deptIds.length && !nd.length)) { err.textContent = 'メールアドレス、部署、役職を入れてください。'; err.hidden = false; return; }
        try {
          await api.post('/api/admin/users', { email: f.elements.email.value.trim(), displayName: f.elements.displayName.value.trim() || undefined, position: [...chosenPos][0], deptIds, newDepartments: nd.length ? nd : undefined });
          toast('登録しました', 'success');
          if (nd.length) resetDepartmentCache();
          renderAdminUsers.reload();
        } catch (ex) { err.textContent = ex.message + (ex.details ? '\n' + ex.details.map((d) => d.message).join('\n') : ''); err.hidden = false; }
      });
    } else {
      box.innerHTML = `<form class="stack" novalidate>
        <label class="field"><span>ID（3〜64 文字）</span><input name="loginId" autocapitalize="none" required></label>
        <label class="field"><span>氏名</span><input name="displayName" required></label>
        <div class="field"><span>役割</span><div class="radios"><label><input type="radio" name="role" value="member" checked> メンバー</label>
          <label><input type="radio" name="role" value="admin"> 管理者</label></div></div>
        <p class="alert alert-error" data-err hidden></p>
        <div class="actions"><button class="btn btn-primary" type="submit">登録する</button></div></form>`;
      box.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target, err = box.querySelector('[data-err]');
        err.hidden = true;
        try {
          const r = await api.post('/api/admin/users', { loginId: f.elements.loginId.value.trim(), displayName: f.elements.displayName.value.trim(), role: f.elements.role.value });
          tempPasswordModal(f.elements.loginId.value.trim(), r.tempPassword);
          renderAdminUsers.reload();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    }
  }

  function drawList() {
    const box = page.querySelector('[data-list]');
    box.innerHTML = `<table class="table"><thead><tr><th>氏名</th><th>${aws ? 'メール' : 'ID'}</th>${useDepts ? '<th>部署</th>' : ''}<th>${aws ? '役職' : '役割'}</th><th>状態</th><th>最終ログイン</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr data-id="${esc(u.id)}"><td>${esc(u.displayName) || '<span class="muted">-</span>'}</td><td>${esc(aws ? u.email : u.loginId)}</td>
        ${useDepts ? `<td>${(u.departments || []).map((d) => esc(d.name)).join('、')}</td>` : ''}
        <td>${esc(aws ? u.position : { admin: '管理者', member: 'メンバー' }[u.role] || u.role)}</td>
        <td>${esc(STATUS[u.status] || u.status)}</td><td>${esc(formatDateTime(u.lastLoginAt))}</td>
        <td class="nowrap"><button type="button" class="btn btn-small" data-edit>変更</button>
          ${u.status === 'disabled' ? '<button type="button" class="btn btn-small" data-toggle="active">有効にする</button>' : '<button type="button" class="btn btn-small" data-toggle="disabled">無効にする</button>'}
          ${!aws ? '<button type="button" class="btn btn-small" data-temp>仮パスワード</button>' : ''}</td></tr>`).join('')}</tbody></table>`;
  }

  page.querySelector('[data-list]').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const u = users.find((x) => x.id === tr.dataset.id);
    if (e.target.closest('[data-toggle]')) {
      const to = e.target.closest('[data-toggle]').dataset.toggle;
      if (to === 'disabled' && !(await confirmDialog(`${u.displayName || u.email || u.loginId} を無効にしますか？登録した名刺と履歴は残ります。`, { okLabel: '無効にする', danger: true }))) return;
      try { await api.patch(`/api/admin/users/${encodeURIComponent(u.id)}`, { status: to }); renderAdminUsers.reload(); } catch (ex) { toast(errorMessage(ex), 'error'); }
    } else if (e.target.closest('[data-temp]')) {
      if (!(await confirmDialog('仮パスワードを再発行します。その人のログインは全部切れます。', { okLabel: '再発行する' }))) return;
      try { const r = await api.post(`/api/admin/users/${encodeURIComponent(u.id)}/temp-password`); tempPasswordModal(u.loginId, r.tempPassword); } catch (ex) { toast(errorMessage(ex), 'error'); }
    } else if (e.target.closest('[data-edit]')) editModal(u);
  });

  function editModal(u) {
    const chosenDepts = new Set(u.deptIds || []), chosenPos = new Set([u.position]);
    const body = openModal(`<form class="stack"><label class="field"><span>氏名</span><input name="displayName" value="${esc(u.displayName)}"></label>
      ${aws ? '<div class="field"><span>部署</span><div data-depts></div></div><div class="field"><span>役職</span><div data-pos></div></div>'
        : `<div class="field"><span>役割</span><div class="radios"><label><input type="radio" name="role" value="member" ${u.role === 'member' ? 'checked' : ''}> メンバー</label>
          <label><input type="radio" name="role" value="admin" ${u.role === 'admin' ? 'checked' : ''}> 管理者</label></div></div>`}
      <p class="alert alert-error" data-err hidden></p>
      <div class="actions"><button type="button" class="btn" data-close>キャンセル</button><button class="btn btn-primary" type="submit">保存</button></div></form>`, { title: '変更' });
    if (aws) {
      if (useDepts) body.querySelector('[data-depts]').appendChild(pillGroup(depts.filter((d) => !d.id.startsWith('new:')), chosenDepts, true));
      const posList = positions.includes(u.position) ? positions : [...positions, u.position];
      body.querySelector('[data-pos]').appendChild(pillGroup(posList.map((n) => ({ id: n, name: n })), chosenPos, false));
    }
    body.querySelector('[data-close]').addEventListener('click', closeModal);
    body.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target, err = body.querySelector('[data-err]');
      const patch = { displayName: f.elements.displayName.value.trim() };
      if (aws) { patch.position = [...chosenPos][0]; if (useDepts) patch.deptIds = [...chosenDepts]; } else patch.role = f.elements.role.value;
      try { await api.patch(`/api/admin/users/${encodeURIComponent(u.id)}`, patch); closeModal(); toast('保存しました', 'success'); renderAdminUsers.reload(); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
  }

  renderAdminUsers.reload = async () => {
    try { users = (await api.get('/api/admin/users')).items || []; } catch (e) { page.querySelector('[data-list]').innerHTML = `<p class="alert alert-error">${esc(e.message)}</p>`; return; }
    drawList();
    // 部署を新しく作ったかもしれないので、追加フォームの部署も取り直す。
    if (aws && useDepts) { const fresh = (await api.get('/api/admin/departments')).items || []; depts.splice(0, depts.length, ...fresh.filter((d) => d.active !== false)); }
    buildAddForm();
  };
  buildAddForm();
  await renderAdminUsers.reload();
}
