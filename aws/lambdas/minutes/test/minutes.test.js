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

// ---- 資料を踏まえた議事録（§15.3b。目次化も対応表も作らず、資料をそのまま渡す） ----

const SUMMARY_MD = '## 要点\n資料に沿った議事録（売上は関東 120）';
const XLSX_EXTRACT = { kind: 'xlsx', sheets: [{ name: '売上', rows: [['地域', '値'], ['関東', 120]], truncated: false, charts: [] }] };
const PPTX_EXTRACT = { kind: 'pptx', slides: [{ no: 3, title: '地域別売上', text: 'あ'.repeat(900), notes: '', charts: [] }] };

function materialSeed({ withPdf = true, withPptx = false } = {}) {
  const rows = [
    {
      pk: 'MIN#m1', sk: 'META', status: 'queued', ownerEmail: 'a@x.jp', title: '定例', heldAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
      transcript: { key: 'minutes/m1/transcript-v1.txt', version: 1 },
      summary: { key: 'minutes/m1/summary-v1.md', version: 1 },
    },
  ];
  if (withPdf) rows.push({ pk: 'MIN#m1', sk: 'MAT#001', id: 'm001', seq: 1, name: '提案書.pdf', kind: 'pdf', state: 'ready', key: 'minutes/m1/materials/m001.pdf' });
  rows.push({ pk: 'MIN#m1', sk: 'MAT#002', id: 'm002', seq: 2, name: '売上.xlsx', kind: 'xlsx', state: 'ready', key: 'minutes/m1/materials/m002.xlsx', extractKey: 'minutes/m1/materials/m002.extract.json' });
  if (withPptx) rows.push({ pk: 'MIN#m1', sk: 'MAT#003', id: 'm003', seq: 3, name: '説明.pptx', kind: 'pptx', state: 'ready', key: 'minutes/m1/materials/m003.pptx', extractKey: 'minutes/m1/materials/m003.extract.json' });
  return rows;
}

function putMaterials(t, { pdfBytes = Buffer.from('%PDF-1.4 fake') } = {}) {
  t.puts.set('minutes/m1/transcript-v1.txt', Buffer.from('[00:00:10] 話者A: この数字が'));
  t.puts.set('minutes/m1/materials/m001.pdf', pdfBytes);
  t.puts.set('minutes/m1/materials/m002.extract.json', Buffer.from(JSON.stringify(XLSX_EXTRACT)));
  t.puts.set('minutes/m1/materials/m003.extract.json', Buffer.from(JSON.stringify(PPTX_EXTRACT)));
}

function materialDeps(ddb, { text = SUMMARY_MD, pdfBytes } = {}) {
  const calls = [];
  const t = makeDeps({
    ddb,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      const parts = (body.contents ?? []).flatMap((c) => c.parts ?? []);
      calls.push({
        order: parts.map((p) => (p.inlineData ? 'pdf' : p.fileData ? 'file' : 'text')),
        prompt: parts.map((p) => p.text ?? '').join(''),
        schema: body.generationConfig?.responseSchema,
      });
      return reply(text);
    },
  });
  putMaterials(t, { pdfBytes });
  return { t, calls };
}

test('資料つき: PDF（小）は inlineData で、プロンプトの前に 1 回で渡す。目次化も対応表も無い', async () => {
  const ddb = fakeDdb(materialSeed());
  const { t, calls } = materialDeps(ddb);
  const r = await runMinutes({ minuteId: 'm1', target: 'summary', withMaterials: true }, t.deps);
  assert.equal(r.ok, true);

  // モデルの呼び出しは議事録の 1 回だけ。parts は PDF → 文。JSON スキーマは付けない
  assert.equal(t.fetchCalls, 1);
  assert.deepEqual(calls[0].order, ['pdf', 'text']);
  assert.equal(calls[0].schema, undefined);
  assert.match(calls[0].prompt, /関東\t120/); // xlsx の全行が文字で入っている
  assert.match(calls[0].prompt, /資料 1: 提案書\.pdf\n {2}（添付の PDF を見てください）/);

  const meta = ddb.m.get('MIN#m1|META');
  assert.equal(meta.status, 'done');
  assert.equal(meta.summary.version, 2);
  assert.equal(meta.summary.withMaterials, true);
  assert.deepEqual(meta.summary.materialIds, ['m001', 'm002']);
  assert.equal(meta.summary.mappingKey, null);
  assert.equal(meta.summary.previousKey, 'minutes/m1/summary-v1.md');
  assert.equal(t.puts.get('minutes/m1/summary-v2.md').toString(), SUMMARY_MD);
  // 目次も対応表も S3 に書かない
  assert.ok(![...t.puts.keys()].some((k) => /outline|mapping/.test(k)));
  assert.equal(t.usage.length, 1);
  assert.equal(t.usage[0].kind, 'summarize');
  assert.equal(t.usage[0].retry, true);
});

