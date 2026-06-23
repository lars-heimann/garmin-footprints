# Deployment

Production targets:

- Upload app: `https://runmaps.larsheimann.com`
- Generated maps: `https://{slug}.runmaps.larsheimann.com`

## Automated Path

1. Use `infra/bootstrap` once to create the private R2 OpenTofu state bucket.
2. Configure the GitHub Actions credentials listed in `infra/README.md`.
3. Add `PROCESSOR_GITHUB_TOKEN`, a fine-grained GitHub token with Actions write access for this repository.
4. Run the `Deploy Production` workflow.

The deploy workflow runs quality checks, tests, OpenTofu apply, D1 migrations, Worker secret upload, Worker/static asset deploy, and a production smoke test.

## Runtime Resources

OpenTofu provisions:

- private R2 app bucket `runmaps-app`
- private R2 state bucket
- D1 database `runmaps`
- DNS records for `runmaps.larsheimann.com` and `*.runmaps.larsheimann.com`
- Worker routes for root and wildcard hostnames
- generated secrets for invite hashing, upload tokens, and processor auth
- GitHub Actions variables/secrets used by deploy, processor, invite, and reaper workflows

Wrangler deploys Worker code and static upload app assets using a generated production config.

## Invite Codes

Create a GitHub Actions secret containing the plaintext invite code, for example `NEXT_INVITE_CODE`, then run the
`Create Invite` workflow with `codeSecretName=NEXT_INVITE_CODE`. It hashes the invite code with `INVITE_HASH_SECRET` and
inserts only the hash into D1. Do not pass invite codes as workflow-dispatch inputs or paste them into logs.

## Cleanup

The Worker stores raw uploads under `uploads/{jobId}/garmin-export.zip`, generated assets under `sites/{slug}/`, and removes raw uploads when processing reports either `ready` or `failed`. A Worker cron and the `Reap Stale Jobs` workflow expire stale jobs and retry raw ZIP deletion.
