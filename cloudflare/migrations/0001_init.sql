-- Cloudflare 版のスキーマ（docs/cloudflare-small-design.md §5）。
-- 検索用の正規化列（*_n）は書き込み時にアプリが作る。LIKE の全件走査で数千件なら数ミリ秒。

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  display_name TEXT NOT NULL DEFAULT '',
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX login_attempts_login ON login_attempts(login_id, at);
CREATE INDEX login_attempts_ip ON login_attempts(ip, at);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'review', 'failed', 'confirmed')),
  company TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  name_reading TEXT NOT NULL DEFAULT '',
  phones TEXT NOT NULL DEFAULT '[]',
  mobiles TEXT NOT NULL DEFAULT '[]',
  emails TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  raw_text TEXT NOT NULL DEFAULT '',
  company_n TEXT NOT NULL DEFAULT '',
  name_n TEXT NOT NULL DEFAULT '',
  reading_n TEXT NOT NULL DEFAULT '',
  department_n TEXT NOT NULL DEFAULT '',
  phones_digits TEXT NOT NULL DEFAULT '',
  emails_n TEXT NOT NULL DEFAULT '',
  note_n TEXT NOT NULL DEFAULT '',
  image_front_key TEXT,
  image_back_key TEXT,
  thumb_key TEXT,
  failure TEXT,
  extraction TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  edit_count INTEGER NOT NULL DEFAULT 0,
  scan_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX cards_created ON cards(created_at);
CREATE INDEX cards_deleted ON cards(deleted_at);

CREATE TABLE card_history (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  type TEXT NOT NULL CHECK (type IN ('create', 'edit', 'rescan', 'delete', 'restore')),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  changes TEXT NOT NULL DEFAULT '[]',
  at TEXT NOT NULL
);
CREATE INDEX card_history_card ON card_history(card_id, at);
CREATE INDEX card_history_at ON card_history(at);

CREATE TABLE minutes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  held_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('web', 'room')),
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
  deleted_at TEXT
);
CREATE INDEX minutes_owner ON minutes(owner_id, held_at);

CREATE TABLE minute_segments (
  minute_id TEXT NOT NULL REFERENCES minutes(id),
  seq INTEGER NOT NULL,
  key TEXT NOT NULL,
  mime TEXT NOT NULL,
  start_sec INTEGER NOT NULL,
  duration_sec INTEGER NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  uploaded INTEGER NOT NULL DEFAULT 0,
  transcript_key TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (minute_id, seq)
);

CREATE TABLE minute_counterparts (
  minute_id TEXT NOT NULL REFERENCES minutes(id),
  seq INTEGER NOT NULL,
  card_id TEXT,
  company TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  company_n TEXT NOT NULL DEFAULT '',
  name_n TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (minute_id, seq)
);
CREATE INDEX minute_counterparts_card ON minute_counterparts(card_id);

CREATE TABLE minute_attendees (
  minute_id TEXT NOT NULL REFERENCES minutes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (minute_id, user_id)
);

CREATE TABLE minute_shares (
  minute_id TEXT NOT NULL REFERENCES minutes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  shared_by TEXT NOT NULL,
  shared_at TEXT NOT NULL,
  PRIMARY KEY (minute_id, user_id)
);
CREATE INDEX minute_shares_user ON minute_shares(user_id);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'openai')),
  label TEXT NOT NULL,
  uses TEXT NOT NULL DEFAULT '[]',
  pricing TEXT NOT NULL DEFAULT '{}',
  thinking_level TEXT,
  max_audio_minutes INTEGER,
  shutdown_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);

CREATE TABLE prompts (
  kind TEXT NOT NULL CHECK (kind IN ('card', 'transcribe', 'summarize')),
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  saved_by TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (kind, version)
);

CREATE TABLE usage_monthly (
  year_month TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (year_month, user_id, kind)
);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  model_id TEXT,
  ok INTEGER NOT NULL,
  failure_kind TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0
);
CREATE INDEX usage_events_user ON usage_events(user_id, at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at ON audit_log(at);

CREATE TABLE scan_quota (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
