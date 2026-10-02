# API 契約（画面 ↔ AWS 版 / Cloudflare 版）

画面（`web/`）は 1 つで、AWS 版と Cloudflare 版の両方のバックエンドで動く。両バックエンドはこの契約どおりに応答する。**契約を変えるときは、この文書を先に直す。**

## 1. 共通

| 項目 | 内容 |
| --- | --- |
| パス | すべて `/api/...`。画面と同じオリジン。CORS は使わない |
| 本文 | JSON（`Content-Type: application/json`）。ファイルの送信だけは本文そのもの |
| 日時 | ISO 8601（UTC、`2026-10-02T05:03:00.000Z`）。画面側で日本時間に直す |
| ID | 文字列。26 文字の ULID 相当（`01J...`）。桁数と文字種に意味は無い |
| 一覧 | `{ "items": [...], "nextCursor": "..." | null }`。`?cursor=` で続き、`?limit=`（既定 50、最大 200） |
| エラー | HTTP ステータス + `{ "error": { "code": "...", "message": "..." } }`。`message` は利用者に見せてよい日本語 |
| 認証 | AWS 版は `Authorization: Bearer <Cognito の ID トークン>`。Cloudflare 版は Cookie（`sid`）。画面は `/api/config` の `authMode` で切り替える |
| 権限 | サーバー側で判定。画面の出し分けは `/api/me` の `capabilities` を使う |

エラーの `code`:

| code | HTTP | 意味 |
| --- | --- | --- |
| `unauthorized` | 401 | ログインしていない、セッション切れ |
| `forbidden` | 403 | 権限が無い |
| `not_found` | 404 | 無い、または見える範囲の外 |
| `conflict` | 409 | ほかの人が先に更新した（`version` 不一致）、重複 |
| `validation` | 400 | 入力の誤り。`details: [{ field, message }]` を付ける |
| `rate_limited` | 429 | 1 日の上限、ログインの試行回数 |
| `provider_error` | 502 | Gemini / OpenAI 側の失敗 |
| `not_configured` | 503 | API キーやモデルが未設定 |

## 2. 設定と自分

### `GET /api/config`（認証不要）

```json
{
  "appName": "hyper-sfa",
  "edition": "aws" | "cloudflare",
  "authMode": "cognito-google" | "password",
  "cognito": { "domain": "https://xxx.auth.ap-northeast-1.amazoncognito.com", "clientId": "...", "redirectUri": "https://.../auth/callback" },
  "features": { "departments": true, "positions": true, "userImport": true, "minutes": true },
  "limits": { "scanPerDay": 200, "recordingMaxSec": 7200, "segmentSec": 600 },
  "setupRequired": false
}
```

- `cognito` は AWS 版だけ。
- `setupRequired` は Cloudflare 版で利用者が 0 人のとき `true`（最初の管理者を作る画面へ）。
- `features` が `false` の項目は、画面がメニューと欄を出さない。

### `GET /api/me`

```json
{
  "id": "...",
  "email": "taro@example.co.jp",
  "loginId": "taro",
  "displayName": "山田 太郎",
  "position": "MG",
  "level": "dev" | "org_admin" | "org_edit" | "dept_edit" | "dept_view",
  "deptIds": ["..."],
  "departments": [{ "id": "...", "name": "営業部" }],
  "mustChangePassword": false,
  "capabilities": {
    "seeAllCards": true, "editCards": true, "deleteAnyCard": false,
    "assignOtherDepts": true, "register": true,
    "admin": false, "dev": false, "viewHistory": false
  }
}
```

権限の段階と `capabilities` の対応は `docs/design.md` §9。Cloudflare 版は `admin` → `dev`（全部 `true`）、`member` → `org_edit`（`admin` `dev` `viewHistory` は `false`、`seeAllCards` `editCards` `register` は `true`、`assignOtherDepts` `deleteAnyCard` は `false`）。削除できるのは `admin` だけなので、`admin` の `deleteAnyCard` だけが `true`（cloudflare-small-design §4）。AWS 版も `dev` だけが `deleteAnyCard` が `true`（design §9）。

