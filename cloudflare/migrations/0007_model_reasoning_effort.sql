-- OpenAI の文章モデルの reasoning effort（none / minimal / low / medium / high）。NULL ならモデルの既定に任せ、API に渡さない。
ALTER TABLE models ADD COLUMN reasoning_effort TEXT;
