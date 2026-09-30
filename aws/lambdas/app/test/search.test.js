// 検索用の一覧の差分取り込みと、見える範囲の絞り込み。ddb は差し替える（AWS には触れない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor, searchKeys } from '@hyper-sfa/core';
import { shardOf } from '@hyper-sfa/aws-shared/keys.js';
import { createSearchIndex, OVERLAP_MS } from '../src/search.js';

// gsi1 だけを再現した ddb。呼ばれた条件を記録する
function fakeDdb() {
  const items = new Map();
  const calls = [];
  return {
    calls,
    upsert(card) {
      const gsi1pk = `IDX#${shardOf(card.id)}`;
      items.set(card.id, { pk: `CARD#${card.id}`, sk: 'META', gsi1pk, gsi1sk: `${card.updatedAt}#${card.id}`, keys: searchKeys(card), ...card });
    },
    async queryAll({ pk, index, skGte }) {
      calls.push({ pk, index, skGte });
      return [...items.values()].filter((i) => i.gsi1pk === pk && (!skGte || i.gsi1sk >= skGte));
    },
  };
}

const card = (id, o = {}) => ({
  id, status: 'confirmed', company: '株式会社アシスト', name: `名前${id}`, emails: [], phones: [], mobiles: [],
  deptIds: ['d1'], createdBy: 'a@example.jp', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...o,
});

const user = (level, deptIds, id = 'u@example.jp') => ({ id, level, deptIds, capabilities: capabilitiesFor(level) });

test('起動時に 8 分割を全部読み、次の検索では前回より後の分だけを差分で取り込む', async () => {
  const db = fakeDdb();
  db.upsert(card('01A'));
  db.upsert(card('01B', { name: '田中 一郎' }));
  let t = Date.parse('2026-10-02T00:00:00.000Z');
  const idx = createSearchIndex({ ddb: db, now: () => t });

  const r1 = await idx.search({ user: user('org_edit', []), params: {} });
  assert.equal(r1.total, 2);
  assert.equal(db.calls.length, 8);
  assert.ok(db.calls.every((c) => c.index === 'gsi1' && c.skGte === undefined));

  // 更新された名刺だけが、重なりを持たせた時刻から読まれる
  t = Date.parse('2026-10-02T00:10:00.000Z');
  db.calls.length = 0;
  db.upsert(card('01B', { name: '田中 二郎', updatedAt: '2026-10-02T00:05:00.000Z' }));
  db.upsert(card('01C', { name: '新規 三郎', updatedAt: '2026-10-02T00:06:00.000Z' }));
  const r2 = await idx.search({ user: user('org_edit', []), params: {} });
  assert.equal(r2.total, 3);
  const expectFrom = new Date(Date.parse('2026-10-02T00:00:00.000Z') - OVERLAP_MS).toISOString();
  assert.ok(db.calls.every((c) => c.skGte === expectFrom));
  // cardId で上書きされ、新しい順に並ぶ
  assert.deepEqual(r2.entries.map((e) => e.id), ['01C', '01B', '01A']);
  assert.equal(r2.entries[1].item.name, '田中 二郎');
});

test('deletedAt のある名刺は一覧から外れる', async () => {
  const db = fakeDdb();
  db.upsert(card('01A'));
  let t = Date.parse('2026-10-02T00:00:00.000Z');
  const idx = createSearchIndex({ ddb: db, now: () => t });
  assert.equal((await idx.search({ user: user('org_admin', []), params: {} })).total, 1);
  t += 60_000;
  db.upsert(card('01A', { deletedAt: '2026-10-02T00:00:30.000Z', updatedAt: '2026-10-02T00:00:30.000Z' }));
  assert.equal((await idx.search({ user: user('org_admin', []), params: {} })).total, 0);
});

