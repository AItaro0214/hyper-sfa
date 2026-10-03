// 同じ人の名刺（design §5.5b）。SQL は node:sqlite に本物のマイグレーションを流して確かめる（D1 は SQLite）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { searchKeys } from '../worker/src/core.js';
import { keyColumns } from '../worker/src/lib/cards.js';
import {
  GUARD_SQL,
  buildMatchQuery,
  isGuardError,
  matchesFromRows,
  personCardsOf,
  planCurrent,
  rowMatchKeys,
} from '../worker/src/lib/person.js';
import { matchKeys } from '../worker/src/core.js';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // node:sqlite が無い Node では SQL を実際には流さない
}
const skip = DatabaseSync ? false : 'node:sqlite がありません';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
function migrate(db, { beforePerson } = {}) {
  for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    if (f.startsWith('0010') && beforePerson) beforePerson(db);
    db.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
}

// 保存時と同じ列を作って 1 枚入れる（emails / phones / 検索用の列 / card_contacts）
function insertCard(db, c) {
  const card = { company: '', department: '', title: '', name: '', nameReading: '', phones: [], mobiles: [], emails: [], note: '', ...c };
  const k = keyColumns(searchKeys(card));
  db.prepare(
    `INSERT INTO cards (id, status, company, department, title, name, phones, mobiles, emails, company_n, name_n, phones_digits, emails_n, title_n,
       created_by, created_at, updated_at, person_id, is_current)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'u', ?, ?, ?, ?)`,
  ).run(
    card.id, card.status ?? 'confirmed', card.company, card.department, card.title, card.name,
    JSON.stringify(card.phones), JSON.stringify(card.mobiles), JSON.stringify(card.emails),
    k.company_n, k.name_n, k.phones_digits, k.emails_n, k.title_n,
    card.createdAt ?? '2026-09-01T00:00:00.000Z', card.createdAt ?? '2026-09-01T00:00:00.000Z', card.personId ?? card.id, card.isCurrent ?? 1,
  );
  const sk = searchKeys(card);
  for (const e of sk.emailsN) db.prepare("INSERT OR IGNORE INTO card_contacts VALUES ('e', ?, ?)").run(e, card.id);
  for (const p of sk.phonesDigits) db.prepare("INSERT OR IGNORE INTO card_contacts VALUES ('p', ?, ?)").run(p, card.id);
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.exec("INSERT INTO users (id, login_id, password_hash, salt, iterations, role, created_at) VALUES ('u', 'u', 'x', 'x', 1, 'admin', 't')");
  return db;
}

test('候補を引く SQL は = と IN だけ（LIKE なし）で、全件を走査せず索引で引く。判定は同じ名刺 / 同じ人 / 同じ名前', { skip }, () => {
  const db = freshDb();
  insertCard(db, { id: 'P1', company: '株式会社アシスト', department: '営業部', title: '課長', name: '山田 太郎', emails: ['taro@example.jp'], mobiles: ['090-1111-2222'] });
  insertCard(db, { id: 'S1', company: '別の会社', name: '山田 太郎', emails: ['other@example.jp'] });
  insertCard(db, { id: 'OLD', company: '株式会社アシスト', name: '山田 太郎', emails: ['taro@example.jp'], isCurrent: 0, personId: 'P1' });
  insertCard(db, { id: 'DEL', company: '株式会社アシスト', name: '山田 太郎', emails: ['taro@example.jp'] });
  db.exec("UPDATE cards SET deleted_at = 't' WHERE id = 'DEL'");
  for (let i = 0; i < 2000; i++) insertCard(db, { id: `X${i}`, company: `会社${i}`, name: `人${i}`, emails: [`x${i}@example.jp`] });

  // 役職と部署が変わった新しい名刺（メールが同じ）
  const mine = matchKeys({ company: 'アシスト（株）', title: '部長', name: '山田 太郎', emails: ['Taro@Example.jp'], mobiles: ['09011112222'] });
  const q = buildMatchQuery(mine, { selfId: 'NEW' });
  assert.doesNotMatch(q.sql, /LIKE/i);
  assert.equal([...q.sql.matchAll(/\?/g)].length, q.params.length);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params).map((r) => r.detail).join('\n');
  assert.doesNotMatch(plan, /SCAN (cards|c)\b/, plan);
  assert.match(plan, /idx_cards_name_n/);
  assert.match(plan, /card_contacts USING PRIMARY KEY/);

  const rows = db.prepare(q.sql).all(...q.params);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['P1', 'S1'], '過去と削除済みは候補に出ない');
  const matches = matchesFromRows(rows, mine);
  assert.deepEqual(matches.map((m) => [m.id, m.kind, m.reason]), [['P1', 'same_person', 'email'], ['S1', 'same_name', 'name']]);
  assert.equal(matches[0].title, '課長');

  // 保存済みと全く同じ内容を撮り直したら同じ名刺
  const p1 = rows.find((r) => r.id === 'P1');
  assert.equal(matchesFromRows([p1], rowMatchKeys(p1))[0].kind, 'same_card');
  // 手掛かりが無ければ引かない
  assert.equal(buildMatchQuery(matchKeys({ company: 'x' }), { selfId: 'a' }), null);
});

