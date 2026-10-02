// 画面の動作確認用の簡易サーバー。バックエンドの代わりに固定データを返す（依存なし）。
// 使い方: node web/dev/mock-server.mjs [port]   ログイン: admin / password123
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODELS } from '../../packages/core/src/models.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '..');
const CORE = path.resolve(WEB, '../packages/core/src');
const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

const ME = {
  id: 'u1', email: 'admin@example.co.jp', loginId: 'admin', displayName: '山田 管理', position: '開発者', level: 'dev',
  deptIds: ['d1'], departments: [{ id: 'd1', name: '営業部' }], mustChangePassword: false,
  capabilities: { seeAllCards: true, editCards: true, deleteAnyCard: true, assignOtherDepts: true, register: true, admin: true, dev: true, viewHistory: true },
};
let POSITIONS = [['開発者', 'dev'], ['役員', 'org_admin'], ['GM', 'org_admin'], ['SMG', 'org_admin'], ['MG', 'org_edit'], ['SubMG', 'org_edit'], ['EX', 'dept_edit'], ['社員A', 'dept_edit'], ['社員B', 'dept_view'], ['協力会社', 'dept_view']].map(([name, level], i) => ({ name, level, order: i + 1 }));
const DEPTS = [{ id: 'd1', name: '営業部', order: 1, active: true }, { id: 'd2', name: '開発部', order: 2, active: true }, { id: 'd3', name: '総務部', order: 3, active: true }];
const USERS = [
  { id: 'u1', email: 'admin@example.co.jp', loginId: 'admin', displayName: '山田 管理', position: '開発者', role: 'admin', deptIds: ['d1'], departments: [{ id: 'd1', name: '営業部' }], status: 'active', lastLoginAt: new Date().toISOString() },
  { id: 'u2', email: 'hanako@example.co.jp', loginId: 'hanako', displayName: '佐藤 花子', position: 'MG', role: 'member', deptIds: ['d1', 'd2'], departments: [{ id: 'd1', name: '営業部' }, { id: 'd2', name: '開発部' }], status: 'invited', lastLoginAt: null },
];
const card = (i, o = {}) => ({
  id: `c${i}`, status: 'confirmed', company: `株式会社サンプル${i}`, department: '営業部', title: '営業部長', name: `田中 太郎${i}`, nameReading: 'たなか たろう',
  phones: ['03-1234-5678'], mobiles: ['090-1234-5678'], emails: [`taro${i}@example.co.jp`], note: '資格: 一級建築士', rawText: 'raw',
  deptIds: ['d1'], departments: [{ id: 'd1', name: '営業部' }], imageUrls: { thumb: `/mock-img/c${i}.svg`, front: `/mock-img/c${i}.svg`, back: null },
  createdBy: { id: 'u2', name: '佐藤 花子' }, createdAt: new Date().toISOString(), updatedBy: { id: 'u1', name: '山田 管理' }, updatedAt: new Date().toISOString(),
  editCount: 1, scanCount: 1, version: 1, failure: null, ...o,
});
const CARDS = Array.from({ length: 75 }, (_, i) => card(i + 1));
// 取引先の確認用: 同じ会社で部署違い、表記ゆれ（（株）の位置違い）
CARDS.push(
  card(76, { company: '株式会社サンプル1', department: '開発部', title: '部長', name: '鈴木 一郎' }),
  card(77, { company: '株式会社サンプル1', department: '開発部', title: '主任', name: '高橋 二郎' }),
  card(78, { company: '株式会社サンプル1', department: '総務部', title: '課長', name: '伊藤 三郎' }),
  card(79, { company: 'サンプル1（株）', department: '営業部', title: '係長', name: '渡辺 四郎' }),
);
const scans = new Map();
let loggedIn = false;
let devSettings = { keys: { gemini: { configured: true, last4: 'ab12', updatedAt: new Date().toISOString() }, openai: { configured: false } }, models: { card: 'gemini-3.5-flash-lite', transcribe: 'gemini-3.5-flash-lite', summarize: 'gemini-3.6-flash', qa: 'gemini-3.6-flash' }, prompts: {} };
// 一覧は共通ロジックの初期値をそのまま使う（tier / status / note もそのまま出る）。無効の例を 1 件足す
const MODELS = [...DEFAULT_MODELS.map((m) => structuredClone(m)), { id: 'custom-test', provider: 'openai', label: 'カスタム試験モデル', uses: ['summarize'], pricing: { input: 1, output: 4 }, status: 'preview', note: '手で追加したモデル', active: false, builtin: false }];
const PROMPTS = { card: 'カード用プロンプト', transcribe: '文字起こし用 {{TITLE}}', summarize: '議事録用 {{TRANSCRIPT}}' };
const promptVer = { card: 1, transcribe: 1, summarize: 1 };

