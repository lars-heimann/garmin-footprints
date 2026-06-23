# Garmin Footprints

Invite-only web app for uploading a Garmin account export ZIP and publishing a shareable personal running map at a wildcard subdomain such as `https://runner.runmaps.larsheimann.com`.

## Shape

- `apps/web` - upload/status frontend
- `apps/worker` - Cloudflare Worker API, D1 metadata, R2 upload/site routing
- `processor` - Garmin ZIP processor CLI and GitHub Actions job runner
- `template` - reusable static WebGL running map viewer
- `docs` - Garmin export and deployment notes

## Test

```sh
npm test
```

The e2e test starts the Worker locally, uploads a synthetic Garmin export, runs the Python processor against the Worker API, verifies raw upload cleanup, fetches the generated wildcard site, checks `points.bin` against `meta.json`, and opens the generated site in desktop and mobile headless Chrome.

## Quality

```sh
npm run quality
```

Quality checks include Prettier, ESLint, TypeScript `checkJs`, Ruff, and mypy. `.pre-commit-config.yaml` provides an optional local pre-commit hook that runs the same quality gate.

## Processor CLI

```sh
python3 processor/build_visualization_data.py garmin-export.zip out/site \
  --slug runner \
  --display-name "Runner" \
  --template-dir template
```

Exit codes:

- `0` success
- `2` invalid, suspicious, oversized, or unusually compressed ZIP
- `3` no running GPS data found, missing Garmin export folders, or missing activity files
- `4` parser failure
- `5` internal error

## Local Worker Flow

Run the upload app locally with an in-memory Worker/R2/D1 harness:

```sh
npm run dev:local
```

Open `http://127.0.0.1:8787/` and use invite code `LOCAL-DEMO`. Local share URLs use `http://{slug}.runs.localhost:8787/`, and uploads are processed automatically by the Python processor.

The Worker API creates signed upload sessions, stores temporary ZIPs in R2, queues jobs, accepts processor callbacks, uploads final assets under `sites/{slug}/`, and serves wildcard hostnames from R2.

## Production

Production launch is driven by OpenTofu plus GitHub Actions. See [docs/deployment.md](docs/deployment.md) and [infra/README.md](infra/README.md).

The Worker requires a separate `PROCESSOR_GITHUB_TOKEN` secret with Actions write access so uploads can dispatch the processor workflow.
