// 質問（docs/core-api.md §15）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatGenerateRequest, buildResponsesRequest, buildQaContext, trimTurns, renderPrompt, DEFAULT_PROMPTS, PLACEHOLDERS,
  DEFAULT_MODELS, DEFAULT_SELECTION,
} from '../src/index.js';

test('buildChatGenerateRequest: role を user / model に写す', () => {
  const r = buildChatGenerateRequest({
    model: 'gemini-3.6-flash', apiKey: 'K', systemText: 'SYS', thinkingLevel: 'minimal', maxOutputTokens: 100,
    turns: [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }, { role: 'user', text: 'q2' }],
  });
  const b = JSON.parse(r.body);
  assert.deepEqual(b.systemInstruction, { parts: [{ text: 'SYS' }] });
  assert.deepEqual(b.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(b.contents[1].parts[0].text, 'a1');
  assert.equal(b.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
  assert.equal(r.headers['x-goog-api-key'], 'K');
  assert.ok(r.url.endsWith('/models/gemini-3.6-flash:generateContent'));
});

test('buildResponsesRequest: turns', () => {
  const r = buildResponsesRequest({
    model: 'gpt-6-luna', apiKey: 'K', instructions: 'SYS',
    turns: [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }, { role: 'user', text: 'q2' }],
  });
  const b = JSON.parse(r.body);
  assert.deepEqual(b.input.map((x) => [x.role, x.content[0].type]), [['user', 'input_text'], ['assistant', 'output_text'], ['user', 'input_text']]);
  const p = JSON.parse(buildResponsesRequest({ model: 'm', apiKey: 'K', parts: [{ type: 'input_text', text: 'P' }], turns: [{ role: 'user', text: 'q' }] }).body);
  assert.deepEqual(p.input[0].content.map((c) => c.text), ['P', 'q']);
});

test('trimTurns', () => {
  const t = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: String(i) }));
  const o = trimTurns(t);
  assert.equal(o.length, 20);
  assert.equal(o[0].role, 'user');
  assert.equal(o.at(-1).text, '29');
  // 末尾 5 件は assistant 始まりなので 1 件落ちる
  assert.equal(trimTurns(t, 5)[0].role, 'user');
  assert.deepEqual(trimTurns(undefined), []);
});

test('buildQaContext とプロンプト', () => {
  const c = buildQaContext({
    transcript: '[00:00:01] a: こんにちは',
    materials: [{ seq: 1, name: 'x.pdf', kind: 'pdf', outline: { sections: [{ page: 1, title: '料金', summary: 's', figures: [], keywords: [] }] } }],
    minute: { title: '定例', heldAt: '2026-10-01T01:30:00Z', counterparts: [{ company: 'A社', name: '田中' }], attendees: [{ name: '佐藤' }], memo: 'm' },
  });
  assert.equal(c.DATE, '2026-10-01 10:30');
  assert.equal(c.COUNTERPARTS, 'A社 田中');
  assert.equal(c.ATTENDEES, '佐藤');
  assert.ok(c.MATERIALS.includes('資料 1: x.pdf'));
  assert.equal(buildQaContext({ transcript: 't' }).MATERIALS, '（資料なし）');
  const text = renderPrompt(DEFAULT_PROMPTS.qa, c);
  assert.ok(text.includes('タイトル: 定例') && text.includes('こんにちは') && text.includes('資料 1: x.pdf'));
  assert.ok(!/\{\{/.test(text));
  assert.deepEqual([...PLACEHOLDERS.qa], ['TITLE', 'DATE', 'COUNTERPARTS', 'ATTENDEES', 'MEMO', 'MATERIALS', 'TRANSCRIPT']);
});

test('モデルの用途 qa', () => {
  assert.equal(DEFAULT_SELECTION.qa, DEFAULT_SELECTION.summarize);
  const qa = DEFAULT_MODELS.filter((m) => m.uses.includes('qa'));
  assert.ok(qa.some((m) => m.provider === 'gemini') && qa.some((m) => m.provider === 'openai'));
  assert.ok(!DEFAULT_MODELS.filter((m) => m.uses.length === 1 && m.uses[0] === 'transcribe').some((m) => m.uses.includes('qa')));
  assert.ok(DEFAULT_MODELS.find((m) => m.id === DEFAULT_SELECTION.qa).uses.includes('qa'));
});
