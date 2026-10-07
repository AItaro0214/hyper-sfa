// 資料を踏まえた議事録（minutes-design.md §15.3b）。実 API は呼ばず、偽物の step / D1 / R2 / fetch で流れを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { runMinutesPipeline } from '../worker/src/minutes/pipeline.js';
import { minutesRoutes } from '../worker/src/minutes/index.js';
import * as gemini from '../../packages/core/src/gemini.js';
import * as openai from '../../packages/core/src/openai.js';
import * as materials from '../../packages/core/src/materials.js';
import { extractJson } from '../../packages/core/src/json.js';
import { renderPrompt } from '../../packages/core/src/prompts.js';
import { joinSegments, offsetTimestamps } from '../../packages/core/src/transcript.js';
import { DEFAULT_MODELS, estimateCost } from '../../packages/core/src/models.js';

// ---- 偽物 ----

function fakeStep() {
  const attempts = {};
  return {
    attempts,
    async do(name, config, fn) {
      if (typeof config === 'function') [config, fn] = [{}, config];
      const limit = config?.retries?.limit ?? 0;
      let last;
      for (let i = 0; i <= limit; i++) {
        attempts[name] = (attempts[name] ?? 0) + 1;
        try {
          return JSON.parse(JSON.stringify((await fn()) ?? null));
        } catch (e) {
          last = e;
        }
      }
      throw last;
    },
    async sleep() {},
  };
}

function fakeR2(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    async get(key) {
      if (!m.has(key)) return null;
      const v = m.get(key);
      return { size: v.length, body: new Blob([v]).stream(), async text() { return v; } };
    },
    async put(key, v) { m.set(key, typeof v === 'string' ? v : '[stream]'); },
    async delete(k) { for (const x of [].concat(k)) m.delete(x); },
    async head(key) { return m.has(key) ? { size: m.get(key).length } : null; },
  };
}

const MIN = {
  id: 'M1', title: '定例', held_at: '2026-10-02T05:00:00.000Z', memo: '', owner_id: 'U1', status: 'queued',
  transcript_key: 'minutes/M1/transcript-v1.txt', transcript_prev_key: null, transcript_version: 1,
  summary_key: 'minutes/M1/summary-v1.md', summary_prev_key: null, summary_version: 1,
  summary_with_materials: 0, summary_mapping_key: null, summary_prev_mapping_key: null,
};
const mat = (seq, extra) => ({ id: `MAT${seq}`, seq, outline_key: null, extract_key: null, size: 10, pages: null, ...extra });
const PDF = mat(1, { name: '提案書.pdf', kind: 'pdf', key: 'minutes/M1/materials/MAT1.pdf', outline_status: 'pending', pages: 3 });
const XLSX = mat(2, {
  name: '売上.xlsx', kind: 'xlsx', key: 'minutes/M1/materials/MAT2.xlsx',
  extract_key: 'minutes/M1/materials/MAT2.extract.json', outline_status: 'none',
});
const XLSX_EXTRACT = JSON.stringify({ kind: 'xlsx', sheets: [{ name: '地域別売上', rows: [['地域', '売上'], ['関東', 120], ['関西', 95]], charts: [] }] });

function fakeDb({ materialRows }) {
  const S = { minute: { ...MIN }, materials: materialRows.map((m) => ({ ...m })) };
  const exec = (sql, a) => {
    if (/^SELECT \* FROM minutes/.test(sql)) return S.minute;
    if (/FROM minute_segments/.test(sql)) return { results: [] };
    if (/FROM minute_counterparts/.test(sql)) return { results: [{ company: '株式会社アシスト', department: '', name: '山田 太郎' }] };
    if (/FROM minute_attendees/.test(sql)) return { results: [{ display_name: '佐藤 花子' }] };
    if (/FROM minute_materials WHERE minute_id/.test(sql)) return { results: S.materials.map((m) => ({ ...m })) };
    if (/UPDATE minute_materials SET outline_key/.test(sql)) {
      Object.assign(S.materials.find((m) => m.id === a[1]), { outline_key: a[0], outline_status: 'done' });
      return {};
    }
    if (/UPDATE minute_materials SET outline_status = 'failed'/.test(sql)) {
      S.materials.find((m) => m.id === a[0]).outline_status = 'failed';
      return {};
    }
    if (/SELECT transcript_key, summary_key, summary_prev_key/.test(sql)) {
      const m = S.minute;
      return { transcript_key: m.transcript_key, summary_key: m.summary_key, summary_prev_key: m.summary_prev_key, summary_prev_mapping_key: m.summary_prev_mapping_key };
    }
    if (/SET status = 'summarizing'/.test(sql)) { Object.assign(S.minute, { status: 'summarizing', step: 'summarize_materials' }); return {}; }
    if (/UPDATE minutes SET summary_prev_key/.test(sql)) {
      Object.assign(S.minute, {
        summary_prev_key: S.minute.summary_key, summary_key: a[0], summary_version: a[1], summary_model: a[2],
        summary_with_materials: a[5], summary_material_ids: a[6], summary_mapping_key: a[7],
      });
      return {};
    }
    if (/SET status = 'done'/.test(sql)) { S.minute.status = 'done'; return {}; }
    if (/SET status = 'failed'/.test(sql)) { Object.assign(S.minute, { status: 'failed', failure: a[0] }); return {}; }
    throw new Error(`偽物が知らない SQL: ${sql}`);
  };
  const prepare = (sql) => ({
    bind: (...a) => ({ first: async () => exec(sql, a), all: async () => exec(sql, a), run: async () => exec(sql, a) }),
  });
  return { prepare, state: S };
}

