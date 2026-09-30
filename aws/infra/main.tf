# hyper-sfa（AWS 版）。構成は docs/design.md §2、権限は §9.5、ログインは §9.6。
#
# 事前に `npm run build:aws` で aws/lambdas/*/build/index.mjs を作っておくこと（archive_file がその中身を zip にする）。
# 依存の向き（循環しないように）:
#   API Gateway の API 本体 → CloudFront → Cognito のアプリクライアント → Lambda → API Gateway の統合とルート
# CloudFront が API 本体だけを見て、ルートや Lambda を見ないので、CloudFront のドメインを Cognito と Lambda の環境変数に渡せる。

data "aws_caller_identity" "current" {}

locals {
  name       = "${var.project}-${var.env}"
  region     = "ap-northeast-1"
  account_id = data.aws_caller_identity.current.account_id

  bucket_keys  = ["web", "images", "audio", "data", "exports"]
  lambda_names = ["app", "console", "auth", "scan", "minutes"]
  worker_names = ["app", "console", "scan", "minutes"] # auth は Cognito が作られる前に要るので別のリソースにする（循環を避けるため）

  # Lambda どうしの参照は、リソースの属性ではなく決まった名前で書く（同じリソースの中での循環を避けるため）
  fn_name = { for n in local.lambda_names : n => "${local.name}-${n}" }
  fn_arn  = { for n in local.lambda_names : n => "arn:aws:lambda:${local.region}:${local.account_id}:function:${local.name}-${n}" }

  lambda_cfg = {
    app     = { memory = 1024, timeout = 30, ephemeral = 512 } # 検索用の一覧をメモリに持つ（docs/design.md §7）
    console = { memory = 512, timeout = 30, ephemeral = 512 }
    auth    = { memory = 256, timeout = 5, ephemeral = 512 } # Cognito のトリガーは 5 秒で打ち切られる
    scan    = { memory = 1024, timeout = 120, ephemeral = 512 }
    minutes = { memory = 2048, timeout = 900, ephemeral = 2048 }
  }

  app_origin = "https://${aws_cloudfront_distribution.main.domain_name}"

  cognito_domain_prefix = "${local.name}-${local.account_id}"
  cognito_domain_url    = "https://${local.cognito_domain_prefix}.auth.${local.region}.amazoncognito.com"
  cognito_issuer        = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"

  ddb_item_actions = [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:Query",
    "dynamodb:BatchGetItem",
    "dynamodb:ConditionCheckItem",
  ]
  ddb_resources = [aws_dynamodb_table.main.arn, "${aws_dynamodb_table.main.arn}/index/*"]

  # 名刺の内容を環境変数に入れない。ここにあるのは場所と名前だけ
  env_base = {
    TABLE_NAME    = aws_dynamodb_table.main.name
    IMAGE_BUCKET  = aws_s3_bucket.b["images"].bucket
    AUDIO_BUCKET  = aws_s3_bucket.b["audio"].bucket
    DATA_BUCKET   = aws_s3_bucket.b["data"].bucket
    EXPORT_BUCKET = aws_s3_bucket.b["exports"].bucket
  }

  lambda_env = {
    app = merge(local.env_base, {
      SCAN_FUNCTION_NAME    = local.fn_name["scan"]
      MINUTES_FUNCTION_NAME = local.fn_name["minutes"]
      COGNITO_DOMAIN        = local.cognito_domain_url
      COGNITO_CLIENT_ID     = aws_cognito_user_pool_client.web.id
      APP_ORIGIN            = local.app_origin
    })
    console = merge(local.env_base, {
      API_KEYS_SECRET_ARN   = aws_secretsmanager_secret.api_keys.arn
      SCAN_FUNCTION_NAME    = local.fn_name["scan"]
      MINUTES_FUNCTION_NAME = local.fn_name["minutes"]
      COGNITO_USER_POOL_ID  = aws_cognito_user_pool.main.id
      ALLOWED_HD            = var.allowed_hd
    })
    auth = {
      TABLE_NAME = aws_dynamodb_table.main.name
      ALLOWED_HD = var.allowed_hd
    }
    scan = merge(local.env_base, {
      API_KEYS_SECRET_ARN = aws_secretsmanager_secret.api_keys.arn
    })
    minutes = merge(local.env_base, {
      API_KEYS_SECRET_ARN = aws_secretsmanager_secret.api_keys.arn
      FFMPEG_PATH         = "/opt/bin/ffmpeg"
    })
  }
}

