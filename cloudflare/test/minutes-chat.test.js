// 議事録への質問。D1 / R2 / モデルの呼び出しは偽物（Cloudflare にも Gemini / OpenAI にも触れない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { chatRoutes } from '../worker/src/minutes/chat.js';
import { DEFAULT_MODELS, DEFAULT_SELECTION } from '../../packages/core/src/models.js';
import { DEFAULT_PROMPTS } from '../../packages/core/src/prompts.js';

const TRANSCRIPT = '[00:00:10] 田中: 初年度だけ 10% 値引きできませんか';
const SUMMARY_TEXT = 'これは議事録の要約です（質問の文脈に入ってはいけない）';

const MIN = {
  id: 'M1', title: '価格の相談', held_at: '2026-10-01T01:00:00.000Z', memo: '', owner_id: 'U1', owner_name: 'A', status: 'done',
  transcript_key: 'minutes/M1/transcript-v1.txt', summary_key: 'minutes/M1/summary-v1.md', deleted_at: null,
};
const mats = [
  { id: 'a1', minute_id: 'M1', seq: 1, name: '見積.pdf', kind: 'pdf', outline_status: 'done', outline_key: 'minutes/M1/materials/a1.outline.json', extract_key: null },
  { id: 'a2', minute_id: 'M1', seq: 2, name: '提案.pptx', kind: 'pptx', outline_status: 'none', outline_key: null, extract_key: 'minutes/M1/materials/a2.extract.json' },
  { id: 'a3', minute_id: 'M1', seq: 3, name: '図.pdf', kind: 'pdf', outline_status: 'failed', outline_key: null, extract_key: null },
];

