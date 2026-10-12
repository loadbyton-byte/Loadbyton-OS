variable "region" {
  type        = string
  description = "AWS region. ap-south-1 (Mumbai) is closest to the builders; me-central-1 (UAE) is closest to customers but costs more and must be enabled for the account."
  default     = "ap-south-1"
}
variable "environment" {
  type    = string
  default = "prod"
}
variable "instance_type" {
  type        = string
  description = "t4g.medium (4 GB) runs the app, worker, malware scanner and tunnel. t4g.small (2 GB) works only without the scanner."
  default     = "t4g.medium"
}
variable "disk_gb" {
  type    = number
  default = 30
}
variable "alert_email" {
  type        = string
  description = "Where alarms and budget notices go."
}
variable "monthly_budget_usd" {
  type        = number
  description = "Budget alert threshold for real spend, credits excluded."
  default     = 40
}
variable "backup_bucket_name" {
  type        = string
  description = "Name of the append-only bucket created by backup-account/ in the second AWS account. Empty = no offsite backup user."
  default     = ""
}
