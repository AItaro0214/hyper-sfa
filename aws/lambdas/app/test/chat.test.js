// 議事録への質問。DynamoDB と S3 とモデルの呼び出しは偽物にする（AWS にも Gemini / OpenAI にも触れない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { ddb, s3, errorHandler } from '@hyper-sfa/aws-shared';
import { registerMinutesRoutes } from '../src/minutes.js';
import { registerChatRoutes } from '../src/chat.js';
import { QA_PER_DAY } from '../src/rate.js';

const TRANSCRIPT = '[00:00:10] 田中: 初年度だけ 10% 値引きできませんか';
const SUMMARY_TEXT = 'これは議事録の要約です（質問の文脈に入ってはいけない）';

function fakeStore() {
  const items = new Map();
  const key = (pk, sk) => `${pk}\u0000${sk}`;
  const put = (i) => items.set(key(i.pk, i.sk), { ...i });
  ddb.get = async (pk, sk) => items.get(key(pk, sk)) ?? null;
  ddb.put = async (i) => put(i);
  ddb.del = async (pk, sk) => { items.delete(key(pk, sk)); };
  ddb.query = async ({ pk, skPrefix, forward = true, limit }) => {
    let rows = [...items.values()].filter((i) => i.pk === pk && (skPrefix == null || i.sk.startsWith(skPrefix)));
    rows.sort((a, b) => (a.sk < b.sk ? -1 : 1));
    if (!forward) rows.reverse();
    if (limit) rows = rows.slice(0, limit);
    return { items: rows, lastKey: undefined };
  };
  ddb.queryAll = async (q) => (await ddb.query(q)).items;
  ddb.update = async (pk, sk, o = {}) => {
    const cur = items.get(key(pk, sk)) ?? { pk, sk };
    if (o.condition) {
      const field = o.names?.['#c'];
      if (cur[field] != null && !(cur[field] < o.values[':max'])) {
        const e = new Error('cond');
        e.name = 'ConditionalCheckFailedException';
        throw e;
      }
    }
    const next = { ...cur, ...(o.set ?? {}) };
    for (const [f, n] of Object.entries(o.add ?? {})) next[f] = (next[f] ?? 0) + n;
    items.set(key(pk, sk), next);
    return next;
  };
  ddb.transact = async (ops) => {
    for (const op of ops) {
      if (op.put && op.condition && items.has(key(op.put.pk, op.put.sk))) {
        const e = new Error('cond');
        e.name = 'ConditionalCheckFailedException';
        throw e;
      }
    }
    for (const op of ops) put(op.put);
  };
  return { items, put };
}

