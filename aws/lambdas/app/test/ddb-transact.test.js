// 同時のトランザクションで拒否されたときの扱い（shared/ddb.js）。SDK の send を差し替えて確かめる
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ddb, isConditionFailed, isTransactionConflict } from '@hyper-sfa/aws-shared';

process.env.TABLE_NAME ??= 'test-table';

const canceled = (...codes) => Object.assign(new Error('canceled'), {
  name: 'TransactionCanceledException',
  CancellationReasons: codes.map((Code) => ({ Code })),
});
const op = { put: { pk: 'A', sk: 'B' } };

test('TransactionConflict だけならやり直して通す', async () => {
  let calls = 0;
  const m = mock.method(DynamoDBDocumentClient.prototype, 'send', async () => {
    calls++;
    if (calls < 3) throw canceled('None', 'TransactionConflict');
    return {};
  });
  try {
    await ddb.transact([op]);
    assert.equal(calls, 3);
  } finally {
    m.mock.restore();
  }
});

test('条件の不一致が混じっていればやり直さず、409 の扱いになる', async () => {
  let calls = 0;
  const m = mock.method(DynamoDBDocumentClient.prototype, 'send', async () => {
    calls++;
    throw canceled('ConditionalCheckFailed', 'TransactionConflict');
  });
  try {
    await assert.rejects(ddb.transact([op]), (e) => isConditionFailed(e) && !isTransactionConflict(e));
    assert.equal(calls, 1);
  } finally {
    m.mock.restore();
  }
});

test('衝突が続けば数回で諦め、409 の扱いになる（500 にしない）', async () => {
  let calls = 0;
  const m = mock.method(DynamoDBDocumentClient.prototype, 'send', async () => {
    calls++;
    throw canceled('TransactionConflict');
  });
  try {
    await assert.rejects(ddb.transact([op]), (e) => isConditionFailed(e));
    assert.equal(calls, 4); // 初回 + 3 回
  } finally {
    m.mock.restore();
  }
});