test('見える範囲: 部署が重なる名刺だけが出て、件数にも数えない', async () => {
  const db = fakeDdb();
  db.upsert(card('01A', { deptIds: ['d1'] }));
  db.upsert(card('01B', { deptIds: ['d2'] }));
  db.upsert(card('01C', { deptIds: ['d1', 'd2'] }));
  const idx = createSearchIndex({ ddb: db });

  const staff = await idx.search({ user: user('dept_edit', ['d1']), params: {} });
  assert.deepEqual(staff.entries.map((e) => e.id).sort(), ['01A', '01C']);
  assert.equal(staff.total, 2);

  const multi = await idx.search({ user: user('dept_edit', ['d1', 'd2']), params: {} });
  assert.equal(multi.total, 3);

  const all = await idx.search({ user: user('org_edit', []), params: {} });
  assert.equal(all.total, 3);

  // 担当部署の絞り込みは、見える範囲の中でだけ効く
  const filtered = await idx.search({ user: user('dept_view', ['d1']), params: { dept: 'd2' } });
  assert.deepEqual(filtered.entries.map((e) => e.id), ['01C']);
});

test('読み取り中と失敗は検索に出ない。本人が status を指定したときだけ出る', async () => {
  const db = fakeDdb();
  db.upsert(card('01A', { status: 'processing', createdBy: 'me@example.jp' }));
  db.upsert(card('01B', { status: 'failed', createdBy: 'other@example.jp' }));
  db.upsert(card('01C', { status: 'review', createdBy: 'me@example.jp' }));
  const idx = createSearchIndex({ ddb: db });
  const me = user('dept_view', ['d1'], 'me@example.jp');

  assert.deepEqual((await idx.search({ user: me, params: {} })).entries.map((e) => e.id), ['01C']);
  assert.deepEqual((await idx.search({ user: me, params: { status: 'processing' } })).entries.map((e) => e.id), ['01A']);
  // 他人の失敗した名刺は、部署が同じでも閲覧だけの人には出ない
  assert.equal((await idx.search({ user: me, params: { status: 'failed' } })).total, 0);
});

test('条件は AND、ページ送りは最後の位置の次から続く', async () => {
  const db = fakeDdb();
  for (let i = 0; i < 5; i++) {
    db.upsert(card(`01${i}`, { name: `山田 ${i}`, updatedAt: `2026-10-0${i + 1}T00:00:00.000Z` }));
  }
  db.upsert(card('01X', { company: '別会社', name: '山田 九', updatedAt: '2026-10-09T00:00:00.000Z' }));
  const idx = createSearchIndex({ ddb: db });
  const u = user('org_edit', []);

  const p1 = await idx.search({ user: u, params: { company: 'アシスト', name: '山田' }, limit: 2 });
  assert.equal(p1.total, 5);
  assert.deepEqual(p1.entries.map((e) => e.id), ['014', '013']);
  assert.ok(p1.nextCursor);
  const p2 = await idx.search({ user: u, params: { company: 'アシスト', name: '山田' }, limit: 2, cursor: p1.nextCursor });
  assert.deepEqual(p2.entries.map((e) => e.id), ['012', '011']);
  const p3 = await idx.search({ user: u, params: { company: 'アシスト', name: '山田' }, limit: 2, cursor: p2.nextCursor });
  assert.deepEqual(p3.entries.map((e) => e.id), ['010']);
  assert.equal(p3.nextCursor, null);
});

test('重複の知らせは、見える範囲の名刺だけを対象にする', async () => {
  const db = fakeDdb();
  db.upsert(card('01A', { emails: ['x@example.jp'], deptIds: ['d2'] })); // 見えない部署
  db.upsert(card('01B', { emails: ['x@example.jp'], deptIds: ['d1'] }));
  const idx = createSearchIndex({ ddb: db });
  const mine = card('01N', { status: 'review', emails: ['X@example.jp'], deptIds: ['d1'] });
  const dups = await idx.findDuplicates(user('dept_edit', ['d1']), mine);
  assert.deepEqual(dups.map((d) => d.id), ['01B']);
  assert.equal(dups[0].reason, 'email');
});