const send = (res, status, body, headers = {}) => {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(data);
};
const err = (res, status, code, message, details) => send(res, status, { error: { code, message, details } });
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { const t = Buffer.concat(c).toString(); try { r(t ? JSON.parse(t) : {}); } catch { r({}); } }); });

function cardView(c) {
  const s = scans.get(c.id);
  if (s && c.status === 'processing' && Date.now() - s > 2500) c.status = 'review';
  return c;
}
// 表記ゆれを吸収する簡易版（本物は core の companyKey）
const companyKey = (s) => norm(s).replace(/株式会社|有限会社|\(株\)|（株）|\s|　/g, '');
function groupCompanies(q, limit) {
  const key = companyKey(q);
  const by = new Map();
  for (const c of CARDS) {
    if (c.status !== 'confirmed' || !c.company) continue;
    const k = companyKey(c.company);
    if (key && !k.includes(key)) continue;
    if (!by.has(k)) by.set(k, { key: k, cards: [] });
    by.get(k).cards.push(c);
  }
  const jp = (a, b) => String(a).localeCompare(String(b), 'ja');
  return [...by.values()].map(({ key: k, cards }) => {
    const freq = new Map();
    cards.forEach((c) => freq.set(c.company, (freq.get(c.company) || 0) + 1));
    const company = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const deps = new Map();
    cards.forEach((c) => { const n = c.department || ''; if (!deps.has(n)) deps.set(n, []); deps.get(n).push({ id: c.id, name: c.name, title: c.title }); });
    const departments = [...deps.entries()].sort((a, b) => jp(a[0], b[0])).map(([name, people]) => ({ name, count: people.length, people: people.sort((a, b) => jp(a.name, b.name)) }));
    return { company, key: k, count: cards.length, departments };
  }).sort((a, b) => b.count - a.count).slice(0, limit);
}
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();

