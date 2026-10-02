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

// ---- 資料を踏まえた議事録（§15） ----

const OUTLINE_JSON = JSON.stringify({ sections: [{ page: 1, title: '表紙', summary: '提案の概要', figures: ['棒グラフ: 関西だけ伸びている'], keywords: ['提案'] }] });
const SUMMARY_JSON = JSON.stringify({
  mapping: [
    { material: 1, page: 1, start: '00:00:10', end: '00:01:00', confidence: 'high' },
    { material: 2, page: 1, start: '1:00', end: '2:00', confidence: 'bogus' },
    { material: 9, page: 1, start: '0:00', end: '0:10', confidence: 'low' },
  ],
  markdown: '## 要点\n資料に沿った議事録',
});
const XLSX_EXTRACT = { kind: 'xlsx', sheets: [{ name: '売上', rows: [['地域', '値'], ['関東', 120]], truncated: false, charts: [] }] };

function materialSeed() {
  return [
    {
      pk: 'MIN#m1', sk: 'META', status: 'queued', ownerEmail: 'a@x.jp', title: '定例', heldAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
      transcript: { key: 'minutes/m1/transcript-v1.txt', version: 1 },
      summary: { key: 'minutes/m1/summary-v1.md', version: 1 },
    },
    { pk: 'MIN#m1', sk: 'MAT#001', id: 'm001', seq: 1, name: '提案書.pdf', kind: 'pdf', state: 'ready', outlineStatus: 'pending', key: 'minutes/m1/materials/m001.pdf' },
    { pk: 'MIN#m1', sk: 'MAT#002', id: 'm002', seq: 2, name: '売上.xlsx', kind: 'xlsx', state: 'ready', outlineStatus: 'none', key: 'minutes/m1/materials/m002.xlsx', extractKey: 'minutes/m1/materials/m002.extract.json' },
  ];
}

function materialDeps(ddb, { pdfOk }) {
  const calls = [];
  const t = makeDeps({
    ddb,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      const parts = (body.contents ?? []).flatMap((c) => c.parts ?? []);
      const pdf = parts.find((p) => p.inlineData?.mimeType === 'application/pdf');
      calls.push({ pdf: Boolean(pdf), prompt: parts.map((p) => p.text ?? '').join('') });
      if (pdf) return pdfOk ? reply(OUTLINE_JSON) : { status: 400, json: async () => ({ error: { message: 'bad' } }) };
      return reply(SUMMARY_JSON);
    },
  });
  t.puts.set('minutes/m1/transcript-v1.txt', Buffer.from('[00:00:10] 話者A: 提案です'));
  t.puts.set('minutes/m1/materials/m001.pdf', Buffer.from('%PDF-1.4 fake'));
  t.puts.set('minutes/m1/materials/m002.extract.json', Buffer.from(JSON.stringify(XLSX_EXTRACT)));
  return { t, calls };
}

test('資料つき: PDF（Gemini）と xlsx の目次 → 議事録と対応表が保存される', async () => {
  const ddb = fakeDdb(materialSeed());
  const { t, calls } = materialDeps(ddb, { pdfOk: true });
  const r = await runMinutes({ minuteId: 'm1', target: 'summary', withMaterials: true }, t.deps);
  assert.equal(r.ok, true);

  // 目次化は PDF の 1 回だけ（xlsx はモデルを使わない）。議事録は 1 回
  assert.equal(calls.filter((c) => c.pdf).length, 1);
  assert.equal(t.fetchCalls, 2);
  assert.match(calls.find((c) => !c.pdf).prompt, /売上/); // xlsx の目次が差し込まれている
  assert.match(calls.find((c) => !c.pdf).prompt, /関西だけ伸びている/); // PDF の図の説明が差し込まれている

  assert.equal(ddb.m.get('MIN#m1|MAT#001').outlineStatus, 'done');
  assert.ok(t.puts.has('minutes/m1/materials/m001.outline.json'));

  const meta = ddb.m.get('MIN#m1|META');
  assert.equal(meta.status, 'done');
  assert.equal(meta.summary.version, 2);
  assert.equal(meta.summary.withMaterials, true);
  assert.deepEqual(meta.summary.materialIds, ['m001', 'm002']);
  assert.equal(meta.summary.previousKey, 'minutes/m1/summary-v1.md');
  assert.equal(meta.summary.previousWithMaterials, false);
  assert.match(t.puts.get('minutes/m1/summary-v2.md').toString(), /資料に沿った議事録/);
  const mapping = JSON.parse(t.puts.get(meta.summary.mappingKey).toString());
  // 存在しない資料番号は捨て、時刻と confidence は整う
  assert.deepEqual(mapping.map((m) => [m.material, m.start, m.confidence]), [[1, '00:00:10', 'high'], [2, '00:01:00', 'medium']]);
  assert.equal(t.usage.length, 1);
  assert.equal(t.usage[0].kind, 'summarize');
  assert.equal(t.usage[0].retry, true);
});

