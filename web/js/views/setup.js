// 利用者が 0 人のときの「最初の管理者を作る」画面（Cloudflare 版）。
import { state } from '../state.js';
import { toast } from '../ui.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { passwordLogin } from '../auth.js';

export function renderSetup(container) {
  container.innerHTML = `<div class="auth-card">
    <h1>最初の管理者を作る</h1>
    <p class="muted">はじめての利用です。管理者の ID とパスワードを決めてください。</p>
    <p class="alert alert-error" role="alert" id="err" hidden></p>
    <form id="f">
      <label class="field"><span>ID（3〜64 文字）</span><input name="loginId" autocomplete="username" autocapitalize="none" minlength="3" maxlength="64" required></label>
      <label class="field"><span>表示名</span><input name="displayName" autocomplete="name" required></label>
      <label class="field"><span>パスワード（10 文字以上）</span><input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
      <label class="field"><span>パスワード（確認）</span><input name="password2" type="password" autocomplete="new-password" minlength="10" required></label>
      <button class="btn btn-primary btn-block" type="submit">作成する</button>
    </form></div>`;
  const form = container.querySelector('#f');
  const errBox = container.querySelector('#err');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    errBox.hidden = true;
    if (fd.get('password') !== fd.get('password2')) {
      errBox.textContent = 'パスワードが一致しません。';
      errBox.hidden = false;
      return;
    }
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api.post('/api/auth/setup', { loginId: fd.get('loginId').trim(), displayName: fd.get('displayName').trim(), password: fd.get('password') });
      state.config.setupRequired = false;
      await passwordLogin(fd.get('loginId').trim(), fd.get('password'));
      toast('管理者を作成しました');
      navigate('/', { replace: true });
    } catch (ex) {
      errBox.textContent = ex.message;
      errBox.hidden = false;
      btn.disabled = false;
    }
  });
}