const jsonRes = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers });
const genOk = (text) => jsonRes({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } });

function fakeFetch(replies) {
  const calls = [];
  let g = 0;
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method, body: init.body });
    if (u.includes('/upload/v1beta/files')) return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/x' } });
    if (u === 'https://upload.example/x') return jsonRes({ file: { name: 'files/a', uri: 'https://files.example/a', mimeType: 'application/pdf', state: 'ACTIVE' } });
    if (u.includes('/v1beta/files/')) return init.method === 'DELETE' ? jsonRes({}) : jsonRes({ name: 'files/a', state: 'ACTIVE' });
    if (u.includes(':generateContent')) return replies[Math.min(g++, replies.length - 1)]();
    throw new Error(`知らない URL: ${u}`);
  };
  f.calls = calls;
  return f;
}

function makeDeps({ fetch, events, provider = 'gemini' }) {
  const model = provider === 'openai' ? DEFAULT_MODELS.find((m) => m.provider === 'openai' && (m.uses ?? []).includes('summarize')) : DEFAULT_MODELS.find((m) => m.provider === 'gemini' && (m.uses ?? []).includes('summarize')) ?? DEFAULT_MODELS.find((m) => m.provider === 'gemini');
  const prompts = {
    summarize: '議事録 {{TRANSCRIPT}}',
    transcribe: '文字起こし',
    summarize_materials: '資料つき議事録\n{{MATERIALS}}\n---\n{{TRANSCRIPT}}',
  };
  return {
    fetch, ...gemini, ...openai, ...materials, extractJson,
    renderPrompt, joinSegments, offsetTimestamps, estimateCost,
    usageEvent: (o) => ({ ...o }),
    recordUsage: async (_env, ev) => { events.push(ev); },
    getApiKey: async () => 'test-key',
    getSelectedModel: async () => model.id,
    getModel: async () => model,
    getPrompt: async (_env, kind) => ({ text: prompts[kind], version: 1 }),
  };
}

const SUMMARY_MD = '## 要点\n資料に沿った議事録（関東は 120）';

function run(env, deps) {
  const step = fakeStep();
  return runMinutesPipeline({ env, deps, event: { payload: { minuteId: 'M1', target: 'summary', withMaterials: true } }, step }).then((r) => ({ r, step }));
}

// ---- テスト ----

