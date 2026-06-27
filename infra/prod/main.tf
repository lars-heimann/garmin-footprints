locals {
  public_site_url_pattern = "https://${var.domain}/m/{slug}"
  worker_api_base         = "https://${var.domain}"
  dns_record_name         = trimsuffix(var.domain, ".${var.zone_name}")
}

resource "cloudflare_r2_bucket" "app" {
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_name
  location   = var.r2_location
}

resource "cloudflare_d1_database" "app" {
  account_id = var.cloudflare_account_id
  name       = var.d1_database_name

  lifecycle {
    ignore_changes = [read_replication]
  }
}

resource "cloudflare_worker" "app" {
  account_id = var.cloudflare_account_id
  name       = var.worker_name

  lifecycle {
    ignore_changes = all
  }
}

resource "cloudflare_dns_record" "root" {
  zone_id = var.cloudflare_zone_id
  name    = local.dns_record_name
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}

resource "cloudflare_workers_route" "root" {
  count   = var.create_worker_routes ? 1 : 0
  zone_id = var.cloudflare_zone_id
  pattern = "${var.domain}/*"
  script  = cloudflare_worker.app.name
}

resource "cloudflare_ruleset" "publish_rate_limits" {
  zone_id     = var.cloudflare_zone_id
  name        = "Runmaps publish API rate limits"
  description = "Blocks obvious abuse of public publishing routes before requests reach the Worker."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      ref         = "runmaps_publish_sessions_by_ip"
      description = "Limit publish session creation by IP"
      expression  = "http.host eq \"${var.domain}\" and http.request.method eq \"POST\" and http.request.uri.path eq \"/api/publish-sessions\""
      action      = "block"

      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = 600
        requests_per_period = 5
        mitigation_timeout  = 600
      }
    },
    {
      ref         = "runmaps_publish_assets_by_ip"
      description = "Limit generated asset uploads by IP"
      expression  = "http.host eq \"${var.domain}\" and http.request.method eq \"PUT\" and http.request.uri.path matches \"^/api/publish-sessions/[^/]+/assets/(meta\\\\.json|points\\\\.bin)$\""
      action      = "block"

      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = 600
        requests_per_period = 30
        mitigation_timeout  = 600
      }
    },
    {
      ref         = "runmaps_publish_complete_by_ip"
      description = "Limit publish completion attempts by IP"
      expression  = "http.host eq \"${var.domain}\" and http.request.method eq \"POST\" and http.request.uri.path matches \"^/api/publish-sessions/[^/]+/complete$\""
      action      = "block"

      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = 600
        requests_per_period = 20
        mitigation_timeout  = 600
      }
    },
  ]
}

resource "random_password" "invite_hash_secret" {
  length  = 48
  special = false
  keepers = {
    rotation_id = var.app_secret_rotation_id
  }
}

resource "random_password" "upload_token_secret" {
  length  = 48
  special = false
  keepers = {
    rotation_id = var.app_secret_rotation_id
  }
}

resource "random_password" "maintenance_token" {
  length  = 48
  special = false
  keepers = {
    rotation_id = var.app_secret_rotation_id
  }
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

resource "github_actions_secret" "invite_hash_secret" {
  repository  = var.github_repository
  secret_name = "INVITE_HASH_SECRET"
  value       = random_password.invite_hash_secret.result
}

resource "github_actions_secret" "upload_token_secret" {
  repository  = var.github_repository
  secret_name = "UPLOAD_TOKEN_SECRET"
  value       = random_password.upload_token_secret.result
}

resource "github_actions_secret" "maintenance_token" {
  repository  = var.github_repository
  secret_name = "MAINTENANCE_TOKEN"
  value       = random_password.maintenance_token.result
}

resource "github_actions_secret" "turnstile_secret_key" {
  count       = var.turnstile_secret_key == "" ? 0 : 1
  repository  = var.github_repository
  secret_name = "TURNSTILE_SECRET_KEY"
  value       = var.turnstile_secret_key
}