// 議事録 1 件（資料の確認用）。再作成は 3 秒ごとに 目次 → 資料を踏まえて作成 → 完了 と進む。
const MATS = [{ id: 'mat1', seq: 1, name: '提案書_v3.pdf', kind: 'pdf', size: 2400000, pages: 18, outlineStatus: 'done', uploadedBy: { id: 'u1', name: '山田 管理' }, uploadedAt: new Date().toISOString() }];
const MIN = { job: null, withMaterials: false, summaryVersion: 1, summaryMd: '## 要点\n- 見積りの提示\n- 来月の再訪が決定' };
const MIN_TRANSCRIPT = ['[00:00:05] 本日はありがとうございます。', '[00:05:30] まず売上の推移です。', '[00:12:10] 地域別では関西が伸びています。', '[00:18:40] 次にご提案の内容です。', '[00:30:00] 以上です。'].join('\n');
// 質問タブの見本。画面確認用に最初から 1 往復入れておく
const CHAT = { seq: 3, items: [
  { seq: 1, role: 'user', text: '関西の売上はどうでしたか？', modelId: null, createdAt: new Date().toISOString() },
  { seq: 2, role: 'assistant', text: '前年より伸びています。[00:12:10] で「地域別では関西が伸びています」と説明されていました。', modelId: 'gemini-3.6-flash', createdAt: new Date().toISOString() },
] };
const MIN_MAPPING = () => [
  { material: 'mat1', materialName: '提案書_v3.pdf', page: 7, start: '00:12:10', end: '00:18:40', confidence: 'high' },
  { material: 'mat1', materialName: '提案書_v3.pdf', page: 9, start: '00:18:40', end: '00:29:00', confidence: 'low' },
];
function minuteView() {
  if (MIN.job) {
    const dt = Date.now() - MIN.job.at;
    if (dt > 6000 || (dt > 3000 && !MIN.job.withMaterials)) {
      MIN.withMaterials = MIN.job.withMaterials;
      MIN.summaryVersion++;
      MIN.summaryMd = MIN.withMaterials
        ? '## 要点\n- 資料を踏まえた要点\n## 資料に沿った話の内容\n### 提案書_v3.pdf  スライド 7「地域別売上」（00:12:10〜00:18:40）\n- 関西が前年比で伸びている'
        : '## 要点\n- 作り直した版';
      MIN.job = null;
    }
  }
  const dt = MIN.job ? Date.now() - MIN.job.at : 0;
  const step = !MIN.job ? undefined : MIN.job.withMaterials ? (dt < 3000 ? 'outline' : 'summarize_materials') : 'summarize';
  return {
    id: 'm1', title: 'サンプル商談（モック）', heldAt: new Date().toISOString(), mode: 'web', durationSec: 1800, memo: '', status: MIN.job ? 'summarizing' : 'done', progress: step ? { step } : null, failure: null,
    owner: { id: 'u1', name: '山田 管理' }, relation: 'owner', counterparts: [{ cardId: null, company: '株式会社サンプル', department: '', name: '田中 太郎', cardVisible: false }],
    attendees: [], shares: [], audio: { available: false, deleted: true },
    transcript: { version: 1, createdAt: new Date().toISOString(), modelId: 'mock', hasPrevious: false },
    summary: { version: MIN.summaryVersion, createdAt: new Date().toISOString(), modelId: 'mock', hasPrevious: MIN.summaryVersion > 1, withMaterials: MIN.withMaterials, materialIds: MATS.map((x) => x.id) },
    materials: MATS.filter((x) => !x.pending),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

async function api(req, res, url) {
  const p = url.pathname, m = req.method, q = url.searchParams;
  const body = ['POST', 'PUT', 'PATCH'].includes(m) ? await readBody(req) : {};
  let g;
  if (p === '/api/config') return send(res, 200, { appName: 'hyper-sfa (mock)', edition: 'cloudflare', authMode: 'password', features: { departments: true, positions: true, userImport: true, minutes: true }, limits: { scanPerDay: 200, recordingMaxSec: 7200, segmentSec: 600 }, setupRequired: false });
  if (p === '/api/auth/login') {
    if (body.loginId === 'admin' && body.password === 'password123') { loggedIn = true; return send(res, 200, ME, { 'Set-Cookie': 'sid=mock; Path=/; HttpOnly' }); }
    return err(res, 401, 'unauthorized', 'ID またはパスワードが違います');
  }
  if (p === '/api/auth/logout') { loggedIn = false; return send(res, 200, {}, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }); }
  if (p === '/api/auth/change-password') return send(res, 200, {});
  if (!loggedIn) return err(res, 401, 'unauthorized', 'ログインしてください');
  if (p === '/api/me') return send(res, 200, ME);
  if (p === '/api/departments') return send(res, 200, { items: DEPTS });
  if (p === '/api/directory') return send(res, 200, { items: USERS.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, departments: u.departments })) });
  if (p === '/api/uploads') return send(res, 200, { uploads: (body.kinds || []).map((k) => ({ kind: k, key: `k-${k}-${Date.now()}`, url: `/mock-upload/${k}`, method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } })) });
  if (m === 'PUT' && p.startsWith('/api/uploads/')) return send(res, 200, { ok: true });
  if ((g = p.match(/^\/api\/cards\/([^/]+)\/images\/(replace|optimized)$/)) && m === 'POST') {
    const c = CARDS.find((x) => x.id === g[1]);
    if (!c) return err(res, 404, 'not_found', '名刺が見つかりません');
    if (g[2] === 'replace') {
      const kinds = ['front', ...(c.imageUrls.back ? ['back'] : [])];
      return send(res, 200, { uploads: kinds.map((kind) => ({ kind, url: `/api/uploads/cards/${'0'.repeat(26)}/${kind}.jpg`, method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } })) });
    }
    c.imageOptimized = true; c.imageOptimizedAt = new Date().toISOString();
    return send(res, 200, { imageOptimized: true, imageOptimizedAt: c.imageOptimizedAt });
  }
  if (p === '/api/cards/scan') {
    const id = `c${CARDS.length + 1}`;
    CARDS.unshift(card(CARDS.length + 1, { id, status: 'processing', company: '株式会社読み取り', name: '新規 花子', version: 1, duplicates: [{ id: 'c1', company: '株式会社サンプル1', name: '田中 太郎1', reason: 'email' }] }));
    scans.set(id, Date.now());
    return send(res, 202, { id, status: 'processing' });
  }
  if (p === '/api/companies' && m === 'GET') return send(res, 200, { items: groupCompanies(q.get('q') || '', Math.min(Number(q.get('limit') || 20), 100)) });
  if (p === '/api/cards' && m === 'GET') {
    let items = CARDS.filter((c) => c.status !== 'failed');
    const has = (field, qv) => norm(qv).split(/\s+/).filter(Boolean).every((w) => norm(field).includes(w));
    if (q.get('company')) items = items.filter((c) => has(c.company, q.get('company')));
    if (q.get('name')) items = items.filter((c) => has(c.name, q.get('name')));
    if (q.get('department')) items = items.filter((c) => has(c.department, q.get('department')));
    if (q.get('email')) items = items.filter((c) => has(c.emails.join(' '), q.get('email')));
    if (q.get('phone')) items = items.filter((c) => (c.phones.concat(c.mobiles)).join('').replace(/\D/g, '').includes(q.get('phone').replace(/\D/g, '')));
    if (q.get('note')) items = items.filter((c) => has(c.note + ' ' + c.title, q.get('note')));
    if (q.get('dept')) items = items.filter((c) => c.deptIds.includes(q.get('dept')));
    const start = Number(q.get('cursor') || 0), limit = Number(q.get('limit') || 50);
    const page = items.slice(start, start + limit).map(({ rawText, ...r }) => r);
    return send(res, 200, { items: page, nextCursor: start + limit < items.length ? String(start + limit) : null, total: items.length });
  }
  if ((g = p.match(/^\/api\/cards\/([^/]+)(\/[a-z]+)?$/))) {
    const c = CARDS.find((x) => x.id === g[1]);
    if (!c) return err(res, 404, 'not_found', '名刺が見つかりません');
    const sub = g[2];
    if (!sub && m === 'GET') return send(res, 200, cardView(c));
    if (sub === '/status') { cardView(c); return send(res, 200, c.status === 'processing' ? { status: 'processing' } : { status: c.status, card: c }); }
    if (sub === '/rescan') { c.status = 'processing'; scans.set(c.id, Date.now()); return send(res, 202, { status: 'processing' }); }
    if (sub === '/minutes') return send(res, 200, { items: [{ id: 'm1', title: `${c.company} 定例`, heldAt: new Date().toISOString(), status: 'done' }], nextCursor: null });
    if (!sub && m === 'PUT') {
      if (body.version !== c.version) return err(res, 409, 'conflict', 'ほかの人が先に更新しました');
      Object.assign(c, { company: body.company, department: body.department, title: body.title ?? '', name: body.name, nameReading: body.nameReading, phones: body.phones, mobiles: body.mobiles, emails: body.emails, note: body.note, deptIds: body.deptIds || c.deptIds, version: c.version + 1, updatedAt: new Date().toISOString() });
      c.departments = c.deptIds.map((id) => DEPTS.find((d) => d.id === id)).filter(Boolean);
      if (body.confirm) c.status = 'confirmed';
      return send(res, 200, c);
    }
    if (!sub && m === 'DELETE') { CARDS.splice(CARDS.indexOf(c), 1); return send(res, 204); }
  }
  // ---- 議事録と資料（メモリ上。PUT は受けるだけ） ----
  // 録音の画面の確認用: 作成と区切りのアップロードを受けるだけ
  if (p === '/api/minutes' && m === 'POST') return send(res, 200, { id: 'rec1', segmentSec: 600 });
  // 音声ファイルのアップロード: 送り先を返すだけ（本文は /dev/upload-sink が読み捨てる）
  if (p === '/api/minutes/rec1/upload' && m === 'POST') {
    if (body.size > 600 * 1024 * 1024) return err(res, 400, 'validation', '600MB までです');
    return send(res, 200, { key: 'mock/upload/rec1', url: '/dev/upload-sink', method: 'PUT', headers: body.mime ? { 'Content-Type': body.mime } : {} });
  }
  if ((g = p.match(/^\/api\/minutes\/rec1(\/.*)?$/))) {
    if (/^\/segments$/.test(g[1] || '') && m === 'POST') return send(res, 200, { url: `/mock-upload/seg${body.seq}`, headers: {} });
    return send(res, 200, {});
  }
  if (m === 'PUT' && p.startsWith('/mock-upload/')) return send(res, 200, {});
  if (p === '/api/minutes' && m === 'GET') {
    const mv = minuteView();
    // department は相手の部署（見本は部署なしなので、指定されたら「営業部」だけ一致させる）
    if (q.get('department') && q.get('department') !== '営業部') return send(res, 200, { items: [], nextCursor: null });
    return send(res, 200, { items: [mv], nextCursor: null });
  }
  if ((g = p.match(/^\/api\/minutes\/m1(\/.*)?$/))) {
    const sub = g[1] || '';
    let h;
    if (!sub && m === 'GET') return send(res, 200, minuteView());
    if (!sub && m === 'DELETE') return send(res, 204);
    if (sub === '/chat') {
      if (m === 'GET') return send(res, 200, { items: CHAT.items, modelLabel: 'Gemini 3.6 Flash', available: true });
      if (m === 'DELETE') { CHAT.items = []; return send(res, 204); }
      if (m === 'POST') {
        const text = String(body.text || '').trim();
        if (!text) return err(res, 400, 'validation', '質問を入力してください');
        if (text.length > 2000) return err(res, 400, 'validation', '質問は 2,000 字までです');
        // 「エラー」を含む質問で失敗の表示を確かめられるようにする
        if (text.includes('エラー')) { await new Promise((r) => setTimeout(r, 800)); return err(res, 502, 'provider_error', 'モデルの呼び出しに失敗しました'); }
        await new Promise((r) => setTimeout(r, 1500));
        const now = new Date().toISOString();
        const question = { seq: CHAT.seq++, role: 'user', text, modelId: null, createdAt: now };
        const answer = { seq: CHAT.seq++, role: 'assistant', text: 'はい。**[00:12:10]** 付近で、地域別の売上の話があり、関西が伸びているという説明がありました。\n資料のスライド 7 の棒グラフを見ながらの話です。\n- 数字の細かい内容は、文字起こしには出てきません', modelId: 'gemini-3.6-flash', createdAt: now };
        CHAT.items.push(question, answer);
        return send(res, 200, { question, answer, usage: { inputTokens: 41200, outputTokens: 180 } });
      }
    }
    if (sub === '/transcript') return send(res, 200, { text: MIN_TRANSCRIPT, version: 1 });
    if (sub === '/summary') { minuteView(); return send(res, 200, { markdown: MIN.summaryMd, version: MIN.summaryVersion, withMaterials: MIN.withMaterials, ...(MIN.withMaterials ? { mapping: MIN_MAPPING() } : {}) }); }
    if (sub === '/audio-url') return err(res, 404, 'not_found', '音声は削除されました');
    if (sub === '/materials' && m === 'GET') return send(res, 200, { items: MATS });
    if (sub === '/materials' && m === 'POST') {
      if (MATS.length >= 5) return err(res, 400, 'validation', '資料は 5 件までです');
      if (body.size > 20 * 1024 * 1024) return err(res, 400, 'validation', '20MB までです');
      const seq = (MATS.length ? MATS[MATS.length - 1].seq : 0) + 1;
      const mat = { id: `mat${seq}`, seq, name: body.name, kind: body.kind, size: body.size, pages: null, outlineStatus: 'none', uploadedBy: { id: 'u1', name: '山田 管理' }, uploadedAt: new Date().toISOString(), pending: true };
      MATS.push(mat);
      return send(res, 200, { id: mat.id, seq, file: { url: `/mock-upload/mat/${mat.id}`, method: 'PUT', headers: {} }, extract: body.hasExtract ? { url: `/mock-upload/mat/${mat.id}.extract`, method: 'PUT', headers: {} } : null });
    }
    if ((h = sub.match(/^\/materials\/([^/]+)\/done$/)) && m === 'PUT') {
      const mat = MATS.find((x) => x.id === h[1]);
      if (!mat) return err(res, 404, 'not_found', '資料がありません');
      delete mat.pending;
      mat.pages = body.pages ?? (mat.kind === 'pdf' ? 18 : null);
      mat.outlineStatus = mat.kind === 'pdf' ? 'pending' : 'none';
      return send(res, 200, mat);
    }
    if ((h = sub.match(/^\/materials\/([^/]+)\/url$/))) {
      const mat = MATS.find((x) => x.id === h[1]);
      return mat ? send(res, 200, { url: '/mock-img/material', expiresAt: new Date(Date.now() + 300000).toISOString(), filename: mat.name }) : err(res, 404, 'not_found', '資料がありません');
    }
    if ((h = sub.match(/^\/materials\/([^/]+)$/)) && m === 'DELETE') { const i = MATS.findIndex((x) => x.id === h[1]); if (i >= 0) MATS.splice(i, 1); return send(res, 204); }
    if (sub === '/regenerate' && m === 'POST') {
      if (body.withMaterials && !MATS.length) return err(res, 400, 'validation', '資料がありません');
      MIN.job = { at: Date.now(), withMaterials: !!body.withMaterials };
      return send(res, 202, {});
    }
    if (sub === '/generate' && m === 'POST') return send(res, 202, {});
    return err(res, 404, 'not_found', `モックに無い API: ${m} ${p}`);
  }
  if (p === '/api/admin/users' && m === 'GET') return send(res, 200, { items: USERS });
  if (p === '/api/admin/users' && m === 'POST') { USERS.push({ id: `u${USERS.length + 1}`, loginId: body.loginId, email: body.email, displayName: body.displayName, position: body.position, role: body.role, deptIds: [], departments: [], status: 'invited' }); return send(res, 200, { tempPassword: 'Tmp-Pass-1234' }); }
  if ((g = p.match(/^\/api\/admin\/users\/([^/]+)$/)) && m === 'PATCH') { const u = USERS.find((x) => x.id === g[1]); if (u) { Object.assign(u, body); if (body.deptIds) u.departments = body.deptIds.map((id) => DEPTS.find((d) => d.id === id)).filter(Boolean); } return send(res, 200, u || {}); }
  if (p.endsWith('/temp-password')) return send(res, 200, { tempPassword: 'New-Temp-5678' });
  if (p === '/api/admin/users/import/preview') return send(res, 200, { create: (body.rows || []).slice(0, 2).map((r) => ({ ...r })), update: [], unchanged: [], errors: (body.rows || []).length > 2 ? [{ row: 3, email: body.rows[2].email, message: '会社のドメインではありません' }] : [], newDepartments: [{ name: '営業 部', count: 1, similarTo: '営業部' }] });
  if (p === '/api/admin/users/import') return send(res, 200, { created: 2, updated: 0, departmentsCreated: 1 });
  if (p === '/api/admin/departments' && m === 'GET') return send(res, 200, { items: DEPTS });
  if (p === '/api/admin/departments' && m === 'POST') { DEPTS.push({ id: `d${DEPTS.length + 1}`, name: body.name, order: body.order, active: true }); return send(res, 200, {}); }
  if ((g = p.match(/^\/api\/admin\/departments\/([^/]+)$/)) && m === 'PATCH') { Object.assign(DEPTS.find((d) => d.id === g[1]) || {}, body); return send(res, 200, {}); }
  if (p === '/api/admin/history') return send(res, 200, { items: [{ id: 'h1', type: 'edit', at: new Date().toISOString(), actor: { id: 'u2', name: '佐藤 花子', deptName: '営業部' }, source: 'search', card: { id: 'c1', company: '株式会社サンプル1', name: '田中 太郎1' }, changes: [{ field: 'phones', before: ['03-1234-5678'], after: ['03-1234-5679'] }] }, { id: 'h2', type: 'create', at: new Date().toISOString(), actor: { id: 'u2', name: '佐藤 花子', deptName: '営業部' }, source: 'review', card: { id: 'c2', company: '株式会社サンプル2', name: '田中 太郎2' }, changes: [] }], nextCursor: null });
  if (p === '/api/admin/history/summary') return send(res, 200, { byUser: [{ id: 'u2', name: '佐藤 花子', deptName: '営業部', count: 12 }], byDept: [{ id: 'd1', name: '営業部', count: 12 }] });
  if (p.startsWith('/api/admin/cards/')) return send(res, 200, { items: [] });
  if (p === '/api/dev/settings') return send(res, 200, devSettings);
  if ((g = p.match(/^\/api\/dev\/keys\/(gemini|openai)(\/test)?$/))) {
    if (g[2]) return send(res, 200, { ok: true, models: 12 });
    devSettings.keys[g[1]] = { configured: true, last4: String(body.key || '').slice(-4), updatedAt: new Date().toISOString() };
    return send(res, 200, devSettings);
  }
  if (p === '/api/dev/models/available') return send(res, 200, { items: ['gemini-3.8-flash', 'gemini-3.7-flash'] });
  if (p === '/api/dev/models' && m === 'GET') return send(res, 200, { items: MODELS });
  if (p === '/api/dev/models' && m === 'POST') { MODELS.push({ ...body, builtin: false }); return send(res, 200, {}); }
  if ((g = p.match(/^\/api\/dev\/models\/([^/]+)$/)) && m === 'PATCH') { Object.assign(MODELS.find((x) => x.id === g[1]) || {}, body); return send(res, 200, {}); }
  if (p === '/api/dev/model') { devSettings.models[body.use] = body.modelId; return send(res, 200, devSettings); }
  if ((g = p.match(/^\/api\/dev\/prompts\/(card|transcribe|summarize)(\/history|\/revert)?$/))) {
    const k = g[1];
    if (g[2] === '/history') return send(res, 200, { items: [{ version: 1, savedBy: { name: '山田 管理' }, savedAt: new Date().toISOString(), text: PROMPTS[k] }] });
    if (g[2] === '/revert') return send(res, 200, { kind: k, text: PROMPTS[k], version: ++promptVer[k], isDefault: false });
    if (m === 'PUT') { PROMPTS[k] = body.text || `初期値の${k}プロンプト`; promptVer[k]++; }
    return send(res, 200, { kind: k, text: PROMPTS[k], version: promptVer[k], savedBy: { name: '山田 管理' }, savedAt: new Date().toISOString(), isDefault: promptVer[k] === 1 });
  }
  if (p === '/api/dev/scan-test') return send(res, 200, { card: { company: '株式会社テスト', name: 'テスト 太郎' }, raw: '{"company":"株式会社テスト"}', repairs: ['fence'], usage: { inputTokens: 2500, outputTokens: 500 }, elapsedMs: 1800 });
  if (p === '/api/dev/minutes-test' && m === 'POST') return send(res, 202, { jobId: 'j1' });
  if (p === '/api/dev/minutes-test/j1') return send(res, 200, { text: '## 要点\n- テスト', usage: { inputTokens: 100, outputTokens: 50 }, elapsedMs: 900 });
  if (p === '/api/dev/export') return send(res, 200, { url: '/mock-export.csv', expiresAt: new Date(Date.now() + 300000).toISOString(), rows: 75 });
  if (p === '/api/dev/usage') return send(res, 200, { months: [{ month: new Date().toISOString().slice(0, 7), byUse: { card: { count: 75, failed: 2, inputTokens: 187500, outputTokens: 37500, cost: 0.4 }, summarize: { count: 5, failed: 0, inputTokens: 150000, outputTokens: 15000, cost: 0.9 } }, byModel: [{ modelId: 'gemini-3.5-flash-lite', count: 75, failed: 2, inputTokens: 187500, outputTokens: 37500, cost: 0.4 }] }] });
  if (p === '/api/dev/usage/minutes') return send(res, 200, { items: [{ user: { id: 'u2', name: '佐藤 花子', departments: ['営業部'], status: 'active' }, recordings: 18, recordedSec: 52320, transcribe: { first: 18, retry: 2 }, summarize: { first: 18, retry: 5 }, qa: { count: 42 }, failed: 1, transcribedSec: 60000, inputTokens: 100, outputTokens: 50, cost: 2.31, lastUsedAt: new Date().toISOString() }, { user: { id: 'u1', name: '山田 管理', departments: ['営業部'], status: 'active' }, recordings: 3, recordedSec: 7800, transcribe: { first: 3, retry: 0 }, summarize: { first: 3, retry: 0 }, qa: { count: 7 }, failed: 0, transcribedSec: 7800, inputTokens: 10, outputTokens: 5, cost: 0.36, lastUsedAt: new Date().toISOString() }], total: { recordings: 21, recordedSec: 60120, transcribe: { first: 21, retry: 2 }, summarize: { first: 21, retry: 5 }, qa: { count: 49 }, failed: 1, cost: 2.67 } });
  if (p.startsWith('/api/dev/usage/minutes/')) return send(res, 200, { months: [{ month: '2026-09', recordedSec: 3600, transcribeCount: 3, cost: 0.5 }], events: [{ at: new Date().toISOString(), kind: 'transcribe', durationSec: 4320, modelId: 'gemini-3.5-flash-lite', ok: true, inputTokens: 144300, outputTokens: 27900, cost: 0.3 }] });
  if (p === '/api/dev/audit') return send(res, 200, { items: [{ at: new Date().toISOString(), actor: { name: '山田 管理' }, action: 'key.update', detail: { provider: 'gemini' } }], nextCursor: null });
  if (p === '/api/dev/positions') {
    if (m === 'GET') return send(res, 200, { items: POSITIONS });
    // 画面確認用: 名前に「conflict」を含む行があれば 409、検証は AWS 版と同じ規則
    const list = Array.isArray(body.items) ? body.items : [];
    const errors = [], seen = new Set();
    if (!list.length || list.length > 50) errors.push({ field: 'items', message: '1〜50 件で指定してください' });
    list.forEach((it, i) => {
      const name = typeof it.name === 'string' ? it.name.trim() : '';
      if (!name || name.length > 30) errors.push({ field: `items[${i}].name`, message: '1〜30 文字' });
      else if (seen.has(name.toLowerCase())) errors.push({ field: `items[${i}].name`, message: '重複しています' });
      else seen.add(name.toLowerCase());
      if (!['dev', 'org_admin', 'org_edit', 'dept_edit', 'dept_view'].includes(it.level)) errors.push({ field: `items[${i}].level`, message: 'dev / org_admin / org_edit / dept_edit / dept_view' });
    });
    if (errors.length) return err(res, 400, 'validation', '入力を確かめてください', errors);
    if (list.some((it) => /conflict/i.test(it.name))) return err(res, 409, 'conflict', '使われている役職は消せません。先にその人たちの役職を変えてください');
    if (!list.some((it) => it.level === 'dev')) return err(res, 409, 'conflict', '開発者が 1 人もいなくなる変更はできません');
    POSITIONS = list.map((it, i) => ({ name: it.name.trim(), level: it.level, order: i + 1 }));
    return send(res, 200, { items: POSITIONS });
  }
  return err(res, 404, 'not_found', `モックに無い API: ${m} ${p}`);
}

