output "cloudfront_domain" {
  description = "画面の URL（https://<この値>）。独自ドメインは使わない（docs/design.md §13 #12）"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "cloudfront_distribution_id" {
  description = "aws/scripts/sync-web.sh が、キャッシュを消すのに使う"
  value       = aws_cloudfront_distribution.main.id
}

output "web_bucket" {
  description = "aws/scripts/sync-web.sh が、web/ を同期する先"
  value       = aws_s3_bucket.b["web"].bucket
}

output "api_url" {
  description = "API Gateway の URL。画面は CloudFront の /api/* 経由で使うので、直接は使わない"
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "cognito_domain" {
  description = "Cognito のドメイン。画面が /oauth2/authorize に進む先"
  value       = local.cognito_domain_url
}

output "cognito_client_id" {
  description = "Cognito のアプリクライアント ID"
  value       = aws_cognito_user_pool_client.web.id
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "google_redirect_uri" {
  description = "Google Cloud の OAuth クライアントの「承認済みのリダイレクト URI」に登録する値"
  value       = "${local.cognito_domain_url}/oauth2/idpresponse"
}

output "table_name" {
  value = aws_dynamodb_table.main.name
}

output "manual_steps" {
  description = "Terraform だけでは設定できないこと"
  value = var.enable_inbound_federation_trigger ? "なし" : join("\n", [
    "Cognito の Inbound federation トリガーを手動で設定してください。",
    "  User pool（${aws_cognito_user_pool.main.id}）> Extensions > Lambda triggers > Add Lambda trigger",
    "  > Authentication の Inbound federation > Lambda「${local.fn_name["auth"]}」を選ぶ。",
    "  設定したら enable_inbound_federation_trigger = true にする（この表示が消える）。",
    "  Terraform の AWS プロバイダーが lambda_config の inbound federation に対応したら、main.tf に足して手動設定をやめる。",
    "  未設定でも、PreSignUp と関門 3（API 側）は働くが、ログインのたびの hd の確認が抜ける（docs/design.md §9.6 の関門 2）。",
  ])
}
