import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMinutesPipeline } from '../worker/src/minutes/pipeline.js';
import { planStart } from '../worker/src/minutes/rules.js';
import * as gemini from '../../packages/core/src/gemini.js';
import * as openai from '../../packages/core/src/openai.js';
import { renderPrompt } from '../../packages/core/src/prompts.js';
import { joinSegments, offsetTimestamps } from '../../packages/core/src/transcript.js';
import { DEFAULT_MODELS, estimateCost } from '../../packages/core/src/models.js';

// ---- 偽物 ----

/** step.do を即時に実行し、再試行（retries.limit）も行う。待ち時間は無し */
function fakeStep() {
  const attempts = {};
  const sleeps = [];
  return {
    attempts,
    sleeps,
    async do(name, config, fn) {
      if (typeof config === 'function') [config, fn] = [{}, config];
      const limit = config?.retries?.limit ?? 0;
      let last;
      for (let i = 0; i <= limit; i++) {
        attempts[name] = (attempts[name] ?? 0) + 1;
        try {
          return JSON.parse(JSON.stringify((await fn()) ?? null)); // Workflows は返り値を保存する
        } catch (e) {
          last = e;
        }
      }
      throw last;
    },
    async sleep(name) {
      sleeps.push(name);
    },
  };
}

function fakeR2(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    async get(key) {
      if (!m.has(key)) return null;
      const v = m.get(key);
      return { size: v.length, body: new Blob([v]).stream(), async text() { return v; }, async blob() { return new Blob([v]); } };
    },
    async put(key, v) { m.set(key, typeof v === 'string' ? v : '[stream]'); },
    async delete(k) { for (const x of [].concat(k)) m.delete(x); },
    async head(key) { return m.has(key) ? { size: m.get(key).length } : null; },
  };
}

/** pipeline が使う SQL だけに答える D1 の偽物 */
function fakeDb({ minute, segments }) {
  const state = { minute: { ...minute }, segments: segments.map((s) => ({ ...s })) };
  const exec = (sql, a, mode) => {
    const S = state;
    if (/^SELECT \* FROM minutes/.test(sql)) return S.minute;
    if (/FROM minute_segments WHERE minute_id = \? AND uploaded = 1 ORDER BY/.test(sql)) return { results: S.segments.map((s) => ({ ...s })) };
    if (/FROM minute_counterparts/.test(sql)) return { results: [{ company: '株式会社アシスト', department: '', name: '山田 太郎' }] };
    if (/FROM minute_attendees/.test(sql)) return { results: [{ display_name: '佐藤 花子' }] };
    if (/SELECT COUNT\(\*\)/.test(sql)) return { n: S.segments.filter((s) => s.transcript_status === 'done').length };
    if (/SELECT seq, start_sec, transcript_key/.test(sql)) {
      return { results: S.segments.filter((s) => s.transcript_status === 'done').map((s) => ({ seq: s.seq, start_sec: s.start_sec, transcript_key: s.transcript_key })) };
    }
    if (/SELECT transcript_key, transcript_prev_key FROM minutes/.test(sql)) return { transcript_key: S.minute.transcript_key, transcript_prev_key: S.minute.transcript_prev_key };
    if (/SELECT transcript_key, summary_key, summary_prev_key/.test(sql)) return { transcript_key: S.minute.transcript_key, summary_key: S.minute.summary_key, summary_prev_key: S.minute.summary_prev_key };
    if (/UPDATE minute_segments SET transcript_key/.test(sql)) {
      const s = S.segments.find((x) => x.seq === a[2]);
      s.transcript_key = a[0];
      s.transcript_status = 'done';
      return {};
    }
    if (/SET status = 'transcribing'/.test(sql)) { Object.assign(S.minute, { status: 'transcribing', progress: a[0], failure: null }); return {}; }
    if (/UPDATE minutes SET progress/.test(sql)) { S.minute.progress = a[0]; return {}; }
    if (/UPDATE minutes SET transcript_prev_key/.test(sql)) {
      Object.assign(S.minute, { transcript_prev_key: S.minute.transcript_key, transcript_key: a[0], transcript_version: a[1], transcript_model: a[2] });
      return {};
    }
    if (/SET status = 'summarizing'/.test(sql)) { S.minute.status = 'summarizing'; return {}; }
    if (/UPDATE minutes SET summary_prev_key/.test(sql)) {
      Object.assign(S.minute, { summary_prev_key: S.minute.summary_key, summary_key: a[0], summary_version: a[1], summary_model: a[2] });
      return {};
    }
    if (/SET status = 'done'/.test(sql)) { S.minute.status = 'done'; return {}; }
    if (/SET status = 'failed'/.test(sql)) { Object.assign(S.minute, { status: 'failed', failure: a[0] }); return {}; }
    throw new Error(`偽物が知らない SQL: ${sql}`);
  };
  const prepare = (sql) => ({
    bind: (...a) => ({
      first: async () => exec(sql, a, 'first'),
      all: async () => exec(sql, a, 'all'),
      run: async () => exec(sql, a, 'run'),
    }),
  });
  return { prepare, batch: async (l) => { for (const x of l) await x.run(); }, state };
}