function serveFile(res, file) {
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}
const inside = (root, p) => { const f = path.resolve(root, '.' + p); return f.startsWith(root) ? f : null; };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    // 画面の確認用: ログイン済みにして / へ送る。?user=admin 以外は無い（ヘッドレスの撮影用）
    if (url.pathname === '/dev/login-as') { loggedIn = true; res.writeHead(302, { 'Set-Cookie': 'sid=mock; Path=/; HttpOnly', Location: url.searchParams.get('to') || '/' }); return res.end(); }
    if (url.pathname === '/dev/upload-sink') { req.resume(); return req.on('end', () => setTimeout(() => { res.writeHead(200); res.end(); }, 1500)); }
    if (url.pathname.startsWith('/mock-upload/')) { req.resume(); return req.on('end', () => { res.writeHead(200); res.end(); }); }
    if (url.pathname === '/mock-export.csv') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' }); return res.end('﻿id,name\r\nc1,田中\r\n'); }
    if (url.pathname.startsWith('/mock-img/')) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b2b33"/><stop offset="1" stop-color="#4a2a3c"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/><rect x="20" y="20" width="36" height="4" fill="#ff2d8f"/><text x="20" y="60" font-size="16" fill="#f5f5f7" font-family="sans-serif">株式会社サンプル</text><text x="20" y="110" font-size="24" font-weight="700" fill="#fff" font-family="sans-serif">田中 太郎</text><text x="20" y="150" font-size="12" fill="#cfcfd6" font-family="monospace">03-1234-5678</text><text x="20" y="170" font-size="12" fill="#cfcfd6" font-family="monospace">taro@example.co.jp</text></svg>'); }
    if (url.pathname.startsWith('/core/')) { const f = inside(CORE, url.pathname.slice(5)); return f ? serveFile(res, f) : (res.writeHead(403), res.end()); }
    const f = url.pathname === '/' ? null : inside(WEB, url.pathname);
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(res, f);
    // それ以外は History API のルーティング用に index.html を返す。
    return serveFile(res, path.join(WEB, 'index.html'));
  } catch (e) { send(res, 500, { error: { code: 'internal', message: String(e.message) } }); }
}).listen(PORT, () => console.log(`mock server: http://localhost:${PORT}  (ID: admin / パスワード: password123)`));