test('PDF（Gemini）と xlsx: 資料をそのまま 1 回で渡し、議事録だけ保存する（目次も対応表も無い）', async () => {
  const db = fakeDb({ materialRows: [PDF, XLSX] });
  const env = {
    DB: db,
    AUDIO: fakeR2(),
    DATA: fakeR2({
      'minutes/M1/transcript-v1.txt': '[00:12:10] 話者A: 関西が伸びています',
      'minutes/M1/summary-v1.md': '古い',
      [PDF.key]: '%PDF-1.7',
      [XLSX.key]: 'xlsx',
      [XLSX.extract_key]: XLSX_EXTRACT,
    }),
  };
  const events = [];
  const fetch = fakeFetch([() => genOk(SUMMARY_MD)]);
  const { r, step } = await run(env, makeDeps({ fetch, events }));

  assert.equal(r.ok, true);
  assert.equal(db.state.minute.status, 'done');
  assert.equal(step.attempts['summarize-materials'], 1);
  // PDF は Gemini の Files API に預けて、使い終わったら消す
  assert.equal(fetch.calls.filter((c) => c.method === 'DELETE').length, 1);
  // モデルの呼び出しは 1 回。parts は PDF の fileData → プロンプトの文。JSON スキーマは付けない
  const gens = fetch.calls.filter((c) => c.url.includes(':generateContent'));
  assert.equal(gens.length, 1);
  const body = JSON.parse(gens[0].body);
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].fileData.mimeType, 'application/pdf');
  assert.equal(body.generationConfig.responseMimeType, undefined);
  const prompt = parts[1].text;
  assert.match(prompt, /資料 1: 提案書\.pdf\n {2}（添付の PDF を見てください）/);
  assert.match(prompt, /資料 2: 売上\.xlsx/);
  assert.match(prompt, /関東\t120/);
  assert.match(prompt, /関西が伸びています/);
  // 議事録だけ。目次も対応表も書かない
  assert.equal(await env.DATA.m.get('minutes/M1/summary-v2.md'), SUMMARY_MD);
  assert.ok(![...env.DATA.m.keys()].some((k) => /outline|mapping/.test(k)));
  const m = db.state.minute;
  assert.equal(m.summary_with_materials, 1);
  assert.equal(m.summary_mapping_key, null);
  assert.deepEqual(JSON.parse(m.summary_material_ids), ['MAT1', 'MAT2']);
  assert.equal(m.summary_prev_key, 'minutes/M1/summary-v1.md');
  // 利用量は summarize のやり直しとして 1 回だけ数える
  const used = events.filter((e) => e.kind === 'summarize' && e.ok);
  assert.equal(used.length, 1);
  assert.ok(used.every((e) => e.retry === true && e.userId === 'U1'));
});

test('pptx の本文は 600 文字で切らずに prompt に入り、応答が JSON でも Markdown を取り出す', async () => {
  const long = 'あ'.repeat(900);
  const PPTX = mat(1, { name: '説明.pptx', kind: 'pptx', key: 'minutes/M1/materials/MAT1.pptx', extract_key: 'minutes/M1/materials/MAT1.extract.json', outline_status: 'none' });
  const db = fakeDb({ materialRows: [PPTX] });
  const env = {
    DB: db,
    AUDIO: fakeR2(),
    DATA: fakeR2({
      'minutes/M1/transcript-v1.txt': '[00:00:01] 話者A: この数字が',
      [PPTX.extract_key]: JSON.stringify({ kind: 'pptx', slides: [{ no: 3, title: '地域別売上', text: long, notes: '', charts: [] }] }),
    }),
  };
  const fetch = fakeFetch([() => genOk(JSON.stringify({ mapping: [], markdown: '## 要点\n古いプロンプトの答え' }))]);
  const { r } = await run(env, makeDeps({ fetch, events: [] }));

  assert.equal(r.ok, true);
  const gens = fetch.calls.filter((c) => c.url.includes(':generateContent'));
  assert.equal(gens.length, 1);
  const parts = JSON.parse(gens[0].body).contents[0].parts;
  assert.equal(parts.length, 1, 'PDF が無ければ文だけ');
  assert.ok(parts[0].text.includes(long));
  assert.match(parts[0].text, /スライド 3「地域別売上」/);
  assert.equal(await env.DATA.m.get('minutes/M1/summary-v2.md'), '## 要点\n古いプロンプトの答え');
  assert.equal(fetch.calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('議事録のモデルが続けて失敗したら failed になり、預けたファイルは消す', async () => {
  const db = fakeDb({ materialRows: [PDF] });
  const env = {
    DB: db,
    AUDIO: fakeR2(),
    DATA: fakeR2({ 'minutes/M1/transcript-v1.txt': '[00:00:01] 話者A: こんにちは', [PDF.key]: '%PDF-1.7' }),
  };
  const down = () => jsonRes({ error: { status: 'UNAVAILABLE', message: 'overloaded' } }, 503);
  const fetch = fakeFetch([down]);
  const { r, step } = await run(env, makeDeps({ fetch, events: [] }));

  assert.equal(r.ok, false);
  assert.equal(step.attempts['summarize-materials'], 3);
  assert.equal(db.state.minute.status, 'failed');
  assert.equal(fetch.calls.filter((c) => c.method === 'DELETE').length, 1);
});

test('資料を使わない作り直しは、資料の印と対応表を外す', async () => {
  const db = fakeDb({ materialRows: [] });
  db.state.minute.summary_with_materials = 1;
  db.state.minute.summary_mapping_key = 'minutes/M1/summary-mapping-v1.json';
  const env = { DB: db, AUDIO: fakeR2(), DATA: fakeR2({ 'minutes/M1/transcript-v1.txt': '[00:00:01] 話者A: こんにちは' }) };
  const step = fakeStep();
  const r = await runMinutesPipeline({
    env, deps: makeDeps({ fetch: fakeFetch([() => genOk('通常の議事録')]), events: [] }),
    event: { payload: { minuteId: 'M1', target: 'summary' } }, step,
  });
  assert.equal(r.ok, true);
  assert.equal(db.state.minute.summary_with_materials, 0);
  assert.equal(db.state.minute.summary_mapping_key, null);
});

test('OpenAI: PDF は prefix + 本文 + suffix のストリームで /v1/files に預け、Responses で 1 回読ませて、すぐ消す', async () => {
  const db = fakeDb({ materialRows: [PDF] });
  const env = { DB: db, AUDIO: fakeR2(), DATA: fakeR2({ 'minutes/M1/transcript-v1.txt': '[00:00:01] 話者A: はい', [PDF.key]: '%PDF-BODY' }) };
  const calls = [];
  const response = { id: 'resp', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: SUMMARY_MD }] }], usage: { input_tokens: 10, output_tokens: 5 } };
  const fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method, body: init.body });
    if (u.endsWith('/v1/files') && init.method === 'POST') {
      const text = await new Response(init.body).text();
      assert.match(text, /%PDF-BODY/);
      assert.match(text, /name="purpose"/);
      assert.match(text, /filename="提案書\.pdf"/);
      assert.ok(text.endsWith('--\r\n'), '最後は終端の boundary');
      return jsonRes({ id: 'file-1', bytes: 9 });
    }
    if (u.includes('/v1/files/file-1')) return jsonRes({ deleted: true });
    if (u.endsWith('/v1/responses')) return jsonRes(response);
    throw new Error(`知らない URL: ${u}`);
  };
  const { r: out } = await run(env, makeDeps({ fetch, events: [], provider: 'openai' }));
  assert.equal(out.ok, true);
  const responsesCalls = calls.filter((c) => c.url.endsWith('/v1/responses'));
  assert.equal(responsesCalls.length, 1);
  const body = JSON.parse(responsesCalls[0].body);
  assert.deepEqual(body.input[0].content[0], { type: 'input_file', file_id: 'file-1' });
  assert.equal(body.input[0].content[1].type, 'input_text');
  assert.equal(body.text?.format, undefined, 'JSON スキーマは付けない');
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
  assert.equal(await env.DATA.m.get('minutes/M1/summary-v2.md'), SUMMARY_MD);
});

