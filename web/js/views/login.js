// ログイン画面。authMode で切り替える。
import { state } from '../state.js';
import { esc, toast } from '../ui.js';
import { navigate } from '../router.js';
import { startCognitoLogin, passwordLogin } from '../auth.js';

export function renderLogin(container, _params, query) {
  const cfg = state.config;
  const next = query && query.next && query.next.startsWith('/') && !query.next.startsWith('//') ? query.next : '/';
  const err = state.authError;
  state.authError = null;
  if (cfg.authMode === 'cognito-google') {
    container.innerHTML = `<div class="auth-card">
      <h1>${esc(cfg.appName || 'hyper-sfa')}</h1>
      ${err ? `<p class="alert alert-error" role="alert">${esc(err)}</p>` : ''}
      <button type="button" class="btn btn-primary btn-block" id="google">Google でログイン</button>
    </div>`;
    container.querySelector('#google').addEventListener('click', (e) => { e.target.disabled = true; startCognitoLogin(); });
    return;
  }
  container.innerHTML = `<div class="auth-card">
    <h1>${esc(cfg.appName || 'hyper-sfa')}</h1>
    <p class="alert alert-error" role="alert" id="err" ${err ? '' : 'hidden'}>${esc(err || '')}</p>
    <form id="f" autocomplete="on">
      <label class="field"><span>ID</span><input name="loginId" autocomplete="username" autocapitalize="none" required></label>
      <label class="field"><span>パスワード</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn-primary btn-block" type="submit">ログイン</button>
    </form></div>`;
  const form = container.querySelector('#f');
  const errBox = container.querySelector('#err');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    errBox.hidden = true;
    try {
      const fd = new FormData(form);
      await passwordLogin(fd.get('loginId').trim(), fd.get('password'));
      toast('ログインしました');
      navigate(next, { replace: true });
    } catch (ex) {
      errBox.textContent = ex.status === 401 ? 'ID またはパスワードが違います。' : ex.message;
      errBox.hidden = false;
      btn.disabled = false;
    }
  });
}
