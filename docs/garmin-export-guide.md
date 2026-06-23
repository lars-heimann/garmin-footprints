# Garmin Export Guide

1. Log into [Garmin Connect](https://connect.garmin.com/).
2. Open Garmin's account data export page: <https://www.garmin.com/account/datamanagement/exportdata/>.
3. Request your account export.
4. Wait for Garmin to prepare it. Garmin may take up to 30 days. In practice, many exports arrive much sooner, sometimes within about 20 minutes.
5. Download the ZIP Garmin provides.
6. Upload the ZIP unchanged in Run Maps.

## What To Upload

- Upload the full Garmin account export ZIP.
- Do not unzip it.
- Do not upload a single `.fit`, `.gpx`, `.tcx`, or activity export.
- Do not upload a Strava export.
- If Garmin gives multiple files, upload the main account export archive containing `DI_CONNECT`.

## Privacy

The Garmin ZIP contains private health and location data. The app extracts only running GPS tracks, trims the start and finish of each run, generates static public map assets, and deletes the raw ZIP after processing succeeds or fails. Generated map assets are public at the chosen slug URL.

## Troubleshooting

- Single activity file: request the full Garmin account export instead.
- ZIP does not contain Garmin export folders: confirm the archive contains `DI_CONNECT`.
- No running GPS activities found: confirm your account has outdoor runs with GPS tracks after the configured start date.
- iCloud or Dropbox placeholder: download the real ZIP locally before uploading.
- Second upload while one is processing: wait for the first job to finish or use a different slug.
