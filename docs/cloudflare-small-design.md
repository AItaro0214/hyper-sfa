# 名刺管理 + 議事録 Cloudflare 版（1〜5 名）設計書

作成日: 2026-09-30 / 状態: 設計案 第 1 版（実装前）

100 名向けの AWS 版（[design.md](./design.md)、[minutes-design.md](./minutes-design.md)）とは別のもの。機能の中身（名刺の読み取り、検索、議事録の作成、再生成、JSON の取り出し、プロンプト）は AWS 版と同じで、ここには **AWS 版と違う所だけ** を書く。AWS 版との費用の比較は [cloudflare-option.md](./cloudflare-option.md)。

## 1. 前提

| 項目 | 内容 |
| --- | --- |
| 利用者 | 1〜5 名 |
| 基盤 | Cloudflare の**無料プラン**（Workers、D1、R2、Workflows）。固定費 $0 |
| ログイン | ログイン ID とパスワード。セッションは 30 日 |
| 権限 | 管理者とメンバーの 2 つ。全員がすべての名刺を見られる |
| 名刺の量 | 初期 2,000 枚、月 75 枚増、3 年で 5,000 枚。設計上の上限は 2 万枚 |
| 議事録 | 月 40 時間まで想定 |
| 費用 | 基盤 $0 + AI 月 $6 前後（約 1,000 円）。[cloudflare-option.md](./cloudflare-option.md) §7 |

## 2. 全体構成

```text
ブラウザ
   │
   ▼
Worker 1 本 ───┬─ 静的アセット      画面（無料・回数の上限なし）
               ├─ /api/*           API。Cookie でセッションを確かめる
               ├─ D1               ユーザー、セッション、名刺、議事録、共有、履歴、設定
               ├─ R2「画像」        名刺の写真
               ├─ R2「音声」        録音の区切り（7 日で削除）
               ├─ R2「文章」        文字起こしと議事録
               └─ Workflows        名刺の読み取り、文字起こし、議事録の作成
                                       └─ Gemini / OpenAI
```

| 役割 | 使うもの | AWS 版との違い |
| --- | --- | --- |
| 画面 | Workers の静的アセット | CloudFront + S3 が要らない |
| API | Worker 1 本（`/api/*`） | Lambda 3 本と API Gateway が 1 本になる |
| 時間のかかる処理 | Workflows | Lambda の非同期呼び出しの代わり。再試行と途中からの再開が組み込み |
| データ | D1（SQLite） | DynamoDB とメモリ内の索引が要らない。検索は SQL |
| ファイル | R2 | S3 と同じ使い方。転送が無料 |
| API キー | D1 に暗号化して保存。鍵は Worker の Secret | Secrets Manager の代わり |
| 構成管理 | `wrangler.toml` | Terraform が要らない |

**無料プランの上限との付き合い方**

| 上限 | 対応 |
| --- | --- |
| Worker の CPU 1 回 10 ミリ秒 | 画像と音声は Worker の中で中身を触らない。ブラウザ → R2、R2 → Gemini は「流すだけ」にする（§6）。パスワードのハッシュは、この枠に収まる強さにして、秘密の値（pepper）で補う（§3） |
| Workers 1 日 10 万リクエスト | 5 名なら 1 日 500 回ほど |
| D1 の読み取り 1 日 500 万行、1 つの DB は 500MB | 名刺 5,000 枚の全件走査を 1 日 1,000 回しても 500 万行。DB は数十 MB |
| D1 の書き込み 1 日 10 万行 | 1 日 数百行 |
| R2 の保存 10GB | 3 年で 2GB + 音声 0.2GB |
| Workflows 1 日 3,000 ステップ | 議事録 1 本で 15 ステップほど |
| KV | 使わない（無料枠の書き込みが 1 日 1,000 回しかない。mikata と同じ判断） |

## 3. ログイン（ID とパスワード）

### 3.1 決まり

| 項目 | 内容 |
| --- | --- |
| ログイン ID | 管理者が決める文字列（メールアドレスでもよい）。3〜64 文字 |
| パスワード | 10 文字以上。管理者が最初の仮パスワードを発行し、本人が初回ログインで変える |
| セッション | ログインから 30 日。**その間に使えば、最後に使った日から 30 日に延びる**（毎日使う人は切れない）。90 日を超えたら必ず再ログイン |
| 端末 | 何台でもログインできる。「ほかの端末からログアウト」で自分のセッションを全部消せる |
| ログアウト | Cookie とサーバー側のセッションを両方消す |
| パスワードを忘れたら | 管理者が仮パスワードを再発行する。メールは送らない（メール送信の仕組みを持たないため） |
| 管理者自身が忘れたら | `wrangler` のコマンドで仮パスワードを入れ直す手順を用意する |