想定外のエラーは `500 { "error": { "code": "internal", "message": "..." } }`。`409` の `version` 不一致には `error.current`（最新の名刺）を付ける。

## 3. ログイン

### AWS 版（`authMode: cognito-google`）

画面が Cognito の `/oauth2/authorize` へ直接進む（`identity_provider=Google`、認可コード + PKCE）。戻り先 `/auth/callback` で画面が `/oauth2/token` からトークンを受け取り、ID トークンを `Authorization: Bearer` に付ける。更新はリフレッシュトークンで画面が行う。サーバーの API は無い。

拒否されたとき（未登録、組織外）は Cognito から `error_description` 付きで戻る。画面は「このアカウントは登録されていません。管理者に連絡してください。」を出す。

### Cloudflare 版（`authMode: password`）

| メソッドとパス | 本文 | 応答 |
| --- | --- | --- |
| `POST /api/auth/setup` | `{ loginId, password, displayName }` | 最初の管理者を作る。利用者が 1 人でもいれば 403 |
| `POST /api/auth/login` | `{ loginId, password }` | `Set-Cookie: sid=...` と `/api/me` と同じ内容。失敗は 401。ロック中は 429 |
| `POST /api/auth/logout` | なし | Cookie とセッションを消す |
| `POST /api/auth/logout-all` | なし | 自分のセッションを全部消す |
| `POST /api/auth/change-password` | `{ currentPassword, newPassword }` | 変更し、ほかのセッションを消す。`mustChangePassword` を `false` に |

## 4. 名刺

### 名刺の形

```json
{
  "id": "...", "status": "processing" | "review" | "failed" | "confirmed",
  "company": "株式会社アシスト", "department": "営業部", "title": "営業部長", "name": "山田 太郎", "nameReading": "やまだ たろう",
  "phones": ["03-1234-5678"], "mobiles": ["090-1234-5678"], "emails": ["taro@example.co.jp"],
  "note": "資格: 一級建築士", "rawText": "...",
  "deptIds": ["..."], "departments": [{ "id": "...", "name": "営業部" }],
  "imageUrls": { "thumb": "...", "front": "...", "back": null },
  "createdBy": { "id": "...", "name": "佐藤 花子" }, "createdAt": "...",
  "updatedBy": { "id": "...", "name": "鈴木 一郎" }, "updatedAt": "...",
  "editCount": 2, "scanCount": 1, "version": 3,
  "imageOptimized": false,
  "failure": { "kind": "parse" | "truncated" | "empty" | "blocked" | "provider" | "not_configured", "message": "...", "retryable": true } | null,
  "duplicates": [{ "id": "...", "company": "...", "name": "...", "reason": "email" | "company_name" }]
}
```

- `imageUrls` はそのまま `<img src>` と `<a href>` に使える URL。AWS 版は 15 分で切れる署名付き URL、Cloudflare 版は同一オリジンの `/api/...`。
- `rawText` は詳細（`GET /api/cards/{id}`）だけに入る。一覧には入れない。
- `duplicates` は `status` が `review` のときだけ。
- Cloudflare 版では `deptIds` と `departments` は空配列。

