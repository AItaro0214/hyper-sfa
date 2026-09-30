import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildListQuery,
  encodeCursor,
  decodeCursor,
  escapeLike,
  jstDayStartIso,
  jstNextDayStartIso,
} from '../worker/src/minutes/sql.js';

const count = (sql, ch = '?') => sql.split(ch).length - 1;

test('relation=owner は作った人だけ', () => {
  const q = buildListQuery({ userId: 'u1', relation: 'owner' });
  assert.match(q.sql, /m\.owner_id = \?/);
  assert.doesNotMatch(q.sql, /minute_shares/);
  assert.deepEqual(q.params, ['u1', 51]);
});

test('relation=shared は共有された人だけ、all は両方', () => {
  const s = buildListQuery({ userId: 'u1', relation: 'shared' });
  assert.match(s.sql, /minute_shares/);
  assert.doesNotMatch(s.sql, /m\.owner_id = \?/);
  const a = buildListQuery({ userId: 'u1', relation: 'all' });
  assert.match(a.sql, /\(m\.owner_id = \? OR EXISTS/);
  assert.deepEqual(a.params.slice(0, 2), ['u1', 'u1']);
  // 不正な値は all（役職による特別扱いは無い）
  assert.equal(buildListQuery({ userId: 'u1', relation: 'x' }).sql, a.sql);
});

test('company と name と cardId は同じ相手の行に対する AND', () => {
  const q = buildListQuery({
    userId: 'u1',
    company: 'アシスト 株式',
    name: '山田',
    cardId: 'card1',
    normalize: (s) => s.toUpperCase(),
  });
  assert.equal(count(q.sql, 'FROM minute_counterparts'), 1);
  assert.equal(count(q.sql, 'c.company_n LIKE'), 2);
  assert.equal(count(q.sql, 'c.name_n LIKE'), 1);
  assert.match(q.sql, /c\.card_id = \?/);
  assert.ok(q.params.includes('%アシスト%'));
  assert.ok(q.params.includes('%株式%'));
  assert.ok(q.params.includes('%山田%'));
  assert.ok(q.params.includes('card1'));
  // プレースホルダの数と bind の数が合う
  assert.equal(count(q.sql), q.params.length);
});

test('LIKE の記号は文字として扱う', () => {
  assert.equal(escapeLike('a%b_c\\d'), 'a\\%b\\_c\\\\d');
  const q = buildListQuery({ userId: 'u', title: '100%' });
  assert.ok(q.params.includes('%100\\%%'));
});

test('cursor は held_at|id で、それより古いものだけ', () => {
  const row = { held_at: '2026-10-02T05:00:00.000Z', id: '01ABC' };
  const cur = encodeCursor(row);
  assert.equal(cur, '2026-10-02T05:00:00.000Z|01ABC');
  assert.deepEqual(decodeCursor(cur), { heldAt: row.held_at, id: '01ABC' });
  assert.equal(decodeCursor('壊れている'), null);
  assert.equal(decodeCursor(undefined), null);
  const q = buildListQuery({ userId: 'u', cursor: cur });
  assert.match(q.sql, /m\.held_at < \? OR \(m\.held_at = \? AND m\.id < \?\)/);
  assert.deepEqual(q.params.slice(-4), [row.held_at, row.held_at, '01ABC', 51]);
  assert.match(q.sql, /ORDER BY m\.held_at DESC, m\.id DESC LIMIT \?$/);
});

test('期間は日本時間の日付で、to は翌日 0 時（排他的）', () => {
  assert.equal(jstDayStartIso('2026-10-02'), '2026-10-01T15:00:00.000Z');
  assert.equal(jstNextDayStartIso('2026-10-02'), '2026-10-02T15:00:00.000Z');
  assert.equal(jstDayStartIso('bad'), null);
  const q = buildListQuery({ userId: 'u', from: '2026-10-01', to: '2026-10-02' });
  assert.match(q.sql, /m\.held_at >= \?/);
  assert.match(q.sql, /m\.held_at < \?/);
  assert.ok(q.params.includes('2026-09-30T15:00:00.000Z'));
  assert.ok(q.params.includes('2026-10-02T15:00:00.000Z'));
});

test('attendee と owner と limit', () => {
  const q = buildListQuery({ userId: 'u', attendee: 'a1', owner: 'o1', limit: 9999 });
  assert.match(q.sql, /minute_attendees/);
  assert.ok(q.params.includes('a1'));
  assert.ok(q.params.includes('o1'));
  assert.equal(q.limit, 100);
  assert.equal(q.params.at(-1), 101);
  assert.equal(buildListQuery({ userId: 'u' }).limit, 50);
  assert.equal(count(q.sql), q.params.length);
});
