-- 名刺の役職を独立した項目にする（これまでは備考に「役職: 営業部長」と入れていた）。
-- title_n は検索用。備考の欄で探した語を note_n と title_n の両方に当てる。
ALTER TABLE cards ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN title_n TEXT NOT NULL DEFAULT '';