| メソッドとパス | 内容 |
| --- | --- |
| `POST /api/uploads` | 本文 `{ "kinds": ["front", "thumb", "back"] }`。応答 `{ "uploads": [{ "kind": "front", "key": "...", "url": "...", "method": "PUT", "headers": { "Content-Type": "image/jpeg" } }] }`。画面は `url` へ `PUT` する。有効期限 15 分 |
| `POST /api/cards/scan` | `{ "frontKey", "backKey"?, "thumbKey", "deptIds"? }` → `{ "id", "status": "processing" }` 202。`deptIds` を省くと自分の所属部署 |
| `GET /api/cards/{id}/status` | `{ "status", "card"?, "failure"? }`。`review` `confirmed` なら `card` 付き |
| `POST /api/cards/{id}/rescan` | 再生成。`{ "status": "processing" }` 202 |
| `GET /api/cards` | 検索。`company` `name` `department` `phone` `email` `note`（備考と役職の両方に当てる） `owner`（利用者 ID）`from` `to`（登録日、`YYYY-MM-DD`）`status` `dept`（担当部署 ID）`cursor` `limit`。応答 `{ "items", "nextCursor", "total" }`。`items` は `rawText` 抜き |
| `GET /api/cards/{id}` | 詳細 |
| `GET /api/companies` | 取引先（会社 → 部署 → 人）の集計。見える範囲の名刺（確認済みのみ、削除済みを除く）から作る。`q`（会社名の部分一致。表記ゆれは `companyKey` で吸収）`limit`（会社の数。既定 20、最大 100）。応答 `{ "items": [{ "company", "key", "count", "departments": [{ "name", "count", "people": [{ "id", "name", "title" }] }] }] }`。`company` は名刺に多く書かれている表記、`key` は `companyKey` の値。部署名が空の名刺は `name: ""` の部署にまとめる。会社は `count` の多い順、部署は名前順、人は名前順。会社名が空の名刺は含めない。**AWS 版は `title` を返さない**（検索用の索引 gsi1 が INCLUDE の上限 20 属性を使い切っていて役職を載せられないため。人は `{ id, name }`）。Cloudflare 版は `title` を返す |
| `PUT /api/cards/{id}` | `{ company, department, title, name, nameReading, phones, mobiles, emails, note, deptIds, version, source: "review" | "search" | "detail", confirm: true }`。`confirm: true` で `review` → `confirmed`。`version` 不一致は 409 |
| `DELETE /api/cards/{id}` | 論理削除。開発者（Cloudflare 版は `admin`）だけ。登録の途中（`status` が `confirmed` でない）の自分の下書きは本人も可。それ以外は 403 `forbidden` |
| `POST /api/cards/{id}/images/replace` | 画像を縮小して置き換えるための PUT 先。`{ "uploads": [{ "kind": "front" / "back", "url", "method": "PUT", "headers" }] }`。**既存のキーに上書きする。** 編集できる人だけ。15 分有効 |
| `POST /api/cards/{id}/images/optimized` | 縮小済みの印を付ける。`{ "imageOptimized": true, "imageOptimizedAt" }`。`version` は増えず、履歴にも残らない |

縮小の決まり: 長辺 900px、JPEG 品質 0.4、サムネイルはそのまま。1 枚につき 1 回（表と裏を終えてから印を付ける）。元の 0.9 倍未満に減らないときは上書きせず印だけ付ける。失敗したら黙って次に詳細画面を開いたときにやり直す。Cloudflare 版の `imageUrls` には `?v=` が付く（ブラウザのキャッシュ対策）。R2 は上書きで元の画像が即座に無くなる。S3 はバージョニングで上書き前の版が 30 日残る。
| `GET /api/cards/{id}/minutes` | その人との議事録（見える範囲）。議事録の一覧と同じ形 |
| `GET /api/departments` | `{ "items": [{ "id", "name", "order", "active" }] }`。Cloudflare 版は空 |
| `GET /api/directory` | `{ "items": [{ "id", "displayName", "email", "departments": [...] }] }`。共有や同席者の選択用。無効の人は除く |

検索の条件は AND。1 つの欄の空白区切りも AND。部分一致で表記ゆれを吸収する（`docs/design.md` §3.1）。`deptIds` は Cloudflare 版では無視する。

## 5. 管理コンソール（`capabilities.admin`）

