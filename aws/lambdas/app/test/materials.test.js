// 資料の API の入力検査。DynamoDB は共有の ddb の関数を差し替える（AWS には触れない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { ddb, errorHandler } from '@hyper-sfa/aws-shared';
import { registerMinutesRoutes } from '../src/minutes.js';
import { MATERIAL_LIMITS } from '@hyper-sfa/core';

const mat = (n) => ({ pk: 'MIN#m1', sk: `MAT#00${n}`, id: `m00${n}`, seq: n, state: 'ready', uploadedAt: new Date().toISOString() });

function setup(materials) {
  const meta = { pk: 'MIN#m1', sk: 'META', id: 'm1', ownerEmail: 'a@x.jp', status: 'done', transcript: { key: 'k' }, summary: { key: 's' } };
  ddb.get = async (pk, sk) => (pk === 'MIN#m1' && sk === 'META' ? meta : undefined);
  ddb.queryAll = async ({ skPrefix }) => (skPrefix === 'MAT#' ? materials : []);
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', async (c, next) => { c.set('auth', { user: { id: 'a@x.jp', displayName: 'A' } }); return next(); });
  registerMinutesRoutes(app);
  const post = (path, body) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { post };
}

test('資料が 0 件のとき、資料つきの作り直しは validation', async () => {
  const { post } = setup([]);
  const res = await post('/api/minutes/m1/regenerate', { target: 'summary', withMaterials: true });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'validation');
});

test('6 件目、上限超、対応外の形式は validation', async () => {
  const { post } = setup([1, 2, 3, 4, 5].map(mat));
  let res = await post('/api/minutes/m1/materials', { name: 'a.pdf', kind: 'pdf', size: 1000 });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'validation');

  const s2 = setup([]);
  res = await s2.post('/api/minutes/m1/materials', { name: 'a.pdf', kind: 'pdf', size: MATERIAL_LIMITS.maxBytes + 1 });
  assert.equal(res.status, 400);
  res = await s2.post('/api/minutes/m1/materials', { name: 'a.ppt', kind: 'pptx', size: 1000 });
  assert.equal(res.status, 400);
});
