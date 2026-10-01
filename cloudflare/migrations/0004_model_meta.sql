-- モデルの説明の項目（価格帯、安定版かプレビューか、1 行の補足）。画面の一覧でバッジと補足を出すために使う。
ALTER TABLE models ADD COLUMN tier TEXT;
ALTER TABLE models ADD COLUMN status TEXT;
ALTER TABLE models ADD COLUMN note TEXT;