test('資料つき: PDF の目次化が失敗しても議事録は作られる（その資料は名前だけ）', async () => {
  const ddb = fakeDdb(materialSeed());
  const { t, calls } = materialDeps(ddb, { pdfOk: false });
  const r = await runMinutes({ minuteId: 'm1', target: 'summary', withMaterials: true }, t.deps);
  assert.equal(r.ok, true);
  assert.equal(ddb.m.get('MIN#m1|MAT#001').outlineStatus, 'failed');
  assert.equal(ddb.m.get('MIN#m1|META').status, 'done');
  assert.equal(ddb.m.get('MIN#m1|META').summary.withMaterials, true);
  const prompt = calls.filter((c) => !c.pdf).at(-1).prompt;
  assert.match(prompt, /提案書\.pdf/);
  assert.match(prompt, /目次なし/);
});

test('資料つきでない議事録の作り直しは資料の印を外し、前の版の印を残す', async () => {
  const s = materialSeed();
  s[0].summary = { key: 'minutes/m1/summary-v2.md', version: 2, withMaterials: true, materialIds: ['m001'], mappingKey: 'minutes/m1/summary-mapping-v2.json' };
  const ddb = fakeDdb(s);
  const { t } = materialDeps(ddb, { pdfOk: true });
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
      if (fd) {
        log.push(`generate:${fd.fileData.fileUri}:${Boolean(parts.find((p) => p.inlineData))}`);
        return reply(OUTLINE_JSON);
      }
      log.push('summary');
      return reply(SUMMARY_JSON);
    },
  });
  t.puts.set('minutes/m1/transcript-v1.txt', Buffer.from('[00:00:10] 話者A: 提案です'));
  t.puts.set('minutes/m1/materials/m001.pdf', Buffer.alloc(14 * 1024 * 1024 + 1));
  t.puts.set('minutes/m1/materials/m002.extract.json', Buffer.from(JSON.stringify(XLSX_EXTRACT)));
  return { t, log };
}

test('資料つき: 14MB 以上の PDF は Files API に預けて fileData で読み、終わったら削除する', async () => {
  const ddb = fakeDdb(materialSeed());
  const { t, log } = bigPdfDeps(ddb, ['ACTIVE']);
  const r = await runMinutes({ minuteId: 'm1', target: 'summary', withMaterials: true }, t.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(log.slice(0, 4), ['start', 'body', 'generate:https://g/files/abc:false', 'delete']);
  assert.equal(ddb.m.get('MIN#m1|MAT#001').outlineStatus, 'done');
});

test('資料つき: Files API が PROCESSING のあいだは ACTIVE になるまで待ってから読む', async () => {
  const ddb = fakeDdb(materialSeed());
  const { t, log } = bigPdfDeps(ddb, ['PROCESSING', 'ACTIVE']);
  const r = await runMinutes({ minuteId: 'm1', target: 'summary', withMaterials: true }, t.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(log.slice(0, 5), ['start', 'body', 'get', 'generate:https://g/files/abc:false', 'delete']);
});
