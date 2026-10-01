import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText, phoneDigits, searchKeys, parseQuery, matchCard,
  buildCsv, parseCsv, detectAndDecode, historyToCsvRows, HISTORY_CSV_COLUMNS,
  planUserImport, parseUserRows, CARD_CSV_COLUMNS, cardToCsvRow,
  estimateCost, priceAt, DEFAULT_MODELS, DEFAULT_SELECTION, tierOf,
  offsetTimestamps, joinSegments,
  capabilitiesFor, levelFor, canSeeCard, canDeleteCard, DEFAULT_POSITIONS,
  renderPrompt, DEFAULT_PROMPTS,
  buildGenerateRequest, parseGenerateResponse, buildFilesUploadRequest, buildFilesUploadBodyHeaders,
  ulid, isValidEmail, monthKey,
} from '../src/index.js';

test('normalizeText / phoneDigits', () => {
  assert.equal(normalizeText('  ＡＢＣ　アシスト   Ｔａｒｏ '), 'abc あしすと taro');
  assert.equal(phoneDigits('+81 3-1234-5678'), '0312345678');
  assert.equal(phoneDigits('０３（１２３４）５６７８'), '0312345678');
});

test('searchKeys / matchCard', () => {
  const keys = searchKeys({
    company: '株式会社アシスト', name: '山田 太郎', nameReading: 'やまだ たろう', department: '営業本部 第二営業部',
    phones: ['03-1234-5678'], mobiles: ['+81 90-1111-2222'], emails: ['Taro@Example.co.jp'], note: '資格: 一級建築士', title: '営業部長',
  });
  const m = (p) => matchCard(keys, parseQuery(p));
  assert.ok(m({ company: 'ｱｼｽﾄ' }));
  assert.ok(m({ company: 'あしすと 株式' }));
  assert.ok(m({ name: 'やまだ' }));
  assert.ok(m({ name: '山田太郎' }));
  assert.ok(m({ phone: '09011112222' }));
  assert.ok(m({ phone: '031234' }));
  assert.ok(m({ email: 'TARO@example' }));
  assert.ok(m({ note: '建築士' }));
  assert.ok(m({ department: '第二' }));
  assert.ok(m({ note: '部長' }));
  assert.equal(searchKeys({ title: '営業部長' }).titleN, '営業部長');
  assert.equal(m({ company: 'アシスト', name: '佐藤' }), false);
  assert.equal(m({ phone: '0299' }), false);
  assert.ok(m({}));
});

test('buildCsv: BOM、CRLF、引用符、数式対策、配列', () => {
  const csv = buildCsv(
    [{ a: '=1+1', b: ['+81 3-1234-5678', '090'], c: 'x,"y"', d: 5, e: '-5' }],
    [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', type: 'phone' }, { key: 'c', label: 'C' }, { key: 'd', label: 'D' }, { key: 'e', label: 'E' }],
  );
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'A,B,C,D,E');
  assert.equal(lines[1], `'=1+1,"=""+81 3-1234-5678;090""","x,""y""",5,'-5`);
});