test('資料つき: pptx の本文は 600 文字で切らずに prompt へ入る', async () => {
  const ddb = fakeDdb(materialSeed({ withPdf: false, withPptx: true }));
  const { t, calls } = materialDeps(ddb);
  const r = await runMinutes({ minuteId: 'm1', target: 'summary', withMaterials: true }, t.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].order, ['text']);
  assert.ok(calls[0].prompt.includes('あ'.repeat(900)));
  assert.match(calls[0].prompt, /スライド 3「地域別売上」/);
});

test('資料つき: 応答が {"markdown": ...} の JSON でも、Markdown を取り出して保存する', async () => {
  const ddb = fakeDdb(materialSeed());
  const { t } = materialDeps(ddb, { text: JSON.stringify({ mapping: [], markdown: '## 要点\n古いプロンプトの答え' }) });
  const r = await runMinutes({ minuteId: 'm1', target: 'summary', withMaterials: true }, t.deps);
  assert.equal(r.ok, true);
  assert.equal(t.puts.get('minutes/m1/summary-v2.md').toString(), '## 要点\n古いプロンプトの答え');
});

test('資料つき: OpenAI は PDF を /v1/files に預けて input_file で渡し、終わったら削除する', async () => {
  const s = materialSeed();
  s.push({ pk: 'ORG', sk: 'SETTING#gemini', models: { summarize: 'gpt-x' } });
  s.push({ pk: 'ORG', sk: 'MODEL#gpt-x', provider: 'openai', uses: ['summarize'] });
  const ddb = fakeDdb(s);
  const log = [];
  let responsesBody;
  const t = makeDeps({
    ddb,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/v1/files') && init.method === 'POST') { log.push('upload'); return { status: 200, json: async () => ({ id: 'file-1', bytes: 10 }) }; }
      if (init.method === 'DELETE') { log.push(`delete:${url.split('/').pop()}`); return { status: 200, json: async () => ({}) }; }
      log.push('responses');
      responsesBody = JSON.parse(init.body);
      return { status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: SUMMARY_MD }] }], usage: { input_tokens: 10, output_tokens: 5 } }) };
    },
  });
  putMaterials(t);
  const r = await runMinutes({ minuteId: 'm1', target: 'summary', withMaterials: true }, t.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(log, ['upload', 'responses', 'delete:file-1']);
  const content = responsesBody.input[0].content;
  assert.deepEqual(content.map((c) => c.type), ['input_file', 'input_text']);
  assert.equal(content[0].file_id, 'file-1');
  assert.equal(responsesBody.text?.format, undefined);
  assert.equal(t.puts.get('minutes/m1/summary-v2.md').toString(), SUMMARY_MD);
});

test('資料つきでない議事録の作り直しは資料の印を外し、前の版の印を残す', async () => {
  const s = materialSeed();
  s[0].summary = { key: 'minutes/m1/summary-v2.md', version: 2, withMaterials: true, materialIds: ['m001'], mappingKey: 'minutes/m1/summary-mapping-v2.json' };
  const ddb = fakeDdb(s);
  const { t } = materialDeps(ddb, {});
  await runMinutes({ minuteId: 'm1', target: 'summary' }, t.deps);
  const sm = ddb.m.get('MIN#m1|META').summary;
  assert.equal(sm.withMaterials, false);
  assert.equal(sm.previousWithMaterials, true);
  assert.equal(sm.previousMappingKey, 'minutes/m1/summary-mapping-v2.json');
});

