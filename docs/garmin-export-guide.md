# Garmin Export Guide

1. Log into [Garmin Connect](https://connect.garmin.com/).
2. Open Garmin's account data export page: <https://www.garmin.com/account/datamanagement/exportdata/>.
3. Request your account export.
4. Wait for Garmin to prepare it. Garmin may take up to 30 days. In practice, many exports arrive much sooner, sometimes within about 20 minutes.
5. Download the ZIP Garmin provides.
6. Select the ZIP unchanged in Runmaps to create a local preview.

## What To Upload

- Upload the full Garmin account export ZIP.
- Do not unzip it.
- Do not upload a single `.fit`, `.gpx`, `.tcx`, or activity export.
- Do not upload a Strava export.
- If Garmin gives multiple files, upload the main account export archive containing `DI_CONNECT`.

## Privacy

The Garmin ZIP contains private health and location data. Runmaps processes it in your browser so the raw ZIP does not leave your machine. The app extracts only running GPS tracks, trims the start and finish of each run, and publishes only generated `meta.json` and `points.bin` map files if you choose to share. Generated map assets are public at the final slug URL for 30 days.

## Troubleshooting

- Single activity file: request the full Garmin account export instead.
- ZIP does not contain Garmin export folders: confirm the archive contains `DI_CONNECT`.
- No running GPS activities found: confirm your account has outdoor runs with GPS tracks after the configured start date.
- iCloud or Dropbox placeholder: download the real ZIP locally before uploading.
- Publish failed: keep the local preview open and try publishing again, or clear the preview and start over.
