output "r2_bucket_name" {
  value = cloudflare_r2_bucket.app.name
}

output "d1_database_name" {
  value = cloudflare_d1_database.app.name
}

output "d1_database_id" {
  value = cloudflare_d1_database.app.id
}

output "worker_name" {
  value = cloudflare_worker.app.name
}

output "worker_api_base" {
  value = local.worker_api_base
}

output "public_host_suffix" {
  value = var.domain
}

output "public_site_url_pattern" {
  value = local.public_site_url_pattern
}

output "invite_hash_secret" {
  value     = random_password.invite_hash_secret.result
  sensitive = true
}

output "upload_token_secret" {
  value     = random_password.upload_token_secret.result
  sensitive = true
}

output "processor_token" {
  value     = random_password.processor_token.result
  sensitive = true
}
