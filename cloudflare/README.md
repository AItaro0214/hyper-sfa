# hyper-sfa Cloudflare 版

Worker 1 本（Hono）+ D1 + R2 + Workflows。1〜5 名向け。設計は [`docs/cloudflare-small-design.md`](../docs/cloudflare-small-design.md)、API は [`docs/api-contract.md`](../docs/api-contract.md)。

```text
cloudflare/
  wrangler.toml          Worker、D1、R2 ×3、Workflows ×2、静的アセット
  migrations/            D1 のスキーマ（0001_init.sql）
  scripts/               prepare-assets.mjs（画面と core を .assets/ にまとめる）、reset-password.mjs
  worker/src/
    index.js             エントリ（ミドルウェア: Origin → セッション → 認証 → 管理者）
    core.js              @hyper-sfa/core の取り込み口
    routes/              auth / cards（+ 画像アップロード）/ admin / dev / misc
    lib/                 crypto, session, search, settings, usage, gemini-run ...
    workflows/cards.js   名刺の読み取り Workflow（card-scan）
    minutes/, workflows/minutes.js   議事録（別担当）
  test/                  node --test（D1 と Worker の環境を使わない純粋な関数）
```

## ローカルで動かす

```bash
# 1. 依存はリポジトリのルートでまとめて入れる（cloudflare/ の中では入れない）
npm install

cd cloudflare

# 2. Secret（ローカル用）。.dev.vars は .gitignore 済み
cp .dev.vars.example .dev.vars      # 中身を長いランダムな文字列に書き換える

# 3. D1 のスキーマを作る（初回と、migrations/ を足したとき）
npx wrangler d1 migrations apply hyper-sfa --local

# 4. 起動（web/ と packages/core/src を .assets/ にコピーしてから wrangler dev）
npm run dev
```

- `http://localhost:8787` を開くと、利用者が 0 人なので「最初の管理者を作る」画面になる（`POST /api/auth/setup`）。
- ローカルでは Cookie の `Secure` を外している（`http://localhost` で保存されるように）。
- Gemini の API キーが無い間は、名刺の読み取りは「設定に問題があります」で失敗する。手入力で試せる。キーは「設定」画面から入れる。
- `web/` や `packages/core/src` を直したら、`npm run prepare-assets` で `.assets/` を作り直す（`npm run dev` は起動のたびに行う）。
- テスト: `npm test`（`node --test test/*.test.js`）。実 API と wrangler は使わない。

## Cloudflare に出す手順（**今はしない**）

デプロイは設計の確認と実機テストが済んでから。手順だけ書いておく。

1. `npx wrangler d1 create hyper-sfa` … 出力の `database_id` を `wrangler.toml` の `PLACEHOLDER_D1_DATABASE_ID` に貼る。
2. R2 を 3 つ作る: `npx wrangler r2 bucket create hyper-sfa-images` / `hyper-sfa-audio` / `hyper-sfa-data`。
   - 音声は 7 日で消す: `hyper-sfa-audio` にライフサイクルを付ける（`wrangler r2 bucket lifecycle add`）。
   - CSV は `hyper-sfa-data` の `exports/` を 1 日で消す。
3. `npx wrangler d1 migrations apply hyper-sfa --remote`
4. Secret を 2 つ入れる: `npx wrangler secret put AUTH_PEPPER` / `npx wrangler secret put KEY_ENCRYPTION_KEY`。
   **どちらも後から変えられない**（変えると全員のパスワードが通らなくなる / 保存済みの API キーが読めなくなる）。控えを安全な場所に残す。
5. `npm run deploy`（画面のコピーを作ってから `wrangler deploy`）。
6. 開いてすぐ、画面の「最初の管理者を作る」で管理者を作る。**配備から作るまでの間は、誰でも最初の管理者になれる**ので、続けて行う。
7. 「設定」画面で Gemini の API キーを入れ、接続テストを押す。

`PBKDF2_ITERATIONS`（既定 3 万回）は、実機で CPU 10 ミリ秒に収まるかを測って決める（設計書 §12）。

## 最初の管理者と、パスワードを忘れたとき

- 最初の管理者は、利用者が 0 人のときの `setup` 画面で作る。以後この画面は出ない（`POST /api/auth/setup` は 403）。
- メンバーが忘れたら、管理者が「設定」画面から仮パスワードを再発行する（その人のセッションは消える）。
- 管理者自身が忘れたら:

  ```bash
  AUTH_PEPPER=<本番と同じ値> node scripts/reset-password.mjs <ログインID>
  # 表示された SQL を実行
  npx wrangler d1 execute hyper-sfa --remote --command "<表示された SQL>"
  ```

## 覚えておくこと

- **画像と音声は Worker の中で読まない**（CPU 10 ミリ秒のため）。アップロードは本文をそのまま R2 へ、表示は R2 の本文をそのまま返す。
- 名刺の読み取りは Workflows（`card-scan`）。Gemini の Files API に R2 から直接流し、終わったら消す。
- `/api/*` は `run_worker_first` で必ず Worker に渡している（画像や CSV への「ページ移動」が SPA の index.html にならないように）。
- 期限切れのセッション、古い試行の記録、削除から 30 日の名刺は、ログインのたびに掃除する（Cron は使わない）。

## ローカルで確かめたこと（2026-09-30）

`wrangler dev --local` で、初期設定 → ログイン → 画像のアップロード → 読み取り（API キー未登録なので `not_configured` で失敗）→ 手入力で確定 → 検索（ひらがな・カタカナ・半角カナ・`+81`・空白の揺れ）→ 画像の配信 → ユーザーの追加 → 開発コンソール（設定、モデル、プロンプト、CSV 出力、利用状況）→ 議事録（作成、区切りの送信、finish、generate → `not_configured` で失敗、一覧）が通った。

- Workflow を起動した直後に、ログに `The Workers runtime canceled this request because it detected that your Worker's code had hung` が出ることがある。Workflow 自体は最後まで進み、結果も D1 に書かれている。ローカルの Workflows の模擬に由来するものと見ているが、本番で出ないことは未確認。
- `curl` で日本語を送るときは、シェルの文字コード（Windows の Git Bash は cp932）に注意する。ファイルに UTF-8 で書いて `--data-binary @file` で送る。

## 2026-10-01 の追加

- `migrations/0003_materials.sql`: 資料（`minute_materials`）と `prompts` の `kind` に `outline` / `summarize_materials` を追加。本番に出すときは `npx wrangler d1 migrations apply hyper-sfa --remote`。
- ログインの不具合を修正: `verifyPassword` に DB の行（`password_hash`）をそのまま渡していて照合が常に失敗していた。`setup` は照合を通らないので気付きにくかった。テストを足した。
- `prepare-assets.mjs` は `wrangler dev` が動いている間は `.assets` を消せず失敗する。先に止めること。
