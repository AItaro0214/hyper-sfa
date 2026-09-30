# Cloudflare で組む場合の比較

作成日: 2026-09-30 / 状態: 比較の資料（AWS 版の設計書 [design.md](./design.md)、[minutes-design.md](./minutes-design.md) はそのまま残す）

## 1. 結論

> **追記（2026-09-30）:** この文書は「100 名を Cloudflare で組んだら」の比較。その後、Cloudflare 版は **1〜5 名、ID とパスワードでログイン** と決まった。その前提の設計は [cloudflare-small-design.md](./cloudflare-small-design.md)、費用は本文書の §7。

**Cloudflare でも同じくらい安く運用できる。月額の差は $2〜3 で、費用では決まらない。**

| | AWS 版 | Cloudflare 版 |
| --- | --- | --- |
| 基盤の月額（開始時） | $1.2 | $5.0 |
| 基盤の月額（3 年後、名刺 6.4 万枚） | $3.2 | $5.3 |
| 固定費 | $0.40（Secrets Manager） | $5.00（Workers Paid プラン） |
| AI の費用（名刺 + 議事録 月 200 時間） | 約 $33 | 同じ |
| **合計（3 年後）** | **約 $36（約 5,800 円）** | **約 $38（約 6,100 円）** |

費用の 9 割は Gemini などの AI で、これはどちらで組んでも同じ。基盤の差は月 $2〜3。

| 決め手 | 向いている方 |
| --- | --- |
| データの置き場所を「東京」と言い切りたい（名刺と会議の音声は社外の人の個人情報） | AWS |
| 本番で動かしている既存のもの（rollplay、product-chatbot-aws）と運用を揃えたい | AWS |
| 音声をサーバー側で加工したい（区切りをつなげて 1 本にする、形式を変える） | AWS |
| 作る量を減らしたい。検索を SQL で書きたい | Cloudflare |
| 既存の Cloudflare 案件（mikata など）と作り方を揃えたい | Cloudflare |
| ログインを自分で作ることに抵抗が無い | Cloudflare |

**私の勧め:** このアプリは AWS 版のままでよい。理由は、費用が変わらないこと、名刺と音声が社外の人の個人情報で置き場所を東京に固定できること、ログインの維持を Cognito に任せられること、音声の加工に ffmpeg を使えること。Cloudflare に寄せるなら、ログインとセッションを自分で作る分と、音声のダウンロードの作り方が変わる（§4）。

## 2. 構成の対応

| 役割 | AWS 版 | Cloudflare 版 |
| --- | --- | --- |
| 画面の配信 | CloudFront + S3 | Workers の静的アセット（無料・回数の上限なし） |
| API | API Gateway + Lambda「app」「console」「auth」 | Worker 1 本 |
| 名刺の読み取り、議事録の作成（時間のかかる処理） | Lambda「scan」「minutes」 | Workflows（途中で止まっても再開できる仕組み。再試行が組み込み） |
| ログイン | Cognito + Google | Worker で Google の OAuth を実装。セッションは D1 に持ち、Cookie で維持 |
| データ | DynamoDB + Lambda のメモリ内で検索 | D1（SQLite）。検索は SQL の LIKE |
| 画像、音声、文章 | S3 3 バケット | R2 3 バケット |
| API キー | Secrets Manager | D1 に暗号化して保存。暗号の鍵は Worker の Secret |
| ログ・監視 | CloudWatch | Workers Logs |
| 構成管理 | Terraform | wrangler の設定ファイル |
| デプロイ | GitHub Actions → Terraform | GitHub Actions → wrangler |

## 3. 費用の内訳（Cloudflare 版）

前提は AWS 版と同じ（[cost-estimate.md](./cost-estimate.md) §2、§11.2）。

| 項目 | 単価 | 開始時 | 3 年後 | 計算 |
| --- | --- | --- | --- | --- |
| Workers Paid プラン | $5 / 月 | $5.00 | $5.00 | 下の「無料プランで収まるか」 |
| Workers のリクエスト | 月 1,000 万回まで込み | $0 | $0 | 月 25 万回 |
| Workers の CPU 時間 | 月 3,000 万ミリ秒まで込み | $0 | $0 | 1 回 50 ミリ秒でも 1,250 万ミリ秒 |
| Workflows | ステップ 月 50 万まで込み | $0 | $0 | 議事録 1 本で 20 ステップほど。月 6,000 |
| D1 | 読み取り 月 250 億行、保存 5GB まで込み | $0 | $0 | 検索 1 回で 6.4 万行を走査、月 2 万回で 13 億行。保存は 0.2GB |
| R2 | $0.015 / GB 月。10GB まで無料。転送は無料 | $0 | $0.26 | 名刺の画像 26GB + 音声 1.4GB − 10GB |
| **合計** | | **$5.0** | **$5.3** | |

