# Deployment

Production targets:

- Upload app: `https://runmaps.larsheimann.com`
- Generated maps: `https://{slug}.runmaps.larsheimann.com`

## Automated Path

1. Use `infra/bootstrap` once to create the private R2 OpenTofu state bucket.
2. Configure the GitHub Actions credentials listed in `infra/README.md`.
3. Add `PROCESSOR_GITHUB_TOKEN`, a fine-grained GitHub token with Actions write access for this repository.
4. Add R2 S3 upload credentials as GitHub Actions secrets. Preferred names are `R2_UPLOAD_ACCESS_KEY_ID` and
   `R2_UPLOAD_SECRET_ACCESS_KEY`; the deploy workflow also accepts Cloudflare's `CLOUDFLARE_ACCESS_KEY_R2` and
   `CLOUDFLARE_SECRET_ACCESS_KEY_R2` names.
5. Run the `Deploy Production` workflow.

The deploy workflow runs quality checks, tests, OpenTofu apply, D1 migrations, Worker secret upload, Worker/static asset deploy, and a production smoke test.
On the first deploy it applies base Cloudflare/GitHub resources before Worker routes, deploys the Worker with Wrangler, then applies the routes after the Worker script exists.

## Runtime Resources

OpenTofu provisions:

- private R2 app bucket `runmaps-app`
- private R2 state bucket
- D1 database `runmaps`
- DNS records for `runmaps.larsheimann.com` and `*.runmaps.larsheimann.com`
- Worker routes for root and wildcard hostnames
- generated secrets for invite hashing, upload tokens, and processor auth
- GitHub Actions variables/secrets used by deploy, processor, invite, and reaper workflows

`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `TOFU_STATE_BUCKET`, and optional `TURNSTILE_SITE_KEY` are manually seeded GitHub variables because the workflow needs them before OpenTofu can run.

Wrangler deploys Worker code and static upload app assets using a generated production config. The Worker uses the R2
S3 upload credentials only to generate short-lived `UploadPart` presigned URLs for browser-to-R2 multipart uploads; the
browser never receives those credentials.

## Invite Codes

Create a GitHub Actions secret containing the plaintext invite code, for example `NEXT_INVITE_CODE`, then run the
`Create Invite` workflow with `codeSecretName=NEXT_INVITE_CODE`. It hashes the invite code with `INVITE_HASH_SECRET` and
inserts only the hash into D1. Do not pass invite codes as workflow-dispatch inputs or paste them into logs.

## Cleanup

The Worker stores raw uploads under `uploads/{jobId}/garmin-export.zip`, generated assets under `sites/{slug}/`, and removes raw uploads when processing reports either `ready` or `failed`. A Worker cron and the `Reap Stale Jobs` workflow expire stale jobs and retry raw ZIP deletion.