const jsonRes = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers });
const genOk = (text) => jsonRes({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } });

/** generateContent の応答を順番に返す fetch の偽物 */
function fakeFetch(generateReplies) {
  const calls = [];
  let g = 0;
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method });
    const u = String(url);
    if (u.includes('/upload/v1beta/files')) return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/x' } });
    if (u === 'https://upload.example/x') return jsonRes({ file: { name: 'files/a', uri: 'https://files.example/a', mimeType: 'audio/webm', state: 'ACTIVE' } });
    if (u.includes('/v1beta/files/')) return init.method === 'DELETE' ? jsonRes({}) : jsonRes({ name: 'files/a', state: 'ACTIVE' });
    if (u.includes(':generateContent')) return generateReplies[Math.min(g++, generateReplies.length - 1)]();
    throw new Error(`知らない URL: ${u}`);
  };
  f.calls = calls;
  return f;
}

function makeDeps({ fetch, events }) {
  const model = DEFAULT_MODELS.find((m) => m.id === 'gemini-3.5-flash-lite');
  return {
    fetch,
    ...gemini,
    ...openai,
    renderPrompt,
    joinSegments,
    offsetTimestamps,
    estimateCost,
    usageEvent: (o) => ({ ...o }),
    recordUsage: async (_env, ev) => { events.push(ev); },
    getApiKey: async () => 'test-key',
    getSelectedModel: async () => model.id,
    getModel: async () => model,
    getPrompt: async (_env, kind) => ({ text: kind === 'summarize' ? '議事録を作る\n{{TRANSCRIPT}}' : '文字起こし {{TITLE}} {{COUNTERPARTS}}', version: 1 }),
  };
}

const baseMinute = {
  id: 'M1', title: '定例', held_at: '2026-10-02T05:00:00.000Z', memo: '', owner_id: 'U1', status: 'queued',
  transcript_key: null, transcript_prev_key: null, transcript_version: 0,
  summary_key: null, summary_prev_key: null, summary_version: 0,
};
const seg = (seq, extra = {}) => ({
  seq, key: `minutes/M1/seg-${seq}.webm`, mime: 'audio/webm;codecs=opus', start_sec: (seq - 1) * 600, duration_sec: 600, size: 10,
  transcript_key: null, transcript_status: 'pending', ...extra,
});
const audioFiles = () => fakeR2({ 'minutes/M1/seg-1.webm': 'aaa', 'minutes/M1/seg-2.webm': 'bbb', 'minutes/M1/seg-3.webm': 'ccc' });

// ---- テスト ----

