// 起動: /api/config → 認証 → /api/me → ルーター開始。
import { api, setUnauthorizedHandler } from './api.js';
import { ensureLoggedIn, logout, handleCognitoCallback } from './auth.js';
import { state } from './state.js';
import { registerRoute, setGuard, setContainerProvider, onNavigated, navigate, start } from './router.js';
import { esc, el, toast, currentTheme, toggleTheme, APP_NAME } from './ui.js';
import { icon, logoSvg } from './icons.js';

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
import { renderDevPositions } from './views/dev/positions.js';

const app = document.getElementById('app');

// ユーザーメニューの外を押したら閉じる（1 回だけ登録する）
document.addEventListener('click', (e) => {
  const d = document.querySelector('.usermenu');
  if (d && d.open && !d.contains(e.target)) d.open = false;
});

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
  registerRoute('/developer/positions', renderDevPositions, { cap: 'dev' });
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
  const who = state.me.displayName || state.me.loginId || state.me.email || '';
  const appName = state.config.appName || APP_NAME;
  const themeLabel = () => (currentTheme() === 'dark' ? 'ライトにする' : 'ダークにする');
  const shell = el(`<div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="${esc(appName)}">${logoSvg(30)}<span class="brand-name">${esc(appName)}</span></a>
      <details class="usermenu"><summary aria-label="アカウント"><span class="avatar">${esc([...who][0] || '?')}</span><span class="uname">${esc(who)}</span></summary>
        <div class="menu">
          <button type="button" data-theme>${icon('settings')}<span data-theme-label>${themeLabel()}</span></button>
          ${state.config.authMode === 'password' ? `<a href="/password">${icon('key')}パスワードを変える</a>` : ''}
          <button type="button" data-logout>${icon('logout')}ログアウト</button>
        </div></details>
    </header>
    <nav class="nav" aria-label="メイン">
      <a href="/" data-nav="/">${icon('card', 22)}<span>名刺</span></a>
      ${c.register ? `<a href="/cards/new" data-nav="/cards/new">${icon('camera', 22)}<span>登録</span></a>` : ''}
      ${f.minutes ? `<a href="/minutes" data-nav="/minutes">${icon('mic', 22)}<span>議事録</span></a>` : ''}
      ${settings ? `<a href="${settings}" data-nav="/admin /developer">${icon('settings', 22)}<span>${state.config.edition === 'cloudflare' ? '設定' : '管理'}</span></a>` : ''}
    </nav>
    <main id="view"></main></div>`);
  shell.querySelector('[data-logout]').addEventListener('click', async () => { await logout(); navigate('/login'); });
  shell.querySelector('[data-theme]').addEventListener('click', () => {
    toggleTheme();
    shell.querySelector('[data-theme-label]').textContent = themeLabel();
  });
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
  document.title = state.config.appName || APP_NAME;
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
