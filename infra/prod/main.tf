locals {
  public_site_url_pattern = "https://{slug}.${var.domain}"
  worker_api_base         = "https://${var.domain}"
  dns_record_name         = trimsuffix(var.domain, ".${var.zone_name}")
  wildcard_record_name    = "*.${local.dns_record_name}"
}

resource "cloudflare_r2_bucket" "app" {
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_name
  location   = var.r2_location
}

resource "cloudflare_d1_database" "app" {
  account_id = var.cloudflare_account_id
  name       = var.d1_database_name
}

resource "cloudflare_worker" "app" {
  account_id = var.cloudflare_account_id
  name       = var.worker_name
}

resource "cloudflare_dns_record" "root" {
  zone_id = var.cloudflare_zone_id
  name    = local.dns_record_name
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "wildcard" {
  zone_id = var.cloudflare_zone_id
  name    = local.wildcard_record_name
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}

resource "cloudflare_workers_route" "root" {
  zone_id = var.cloudflare_zone_id
  pattern = "${var.domain}/*"
  script  = cloudflare_worker.app.name
}

resource "cloudflare_workers_route" "wildcard" {
  zone_id = var.cloudflare_zone_id
  pattern = "*.${var.domain}/*"
  script  = cloudflare_worker.app.name
}

resource "random_password" "invite_hash_secret" {
  length  = 48
  special = false
}

resource "random_password" "upload_token_secret" {
  length  = 48
  special = false
}

resource "random_password" "processor_token" {
  length  = 48
  special = false
}

resource "github_actions_variable" "cloudflare_account_id" {
  repository    = var.github_repository
  variable_name = "CLOUDFLARE_ACCOUNT_ID"
  value         = var.cloudflare_account_id
}

resource "github_actions_variable" "cloudflare_zone_id" {
  repository    = var.github_repository
  variable_name = "CLOUDFLARE_ZONE_ID"
  value         = var.cloudflare_zone_id
}

resource "github_actions_variable" "worker_name" {
  repository    = var.github_repository
  variable_name = "WORKER_NAME"
  value         = var.worker_name
}

resource "github_actions_variable" "worker_api_base" {
  repository    = var.github_repository
  variable_name = "WORKER_API_BASE"
  value         = local.worker_api_base
}

resource "github_actions_variable" "public_host_suffix" {
  repository    = var.github_repository
  variable_name = "PUBLIC_HOST_SUFFIX"
  value         = var.domain
}

resource "github_actions_variable" "public_site_url_pattern" {
  repository    = var.github_repository
  variable_name = "PUBLIC_SITE_URL_PATTERN"
  value         = local.public_site_url_pattern
}

resource "github_actions_variable" "r2_bucket_name" {
  repository    = var.github_repository
  variable_name = "R2_BUCKET_NAME"
  value         = cloudflare_r2_bucket.app.name
}

resource "github_actions_variable" "d1_database_name" {
  repository    = var.github_repository
  variable_name = "D1_DATABASE_NAME"
  value         = cloudflare_d1_database.app.name
}

resource "github_actions_variable" "d1_database_id" {
  repository    = var.github_repository
  variable_name = "D1_DATABASE_ID"
  value         = cloudflare_d1_database.app.id
}

resource "github_actions_variable" "turnstile_site_key" {
  count         = var.turnstile_site_key == "" ? 0 : 1
  repository    = var.github_repository
  variable_name = "TURNSTILE_SITE_KEY"
  value         = var.turnstile_site_key
}

resource "github_actions_secret" "invite_hash_secret" {
  repository      = var.github_repository
  secret_name     = "INVITE_HASH_SECRET"
  plaintext_value = random_password.invite_hash_secret.result
}

resource "github_actions_secret" "upload_token_secret" {
  repository      = var.github_repository
  secret_name     = "UPLOAD_TOKEN_SECRET"
  plaintext_value = random_password.upload_token_secret.result
}

resource "github_actions_secret" "processor_token" {
  repository      = var.github_repository
  secret_name     = "PROCESSOR_TOKEN"
  plaintext_value = random_password.processor_token.result
}

resource "github_actions_secret" "turnstile_secret_key" {
  count           = var.turnstile_secret_key == "" ? 0 : 1
  repository      = var.github_repository
  secret_name     = "TURNSTILE_SECRET_KEY"
  plaintext_value = var.turnstile_secret_key
}