メールを使わないのは、1〜5 名の運用ではメール送信の仕組み（ドメインの検証、送信サービスの契約）のほうが手間だから。

### 3.2 パスワードの保存

| 項目 | 内容 |
| --- | --- |
| 方式 | PBKDF2-SHA256。利用者ごとのソルト + サーバーだけが持つ秘密の値（pepper。Worker の Secret） |
| 繰り返し回数 | **CPU 10 ミリ秒に収まる回数**（目安 3 万回。実測して決め、設定値として持つ） |
| なぜ回数を抑えるか | 一般に勧められる回数（60 万回）は 100 ミリ秒以上かかり、無料プランの上限を超える。回数を抑えた分は pepper で補う。DB が漏れても pepper が無ければ総当たりできない |
| 総当たりへの守り | 同じ ID で 5 回続けて失敗したら 15 分ロック。同じ IP からの試行は 1 分 10 回まで。失敗は記録する |
| 回数を上げたくなったら | Workers Paid（$5）にすると CPU が 1 回 30 秒になり、60 万回にできる。保存してある回数を見て、ログイン時に順次ハッシュし直す |

roleplay-saas と meeting-notes-cf で使った「PBKDF2 + pepper」と同じ考え方。

### 3.3 セッションの持ち方

| 項目 | 内容 |
| --- | --- |
| Cookie | ランダムな 256 ビットの ID。`HttpOnly` `Secure` `SameSite=Lax`。有効期限 30 日 |
| サーバー側 | D1 の `sessions` 表。ID のハッシュ、利用者、作成日時、最後に使った日時、期限、端末の名前 |
| 確認 | リクエストのたびに `sessions` と `users` を読む（2 行）。無効な利用者、期限切れ、消されたセッションは 401 |
| 延長 | 最後に使った日時が 1 日以上前なら、期限を「今から 30 日」に書き換える（毎回書かない。D1 の書き込みを減らすため） |
| 無効化 | 利用者を無効にする、パスワードを変える、仮パスワードを発行する、のいずれかで、その人のセッションを全部消す |
| 掃除 | 期限切れのセッションは、ログインのたびにまとめて消す（Cron を使わない） |
| CSRF | `SameSite=Lax` に加え、変更を伴う API は `Origin` ヘッダーを確かめる |

### 3.4 最初の管理者

初めて開いたときに利用者が 0 人なら、「最初の管理者を作る」画面を出す。ここで ID とパスワードを決めると、以後この画面は出ない。`wrangler secret` に初期パスワードを入れる方式より、間違いが少ない。

## 4. 権限

| 権限 | できること |
| --- | --- |
| メンバー | 名刺の登録・検索・編集（削除は不可。登録の途中の自分の下書きの取りやめだけ可）、議事録の作成、自分が作った議事録の共有 |
| 管理者 | メンバーのできること + 名刺の削除（誤削除の防止のため管理者だけ）、利用者の追加・無効化・仮パスワードの発行、API キー、モデル、プロンプト、CSV 出力、利用状況 |

- 役職、部署、担当部署の仕組みは持たない。名刺は全員が見られる。
- 議事録は AWS 版と同じで、作った人と共有された人だけが見られる。管理者でも見られない。
- 管理コンソールと開発コンソールは 1 つの「設定」画面にまとめる。
- 最後の 1 人の管理者は無効化できない。

## 5. データ設計（D1）

