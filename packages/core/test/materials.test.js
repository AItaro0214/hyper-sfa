// 資料（docs/core-api.md §13、§14）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIAL_LIMITS, materialKindOf, outlineFromExtract, formatMaterialsForPrompt, formatMaterialsFullText, normalizeMapping,
  OUTLINE_SCHEMA, MATERIAL_SUMMARY_SCHEMA, toGeminiSchema, PLACEHOLDERS, renderPrompt, DEFAULT_PROMPTS, buildGenerateRequest,
  buildResponsesRequest, parseResponsesResponse, buildOpenAIFileUploadRequest, buildOpenAIFileDeleteRequest, parseOpenAIFileResponse,
} from '../src/index.js';

test('materialKindOf', () => {
  assert.equal(materialKindOf('提案書_v3.PDF'), 'pdf');
  assert.equal(materialKindOf('a.pptx'), 'pptx');
  assert.equal(materialKindOf('売上.xlsx'), 'xlsx');
  assert.equal(materialKindOf('古い.ppt'), null);
  assert.equal(materialKindOf('noext'), null);
  assert.equal(MATERIAL_LIMITS.maxFiles, 5);
});

test('outlineFromExtract: pptx', () => {
  const o = outlineFromExtract({
    kind: 'pptx',
    slides: [
      { no: 1, title: '表紙', text: '株式会社アシスト 提案書 Wix', notes: '', charts: [] },
      {
        no: 2, title: '地域別売上', text: 'クラウドサービスの売上', notes: 'x'.repeat(700),
        charts: [{ type: 'barChart', title: '売上', categories: ['関東', '関西', '九州'], series: [{ name: '2025', values: [120, 95, 40] }] }],
      },
      { no: 3, title: '', text: '', notes: '', charts: [] },
    ],
  }, { name: 'a.pptx' });
  assert.equal(o.sections.length, 3);
  assert.equal(o.sections[0].page, 1);
  assert.ok(o.sections[0].keywords.includes('株式会社アシスト'));
  assert.ok(o.sections[0].keywords.includes('Wix'));
  assert.equal(o.sections[1].figures[0], '棒グラフ「売上」: 系列「2025」 関東 120 / 関西 95 / 九州 40');
  assert.ok(o.sections[1].keywords.includes('クラウドサービス'));
  assert.equal(o.sections[1].summary.length, 600);
  assert.equal(o.sections[2].title, 'スライド 3');
});

test('outlineFromExtract: 系列が複数、キーワードは 10 個まで', () => {
  const o = outlineFromExtract({
    kind: 'pptx',
    slides: [{ no: 1, title: 't', text: Array.from({ length: 20 }, (_, i) => `Word${i}`).join(' '), notes: '', charts: [
      { type: 'line', categories: ['1月', '2月'], series: [{ name: 'A', values: [1, 2] }, { name: 'B', values: [3, 4] }] },
    ] }],
  });
  assert.equal(o.sections[0].keywords.length, 10);
  assert.equal(o.sections[0].figures[0], '折れ線グラフ: 系列「A」 1月 1 / 2月 2; 系列「B」 1月 3 / 2月 4');
});

test('outlineFromExtract: xlsx', () => {
  const rows = Array.from({ length: 40 }, (_, i) => [`行${i}`, i, null]);
  const o = outlineFromExtract({ kind: 'xlsx', sheets: [{ name: '売上', rows, truncated: false, charts: [] }, { name: '', rows: [], charts: [] }] });
  assert.equal(o.sections[0].page, 1);
  assert.equal(o.sections[0].title, '売上');
  const lines = o.sections[0].summary.split('\n');
  assert.equal(lines.length, 30);
  assert.equal(lines[1], '行1\t1\t');
  assert.equal(o.sections[1].title, 'シート 2');
  assert.deepEqual(outlineFromExtract({ kind: 'pdf' }).sections, []);
});

test('formatMaterialsForPrompt', () => {
  const outline = outlineFromExtract({ kind: 'pptx', slides: [{ no: 7, title: '地域別売上', text: '本文', notes: '', charts: [
    { type: 'bar', categories: ['関東'], series: [{ name: '2025', values: [120] }] }] }] });
  const s = formatMaterialsForPrompt([
    { seq: 1, name: '提案書.pptx', kind: 'pptx', outline },
    { seq: 2, name: 'x.pdf', kind: 'pdf', outline: { sections: [{ page: 3, title: '', summary: 's', figures: [], keywords: [] }] } },
  ]);
  assert.match(s, /^資料 1: 提案書\.pptx\n {2}スライド 7「地域別売上」\n {4}本文\n {4}図: 棒グラフ: 系列「2025」 関東 120/);
  assert.match(s, /\n\n資料 2: x\.pdf\n {2}ページ 3\n/);
  const big = formatMaterialsForPrompt([{ seq: 1, name: 'b.pdf', kind: 'pdf', outline: { sections: [{ page: 1, title: 't', summary: 'あ'.repeat(40000), figures: [], keywords: [] }] } }]);
  assert.ok(big.length < 30100);
  assert.match(big, /省略/);
});

