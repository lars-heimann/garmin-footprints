# Runmaps Infrastructure

Production is designed for `https://runmaps.larsheimann.com` with generated maps at
`https://runmaps.larsheimann.com/m/{slug}`.

This path-based URL shape is intentional for the free Cloudflare tier. Deeper wildcard hostnames such as
`{slug}.runmaps.larsheimann.com` are not covered by Universal SSL for `larsheimann.com` and would require a paid
certificate feature or a custom certificate.

## Stacks

- `bootstrap` creates the private R2 bucket used for OpenTofu state.
- `prod` creates the app R2 bucket, D1 database, DNS records, Worker routes, generated app secrets, and GitHub Actions configuration.

The infrastructure supports browser-first publish sessions for derived map assets; it does not provision backend Garmin ZIP processing.

The first unavoidable manual step is providing credentials to OpenTofu/GitHub Actions:

- `CLOUDFLARE_API_TOKEN` with scoped access to the account and `larsheimann.com` zone.
- `GH_ADMIN_TOKEN` for the GitHub provider to manage repository Actions secrets and variables.
- R2 S3 credentials for the OpenTofu state backend.
- A temporary invite-code secret such as `NEXT_INVITE_CODE` before running the invite workflow.

Turnstile is optional for local development but recommended for production publishing:

- `TURNSTILE_SITE_KEY` as a repository Actions variable.
- `TURNSTILE_SECRET_KEY` as a repository Actions secret.

No processor-dispatch GitHub token is needed. No R2 direct-upload credentials are needed for app users because Garmin ZIPs are parsed in the browser and never uploaded.

After bootstrap, CI can run plan/apply, migrations, Worker deploy, smoke tests, invite creation, and scheduled cleanup without dashboard clicks.

## Bootstrap

```sh
cd infra/bootstrap
tofu init
tofu apply \
  -var cloudflare_account_id="$CLOUDFLARE_ACCOUNT_ID" \
  -var state_bucket_name="runmaps-tofu-state"
```

Copy `infra/prod/backend.example.hcl` to a secure local/CI backend config and fill in the account-specific R2 S3 endpoint and credentials.

## Production

```sh
cd infra/prod
tofu init -backend-config=backend.hcl
tofu plan
tofu apply
```

The deploy workflow reads OpenTofu outputs, writes a temporary Wrangler config, runs D1 migrations, uploads Worker secrets, and deploys the Worker/static assets. Worker routes are applied after the Wrangler deploy step because Cloudflare rejects routes for a script that has not been uploaded yet.

Seed these GitHub Actions variables manually before running the workflow because they are inputs to OpenTofu itself:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`
- `TOFU_STATE_BUCKET`
- `TURNSTILE_SITE_KEY`, if Turnstile is enabled

OpenTofu creates these runtime secrets automatically:

- `INVITE_HASH_SECRET`
- `UPLOAD_TOKEN_SECRET`, used for publish and delete-token signatures
- `MAINTENANCE_TOKEN`, used by scheduled cleanup

## Invite Codes

Create invite codes by storing the plaintext code in a repository Actions secret and passing only the secret name to the `Create Invite` workflow:

```sh
INVITE_CODE="RUN-$(openssl rand -hex 8 | tr '[:lower:]' '[:upper:]')"
SECRET_NAME="RUNMAPS_INVITE_$(date +%Y%m%d_%H%M%S)"
printf %s "$INVITE_CODE" | gh secret set "$SECRET_NAME" --app actions
gh workflow run create-invite.yml --ref main \
  -f codeSecretName="$SECRET_NAME" \
  -f label="Friends" \
  -f maxUses=200
sleep 3
RUN_ID=$(gh run list --workflow create-invite.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

The workflow masks the plaintext code, hashes it with `INVITE_HASH_SECRET`, and inserts only the hash plus a readable label into D1. Do not pass plaintext invite codes as workflow-dispatch inputs or expect to recover them later from GitHub or D1.
