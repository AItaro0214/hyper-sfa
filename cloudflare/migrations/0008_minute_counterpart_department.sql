-- 議事録の一覧を相手の部署名で絞るための検索用の列（空白を除いて正規化した形。アプリが保存時に入れる）。
-- 既存の行は、アプリの正規化（NFKC）を SQL で再現できないので、小文字化と空白除去だけで埋める。
-- 全角英数字などの表記ゆれは、相手を保存し直したときに揃う。
ALTER TABLE minute_counterparts ADD COLUMN department_n TEXT NOT NULL DEFAULT '';
UPDATE minute_counterparts SET department_n = lower(replace(replace(department, ' ', ''), '　', ''));
