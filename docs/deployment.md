# Deployment

Production targets:

- Upload app: `https://runmaps.larsheimann.com`
- Generated maps: `https://{slug}.runmaps.larsheimann.com`

## Automated Path

1. Use `infra/bootstrap` once to create the private R2 OpenTofu state bucket.
2. Configure the GitHub Actions credentials listed in `infra/README.md`.
3. Configure Turnstile if you want production publish protection. Local preview does not require Turnstile.
4. Run the `Deploy Production` workflow.

The deploy workflow runs quality checks, tests, OpenTofu apply, D1 migrations, Worker secret upload, Worker/static asset deploy, and production smoke tests. On the first deploy it applies base Cloudflare/GitHub resources before Worker routes, deploys the Worker with Wrangler, then applies the routes after the Worker script exists.

## Runtime Resources

OpenTofu provisions:

- private R2 app bucket `runmaps-app`
- private R2 state bucket
- D1 database `runmaps`
- DNS records for `runmaps.larsheimann.com` and `*.runmaps.larsheimann.com`
- Worker routes for root and wildcard hostnames
- generated secrets for invite hashing, publish/delete tokens, and maintenance auth
- GitHub Actions variables/secrets used by deploy, invite, and reaper workflows

`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `TOFU_STATE_BUCKET`, and optional `TURNSTILE_SITE_KEY` are manually seeded GitHub variables because the workflow needs them before OpenTofu can run.

Wrangler deploys Worker code and static upload app assets using a generated production config. The Worker never needs GitHub Actions runtime dispatch credentials and never signs direct browser uploads for raw Garmin ZIP files.

## Invite Codes

Invite codes are stored in production only as keyed hashes. A readable non-secret label is stored with the invite row for usage tracking.

Keep the plaintext code in a GitHub Actions secret, then dispatch the `Create Invite` workflow with the secret name, label, and desired use count. The workflow reads the secret, masks the plaintext value, hashes it with `INVITE_HASH_SECRET`, and inserts only the hash into D1.

Generate a new code locally, store it as a repository Actions secret, and run the workflow:

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

Use a unique `SECRET_NAME` if you need several active invite codes at once. Reusing the same plaintext code updates that invite row's label and `max_uses`, and resets `reserved_uses`, but does not reset `uses`.

Do not pass plaintext invite codes as workflow-dispatch inputs, commit them, paste them into GitHub logs, or expect to recover them later from D1. GitHub can list secret names, but it cannot reveal secret values.

## Cleanup

The Worker stores only derived public map files under `sites/{slug}/meta.json` and `sites/{slug}/points.bin`. It does not store raw Garmin ZIPs.

Published maps expire after 30 days. A Worker cron and the `Reap Stale Jobs` workflow expire stale publish sessions, release unused invite reservations, delete expired map files, and mark expired public URLs so they show the friendly create-new-map page.