// ---- ルート: 資料 0 件の regenerate ----

function routeApp({ materialCount }) {
  const created = [];
  const row = { ...MIN, status: 'done', owner_id: 'U1', updated_at: new Date().toISOString(), audio_expires_at: null };
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: () => ({
          first: async () => {
            if (/FROM minutes WHERE id/.test(sql)) return row;
            if (/FROM minute_materials/.test(sql)) return { n: materialCount };
            if (/FROM minute_segments/.test(sql)) return { n: 1 };
            throw new Error(`偽物が知らない SQL: ${sql}`);
          },
          run: async () => ({}),
        }),
      }),
      batch: async () => [],
    },
    MINUTES_WORKFLOW: { create: async (o) => { created.push(o); } },
  };
  const app = new Hono();
  app.onError((e, c) => c.json({ code: e.code, message: e.message }, e.status ?? 500));
  app.use('*', async (c, next) => { c.set('user', { id: 'U1' }); await next(); });
  minutesRoutes(app);
  return { app, env, created };
}

test('資料 0 件の regenerate { withMaterials: true } は 400 validation', async () => {
  const { app, env, created } = routeApp({ materialCount: 0 });
  const res = await app.request('/api/minutes/M1/regenerate', { method: 'POST', body: JSON.stringify({ target: 'summary', withMaterials: true }), headers: { 'Content-Type': 'application/json' } }, env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'validation');
  assert.equal(created.length, 0);
});

test('資料があれば 202 で、Workflow に withMaterials: true を渡す', async () => {
  const { app, env, created } = routeApp({ materialCount: 2 });
  const res = await app.request('/api/minutes/M1/regenerate', { method: 'POST', body: JSON.stringify({ target: 'summary', withMaterials: true }), headers: { 'Content-Type': 'application/json' } }, env);
  assert.equal(res.status, 202);
  assert.equal(created[0].params.withMaterials, true);
  assert.equal(created[0].params.target, 'summary');
});
