// GET /api/companies。D1 は偽物（受け取った SQL と値を記録し、決めた行を返す）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { cardRoutes } from '../worker/src/routes/cards.js';

function appWith(rows) {
  const calls = [];
  const env = {
    DB: {
      prepare(sql) {
        return { bind: (...params) => ({ all: async () => (calls.push({ sql, params }), { results: rows }) }) };
      },
    },
  };
  const app = new Hono();
  app.use('*', async (c, next) => (c.set('user', { id: 'u1' }), next()));
  cardRoutes(app);
  return { call: (path) => app.request(path, {}, env), calls };
}

const rows = [
  { id: '1', company: '株式会社アシスト', department: '営業部', name: '山田', title: '部長' },
  { id: '2', company: 'アシスト（株）', department: '営業部', name: '佐藤', title: '' },
  { id: '3', company: '株式会社アシスト', department: '', name: '鈴木', title: '' },
];

test('確認済みの名刺を会社 → 部署 → 人にまとめる。q は D1 の LIKE で先に絞る', async () => {
  const { call, calls } = appWith(rows);
  const res = await call('/api/companies?q=' + encodeURIComponent('アシスト（株）'));
  assert.equal(res.status, 200);
  const { items } = await res.json();
  assert.equal(items.length, 1);
  assert.equal(items[0].count, 3);
  assert.deepEqual(items[0].departments.map((d) => d.name), ['', '営業部']);
  assert.deepEqual(items[0].departments[1].people[1], { id: '1', name: '山田', title: '部長' });
  assert.match(calls[0].sql, /status = 'confirmed' AND deleted_at IS NULL AND company != ''/);
  assert.match(calls[0].sql, /company LIKE \? ESCAPE '\\' OR company LIKE \? ESCAPE '\\' OR company_n LIKE \?/);
  assert.ok(calls[0].params.includes('%アシスト（株）%') && calls[0].params.includes('%あしすと(株)%'));
});

test('q が無ければ LIKE を付けない', async () => {
  const { call, calls } = appWith(rows);
  await call('/api/companies');
  assert.doesNotMatch(calls[0].sql, /LIKE/);
  assert.deepEqual(calls[0].params, []);
});
