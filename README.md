# Running Visualization

Personal running footprint viewer inspired by dense GPS point-cloud maps. It parses Garmin export data, keeps only running GPS tracks from May 2022 onward, privacy-trims activity starts/finishes, and renders the points in a local WebGL browser view.

## Run

Rebuild the generated data:

```sh
python3 scripts/build_visualization_data.py
```

Serve the viewer:

```sh
python3 -m http.server 8000 -d public
```

Open:

```text
http://127.0.0.1:8000/
```

## Publish

Push this repo to GitHub, then in **Settings -> Pages**, set **Source** to **GitHub Actions**. The included workflow publishes `public/` to GitHub Pages on every push to `main`.
