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

## 状態

実装中。**デプロイはまだしていない。** テストは最小限。
