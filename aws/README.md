# aws/（AWS 版）

100 名向け。Lambda 5 つ（`app` `console` `auth` `scan` `minutes`）と Terraform。設計は `docs/design.md`、`docs/minutes-design.md`、API の契約は `docs/api-contract.md`。

```text
aws/
  lambdas/
    shared/    @hyper-sfa/aws-shared … DynamoDB / S3 / Secrets Manager / 認証 / 利用量 / 監査ログ（全 Lambda が使う）
    app/       名刺・議事録の API（/api/* のうち admin と dev 以外）。検索用の一覧をメモリに持つ
    console/   管理コンソール（/api/admin/*）と開発コンソール（/api/dev/*）
    auth/      Cognito のトリガー（ログインの関門 2）。API Gateway にはつながない
    scan/      名刺の読み取り（app と console から呼ぶ）
    minutes/   文字起こしと議事録の作成（app と console から呼ぶ）
  infra/       Terraform
  scripts/     build.mjs（Lambda を 1 ファイルに束ねる）、sync-web.sh（画面を S3 に置く）
```

## ローカルでの動かし方

Lambda をローカルで動かす仕組みは無い。確かめるのは **構文チェックと単体テストだけ**（実 API、AWS には触れない）。

```bash
# リポジトリのルートで
npm install                  # 初回だけ（@hyper-sfa/core と aws-shared がワークスペースとして繋がる）
npm run check                # 全 JS の構文チェック
cd aws/lambdas/app     && npm test    # 検索用の一覧の差分取り込みと、見える範囲の絞り込み
cd aws/lambdas/auth    && npm test    # Cognito トリガーの分岐（hd 不一致、未登録、正常）
cd aws/lambdas/scan    && npm test
cd aws/lambdas/minutes && npm test
```

依存が入っていない状態でも、`node --check aws/lambdas/*/src/*.js` は通る。ローカルで全部を回す必要は無く、触った Lambda のテストだけ回して、全体は CI に任せる。

束ねた結果を見たいとき:

```bash
npm run build:aws            # aws/lambdas/*/build/index.mjs（.gitignore 済み）
```

## デプロイ

**今はしない。** Terraform は `plan` までにする（`CLAUDE.md`）。手順は `aws/infra/README.md` に書いてある。

デプロイするときの順番:

1. `npm run build:aws`
2. `aws/infra` で `terraform init` → `plan` → `apply`（Google の OAuth クライアントの値が要る。次の節）
3. `terraform output manual_steps` に従って、Cognito の Inbound federation トリガーを設定する
4. Google Cloud の OAuth クライアントに、リダイレクト URI を登録する（次の節）
5. `bash aws/scripts/sync-web.sh` で画面を置く
6. 最初の開発者（`initial_developer_email`）でログインし、開発コンソールで API キーを登録する。部署を作ってから、ほかの人を管理コンソールで登録する

## Google Cloud 側の設定

会社の組織に属する Google Cloud プロジェクトで行う（組織に属さないプロジェクトでは、同意画面を「内部」にできない）。

1. **OAuth 同意画面** を開き、ユーザーの種類を **「内部」** にする。組織の外のアカウントは Google が拒否する（ログインの関門 1。`docs/design.md` §9.6）。アプリ名、サポートメールを入れる。スコープは `openid` `email` `profile`。
2. **認証情報 > 認証情報を作成 > OAuth クライアント ID** を作る。種類は「ウェブ アプリケーション」。
3. **承認済みのリダイレクト URI** に、Cognito のドメインの `/oauth2/idpresponse` を入れる:

   ```text
   https://<project>-<env>-<AWS アカウント ID>.auth.ap-northeast-1.amazoncognito.com/oauth2/idpresponse
   ```

   `terraform output google_redirect_uri` に同じ値が出る。Cognito のドメインは Terraform が決める名前なので、`apply` の前に、上の形から作って登録してもよい。
4. できたクライアント ID を `google_client_id`、シークレットを `google_client_secret`（環境変数 `TF_VAR_google_client_secret`）に渡す。**シークレットはリポジトリに入れない。**

## 画面を置く（`aws/scripts/sync-web.sh`）

```bash
bash aws/scripts/sync-web.sh
```

- `web/` を web バケットへ `aws s3 sync`（`--delete`）
- `packages/core/src` を `/core/` として同期（画面は core をそのままブラウザで読む）
- CloudFront の `/*` を invalidation

`terraform output` からバケット名と CloudFront の ID を読む。使わない場合は環境変数 `WEB_BUCKET` と `DISTRIBUTION_ID` で渡す。

## Lambda に渡す環境変数（Terraform が設定）

