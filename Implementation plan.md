# Standalone Plan: Garmin ZIP Upload To Shareable Running Map

## Summary

Build a new standalone web app that lets invited users upload a Garmin account export ZIP, automatically processes running GPS data, and publishes a personal shareable map at a URL like `https://{slug}.runs.yourdomain.com`.

Use the existing visualization files only as a starting template after copying them into the new repository. The new system should not depend on the old repo’s Git history, deployment, or structure.

Default decisions:
- Invite-only MVP.
- Use an existing domain with a wildcard subdomain.
- Use Cloudflare free/low-cost tiers wherever possible.
- Delete raw Garmin ZIP uploads immediately after processing.
- Keep only generated static assets and minimal metadata.

## Recommended Architecture

Use Cloudflare as the main platform:

- **Cloudflare Worker**: API, upload coordination, job status, and wildcard subdomain routing.
- **Cloudflare R2**: object storage for temporary ZIP uploads and final static site assets.
- **Cloudflare D1 or KV**: metadata for invites, slugs, jobs, status, timestamps, and generated site records.
- **GitHub Actions**: free/cheap processing worker that runs Python against uploaded ZIPs.
- **Wildcard DNS**: `*.runs.yourdomain.com` routed to the Worker.

Avoid creating one GitHub/GitLab Pages project per user. It creates operational overhead and makes wildcard routing, cleanup, privacy, and abuse control harder.

## Product Flow

1. User opens the app homepage.
2. App shows a short Garmin export guide:
   - Go to Garmin Connect account data export.
   - Request/export account data.
   - Download the ZIP from Garmin.
   - Upload the ZIP unchanged.
3. User enters:
   - Invite code.
   - Desired public slug.
   - Optional display name/title.
4. Frontend requests an upload session from the Worker.
5. Worker validates invite code and reserves the slug.
6. User uploads ZIP directly to R2 using a signed upload URL.
7. Worker creates a processing job.
8. GitHub Actions processor runs:
   - Downloads ZIP from R2.
   - Extracts Garmin FIT files.
   - Parses running activities.
   - Applies privacy trimming.
   - Generates `points.bin` and `meta.json`.
   - Copies static visualization template files.
   - Uploads final assets to R2 under `sites/{slug}/`.
   - Deletes the raw ZIP.
   - Marks the job as `ready` or `failed`.
9. User sees the final share URL:
   - `https://{slug}.runs.yourdomain.com`
10. Worker serves that subdomain from R2.

## Repository Shape

Create a new repository with this rough structure:

```text
/
  apps/
    web/                 # upload/status frontend
    worker/              # Cloudflare Worker API + site routing
  processor/
    build_visualization_data.py
    process_job.py
    requirements.txt
  template/
    index.html
    app.js
    styles.css
  .github/
    workflows/
      process-job.yml
  docs/
    garmin-export-guide.md
```

The copied visualization files should go into `template/`, then be made user-neutral.

## Key Implementation Details

- Make the parser a standalone CLI:
  - Input: Garmin ZIP path.
  - Output directory: generated static site assets.
  - Options: `--slug`, `--display-name`, `--start-date`, `--max-points`.
  - Exit codes distinguish invalid ZIP, no runs found, parser failure, and internal error.

- Store final generated assets like:

```text
sites/{slug}/index.html
sites/{slug}/app.js
sites/{slug}/styles.css
sites/{slug}/meta.json
sites/{slug}/points.bin
```

- Store temporary uploads like:

```text
uploads/{jobId}/garmin-export.zip
```

- Delete `uploads/{jobId}/garmin-export.zip` after success or failure.

- Metadata fields:
  - `jobId`
  - `slug`
  - `status`
  - `inviteCodeHash`
  - `createdAt`
  - `updatedAt`
  - `errorCode`
  - `errorMessage`
  - `siteUrl`
  - `rawUploadDeletedAt`

- Job statuses:
  - `reserved`
  - `uploaded`
  - `queued`
  - `processing`
  - `ready`
  - `failed`
  - `expired`

## Security And Privacy

- Require invite code for MVP.
- Enforce max ZIP size.
- Reject nested or suspicious ZIP contents.
- Never expose raw upload URLs publicly.
- Delete raw Garmin ZIPs immediately after processing.
- Keep the existing start/end route trimming, but display a privacy warning before upload.
- Add slug blocklist:
  - `www`
  - `api`
  - `admin`
  - `static`
  - `assets`
  - `login`
  - `support`

## Deployment Plan

1. Create Cloudflare R2 bucket for uploads and generated sites.
2. Create Cloudflare D1 or KV namespace for jobs, slugs, and invites.
3. Configure wildcard DNS:
   - `*.runs.yourdomain.com`
4. Route wildcard domain to the Cloudflare Worker.
5. Deploy Worker.
6. Add GitHub repository secrets:
   - Cloudflare account ID.
   - R2 credentials.
   - Worker API token or signed job token.
7. Add GitHub Actions workflow that can process a specific `jobId`.
8. Trigger GitHub Actions from the Worker after upload completion.

## Test Plan

- Valid Garmin export produces a working public site.
- Invalid ZIP gives a clear error.
- ZIP with no running GPS data gives a clear error.
- Huge ZIP is rejected before processing.
- Duplicate slug reservation is impossible.
- Raw ZIP is deleted after success.
- Raw ZIP is deleted after failure.
- Generated URL works on desktop and mobile.
- `points.bin` size matches `meta.json.pointCount`.
- Invite code can only create the configured number of sites.

## Paste-Into-New-Repo Prompt

Use this prompt in the new repository after copying the visualization files:

```text
Build this as a new standalone project, unrelated to any previous repository.

Goal:
Create an invite-only web app where users upload a Garmin account export ZIP, the system processes running GPS activities, and publishes a shareable personal running map at a wildcard subdomain like https://{slug}.runs.example.com.

Use Cloudflare free/low-cost tiers as the primary platform:
- Cloudflare Worker for API, upload coordination, job status, and wildcard subdomain routing.
- Cloudflare R2 for temporary Garmin ZIP uploads and final generated static site assets.
- Cloudflare D1 or KV for invite codes, slug reservations, job metadata, and status.
- GitHub Actions as the first processing worker that runs Python and uploads generated assets back to R2.

Important defaults:
- Invite-code only.
- Use an existing domain with wildcard subdomains.
- Delete the raw uploaded Garmin ZIP immediately after processing, whether success or failure.
- Keep only generated site assets and minimal job metadata.
- Do not create one GitHub/GitLab Pages project per user.

Use the copied visualization files as a template only:
- Move static viewer files into a reusable template folder.
- Remove personal text from the viewer.
- Make title/display name configurable from generated metadata.
- Keep the WebGL `points.bin` + `meta.json` loading model.

Implement:
1. A frontend upload flow with Garmin export instructions, invite code, slug selection, ZIP upload, processing status, and final share URL.
2. A Cloudflare Worker API that validates invites, reserves slugs, creates signed R2 upload sessions, tracks jobs, and serves generated sites by hostname.
3. A Python processor CLI that accepts a Garmin ZIP and output directory, extracts running FIT data, privacy-trims starts/finishes, generates `points.bin` and `meta.json`, and copies template assets.
4. A GitHub Actions workflow that processes queued jobs by `jobId`.
5. Cleanup logic that deletes raw uploads after processing.
6. Tests for parser success/failure cases, slug validation, duplicate slug handling, job status transitions, and generated asset consistency.

Suggested repo structure:
apps/web
apps/worker
processor
template
.github/workflows
docs

Before editing, inspect the copied files and adapt the plan to the actual file names. Build the smallest working MVP first, then add polish.
```