// ---- 区切りの分け方（長さ・大きさ・コピー） ----

// 偽の ffmpeg。exec の呼び出しを記録し、onExec が返した名前の部品を出来たことにする
function splitIo(onExec) {
  const calls = [];
  let names = [];
  return {
    calls,
    io: {
      exists: async () => true,
      mkdtemp: async () => '/tmp/x',
      writeFile: async () => {},
      readFile: async () => Buffer.from('part'),
      readdir: async () => names,
      rm: async (p) => { names = names.filter((n) => !p.endsWith(n)); },
      exec: async (cmd, args) => {
        calls.push(args);
        const r = onExec(args, calls.length);
        if (r instanceof Error) throw r;
        names = r;
      },
    },
  };
}

async function runSplit({ mime, durationSec, size, onExec }) {
  const sio = splitIo(onExec);
  const ddb = fakeDdb([
    { pk: 'MIN#m1', sk: 'META', status: 'queued', ownerEmail: 'a@x.jp', title: '定例', heldAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
    { pk: 'MIN#m1', sk: 'SEG#1', seq: 1, key: 'minutes/m1/seg-1.m4a', mime, startSec: 0, durationSec, transcriptStatus: 'pending' },
  ]);
  const t = makeDeps({ ddb, fetchImpl: async (u, init) => {
    const body = JSON.parse(init.body);
    const inline = (body.contents ?? []).flatMap((c) => c.parts ?? []).find((p) => p.inlineData)?.inlineData;
    if (inline) t.mimes.push(inline.mimeType);
    return reply(inline ? '[00:05] 話者A: こんにちは' : '## 要点\n議事録');
  } });
  t.mimes = [];
  t.puts.set('minutes/m1/seg-1.m4a', Buffer.alloc(size));
  t.deps.io = sio.io;
  await runMinutes({ minuteId: 'm1', target: 'generate' }, t.deps);
  return { t, calls: sio.calls };
}

test('m4a は再エンコードせずコピーで切り、部品の MIME は audio/mp4', async () => {
  const { t, calls } = await runSplit({
    mime: 'audio/mp4', durationSec: 1500, size: 1000,
    onExec: () => ['part-000.m4a', 'part-001.m4a', 'part-002.m4a'],
  });
  const a = calls[0];
  assert.deepEqual(a.slice(a.indexOf('-c:a'), a.indexOf('-c:a') + 2), ['-c:a', 'copy']);
  assert.ok(a.includes('-vn') && a.includes('ipod') && !a.includes('libmp3lame'));
  assert.deepEqual(t.mimes, ['audio/mp4', 'audio/mp4', 'audio/mp4']);
  assert.match(t.puts.get('minutes/m1/transcript-v1.txt').toString(), /\[00:20:05\]/);
});

test('コピーが失敗したら mp3 への再エンコードに落ちる', async () => {
  const { t, calls } = await runSplit({
    mime: 'audio/x-m4a', durationSec: 1500, size: 1000,
    onExec: (args, n) => (n === 1 ? new Error('ffmpeg exited 1') : ['part-000.mp3', 'part-001.mp3', 'part-002.mp3']),
  });
  assert.equal(calls.length >= 2, true);
  assert.ok(calls[1].includes('libmp3lame'));
  assert.deepEqual(t.mimes, ['audio/mp3', 'audio/mp3', 'audio/mp3']);
});

test('20MB を超えるなら、長さが上限内でも分ける', async () => {
  const { t, calls } = await runSplit({
    mime: 'audio/mp4', durationSec: 300, size: 21 * 1024 * 1024,
    onExec: () => ['part-000.m4a', 'part-001.m4a'],
  });
  assert.equal(calls.length >= 1, true);
  const st = calls[0][calls[0].indexOf('-segment_time') + 1];
  assert.ok(Number(st) < 300); // 大きさから逆算して、上限より短く切る
  assert.equal(t.mimes.length, 2);
});

test('durationSec が 0 でも、大きさから 64kbps 相当で概算して分ける', async () => {
  // 21MB / 8000 = 約 2750 秒 > 600 秒
  const { t, calls } = await runSplit({
    mime: 'audio/mp4', durationSec: 0, size: 21 * 1024 * 1024,
    onExec: () => ['part-000.m4a', 'part-001.m4a'],
  });
  assert.equal(calls.length >= 1, true);
  assert.equal(calls[0][calls[0].indexOf('-segment_time') + 1], '600');
  assert.equal(t.mimes.length, 2);
});

// ---- 拒否（blocked）された区切り ----

// 元の区切り（中身が空の音声）は常に blocked。部品は blockedParts の番号だけ blocked
async function runBlocked({ blockedParts = [], bodies = [] }) {
  const calls = [];
  const ddb = fakeDdb([
    { pk: 'MIN#m1', sk: 'META', status: 'queued', ownerEmail: 'a@x.jp', title: '定例', heldAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
    { pk: 'MIN#m1', sk: 'SEG#1', seq: 1, key: 'minutes/m1/seg-1.m4a', mime: 'audio/mp4', startSec: 0, durationSec: 600, transcriptStatus: 'pending' },
  ]);
  let names = [];
  const t = makeDeps({ ddb, fetchImpl: async (u, init) => {
    bodies.push(JSON.parse(init.body));
    const inline = bodies.at(-1).contents.flatMap((c) => c.parts ?? []).find((p) => p.inlineData)?.inlineData;
    if (!inline) return reply('## 要点\n議事録');
    const audio = Buffer.from(inline.data, 'base64').toString();
    const m = /^part-(\d+)$/.exec(audio);
    if (!m || blockedParts.includes(Number(m[1]))) {
      t.blockedCalls = (t.blockedCalls ?? 0) + 1;
      return reply('', 'SAFETY');
    }
    return reply('[00:05] 話者A: こんにちは');
  } });
  t.puts.set('minutes/m1/seg-1.m4a', Buffer.from('whole'));
  let readIdx = 0;
  t.deps.io = {
    exists: async () => true, mkdtemp: async () => '/tmp/x', writeFile: async () => {},
    readFile: async (f) => Buffer.from(f.slice(Math.max(f.lastIndexOf('/'), f.lastIndexOf(String.fromCharCode(92))) + 1).replace(/\.\w+$/, '')),
    readdir: async () => names, rm: async () => {},
    exec: async (cmd, args) => { calls.push(args); names = ['part-000.m4a', 'part-001.m4a', 'part-002.m4a', 'part-003.m4a']; readIdx++; },
  };
  const sleeps = [];
  t.deps.sleep = async (ms) => { sleeps.push(ms); };
  await runMinutes({ minuteId: 'm1', target: 'generate' }, t.deps);
  return { t, calls, sleeps, ddb };
}

test('blocked は数回やり直し、それでも駄目なら 4 等分して起こし、全部通れば結合する', async () => {
  const { t, calls, sleeps } = await runBlocked({});
  assert.equal(t.blockedCalls, 3); // 最初 + やり直し 2 回
  assert.deepEqual(sleeps, [2000, 5000]);
  const st = calls[0][calls[0].indexOf('-segment_time') + 1];
  assert.equal(st, '150'); // 600 秒 ÷ 4
  const text = t.puts.get('minutes/m1/transcript-v1.txt').toString();
  assert.match(text, /\[00:00:05\]/);
  assert.match(text, /\[00:02:35\]/);
  assert.match(text, /\[00:05:05\]/);
  assert.match(text, /\[00:07:35\]/);
  assert.doesNotMatch(text, /文字起こしできませんでした/);
});

test('1 部品だけ blocked のままなら、その分は置き換えの行になり、区切りは成功する', async () => {
  const { t, ddb } = await runBlocked({ blockedParts: [2] });
  const text = t.puts.get('minutes/m1/transcript-v1.txt').toString();
  assert.ok(text.includes('[00:05:00〜00:07:30 この区間は文字起こしできませんでした]'));
  assert.match(text, /\[00:07:35\]/);
  const seg = ddb.items?.get?.('MIN#m1|SEG#1');
  if (seg) assert.equal(seg.transcriptStatus, 'done');
  assert.ok(t.puts.has('minutes/m1/transcript-v1.txt'));
});

test('Gemini の body に safetySettings（BLOCK_NONE）が入る', async () => {
  const bodies = [];
  await runBlocked({ bodies });
  const withAudio = bodies.filter((b) => b.contents.some((c) => c.parts.some((p) => p.inlineData)));
  assert.ok(withAudio.length > 0);
  for (const b of withAudio) {
    assert.equal(b.safetySettings.length, 4);
    assert.ok(b.safetySettings.every((s) => s.threshold === 'BLOCK_NONE'));
  }
});

// 14MB 以上の PDF は Files API に預けてから fileData で読ませ、読み終えたら削除する
function bigPdfDeps(ddb, states) {
  const log = [];
  const t = makeDeps({
    ddb,
    fetchImpl: async (url, init) => {
      if (url.includes('/upload/v1beta/files')) {
        log.push('start');
        return { status: 200, headers: new Headers({ 'x-goog-upload-url': 'https://up.example/u1' }), json: async () => ({}) };
      }
      if (url === 'https://up.example/u1') {
        log.push('body');
        return { status: 200, json: async () => ({ file: { name: 'files/abc', uri: 'https://g/files/abc', state: states[0] } }) };
      }
      if (init.method === 'GET' && url.endsWith('/files/abc')) {
        log.push('get');
        return { status: 200, json: async () => ({ file: { name: 'files/abc', uri: 'https://g/files/abc', state: states[1] } }) };
      }
      if (init.method === 'DELETE') { log.push('delete'); return { status: 200, json: async () => ({}) }; }
      const parts = (JSON.parse(init.body).contents ?? []).flatMap((c) => c.parts ?? []);
      const fd = parts.find((p) => p.fileData);
      log.push(`generate:${fd?.fileData.fileUri}:${Boolean(parts.find((p) => p.inlineData))}:${parts.at(-1).text ? 'text-last' : 'no-text'}`);
      return reply(SUMMARY_MD);
    },
  });
  putMaterials(t, { pdfBytes: Buffer.alloc(14 * 1024 * 1024 + 1) });
  return { t, log };
}

test('資料つき: 14MB 以上の PDF は Files API に預けて fileData で読み、終わったら削除する', async () => {
  const ddb = fakeDdb(materialSeed());
  const { t, log } = bigPdfDeps(ddb, ['ACTIVE']);
  const r = await runMinutes({ minuteId: 'm1', target: 'summary', withMaterials: true }, t.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(log, ['start', 'body', 'generate:https://g/files/abc:false:text-last', 'delete']);
});

test('資料つき: Files API が PROCESSING のあいだは ACTIVE になるまで待ってから読む', async () => {
  const ddb = fakeDdb(materialSeed());
  const { t, log } = bigPdfDeps(ddb, ['PROCESSING', 'ACTIVE']);
  const r = await runMinutes({ minuteId: 'm1', target: 'summary', withMaterials: true }, t.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(log, ['start', 'body', 'get', 'generate:https://g/files/abc:false:text-last', 'delete']);
});

test('資料つき: 直接入れる PDF は合計で判定し、合計が 14MB を超える分だけ Files API に預ける', async () => {
  // 8MB の PDF が 2 つ。1 件ずつなら両方とも直接入れてしまい、合計でリクエストの上限（20MB）を超える
  const seed = materialSeed();
  seed.push({ pk: 'MIN#m1', sk: 'MAT#004', id: 'm004', seq: 4, name: '別紙.pdf', kind: 'pdf', state: 'ready', key: 'minutes/m1/materials/m004.pdf' });
  const ddb = fakeDdb(seed);
  const { t, log } = bigPdfDeps(ddb, ['ACTIVE']);
  t.puts.set('minutes/m1/materials/m001.pdf', Buffer.alloc(8 * 1024 * 1024));
  t.puts.set('minutes/m1/materials/m004.pdf', Buffer.alloc(8 * 1024 * 1024));
  const r = await runMinutes({ minuteId: 'm1', target: 'summary', withMaterials: true }, t.deps);
  assert.equal(r.ok, true);
  // 1 つ目は直接（inlineData）、2 つ目は Files API（fileData）。両方が 1 回の呼び出しに入る
  assert.deepEqual(log, ['start', 'body', 'generate:https://g/files/abc:true:text-last', 'delete']);
});