function setup({ user = 'a@x.jp', answers } = {}) {
  const store = fakeStore();
  const files = new Map([
    ['minutes/m1/transcript-v1.txt', TRANSCRIPT],
    ['minutes/m1/summary-v1.md', SUMMARY_TEXT],
    ['minutes/m1/materials/m001.outline.json', JSON.stringify({ sections: [{ page: 3, title: '料金表', summary: '初年度の料金' }] })],
    ['minutes/m1/materials/m002.extract.json', JSON.stringify({ kind: 'pptx', slides: [{ index: 1, title: '提案の概要', text: '本文' }] })],
  ]);
  s3.getObjectBuffer = async ({ key }) => {
    if (!files.has(key)) throw Object.assign(new Error('x'), { name: 'NoSuchKey' });
    return Buffer.from(files.get(key));
  };
  store.put({ pk: 'MIN#m1', sk: 'META', id: 'm1', title: '価格の相談', heldAt: '2026-10-01T01:00:00.000Z', ownerEmail: 'a@x.jp', status: 'done', transcript: { key: 'minutes/m1/transcript-v1.txt' }, summary: { key: 'minutes/m1/summary-v1.md' } });
  store.put({ pk: 'MIN#m1', sk: 'SHARE#b@x.jp' });
  store.put({ pk: 'MIN#m1', sk: 'MAT#001', id: 'm001', seq: 1, name: '見積.pdf', kind: 'pdf', state: 'ready', outlineStatus: 'done', outlineKey: 'minutes/m1/materials/m001.outline.json' });
  store.put({ pk: 'MIN#m1', sk: 'MAT#002', id: 'm002', seq: 2, name: '提案.pptx', kind: 'pptx', state: 'ready', extractKey: 'minutes/m1/materials/m002.extract.json' });
  store.put({ pk: 'MIN#m1', sk: 'MAT#003', id: 'm003', seq: 3, name: '図.pdf', kind: 'pdf', state: 'ready', outlineStatus: 'failed' });

  const calls = [];
  const queue = answers ?? [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = queue.length ? queue.shift() : { status: 200, json: { candidates: [{ content: { parts: [{ text: '答えです' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } } };
    return { status: r.status, json: async () => r.json };
  };
  let who = user;
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', async (c, next) => { c.set('auth', { user: { id: who, displayName: who } }); return next(); });
  registerMinutesRoutes(app);
  registerChatRoutes(app, { fetch: fakeFetch, getApiKey: async () => 'key' });
  const req = (method, path, body) => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { store, calls, req, as: (u) => { who = u; } };
}

test('文脈に文字起こしと資料の目次が入り、要約は入らない', async () => {
  const { req, calls } = setup();
  const res = await req('POST', '/api/minutes/m1/chat', { text: '値引きの話は出た？' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.answer.text, '答えです');
  assert.equal(body.question.seq, 1);
  assert.equal(body.answer.seq, 2);
  assert.deepEqual(body.usage, { inputTokens: 100, outputTokens: 20 });

  const sent = calls[0].body;
  const system = sent.systemInstruction.parts[0].text;
  assert.ok(system.includes(TRANSCRIPT));
  assert.ok(system.includes('料金表'), 'PDF の目次');
  assert.ok(system.includes('提案の概要'), 'pptx の目次');
  assert.ok(system.includes('図.pdf'), '目次の無い資料は名前だけ');
  assert.ok(!system.includes(SUMMARY_TEXT), '要約は入れない');
  assert.equal(sent.contents.at(-1).parts[0].text, '値引きの話は出た？');
  assert.equal(sent.generationConfig.maxOutputTokens, 4000);
});

test('スレッドは利用者ごとに分かれ、履歴が次の質問に渡る', async () => {
  const { req, as, calls, store } = setup();
  await req('POST', '/api/minutes/m1/chat', { text: 'A の質問' });
  as('b@x.jp');
  await req('POST', '/api/minutes/m1/chat', { text: 'B の質問' });
  // B に A の履歴は渡らない
  assert.equal(calls[1].body.contents.length, 1);
  as('a@x.jp');
  await req('POST', '/api/minutes/m1/chat', { text: 'A の 2 問目' });
  assert.equal(calls[2].body.contents.length, 3);

  let list = await (await req('GET', '/api/minutes/m1/chat')).json();
  assert.deepEqual(list.items.map((i) => i.text), ['A の質問', '答えです', 'A の 2 問目', '答えです']);
  assert.equal(list.available, true);
  as('b@x.jp');
  list = await (await req('GET', '/api/minutes/m1/chat')).json();
  assert.deepEqual(list.items.map((i) => i.text), ['B の質問', '答えです']);
  assert.equal(list.items[0].seq, 1);

  // 自分のスレッドだけ消える
  await req('DELETE', '/api/minutes/m1/chat');
  assert.equal((await (await req('GET', '/api/minutes/m1/chat')).json()).items.length, 0);
  as('a@x.jp');
  assert.equal((await (await req('GET', '/api/minutes/m1/chat')).json()).items.length, 4);
  assert.ok([...store.items.keys()].some((k) => k.includes('CHAT#a@x.jp#0001')));
});

test('見えない人は 404、空と長すぎる質問は validation、文字起こしが無ければ validation', async () => {
  const { req, as, store } = setup();
  as('c@x.jp');
  assert.equal((await req('POST', '/api/minutes/m1/chat', { text: 'x' })).status, 404);
  as('a@x.jp');
  assert.equal((await req('POST', '/api/minutes/m1/chat', { text: '  ' })).status, 400);
  assert.equal((await req('POST', '/api/minutes/m1/chat', { text: 'あ'.repeat(2001) })).status, 400);
  const meta = store.items.get('MIN#m1\u0000META');
  delete meta.transcript;
  const res = await req('POST', '/api/minutes/m1/chat', { text: 'x' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'validation');
  assert.equal((await (await req('GET', '/api/minutes/m1/chat')).json()).available, false);
});

test('1 日 200 回を超えたら rate_limited', async () => {
  const { req } = setup();
  for (let i = 0; i < QA_PER_DAY; i++) {
    const r = await req('POST', '/api/minutes/m1/chat', { text: `q${i}` });
    assert.equal(r.status, 200);
  }
  const res = await req('POST', '/api/minutes/m1/chat', { text: 'もう 1 回' });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, 'rate_limited');
});

test('モデル側の失敗は provider_error で、質問は保存しない', async () => {
  const { req } = setup({ answers: [{ status: 503, json: { error: { status: 'UNAVAILABLE' } } }] });
  const res = await req('POST', '/api/minutes/m1/chat', { text: '失敗する質問' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'provider_error');
  assert.equal((await (await req('GET', '/api/minutes/m1/chat')).json()).items.length, 0);
});

test('議事録の削除で全員のスレッドも消える', async () => {
  const { req, as, store } = setup();
  await req('POST', '/api/minutes/m1/chat', { text: 'A' });
  as('b@x.jp');
  await req('POST', '/api/minutes/m1/chat', { text: 'B' });
  as('a@x.jp');
  s3.listPrefix = async () => [];
  s3.deleteObject = async () => {};
  const res = await req('DELETE', '/api/minutes/m1');
  assert.equal(res.status, 200);
  assert.ok(![...store.items.values()].some((i) => String(i.sk).startsWith('CHAT#')));
});
