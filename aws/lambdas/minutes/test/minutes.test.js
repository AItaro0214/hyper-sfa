import test from 'node:test';
import assert from 'node:assert/strict';
import { runMinutes } from '../src/minutes.js';
import { runPool } from '../src/pool.js';
import { fakeDdb, makeDeps, reply } from './fakes.js';

const seed = () => [
  { pk: 'MIN#m1', sk: 'META', status: 'queued', ownerEmail: 'a@x.jp', title: '定例', heldAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
  ...[1, 2, 3].map((n) => ({
    pk: 'MIN#m1', sk: `SEG#${n}`, seq: n, key: `minutes/m1/seg-${n}.webm`, mime: 'audio/webm',
    startSec: (n - 1) * 600, durationSec: 600, transcriptStatus: 'pending',
  })),
];

// 音声つきの呼び出しが文字起こし、音声なしが議事録。音声の中身(キー名)で区切りを見分ける
function scripted(state) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const inline = (body.contents ?? []).flatMap((c) => c.parts ?? []).find((p) => p.inlineData)?.inlineData;
    if (!inline) return reply('## 要点\n議事録');
    const audio = Buffer.from(inline.data, 'base64').toString();
    if (audio.includes('seg-2')) {
      state.seg2Calls++;
      if (state.seg2Fails) return { status: 400, json: async () => ({ error: { message: 'bad request' } }) };
    }
    return reply('[00:05] 話者A: こんにちは');
  };
}

test('runPool は同時実行数を守り、失敗しても他を続ける', async () => {
  let cur = 0;
  let max = 0;
  const r = await runPool([1, 2, 3, 4, 5, 6], 4, async (n) => {
    cur++;
    max = Math.max(max, cur);
    await new Promise((s) => setTimeout(s, 5));
    cur--;
    if (n === 3) throw new Error('x');
    return n;
  });
  assert.equal(max, 4);
  assert.equal(r.filter((x) => !x.ok).length, 1);
});

test('区切り 3 つのうち 1 つ失敗 → failed、再実行では失敗した 1 つだけやり直す', async () => {
  const ddb = fakeDdb(seed());
  const state = { seg2Fails: true, seg2Calls: 0 };
  const t = makeDeps({ ddb, fetchImpl: scripted(state) });

  const r1 = await runMinutes({ minuteId: 'm1', target: 'generate' }, t.deps);
  assert.equal(r1.ok, false);
  let meta = ddb.m.get('MIN#m1|META');
  assert.equal(meta.status, 'failed');
  assert.equal(meta.failure.step, 'transcribe');
  assert.equal(ddb.m.get('MIN#m1|SEG#1').transcriptStatus, 'done');
  assert.equal(ddb.m.get('MIN#m1|SEG#2').transcriptStatus, 'failed');
  assert.equal(ddb.m.get('MIN#m1|SEG#3').transcriptStatus, 'done');

  const before = t.fetchCalls;
  state.seg2Fails = false;
  const r2 = await runMinutes({ minuteId: 'm1', target: 'generate' }, t.deps);
  assert.equal(r2.ok, true);
  // 区切り 2 の文字起こし 1 回 + 議事録 1 回だけ
  assert.equal(t.fetchCalls - before, 2);
  meta = ddb.m.get('MIN#m1|META');
  assert.equal(meta.status, 'done');
  assert.equal(meta.transcript.version, 1);
  assert.equal(meta.summary.version, 1);
  assert.equal(meta.audio?.downloadFailed, true); // ffmpeg が無い
  assert.equal(meta.transcriptWork, undefined);
  const text = t.puts.get('minutes/m1/transcript-v1.txt').toString();
  assert.match(text, /\[00:20:05\]/); // 区切り 3 の時刻が通しになる
});

test('20 分以上止まっている transcribing は失敗として扱い、再開する', async () => {
  const s = seed();
  s[0].status = 'transcribing';
  s[0].updatedAt = '2026-09-30T00:00:00Z';
  const ddb = fakeDdb(s);
  const t = makeDeps({ ddb, fetchImpl: scripted({ seg2Calls: 0 }) });
  const r = await runMinutes({ minuteId: 'm1', target: 'generate' }, t.deps);
  assert.equal(r.ok, true);
  assert.equal(ddb.m.get('MIN#m1|META').status, 'done');
});

test('動いている最中(20 分未満)は二重起動しない', async () => {
  const s = seed();
  s[0].status = 'summarizing';
  s[0].updatedAt = '2026-09-30T23:55:00Z';
  const t = makeDeps({ ddb: fakeDdb(s), fetchImpl: async () => reply('x') });
  const r = await runMinutes({ minuteId: 'm1', target: 'summary' }, t.deps);
  assert.equal(r.skipped, true);
  assert.equal(t.fetchCalls, 0);
});
