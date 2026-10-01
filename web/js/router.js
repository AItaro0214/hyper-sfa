// History API の小さなルーター。パターンは '/cards/:id' 形式。
const routes = [];
let guard = () => null;
let containerFor = () => document.getElementById('app');
let afterNavigate = () => {};
let cleanup = null;
let token = 0;

// options: { bare: 枠（ヘッダー）なしで描く, public: ログイン不要, cap: 必要な capabilities のキー }
export function registerRoute(pattern, render, options = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  routes.push({ pattern, re, keys, render, options });
}
export function setGuard(fn) { guard = fn; }
export function setContainerProvider(fn) { containerFor = fn; }
export function onNavigated(fn) { afterNavigate = fn; }

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  return run();
}

function match(pathname) {
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
  }
  return null;
}

async function run() {
  const my = ++token;
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* 画面を離れるだけなので無視 */ } }
  cleanup = null;
  const url = new URL(location.href);
  const m = match(url.pathname);
  const route = m ? m.route : { options: {}, render: notFound };
  const redirect = guard(route, url.pathname);
  if (redirect && redirect !== url.pathname + url.search) {
    history.replaceState(null, '', redirect);
    return run();
  }
  // 画面の入れ替えだけを View Transition で包む（描画の待ち時間まで凍らせないため、描画本体は外に出す）。
  // 未対応や「動きを減らす」設定のときは、CSS の enter アニメーションだけで切り替える。
  let container;
  const swap = () => { container = containerFor(route); container.replaceChildren(); window.scrollTo(0, 0); afterNavigate(url.pathname); };
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !reduced && document.getElementById('view')) {
    try { await document.startViewTransition(swap).updateCallbackDone; } catch { if (!container) swap(); }
  } else swap();
  if (my !== token) return;
  const query = Object.fromEntries(url.searchParams);
  const result = await route.render(container, m ? m.params : {}, query);
  if (my === token) cleanup = result;
  else if (typeof result === 'function') result();
}

function notFound(container) {
  container.innerHTML = '<div class="page"><h1>ページが見つかりません</h1><p><a href="/">名刺を探す</a></p></div>';
}

export function start() {
  window.addEventListener('popstate', run);
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/')) return;
    e.preventDefault();
    navigate(href);
  });
  return run();
}
