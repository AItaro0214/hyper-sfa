// パスワード変更。仮パスワードのまま入った人（mustChangePassword）はここから先へ進めない。
import { state } from '../state.js';
import { toast } from '../ui.js';
import { api } from '../api.js';
import { navigate } from '../router.js';

export function renderPasswordChange(container) {
  const must = state.me && state.me.mustChangePassword;
  container.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <h1 style="font-size:1.3rem;margin:0 0 8px">パスワードを変える</h1>
    ${must ? '<p class="muted">仮パスワードでログインしています。新しいパスワードを決めてください。</p>' : ''}
    <p class="alert alert-error" role="alert" id="err" hidden></p>
    <form id="f">
      <label class="field"><span>いまのパスワード</span><input name="cur" type="password" autocomplete="current-password" required></label>
      <label class="field"><span>新しいパスワード（10 文字以上）</span><input name="np" type="password" autocomplete="new-password" minlength="10" required></label>
      <label class="field"><span>新しいパスワード（確認）</span><input name="np2" type="password" autocomplete="new-password" minlength="10" required></label>
      <button class="btn btn-primary btn-block" type="submit">変更する</button>
      ${must ? '' : '<a class="btn btn-block" href="/">やめる</a>'}
    </form></div></div>`;
  const form = container.querySelector('#f');
  const errBox = container.querySelector('#err');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    errBox.hidden = true;
    if (fd.get('np') !== fd.get('np2')) { errBox.textContent = '新しいパスワードが一致しません。'; errBox.hidden = false; return; }
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api.post('/api/auth/change-password', { currentPassword: fd.get('cur'), newPassword: fd.get('np') });
      state.me.mustChangePassword = false;
      toast('パスワードを変更しました');
      navigate('/', { replace: true });
    } catch (ex) {
      errBox.textContent = ex.message;
      errBox.hidden = false;
      btn.disabled = false;
    }
  });
}