| 名前 | 使う Lambda | 内容 |
| --- | --- | --- |
| `TABLE_NAME` | 全部 | DynamoDB のテーブル名 |
| `IMAGE_BUCKET` `AUDIO_BUCKET` `DATA_BUCKET` `EXPORT_BUCKET` | app / console / scan / minutes | S3 のバケット名 |
| `API_KEYS_SECRET_ARN` | console / scan / minutes | API キーのシークレット（**app は読めない**） |
| `SCAN_FUNCTION_NAME` `MINUTES_FUNCTION_NAME` | app / console | 呼び出す Lambda の名前 |
| `COGNITO_DOMAIN` `COGNITO_CLIENT_ID` `APP_ORIGIN` | app | `/api/config` の `cognito` に返す |
| `COGNITO_USER_POOL_ID` | console | 無効化したユーザーのログインを取り消す |
| `ALLOWED_HD` | auth / console | 会社のドメイン |
| `FFMPEG_PATH` | minutes | `/opt/bin/ffmpeg`（layer があるとき） |

## DynamoDB に置くもの（キーは `aws/lambdas/shared/src/keys.js`）

`docs/design.md` §6.1 と `docs/minutes-design.md` §10.1 のとおり。この実装で足した項目:

| pk | sk | 内容 |
| --- | --- | --- |
| `ORG` | `SETTING#gemini` | 選択中のモデル `models`、プロンプトの版 `promptVersion`（scan / minutes が読む） |
| `ORG` | `SETTING#key#<gemini or openai>` | キーの末尾 4 文字、更新日時、更新した人（キーの値は入れない） |
| `ORG` | `SETTING#test#<jobId>` | 議事録の試しの結果（24 時間で消える） |
| `ORG` | `PROMPT#<用途>#<版 6 桁>` | プロンプトの本文 |
| `RATE#<日>` | `USER#<メール>` | 1 日の読み取り回数（3 日で消える） |
| `USAGE#<月>` | `USE#<用途>#<モデル ID>` | 用途ごと・モデルごとの合計 |
| `USAGE#<月>` | `MINUTES#USER#<メール>` | ユーザーごとの議事録の利用量 |
| `USAGE#<月>` | `MINLOG#<日時>#<乱数>` | 1 回ごとの記録（`gsi2pk = MINUSER#<メール>` で 1 人分を読む。2 年で消える） |

## 権限（`docs/design.md` §9.5）

| Lambda | できること |
| --- | --- |
| app | DynamoDB の読み書き、画像・音声・文章バケットの読み書き、scan と minutes の呼び出し。**API キーは読めない** |
| console | DynamoDB の読み書き、Cognito のユーザーの無効化とログインの取り消し、API キーの読み取りと**書き込み**、出力バケットへの書き込み、scan と minutes の呼び出し |
| auth | DynamoDB のユーザーの読み取りと、ログイン日時の記録だけ |
| scan | DynamoDB の読み書き、画像バケットの読み取り、API キーの読み取り |
| minutes | DynamoDB の読み書き、音声・文章バケットの読み書き、API キーの読み取り |

## デプロイの仕組み（2026-10-01 に追加）

main への push で GitHub Actions（`.github/workflows/deploy.yml`）が Terraform apply と web の同期を行う。PR では plan だけ。

1. **土台（1 回だけ、手元の AWS CLI で）**: `aws/infra/bootstrap/github-deploy.yaml` を CloudFormation で作る。Terraform の状態を置く S3 バケットと、GitHub Actions が OIDC で引き受けるロールができる。
   ```sh
   aws cloudformation deploy --stack-name hyper-sfa-bootstrap \
     --template-file aws/infra/bootstrap/github-deploy.yaml \
     --capabilities CAPABILITY_NAMED_IAM --parameter-overrides GitHubRepo=Assist-inc-net/SFA
   ```
   Windows の AWS CLI は日本語コメント入りのファイルを cp932 で読んで失敗することがある。その場合は非 ASCII の行を除いた写しを作って渡す。
2. **GitHub の Variables**: `AWS_ROLE_ARN`、`TF_STATE_BUCKET`、`ALLOWED_HD`、`INITIAL_DEVELOPER_EMAIL`、`DEPLOY_ENABLED`（`true` で有効）。**Secrets**: `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。
3. Google Cloud の OAuth クライアント（ユーザーの種類は「内部」）の「承認済みのリダイレクト URI」に、Cognito のドメイン `/oauth2/idpresponse` を登録する。ドメインは `https://hyper-sfa-<env>-<account>.auth.ap-northeast-1.amazoncognito.com`（Terraform の出力 `google_redirect_uri` にも出る）。
4. `DEPLOY_ENABLED=true` にして main に push する。
5. 初回の apply 後、Terraform の出力 `manual_steps` にある Cognito の Inbound federation トリガーを手動で設定し、`ENABLE_INBOUND_FEDERATION_TRIGGER=true` にする。

手元で Terraform を回すときは、`terraform init` に `-backend-config` でバケット名・キー・リージョンを渡す（`versions.tf` のコメント）。
