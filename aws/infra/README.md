# aws/infra（Terraform）

hyper-sfa の AWS 版の構成。設計は `docs/design.md` §2、権限は §9.5、ログインは §9.6。

**今はデプロイしない段階。`terraform plan` までにする（`CLAUDE.md`）。**

## 作るもの

| 種類 | 内容 |
| --- | --- |
| DynamoDB | 単一テーブル 1 つ。`gsi1`（検索用の一覧）、`gsi2`（履歴）、PITR、TTL（`ttl`）、オンデマンド |
| S3 | `web`（CloudFront の OAC からだけ）、`images`（バージョニング有効）、`audio`（7 日で削除）、`data`、`exports`（1 日で削除）。すべて公開ブロック、SSE-S3、TLS 強制 |
| CloudFront | 既定は `web`、`/api/*` は API Gateway |
| API Gateway | HTTP API。JWT オーソライザー。`/api/config` だけ認証なし |
| Cognito | User Pool（Essentials）、Google、アプリクライアント（PKCE）、ドメイン、Lambda トリガー |
| Lambda | `app` `console` `auth` `scan` `minutes`（Node.js 22、arm64） |
| Secrets Manager | API キー用の空のシークレット 1 つ |

## 手順（するときは）

```bash
# リポジトリのルートで
npm install
npm run build:aws            # aws/lambdas/*/build/index.mjs を作る（Terraform がこれを zip にする）

cd aws/infra
cp terraform.tfvars.example terraform.tfvars   # 値を入れる
export TF_VAR_google_client_secret='...'
terraform init
terraform fmt -check
terraform validate
terraform plan
```

`apply` の後にすること:

1. `terraform output manual_steps` を見て、Cognito の Inbound federation トリガーを手動で設定する。
2. `terraform output google_redirect_uri` の値を、Google Cloud の OAuth クライアントの「承認済みのリダイレクト URI」に登録する（`aws/README.md`）。
3. `bash aws/scripts/sync-web.sh` で画面を置く。

## 設計上の注意

- **循環を避けるための並び。** API Gateway の API 本体 → CloudFront → Cognito のアプリクライアント → Lambda → API Gateway のルート、の向きに参照している。CloudFront は API 本体だけを見る。Lambda どうしの参照は、属性ではなく決まった名前（`local.fn_name` / `local.fn_arn`）で書く。`auth` だけ別のリソースなのは、Cognito から参照されるため。
- **SPA の書き換えは CloudFront Function。** 403 / 404 を `/index.html` に置き換える方式にすると、API の 403 / 404 まで HTML に化けるため、拡張子の無いパスだけ `/index.html` にする関数にした。
- **Inbound federation** は、AWS プロバイダーが `lambda_config` に対応するまで手動（`enable_inbound_federation_trigger`）。
- 初期の開発者の DynamoDB 項目は作るだけで、以後の変更を追いかけない（`ignore_changes`）。シークレットの値も同じ。
