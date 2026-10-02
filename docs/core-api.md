# `packages/core` の公開関数

両バックエンド（Node.js の Lambda、Cloudflare Worker）と画面（ブラウザ）で同じコードを使う。**依存パッケージ無し。`fetch` と Web 標準（`TextEncoder`、`crypto.subtle`）以外に依存しない。** `node:` の API も使わない（ブラウザと Worker で動かないため）。

`import { ... } from '@hyper-sfa/core'`（`packages/core/src/index.js` が全部を再エクスポートする）。

## 1. JSON の取り出し `json.js`

```js
extractJson(text) // → { value: object, repairs: string[], truncated: boolean }
```

`docs/design.md` §5.6 の 5 段階。取り出せなければ `JsonExtractError`（`code: 'parse'`）を投げる。`repairs` は効いた手当ての名前（`'fence'` `'slice'` `'comments'` `'trailing_comma'` `'fullwidth'` `'quotes'` `'newline'` `'truncated'`）。`truncated` は 5 段階目で閉じた場合に `true`。

```js
normalizeCard(value) // → { company, department, title, name, nameReading, phones, mobiles, emails, note, rawText, coerced: string[] }
```

キーの別名（`email` `mail` `tel` `phone` `mobile` `会社名` `氏名` など）を正しいキーに読み替え、文字列 ↔ 配列のずれを直し、外側の `result` や配列を剥がし、知らないキーを捨てる。`coerced` は直した内容の名前。すべて空なら `isEmptyCard(card)` が `true`。

```js
CARD_RESPONSE_SCHEMA // Gemini の構造化出力に渡す JSON スキーマ（docs/design.md §5.3）
```

## 2. 検索キー `search.js`

```js
normalizeText(s)      // NFKC、小文字、カタカナ → ひらがな、空白の統一
phoneDigits(s)        // '+81 3-1234-5678' → '0312345678'
searchKeys(card)      // → { companyN, nameN, readingN, departmentN, phonesDigits: string[], emailsN: string[], titleN, noteN }
parseQuery(params)    // { company, name, department, phone, email, note } → 各欄を空白で分けた語の配列
matchCard(keys, query) // すべての条件を満たすか（AND）。部分一致。`note` の語は noteN と titleN の両方に当てる（役職でも探せる）
```

## 3. プロンプト `prompts.js`

```js
DEFAULT_PROMPTS // { card, transcribe, summarize }（設計書の初期値そのまま）
PLACEHOLDERS    // { transcribe: ['TITLE','DATE','COUNTERPARTS','ATTENDEES','MEMO'], summarize: [..., 'TRANSCRIPT'] }
renderPrompt(template, vars) // {{KEY}} を差し込む。無いキーは空文字。summarize に {{TRANSCRIPT}} が無ければ末尾に「# 文字起こし」として足す
```

## 4. モデル一覧 `models.js`

```js
DEFAULT_MODELS // 設計書の初期一覧。[{ id, provider: 'gemini'|'openai', label, uses: [...], pricing, thinkingLevel, reasoningEffort?, maxAudioMinutes, shutdownAt, builtin: true }]。`reasoningEffort` は OpenAI の文章モデルだけ（初期値 `'medium'`）
DEFAULT_SELECTION // { card: 'gemini-3.5-flash-lite', transcribe: 'gemini-3.5-flash-lite', summarize: 'gemini-3.6-flash' }
priceAt(model, date)   // changesAt を考慮した { input, output, audioInput, perMinute }
estimateCost({ model, inputTokens, outputTokens, audioSeconds, date }) // USD
```

`pricing`: `{ input, output, audioInput?, perMinute?, changesAt?: '2027-01-01', next?: { input, output } }`。単価は 100 万トークンあたり USD。

## 5. Gemini `gemini.js`

```js
buildGenerateRequest({ model, apiKey, prompt, parts, schema, thinkingLevel, maxOutputTokens, mediaResolution })
// → { url, method: 'POST', headers, body: string }
// parts: [{ inlineData: { mimeType, data(base64) } } | { fileData: { mimeType, fileUri } }]
parseGenerateResponse(json) // → { text, finishReason, blocked: boolean, usage: { inputTokens, outputTokens, thoughtTokens } }
buildFilesUploadRequest({ apiKey, mimeType, displayName, sizeBytes }) // Files API の再開可能アップロードの開始リクエスト
buildListModelsRequest({ apiKey })
parseListModels(json) // → ['gemini-3.8-flash', ...]（generateContent 対応のものだけ）
classifyGeminiError({ status, json }) // → { kind: 'not_configured'|'provider'|'blocked'|'rate_limited', retryable, message }
```

`finishReason` が `MAX_TOKENS` なら呼び出し側は `truncated` として扱う。

## 6. OpenAI `openai.js`

