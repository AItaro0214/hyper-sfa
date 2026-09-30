// 認証。AWS 版は Cognito（Google）を画面が直接呼ぶ。Cloudflare 版は Cookie なので何も付けない。
import { state } from './state.js';

const TOKEN_KEY = 'hsfa.tokens';
const PKCE_KEY = 'hsfa.pkce';

function readTokens() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { return null; }
}
function writeTokens(t) {
  try { if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); else localStorage.removeItem(TOKEN_KEY); } catch { /* 保存できない環境ではログインが続かないだけ */ }
}

const isCognito = () => state.config && state.config.authMode === 'cognito-google';

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n = 48) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function tokenRequest(params) {
  const c = state.config.cognito;
  const res = await fetch(`${c.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, ...params }),
  });
  if (!res.ok) throw new Error('token');
  return res.json();
}

// リフレッシュトークンで ID トークンを取り直す。失敗したらトークンを捨てる。
let refreshing = null;
export async function refreshSession() {
  if (!isCognito()) return false;
  const t = readTokens();
  if (!t || !t.refreshToken) return false;
  if (!refreshing) {
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken })
      .then((r) => {
        writeTokens({ idToken: r.id_token, refreshToken: r.refresh_token || t.refreshToken, expiresAt: Date.now() + r.expires_in * 1000 });
        return true;
      })
      .catch(() => { writeTokens(null); return false; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// 期限の 1 分前に更新しておく。リクエストが 401 になってから直すより体験が良い。
export async function getAuthHeader() {
  if (!isCognito()) return {};
  let t = readTokens();
  if (!t) return {};
  if (t.expiresAt - Date.now() < 60_000) {
    await refreshSession();
    t = readTokens();
  }
  return t ? { Authorization: `Bearer ${t.idToken}` } : {};
}

export async function startCognitoLogin() {
  const c = state.config.cognito;
  const verifier = randomString(64);
  const oauthState = randomString(16);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state: oauthState }));
  const q = new URLSearchParams({
    response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri,
    scope: 'openid email profile', identity_provider: 'Google',
    code_challenge_method: 'S256', code_challenge: challenge, state: oauthState,
  });
  location.href = `${c.domain}/oauth2/authorize?${q}`;
}

// /auth/callback で呼ぶ。{ ok: true } か { ok: false, error } を返す。
export async function handleCognitoCallback() {
  const q = new URLSearchParams(location.search);
  if (q.get('error')) {
    return { ok: false, error: q.get('error_description') || q.get('error'), denied: true };
  }
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null'); } catch { saved = null; }
  sessionStorage.removeItem(PKCE_KEY);
  if (!saved || !q.get('code') || q.get('state') !== saved.state) {
    return { ok: false, error: 'ログインをやり直してください。' };
  }
  try {
    const r = await tokenRequest({
      grant_type: 'authorization_code', code: q.get('code'),
      redirect_uri: state.config.cognito.redirectUri, code_verifier: saved.verifier,
    });
    writeTokens({ idToken: r.id_token, refreshToken: r.refresh_token, expiresAt: Date.now() + r.expires_in * 1000 });
    return { ok: true };
  } catch {
    return { ok: false, error: 'ログインに失敗しました。もう一度お試しください。' };
  }
}

// ログイン済みなら /api/me を返し、そうでなければ null。
export async function ensureLoggedIn() {
  const { api } = await import('./api.js');
  if (isCognito() && !readTokens()) return null;
  try {
    state.me = await api.get('/api/me');
    return state.me;
  } catch (e) {
    if (e.status === 401 || e.status === 403) { state.me = null; return null; }
    throw e;
  }
}

export async function passwordLogin(loginId, password) {
  const { api } = await import('./api.js');
  state.me = await api.post('/api/auth/login', { loginId, password });
  return state.me;
}

export async function logout() {
  const { api } = await import('./api.js');
  if (isCognito()) {
    writeTokens(null);
    state.me = null;
    const c = state.config.cognito;
    location.href = `${c.domain}/logout?client_id=${encodeURIComponent(c.clientId)}&logout_uri=${encodeURIComponent(location.origin + '/login')}`;
    return;
  }
  try { await api.post('/api/auth/logout'); } catch { /* すでに切れていてもログイン画面へ進める */ }
  state.me = null;
}
