import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractJson, normalizeCard, isEmptyCard, JsonExtractError } from '../src/index.js';

const fx = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const cases = [
  ['gemini-fence.txt', ['fence'], false],
  ['gemini-prose.txt', ['slice'], false],
  ['gemini-comments.txt', ['comments'], false],
  ['gemini-trailing-comma.txt', ['trailing_comma'], false],
  ['gemini-fullwidth.txt', ['fullwidth'], false],
  ['gemini-bare-keys.txt', ['quotes'], false],
  ['gemini-raw-newline.txt', ['newline'], false],
  ['gemini-brace-in-note.txt', [], false],
];
for (const [file, repairs, truncated] of cases) {
  test(`extractJson: ${file}`, () => {
    const r = extractJson(fx(file));
    assert.equal(r.value.company, '株式会社アシスト');
    assert.equal(r.value.name, '山田 太郎');
    for (const name of repairs) assert.ok(r.repairs.includes(name), `${name} が repairs に無い: ${r.repairs}`);
    assert.equal(r.truncated, truncated);
  });
}

test('extractJson: 備考の中の // と } は壊さない', () => {
  assert.equal(extractJson(fx('gemini-comments.txt')).value.note, 'https://example.co.jp // 公式サイト');
  assert.equal(extractJson(fx('gemini-brace-in-note.txt')).value.note, '資格: {一級建築士} / 委員: }協会{');
  // 説明文つきでも、備考の } で切らない
  const r = extractJson('結果です\n{"note": "a } b", "name": "x"}\n以上');
  assert.equal(r.value.note, 'a } b');
});

test('extractJson: 文字列中の生の改行は \\n になる', () => {
  assert.equal(extractJson(fx('gemini-raw-newline.txt')).value.note, '住所: 東京都千代田区\n1-2-3');
});

test('extractJson: 途中で切れた応答は読めた項目だけ拾う', () => {
  const r = extractJson(fx('gemini-truncated.txt'));
  assert.equal(r.truncated, true);
  assert.ok(r.repairs.includes('truncated'));
  assert.equal(r.value.company, '株式会社アシスト');
  assert.equal(r.value.emails[0], 'taro@example.co.jp');
});

test('extractJson: キーだけ書いて切れた場合はその項目を捨てる', () => {
  const r = extractJson(fx('gemini-truncated-key.txt'));
  assert.equal(r.truncated, true);
  assert.deepEqual(r.value, { company: '株式会社アシスト', phones: ['03-1234-5678'] });
});

test('extractJson: 取り出せなければ JsonExtractError', () => {
  assert.throws(() => extractJson('読み取れませんでした'), (e) => e instanceof JsonExtractError && e.code === 'parse');
});

test('normalizeCard: 外側の result、別名、文字列と配列のずれ、知らないキー', () => {
  const card = normalizeCard(extractJson(fx('gemini-wrapped-result.txt')).value);
  assert.deepEqual(card.emails, ['taro@example.co.jp', 'hanako@example.co.jp']);
  assert.deepEqual(card.phones, ['03-1234-5678']);
  assert.equal(card.company, '株式会社アシスト');
  assert.equal('fax' in card, false);
  assert.ok(card.coerced.includes('unwrap:result'));
  assert.ok(card.coerced.includes('alias:email->emails'));
});

test('normalizeCard: 配列で包まれ、日本語キー、null は空文字', () => {
  const card = normalizeCard(extractJson(fx('gemini-array.txt')).value);
  assert.equal(card.company, '株式会社アシスト');
  assert.equal(card.name, '山田 太郎');
  assert.equal(card.department, '');
  assert.deepEqual(card.emails, ['taro@example.co.jp']);
});

test('normalizeCard: 大文字小文字を無視、snake_case の読みと全文', () => {
  const card = normalizeCard({ Company_Name: 'A', NAME_READING: 'やまだ', raw_text: 'zzz', Mobile: '090-1111-2222', 配列: 1 });
  assert.equal(card.company, 'A');
  assert.equal(card.nameReading, 'やまだ');
  assert.equal(card.rawText, 'zzz');
  assert.deepEqual(card.mobiles, ['090-1111-2222']);
});

test('isEmptyCard', () => {
  assert.equal(isEmptyCard(normalizeCard({})), true);
  assert.equal(isEmptyCard(normalizeCard({ company: null, emails: [] })), true);
  assert.equal(isEmptyCard(normalizeCard({ name: 'x' })), false);
});

test('normalizeCard: 役職の別名', () => {
  for (const k of ['title', 'position', 'job_title', 'role', '役職', '肩書', '肩書き']) {
    assert.equal(normalizeCard({ [k]: '営業部長' }).title, '営業部長', k);
  }
  assert.equal(normalizeCard({}).title, '');
  assert.equal(isEmptyCard(normalizeCard({ title: '部長' })), false);
});
