# hyper-sfa — 名刺管理 + 議事録

撮影した名刺を Gemini で読み取って検索できる形で保存し、商談や会議を録音して文字起こしと議事録を作る。誰と会ったかを、名刺と自社のユーザーに紐づけて残す。

2 つの版がある。画面と共通ロジックは同じで、バックエンドだけが違う。

| 版 | 対象 | ログイン | 基盤 | 設計書 |
| --- | --- | --- | --- | --- |
| AWS 版 | 社内 100 名。役職と部署で見える範囲が決まる | Google（会社の組織内 + 登録済みのアドレス） | CloudFront, API Gateway, Lambda, DynamoDB, S3, Cognito, Terraform | [docs/design.md](docs/design.md), [docs/minutes-design.md](docs/minutes-design.md) |
| Cloudflare 版 | 1〜5 名。全員がすべての名刺を見られる | ID とパスワード（セッション 30 日） | Workers, D1, R2, Workflows（無料プラン） | [docs/cloudflare-small-design.md](docs/cloudflare-small-design.md) |

費用の試算は [docs/cost-estimate.md](docs/cost-estimate.md) と [docs/cloudflare-option.md](docs/cloudflare-option.md)。

## 構成

```text
packages/core/   共通ロジック（JSON の取り出し、検索キー、プロンプト、モデル一覧、CSV、費用の計算）
web/             画面（素の JS の SPA。ビルド無し）
aws/             Lambda と Terraform
cloudflare/      Worker、D1 のマイグレーション、Workflows
docs/            設計書、API 契約
```

画面と両バックエンドの契約は [docs/api-contract.md](docs/api-contract.md)。

## ローカルで動かす

```sh
npm install
npm run check        # 構文チェック
npm run test:core    # 共通ロジックのテスト
```

- Cloudflare 版: `cd cloudflare && npx wrangler dev`（D1、R2、Workflows をローカルで模擬。詳細は `cloudflare/README.md`）
- AWS 版: `aws/README.md`

## 状態（2026-09-30）

**AWS 版は 2026-10-01 に本番へデプロイ済み**（`Assist-inc-net/SFA` の `main` への push で GitHub Actions が apply。`aws/README.md`「デプロイの仕組み」）。Cloudflare 版は未デプロイ。テストは最小限（120 件）。

| 領域 | 確かめたこと | 確かめていないこと |
| --- | --- | --- |
| `packages/core` | 単体テスト 42 件（崩れた JSON の見本 12 種類、資料の目次化を含む） | Gemini / OpenAI の実 API との整合（`responseSchema`、`thinkingConfig` の形など） |
| `web/` | 構文、import の解決、mock サーバーでの描画（headless Chrome）、pptx / xlsx のブラウザ展開（実物の 5MB の pptx と、グラフ入りの xlsx） | 実ブラウザでの操作、録音（`web/dev/recorder-check.html` で確認できる）、Cognito の PKCE |
| `cloudflare/` | 単体テスト 50 件、`wrangler deploy --dry-run`、`wrangler dev --local` で API を通しで実行（名刺、議事録、資料。`cloudflare/README.md`） | 本番の Cloudflare、CPU 10 ミリ秒に収まるか、Files API へのストリーム送信 |
| `aws/` | 単体テスト 28 件、esbuild で 5 本の Lambda を束ねられること | **Terraform は未検証**（この PC に無い。`terraform validate` と `plan` が要る）、Cognito のトリガーの実イベント、実 AWS |

既知の未実装・要判断:

- AWS 版: 論理削除した名刺の 30 日後の実削除、CloudWatch アラームと Budgets、画像 5MB の上限の強制（署名付き PUT のため）、Inbound federation トリガーの Terraform 化（`enable_inbound_federation_trigger`、既定 false で手動）
- AWS 版の利用状況: 文字起こしの回数が「区切りの数」で数えられる（1 回の作成で 12 区切りなら 12）。集計の単位を決める必要がある
- 両版: 議事録の本文を手で直す機能は無い（設計どおり）
- 資料（`docs/minutes-design.md` §15）: 100 ページ超の PDF の分割は未実装（OpenAI は 100 ページまで）。pptx に画像として貼られたグラフは読めない。OpenAI の Files API / Responses API と Gemini の PDF 読み取りは実 API で未確認
