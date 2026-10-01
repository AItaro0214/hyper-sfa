// ログイン画面。authMode で切り替える。
import { state } from '../state.js';
import { esc, toast, APP_NAME } from '../ui.js';
import { logoSvg } from '../icons.js';
import { navigate } from '../router.js';
import { startCognitoLogin, passwordLogin } from '../auth.js';

// Google の「G」。公式の 4 色のマーク。
const GOOGLE_G = '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.3 5.7c4.3-4 6.8-9.9 7-17.1z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.9 2.3-8.6 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';

export function renderLogin(container, _params, query) {
  const cfg = state.config;
  const next = query && query.next && query.next.startsWith('/') && !query.next.startsWith('//') ? query.next : '/';
  const err = state.authError;
  const head = `<div class="auth-logo">${logoSvg(52)}<h1>${esc(cfg.appName || APP_NAME)}</h1><p>名刺とミーティングの記録</p></div>`;
  state.authError = null;
  if (cfg.authMode === 'cognito-google') {
    container.innerHTML = `<div class="auth-wrap"><div class="auth-card">
      ${head}
      ${err ? `<p class="alert alert-error" role="alert">${esc(err)}</p>` : ''}
      <button type="button" class="btn btn-google btn-block btn-lg" id="google">${GOOGLE_G}Google でログイン</button>
    </div></div>`;
    container.querySelector('#google').addEventListener('click', (e) => { e.currentTarget.disabled = true; startCognitoLogin(); });
    return;
  }
  container.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    ${head}
    <p class="alert alert-error" role="alert" id="err" ${err ? '' : 'hidden'}>${esc(err || '')}</p>
    <form id="f" autocomplete="on">
      <label class="field"><span>ID</span><input name="loginId" autocomplete="username" autocapitalize="none" required></label>
      <label class="field"><span>パスワード</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn-primary btn-block btn-lg" type="submit">ログイン</button>
    </form></div></div>`;
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
