-- 議事録への質問（docs/minutes-design.md §16）。スレッドは利用者ごと。連番も利用者ごと（質問と答えで 2 行）。
-- 議事録は論理削除だが、質問と答えは削除のときに全員分を実際に消す。
CREATE TABLE minute_chats (
  minute_id TEXT NOT NULL REFERENCES minutes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  model_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (minute_id, user_id, seq)
);

-- 質問の 1 日の上限（名刺の読み取りの scan_quota と同じ作り。用途ごとに別のカウンタにして、互いの上限を食い合わないようにする。
-- scan_quota に kind 列を足すと主キーを変える作り直しになるので、別の表にした）
CREATE TABLE qa_quota (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- プロンプトの種類に qa を足す。SQLite は CHECK を後から変えられないので 0003 と同じく作り直す
CREATE TABLE prompts_new (
  kind TEXT NOT NULL CHECK (kind IN ('card', 'transcribe', 'summarize', 'outline', 'summarize_materials', 'qa')),
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  saved_by TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (kind, version)
);
INSERT INTO prompts_new (kind, version, text, saved_by, saved_at) SELECT kind, version, text, saved_by, saved_at FROM prompts;
DROP TABLE prompts;
ALTER TABLE prompts_new RENAME TO prompts;
