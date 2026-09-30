import test from 'node:test';
import assert from 'node:assert/strict';
import { runScan } from '../src/scan.js';
import { fakeDdb, geminiReply, makeDeps } from './fakes.js';

const seed = () => [{ pk: 'CARD#c1', sk: 'META', status: 'processing', imageFrontKey: 'cards/c1/front.jpg', createdBy: 'u1' }];
const GOOD = '{"company":"株式会社テスト","name":"山田 太郎","emails":["TARO@Example.JP"]}';

test('壊れた応答は 1 回やり直して成功する', async () => {
  const ddb = fakeDdb(seed());
  const t = makeDeps({ ddb, replies: [geminiReply('読み取れません'), geminiReply(GOOD)] });
  const r = await runScan({ cardId: 'c1' }, t.deps);
  assert.equal(r.ok, true);
  const card = ddb.m.get('CARD#c1|META');
  assert.equal(card.status, 'review');
  assert.deepEqual(card.emails, ['taro@example.jp']);
  assert.equal(card.extraction.attempts, 2);
  assert.equal(card.scanCount, 1);
  assert.match(card.gsi1sk, /#c1$/);
  assert.equal(t.usage.length, 1);
  assert.equal(t.usage[0].userId, 'u1');
});

test('MAX_TOKENS は truncated として失敗、読めた項目は保存する', async () => {
  const ddb = fakeDdb(seed());
  const t = makeDeps({ ddb, replies: [geminiReply('{"company":"株式会社テスト","name":"山', 'MAX_TOKENS')] });
  const r = await runScan({ cardId: 'c1' }, t.deps);
  assert.equal(r.ok, false);
  const card = ddb.m.get('CARD#c1|META');
  assert.equal(card.status, 'failed');
  assert.equal(card.failure.kind, 'truncated');
  assert.equal(card.failure.retryable, true);
  assert.equal(card.company, '株式会社テスト');
  assert.ok(ddb.m.get('ORG|SETTING#failedscan#c1'));
});

test('混雑(429)は 2 秒、5 秒待って試し直し、それでも駄目なら provider', async () => {
  const ddb = fakeDdb(seed());
  const busy = { status: 429, json: async () => ({}) };
  const t = makeDeps({ ddb, replies: [busy] });
  const r = await runScan({ cardId: 'c1' }, t.deps);
  assert.equal(r.ok, false);
  assert.deepEqual(t.sleeps, [2000, 5000]);
  assert.equal(t.calls, 3);
  assert.equal(ddb.m.get('CARD#c1|META').failure.kind, 'provider');
});

test('試し読みは名刺を書かず結果を返す', async () => {
  const ddb = fakeDdb();
  const t = makeDeps({ ddb, replies: [geminiReply(GOOD)] });
  const r = await runScan({ test: true, frontKey: 'x', promptText: 'p', actor: 'dev' }, t.deps);
  assert.equal(r.ok, true);
  assert.equal(r.card.company, '株式会社テスト');
  assert.equal(ddb.m.size, 0);
});