| メソッドとパス | 内容 |
| --- | --- |
| `GET /api/admin/users` | `{ "items": [{ "id", "email", "loginId", "displayName", "position", "role", "deptIds", "departments", "status": "invited" | "active" | "disabled", "lastLoginAt" }] }` |
| `POST /api/admin/users` | AWS 版 `{ email, displayName?, position, deptIds, newDepartments?: ["企画部"] }`。Cloudflare 版 `{ loginId, displayName, role: "admin" | "member" }` → 応答に `tempPassword`（1 回だけ表示） |
| `PATCH /api/admin/users/{id}` | `{ position?, role?, deptIds?, status?: "active" | "disabled", displayName? }` |
| `POST /api/admin/users/{id}/temp-password` | Cloudflare 版だけ。`{ "tempPassword": "..." }`。その人のセッションを消す |
| `POST /api/admin/users/import/preview` | `{ "rows": [{ "department": "営業部;開発部", "email": "...", "position": "MG", "displayName"?: "..." }] }`（画面が CSV を読んで行にする。文字コードの判定は画面側）。応答 `{ "create": [...], "update": [{ before, after }], "unchanged": [...], "errors": [{ "row": 38, "email", "message" }], "newDepartments": [{ "name", "count", "similarTo"? }] }` |
| `POST /api/admin/users/import` | 同じ本文 + `{ "skipErrors": true }`。サーバーで再検証して実行。応答 `{ "created", "updated", "departmentsCreated" }` |
| `GET /api/admin/departments` `POST` `PATCH /{id}` | `{ name, order, active }` |
| `GET /api/admin/history` | `type`（`create` `edit` `rescan` `delete` `restore`）`from` `to` `actor` `dept` `cursor`。`{ "items": [{ "id", "type", "at", "actor": { id, name, deptName }, "source", "card": { id, company, name }, "changes": [{ "field", "before", "after" }] }] }` |
| `GET /api/admin/history/summary` | `from` `to`（年月）。`{ "byUser": [{ "id", "name", "deptName", "count" }], "byDept": [{ "id", "name", "count" }] }` |
| `GET /api/admin/cards/{id}/history` | 1 枚の履歴 |

Cloudflare 版は `departments`、`history/summary` の部署別、`import` を持たない（`features` で画面が隠す）。

## 6. 開発コンソール（`capabilities.dev`）