- R2 は転送（ダウンロード）が無料なので、画像や音声を何度表示しても増えない。
- D1 の「読み取り行」は返した行数ではなく走査した行数で数える。部分一致の検索は毎回全件を走査するので、この数え方が効く。Paid プランの込み量（250 億行 / 月）には余裕で収まる。

### 無料プランで収まるか

収まらない。月 $0.26 にはなるが、次の 2 点で無理をすることになる。

| 上限（無料プラン） | ぶつかる所 |
| --- | --- |
| D1 の読み取り 1 日 500 万行 | 部分一致の検索は 1 回で全件（3 年後は 6.4 万行）を走査する。1 日 78 回で上限に達し、それ以降の検索は失敗する。全文検索の索引（FTS5）で走査を減らす手はあるが、日本語の部分一致で使えるかは未確認 |
| Worker の CPU 1 回 10 ミリ秒 | CSV の出力（6.4 万行）や、名刺の画像・音声の区切りをそのまま扱う処理で超える恐れがある。超えるとその処理が失敗する |

Paid プラン（$5）にすると、CPU は 1 回 30 秒、D1 は月 250 億行になり、どちらも気にしなくてよくなる。mikata のように「無料枠に収める」設計はこのアプリには向かない。

## 4. 設計で変わること

### 4.1 ログイン（Cognito が無くなる）

Cloudflare Access（Zero Trust）で Google ログインを付ける手もあるが、無料は 50 人までで、100 人だと 1 人 $7 / 月ほどになり合わない（この数字は公式ページの本文で確認できず、二次情報）。**Worker で Google の OAuth を自分で実装する。** TalentBoard、mikata（LINE Login）と同じ作り方。

| 項目 | 内容 |
| --- | --- |
| 流れ | 認可コード + PKCE + state。Google から戻ったら、Worker が ID トークンの署名を検証する |
| 3 つの関門 | AWS 版（design.md §9.6）と同じ。Google 側の「内部」、`hd` と登録済みアドレスの確認、リクエストごとのユーザー情報の確認 |
| セッション | D1 の表（ID、メールアドレス、期限、最後に使った日時）。Cookie は HttpOnly、Secure、SameSite=Lax。30 日 |
| 無効化 | ユーザーを無効にしたら、その人のセッションを消す。次のリクエストから入れない |
| Google のクライアントシークレット | Worker の Secret（`wrangler secret put`） |

Cognito から失うもの: トークンの発行と更新、ログインの取り消しの仕組み。すべて自分で書く（数百行）。AWS 版で気にしていた「Cognito が `hd` を渡してくれるか」の不確かさは無くなる（自分で ID トークンを読むため）。

### 4.2 検索（メモリ内の索引が無くなる）

D1 は SQLite なので、部分一致は `LIKE '%田中%'` で書ける。AWS 版の「検索用の一覧を Lambda のメモリに持つ」仕組み（design.md §7）は要らない。

| 項目 | 内容 |
| --- | --- |
| 表 | 名刺の表に、検索用に正規化した列（会社名、氏名、読み、相手の部署名、電話番号の数字だけ、メールアドレス、備考）を持つ |
| 見える範囲 | 担当部署の表と結合して、その人が見られる名刺に絞る |
| 速さ | 6.4 万件の全件走査で数十ミリ秒 |
| 上限 | 1 つの D1 は 10GB。名刺 10 万件で 0.3GB |

AWS 版より作りが単純になる。これが Cloudflare 版の一番の利点。

### 4.3 名刺の読み取り

Workflows で Gemini を呼ぶ。画像は R2 から読んで、リクエストに入れる。応答待ちは CPU 時間に数えられない。AWS 版の「読み取り中 → 確認待ち → 失敗 → 再生成」の流れはそのまま。

### 4.4 議事録

| 項目 | AWS 版 | Cloudflare 版 |
| --- | --- | --- |
| 区切りの送信 | S3 の署名付き URL に直接 PUT | Worker 経由で R2 に書く（2.4MB なので Worker を通してよい。R2 の署名付き URL も使えるが、鍵の管理が増える） |
| 文字起こしと議事録 | Lambda「minutes」 | Workflows。区切りごとを 1 ステップにすると、失敗した区切りだけが再試行される |
| 音声の 7 日削除 | S3 のライフサイクル | R2 のライフサイクル（日単位。削除は期限から 24 時間以内） |
| 区切りをつなげたダウンロード用の 1 本 | Lambda の ffmpeg | **ffmpeg が無い。** 下のどれか |
| モデルに合わせて区切りを短く分け直す | Lambda の ffmpeg | できない。録音の時点で、選んでいるモデルに合わせた長さで区切る |

**ダウンロード用の 1 本の作り方（Cloudflare 版）**