| 表 | 主な列 |
| --- | --- |
| `users` | id, login_id, password_hash, salt, iterations, role, status, display_name, must_change_password, created_at, last_login_at |
| `sessions` | id_hash, user_id, created_at, last_seen_at, expires_at, device |
| `login_attempts` | login_id, ip, at, ok |
| `cards` | id, company, department, title, name, name_reading, phones, mobiles, emails, note, raw_text, image_front_key, image_back_key, thumb_key, status, failure, created_by, created_at, updated_by, updated_at, edit_count, scan_count, version, deleted_at |
| `cards`（検索用の列） | company_n, name_n, reading_n, department_n, phones_digits, emails_n, title_n, note_n（全角 / 半角、大文字 / 小文字、ひらがな / カタカナをそろえたもの） |
| `card_history` | id, card_id, type, actor_id, actor_name, source, changes（JSON）, at |
| `minutes` | id, title, held_at, mode, duration_sec, memo, owner_id, status, step, failure, audio_expires_at, download_key, transcript_key, transcript_version, summary_key, summary_version, created_at, updated_at |
| `minute_segments` | minute_id, seq, key, mime, start_sec, duration_sec, size, transcript_status |
| `minute_counterparts` | minute_id, card_id, company, department, name |
| `minute_attendees` | minute_id, user_id |
| `minute_shares` | minute_id, user_id, shared_by, shared_at |
| `models` | id, provider, uses, label, prices, thinking_level, max_audio_minutes, shutdown_at, active |
| `settings` | key, value（選択中のモデル、プロンプトの版、暗号化した API キー など） |
| `prompts` | kind, version, text, saved_by, saved_at |
| `usage_monthly` | year_month, user_id, kind, count, seconds, input_tokens, output_tokens, cost |
| `audit_log` | at, actor_id, action, detail |

- 検索は `cards` の検索用の列に `LIKE '%…%'` を AND でつなぐ。5,000 件なら数ミリ秒。
- 論理削除は `deleted_at`。30 日後に画像ごと消す（ログインのたびに古いものを少しずつ消す。Cron を使わない）。
- D1 の Time Travel（無料は 7 日前まで戻せる）をバックアップとする。R2 には版の管理が無いので、画像は論理削除の 30 日で守る。

## 6. 画像と音声の流し方（CPU 10 ミリ秒のため）

Worker の中でファイルの中身を読んだり変換したりすると、CPU 時間を使う。**Worker は「受け取ったものをそのまま次へ渡す」だけにする。**

| 場面 | 作り |
| --- | --- |
| 写真のアップロード | ブラウザが縮小した JPEG を `PUT /api/uploads/...` で送る。Worker は本文をそのまま R2 に書く（ストリーム） |
| 写真の表示 | `GET /api/images/...`。Worker はセッションを確かめて、R2 の本文をそのまま返す。R2 の署名付き URL は使わない（鍵の管理が増えるため。転送は無料） |
| Gemini に写真を渡す | Workflows のステップから、R2 の本文を Gemini の Files API にストリームで送り、返ってきたファイルの参照で読み取りを依頼する。Base64 への変換を Worker でしない |
| 録音の区切り | 同じ。ブラウザ → R2 はストリーム、R2 → Gemini の Files API はストリーム |
| 文字起こしの応答 | 文章なので小さい。R2 の「文章」に書く |
| CSV の出力 | 数千行を 1 行ずつ作って流す。1 万行を超えるなら、Workflows で作って R2 に置き、リンクを渡す |

Gemini の Files API は無料で、預けたファイルは 48 時間で消える。読み取りが終わったら、明示的に消す。

## 7. 議事録で変わること

AWS 版の [minutes-design.md](./minutes-design.md) と同じ流れ。違いは次の 3 点。

| 項目 | AWS 版 | Cloudflare 版 |
| --- | --- | --- |
| 処理の器 | Lambda「minutes」 | Workflows。区切り 1 つを 1 ステップにする。失敗した区切りだけが再試行される |
| 区切りをつなげた 1 本（ダウンロード用） | Lambda の ffmpeg | ffmpeg が無い。**録音中に「区切り」と「通しの 1 本」を並行して取り、通しの 1 本は録音を終えた後に送る。** 送る量は 2 倍（2 時間で 29MB × 2）。通しの 1 本は録音したままの形式（Chrome は WebM、Safari は MP4） |
| モデルに合わせて区切りを短く分け直す | Lambda の ffmpeg | できない。録音を始めるときに、選んでいるモデルの「1 回に渡せる長さ」を読んで、その長さで区切る |

- 音声の 7 日削除は R2 のライフサイクル（日単位、期限から 24 時間以内に削除）。アプリ側で 7 日ちょうどに渡すのを止めるのは AWS 版と同じ。
- 「ウェブ会議を録音」がパソコンの Chrome / Edge だけ、という制約はブラウザ側の話なので変わらない。
- ユーザーごとの利用状況の一覧（minutes-design.md §7.2）は、`usage_monthly` から出す。5 名なので画面は簡素でよい。

