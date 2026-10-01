// 画面の見た目を撮る開発用ツール（mock-server を先に起動しておく）。
// 使い方: node web/dev/shoot.mjs [port] [出力先] [theme: dark|light|both]
// Chrome を DevTools Protocol で操作し、390x844 と 1280x800 の両方で主要な画面を撮る。依存なし（Node の WebSocket を使う）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.argv[2] || '8791';
const OUT = path.resolve(process.argv[3] || path.join(here, 'shots'));
const THEMES = process.argv[4] === 'light' ? ['light'] : process.argv[4] === 'dark' ? ['dark'] : ['dark', 'light'];
const ONLY = process.argv[5] ? new Set(process.argv[5].split(',')) : null;
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = `http://localhost:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--remote-debugging-port=9333', `--user-data-dir=${profile}`,
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', 'about:blank'], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:9333/json'); const t = (await r.json()).find((x) => x.type === 'page'); if (t) return t.webSocketDebuggerUrl; } catch { /* まだ起動中 */ }
    await sleep(200);
  }
  throw new Error('chrome が起動しません');
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data);
  // 画面の JS が投げた例外は撮影の邪魔になるので、その場で知らせる
  if (m.method === 'Runtime.exceptionThrown') console.log('  ** JS 例外:', (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).split(String.fromCharCode(10))[0]); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => { ws.send(JSON.stringify({ id: 9999, method: 'Runtime.enable' })); setTimeout(r, 100); });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.value; };

async function go(url, wait = 1400) { await send('Page.navigate', { url }); await sleep(wait); }
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  // はみ出しの自動検査: 横スクロールが出ていれば警告する
  const over = await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  console.log(`${name}.png${over > 0 ? `  ** 横にはみ出し ${over}px` : ''}`);
}
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.click(); return !!e; })()`);

// 名刺の読み取り（mock の scan → review）。ファイル入力に小さな PNG を入れる
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function setFile() {
  await ev(`(async () => {
    const b = await (await fetch('/mock-img/c1.svg')).blob();
    const c = document.createElement('canvas'); c.width = 640; c.height = 400; const x = c.getContext('2d');
    const img = new Image(); img.src = URL.createObjectURL(b); await img.decode(); x.drawImage(img, 0, 0, 640, 400);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'card.jpg', { type: 'image/jpeg' }));
    const inp = document.querySelector('input[data-file=front]'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

const VIEWS = [['390x844', 390, 844, true], ['1280x800', 1280, 800, false]];
const want = (n) => !ONLY || ONLY.has(n);

for (const theme of THEMES) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  for (const [label, w, h, mobile] of VIEWS) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
    const n = (s) => `${s}-${label}-${theme}`;
    // ログイン（未ログイン状態にしてから）
    if (want('login')) {
      await go(`${BASE}/api/auth/logout`, 100).catch(() => {});
      await ev(`fetch('/api/auth/logout', { method: 'POST' })`).catch(() => {});
      await go(`${BASE}/login`);
      await shot(n('login'));
    }
    await go(`${BASE}/dev/login-as?user=admin`);
    if (want('home')) { await go(`${BASE}/`, 1600); await shot(n('home')); }
    if (want('home-more') && theme === 'dark') {
      await ev(`document.querySelector('.more').open = true`); await sleep(300); await shot(n('home-more'));
    }
    if (want('home-panel') && theme === 'dark') { await go(`${BASE}/`, 1200); await click('[data-edit]'); await sleep(900); await shot(n('home-panel')); }
    if (want('detail')) { await go(`${BASE}/cards/c2`, 1600); await shot(n('detail')); }
    if (want('new') && theme === 'dark') {
      await go(`${BASE}/cards/new`, 900); await shot(n('new-pick'));
      await setFile(); await sleep(500); await click('[data-go]'); await sleep(900); await shot(n('new-wait'));
      await sleep(4800); await shot(n('new-review'));
    }
    if (want('minutes-list') && theme === 'dark') { await go(`${BASE}/minutes`, 1500); await shot(n('minutes-list')); }
    if (want('minutes-new') && theme === 'dark') {
      await go(`${BASE}/minutes/new`, 900); await shot(n('minutes-choose'));
      const ok = await click('[data-kind=room]'); await sleep(300);
      if (ok) { await click('[data-start]'); await sleep(2500); await shot(n('minutes-rec')); }
    }
    if (want('minutes-detail') && theme === 'dark') { await go(`${BASE}/minutes/m1`, 1800); await shot(n('minutes-detail')); }
    if (want('admin') && theme === 'dark') { await go(`${BASE}/admin/users`, 1500); await shot(n('admin-users')); }
    if (want('models')) { await go(`${BASE}/developer/models`, 1800); await shot(n('dev-models')); }
  }
}
ws.close();
chrome.kill();
process.exit(0);