| 案 | 内容 | 難点 |
| --- | --- | --- |
| A（勧め） | 録音中に 2 本の録音を並行して取る。区切り（文字起こし用）と、通しの 1 本（ダウンロード用）。通しの 1 本は止めた後に送る | 送る量が 2 倍（2 時間で 29MB × 2）。通しの 1 本は Chrome なら WebM で、iPhone でそのまま再生できないことがある |
| B | ダウンロードは区切りごとのファイルを zip でまとめる | 1 本にならない |
| C | Cloudflare Containers で ffmpeg を動かす | Docker のイメージを作って保守する。Paid プランに込みの量（vCPU 375 分 / 月）で足りる見込みだが、部品が 1 つ増える |

### 4.5 API キー

Worker の Secret は、開発コンソールのような「画面から更新する」用途に向かない（更新のたびに Worker を配り直す形になる）。**D1 に暗号化して保存し、暗号の鍵だけを Worker の Secret に置く。** 表示は末尾 4 文字だけ、という決まりは同じ。

### 4.6 データの置き場所

| | AWS 版 | Cloudflare 版 |
| --- | --- | --- |
| 置き場所 | 東京リージョンに固定 | D1 と R2 に「アジア太平洋」の希望（location hint）を出せるが、保証ではない。日本に限定する指定は無い |

社外の人の名刺と会議の音声を扱うので、社内向けの説明のしやすさでは AWS 版が上。

### 4.7 そのほか

| 項目 | 内容 |
| --- | --- |
| バックアップ | D1 の Time Travel（Paid は 30 日前まで戻せる）。R2 には版の管理が無いので、画像の誤削除は論理削除（30 日）で守る |
| 構成管理 | wrangler の設定ファイル 1 つ。Terraform より少ない |
| Workers AI の Whisper | 文字起こしを Cloudflare の Whisper にすると 1 分 $0.000513（月 200 時間で約 $6）。Gemini の Lite（約 $20）より安いが、日本語の精度と 1 回に渡せる長さが未確認。要件は Gemini / GPT なので初期案には入れない |

## 5. 確認できなかったこと

| 項目 | 扱い |
| --- | --- |
| Cloudflare Access の無料人数（50 人）と 1 人あたりの月額（$7） | 二次情報。いずれにせよ自前で実装する前提なので、結論には影響しない |
| D1 の FTS5 で日本語の部分一致（trigram）が使えるか | 使えなくても、Paid プランなら全件走査で足りる |
| Workers の CPU 時間の実測（名刺の画像を扱う処理、CSV の出力） | Paid プランの 30 秒なら問題にならない見込み |
| Secrets Store（ベータ）の料金と、実行時の更新の可否 | 使わず、D1 に暗号化して保存する案にした |
| Containers が正式版か | 案 C を採る場合だけ関係する |

## 6. 情報源

- [Workers の料金](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers の上限](https://developers.cloudflare.com/workers/platform/limits/)
- [Workflows の料金](https://developers.cloudflare.com/workflows/reference/pricing/)
- [Workflows の上限](https://developers.cloudflare.com/workflows/reference/limits/)
- [D1 の料金](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 の上限](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 の Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 のデータの場所](https://developers.cloudflare.com/d1/configuration/data-location/)
- [R2 の料金](https://developers.cloudflare.com/r2/pricing/)
- [R2 の署名付き URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 のライフサイクル](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [R2 のデータの場所](https://developers.cloudflare.com/r2/reference/data-location/)
- [Workers の Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Access の Google Workspace 連携](https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/google-workspace/)
- [Workers AI の料金](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Containers の料金](https://developers.cloudflare.com/containers/pricing/)

## 7. 1〜5 名で使う場合

利用者が 1〜5 名なら、上の「無料プランで収まらない」理由は 2 つとも消える。

| 上限（無料プラン） | 100 名 | 5 名 |
| --- | --- | --- |
| Workers 1 日 10 万リクエスト | 7,000 / 日 | 500 / 日 |
| D1 の読み取り 1 日 500 万行 | 検索 1 回 6.4 万行 × 月 2 万回 → 超える | 名刺 5,000 枚 × 月 1,000 回 → 1 日 17 万行 |
| R2 の保存 10GB | 26GB | 3 年で 2GB + 音声 0.2GB |
| Worker の CPU 1 回 10 ミリ秒 | CSV 6.4 万行、音声で超える恐れ | 5,000 行なら収まる。画像と音声は中身を触らず流す |

| 月額（5 名） | 金額 |
| --- | --- |
| 基盤 | **$0** |
| 名刺の読み取り（月 75 枚） | $0.15 |
| 議事録（月 40 時間） | $5.9（2027 年〜 $7.4） |
| **合計** | **約 $6（約 1,000 円）**。1 名なら約 $1.5 |

既存の名刺をまとめて読み取る分は、2,000 枚で $4 ほど（1 回だけ）。