| メソッドとパス | 内容 |
| --- | --- |
| `GET /api/dev/settings` | `{ "keys": { "gemini": { "configured": true, "last4": "ab12", "updatedAt", "updatedBy" }, "openai": {...} }, "models": { "card": "gemini-3.5-flash-lite", "transcribe": "...", "summarize": "..." }, "prompts": { "card": { "version": 3 }, "transcribe": {...}, "summarize": {...} } }` |
| `PUT /api/dev/keys/{provider}` | `{ "key": "..." }`。`provider` は `gemini` / `openai`。応答は `settings` と同じ。キーは応答にもログにも出さない |
| `POST /api/dev/keys/{provider}/test` | `{ "ok": true, "models": 12 }` または `provider_error` |
| `GET /api/dev/models` | `{ "items": [{ "id", "provider", "label", "uses": ["card", "transcribe", "summarize"], "pricing": { "input", "output", "audioInput"?, "perMinute"?, "changesAt"?, "next"? }, "thinkingLevel", "reasoningEffort", "maxAudioMinutes", "shutdownAt", "active", "builtin" }] }`。`thinkingLevel` は Gemini、`reasoningEffort` は OpenAI の考える量。`reasoningEffort` は `none` / `minimal` / `low` / `medium` / `high` か `null`（`null` は API に渡さず、モデルの既定に任せる）。それ以外は `validation` |
| `POST /api/dev/models` | 追加（同じ形）。`PATCH /api/dev/models/{id}` で変更・有効 / 無効 |
| `GET /api/dev/models/available?provider=gemini` | 登録済みのキーで使えるモデル ID の一覧 `{ "items": ["gemini-3.8-flash", ...] }` |
| `PUT /api/dev/model` | `{ "use": "card" | "transcribe" | "summarize", "modelId" }` |
| `GET /api/dev/prompts/{kind}` | `{ "kind", "text", "version", "savedBy", "savedAt", "isDefault" }`。`kind` は `card` / `transcribe` / `summarize` |
| `PUT /api/dev/prompts/{kind}` | `{ "text" }`。空文字で初期値に戻す。応答は GET と同じ |
| `GET /api/dev/prompts/{kind}/history` | `{ "items": [{ "version", "savedBy", "savedAt", "text" }] }` |
| `POST /api/dev/prompts/{kind}/revert` | `{ "version" }` |
| `POST /api/dev/scan-test` | `{ "frontKey", "backKey"?, "promptText"?, "modelId"? }` → `{ "card", "raw", "repairs", "usage": { inputTokens, outputTokens }, "elapsedMs" }`。同期。AWS 版は最長 29 秒 |
| `POST /api/dev/minutes-test` | `{ "kind": "transcribe", "audioKey", "promptText"?, "modelId"? }` または `{ "kind": "summarize", "transcript", "promptText"?, "modelId"? }` → `{ "text", "usage", "elapsedMs" }`。時間がかかるので 202 + `{ "jobId" }` を返し、`GET /api/dev/minutes-test/{jobId}` で結果 |
| `POST /api/dev/export` | `{ "kind": "cards" | "history" | "minutes-usage", "filters": {...} }` → `{ "url", "expiresAt", "rows" }`。`url` は 5 分有効 |
| `GET /api/dev/usage` | `from` `to`（`YYYY-MM`）。`{ "months": [{ "month", "byUse": { "card": { count, failed, inputTokens, outputTokens, cost }, "transcribe": {...}, "summarize": {...} }, "byModel": [...] }] }` |
| `GET /api/dev/usage/minutes` | `from` `to` `dept` `includeUnused`。`{ "items": [{ "user": { id, name, departments, status }, "recordings", "recordedSec", "transcribe": { first, retry }, "summarize": { first, retry }, "failed", "transcribedSec", "inputTokens", "outputTokens", "cost", "lastUsedAt" }], "total": {...} }` |
| `GET /api/dev/usage/minutes/{userId}` | `{ "months": [...], "events": [{ "at", "kind", "durationSec", "modelId", "ok", "failureKind", "inputTokens", "outputTokens", "cost" }] }` |
| `GET /api/dev/audit` | `from` `to` `cursor`。`{ "items": [{ "at", "actor", "action", "detail" }] }` |
| `GET /api/dev/positions` `PUT` | AWS 版だけ。`{ "items": [{ "name": "MG", "level": "org_edit", "order": 4 }] }`。開発コンソールの「役職と権限」。全体置き換え |

## 7. 議事録

### 議事録の形

```json
{
  "id": "...", "title": "株式会社アシスト 定例", "heldAt": "...", "mode": "web" | "room" | "upload",
  "durationSec": 4320, "memo": "...",
  "status": "recording" | "uploaded" | "queued" | "transcribing" | "summarizing" | "done" | "failed",
  "progress": { "segmentsDone": 3, "segmentsTotal": 12 },
  "failure": { "step": "transcribe" | "summarize", "kind": "...", "message": "...", "retryable": true } | null,
  "owner": { "id", "name" }, "relation": "owner" | "shared",
  "counterparts": [{ "cardId": "..." | null, "company", "department", "name", "cardVisible": true }],
  "attendees": [{ "id", "name" }],
  "shares": [{ "id", "name", "sharedAt" }],
  "audio": { "available": true, "expiresAt": "...", "deleted": false },
  "transcript": { "version": 2, "createdAt", "modelId", "hasPrevious": true } | null,
  "summary": { "version": 3, "createdAt", "modelId", "hasPrevious": true } | null,
  "createdAt": "...", "updatedAt": "..."
}
```

`shares` は `relation` が `owner` のときだけ。

