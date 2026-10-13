# LOAD|BY|TON.store on AWS (lean): one ARM instance running the same docker compose stack as Oracle, an S3 bucket for uploaded documents, and
# alarms. Everything else stays as before (Cloudflare tunnel, Neon/Supabase PostgreSQL, Upstash, Stripe/Razorpay).
# Written for Terraform >= 1.6 and the AWS provider 5.x/6.x. Not applied by anyone yet: run `terraform plan` and read it first.
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { app = "loadbyton", env = var.environment, managed_by = "terraform" } }
}

data "aws_caller_identity" "me" {}
data "aws_vpc" "default" { default = true }
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}
# Ubuntu 24.04 LTS for Graviton (ARM), resolved through Canonical's public SSM parameter so it is always the current image.
data "aws_ssm_parameter" "ubuntu" { name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id" }

locals {
  name   = "loadbyton-${var.environment}"
  bucket = "${local.name}-files-${data.aws_caller_identity.me.account_id}"
}

# ── network: no inbound ports at all. Visitors arrive through the Cloudflare tunnel (outbound connection from the instance); operators use SSM Session Manager.
resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "No inbound. Egress only (tunnel, database, providers)."
  vpc_id      = data.aws_vpc.default.id
  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

# ── identity: SSM for shell access and patching, CloudWatch agent for disk/memory, nothing else.
data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "app" {
  name               = "${local.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy_attachment" "cw" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}
resource "aws_iam_instance_profile" "app" {
  name = "${local.name}-instance"
  role = aws_iam_role.app.name
}

# ── compute
resource "aws_instance" "app" {
  ami                         = nonsensitive(data.aws_ssm_parameter.ubuntu.value)
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  user_data                   = file("${path.module}/cloud-init.yaml")
  user_data_replace_on_change = false
  monitoring                  = false
  root_block_device {
    volume_type = "gp3"
    volume_size = var.disk_gb
    encrypted   = true
  }
  metadata_options {
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 1
  }
  tags = { Name = local.name }
  lifecycle { ignore_changes = [ami, user_data] }
}

# ── object storage for uploaded documents (the app's S3 driver speaks plain SigV4; keys are created by hand, not in Terraform state)
resource "aws_s3_bucket" "files" {
  count  = var.create_files_bucket ? 1 : 0
  bucket = local.bucket
}
resource "aws_s3_bucket_public_access_block" "files" {
  count                   = var.create_files_bucket ? 1 : 0
  bucket                  = aws_s3_bucket.files[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  count  = var.create_files_bucket ? 1 : 0
  bucket = aws_s3_bucket.files[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_s3_bucket_versioning" "files" {
  count  = var.create_files_bucket ? 1 : 0
  bucket = aws_s3_bucket.files[0].id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_lifecycle_configuration" "files" {
  count  = var.create_files_bucket ? 1 : 0
  bucket = aws_s3_bucket.files[0].id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 3 }
  }
}
data "aws_iam_policy_document" "files_only" {
  count = var.create_files_bucket ? 1 : 0
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.files[0].arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.files[0].arn]
  }
}
resource "aws_iam_user" "files" {
  count = var.create_files_bucket ? 1 : 0
  name  = "${local.name}-files"
}
resource "aws_iam_user_policy" "files" {
  count  = var.create_files_bucket ? 1 : 0
  name   = "files-bucket-only"
  user   = aws_iam_user.files[0].name
  policy = data.aws_iam_policy_document.files_only[0].json
}

# ── alerts: an e-mail when the instance fails its checks, and when real spend (credits excluded) passes a limit
resource "aws_sns_topic" "alerts" { name = "${local.name}-alerts" }
resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
resource "aws_cloudwatch_metric_alarm" "status" {
  alarm_name          = "${local.name}-status-check"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 60
  evaluation_periods  = 3
  dimensions          = { InstanceId = aws_instance.app.id }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "recover" {
  alarm_name          = "${local.name}-auto-recover"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 60
  evaluation_periods  = 2
  dimensions          = { InstanceId = aws_instance.app.id }
  alarm_actions       = [aws_sns_topic.alerts.arn, "arn:aws:automate:${var.region}:ec2:recover"]
}
resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  cost_types { include_credit = false }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

# ── offsite backups into the second account (see backup-account/). The user can add objects there and nothing else.
resource "aws_iam_user" "backup" {
  count = var.backup_bucket_name == "" ? 0 : 1
  name  = "${local.name}-backup"
}
data "aws_iam_policy_document" "backup_put" {
  count = var.backup_bucket_name == "" ? 0 : 1
  statement {
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.backup_bucket_name}/*"]
  }
}
resource "aws_iam_user_policy" "backup" {
  count  = var.backup_bucket_name == "" ? 0 : 1
  name   = "put-backups-only"
  user   = aws_iam_user.backup[0].name
  policy = data.aws_iam_policy_document.backup_put[0].json
}

# ── GitHub Actions deploys: OIDC role that may only run commands on this one instance, only from the main branch / production environment.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_repo != "" && var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
data "aws_iam_openid_connect_provider" "github" {
  count = var.github_repo != "" && !var.create_github_oidc_provider ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
}
locals {
  github_oidc_arn = var.github_repo == "" ? "" : try(aws_iam_openid_connect_provider.github[0].arn, data.aws_iam_openid_connect_provider.github[0].arn)
}
data "aws_iam_policy_document" "deploy_trust" {
  count = var.github_repo == "" ? 0 : 1
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:environment:production"]
    }
  }
}
resource "aws_iam_role" "deploy" {
  count              = var.github_repo == "" ? 0 : 1
  name               = "${local.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_trust[0].json
}
data "aws_iam_policy_document" "deploy" {
  count = var.github_repo == "" ? 0 : 1
  statement {
    actions = ["ssm:SendCommand"]
    resources = [
      "arn:aws:ec2:${var.region}:${data.aws_caller_identity.me.account_id}:instance/${aws_instance.app.id}",
      "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
    ]
  }
  statement {
    actions   = ["ssm:GetCommandInvocation"]
    resources = ["*"]
  }
}
resource "aws_iam_role_policy" "deploy" {
  count  = var.github_repo == "" ? 0 : 1
  name   = "run-deploy-command"
  role   = aws_iam_role.deploy[0].id
  policy = data.aws_iam_policy_document.deploy[0].json
}
