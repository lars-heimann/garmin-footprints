# Garmin Footprints

Invite-only Runmaps web app for turning a Garmin account export into a shareable running map. Garmin ZIP processing happens in the browser first; the backend receives only generated `meta.json` and `points.bin` files after the user chooses to publish.

## Shape

- `apps/web` - browser-first upload, local preview, publish, and guide UI
- `apps/worker` - Cloudflare Worker API, D1 metadata, R2 derived-map storage, and public map serving
- `apps/web/browser-processing` - browser Garmin export parser and map-data generator
- `apps/web/viewer` - reusable public map viewer served for every published slug
- `processor` - standalone Python processor kept for parser parity tests and local CLI usage
- `docs` - deployment, Garmin export, and browser-first architecture notes

## Test

```sh
npm test
```

The e2e tests exercise local browser ZIP processing without backend upload, publish only derived files through the Worker, fetch the generated public map, verify deletion/expiry behavior, and confirm raw ZIP upload endpoints are unavailable.

## Quality

```sh
npm run quality
```

Quality checks include Prettier, ESLint, TypeScript `checkJs`, Ruff, and mypy. `.pre-commit-config.yaml` provides an optional local pre-commit hook that runs the same quality gate.

## Processor CLI

The production sharing path does not run this CLI. It remains useful for local debugging and parity tests:

```sh
python3 processor/build_visualization_data.py garmin-export.zip out/site \
  --slug runner \
  --display-name "Runner" \
  --template-dir apps/web/viewer
```

## Local Worker Flow

Run the app locally with an in-memory Worker/R2/D1 harness:

```sh
npm run dev:local
```

Open `http://127.0.0.1:8787/` and use invite code `LOCAL-DEMO` only when publishing. Local preview does not need an invite code. Local share URLs use `http://127.0.0.1:8787/m/{slug}`.

The Worker reserves server-authoritative slugs, accepts only generated `meta.json` and `points.bin`, serves public map paths from R2, supports confirmation-based delete links, and expires maps after 30 days.

## Personal Runs Pages Preview

`runs.larsheimann.com` is being migrated safely into this repo as a GitHub Pages preview. The Runmaps-owned preview uses the shared viewer plus committed derived map data from `sites/runs`; it does not contain raw Garmin exports.

```sh
npm run test:runs-pages
```

The preview workflow does not write a `CNAME` file and does not claim `runs.larsheimann.com`. The current visualizer repo and live custom domain stay untouched until the default GitHub Pages preview has been inspected and manually approved.

## Production

Production launch is driven by OpenTofu plus GitHub Actions. See [docs/deployment.md](docs/deployment.md), [docs/browser-first-sharing.md](docs/browser-first-sharing.md), and [infra/README.md](infra/README.md).
