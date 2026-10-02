import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyKey, similarCompanies, groupByCompany } from '../src/index.js';

test('companyKey: 法人格と表記の違いを吸収する', () => {
  const k = companyKey('株式会社アシスト');
  for (const v of ['アシスト（株）', 'ｱｼｽﾄ 株式会社', '㈱アシスト', 'アシスト株式会社', ' 株式会社 アシスト ']) assert.equal(companyKey(v), k, v);
  assert.equal(companyKey('Assist Inc.'), companyKey('ASSIST'));
  assert.equal(companyKey('Assist Co.,Ltd.'), companyKey('assist'));
  assert.equal(companyKey('Assist K.K.'), companyKey('assist'));
  assert.equal(companyKey('一般社団法人 日本・ほげ'), companyKey('日本ほげ'));
  assert.equal(companyKey('mincing'), 'mincing');
  assert.equal(companyKey('日本株研究所'), companyKey('日本株研究所'));
  assert.notEqual(companyKey('日本株研究所'), companyKey('日本研究所'));
  assert.equal(companyKey(''), '');
  assert.equal(companyKey(null), '');
});

test('similarCompanies: 完全一致、包含、Dice の順。表記が同じものは除く', () => {
  const list = [
    { company: '株式会社アシスト' },
    { company: 'アシスト（株）' },
    { company: 'アシストシステムズ' },
    { company: 'アシスタント' },
    { company: '全然ちがう会社' },
  ];
  const r = similarCompanies('アシスト株式会社', list);
  assert.deepEqual(r.slice(0, 3).map((x) => x.company), ['株式会社アシスト', 'アシスト（株）', 'アシストシステムズ']);
  assert.ok(!r.some((x) => x.company === '全然ちがう会社'));
  assert.deepEqual(similarCompanies('株式会社アシスト', list).map((x) => x.company).includes('株式会社アシスト'), false);
  assert.equal(similarCompanies('アシスト株式会社', list, { limit: 1 }).length, 1);
  // Dice: 包含ではないが似ている
  assert.equal(similarCompanies('東京商事', [{ company: '東京商会' }, { company: '大阪重工' }]).length, 1);
  assert.equal(similarCompanies('ひろしま電機', [{ company: 'ひろしま電気' }]).length, 1);
});

test('groupByCompany: 会社 → 部署 → 人。除外、表記、並び、limit', () => {
  const c = (id, company, department, name, o = {}) => ({ id, company, department, name, title: '', status: 'confirmed', ...o });
  const cards = [
    c('1', '株式会社アシスト', '営業部', '山田', { title: '部長' }),
    c('2', 'アシスト（株）', '営業部', '佐藤'),
    c('3', '株式会社アシスト', '', '鈴木'),
    c('4', '株式会社アシスト', '営業部', '消した', { deletedAt: 'x' }),
    c('5', '株式会社アシスト', '営業部', '未確認', { status: 'review' }),
    c('6', '', '営業部', '会社なし'),
    c('7', 'ベータ商事', '開発部', '田中'),
    c('8', 'ガンマ', '総務', '高橋'),
  ];
  const r = groupByCompany(cards);
  assert.deepEqual(r.map((x) => x.company), ['株式会社アシスト', 'ガンマ', 'ベータ商事']);
  const a = r[0];
  assert.equal(a.count, 3);
  assert.deepEqual(a.departments.map((d) => [d.name, d.count]), [['', 1], ['営業部', 2]]);
  assert.deepEqual(a.departments[1].people, [{ id: '2', name: '佐藤', title: '' }, { id: '1', name: '山田', title: '部長' }]);
  assert.equal(groupByCompany(cards, { q: 'アシスト' }).length, 1);
  assert.equal(groupByCompany(cards, { q: '（株）ベータ' }).length, 1);
  assert.equal(groupByCompany(cards, { limit: 2 }).length, 2);
});
