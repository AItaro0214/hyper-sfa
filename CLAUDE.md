# hyper-sfa

名刺管理 + 議事録。**AWS 版（100 名向け）** と **Cloudflare 版（1〜5 名向け）** の 2 つを、1 つの画面（`web/`）と 1 つの共通ロジック（`packages/core/`）で動かす。

設計書は `docs/`。仕様の根拠はすべてそこにある。**コードと設計書が食い違ったら、設計書を直すか、設計書に従う。黙ってコードだけ変えない。**

| 文書 | 内容 |
| --- | --- |
| `docs/design.md` | AWS 版（名刺）。権限、担当部署、Google ログイン、JSON の取り出し、履歴 |
| `docs/minutes-design.md` | 議事録（録音、文字起こし、共有、利用状況） |
| `docs/cloudflare-small-design.md` | Cloudflare 版（ID + パスワード、無料プラン） |
| `docs/api-contract.md` | **画面と両バックエンドの契約。** 実装はこれに従う |
| `docs/core-api.md` | `packages/core` の公開関数 |
| `docs/cost-estimate.md`、`docs/cloudflare-option.md` | 費用 |

## 構成

```text
packages/core/     両バックエンドと画面が共有する純粋なロジック（依存なし、ESM）
web/               画面。素の JS の SPA。ビルド無し。両バックエンドがそのまま配信する
aws/               Lambda（app / console / auth / scan / minutes）と Terraform
cloudflare/        Worker 1 本、D1、R2、Workflows
scripts/           構文チェックなど
```

## 書くときの決まり

- **JavaScript（ESM）。TypeScript は使わない。** `web/` はビルド無しでブラウザがそのまま読む。
- **コメントは日本語。「何をしているか」ではなく「なぜそうしているか」を書く。**
- **改行は LF。** `.gitattributes` で強制している。
- 画面に出す値は必ずエスケープする。名刺や文字起こしの文字列は外部から来た値として扱う。
- ログに、名刺の内容、文字起こし、音声、API キー、パスワード、セッション ID を書かない。
- 秘密の値をリポジトリに入れない。`terraform.tfvars`、`.dev.vars`、`.env` は `.gitignore` 済み。例は `*.example` に書く。
- `packages/core` は Node と Worker とブラウザのどこでも動くように、`node:` の API と `fetch` 以外に依存しない。
- 依存パッケージは最小限。追加するときは理由をコミットメッセージに書く。

## テストの回し方

- `npm run check` … 全 JS の構文チェック。数秒。
- `npm run test:core` … 共通ロジックの単体テスト（`node --test`）。
- 各領域のテストは、その領域のディレクトリで `npm test`。実 API（Gemini、OpenAI、AWS、Cloudflare）は呼ばない。
- ローカルで全部を回す必要は無い。触った領域のテストだけ回し、全体は CI に任せる。

## デプロイ

**まだしない。** Terraform も wrangler も、この段階では `plan` / `--dry-run` まで。