test('normalizeMapping', () => {
  const r = normalizeMapping([
    { material: 1, page: '7', start: '12:10', end: '18:40', confidence: 'HIGH' },
    { material: 1, page: 8, start: '00:30:00', end: '00:20:00' },
    { material: 9, page: 1, start: '00:00:00', end: '00:01:00' },
    { material: 1, page: 2, start: 'いつか', end: '00:01:00' },
    { material: 1, page: 3, start: '1:02:03', end: '1:02:04', confidence: 'maybe' },
  ], [{ seq: 1 }]);
  assert.deepEqual(r, [
    { material: 1, page: 7, start: '00:12:10', end: '00:18:40', confidence: 'high' },
    { material: 1, page: 8, start: '00:20:00', end: '00:30:00', confidence: 'medium' },
    { material: 1, page: 3, start: '01:02:03', end: '01:02:04', confidence: 'medium' },
  ]);
  assert.deepEqual(normalizeMapping(null, []), []);
});

test('プロンプトと toGeminiSchema', () => {
  assert.deepEqual(PLACEHOLDERS.outline, ['NAME', 'KIND']);
  assert.ok(PLACEHOLDERS.summarize_materials.includes('MATERIALS'));
  assert.match(renderPrompt(DEFAULT_PROMPTS.outline, { NAME: 'a.pdf', KIND: 'pdf' }), /a\.pdf/);
  assert.match(renderPrompt('資料: {{MATERIALS}}', { MATERIALS: 'M', TRANSCRIPT: 'T' }), /# 文字起こし\nT$/);
  const full = renderPrompt(DEFAULT_PROMPTS.summarize_materials, { MATERIALS: 'MMM', TRANSCRIPT: 'TTT' });
  assert.ok(full.includes('MMM') && full.endsWith('TTT') && !full.includes('{{'));
  const g = toGeminiSchema(OUTLINE_SCHEMA);
  assert.equal(g.type, 'OBJECT');
  assert.equal(g.properties.sections.items.properties.page.type, 'INTEGER');
  assert.equal(g.properties.sections.items.properties.figures.items.type, 'STRING');
  assert.equal(OUTLINE_SCHEMA.type, 'object'); // 元は変えない
  assert.equal(toGeminiSchema(MATERIAL_SUMMARY_SCHEMA).properties.mapping.items.properties.confidence.enum.length, 3);
  const req = buildGenerateRequest({ model: 'm', apiKey: 'k', prompt: 'p', schema: OUTLINE_SCHEMA });
  assert.equal(JSON.parse(req.body).generationConfig.responseSchema.type, 'OBJECT');
});

test('buildResponsesRequest', () => {
  const r = buildResponsesRequest({
    model: 'gpt-x', apiKey: 'k', instructions: '指示',
    parts: [{ type: 'input_file', fileId: 'file-1' }, { type: 'input_text', text: 'これ' }],
    jsonSchema: OUTLINE_SCHEMA, schemaName: 'outline', maxOutputTokens: 100, reasoningEffort: 'low',
  });
  assert.equal(r.url, 'https://api.openai.com/v1/responses');
  assert.equal(r.headers.Authorization, 'Bearer k');
  const b = JSON.parse(r.body);
  assert.equal(b.instructions, '指示');
  assert.deepEqual(b.input, [{ role: 'user', content: [{ type: 'input_file', file_id: 'file-1' }, { type: 'input_text', text: 'これ' }] }]);
  assert.deepEqual(b.text.format, { type: 'json_schema', name: 'outline', schema: OUTLINE_SCHEMA, strict: false });
  assert.equal(b.max_output_tokens, 100);
  assert.deepEqual(b.reasoning, { effort: 'low' });
  const plain = JSON.parse(buildResponsesRequest({ model: 'm', apiKey: 'k', parts: [] }).body);
  assert.equal(plain.text, undefined);
  assert.equal('reasoning' in plain, false);
  const nul = JSON.parse(buildResponsesRequest({ model: 'm', apiKey: 'k', parts: [], reasoningEffort: null }).body);
  assert.equal('reasoning' in nul, false);
});

test('buildOpenAIFileUploadRequest', () => {
  const r = buildOpenAIFileUploadRequest({ apiKey: 'k', filename: '提案"書\r\n.pdf', contentType: 'application/pdf', boundary: 'BB' });
  const dec = new TextDecoder();
  assert.ok(r.prefix instanceof Uint8Array);
  assert.equal(
    dec.decode(r.prefix),
    '--BB\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n' +
      '--BB\r\nContent-Disposition: form-data; name="file"; filename="提案書.pdf"\r\nContent-Type: application/pdf\r\n\r\n',
  );
  assert.equal(dec.decode(r.suffix), '\r\n--BB--\r\n');
  assert.equal(r.headers['Content-Type'], 'multipart/form-data; boundary=BB');
  assert.equal(r.url, 'https://api.openai.com/v1/files');
  assert.ok(buildOpenAIFileUploadRequest({ apiKey: 'k', filename: 'a.pdf' }).boundary.length > 10);
  assert.deepEqual(parseOpenAIFileResponse({ id: 'file-1', bytes: 5 }), { id: 'file-1', bytes: 5 });
  const d = buildOpenAIFileDeleteRequest({ apiKey: 'k', fileId: 'file-1' });
  assert.equal(d.method, 'DELETE');
  assert.equal(d.url, 'https://api.openai.com/v1/files/file-1');
});

test('parseResponsesResponse', () => {
  const ok = parseResponsesResponse({
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: '{"a":' }, { type: 'output_text', text: '1}' }] },
    ],
    usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } },
  });
  assert.equal(ok.text, '{"a":1}');
  assert.equal(ok.finishReason, 'completed');
  assert.equal(ok.incomplete, false);
  assert.deepEqual(ok.usage, { inputTokens: 10, outputTokens: 5, thoughtTokens: 2 });
  const cut = parseResponsesResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a' }] }] });
  assert.equal(cut.finishReason, 'max_output_tokens');
  assert.equal(cut.incomplete, true);
  assert.equal(parseResponsesResponse({}).text, '');
});