## 8. API キーと設定

| 項目 | 内容 |
| --- | --- |
| 保存 | AES-GCM で暗号化して `settings` に置く。鍵は Worker の Secret（`wrangler secret put KEY_ENCRYPTION_KEY`） |
| 表示 | 末尾 4 文字だけ |
| 更新 | 設定画面から。Worker を配り直す必要は無い |
| Secret に置くもの | 鍵（API キーの暗号化用）、pepper（パスワード用）の 2 つだけ |

## 9. 開発と配備

| 項目 | 内容 |
| --- | --- |
| 構成 | `wrangler.toml` 1 つ。mikata と同じ形（Worker 1 本 + `[assets]` + `[[d1_databases]]` + `[[r2_buckets]]` + `[[workflows]]`） |
| ローカル | `wrangler dev` で D1、R2、Workflows を含めて動く。Gemini のキーが無ければ、読み取りは「失敗」として扱われ、手入力で試せる |
| 配備 | `main` への push で GitHub Actions が `wrangler deploy`。D1 のスキーマ変更は `wrangler d1 migrations apply` |
| ログ | Workers Logs（無料は 1 日 20 万件、3 日保持）。名刺の内容、音声、API キーは書かない |
| 費用の見張り | Gemini 側の予算アラート。Cloudflare 側は無料プランなので請求は発生しない（超えた分は失敗する。R2 だけは 10GB を超えると課金される設定にするか、失敗させるかを選べる） |

## 10. 利用者が増えたら

| 変化 | 対応 |
| --- | --- |
| 10 名を超えた | Workers Paid（$5 / 月）にする。CPU の制約が無くなり、パスワードの繰り返し回数を上げられる。それ以外の作りは変えない |
| 名刺が 2 万枚を超えた | D1 の全件走査が重くなる前に、検索用の列に索引を足すか、FTS5 を試す |
| 部署や役職で見える範囲を分けたい | AWS 版の「担当部署」の仕組みを持ち込む。データの持ち方は `card_depts` 表を足すだけで済む |
| 複数の会社に貸し出す（SaaS にする） | roleplay-saas と meeting-notes-cf と同じ形にする。全部の表に `tenant_id` を足し、Stripe で決済、契約ごとに録音時間の上限。無料プランの Workers でも 100 契約程度までは同じ基盤で動く計算 |

## 11. 決めてほしいこと

| # | 内容 | 初期案 |
| --- | --- | --- |
| 1 | 自社の少人数で使うのか、複数の会社に貸し出す SaaS なのか | 自社の少人数（1 組織）。SaaS なら §10 の最後の行の作りを最初から入れる |
| 2 | セッションの延び方 | 使えば最後に使った日から 30 日に延びる。90 日で必ず再ログイン。「ログインから 30 日で必ず切れる」にもできる |
| 3 | パスワードを忘れたときの手順 | 管理者が仮パスワードを再発行。メールは送らない |
| 4 | 2 段階認証（TOTP） | 付けない。付ける場合は sales-recorder の実装（otplib）が流用できる |
| 5 | 名刺の見える範囲 | 全員がすべて見られる。削除は管理者だけ（2026-10-02 変更） |
| 6 | 議事録の共有の決まり | AWS 版と同じ（作った人と共有された人だけ）。5 名なら「全員が見られる」でもよい |
| 7 | 通しの 1 本の音声の形式 | 録音したまま（Chrome は WebM）。iPhone でそのまま再生できないことがある |

## 12. 実機で確かめること

| 確かめること | うまくいかない場合 |
| --- | --- |
| PBKDF2 の繰り返し回数を何回まで上げても 10 ミリ秒に収まるか | 回数を下げる。または Paid にする |
| R2 → Gemini の Files API へのストリーム送信が、CPU 時間を使わずに通るか | ブラウザから Gemini の Files API に直接送る案（キーを画面に出さない工夫が要る）、または Paid にする |
| 5,000 件の `LIKE` 検索の所要時間と、D1 の読み取り行の数え方 | 検索用の列に索引を足す |
| 録音中に 2 本の録音を並行して取ったときの負荷（特にスマホ） | 通しの 1 本をやめ、区切りごとのダウンロードにする |
| Workflows の 1 ステップで Gemini の応答を 60 秒待てるか | ステップを分ける |
