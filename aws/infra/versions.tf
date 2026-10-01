terraform {
  # use_lockfile（S3 だけでロックする。DynamoDB の表が要らない）のため 1.10 以上
  required_version = ">= 1.10.0"

  # 状態は S3 に置く。バケット名・キー・リージョンは init 時に渡す:
  #   terraform init -backend-config="bucket=hyper-sfa-terraform-state-<account>" \
  #                  -backend-config="key=prod/terraform.tfstate" -backend-config="region=ap-northeast-1"
  # バケットは aws/infra/bootstrap/github-deploy.yaml（CloudFormation）が作る
  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      # user_pool_tier（Cognito の Essentials）を使うため 5.80 以上
      version = ">= 5.80.0, < 7.0.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
  }
}

provider "aws" {
  region = "ap-northeast-1"

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.env
      ManagedBy   = "terraform"
    }
  }
}