function fakeDb(state) {
  const exec = (sql, a) => {
    if (/FROM minutes WHERE id = \? AND deleted_at IS NULL/.test(sql)) return state.minute;
    if (/FROM minute_shares/.test(sql)) return state.shares.has(a[1]) ? { x: 1 } : null;
    if (/FROM minute_counterparts/.test(sql)) return { results: [] };
    if (/FROM minute_attendees/.test(sql)) return { results: [] };
    if (/FROM minute_materials m LEFT JOIN/.test(sql)) return { results: [] };
    if (/FROM minute_materials WHERE minute_id/.test(sql)) return { results: mats };
    if (/INSERT INTO qa_quota/.test(sql)) {
      const k = `${a[0]}|${a[1]}`;
      const n = state.quota.get(k) ?? 0;
      if (n >= a[2]) return null;
      state.quota.set(k, n + 1);
      return { count: n + 1 };
    }
    if (/SELECT COALESCE\(MAX\(seq\)/.test(sql)) {
      return { m: Math.max(0, ...state.chats.filter((r) => r.minute_id === a[0] && r.user_id === a[1]).map((r) => r.seq)) };
    }
    if (/INSERT INTO minute_chats/.test(sql)) {
      const [minute_id, user_id, seq, role, text, model_id, input_tokens, output_tokens, created_at] = a;
      if (state.chats.some((r) => r.minute_id === minute_id && r.user_id === user_id && r.seq === seq)) throw new Error('UNIQUE');
      state.chats.push({ minute_id, user_id, seq, role, text, model_id, input_tokens, output_tokens, created_at });
      return {};
    }
    if (/FROM minute_chats WHERE minute_id = \? AND user_id = \? ORDER BY seq DESC LIMIT/.test(sql)) {
      return { results: state.chats.filter((r) => r.minute_id === a[0] && r.user_id === a[1]).sort((x, y) => y.seq - x.seq).slice(0, a[2]) };
    }
    if (/FROM minute_chats WHERE minute_id = \? AND user_id = \? ORDER BY seq/.test(sql)) {
      return { results: state.chats.filter((r) => r.minute_id === a[0] && r.user_id === a[1]).sort((x, y) => x.seq - y.seq) };
    }
    if (/DELETE FROM minute_chats WHERE minute_id = \? AND user_id = \?/.test(sql)) {
      state.chats = state.chats.filter((r) => !(r.minute_id === a[0] && r.user_id === a[1]));
      return {};
    }
    throw new Error(`偽物が知らない SQL: ${sql}`);
  };
  const prepare = (sql) => ({
    bind: (...a) => ({ first: async () => exec(sql, a), all: async () => exec(sql, a), run: async () => exec(sql, a), _run: () => exec(sql, a) }),
  });
  return { prepare, batch: async (stmts) => { for (const s of stmts) await s.run(); } };
}

function fakeR2(files) {
  return { async get(key) { return files.has(key) ? { async text() { return files.get(key); } } : null; } };
}

function setup({ replies } = {}) {
  const state = { minute: { ...MIN }, shares: new Set(['U1:U2'].map((s) => s.split(':')[1])), quota: new Map(), chats: [] };
  const files = new Map([
    [MIN.transcript_key, TRANSCRIPT],
    [MIN.summary_key, SUMMARY_TEXT],
    ['minutes/M1/materials/a1.outline.json', JSON.stringify({ sections: [{ page: 3, title: '料金表', summary: '初年度の料金' }] })],
    ['minutes/M1/materials/a2.extract.json', JSON.stringify({ kind: 'pptx', slides: [{ index: 1, title: '提案の概要', text: '本文' }] })],
  ]);
  const env = { DB: fakeDb(state), DATA: fakeR2(files), QA_PER_DAY: '3' };
  const model = DEFAULT_MODELS.find((m) => m.id === DEFAULT_SELECTION.qa) ?? DEFAULT_MODELS.find((m) => m.provider === 'gemini');
  const calls = [];
  const queue = replies ?? [];
  const usage = [];
  const deps = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      const r = queue.length ? queue.shift() : { status: 200, json: { candidates: [{ content: { parts: [{ text: '答えです' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } } };
      return new Response(JSON.stringify(r.json), { status: r.status });
    },
    getApiKey: async () => 'key',
    getModel: async () => model,
    getSelectedModel: async () => model.id,
    getPrompt: async () => ({ text: DEFAULT_PROMPTS.qa }),
    recordUsage: async (_e, ev) => { usage.push(ev); },
  };
  let who = 'U1';
  const app = new Hono();
  app.onError((e, c) => c.json({ error: { code: e.code, message: e.message } }, e.status ?? 500));
  app.use('*', async (c, next) => { c.set('user', { id: who }); await next(); });
  chatRoutes(app, deps);
  const req = (method, path, body) => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
  return { state, calls, usage, req, as: (u) => { who = u; } };
}

test('文脈に文字起こしと資料の全文が入り、要約は入らない', async () => {
  const { req, calls, usage } = setup();
  const res = await req('POST', '/api/minutes/M1/chat', { text: '値引きの話は出た？' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.answer.text, '答えです');
  assert.equal(body.question.seq, 1);
  assert.equal(body.answer.seq, 2);
  assert.deepEqual(body.usage, { inputTokens: 100, outputTokens: 20 });

  const sent = calls[0].body;
  const system = sent.systemInstruction.parts[0].text;
  assert.ok(system.includes(TRANSCRIPT));
  assert.ok(system.includes('見積.pdf') && !system.includes('初年度の料金'), 'PDF は名前だけ');
  assert.ok(system.includes('提案の概要') && system.includes('本文'), 'pptx の全文');
  assert.ok(system.includes('図.pdf'), '中身の無い資料は名前だけ');
  assert.ok(!system.includes(SUMMARY_TEXT), '要約は入れない');
  assert.equal(sent.contents.at(-1).parts[0].text, '値引きの話は出た？');
  assert.equal(sent.generationConfig.maxOutputTokens, 4000);
  assert.equal(usage[0].kind, 'qa');
});

test('スレッドは利用者ごとに分かれ、履歴が次の質問に渡る', async () => {
  const { req, as, calls } = setup();
  await req('POST', '/api/minutes/M1/chat', { text: 'A の質問' });
  as('U2');
  await req('POST', '/api/minutes/M1/chat', { text: 'B の質問' });
  assert.equal(calls[1].body.contents.length, 1, 'B に A の履歴は渡らない');
  as('U1');
  await req('POST', '/api/minutes/M1/chat', { text: 'A の 2 問目' });
  assert.equal(calls[2].body.contents.length, 3);

  let list = await (await req('GET', '/api/minutes/M1/chat')).json();
  assert.deepEqual(list.items.map((i) => i.text), ['A の質問', '答えです', 'A の 2 問目', '答えです']);
  assert.equal(list.available, true);
  as('U2');
  list = await (await req('GET', '/api/minutes/M1/chat')).json();
  assert.deepEqual(list.items.map((i) => i.text), ['B の質問', '答えです']);
  assert.equal(list.items[0].seq, 1);

  await req('DELETE', '/api/minutes/M1/chat');
  assert.equal((await (await req('GET', '/api/minutes/M1/chat')).json()).items.length, 0);
  as('U1');
  assert.equal((await (await req('GET', '/api/minutes/M1/chat')).json()).items.length, 4);
});

test('見えない人は 404、空と長すぎる質問、文字起こし無しは validation', async () => {
  const { req, as, state } = setup();
  as('U9');
  assert.equal((await req('POST', '/api/minutes/M1/chat', { text: 'x' })).status, 404);
  as('U1');
  assert.equal((await req('POST', '/api/minutes/M1/chat', { text: ' ' })).status, 400);
  assert.equal((await req('POST', '/api/minutes/M1/chat', { text: 'あ'.repeat(2001) })).status, 400);
  state.minute.transcript_key = null;
  const res = await req('POST', '/api/minutes/M1/chat', { text: 'x' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'validation');
  assert.equal((await (await req('GET', '/api/minutes/M1/chat')).json()).available, false);
});

test('1 日の上限を超えたら rate_limited', async () => {
  const { req } = setup(); // 偽物の環境では QA_PER_DAY = 3
  for (let i = 0; i < 3; i++) assert.equal((await req('POST', '/api/minutes/M1/chat', { text: `q${i}` })).status, 200);
  const res = await req('POST', '/api/minutes/M1/chat', { text: 'もう 1 回' });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, 'rate_limited');
});

test('モデル側の失敗は provider_error で、質問は保存しない', async () => {
  const { req, state } = setup({ replies: [{ status: 503, json: { error: { status: 'UNAVAILABLE' } } }] });
  const res = await req('POST', '/api/minutes/M1/chat', { text: '失敗する質問' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'provider_error');
  assert.equal(state.chats.length, 0);
});
