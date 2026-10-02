-- 音声ファイルのアップロード（mode: upload）。docs/minutes-design.md §4.4。
-- minutes.mode の CHECK に 'upload' を足す。SQLite は CHECK を後から変えられないので作り直す。
-- 子テーブル（区切り・同席者・相手・共有・資料・質問）が minutes を参照しているため、
-- 外部キーの検査はコミットまで後回しにする。DROP の暗黙の DELETE で出る違反は、同じ名前の minutes へ
-- 行を入れ直すと解消される（別名で作って RENAME する方法だと解消されずに失敗するため、退避してから同名で作り直す）。
PRAGMA defer_foreign_keys = on;

CREATE TABLE minutes_bak AS SELECT * FROM minutes;
DROP TABLE minutes;

CREATE TABLE minutes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  held_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('web', 'room', 'upload')),
  duration_sec INTEGER NOT NULL DEFAULT 0,
  memo TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  step TEXT,
  progress TEXT,
  failure TEXT,
  segment_sec INTEGER NOT NULL DEFAULT 600,
  audio_mime TEXT NOT NULL DEFAULT 'audio/webm',
  audio_expires_at TEXT,
  audio_deleted INTEGER NOT NULL DEFAULT 0,
  full_audio_key TEXT,
  transcript_key TEXT,
  transcript_prev_key TEXT,
  transcript_version INTEGER NOT NULL DEFAULT 0,
  transcript_model TEXT,
  transcript_at TEXT,
  summary_key TEXT,
  summary_prev_key TEXT,
  summary_version INTEGER NOT NULL DEFAULT 0,
  summary_model TEXT,
  summary_at TEXT,
  workflow_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  summary_with_materials INTEGER NOT NULL DEFAULT 0,
  summary_material_ids TEXT NOT NULL DEFAULT '[]',
  summary_mapping_key TEXT,
  summary_prev_with_materials INTEGER NOT NULL DEFAULT 0,
  summary_prev_mapping_key TEXT
);
INSERT INTO minutes (
  id, title, held_at, mode, duration_sec, memo, owner_id, status, step, progress, failure, segment_sec, audio_mime,
  audio_expires_at, audio_deleted, full_audio_key, transcript_key, transcript_prev_key, transcript_version,
  transcript_model, transcript_at, summary_key, summary_prev_key, summary_version, summary_model, summary_at,
  workflow_id, created_at, updated_at, deleted_at, summary_with_materials, summary_material_ids,
  summary_mapping_key, summary_prev_with_materials, summary_prev_mapping_key
) SELECT
  id, title, held_at, mode, duration_sec, memo, owner_id, status, step, progress, failure, segment_sec, audio_mime,
  audio_expires_at, audio_deleted, full_audio_key, transcript_key, transcript_prev_key, transcript_version,
  transcript_model, transcript_at, summary_key, summary_prev_key, summary_version, summary_model, summary_at,
  workflow_id, created_at, updated_at, deleted_at, summary_with_materials, summary_material_ids,
  summary_mapping_key, summary_prev_with_materials, summary_prev_mapping_key
FROM minutes_bak;
DROP TABLE minutes_bak;
CREATE INDEX minutes_owner ON minutes(owner_id, held_at);
