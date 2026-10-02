// 取引先の集計の材料。索引の見える範囲から会社 → 部署 → 人が組み上がり、範囲の外が入らないこと。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor, searchKeys, groupByCompany } from '@hyper-sfa/core';
import { shardOf } from '@hyper-sfa/aws-shared/keys.js';
import { createSearchIndex } from '../src/search.js';

const rows = [
  { id: '01A', company: '株式会社アシスト', department: '営業部', name: '山田 太郎', deptIds: ['d1'] },
  { id: '01B', company: 'アシスト（株）', department: '営業部', name: '佐藤 花子', deptIds: ['d1'] },
  { id: '01C', company: '株式会社アシスト', department: '開発部', name: '鈴木 一郎', deptIds: ['d1'] },
  { id: '01D', company: '他部署だけの会社', department: '営業部', name: '見えない人', deptIds: ['d2'] },
  { id: '01E', company: '株式会社アシスト', department: '営業部', name: '確認待ち', deptIds: ['d1'], status: 'review' },
];

function fakeDdb() {
  const items = rows.map((r) => {
    const card = {
      status: 'confirmed', phones: [], mobiles: [], emails: [], createdBy: 'a@example.jp',
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...r,
    };
    return { pk: `CARD#${card.id}`, sk: 'META', gsi1pk: `IDX#${shardOf(card.id)}`, gsi1sk: `${card.updatedAt}#${card.id}`, keys: searchKeys(card), ...card };
  });
  return { queryAll: async ({ pk }) => items.filter((i) => i.gsi1pk === pk) };
}

test('見える範囲の確認済みの名刺から、会社 → 部署 → 人が組み上がる', async () => {
  const idx = createSearchIndex({ ddb: fakeDdb() });
  const user = { id: 'u@example.jp', level: 'dept_view', deptIds: ['d1'], capabilities: capabilitiesFor('dept_view') };
  const r = groupByCompany(await idx.visibleConfirmed(user));
  assert.equal(r.length, 1, '他部署の会社と確認待ちは入らない');
  assert.equal(r[0].count, 3);
  assert.deepEqual(r[0].departments.map((d) => [d.name, d.people.map((p) => p.name)]), [
    ['営業部', ['佐藤 花子', '山田 太郎']],
    ['開発部', ['鈴木 一郎']],
  ]);
});