# ---------------------------------------------------------------------------
# DynamoDB（単一テーブル。docs/design.md §6.1、docs/minutes-design.md §10.1）
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "main" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  attribute {
    name = "gsi2pk"
    type = "S"
  }
  attribute {
    name = "gsi2sk"
    type = "S"
  }

  # 検索用の一覧。検索と一覧表示に使う項目だけを含める（rawText や extraction の細部は含めない）
  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "INCLUDE"
    non_key_attributes = [
      "id", "status", "company", "department", "name", "nameReading",
      "phones", "mobiles", "emails", "note", "keys", "deptIds",
      "imageFrontKey", "imageBackKey", "thumbKey", "failure", "deletedAt",
      "createdBy", "createdByName", "createdByPosition", "createdByDeptIds", "createdAt",
      "updatedBy", "updatedByName", "updatedAt", "editCount", "scanCount", "version", "extraction",
    ]
  }

  # 履歴（月ごとに新しい順）と、議事録の利用の記録（ユーザーごと）
  global_secondary_index {
    name            = "gsi2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  deletion_protection_enabled = var.env == "prod"
}

# 最初の開発者。この人がログインして、ほかの人を登録する（docs/design.md §9.6）。
# 以後の変更（ログイン日時、役職の変更など）をアプリが書くので、Terraform は作るだけで追いかけない。
resource "aws_dynamodb_table_item" "initial_developer" {
  table_name = aws_dynamodb_table.main.name
  hash_key   = "pk"
  range_key  = "sk"

  item = jsonencode({
    pk           = { S = "ORG" }
    sk           = { S = "USER#${lower(var.initial_developer_email)}" }
    email        = { S = lower(var.initial_developer_email) }
    position     = { S = "開発者" }
    status       = { S = "active" }
    deptIds      = { L = [] }
    registeredBy = { S = "terraform" }
    registeredAt = { S = "2026-01-01T00:00:00.000Z" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

# ---------------------------------------------------------------------------
# S3（すべて公開を止め、暗号化し、TLS を強制する。docs/design.md §6.2）
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "b" {
  for_each = toset(local.bucket_keys)
  bucket   = "${local.name}-${each.key}-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "b" {
  for_each                = aws_s3_bucket.b
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "bucket" {
  for_each = aws_s3_bucket.b

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # 画面のバケットは CloudFront（OAC）からだけ読める
  dynamic "statement" {
    for_each = each.key == "web" ? [1] : []

    content {
      sid       = "AllowCloudFrontRead"
      effect    = "Allow"
      actions   = ["s3:GetObject"]
      resources = ["${each.value.arn}/*"]

      principals {
        type        = "Service"
        identifiers = ["cloudfront.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "AWS:SourceArn"
        values   = [aws_cloudfront_distribution.main.arn]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id
  policy   = data.aws_iam_policy_document.bucket[each.key].json

  depends_on = [aws_s3_bucket_public_access_block.b]
}

# 名刺画像は過去の版を残す（誤って上書きしたときに戻せるように）
resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.b["images"].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket = aws_s3_bucket.b["images"].id

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.images]
}

# 音声は 7 日で削除（バージョニングは付けない。消したものが残らないように。docs/minutes-design.md §6.2）
resource "aws_s3_bucket_lifecycle_configuration" "audio" {
  bucket = aws_s3_bucket.b["audio"].id

  rule {
    id     = "expire-minutes-audio"
    status = "Enabled"

    filter {
      prefix = "minutes/"
    }

    expiration {
      days = 7
    }
  }

  # 開発コンソールの「試し」用の音声
  rule {
    id     = "expire-test-audio"
    status = "Enabled"

    filter {
      prefix = "tests/"
    }

    expiration {
      days = 1
    }
  }

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.b["exports"].id

  rule {
    id     = "expire-exports"
    status = "Enabled"

    filter {}

    expiration {
      days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# ブラウザから署名付き URL で直接 PUT / GET する。オリジンは画面と同じ CloudFront のドメイン
resource "aws_s3_bucket_cors_configuration" "browser_io" {
  for_each = toset(["images", "audio"])
  bucket   = aws_s3_bucket.b[each.key].id

  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = concat([local.app_origin], var.extra_cors_origins)
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# ---------------------------------------------------------------------------
# Secrets Manager（API キー。値は開発コンソールから入れる。docs/design.md §11）
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "api_keys" {
  name                    = "${local.name}/api-keys"
  description             = "Gemini / OpenAI の API キー（JSON）。値は開発コンソールから入れる"
  recovery_window_in_days = var.env == "prod" ? 30 : 7
}

resource "aws_secretsmanager_secret_version" "api_keys" {
  secret_id     = aws_secretsmanager_secret.api_keys.id
  secret_string = jsonencode({ gemini = "", openai = "" })

  # 開発コンソールが書いた値を Terraform が消さない
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# Lambda（app / console / auth / scan / minutes）
# ---------------------------------------------------------------------------

data "archive_file" "lambda" {
  for_each    = toset(local.lambda_names)
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/${each.key}/build"
  output_path = "${path.module}/.terraform/zips/${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = toset(local.lambda_names)
  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = 30
}

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "fn" {
  for_each           = toset(local.lambda_names)
  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

# ログの書き込み。ログ グループは上で作るので、ストリームの作成と書き込みだけを許す
data "aws_iam_policy_document" "logs" {
  for_each = toset(local.lambda_names)

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.fn[each.key].arn}:*"]
  }
}

resource "aws_iam_role_policy" "logs" {
  for_each = toset(local.lambda_names)
  name     = "logs"
  role     = aws_iam_role.fn[each.key].id
  policy   = data.aws_iam_policy_document.logs[each.key].json
}

# Lambda ごとの権限（docs/design.md §9.5、docs/minutes-design.md §11）。
# 分けているのは権限を絞るため。API キーを読めるのは console / scan / minutes だけ、書けるのは console だけ。
data "aws_iam_policy_document" "app" {
  statement {
    sid       = "Dynamo"
    actions   = local.ddb_item_actions
    resources = local.ddb_resources
  }
  statement {
    sid     = "Images"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [
      "${aws_s3_bucket.b["images"].arn}/*",
      "${aws_s3_bucket.b["audio"].arn}/*",
      "${aws_s3_bucket.b["data"].arn}/*",
    ]
  }
  statement {
    sid     = "List"
    actions = ["s3:ListBucket"]
    resources = [
      aws_s3_bucket.b["audio"].arn,
      aws_s3_bucket.b["data"].arn,
    ]
  }
  statement {
    sid       = "InvokeWorkers"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.fn_arn["scan"], local.fn_arn["minutes"]]
  }
}

data "aws_iam_policy_document" "console" {
  statement {
    sid       = "Dynamo"
    actions   = local.ddb_item_actions
    resources = local.ddb_resources
  }
  statement {
    sid       = "Exports"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.b["exports"].arn}/*"]
  }
  statement {
    sid       = "ApiKeys"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
    resources = [aws_secretsmanager_secret.api_keys.arn]
  }
  statement {
    sid       = "CognitoUsers"
    actions   = ["cognito-idp:ListUsers", "cognito-idp:AdminDisableUser", "cognito-idp:AdminEnableUser", "cognito-idp:AdminUserGlobalSignOut"]
    resources = [aws_cognito_user_pool.main.arn]
  }
  statement {
    sid       = "InvokeWorkers"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.fn_arn["scan"], local.fn_arn["minutes"]]
  }
}

data "aws_iam_policy_document" "auth" {
  statement {
    sid       = "UserLookupAndLoginRecord"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.main.arn]
  }
}

data "aws_iam_policy_document" "scan" {
  statement {
    sid       = "Dynamo"
    actions   = local.ddb_item_actions
    resources = local.ddb_resources
  }
  statement {
    sid       = "ImagesRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.b["images"].arn}/*"]
  }
  statement {
    sid       = "ApiKeysRead"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.api_keys.arn]
  }
}

data "aws_iam_policy_document" "minutes" {
  statement {
    sid       = "Dynamo"
    actions   = local.ddb_item_actions
    resources = local.ddb_resources
  }
  statement {
    sid       = "AudioAndText"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.b["audio"].arn}/*", "${aws_s3_bucket.b["data"].arn}/*"]
  }
  statement {
    sid       = "List"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.b["audio"].arn, aws_s3_bucket.b["data"].arn]
  }
  statement {
    sid       = "ApiKeysRead"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.api_keys.arn]
  }
}

locals {
  lambda_policy_json = {
    app     = data.aws_iam_policy_document.app.json
    console = data.aws_iam_policy_document.console.json
    auth    = data.aws_iam_policy_document.auth.json
    scan    = data.aws_iam_policy_document.scan.json
    minutes = data.aws_iam_policy_document.minutes.json
  }
}

resource "aws_iam_role_policy" "fn" {
  for_each = toset(local.lambda_names)
  name     = "access"
  role     = aws_iam_role.fn[each.key].id
  policy   = local.lambda_policy_json[each.key]
}

# ffmpeg の layer（省略可）。議事録のダウンロード用の音声を作るときだけ使う
resource "aws_lambda_layer_version" "ffmpeg" {
  count                    = var.ffmpeg_layer_zip != "" ? 1 : 0
  layer_name               = "${local.name}-ffmpeg"
  filename                 = var.ffmpeg_layer_zip
  source_code_hash         = filebase64sha256(var.ffmpeg_layer_zip)
  compatible_architectures = ["arm64"]
  compatible_runtimes      = ["nodejs22.x"]
}

# auth は Cognito のユーザープールから参照され、ほかの Lambda はユーザープールを参照する。
# 同じリソースにまとめると循環するので、auth だけ別のリソースにしている。
resource "aws_lambda_function" "auth" {
  function_name    = local.fn_name["auth"]
  role             = aws_iam_role.fn["auth"].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.lambda["auth"].output_path
  source_code_hash = data.archive_file.lambda["auth"].output_base64sha256
  memory_size      = local.lambda_cfg["auth"].memory
  timeout          = local.lambda_cfg["auth"].timeout

  ephemeral_storage {
    size = local.lambda_cfg["auth"].ephemeral
  }

  environment {
    variables = local.lambda_env["auth"]
  }

  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy.logs]
}

resource "aws_lambda_function" "fn" {
  for_each = toset(local.worker_names)

  function_name    = local.fn_name[each.key]
  role             = aws_iam_role.fn[each.key].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.lambda[each.key].output_path
  source_code_hash = data.archive_file.lambda[each.key].output_base64sha256
  memory_size      = local.lambda_cfg[each.key].memory
  timeout          = local.lambda_cfg[each.key].timeout
  layers           = each.key == "minutes" && var.ffmpeg_layer_zip != "" ? [aws_lambda_layer_version.ffmpeg[0].arn] : []

  ephemeral_storage {
    size = local.lambda_cfg[each.key].ephemeral
  }

  environment {
    variables = local.lambda_env[each.key]
  }

  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy.logs]
}

# ---------------------------------------------------------------------------
# Cognito（Google でのログインだけ。docs/design.md §9.6）
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool" "main" {
  name                = local.name
  user_pool_tier      = "ESSENTIALS"
  deletion_protection = var.env == "prod" ? "ACTIVE" : "INACTIVE"

  # 利用者自身によるアカウント作成は無効。Google の連携ユーザーは Lambda「auth」を通ったときだけ作られる
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  # Lambda「auth」が ID トークンの hd を入れる（custom:hd）
  schema {
    name                     = "hd"
    attribute_data_type      = "String"
    mutable                  = true
    required                 = false
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 0
      max_length = 256
    }
  }

  lambda_config {
    pre_sign_up          = aws_lambda_function.auth.arn
    pre_authentication   = aws_lambda_function.auth.arn
    pre_token_generation = aws_lambda_function.auth.arn

    # Inbound federation（Google から戻った直後に hd を確かめる）は、使っている Terraform の AWS プロバイダーが
    # lambda_config にこの項目を持つまで、ここに書けない。プロバイダーが対応するまでは、
    # Cognito のコンソール（User pool > Extensions > Lambda triggers > Inbound federation）で、
    # Lambda「auth」を手動で設定する。設定したら variables の enable_inbound_federation_trigger を true にする。
    # 対応版になったら、ここに inbound_federation を足す（outputs の manual_steps に手順）。
  }

  # カスタム属性のスキーマは作成後に変えられず、プロバイダーが毎回差分を出すことがあるので追いかけない
  lifecycle {
    ignore_changes = [schema]
  }
}

resource "aws_lambda_permission" "cognito_auth" {
  statement_id  = "AllowCognito"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}

resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    email    = "email"
    name     = "name"
    username = "sub"
  }

  lifecycle {
    ignore_changes = [provider_details["client_secret"]]
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = local.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.name}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  # ブラウザの画面が PKCE で使う。シークレットは持てない
  generate_secret = false

  supported_identity_providers         = ["Google"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = concat(["${local.app_origin}/auth/callback"], var.extra_callback_urls)
  logout_urls                          = [local.app_origin]

  # パスワードでのログインは持たない。トークンの更新だけ
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED"

  depends_on = [aws_cognito_identity_provider.google]
}

# ---------------------------------------------------------------------------
# API Gateway（HTTP API。JWT の検証はここに任せる）
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "main" {
  name          = local.name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.main.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.web.id]
    issuer   = local.cognito_issuer
  }
}

resource "aws_apigatewayv2_integration" "fn" {
  for_each               = toset(["app", "console"])
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn[each.key].invoke_arn
  payload_format_version = "2.0"
}

locals {
  # 具体的なパスが優先される。/api/config だけは認証なし（画面が最初に読む）
  routes = {
    "GET /api/config"         = { target = "app", auth = false }
    "ANY /api/{proxy+}"       = { target = "app", auth = true }
    "ANY /api/admin/{proxy+}" = { target = "console", auth = true }
    "ANY /api/dev/{proxy+}"   = { target = "console", auth = true }
  }
}

resource "aws_apigatewayv2_route" "r" {
  for_each           = local.routes
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.fn[each.value.target].id}"
  authorization_type = each.value.auth ? "JWT" : "NONE"
  authorizer_id      = each.value.auth ? aws_apigatewayv2_authorizer.jwt.id : null
}

# アクセスログは付けない（パスやクエリに名刺の検索語が入るため）
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }
}

resource "aws_lambda_permission" "apigw" {
  for_each      = toset(["app", "console"])
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# CloudFront（画面は S3、/api/* は API Gateway。docs/design.md §2）
# ---------------------------------------------------------------------------

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

# Authorization を含む、Host 以外のヘッダー・Cookie・クエリをそのまま API Gateway に渡す
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# SPA: ファイルの拡張子が無いパス（/auth/callback、/cards/123 など）は index.html を返す。
# 403 / 404 を index.html に置き換える方式だと、/api/* の 403 / 404（権限なし、見つからない）まで
# 画面の HTML に化けるので、画面のバケットの振る舞いにだけ効くこの関数にしている。
resource "aws_cloudfront_function" "spa" {
  name    = "${local.name}-spa"
  runtime = "cloudfront-js-2.0"
  publish = true
  comment = "拡張子の無いパスを /index.html にする"
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      if (uri.charAt(uri.length - 1) === '/' || uri.indexOf('.') === -1) {
        request.uri = '/index.html';
      }
      return request;
    }
  EOT
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = local.name
  default_root_object = "index.html"
  price_class         = var.cloudfront_price_class
  http_version        = "http2and3"
  wait_for_deployment = false

  origin {
    origin_id                = "web"
    domain_name              = aws_s3_bucket.b["web"].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id   = "api"
    domain_name = replace(aws_apigatewayv2_api.main.api_endpoint, "https://", "")

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
