# Run this in your SECOND AWS account. It creates an append-only bucket for encrypted backups: the production account's backup user
# can add objects but can never delete or overwrite them, so a compromised production server cannot destroy its own backups.
terraform {
  required_version = ">= 1.6.0"
  required_providers { aws = { source = "hashicorp/aws", version = ">= 5.40" } }
}
variable "region" {
  type    = string
  default = "ap-south-1"
}
variable "production_account_id" {
  type        = string
  description = "12-digit id of the account that runs the application."
}
variable "production_backup_user" {
  type        = string
  description = "IAM user name in the production account that uploads backups."
  default     = "loadbyton-prod-backup"
}
provider "aws" { region = var.region }
data "aws_caller_identity" "me" {}
locals { bucket = "loadbyton-backups-${data.aws_caller_identity.me.account_id}" }

resource "aws_s3_bucket" "backups" {
  bucket              = local.bucket
  object_lock_enabled = true
}
resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "AES256" } }
}
resource "aws_s3_bucket_object_lock_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = 30
    }
  }
  depends_on = [aws_s3_bucket_versioning.backups]
}
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire-after-90-days"
    status = "Enabled"
    filter {}
    expiration { days = 90 }
    noncurrent_version_expiration { noncurrent_days = 7 }
  }
  depends_on = [aws_s3_bucket_versioning.backups]
}
data "aws_iam_policy_document" "write_only" {
  statement {
    sid       = "ProductionMayAddBackups"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.production_account_id}:user/${var.production_backup_user}"]
    }
  }
  statement {
    sid       = "NoOneDeletesFromTheWire"
    effect    = "Deny"
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutBucketPolicy"]
    resources = ["${aws_s3_bucket.backups.arn}/*", aws_s3_bucket.backups.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.production_account_id}:root"]
    }
  }
}
resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id
  policy = data.aws_iam_policy_document.write_only.json
}
output "backup_bucket" { value = aws_s3_bucket.backups.bucket }