```js
buildTranscriptionRequest({ model, apiKey, audio: Blob|ArrayBuffer, mimeType, prompt, language: 'ja' }) // multipart。→ { url, method, headers, body: FormData }
parseTranscriptionResponse(json) // → { text, usage? }
buildChatRequest({ model, apiKey, system, user, maxOutputTokens, reasoningEffort }) // /v1/chat/completions。reasoningEffort が空（null / undefined）なら reasoning_effort を body に載せない
parseChatResponse(json) // → { text, finishReason, usage }
buildListModelsRequest({ apiKey })
parseListModels(json)
classifyOpenAIError({ status, json })
```

## 7. 文字起こしの結合 `transcript.js`

```js
offsetTimestamps(text, offsetSec) // '[03:15] 話者A: …' → '[00:13:15] 話者A: …'
joinSegments([{ startSec, text }])  // 区切りごとの結果を通しの文字起こしにする
```

## 8. CSV `csv.js`

```js
buildCsv(rows, columns) // → string（BOM 付き UTF-8、CRLF）。columns: [{ key, label, type? }]
```

**数式として実行されないための決め:** `=` `+` `-` `@` `\t` `\r` で始まる値は、先頭に `'` を付ける。ただし電話番号（`+81` など）は `'` が付くと見た目が悪いので、**`type: 'phone'` の列だけは `="+81..."`（文字列を返す数式）の形にする。** どちらも Excel で数式として実行されない。配列の値（電話番号、メールアドレス）は `;` でつなぐ。

```js
parseCsv(text) // → string[][]。カンマとタブを自動判定。引用符、引用符内の改行に対応
detectAndDecode(arrayBuffer) // UTF-8（BOM の有無）と Shift_JIS を判定して文字列に（TextDecoder('shift_jis')）
CARD_CSV_COLUMNS（部署名の次に役職）, HISTORY_CSV_COLUMNS, MINUTES_USAGE_CSV_COLUMNS
cardToCsvRow(card), historyToCsvRows(event)
```

## 9. ユーザーの一括登録 `userImport.js`

```js
parseUserRows(rows)  // string[][] → [{ department, email, position, displayName, row }]。1 行目が見出しなら飛ばす。部署は ';' で分割
planUserImport({ rows, existingUsers, departments, positions, companyDomain, actorIsDev })
// → { create, update: [{ before, after }], unchanged, errors: [{ row, email, message }], newDepartments: [{ name, count, similarTo }] }
```

正規化: 前後の空白、全角 / 半角、大文字 / 小文字。役職は `positions` の名前と照合（`submg` = `SubMG`）。似た部署名は `normalizeText` が一致するもの。

## 10. 権限 `permissions.js`

```js
LEVELS // ['dev', 'org_admin', 'org_edit', 'dept_edit', 'dept_view']
DEFAULT_POSITIONS // [{ name: '開発者', level: 'dev' }, { name: '役員', level: 'org_admin' }, ... 'MG': 'org_edit', 'EX': 'dept_edit', '社員B': 'dept_view' ...]
levelFor(position, positions)
capabilitiesFor(level) // docs/api-contract.md §2 の capabilities
canSeeCard(user, card)  // 担当部署の重なり、または seeAllCards
canEditCard(user, card), canDeleteCard(user, card)
```

## 11. 利用量 `usage.js`

```js
monthKey(date) // '2026-10'
usageEvent({ kind, userId, modelId, inputTokens, outputTokens, audioSeconds, ok, failureKind, at }) // 記録の正規形
```

## 12. その他 `util.js`

```js
ulid()              // crypto.getRandomValues を使う。時刻順に並ぶ
sha256Hex(string)   // crypto.subtle
isValidEmail(s)
truncate(s, max)
```

## テスト

`packages/core/test/*.test.js`、`node --test`（引数なし。Node 24 では `node --test test/` が使えない）。特に `extractJson` は崩れた応答の見本（`test/fixtures/gemini-*.txt`）を 10 種類以上そろえる。

## 13. 資料（`materials.js`）— 2026-10-01 追加

```js
MATERIAL_LIMITS            // { maxFiles: 5, maxBytes: 20 * 1024 * 1024, maxExtractBytes: 2 * 1024 * 1024, kinds: ['pdf', 'pptx', 'xlsx'] }
materialKindOf(filename)   // 拡張子 → 'pdf' | 'pptx' | 'xlsx' | null
OUTLINE_SCHEMA             // 目次の JSON スキーマ（minutes-design.md §15.4）。type は小文字で書く。Gemini に渡すときは gemini.js 側で大文字にする
MATERIAL_SUMMARY_SCHEMA    // { mapping: [...], markdown } のスキーマ（§15.5）
outlineFromExtract(extract, { name })  // pptx / xlsx の抜いた JSON → 目次（モデルを使わない）。グラフは「系列 × 項目 = 値」の表の文字列にして figures に入れる
formatMaterialsForPrompt([{ seq, name, kind, outline }]) // {{MATERIALS}} に差し込む文字列。「資料 1: 提案書_v3.pdf」「  ページ 7「地域別売上」 … figures …」の形。1 資料 3 万字で切る
normalizeMapping(mapping, materials) // モデルの出力を整える（page を整数に、時刻を HH:MM:SS に、confidence を high/medium/low に、無い資料番号は捨てる）
```

