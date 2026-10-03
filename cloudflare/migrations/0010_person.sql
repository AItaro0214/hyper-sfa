-- 名刺の上に「人」の単位を置く（docs/design.md §5.5b）。
-- person_id: 同じ人の名刺は同じ値。is_current: その人の最新の 1 枚だけ 1。supersedes: 更新で置き換えた前の名刺。
ALTER TABLE cards ADD COLUMN person_id TEXT;
ALTER TABLE cards ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cards ADD COLUMN supersedes TEXT;
-- 既存の名刺は 1 枚 1 人。名刺 ID を人 ID にする
UPDATE cards SET person_id = id WHERE person_id IS NULL;

CREATE INDEX idx_cards_person ON cards(person_id);
-- 氏名の一致で候補を引く。LIKE ではなく = で引くので索引が効く
CREATE INDEX idx_cards_name_n ON cards(name_n);

-- メールと電話（数字だけ）の引き表。emails_n / phones_digits は空白でつないだ 1 つの文字列で、= では引けないため、
-- 1 件ずつの行に分けて持つ。(kind, k) で引くので、名刺が何枚あっても候補を引く速さは変わらない。
-- kind: 'e' = メール、'p' = 電話・携帯の数字。書き込みは名刺の保存のたびにアプリが作り直す。
CREATE TABLE card_contacts (
  kind TEXT NOT NULL,
  k TEXT NOT NULL,
  card_id TEXT NOT NULL,
  PRIMARY KEY (kind, k, card_id)
) WITHOUT ROWID;

-- 既存の名刺の分は、保存済みの正規化列を空白で割って作る（アプリの searchKeys と同じ値になる）
INSERT OR IGNORE INTO card_contacts (kind, k, card_id)
WITH RECURSIVE split(card_id, kind, k, rest) AS (
  SELECT id, 'e', '', emails_n || ' ' FROM cards WHERE emails_n != ''
  UNION ALL
  SELECT id, 'p', '', phones_digits || ' ' FROM cards WHERE phones_digits != ''
  UNION ALL
  SELECT card_id, kind, substr(rest, 1, instr(rest, ' ') - 1), substr(rest, instr(rest, ' ') + 1) FROM split WHERE rest != ''
)
SELECT kind, k, card_id FROM split WHERE k != '';

-- 履歴の type に 'person_update'（名刺の更新）を足す。SQLite は CHECK を後から変えられないので作り直す。
CREATE TABLE card_history_new (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  type TEXT NOT NULL CHECK (type IN ('create', 'edit', 'rescan', 'delete', 'restore', 'person_update')),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  changes TEXT NOT NULL DEFAULT '[]',
  at TEXT NOT NULL
);
INSERT INTO card_history_new (id, card_id, type, actor_id, actor_name, source, changes, at)
  SELECT id, card_id, type, actor_id, actor_name, source, changes, at FROM card_history;
DROP TABLE card_history;
ALTER TABLE card_history_new RENAME TO card_history;
CREATE INDEX card_history_card ON card_history(card_id, at);
CREATE INDEX card_history_at ON card_history(at);
