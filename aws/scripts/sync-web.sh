#!/usr/bin/env bash
# 画面（web/）と共通ロジック（packages/core/src → /core/）を web バケットへ同期し、CloudFront のキャッシュを消す。
# 画面は core を /core/ から読む（ビルド無しでブラウザがそのまま読むため、同じソースを置く）。
#
# 使い方: bash aws/scripts/sync-web.sh
# 前提: aws CLI が入っていて、対象のアカウントに認証済みであること。
#       Terraform の出力から、バケット名と CloudFront の ID を読む（terraform init 済みで apply 済みのとき）。
#       出力を使わない場合は WEB_BUCKET と DISTRIBUTION_ID を環境変数で渡す。
# 今はデプロイしない段階なので、このスクリプトは実行しない（docs、CLAUDE.md の「デプロイ」）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INFRA="$ROOT/aws/infra"

if [[ -z "${WEB_BUCKET:-}" ]]; then
  WEB_BUCKET="$(terraform -chdir="$INFRA" output -raw web_bucket)"
fi
if [[ -z "${DISTRIBUTION_ID:-}" ]]; then
  DISTRIBUTION_ID="$(terraform -chdir="$INFRA" output -raw cloudfront_distribution_id)"
fi

echo "web/ -> s3://$WEB_BUCKET/"
# --delete で、消したファイルが残らないようにする。core は別の同期で置くので除外する
aws s3 sync "$ROOT/web/" "s3://$WEB_BUCKET/" --delete --exclude "core/*" \
  --cache-control "no-cache"

echo "packages/core/src -> s3://$WEB_BUCKET/core/"
aws s3 sync "$ROOT/packages/core/src/" "s3://$WEB_BUCKET/core/" --delete \
  --cache-control "no-cache" --content-type "text/javascript" --exclude "*" --include "*.js"

echo "CloudFront のキャッシュを消します: $DISTRIBUTION_ID"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*" >/dev/null
echo "完了"
