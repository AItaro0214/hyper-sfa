variable "project" {
  description = "リソース名の先頭に付ける名前"
  type        = string
  default     = "hyper-sfa"
}

variable "env" {
  description = "環境名（prod / stg など）。本番と検証をこの値で分ける"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]{1,12}$", var.env))
    error_message = "env は小文字英数字とハイフンの 12 文字以内にしてください。"
  }
}

variable "google_client_id" {
  description = "Google の OAuth クライアント ID（Google Cloud のコンソールで作る。手順は aws/README.md）"
  type        = string
}

variable "google_client_secret" {
  description = "Google の OAuth クライアントシークレット。リポジトリに入れず、GitHub Actions の Secrets などから渡す"
  type        = string
  sensitive   = true
}

variable "allowed_hd" {
  description = "会社の Google Workspace のドメイン（例 example.co.jp）。ID トークンの hd がこれと違えば Lambda「auth」が拒否する"
  type        = string
}

variable "initial_developer_email" {
  description = "最初の開発者のメールアドレス。この人がログインして、ほかの人を管理コンソールで登録する"
  type        = string
}

variable "ffmpeg_layer_zip" {
  description = "ffmpeg（arm64 の静的ビルド）を /opt/bin/ffmpeg に置いた layer の zip のパス。空なら layer を作らない（議事録のダウンロード用の音声が作れないだけで、文字起こしと議事録は動く）"
  type        = string
  default     = ""
}

variable "enable_inbound_federation_trigger" {
  description = "Cognito の Inbound federation トリガー（Google から戻った直後に hd を確かめる）を Terraform で設定できる版のプロバイダーを使っているか。現状は false のままにして手動で設定する（outputs の manual_steps を参照）"
  type        = bool
  default     = false
}

variable "extra_cors_origins" {
  description = "画像・音声バケットの CORS に足すオリジン（開発中の localhost など）。CloudFront のドメインは自動で入る"
  type        = list(string)
  default     = []
}

variable "extra_callback_urls" {
  description = "Cognito のアプリクライアントに足すコールバック URL（開発中の http://localhost:8787/auth/callback など）。CloudFront の /auth/callback は自動で入る"
  type        = list(string)
  default     = []
}

variable "cloudfront_price_class" {
  description = "CloudFront の価格クラス。日本の利用者だけなら PriceClass_200 で足りる"
  type        = string
  default     = "PriceClass_200"
}
