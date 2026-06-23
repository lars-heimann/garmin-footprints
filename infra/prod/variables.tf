variable "cloudflare_account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for larsheimann.com."
  type        = string
}

variable "github_owner" {
  description = "GitHub owner or organization."
  type        = string
}

variable "github_repository" {
  description = "GitHub repository name."
  type        = string
  default     = "garmin-footprints"
}

variable "zone_name" {
  description = "Apex DNS zone."
  type        = string
  default     = "larsheimann.com"
}

variable "domain" {
  description = "Upload app domain."
  type        = string
  default     = "runmaps.larsheimann.com"
}

variable "worker_name" {
  description = "Cloudflare Worker script name."
  type        = string
  default     = "garmin-footprints"
}

variable "r2_bucket_name" {
  description = "Private app R2 bucket."
  type        = string
  default     = "runmaps-app"
}

variable "d1_database_name" {
  description = "D1 database name."
  type        = string
  default     = "runmaps"
}

variable "r2_location" {
  description = "R2 location hint."
  type        = string
  default     = "WEUR"
}

variable "turnstile_site_key" {
  description = "Optional existing Cloudflare Turnstile site key."
  type        = string
  default     = ""
}

variable "turnstile_secret_key" {
  description = "Optional existing Cloudflare Turnstile secret key."
  type        = string
  default     = ""
  sensitive   = true
}
