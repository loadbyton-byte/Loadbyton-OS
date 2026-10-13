output "instance_id" { value = aws_instance.app.id }
output "connect" { value = "aws ssm start-session --target ${aws_instance.app.id} --region ${var.region}" }
output "files_bucket" { value = try(aws_s3_bucket.files[0].bucket, "none (using R2)") }
output "next_steps" {
  value = <<-EOT
    1. Connect:  aws ssm start-session --target ${aws_instance.app.id} --region ${var.region}
    2. Follow docs/DEPLOY_AWS_LEAN.md from step "Bring the app up". Files go to Cloudflare R2, the database to Supabase.
  EOT
}
output "github_deploy_role_arn" { value = try(aws_iam_role.deploy[0].arn, "") }
