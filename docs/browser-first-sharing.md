# Browser-First Sharing

Runmaps is moving from backend Garmin ZIP processing to browser-first processing.

## Previous Flow

The first production design accepted a raw Garmin account export ZIP in the Worker, stored it temporarily in private R2, dispatched a GitHub Actions processor job, and let the processor upload generated public site assets back to R2. That flow had strong ZIP validation, but the backend still received private health and location data.

## Target Flow

The production sharing path now keeps Garmin ZIP processing in the browser:

1. The user opens Runmaps and reads the Garmin export/privacy guide.
2. The user selects the Garmin account export ZIP locally.
3. The browser validates the file type, the 500 MB local limit, the readiness checklist, and expected Garmin export structure.
4. The browser parses running GPS activities, trims starts/finishes, and renders a local preview.
5. Only after a successful preview does the publish step appear.
6. Publishing requires an invite code and Turnstile.
7. The Worker reserves a server-authoritative slug, returns short-lived publish authorization, and accepts only derived `meta.json` and `points.bin`.
8. The Worker validates schema, size limits, and `points.bin` byte length against `meta.json`.
9. The Worker marks the map public, consumes invite usage, and returns the public URL plus a private delete/manage link.

Privacy promise: **Your Garmin ZIP never leaves your browser.**

The backend does not receive raw Garmin ZIPs, `.fit` files, `.gpx` files, `.tcx` files, extracted Garmin folders, Garmin summary JSON, or uploaded file paths. It stores only generated map metadata and binary point data needed to render the public map.

## Preview Flow

Local preview requires no invite code. The preview step validates:

- `Display name *`
- Garmin account export ZIP presence
- supported `.zip` file type
- 500 MB local file limit
- readiness checklist acknowledgements
- local Garmin parser errors, including non-Garmin ZIPs, single activity files, no running GPS tracks, malformed archives, and suspicious ZIP entries

The browser keeps derived data in memory until the user publishes or clears the preview.

## Publish Flow

Publishing requires:

- successful local preview
- invite code
- Turnstile token when configured
- derived `meta.json` within the Worker limit
- derived `points.bin` within the Worker limit
- byte-length consistency between `meta.json.pointCount` and `points.bin`

The Worker generates slugs as `{normalized-display-name}-{5-char-random}`. Users never submit a public slug directly. The Worker retries slug collisions server-side and blocks exact reserved slug hostnames.

## Invite Tracking

Invite codes are stored as keyed hashes. D1 also stores a readable non-secret `label` so usage can be tracked by group, such as `HSP-RUNNERS` or `RUN-AND-CHILL`.

Usage is reserved when a publish session starts and consumed only after publish completes successfully. Failed, aborted, or stale publish sessions release reserved usage.

## Public Map Lifetime

Published maps are public to anyone with the URL and expire after 30 days. Expired map data is deleted by scheduled cleanup. Expired and deleted public map URLs show a friendly page explaining that the map is no longer available and linking back to create a new one.

## Delete Flow

Every successful publish returns a private delete/manage link. Opening that link never deletes the map. It shows a confirmation page with:

- map name
- public URL
- automatic deletion date
- explicit POST-only delete button

The delete token is stored only as a keyed hash. The delete action is idempotent and removes only the derived public map files.

## Failure Cases

The browser-first flow intentionally handles:

- users uploading a single `.fit`, `.gpx`, `.tcx`, Strava export, or self-zipped folder
- iCloud/Dropbox placeholder files that do not contain the actual ZIP
- ZIP bombs, suspicious paths, duplicate paths, malformed FIT data, and no-run exports in the browser parser
- publish token reuse or expiry
- derived asset size mismatches
- invite exhaustion
- Turnstile failure
- abandoned publish sessions
- stale public maps
- accidental delete-link clicks

## Migration Completion

This migration is not complete until GitHub issues #1-#6 and the browser-first publishing epic are implemented, tested, deployed, and satisfied under this architecture.

Required satisfaction criteria:

- no manual slug field
- display-name explanation, generated URL preview, and generated title preview
- server-authoritative slug generation with normalization, reserved exact names, and collision retry
- Garmin guide in an accessible modal, with `/guide/garmin-export` returning 404
- screenshot-ready guide placeholders
- clear preview-step and publish-step validation summaries and inline errors
- reusable labeled invite codes with use limits
- 30-day public map expiry
- delete confirmation page before destructive action
- no production path that accepts raw Garmin ZIP uploads
- e2e publish from browser processing to public URL
- expired/deleted map friendly page
- CI, Worker tests, browser processor tests, and e2e tests passing