test('区切り 3 つ、2 つ目が 1 回失敗して再試行で成功し、done になる', async () => {
  const db = fakeDb({ minute: baseMinute, segments: [seg(1), seg(2), seg(3)] });
  const env = { DB: db, AUDIO: audioFiles(), DATA: fakeR2() };
  const events = [];
  const fetch = fakeFetch([
    () => genOk('[00:05] 話者A: 一つ目'),
    () => jsonRes({ error: { status: 'UNAVAILABLE', message: 'overloaded' } }, 503), // 2 つ目の 1 回目
    () => genOk('[00:05] 話者A: 二つ目'),
    () => genOk('[00:05] 話者A: 三つ目'),
    () => genOk('## 要点\nまとめ'),
  ]);
  const step = fakeStep();
  const r = await runMinutesPipeline({ env, deps: makeDeps({ fetch, events }), event: { payload: { minuteId: 'M1', target: 'generate' } }, step });

  assert.equal(r.ok, true);
  assert.equal(db.state.minute.status, 'done');
  assert.equal(step.attempts['transcribe-1'], 1);
  assert.equal(step.attempts['transcribe-2'], 2, '2 つ目は 1 回失敗して 2 回目で成功');
  assert.equal(step.attempts['transcribe-3'], 1);
  assert.deepEqual(db.state.segments.map((s) => s.transcript_status), ['done', 'done', 'done']);
  assert.equal(JSON.parse(db.state.minute.progress).segmentsDone, 3);

  // 通しの文字起こしは区切りの開始時刻を足した時刻（2 つ目は +10 分、3 つ目は +20 分）
  const transcript = await env.DATA.m.get('minutes/M1/transcript-v1.txt');
  assert.match(transcript, /\[00:00:05\] 話者A: 一つ目/);
  assert.match(transcript, /\[00:10:05\] 話者A: 二つ目/);
  assert.match(transcript, /\[00:20:05\] 話者A: 三つ目/);
  assert.equal(await env.DATA.m.get('minutes/M1/summary-v1.md'), '## 要点\nまとめ');
  assert.equal(db.state.minute.transcript_version, 1);
  assert.equal(db.state.minute.summary_version, 1);

  // 音声は Files API へ預け、使い終わったら消している
  assert.equal(fetch.calls.filter((c) => c.method === 'DELETE').length, 3);
  // 利用量: 区切りごとに文字起こし（失敗 1 + 成功 3）と議事録 1
  const tr = events.filter((e) => e.kind === 'transcribe');
  assert.equal(tr.filter((e) => e.ok).length, 3);
  assert.equal(tr.filter((e) => !e.ok).length, 1);
  assert.equal(events.filter((e) => e.kind === 'summarize' && e.ok).length, 1);
  assert.ok(events.every((e) => e.userId === 'U1'));
  assert.ok(tr.filter((e) => e.ok).every((e) => e.audioSeconds === 600 && e.cost > 0));
});

test('blocked は再試行せず failed にして、run は正常に終わる。done の区切りは次回飛ばす', async () => {
  const db = fakeDb({ minute: baseMinute, segments: [seg(1), seg(2)] });
  const env = { DB: db, AUDIO: audioFiles(), DATA: fakeR2() };
  const events = [];
  const blocked = () => jsonRes({ candidates: [{ finishReason: 'SAFETY' }], promptFeedback: { blockReason: 'SAFETY' } });
  const fetch1 = fakeFetch([() => genOk('[00:01] 話者A: はい'), blocked]);
  const step1 = fakeStep();
  const r1 = await runMinutesPipeline({ env, deps: makeDeps({ fetch: fetch1, events }), event: { payload: { minuteId: 'M1', target: 'generate' } }, step: step1 });
  assert.equal(r1.ok, false);
  assert.equal(db.state.minute.status, 'failed');
  const failure = JSON.parse(db.state.minute.failure);
  assert.equal(failure.step, 'transcribe');
  assert.equal(failure.kind, 'blocked');
  assert.equal(failure.retryable, false);
  assert.equal(step1.attempts['transcribe-2'], 1, 'blocked は再試行しない');

  // 「もう一度試す」: 1 つ目は done なので飛ばす
  db.state.segments[1].transcript_status = 'pending';
  const fetch2 = fakeFetch([() => genOk('[00:01] 話者B: どうも'), () => genOk('議事録')]);
  const step2 = fakeStep();
  const r2 = await runMinutesPipeline({ env, deps: makeDeps({ fetch: fetch2, events }), event: { payload: { minuteId: 'M1', target: 'generate' } }, step: step2 });
  assert.equal(r2.ok, true);
  assert.equal(step2.attempts['transcribe-1'], undefined, 'done の区切りは飛ばす');
  assert.equal(step2.attempts['transcribe-2'], 1);
  assert.equal(db.state.minute.status, 'done');
});

