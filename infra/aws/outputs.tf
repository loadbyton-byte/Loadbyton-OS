output "instance_id" { value = aws_instance.app.id }
output "connect" { value = "aws ssm start-session --target ${aws_instance.app.id} --region ${var.region}" }
output "files_bucket" { value = aws_s3_bucket.files.bucket }
output "files_iam_user" { value = aws_iam_user.files.name }
output "next_steps" {
  value = <<-EOT
    1. Create an access key for the files user (kept out of Terraform state):
         aws iam create-access-key --user-name ${aws_iam_user.files.name}
    2. On the instance put it in /opt/loadbyton/.env.production:
         STORAGE_DRIVER=s3  S3_ENDPOINT=https://s3.${var.region}.amazonaws.com  S3_REGION=${var.region}  S3_BUCKET=${aws_s3_bucket.files.bucket}  S3_PATH_STYLE=false
    3. Follow docs/DEPLOY_AWS.md from "Bring the app up".
  EOT
}