| メソッドとパス | 内容 |
| --- | --- |
| `POST /api/minutes` | `{ "mode", "title"?, "segmentSec"? }` → `{ "id", "segmentSec": 600, "audioMime": "audio/webm" }`。`mode` は `web` `room` `upload`（`upload` のとき `audioMime` は `null`）。`segmentSec` はサーバーが選択中のモデルに合わせて返す |
| `POST /api/minutes/{id}/segments` | `{ "seq": 1, "mime": "audio/webm", "startSec": 0, "durationSec": 600, "size": 2400000 }` → `{ "key", "url", "method": "PUT", "headers" }`。画面は `url` へ PUT し、続けて `PUT /api/minutes/{id}/segments/{seq}/done` を呼ぶ |
| `POST /api/minutes/{id}/full-audio` | Cloudflare 版だけ。通しの 1 本のアップロード先。本文 `{ "mime", "durationSec", "size" }`。応答は segments と同じ。画面は `/finish` の後に送る |
| `POST /api/minutes/{id}/upload` | `mode: upload` だけ。音声ファイル 1 本のアップロード先。本文 `{ "mime", "durationSec", "size", "filename" }`（`mime` は `audio/mp4` `audio/mpeg` `audio/wav` `audio/x-wav` `audio/webm` `audio/ogg` `audio/aac` `audio/x-m4a` `video/mp4` `video/webm`、`size` は 600MB まで、`durationSec` は 7,200 まで。長さが読めなかった画面は 0 を送り、サーバーは大きさから概算する）→ `{ "key", "url", "method": "PUT", "headers" }`。1 つの区切り（`seq: 1`）として登録される（`mode` が `upload` でない、または `status` が `recording` でないと 409 `conflict`、再度呼ぶと `seq: 1` を上書きする）。`url` の有効期限は 1 時間。**Cloudflare 版は `size` が 100MB まで、`durationSec` が 3,600 まで**で、`url` は Worker の `PUT /api/minutes/{id}/upload/put`（本文をそのまま R2 へ）。画面は `url` へ PUT し、`PUT /api/minutes/{id}/segments/1/done` → `POST /api/minutes/{id}/finish`（`segments: 1`）の順に呼ぶ（`finish` の `durationSec` は 0 でもよく、サーバーは区切りの長さを使う）。以後は録音と同じ |
| `POST /api/minutes/{id}/finish` | `{ "durationSec", "segments": 12 }`。`recording` → `uploaded` |
| `PUT /api/minutes/{id}` | `{ title, memo, counterparts: [{ cardId?, company?, name?, department? }], attendeeIds }`。作った人だけ |
| `POST /api/minutes/{id}/generate` | 作成を始める。失敗した所からのやり直しも同じ。202 |
| `POST /api/minutes/{id}/regenerate` | `{ "target": "summary" | "transcript" }`。`transcript` は音声が残っている間だけ。202 |
| `POST /api/minutes/{id}/revert` | `{ "target": "summary" | "transcript" }`。前の版に戻す |
| `GET /api/minutes` | `relation`（`owner` `shared` `all`）`company` `department`（相手の部署名の部分一致。名刺から選んだ相手も手入力の相手も対象）`name` `cardId` `attendee` `from` `to` `title` `owner` `cursor` |
| `GET /api/minutes/{id}` | 上の形 |
| `GET /api/minutes/{id}/transcript` | `{ "text", "version" }` |
| `GET /api/minutes/{id}/summary` | `{ "markdown", "version" }` |
| `GET /api/minutes/{id}/audio-url` | `{ "url", "expiresAt", "filename": "2026-10-02_株式会社アシスト定例.m4a" }`。7 日を過ぎたら 404 `{ code: "not_found", message: "音声は削除されました" }` |
| `GET /api/minutes/{id}/shares` `POST` `DELETE /{userId}` | `GET` は `{ "items": [{ "id", "name", "sharedAt" }] }`。`POST` は `{ "userIds": [...] }` |
| `DELETE /api/minutes/{id}` | 削除 |

`audio-url` の `url` は `<audio src>` と `<a download>` の両方に使える。

### 資料（minutes-design.md §15）

