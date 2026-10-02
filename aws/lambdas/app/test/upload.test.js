// 音声ファイルのアップロード（mode: upload）。DynamoDB と S3 は共有の関数を差し替える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { ddb, s3, errorHandler } from '@hyper-sfa/aws-shared';
import { registerMinutesRoutes } from '../src/minutes.js';

function setup(mode) {
  const store = new Map();
  const put = (it) => store.set(`${it.pk}|${it.sk}`, { ...it });
  const meta = { pk: 'MIN#m1', sk: 'META', id: 'm1', mode, ownerEmail: 'a@x.jp', ownerName: 'A', status: 'recording', createdAt: 'x' };
  put(meta);
  ddb.get = async (pk, sk) => store.get(`${pk}|${sk}`);
  ddb.put = async (it) => { put(it); };
  ddb.update = async (pk, sk, { set, values, names }) => {
    const cur = store.get(`${pk}|${sk}`) ?? {};
    if (set && !Object.values(set).some((v) => v === undefined)) Object.assign(cur, set);
    return cur;
  };
  ddb.queryAll = async ({ pk, skPrefix }) => [...store.values()].filter((x) => x.pk === pk && x.sk.startsWith(skPrefix));
  s3.presignPut = async ({ key }) => `https://s3.example/${key}`;
  let size = 4_000_000;
  s3.headObject = async () => ({ size });
  const app = new Hono();
  app.onError((e, c) => { if (process.env.DBG) console.error(e); return errorHandler(e, c); });
  app.use('*', async (c, next) => { c.set('auth', { user: { id: 'a@x.jp', displayName: 'A', deptIds: [] } }); return next(); });
  registerMinutesRoutes(app);
  const call = (method, path, body) => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { store, call, setSize: (n) => { size = n; } };
}

test('upload: 登録 → done → finish が通り、長さは大きさから概算される', async () => {
  const { store, call } = setup('upload');
  let res = await call('POST', '/api/minutes/m1/upload', { mime: 'audio/mp4', durationSec: 0, size: 4_000_000, filename: '会議.m4a' });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.key, 'minutes/m1/seg-001.m4a');
  const seg = store.get('MIN#m1|SEG#0001');
  assert.equal(seg.filename, '会議.m4a');
  assert.equal(seg.durationEstimated, true);
  res = await call('PUT', '/api/minutes/m1/segments/1/done');
  assert.equal(res.status, 200);
  assert.equal(store.get('MIN#m1|SEG#0001').state, 'uploaded');
  assert.equal(store.get('MIN#m1|SEG#0001').durationSec, 500);
  res = await call('POST', '/api/minutes/m1/finish', { durationSec: 0, segments: 1 });
  assert.equal(res.status, 200);
  assert.equal(store.get('MIN#m1|META').durationSec, 500);
  assert.equal(store.get('MIN#m1|META').status, 'uploaded');
});

test('mode: web で /upload を呼ぶと conflict', async () => {
  const { call } = setup('web');
  const res = await call('POST', '/api/minutes/m1/upload', { mime: 'audio/mp4', durationSec: 60, size: 1000 });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'conflict');
});

test('600MB 超は validation', async () => {
  const { call } = setup('upload');
  const res = await call('POST', '/api/minutes/m1/upload', { mime: 'audio/mp4', durationSec: 60, size: 601 * 1024 * 1024 });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'validation');
});
