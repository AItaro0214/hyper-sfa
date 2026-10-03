import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchKeys, classifyMatch, rankMatches } from '../src/index.js';

const base = {
  company: '株式会社アシスト', department: '営業部', title: '課長', name: '山田 太郎',
  phones: ['03-1234-5678'], mobiles: ['090-1111-2222'], emails: ['Taro@Example.jp'],
};
const kind = (a, b) => classifyMatch(matchKeys(a), matchKeys(b));

test('同じ名刺: 表記ゆれがあっても、氏名・会社・連絡先・役職が同じなら同じ名刺', () => {
  const r = kind(base, { ...base, company: 'アシスト（株）', name: '山田　太郎', phones: ['+81 3-1234-5678'], emails: ['taro@example.jp'], department: '営業本部' });
  assert.equal(r.kind, 'same_card');
});

test('同じ人: 役職や部署が変わっても、メールが同じなら同じ人', () => {
  const r = kind(base, { ...base, title: '部長', department: '営業本部', name: '山田 次郎', mobiles: [] });
  assert.deepEqual(r, { kind: 'same_person', reason: 'email' });
});

test('同じ人: 携帯が同じ（ハイフンの有無を問わない）。代表電話だけが同じでは同じ人にしない', () => {
  const mine = { ...base, emails: [], title: '部長' };
  assert.deepEqual(kind(mine, { ...base, emails: [], mobiles: ['09011112222'], name: '別 人' }), { kind: 'same_person', reason: 'mobile' });
  assert.equal(kind({ ...mine, mobiles: [] }, { ...base, emails: [], mobiles: [], name: '別 人' }), null);
});

test('同じ人: メールも携帯も変わっても、同じ取引先で氏名が同じなら同じ人', () => {
  const r = kind({ ...base, emails: ['new@example.jp'], mobiles: ['080-0000-0000'], title: '部長' }, base);
  assert.deepEqual(r, { kind: 'same_person', reason: 'company_name' });
});

test('同じ名前: 会社が違えば氏名だけ一致', () => {
  const r = kind({ ...base, company: '別の会社', emails: [], mobiles: [], phones: [] }, base);
  assert.deepEqual(r, { kind: 'same_name', reason: 'name' });
});

test('空の項目: 空同士は一致扱いにならない。rankMatches は強い順に最大件数まで', () => {
  const empty = { company: '', name: '', emails: [], phones: [], mobiles: [] };
  assert.equal(kind(empty, empty), null);
  assert.equal(kind({ ...base, name: '' }, { ...base, name: '', emails: [], mobiles: [] }), null);
  const ranked = rankMatches([
    { id: 'a', kind: 'same_name', reason: 'name' },
    { id: 'b', kind: 'same_person', reason: 'company_name', createdAt: '1' },
    { id: 'c', kind: 'same_card', reason: 'company_name' },
    { id: 'd', kind: 'same_person', reason: 'email' },
    { id: 'e', kind: 'same_person', reason: 'company_name', createdAt: '2' },
  ], { max: 4 });
  assert.deepEqual(ranked.map((x) => x.id), ['c', 'd', 'e', 'b']);
});