test('MAX_TOKENS の区切りは失敗にして再試行する', async () => {
  const db = fakeDb({ minute: baseMinute, segments: [seg(1)] });
  const env = { DB: db, AUDIO: audioFiles(), DATA: fakeR2() };
  const cut = () => jsonRes({ candidates: [{ content: { parts: [{ text: '途中まで' }] }, finishReason: 'MAX_TOKENS' }] });
  const step = fakeStep();
  const r = await runMinutesPipeline({
    env, deps: makeDeps({ fetch: fakeFetch([cut, cut, cut]), events: [] }),
    event: { payload: { minuteId: 'M1', target: 'generate' } }, step,
  });
  assert.equal(step.attempts['transcribe-1'], 3);
  assert.equal(r.ok, false);
  const failure = JSON.parse(db.state.minute.failure);
  assert.equal(failure.kind, 'truncated');
  assert.equal(failure.retryable, true);
});

test('target=summary は議事録だけを作り直し、前の版を prev に残す', async () => {
  const db = fakeDb({
    minute: { ...baseMinute, status: 'queued', transcript_key: 'minutes/M1/transcript-v1.txt', transcript_version: 1, summary_key: 'minutes/M1/summary-v1.md', summary_version: 1 },
    segments: [seg(1, { transcript_status: 'done' })],
  });
  const env = { DB: db, AUDIO: audioFiles(), DATA: fakeR2({ 'minutes/M1/transcript-v1.txt': '[00:00:01] 話者A: こんにちは', 'minutes/M1/summary-v1.md': '古い' }) };
  const step = fakeStep();
  const r = await runMinutesPipeline({
    env, deps: makeDeps({ fetch: fakeFetch([() => genOk('新しい')]), events: [] }),
    event: { payload: { minuteId: 'M1', target: 'summary' } }, step,
  });
  assert.equal(r.ok, true);
  assert.equal(step.attempts['transcribe-1'], undefined);
  assert.equal(db.state.minute.summary_key, 'minutes/M1/summary-v2.md');
  assert.equal(db.state.minute.summary_prev_key, 'minutes/M1/summary-v1.md');
  assert.equal(db.state.minute.transcript_version, 1);
});

test('音声の期限切れでは transcript の再生成が 400 validation「音声は削除されました」', () => {
  const expired = { ...baseMinute, status: 'done', audio_expires_at: '2026-10-01T00:00:00.000Z', audio_deleted: 0, transcript_key: 'k' };
  const now = new Date('2026-10-10T00:00:00.000Z');
  assert.throws(
    () => planStart(expired, { mode: 'regenerate', target: 'transcript' }, now),
    (e) => e.status === 400 && e.code === 'validation' && e.message === '音声は削除されました',
  );
  // 議事録だけの作り直しは音声が無くてもできる
  assert.equal(planStart(expired, { mode: 'regenerate', target: 'summary' }, now).target, 'summary');
  // 期限内なら文字起こしもできる
  const ok = { ...expired, audio_expires_at: '2026-10-12T00:00:00.000Z' };
  assert.equal(planStart(ok, { mode: 'regenerate', target: 'transcript' }, now).target, 'transcript');
});

test('generate: 議事録の段階で失敗していれば議事録だけ、処理中は 409、止まった処理は引き継ぐ', () => {
  const now = new Date('2026-10-02T06:00:00.000Z');
  const audio = { audio_expires_at: '2026-10-09T00:00:00.000Z', audio_deleted: 0 };
  const failedSummary = { ...baseMinute, ...audio, status: 'failed', transcript_key: 'k', failure: JSON.stringify({ step: 'summarize' }), updated_at: '2026-10-02T05:50:00.000Z' };
  assert.equal(planStart(failedSummary, { mode: 'generate' }, now).target, 'summary');
  const failedTr = { ...failedSummary, failure: JSON.stringify({ step: 'transcribe' }) };
  assert.equal(planStart(failedTr, { mode: 'generate' }, now).target, 'generate');

  const running = { ...baseMinute, ...audio, status: 'transcribing', updated_at: '2026-10-02T05:55:00.000Z' };
  assert.throws(() => planStart(running, { mode: 'generate' }, now), (e) => e.status === 409);
  const stuck = { ...running, updated_at: '2026-10-02T05:30:00.000Z' }; // 30 分動きが無い
  const plan = planStart(stuck, { mode: 'generate' }, now);
  assert.equal(plan.takeover, true);
  assert.equal(plan.target, 'generate');

  assert.throws(() => planStart({ ...baseMinute, status: 'recording' }, { mode: 'generate' }, now), (e) => e.status === 400);
});
