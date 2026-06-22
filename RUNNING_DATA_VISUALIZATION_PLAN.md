# Running Data Visualization Plan

Goal: build a personal version of the "five million GPS points" visualization from running activity data.

## Overview

The workflow has two stages:

1. Create static density images from every GPS sample.
2. Optionally build an interactive browser-based point cloud.

The first milestone should be a single static "all my runs" image. Once that works, split the data into regions and add the interactive Three.js view.

## Data Export

Export original activity files from Garmin or Strava.

Preferred formats:

- Garmin `.fit` files
- Strava `.fit`, `.gpx`, or `.tcx` files

Avoid activity-summary CSV exports because they usually do not contain every GPS point.

Suggested local folder:

```text
data/raw/
```

## Normalize GPS Points

Parse every activity file and extract one row per GPS sample:

```text
activity_id
timestamp
latitude
longitude
distance, optional
heart_rate, optional
pace, optional
```

For Garmin `.fit` files, latitude and longitude may be stored as semicircles:

```text
degrees = semicircles * 180 / 2^31
```

Suggested normalized output:

```text
data/processed/points.parquet
```

## Clean And Protect Privacy

Before rendering or publishing:

- Remove activities without GPS.
- Filter to running activities if the export includes rides, walks, hikes, or other sports.
- Drop invalid coordinates and obviously bad GPS jumps.
- Remove a randomized start and finish segment from every run.

Recommended privacy trimming:

- Remove first and last 90-240 seconds, or
- Remove first and last 200-600 meters.

Randomizing the removed distance/time per activity helps prevent obvious home/work clusters.

## Project Coordinates

Convert latitude and longitude to Web Mercator coordinates. This keeps streets visually recognizable in a flat 2D image.

Then compute bounds:

```text
min_x, max_x
min_y, max_y
```

Normalize projected points into image or canvas space.

## Static Density Images

Use Python and Datashader to rasterize millions of points efficiently.

Rendering approach:

- Load `points.parquet`.
- Render points to a large canvas.
- Use transparent or additive-style shading.
- Use histogram-equalized shading so both frequent home routes and rare race/travel routes remain visible.
- Export `.png` or `.webp`.

First milestone:

```text
outputs/all_runs_density.webp
```

## Region Splitting

After the global render works, split data into meaningful places.

Options:

- Manually define regions such as Berlin, hometown, races, travel, etc.
- Automatically cluster GPS points into dense geographic regions.

Each region can produce:

```text
region_0.webp
region_0.bin
region_0.time.bin
```

## Interactive Point Cloud

For the browser view:

- Store points as compact binary, not JSON.
- Store normalized coordinates as `int16` pairs.
- Store relative timestamp/order data as `uint16` or `uint32`.
- Render with a single Three.js `Points` mesh.
- Use additive blending so repeated routes glow brighter.
- Animate point arrival in date order.

Optional later polish:

- Cursor/finger "smoke" displacement.
- Motion trails during the build animation.
- Adaptive render resolution.
- Downsampling when zoomed out.
- Stop rendering when idle.

## Recommended Build Order

1. Add project folders.
2. Add parser for `.fit` and possibly `.gpx`.
3. Generate `data/processed/points.parquet`.
4. Add privacy trimming.
5. Generate the first Datashader image.
6. Add region splitting.
7. Add Vite/React/Three.js viewer.
8. Add binary packing.
9. Add date-order animation.
10. Add interaction and performance polish.