test('parseCsv: カンマ、タブ、引用符内の改行', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x\ny","z,""q"""\r\n'), [['a', 'b'], ['x\ny', 'z,"q"']]);
  assert.deepEqual(parseCsv('﻿a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
});

test('detectAndDecode: UTF-8 BOM と Shift_JIS', () => {
  const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('部署')]);
  assert.equal(detectAndDecode(utf8.buffer), '部署');
  // 「部署」の Shift_JIS
  const sjis = new Uint8Array([0x95, 0x94, 0x8f, 0x90]);
  assert.equal(detectAndDecode(sjis.buffer), '部署');
});

test('historyToCsvRows: 変更 2 件は 2 行', () => {
  const rows = historyToCsvRows({
    type: 'edit', at: '2026-10-02T14:03:00Z', source: 'search', actor: { name: '佐藤', deptName: '営業部' },
    card: { id: 'c1', company: 'A', name: 'B' },
    changes: [{ field: 'phones', before: ['1'], after: ['2'] }, { field: 'department', before: 'x', after: 'y' }],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fieldLabel, '電話番号');
  assert.ok(buildCsv(rows, HISTORY_CSV_COLUMNS).includes('検索画面'));
});

const positions = DEFAULT_POSITIONS;
test('planUserImport: 全エラーの種類と統合', () => {
  const rows = [
    ['部署', 'アドレス', '役職', '氏名'],
    ['営業部;企画部', 'A@Example.com', 'ＳｕｂＭＧ', '甲'],
    ['営業部', 'a@example.com', 'submg', ''],
    ['営業 部', 'new@example.com', 'MG'],
    ['営業部', 'bad-address', 'MG'],
    ['営業部', 'x@other.com', 'MG'],
    ['営業部', 'y@example.com', '謎の役職'],
    ['', 'z@example.com', 'MG'],
    ['営業部', 'c@example.com', 'MG'],
    ['営業部', 'c@example.com', 'EX'],
    ['営業部', 'dev@example.com', '開発者'],
    ['営業部', 'same@example.com', 'MG'],
  ];
  const plan = planUserImport({
    rows,
    existingUsers: [
      { email: 'same@example.com', position: 'MG', departments: [{ name: '営業部' }], displayName: '' },
    ],
    departments: [{ name: '営業部' }],
    positions,
    companyDomain: 'example.com',
    actorIsDev: false,
  });
  const a = plan.create.find((u) => u.email === 'a@example.com');
  assert.deepEqual(a.departments, ['営業部', '企画部']);
  assert.equal(a.position, 'SubMG');
  assert.equal(a.displayName, '甲');
  const messages = plan.errors.map((e) => e.message).join('|');
  for (const key of ['形式', 'ドメイン', '一覧にありません', '部署が空', '食い違', '開発者']) {
    assert.ok(messages.includes(key), key);
  }
  assert.equal(plan.errors.find((e) => e.message.includes('ドメイン')).row, 6);
  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.create.some((u) => u.email === 'c@example.com'), false);
  // 「営業 部」は新しい部署だが、既存の「営業部」に似ているので警告
  assert.deepEqual(plan.newDepartments, [
    { name: '企画部', count: 1 },
    { name: '営業 部', count: 1, similarTo: '営業部' },
  ]);
});

test('planUserImport: 既存ユーザーの変更は before / after', () => {
  const plan = planUserImport({
    rows: parseUserRows([['営業部;企画部', 'u@example.com', 'EX']]),
    existingUsers: [{ email: 'u@example.com', position: '社員A', departments: ['営業部'] }],
    departments: ['営業部', '企画部'],
    positions,
    companyDomain: 'example.com',
  });
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].before.position, '社員A');
  assert.deepEqual(plan.update[0].after.departments, ['営業部', '企画部']);
  const dev = planUserImport({ rows: [['営業部', 'd@example.com', '開発者']], departments: ['営業部'], positions, actorIsDev: true });
  assert.equal(dev.create.length, 1);
});

test('estimateCost: 3.5-flash-lite の 2,500 / 500 トークンは約 $0.0020', () => {
  const c = estimateCost({ model: 'gemini-3.5-flash-lite', inputTokens: 2500, outputTokens: 500 });
  assert.ok(Math.abs(c - 0.002) < 1e-9);
});

test('estimateCost: 音声、分単位の切り上げ、値上げ日', () => {
  const lite = DEFAULT_MODELS.find((m) => m.id === 'gemini-3.1-flash-lite');
  // 600 秒 × 32 トークン × $0.50 / 100 万
  assert.ok(Math.abs(estimateCost({ model: lite, audioSeconds: 600 }) - 0.0096) < 1e-9);
  assert.ok(Math.abs(estimateCost({ model: 'gpt-transcribe', audioSeconds: 61 }) - 0.009) < 1e-9);
  assert.equal(priceAt('gemini-3.6-flash', '2026-12-31').input, 0.75);
  assert.equal(priceAt('gemini-3.6-flash', '2027-01-01').input, 1.5);
  assert.equal(priceAt('gemini-3.8-flash', new Date('2027-02-01')).output, 7.5);
});

test('offsetTimestamps / joinSegments', () => {
  assert.equal(offsetTimestamps('[03:15] 話者A: こんにちは\n[04:00] 話者B: はい', 600), '[00:13:15] 話者A: こんにちは\n[00:14:00] 話者B: はい');
  assert.equal(offsetTimestamps('[01:02:03] x', 60), '[01:03:03] x');
  // 発言中の [10:00] は書き換えない
  assert.equal(offsetTimestamps('[00:05] 会議は [10:00] から', 0), '[00:00:05] 会議は [10:00] から');
  const joined = joinSegments([
    { startSec: 600, text: '[00:10] 話者A: 二つ目' },
    { startSec: 0, text: '[00:05] 話者A: 一つ目' },
    { startSec: 1200, text: '（会話なし）' },
  ]);
  assert.equal(joined, '[00:00:05] 話者A: 一つ目\n[00:10:10] 話者A: 二つ目');
});

test('capabilitiesFor / levelFor / canSeeCard / canDeleteCard', () => {
  assert.equal(Object.values(capabilitiesFor('dev')).every(Boolean), true);
  assert.deepEqual(Object.entries(capabilitiesFor('org_admin')).filter(([, v]) => !v).map(([k]) => k), ['dev']);
  const cf = capabilitiesFor('org_edit');
  assert.deepEqual([cf.admin, cf.dev, cf.viewHistory, cf.deleteAnyCard, cf.seeAllCards, cf.editCards, cf.assignOtherDepts, cf.register], [false, false, false, false, true, true, true, true]);
  const de = capabilitiesFor('dept_edit');
  assert.deepEqual([de.seeAllCards, de.assignOtherDepts, de.editCards, de.register], [false, false, true, true]);
  const dv = capabilitiesFor('dept_view');
  assert.deepEqual([dv.editCards, dv.register], [false, true]);
  assert.equal(levelFor('ｓｕｂmg', DEFAULT_POSITIONS), 'org_edit');
  assert.equal(levelFor('協力会社'), 'dept_view');
  const user = { id: 'u1', level: 'dept_edit', deptIds: ['d1'] };
  assert.equal(canSeeCard(user, { deptIds: ['d1', 'd2'] }), true);
  assert.equal(canSeeCard(user, { deptIds: ['d2'] }), false);
  assert.equal(canDeleteCard(user, { createdBy: { id: 'u1' } }), true);
  assert.equal(canDeleteCard(user, { createdBy: { id: 'u2' } }), false);
});

test('renderPrompt', () => {
  assert.equal(renderPrompt('a {{X}} b {{Y}}', { X: '$&' }), 'a $& b ');
  const out = renderPrompt('本文', { TRANSCRIPT: 'こんにちは' });
  assert.ok(out.endsWith('# 文字起こし\nこんにちは'));
  assert.ok(renderPrompt(DEFAULT_PROMPTS.summarize, { TRANSCRIPT: 'T', TITLE: 'たいとる' }).includes('タイトル: たいとる'));
});

test('buildGenerateRequest / parseGenerateResponse / Files API', () => {
  const req = buildGenerateRequest({ model: 'gemini-3.5-flash-lite', apiKey: 'K', prompt: 'P', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AA' } }], schema: { type: 'OBJECT' }, thinkingLevel: 'minimal', maxOutputTokens: 4000 });
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(req.headers['x-goog-api-key'], 'K');
  const body = JSON.parse(req.body);
  assert.equal(body.contents[0].parts.at(-1).text, 'P');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
  const plain = JSON.parse(buildGenerateRequest({ model: 'm', apiKey: 'K', prompt: 'P' }).body);
  assert.equal('responseMimeType' in plain.generationConfig, false);

  const r = parseGenerateResponse({
    candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
  });
  assert.deepEqual(r, { text: 'ab', finishReason: 'MAX_TOKENS', blocked: false, blockReason: null, usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 2 } });
  assert.equal(parseGenerateResponse({ promptFeedback: { blockReason: 'SAFETY' } }).blocked, true);

  const up = buildFilesUploadRequest({ apiKey: 'K', mimeType: 'audio/webm', displayName: 'a', sizeBytes: 100 });
  assert.equal(up.url, 'https://generativelanguage.googleapis.com/upload/v1beta/files');
  assert.equal(up.headers['X-Goog-Upload-Command'], 'start');
  assert.equal(JSON.parse(up.body).file.display_name, 'a');
  assert.equal(buildFilesUploadBodyHeaders({ sizeBytes: 100 })['X-Goog-Upload-Command'], 'upload, finalize');
});

test('ulid / isValidEmail / monthKey', () => {
  const a = ulid(1_000_000_000_000);
  const b = ulid(1_000_000_000_001);
  assert.equal(a.length, 26);
  assert.ok(a.slice(0, 10) < b.slice(0, 10));
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(isValidEmail('taro@example.co.jp'), true);
  assert.equal(isValidEmail('taro@example'), false);
  assert.equal(monthKey(new Date('2026-10-28T00:00:00Z')), '2026-10');
});

test('モデル一覧: 全モデルに tier / status / label があり、tier は tierOf と一致する', () => {
  for (const m of DEFAULT_MODELS) {
    assert.ok(m.label, m.id);
    assert.ok(['stable', 'preview'].includes(m.status), m.id);
    assert.ok(['lite', 'standard', 'high', 'top', null].includes(m.tier), m.id);
    assert.equal(m.tier, tierOf(m), m.id);
  }
  assert.equal(DEFAULT_MODELS.find((m) => m.id === 'gpt-6-astra').tier, 'top');
  assert.equal(DEFAULT_MODELS.find((m) => m.id === 'gemini-3.1-pro-preview').status, 'preview');
  const ids = DEFAULT_MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('tierOf: 出力単価の境界', () => {
  const t = (output) => tierOf({ pricing: { output } });
  assert.equal(t(2.5), 'lite');
  assert.equal(t(2.51), 'standard');
  assert.equal(t(10), 'standard');
  assert.equal(t(10.01), 'high');
  assert.equal(t(30), 'high');
  assert.equal(t(30.01), 'top');
  assert.equal(tierOf({ pricing: { perMinute: 0.006 } }), null);
  assert.equal(tierOf('gpt-6-astra'), 'top');
});

test('priceAt: longContext は tokens が閾値を超えたときだけ', () => {
  assert.equal(priceAt('gemini-3.1-pro-preview', '2026-10-01').input, 2);
  assert.equal(priceAt('gemini-3.1-pro-preview', '2026-10-01', { tokens: 200000 }).input, 2);
  const over = priceAt('gemini-3.1-pro-preview', '2026-10-01', { tokens: 200001 });
  assert.equal(over.input, 4);
  assert.equal(over.output, 18);
  assert.equal(over.threshold, undefined);
  assert.equal(priceAt('gpt-6-astra', null, { tokens: 272001 }).output, 75);
  assert.equal(priceAt('gpt-6-astra', null, { tokens: 272000 }).output, 50);
  const c = estimateCost({ model: 'gpt-6-astra', inputTokens: 300000, outputTokens: 1000 });
  assert.ok(Math.abs(c - (300000 * 20 + 1000 * 75) / 1e6) < 1e-9);
});

test('DEFAULT_SELECTION のモデルは一覧にあり、用途に合う', () => {
  for (const [use, id] of Object.entries(DEFAULT_SELECTION)) {
    const m = DEFAULT_MODELS.find((y) => y.id === id);
    assert.ok(m, id);
    assert.ok(m.uses.includes(use), id + ' は ' + use + ' に使える');
  }
});

test('CSV: 役職の列は部署名の次', () => {
  const labels = CARD_CSV_COLUMNS.map((c) => c.label);
  assert.equal(labels[labels.indexOf('部署名') + 1], '役職');
  assert.equal(cardToCsvRow({ title: '代表取締役' }).title, '代表取締役');
});
