terraform {
  required_version = ">= 1.9.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "state_bucket_name" {
  description = "Private R2 bucket for OpenTofu state."
  type        = string
  default     = "runmaps-tofu-state"
}

variable "r2_location" {
  description = "R2 location hint."
  type        = string
  default     = "WEUR"
}

resource "cloudflare_r2_bucket" "tofu_state" {
  account_id = var.cloudflare_account_id
  name       = var.state_bucket_name
  location   = var.r2_location
}

output "state_bucket_name" {
  value = cloudflare_r2_bucket.tofu_state.name
}
