-- 名刺画像の縮小済みの印。縮小はブラウザが行い、済んだら 1 になる（1 枚につき 1 回だけ）。
ALTER TABLE cards ADD COLUMN image_optimized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN image_optimized_at TEXT;
