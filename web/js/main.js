// 起動: /api/config → 認証 → /api/me → ルーター開始。
import { api, setUnauthorizedHandler } from './api.js';
import { ensureLoggedIn, logout, handleCognitoCallback } from './auth.js';
import { state } from './state.js';
import { registerRoute, setGuard, setContainerProvider, onNavigated, navigate, start } from './router.js';
import { esc, el, toast } from './ui.js';
import { renderLogin } from './views/login.js';
import { renderSetup } from './views/setup.js';
import { renderPasswordChange } from './views/password.js';
import { renderHome } from './views/home.js';
import { renderCardNew } from './views/cardNew.js';
import { renderCardDetail } from './views/cardDetail.js';
import { renderAdminUsers } from './views/admin/users.js';
import { renderAdminDepartments } from './views/admin/departments.js';
import { renderAdminHistory } from './views/admin/history.js';
import { renderAdminImport } from './views/admin/import.js';
import { renderDevKeys } from './views/dev/keys.js';
import { renderDevModels } from './views/dev/models.js';
import { renderDevPrompts } from './views/dev/prompts.js';
import { renderDevExport } from './views/dev/export.js';
import { renderDevUsage } from './views/dev/usage.js';
import { renderDevAudit } from './views/dev/audit.js';

const app = document.getElementById('app');

// 議事録の画面は別ファイル。無くても名刺の画面は動かす。
async function loadMinutes() {
  try {
    const mod = await import('./views/minutes/index.js');
    if (typeof mod.registerMinutesRoutes === 'function') mod.registerMinutesRoutes();
    return mod;
  } catch (e) {
    console.warn('議事録の画面を読み込めませんでした', e && e.message);
    return null;
  }
}

function registerRoutes(minutesMod) {
  registerRoute('/login', renderLogin, { bare: true, public: true });
  registerRoute('/setup', renderSetup, { bare: true, public: true });
  registerRoute('/password', renderPasswordChange, { bare: true });
  registerRoute('/', (c, p, q) => renderHome(c, p, q, minutesMod));
  registerRoute('/cards/new', renderCardNew);
  registerRoute('/cards/:id', renderCardDetail);
  registerRoute('/admin', () => navigate('/admin/users', { replace: true }), { cap: 'admin' });
  registerRoute('/admin/users', renderAdminUsers, { cap: 'admin' });
  registerRoute('/admin/departments', renderAdminDepartments, { cap: 'admin' });
  registerRoute('/admin/history', renderAdminHistory, { cap: 'viewHistory' });
  registerRoute('/admin/import', renderAdminImport, { cap: 'admin' });
  registerRoute('/developer', () => navigate('/developer/keys', { replace: true }), { cap: 'dev' });
  registerRoute('/developer/keys', renderDevKeys, { cap: 'dev' });
  registerRoute('/developer/models', renderDevModels, { cap: 'dev' });
  registerRoute('/developer/prompts', renderDevPrompts, { cap: 'dev' });
  registerRoute('/developer/export', renderDevExport, { cap: 'dev' });
  registerRoute('/developer/usage', renderDevUsage, { cap: 'dev' });
  registerRoute('/developer/audit', renderDevAudit, { cap: 'dev' });
}

// 画面の出し分けは見た目だけ。本当の判定はサーバーがする。
setGuard((route, path) => {
  const o = route.options || {};
  if (state.config && state.config.setupRequired && path !== '/setup') return '/setup';
  if (!state.me) {
    if (o.public) return null;
    const next = path + location.search;
    return path === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
  }
  if (state.me.mustChangePassword && path !== '/password') return '/password';
  if (path === '/login' || path === '/setup') return '/';
  if (o.cap && !(state.me.capabilities || {})[o.cap]) return '/';
  return null;
});

function buildShell() {
  const c = state.me.capabilities || {};
  const f = state.config.features || {};
  const settings = c.admin ? '/admin/users' : c.dev ? '/developer/keys' : null;
  const shell = el(`<div class="shell">
    <header class="topbar">
      <a class="brand" href="/">${esc(state.config.appName || 'hyper-sfa')}</a>
      <nav class="nav" aria-label="メイン">
        <a href="/" data-nav="/">名刺を探す</a>
        ${c.register ? '<a href="/cards/new" data-nav="/cards/new">登録</a>' : ''}
        ${f.minutes ? '<a href="/minutes" data-nav="/minutes">議事録</a>' : ''}
        ${settings ? `<a href="${settings}" data-nav="/admin /developer">${state.config.edition === 'cloudflare' ? '設定' : '管理'}</a>` : ''}
      </nav>
      <details class="usermenu"><summary>${esc(state.me.displayName || state.me.loginId || state.me.email)}</summary>
        <div class="menu">
          ${state.config.authMode === 'password' ? '<a href="/password">パスワードを変える</a>' : ''}
          <button type="button" data-logout>ログアウト</button>
        </div></details>
    </header>
    <main id="view"></main></div>`);
  shell.querySelector('[data-logout]').addEventListener('click', async () => { await logout(); navigate('/login'); });
  app.replaceChildren(shell);
}

setContainerProvider((route) => {
  if (route.options && route.options.bare) {
    app.replaceChildren();
    return app;
  }
  if (!document.getElementById('view')) buildShell();
  return document.getElementById('view');
});

onNavigated((path) => {
  document.querySelectorAll('.nav a').forEach((a) => {
    const targets = a.dataset.nav.split(' ');
    const on = targets.some((t) => (t === '/' ? path === '/' : path === t || path.startsWith(t + '/')));
    a.classList.toggle('active', on);
  });
});

setUnauthorizedHandler(() => {
  if (!state.me) return;
  state.me = null;
  toast('ログインが切れました。もう一度ログインしてください。', 'error');
  navigate('/login');
});

async function boot() {
  try {
    state.config = await api.get('/api/config');
  } catch (e) {
    app.innerHTML = `<div class="page"><h1>読み込めませんでした</h1><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">再読み込み</button></div>`;
    return;
  }
  document.title = state.config.appName || 'hyper-sfa';
  if (location.pathname === '/auth/callback') {
    const r = await handleCognitoCallback();
    if (!r.ok) {
      state.authError = r.denied ? 'このアカウントは登録されていません。管理者に連絡してください。' : r.error;
      history.replaceState(null, '', '/login');
    } else {
      history.replaceState(null, '', '/');
    }
  }
  if (!state.config.setupRequired) {
    try { await ensureLoggedIn(); } catch (e) {
      app.innerHTML = `<div class="page"><h1>読み込めませんでした</h1><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">再読み込み</button></div>`;
      return;
    }
  }
  const minutesMod = await loadMinutes();
  registerRoutes(minutesMod);
  await start();
}

boot();
