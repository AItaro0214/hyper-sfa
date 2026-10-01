import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCardSearch, clampLimit, escapeLike } from '../worker/src/lib/search.js';

test('条件が無ければ、確認待ちと確認済みだけ・削除済みを除く', () => {
  const q = buildCardSearch({});
  assert.match(q.listSql, /deleted_at IS NULL AND status IN \('review', 'confirmed'\)/);
  assert.match(q.listSql, /ORDER BY id DESC LIMIT \?$/);
  assert.deepEqual(q.listParams, [51]);
  assert.deepEqual(q.countParams, []);
});

test('語は LIKE で AND につなぐ（1 つの欄の複数語も AND）', () => {
  const q = buildCardSearch({ terms: { company: ['アシスト', 'かぶ'], email: ['a@x.jp'] } });
  assert.equal(q.countSql.split('company_n LIKE ?').length - 1, 2);
  assert.ok(q.countSql.includes(' AND emails_n LIKE ?'));
  assert.ok(q.countSql.includes("ESCAPE '\\'"));
  assert.deepEqual(q.countParams, ['%アシスト%', '%かぶ%', '%a@x.jp%']);
});

test('氏名は読みにも当てる', () => {
  const q = buildCardSearch({ terms: { name: ['たろう'] } });
  assert.ok(q.countSql.includes('(name_n LIKE ?'));
  assert.ok(q.countSql.includes(' OR reading_n LIKE ?'));
  assert.deepEqual(q.countParams, ['%たろう%', '%たろう%']);
});

test('電話番号は数字の列に当てる', () => {
  const q = buildCardSearch({ terms: { phone: ['0312345678'] } });
  assert.ok(q.countSql.includes('phones_digits LIKE ?'));
});

test('LIKE の特殊文字は文字どおりに探す', () => {
  assert.equal(escapeLike('100%_\\'), '100\\%\\_\\\\');
  const q = buildCardSearch({ terms: { note: ['50%'] } });
  // 備考の語は note_n と title_n の両方に当てる
  assert.deepEqual(q.countParams, ['%50\\%%', '%50\\%%']);
  assert.ok(q.countSql.includes('(note_n LIKE ?') && q.countSql.includes(' OR title_n LIKE ?'));
});

test('登録者、期間、カーソル、件数', () => {
  const q = buildCardSearch({ ownerId: 'U1', fromIso: 'A', toIso: 'B' }, { cursor: 'C1', limit: 10 });
  assert.ok(q.listSql.includes('created_by = ? AND created_at >= ? AND created_at < ? AND id < ?'));
  assert.deepEqual(q.listParams, ['U1', 'A', 'B', 'C1', 11]);
  assert.deepEqual(q.countParams, ['U1', 'A', 'B']); // 件数にカーソルは効かせない
});

test('失敗 / 読み取り中は登録した本人だけ', () => {
  const q = buildCardSearch({ status: 'failed', viewerId: 'U9' });
  assert.ok(q.countSql.includes('status = ? AND created_by = ?'));
  assert.deepEqual(q.countParams, ['failed', 'U9']);
  assert.deepEqual(buildCardSearch({ status: 'review', viewerId: 'U9' }).countParams, ['review']);
});

test('JOIN 用の別名と SELECT を指定できる', () => {
  const q = buildCardSearch({ terms: { company: ['a'] } }, { prefix: 'c.', from: 'cards c', select: 'SELECT c.*' });
  assert.ok(q.listSql.startsWith('SELECT c.* FROM cards c WHERE c.deleted_at IS NULL'));
  assert.ok(q.listSql.includes('c.company_n LIKE ?'));
  assert.ok(q.listSql.includes('ORDER BY c.id DESC'));
});

test('limit の丸め', () => {
  assert.equal(clampLimit(undefined), 50);
  assert.equal(clampLimit('500'), 200);
  assert.equal(clampLimit('0'), 50);
  assert.equal(clampLimit('20'), 20);
});
