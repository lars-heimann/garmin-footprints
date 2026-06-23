# Garmin Footprints

Invite-only web app for uploading a Garmin account export ZIP and publishing a shareable personal running map at a wildcard subdomain such as `https://runner.runs.example.com`.

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

## Processor CLI

```sh
python3 processor/build_visualization_data.py garmin-export.zip out/site \
  --slug runner \
  --display-name "Runner" \
  --template-dir template
```

Exit codes:

- `0` success
- `2` invalid or suspicious ZIP
- `3` no running GPS data found
- `4` parser failure
- `5` internal error

## Local Worker Flow

Run the upload app locally with an in-memory Worker/R2/D1 harness:

```sh
npm run dev:local
```

Open `http://127.0.0.1:8787/` and use invite code `LOCAL-DEMO`. Local share URLs use `http://{slug}.runs.localhost:8787/`, and uploads are processed automatically by the Python processor.

The Worker API creates signed upload sessions, stores temporary ZIPs in R2, queues jobs, accepts processor callbacks, uploads final assets under `sites/{slug}/`, and serves wildcard hostnames from R2.
