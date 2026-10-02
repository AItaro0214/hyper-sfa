// 音声ファイルのアップロード（mode: upload、minutes-design.md §4.4）。D1 / R2 は偽物。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { minutesRoutes } from '../worker/src/minutes/index.js';

function setup(rowExtra = {}) {
  const segs = [];
  const row = { id: 'M1', owner_id: 'U1', status: 'recording', mode: 'upload', deleted_at: null, audio_expires_at: null, ...rowExtra };
  const env = {
    KEY_ENCRYPTION_KEY: 'k'.repeat(32),
    DB: {
      prepare: (sql) => ({
        bind: (...args) => ({
          first: async () => (/FROM minutes WHERE id/.test(sql) ? row : null),
          run: async () => { if (/INSERT INTO minute_segments/.test(sql)) segs.push(args); return {}; },
        }),
      }),
      batch: async () => [],
    },
  };
  const app = new Hono();
  app.onError((e, c) => c.json({ code: e.code, message: e.message }, e.status ?? 500));
  app.use('*', async (c, next) => { c.set('user', { id: 'U1' }); await next(); });
  minutesRoutes(app);
  const post = (body) => app.request('/api/minutes/M1/upload', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, env);
  return { post, segs };
}

test('upload の登録は seq 1 の区切りと署名付き URL を返し、長さ 0 は大きさから概算する', async () => {
  const { post, segs } = setup();
  const res = await post({ mime: 'audio/mp4', size: 8_000_000, durationSec: 0, filename: 'a.m4a' });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.method, 'PUT');
  assert.match(j.url, /^\/api\/minutes\/M1\/upload\/put\?exp=\d+&sig=/);
  assert.equal(j.key, 'minutes/M1/seg-1.m4a');
  // bind: id, seq, key, mime, startSec, durationSec, size
  assert.deepEqual(segs[0].slice(0, 7), ['M1', 1, 'minutes/M1/seg-1.m4a', 'audio/mp4', 0, 1000, 8_000_000]);
});

test('100MB 超・3,600 秒超・対応外の形式は validation、mode が upload でなければ conflict', async () => {
  const { post } = setup();
  for (const body of [
    { mime: 'audio/mp4', size: 101 * 1024 * 1024, durationSec: 60 },
    { mime: 'audio/mp4', size: 1000, durationSec: 3601 },
    { mime: 'text/plain', size: 1000, durationSec: 60 },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'validation');
  }
  const web = setup({ mode: 'web' });
  const res = await web.post({ mime: 'audio/mp4', size: 1000, durationSec: 60 });
  assert.equal(res.status, 409);
});