test('更新の書き込みは、前の名刺が先に更新されていたら全体を巻き戻す（GUARD）', { skip }, () => {
  const db = freshDb();
  insertCard(db, { id: 'P1', name: '山田 太郎', emails: ['taro@example.jp'], title: '課長' });
  insertCard(db, { id: 'N1', status: 'review', name: '山田 太郎', emails: ['taro@example.jp'], title: '部長' });
  const run = (prevVersion) => {
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE cards SET is_current = 0, version = version + 1 WHERE id = ? AND version = ? AND is_current = 1').run('P1', prevVersion);
      db.prepare(GUARD_SQL).get();
      db.prepare("UPDATE cards SET status = 'confirmed', person_id = 'P1', supersedes = 'P1' WHERE id = 'N1'").run();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  // 他の人が先に更新して version が進んでいた
  assert.throws(() => run(99), (e) => isGuardError(e));
  assert.deepEqual({ ...db.prepare("SELECT status, person_id FROM cards WHERE id = 'N1'").get() }, { status: 'review', person_id: 'N1' });
  assert.equal(db.prepare("SELECT is_current FROM cards WHERE id = 'P1'").get().is_current, 1);
  run(1);
  assert.equal(db.prepare("SELECT is_current FROM cards WHERE id = 'P1'").get().is_current, 0);
  assert.equal(db.prepare("SELECT person_id FROM cards WHERE id = 'N1'").get().person_id, 'P1');

  // 現在の付け直し: 一番新しい確認済みが現在になり、確認待ちは対象外
  const { top, flips } = planCurrent([
    { id: 'A', created_at: '2026-01-01', is_current: 0, version: 1, status: 'confirmed' },
    { id: 'B', created_at: '2026-05-01', is_current: 0, version: 3, status: 'confirmed' },
    { id: 'C', created_at: '2026-09-01', is_current: 0, version: 1, status: 'review' },
  ]);
  assert.equal(top.id, 'B');
  assert.deepEqual(flips, [{ id: 'B', version: 3, current: true }]);
  assert.deepEqual(personCardsOf([{ id: 'B', created_at: '2', is_current: 1 }, { id: 'A', created_at: '1', is_current: 0 }]).map((c) => [c.id, c.isCurrent]), [['A', false], ['B', true]]);
});

test('マイグレーション 0010: 既存の名刺は 1 枚 1 人、メール・電話の引き表と履歴の新しい type が使える', { skip }, () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, {
    beforePerson(d) {
      d.exec("INSERT INTO users (id, login_id, password_hash, salt, iterations, role, created_at) VALUES ('u', 'u', 'x', 'x', 1, 'admin', 't')");
      d.exec(
        `INSERT INTO cards (id, status, name_n, emails_n, phones_digits, created_by, created_at, updated_at)
         VALUES ('c1', 'confirmed', 'やまだ', 'a@x.jp b@x.jp', '0312345678 09011112222', 'u', 't', 't')`,
      );
      d.exec("INSERT INTO card_history (id, card_id, type, actor_id, actor_name, at) VALUES ('h1', 'c1', 'create', 'u', 'u', 't')");
    },
  });
  assert.deepEqual({ ...db.prepare('SELECT person_id, is_current FROM cards').get() }, { person_id: 'c1', is_current: 1 });
  assert.deepEqual(
    db.prepare('SELECT kind, k FROM card_contacts ORDER BY kind, k').all().map((r) => `${r.kind}:${r.k}`),
    ['e:a@x.jp', 'e:b@x.jp', 'p:0312345678', 'p:09011112222'],
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM card_history').get().n, 1, '履歴は作り直しても残る');
  db.exec("INSERT INTO card_history (id, card_id, type, actor_id, actor_name, at) VALUES ('h2', 'c1', 'person_update', 'u', 'u', 't')");
});