`prompts.js` に `DEFAULT_PROMPTS.outline` と `DEFAULT_PROMPTS.summarize_materials` を足す（文面は minutes-design.md §15.4 / §15.5 の方針で書く）。`PLACEHOLDERS.summarize_materials = ['TITLE', 'DATE', 'COUNTERPARTS', 'ATTENDEES', 'MEMO', 'MATERIALS', 'TRANSCRIPT']`。`PLACEHOLDERS.outline = ['NAME', 'KIND']`。

## 14. OpenAI の追加（`openai.js`）

```js
buildOpenAIFileUploadRequest({ apiKey, filename, contentType, purpose = 'user_data' })
// /v1/files の multipart。本文は呼び出し側が作る（Worker ではストリームで組み立てるため）。
// → { url, method, headers（Authorization と Content-Type（boundary 込み））, boundary, prefix: Uint8Array, suffix: Uint8Array }
//   本文 = prefix + ファイルのバイト列 + suffix
parseOpenAIFileResponse(json)  // → { id, bytes }
buildOpenAIFileDeleteRequest({ apiKey, fileId })
buildResponsesRequest({ model, apiKey, instructions, parts, jsonSchema, schemaName, maxOutputTokens, reasoningEffort })
// reasoningEffort が空（null / undefined）なら reasoning を body に載せない。
// /v1/responses。parts: [{ type: 'input_text', text } | { type: 'input_file', fileId }]。
// jsonSchema があれば text.format = { type: 'json_schema', name: schemaName, schema: jsonSchema, strict: false }
parseResponsesResponse(json)   // → { text（output_text を連結）, finishReason（status と incomplete_details.reason）, usage: { inputTokens, outputTokens } }
```

Gemini は既存の `buildGenerateRequest` に `parts: [{ fileData: { mimeType: 'application/pdf', fileUri } }]` と `schema` を渡せば足りる。

## 15. 質問（`qa`）— 2026-10-01 追加

- `DEFAULT_PROMPTS.qa`、`PLACEHOLDERS.qa = ['TITLE', 'DATE', 'COUNTERPARTS', 'ATTENDEES', 'MEMO', 'MATERIALS', 'TRANSCRIPT']`（minutes-design.md §16.1 の「答え方」をプロンプトに書く）。
- `DEFAULT_SELECTION.qa`（初期値は `summarize` と同じ）。文章モデルの `uses` に `'qa'` を足す（Gemini の Flash / Pro、OpenAI の文章モデル。文字起こし専用のモデルには足さない）。
- `gemini.js`: `buildChatGenerateRequest({ model, apiKey, systemText, turns: [{ role: 'user' | 'assistant', text }], thinkingLevel, maxOutputTokens })` → `systemInstruction` と `contents`（`role` は `user` / `model`）。応答は既存の `parseGenerateResponse`。
- `openai.js`: `buildResponsesRequest` に `turns`（`[{ role, text }]`）を渡せるようにする（`input` が `[{ role: 'user' | 'assistant', content: [{ type: 'input_text' | 'output_text', text }] }]` の列になる）。
- `qa.js`: `buildQaContext({ transcript, materials, minute })` → `{ TITLE, DATE, COUNTERPARTS, ATTENDEES, MEMO, MATERIALS, TRANSCRIPT }`（`formatMaterialsForPrompt` を使う）。`trimTurns(turns, max = 20)`。

## 16. `company.js` — 取引先の表記ゆれと集計

| 関数 | 内容 |
| --- | --- |
| `companyKey(name)` | 会社名を突き合わせ用に正規化する。NFKC → 小文字 → 空白と記号を除く → 法人格（株式会社、(株)、㈱、有限会社、合同会社、一般社団法人 など）と前後の「・」を除く。空文字なら `''` |
| `similarCompanies(name, companies, { limit = 5 } = {})` | `companies` は `[{ company, key, ... }]`。`name` の `companyKey` と、完全一致 → 片方がもう片方を含む → バイグラムの Dice 係数 0.6 以上、の順で近いものを返す。`name` と表記まで同じものは除く（「似ている別表記」を出すため） |
| `groupByCompany(cards, { q, limit })` | 名刺の配列（`company` `department` `name` `title` `id` `status` `deletedAt`）を `GET /api/companies` の応答の形にまとめる。両バックエンドと mock が同じ関数を使う。AWS 版は応答から `title` を削って返す（api-contract.md） |

`companyKey` は `search.js` の `normalizeText` を元にする。検索の `companyN` とは別物で、こちらは法人格を落とす（「株式会社アシスト」と「アシスト（株）」を同じ取引先と見なすため）。