test('formatMaterialsFullText: pptx は切らず、グラフの元データも入る', () => {
  const long = 'あ'.repeat(1500);
  const s = formatMaterialsFullText([{ seq: 1, name: '提案.pptx', kind: 'pptx', extract: { kind: 'pptx', slides: [
    { no: 7, title: '地域別売上', text: long, notes: '口頭補足', charts: [{ type: 'bar', categories: ['関東'], series: [{ name: '2025', values: [120] }] }] },
  ] } }]);
  assert.ok(s.includes(long));
  assert.match(s, /^資料 1: 提案\.pptx\nスライド 7「地域別売上」\n/);
  assert.ok(s.includes('ノート: 口頭補足') && s.includes('図: 棒グラフ: 系列「2025」 関東 120'));
});

test('formatMaterialsFullText: xlsx は全行（31 行目以降も）', () => {
  const rows = Array.from({ length: 100 }, (_, i) => [`行${i + 1}`, i * 10]);
  const s = formatMaterialsFullText([{ seq: 2, name: '表.xlsx', kind: 'xlsx', extract: { kind: 'xlsx', sheets: [{ name: '売上', rows, charts: [] }] } }]);
  assert.ok(s.includes('シート 1「売上」') && s.includes('行31\t300') && s.includes('行100\t990'));
});

test('formatMaterialsFullText: PDF は添付、上限は資料ごとに切る', () => {
  const pdf = { seq: 1, name: 'a.pdf', kind: 'pdf', extract: null };
  assert.match(formatMaterialsFullText([pdf]), /添付の PDF/);
  assert.match(formatMaterialsFullText([]), /文字で渡す資料はありません/);
  assert.doesNotMatch(formatMaterialsFullText([pdf], { pdfAttached: false }), /添付の PDF を見て/);
  const sheet = (n) => ({ kind: 'xlsx', sheets: [{ name: 's', rows: [['x'.repeat(n)]], charts: [] }] });
  const s = formatMaterialsFullText([
    pdf,
    { seq: 2, name: 'small.xlsx', kind: 'xlsx', extract: sheet(100) },
    { seq: 3, name: 'big1.xlsx', kind: 'xlsx', extract: sheet(5000) },
    { seq: 4, name: 'big2.xlsx', kind: 'xlsx', extract: sheet(5000) },
  ], { maxChars: 1000 });
  assert.ok(s.includes('x'.repeat(100)));
  assert.equal((s.match(/省略/g) ?? []).length, 2);
  assert.ok(!s.includes('x'.repeat(1000)));
});
