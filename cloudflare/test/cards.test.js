import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffCards, failureFor, keyColumns, sanitizeCard } from '../worker/src/lib/cards.js';

test('検索用の列: 配列は空白でつなぐ', () => {
  const k = keyColumns({ companyN: 'あしすと', nameN: 'やまだたろう', phonesDigits: ['0312345678', '09012345678'], emailsN: ['a@x.jp'] });
  assert.equal(k.phones_digits, '0312345678 09012345678');
  assert.equal(k.emails_n, 'a@x.jp');
  assert.equal(k.note_n, '');
});

test('sanitizeCard: メールは小文字、空要素を捨て、長さを切る', () => {
  const c = sanitizeCard({ company: ' A社 ', emails: ['Taro@Example.JP', ' '], phones: ['03-1234-5678'], note: 'x'.repeat(3000) });
  assert.equal(c.company, 'A社');
  assert.deepEqual(c.emails, ['taro@example.jp']);
  assert.equal(c.note.length, 2000);
});

test('diffCards: 変わった項目だけ', () => {
  const a = { company: 'A', name: 'B', phones: ['1'], emails: [], mobiles: [], department: '', nameReading: '', note: '' };
  const changes = diffCards(a, { ...a, phones: ['2'], name: 'C' });
  assert.deepEqual(changes.map((c) => c.field), ['name', 'phones']);
  assert.deepEqual(diffCards(a, { ...a }), []);
});

test('失敗の種類と文言', () => {
  assert.equal(failureFor('blocked').retryable, false);
  assert.equal(failureFor('empty').retryable, true);
  assert.equal(failureFor('???').kind, 'provider');
});