議事録の形に `"materials": [{ "id", "seq", "name", "kind": "pdf" | "pptx" | "xlsx", "size", "pages", "outlineStatus": "pending" | "done" | "failed" | "none", "uploadedBy": { "id", "name" }, "uploadedAt" }]` を足す。`summary` に `"withMaterials": false, "materialIds": []` を足す。

| メソッドとパス | 内容 |
| --- | --- |
| `GET /api/minutes/{id}/materials` | `{ "items": [...] }` |
| `POST /api/minutes/{id}/materials` | `{ "name", "kind", "size", "hasExtract": true }` → `{ "id", "seq", "file": { "url", "method": "PUT", "headers" }, "extract": { "url", "method": "PUT", "headers" } または null }`。作った人だけ。6 件目や 20MB 超は `validation`。`kind` は拡張子から画面が決める |
| `PUT /api/minutes/{id}/materials/{matId}/done` | `{ "pages"?, "extracted": true または false }`。送り終えた印。PDF は `outlineStatus: pending`、pptx / xlsx は `none`（目次は機械的に作るため） |
| `DELETE /api/minutes/{id}/materials/{matId}` | 作った人だけ。ファイルと抜いた JSON と目次を消す |
| `GET /api/minutes/{id}/materials/{matId}/url` | `{ "url", "expiresAt", "filename" }`。見られる人。元のファイルを開く / ダウンロードする |
| `POST /api/minutes/{id}/regenerate` | `{ "target": "summary", "withMaterials": true }` を足す。資料が 0 件なら `validation` |
| `GET /api/minutes/{id}/summary` | `{ "markdown", "version", "withMaterials", "mapping": [{ "material", "materialName", "page", "start", "end", "confidence" }] }`。`mapping` は資料を踏まえた版だけ |
| `GET /api/dev/prompts/{kind}` ほか | `kind` に `outline` と `summarize_materials` を足す |

抜いた JSON（`extract`）の形は minutes-design.md §15.3、目次の形は §15.4、対応表と議事録の JSON は §15.5。

### 質問（minutes-design.md §16）

議事録を見られる人が使える。スレッドは利用者ごと。

| メソッドとパス | 内容 |
| --- | --- |
| `GET /api/minutes/{id}/chat` | 自分のスレッド。`{ "items": [{ "seq", "role": "user" | "assistant", "text", "modelId", "createdAt" }], "modelLabel": "Gemini 3.6 Flash", "available": true }`。`available` は文字起こしがあるとき `true` |
| `POST /api/minutes/{id}/chat` | `{ "text" }`（2,000 字まで）→ `{ "question": { "seq", "role": "user", ... }, "answer": { "seq", "role": "assistant", "text", "modelId", "createdAt" }, "usage": { "inputTokens", "outputTokens" } }`。同期。文字起こしが無ければ `validation`。1 日 200 回を超えたら `rate_limited`。モデル側の失敗は `provider_error` |
| `DELETE /api/minutes/{id}/chat` | 自分のスレッドを消す |
| `PUT /api/dev/model` | `use` に `qa` を足す |
| `GET /api/dev/prompts/{kind}` ほか | `kind` に `qa` を足す |
| `GET /api/dev/usage/minutes` | 各行に `"qa": { "count" }` を足す |

## 8. 画面の状態確認

| 画面 | 方法 |
| --- | --- |
| 名刺の読み取り中 | `GET /api/cards/{id}/status` を 1.5 秒おき。60 秒で「時間がかかっています」、120 秒で失敗扱い |
| 議事録の作成中 | `GET /api/minutes/{id}` を 3 秒おき。20 分で失敗扱い |

## 9. 上限

| 項目 | 値 |
| --- | --- |
| 1 人の読み取り（再生成を含む） | 1 日 200 回。超えたら `rate_limited` |
| 画像 | 1 枚 5MB まで。JPEG |
| 録音 | 最長 7,200 秒。区切りは 1 つ 10MB まで |
| 議事録の共有 | 1 回 50 人まで |
| CSV の取り込み | 1 回 1,000 行まで |
