# Run Maps Infrastructure

Production is designed for `https://runmaps.larsheimann.com` with generated maps at
`https://{slug}.runmaps.larsheimann.com`.

## Stacks

- `bootstrap` creates the private R2 bucket used for OpenTofu state.
- `prod` creates the app R2 bucket, D1 database, DNS records, Worker routes, generated app secrets, and GitHub Actions configuration.

The first unavoidable manual step is providing credentials to OpenTofu/GitHub Actions:

- `CLOUDFLARE_API_TOKEN` with scoped access to the account and `larsheimann.com` zone.
- `GH_ADMIN_TOKEN` for the GitHub provider to manage repository Actions secrets and variables.
- `PROCESSOR_GITHUB_TOKEN`, a separate fine-grained GitHub token that can dispatch the processor workflow.
- R2 S3 credentials for the OpenTofu state backend.
- R2 S3 credentials for direct browser uploads, stored as `R2_UPLOAD_ACCESS_KEY_ID` and
  `R2_UPLOAD_SECRET_ACCESS_KEY`. If Cloudflare generated `CLOUDFLARE_ACCESS_KEY_R2` and
  `CLOUDFLARE_SECRET_ACCESS_KEY_R2`, those names also work in the deploy workflow.
- A temporary invite-code secret such as `NEXT_INVITE_CODE` before running the invite workflow.

After that, CI can run plan/apply, migrations, Worker deploy, smoke tests, and processor jobs without dashboard clicks.

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

The deploy workflow reads OpenTofu outputs, writes a temporary Wrangler config, runs D1 migrations, uploads Worker secrets, and deploys the Worker/static assets.
Worker routes are applied after the Wrangler deploy step because Cloudflare rejects routes for a script that has not been uploaded yet.

Seed these GitHub Actions variables manually before running the workflow because they are inputs to OpenTofu itself:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`
- `TOFU_STATE_BUCKET`
- `TURNSTILE_SITE_KEY`, if Turnstile is enabled

## Processor Dispatch Token

The Worker dispatches `.github/workflows/process-job.yml` through the GitHub Actions API after a ZIP upload is accepted.
Create a fine-grained GitHub token for this repository with Actions write access and store it as the repository secret
`PROCESSOR_GITHUB_TOKEN`. Do not reuse the broader `GH_ADMIN_TOKEN` at runtime.

## Direct Upload R2 Credentials

The upload app uses browser-to-R2 multipart uploads for Garmin ZIPs up to 1 GB. The Worker keeps the R2 key private and
uses bucket-scoped R2 S3 credentials to sign short-lived `UploadPart` URLs. Store those credentials as GitHub Actions
secrets named `R2_UPLOAD_ACCESS_KEY_ID` and `R2_UPLOAD_SECRET_ACCESS_KEY`; alternatively, keep Cloudflare's generated
`CLOUDFLARE_ACCESS_KEY_R2` and `CLOUDFLARE_SECRET_ACCESS_KEY_R2` names. The deploy workflow uploads them to the Worker as
Worker secrets.

## Invite Codes

Create an invite code locally, store it as a GitHub Actions secret such as `NEXT_INVITE_CODE`, then run the
`Create Invite` workflow with `codeSecretName=NEXT_INVITE_CODE`. The workflow hashes the code and inserts only the hash
into D1; the plaintext code is masked and is not passed as a workflow-dispatch input.
