-- 議事録に添付する資料（PDF / pptx / xlsx）。docs/minutes-design.md §15。
-- outline_status は pending / done / failed / none に加え、アップロード途中の 'uploading' を内部で使う
-- （done を受け取るまで一覧に出さず、1 時間たったものは次の追加のときに捨てる）。
CREATE TABLE minute_materials (
  id TEXT PRIMARY KEY,
  minute_id TEXT NOT NULL REFERENCES minutes(id),
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pdf', 'pptx', 'xlsx')),
  size INTEGER NOT NULL DEFAULT 0,
  pages INTEGER,
  key TEXT NOT NULL,
  extract_key TEXT,
  outline_key TEXT,
  outline_status TEXT NOT NULL DEFAULT 'uploading',
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL
);
CREATE INDEX minute_materials_minute ON minute_materials(minute_id, seq);

-- 資料を踏まえた版かどうか、どの資料を使ったか、対応表の置き場所。前の版に戻せるよう prev も持つ
ALTER TABLE minutes ADD COLUMN summary_with_materials INTEGER NOT NULL DEFAULT 0;
ALTER TABLE minutes ADD COLUMN summary_material_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE minutes ADD COLUMN summary_mapping_key TEXT;
ALTER TABLE minutes ADD COLUMN summary_prev_with_materials INTEGER NOT NULL DEFAULT 0;
ALTER TABLE minutes ADD COLUMN summary_prev_mapping_key TEXT;

-- プロンプトの種類に outline と summarize_materials を足す。SQLite は CHECK を後から変えられないので作り直す
CREATE TABLE prompts_new (
  kind TEXT NOT NULL CHECK (kind IN ('card', 'transcribe', 'summarize', 'outline', 'summarize_materials')),
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  saved_by TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (kind, version)
);
INSERT INTO prompts_new (kind, version, text, saved_by, saved_at) SELECT kind, version, text, saved_by, saved_at FROM prompts;
DROP TABLE prompts;
ALTER TABLE prompts_new RENAME TO prompts;
