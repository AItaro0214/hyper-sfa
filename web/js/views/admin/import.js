// 管理コンソール: ユーザーの CSV 一括登録。必ず確認画面を挟む（部署名の書き間違いが新しい部署になるため）。
import { detectAndDecode, parseCsv, parseUserRows } from '/core/index.js';
import { api } from '../../api.js';
import { state } from '../../state.js';
import { esc, toast, confirmDialog, errorMessage } from '../../ui.js';
import { navigate } from '../../router.js';
import { settingsNav } from '../settingsNav.js';
import { resetDepartmentCache } from '../cardEdit.js';

const MAX_ROWS = 1000;

export async function renderAdminImport(container) {
  if (!state.config.features.userImport) { navigate('/admin/users', { replace: true }); return; }
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);
  let rows = [];

  function stepFile(message) {
    page.innerHTML = `${settingsNav('/admin/import')}<h1>CSV 一括登録</h1>
      ${message ? `<p class="alert alert-ok">${esc(message)}</p>` : ''}
      <p>列は「部署, アドレス, 役職」の順、4 列目に氏名（任意）。兼任は部署を <code>;</code> でつなぎます（例: 営業部;開発部）。UTF-8 と Shift_JIS のどちらも読めます。1 回 ${MAX_ROWS} 行まで。</p>
      <p><a href="#" data-tpl>ひな形をダウンロード</a></p>
      <p class="alert alert-error" data-err hidden></p>
      <label class="btn btn-primary">ファイルを選ぶ<input type="file" accept=".csv,.tsv,.txt,text/csv" data-file hidden></label>`;
    page.querySelector('[data-tpl]').addEventListener('click', (e) => {
      e.preventDefault();
      const blob = new Blob(['﻿部署,アドレス,役職,氏名\r\n営業部;開発部,taro@example.co.jp,MG,山田 太郎\r\n'], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'users-template.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    page.querySelector('[data-file]').addEventListener('change', async (e) => {
      const err = page.querySelector('[data-err]');
      err.hidden = true;
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = detectAndDecode(await file.arrayBuffer());
        rows = parseUserRows(parseCsv(text));
        if (!rows.length) throw new Error('読み込める行がありません。');
        if (rows.length > MAX_ROWS) throw new Error(`${MAX_ROWS} 行を超えています（${rows.length} 行）。分けて取り込んでください。`);
        await stepPreview();
      } catch (ex) { err.textContent = errorMessage(ex); err.hidden = false; }
    });
  }

  const payload = () => rows.map((r) => ({ department: r.department, email: r.email, position: r.position, displayName: r.displayName || undefined, row: r.row }));
  const dept = (v) => (Array.isArray(v) ? v.join(';') : v ?? '');
  const who = (u) => `${esc(u.displayName || '')} ${esc(u.email || '')}`;

  async function stepPreview() {
    const r = await api.post('/api/admin/users/import/preview', { rows: payload() });
    const create = r.create || [], update = r.update || [], unchanged = r.unchanged || [], errors = r.errors || [], nd = r.newDepartments || [];
    page.innerHTML = `${settingsNav('/admin/import')}<h1>内容を確かめる</h1>
      <p class="muted">まだ何も登録されていません。</p>
      <ul class="summary"><li>読み込み ${rows.length} 行</li><li>新しく登録 <b>${create.length}</b> 人</li><li>内容を変更 <b>${update.length}</b> 人</li><li>変更なし ${unchanged.length} 人</li><li>エラー <b>${errors.length}</b> 行</li></ul>
      ${create.length ? `<h2>新しく登録</h2><ul class="plain">${create.map((u) => `<li>${who(u)} ／ ${esc(dept(u.department ?? u.departments))} ／ ${esc(u.position)}</li>`).join('')}</ul>` : ''}
      ${update.length ? `<h2>内容を変更</h2><ul class="plain">${update.map((u) => `<li>${who(u.after || u.before || {})}<div class="change">${esc(dept(u.before?.department ?? u.before?.departments))} ／ ${esc(u.before?.position)} → ${esc(dept(u.after?.department ?? u.after?.departments))} ／ ${esc(u.after?.position)}</div></li>`).join('')}</ul>` : ''}
      ${nd.length ? `<h2>新しく作る部署（${nd.length} つ）</h2><ul class="plain">${nd.map((d) => `<li>${esc(d.name)}（${esc(d.count)} 人）${d.similarTo ? `<div class="alert alert-warn">既にある「${esc(d.similarTo)}」と似ています。書き間違いではありませんか。</div>` : ''}</li>`).join('')}</ul>` : ''}
      ${errors.length ? `<h2>エラー</h2><ul class="plain">${errors.map((x) => `<li class="err-row">${esc(x.row)} 行目 ${esc(x.email || '')} ${esc(x.message)}</li>`).join('')}</ul>` : ''}
      <div class="actions"><button type="button" class="btn" data-cancel>やめる</button>
        <button type="button" class="btn btn-primary" data-go ${create.length + update.length === 0 ? 'disabled' : ''}>${errors.length ? 'エラーの行を除いて登録する' : '登録する'}</button></div>`;
    page.querySelector('[data-cancel]').addEventListener('click', () => stepFile());
    page.querySelector('[data-go]').addEventListener('click', async (e) => {
      if (!(await confirmDialog(`${create.length} 人を登録、${update.length} 人を変更します。よろしいですか？`, { okLabel: '登録する' }))) return;
      e.target.disabled = true;
      try {
        const res = await api.post('/api/admin/users/import', { rows: payload(), skipErrors: true });
        resetDepartmentCache();
        toast('登録しました', 'success');
        stepFile(`登録 ${res.created} 人、変更 ${res.updated} 人、新しい部署 ${res.departmentsCreated} つ。`);
      } catch (ex) { toast(errorMessage(ex), 'error'); e.target.disabled = false; }
    });
  }

  stepFile();
}
