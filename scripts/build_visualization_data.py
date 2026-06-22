#!/usr/bin/env python3
"""Build browser-ready running point data from a Garmin account export."""

from __future__ import annotations

import argparse
import bisect
import json
import math
import random
import re
import struct
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


GARMIN_EPOCH = 631065600
SEMICIRCLE_TO_DEGREES = 180.0 / (2**31)
RUN_ACTIVITY_TYPES = {
    "running",
    "track_running",
    "trail_running",
    "street_running",
    "virtual_running",
    "treadmill_running",
}

BASE_TYPE_FORMATS = {
    0: ("B", 1),
    1: ("b", 1),
    2: ("B", 1),
    3: ("h", 2),
    4: ("H", 2),
    5: ("i", 4),
    6: ("I", 4),
    8: ("f", 4),
    9: ("d", 8),
    10: ("B", 1),
    11: ("H", 2),
    12: ("I", 4),
    13: ("B", 1),
    14: ("q", 8),
    15: ("Q", 8),
    16: ("Q", 8),
}


@dataclass
class FieldDef:
    number: int
    size: int
    base_type: int


@dataclass
class MessageDef:
    global_num: int
    endian: str
    fields: list[FieldDef]
    size: int


@dataclass
class Activity:
    activity_id: int
    name: str
    activity_type: str
    start_ms: int
    distance_m: float


@dataclass
class FitEntry:
    zip_path: Path
    name: str


def decode_value(raw: bytes, field: FieldDef, endian: str):
    type_num = field.base_type & 0x1F
    if type_num == 7:
        return raw.split(b"\0", 1)[0].decode("utf-8", "ignore")
    fmt_info = BASE_TYPE_FORMATS.get(type_num)
    if not fmt_info:
        return None
    fmt, width = fmt_info
    if field.size < width:
        return None
    count = field.size // width
    prefix = "<" if endian == "little" else ">"
    values = struct.unpack(prefix + fmt * count, raw[: count * width])
    return values[0] if len(values) == 1 else values


def parse_fit_records(blob: bytes) -> list[tuple[int | None, float, float]]:
    if len(blob) < 14:
        return []
    header_size = blob[0]
    if header_size not in (12, 14) or blob[8:12] != b".FIT":
        return []
    data_size = struct.unpack_from("<I", blob, 4)[0]
    offset = header_size
    end = min(len(blob), header_size + data_size)
    definitions: dict[int, MessageDef] = {}
    records: list[tuple[int | None, float, float]] = []
    last_timestamp: int | None = None

    while offset < end:
        header = blob[offset]
        offset += 1

        if header & 0x80:
            local_num = (header >> 5) & 0x03
            timestamp_offset = header & 0x1F
            msg_def = definitions.get(local_num)
            if not msg_def or offset + msg_def.size > end:
                break
            payload = blob[offset : offset + msg_def.size]
            offset += msg_def.size
            timestamp = None
            if last_timestamp is not None:
                timestamp = (last_timestamp & ~0x1F) + timestamp_offset
                if timestamp <= last_timestamp - 16:
                    timestamp += 32
                last_timestamp = timestamp
            add_record_point(records, msg_def, payload, timestamp)
            continue

        is_definition = bool(header & 0x40)
        local_num = header & 0x0F
        has_developer_fields = bool(header & 0x20)

        if is_definition:
            if offset + 5 > end:
                break
            offset += 1
            architecture = blob[offset]
            offset += 1
            endian = "big" if architecture else "little"
            prefix = ">" if endian == "big" else "<"
            global_num = struct.unpack_from(prefix + "H", blob, offset)[0]
            offset += 2
            field_count = blob[offset]
            offset += 1
            fields: list[FieldDef] = []
            total_size = 0
            for _ in range(field_count):
                if offset + 3 > end:
                    return records
                number, size, base_type = blob[offset], blob[offset + 1], blob[offset + 2]
                fields.append(FieldDef(number, size, base_type))
                total_size += size
                offset += 3
            if has_developer_fields:
                if offset >= end:
                    return records
                dev_field_count = blob[offset]
                offset += 1 + 3 * dev_field_count
            definitions[local_num] = MessageDef(global_num, endian, fields, total_size)
            continue

        msg_def = definitions.get(local_num)
        if not msg_def or offset + msg_def.size > end:
            break
        payload = blob[offset : offset + msg_def.size]
        offset += msg_def.size
        timestamp = add_record_point(records, msg_def, payload, None)
        if timestamp is not None:
            last_timestamp = timestamp

    return records


def add_record_point(
    records: list[tuple[int | None, float, float]],
    msg_def: MessageDef,
    payload: bytes,
    compressed_timestamp: int | None,
) -> int | None:
    if msg_def.global_num != 20:
        return None

    cursor = 0
    timestamp = compressed_timestamp
    lat_raw = None
    lon_raw = None
    for field in msg_def.fields:
        raw = payload[cursor : cursor + field.size]
        cursor += field.size
        if field.number not in (0, 1, 253):
            continue
        value = decode_value(raw, field, msg_def.endian)
        if value is None:
            continue
        if field.number == 253:
            timestamp = int(value)
        elif field.number == 0:
            lat_raw = int(value)
        elif field.number == 1:
            lon_raw = int(value)

    if lat_raw is None or lon_raw is None:
        return timestamp
    if lat_raw in (0x7FFFFFFF, -0x80000000) or lon_raw in (0x7FFFFFFF, -0x80000000):
        return timestamp

    lat = lat_raw * SEMICIRCLE_TO_DEGREES
    lon = lon_raw * SEMICIRCLE_TO_DEGREES
    if -90 <= lat <= 90 and -180 <= lon <= 180 and not (lat == 0 and lon == 0):
        records.append((timestamp, lat, lon))
    return timestamp


def iter_summarized_activities(export_zip: Path) -> list[Activity]:
    activities: list[Activity] = []
    with zipfile.ZipFile(export_zip) as archive:
        for name in archive.namelist():
            if not name.endswith("_summarizedActivities.json"):
                continue
            payload = json.loads(archive.read(name))
            for block in payload:
                for row in block.get("summarizedActivitiesExport", []):
                    activity_type = str(row.get("activityType", "")).lower()
                    if activity_type not in RUN_ACTIVITY_TYPES:
                        continue
                    activity_id = row.get("activityId")
                    if activity_id is None:
                        continue
                    activities.append(
                        Activity(
                            activity_id=int(activity_id),
                            name=row.get("name") or "Run",
                            activity_type=activity_type,
                            start_ms=int(row.get("startTimeGmt") or row.get("beginTimestamp") or 0),
                            distance_m=float(row.get("distance") or 0) / 100.0,
                        )
                    )
    activities.sort(key=lambda item: item.start_ms)
    return activities


def extract_uploaded_zips(export_zip: Path, raw_dir: Path) -> list[Path]:
    raw_dir.mkdir(parents=True, exist_ok=True)
    extracted: list[Path] = []
    with zipfile.ZipFile(export_zip) as archive:
        for name in archive.namelist():
            if not re.search(r"DI_CONNECT/DI-Connect-Uploaded-Files/.*\.zip$", name):
                continue
            target = raw_dir / Path(name).name
            if not target.exists() or target.stat().st_size != archive.getinfo(name).file_size:
                target.write_bytes(archive.read(name))
            extracted.append(target)
    return sorted(extracted)


def list_fit_entries(uploaded_zips: list[Path]) -> list[FitEntry]:
    entries: list[FitEntry] = []
    for zip_path in uploaded_zips:
        with zipfile.ZipFile(zip_path) as archive:
            for name in archive.namelist():
                if name.lower().endswith(".fit"):
                    entries.append(FitEntry(zip_path, name))
    return entries


def build_activity_matcher(activities: list[Activity]):
    starts = sorted((activity.start_ms // 1000, activity) for activity in activities)
    timestamps = [item[0] for item in starts]

    def match(timestamp: int | None, window_seconds: int) -> Activity | None:
        if timestamp is None:
            return None
        position = bisect.bisect_left(timestamps, timestamp)
        candidates = []
        if position < len(starts):
            candidates.append(starts[position])
        if position > 0:
            candidates.append(starts[position - 1])
        if not candidates:
            return None
        nearest_ts, activity = min(candidates, key=lambda item: abs(item[0] - timestamp))
        if abs(nearest_ts - timestamp) <= window_seconds:
            return activity
        return None

    return match


def trim_activity_points(
    activity_id: int,
    points: list[tuple[int | None, float, float]],
) -> list[tuple[int | None, float, float]]:
    if len(points) < 30:
        return []
    points.sort(key=lambda row: row[0] if row[0] is not None else -1)
    rng = random.Random(activity_id)
    trim_each_side = min(max(10, int(len(points) * rng.uniform(0.035, 0.075))), len(points) // 3)
    return points[trim_each_side : len(points) - trim_each_side]


def mercator(lon: float, lat: float) -> tuple[float, float]:
    clamped_lat = max(-85.05112878, min(85.05112878, lat))
    lat_rad = math.radians(clamped_lat)
    x = math.radians(lon)
    y = math.log(math.tan(math.pi / 4.0 + lat_rad / 2.0))
    return x, y


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        raise ValueError("Cannot compute percentile of an empty list.")
    if fraction <= 0:
        return values[0]
    if fraction >= 1:
        return values[-1]
    position = fraction * (len(values) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return values[lower]
    weight = position - lower
    return values[lower] * (1 - weight) + values[upper] * weight


def densest_cluster_bounds(
    projected: list[tuple[float, float, int]],
    cell_size: float,
    radius_cells: int,
) -> tuple[float, float, float, float, int]:
    counts: dict[tuple[int, int], int] = {}
    for x, y, _ in projected:
        key = (math.floor(x / cell_size), math.floor(y / cell_size))
        counts[key] = counts.get(key, 0) + 1
    best_cell = max(counts, key=counts.get)
    selected = [
        (x, y)
        for x, y, _ in projected
        if abs(math.floor(x / cell_size) - best_cell[0]) <= radius_cells
        and abs(math.floor(y / cell_size) - best_cell[1]) <= radius_cells
    ]
    if len(selected) < 1000:
        raise ValueError("Densest cluster was too small for a useful initial view.")
    xs = [x for x, _ in selected]
    ys = [y for _, y in selected]
    return min(xs), max(xs), min(ys), max(ys), len(selected)


def iso_from_fit_timestamp(timestamp: int | None, fallback_ms: int) -> str:
    if timestamp is not None:
        unix_seconds = timestamp + GARMIN_EPOCH
    else:
        unix_seconds = fallback_ms / 1000.0
    return datetime.fromtimestamp(unix_seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def parse_start_date(value: str) -> int:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("Use YYYY-MM-DD for --start-date.") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def build_visualization_data(args: argparse.Namespace) -> dict:
    export_zip = Path(args.export_zip)
    raw_dir = Path(args.raw_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    start_timestamp = parse_start_date(args.start_date) if args.start_date else None

    activities = iter_summarized_activities(export_zip)
    if args.limit:
        activities = activities[-args.limit :]
    uploaded_zips = extract_uploaded_zips(export_zip, raw_dir)
    fit_entries = list_fit_entries(uploaded_zips)
    match_activity = build_activity_matcher(activities)

    projected: list[tuple[float, float, int]] = []
    parsed_activities = 0
    skipped_non_run = 0
    skipped_no_gps = 0
    skipped_no_timestamp = 0
    skipped_duplicate = 0
    skipped_before_start = 0
    candidate_gps_files = 0
    seen_activity_ids: set[int] = set()
    activity_start_times: list[int] = []
    start_iso = None
    end_iso = None

    scanned = 0
    for zip_path in uploaded_zips:
        names = [entry.name for entry in fit_entries if entry.zip_path == zip_path]
        with zipfile.ZipFile(zip_path) as archive:
            for fit_name in names:
                scanned += 1
                if args.verbose and scanned % 1000 == 0:
                    print(
                        f"scanned {scanned}/{len(fit_entries)} FIT files; "
                        f"gps_candidates={candidate_gps_files}; matched_runs={parsed_activities}; "
                        f"points={len(projected):,}"
                    )
                points = parse_fit_records(archive.read(fit_name))
                if len(points) < 30:
                    skipped_no_gps += 1
                    continue
                candidate_gps_files += 1
                timestamps = [row[0] for row in points if row[0] is not None]
                if not timestamps:
                    skipped_no_timestamp += 1
                    continue
                fit_start = min(timestamps) + GARMIN_EPOCH
                if start_timestamp is not None and fit_start < start_timestamp:
                    skipped_before_start += 1
                    continue
                activity = match_activity(fit_start, args.match_window_hours * 3600)
                if activity is None:
                    skipped_non_run += 1
                    continue
                if activity.activity_id in seen_activity_ids:
                    skipped_duplicate += 1
                    continue
                seen_activity_ids.add(activity.activity_id)
                points = trim_activity_points(activity.activity_id, points)
                if len(points) < 10:
                    skipped_no_gps += 1
                    continue
                parsed_activities += 1
                for timestamp, lat, lon in points:
                    x, y = mercator(lon, lat)
                    unix_seconds = (timestamp + GARMIN_EPOCH) if timestamp is not None else activity.start_ms // 1000
                    projected.append((x, y, int(unix_seconds)))
                activity_start_times.append(
                    int((points[0][0] + GARMIN_EPOCH) if points[0][0] is not None else activity.start_ms // 1000)
                )
                activity_start = iso_from_fit_timestamp(points[0][0], activity.start_ms)
                activity_end = iso_from_fit_timestamp(points[-1][0], activity.start_ms)
                start_iso = activity_start if start_iso is None or activity_start < start_iso else start_iso
                end_iso = activity_end if end_iso is None or activity_end > end_iso else end_iso

    if not projected:
        raise RuntimeError("No GPS points were extracted from running activities.")

    if len(projected) > args.max_points:
        rng = random.Random(42)
        projected = rng.sample(projected, args.max_points)

    min_x = min(row[0] for row in projected)
    max_x = max(row[0] for row in projected)
    min_y = min(row[1] for row in projected)
    max_y = max(row[1] for row in projected)
    min_t = min(row[2] for row in projected)
    max_t = max(row[2] for row in projected)
    initial_view: dict[str, float | int | str]
    if args.initial_view_mode == "cluster":
        try:
            render_min_x, render_max_x, render_min_y, render_max_y, cluster_points = densest_cluster_bounds(
                projected,
                args.cluster_cell_size,
                args.cluster_radius_cells,
            )
            initial_view = {
                "mode": "densest_cluster",
                "cellSize": args.cluster_cell_size,
                "radiusCells": args.cluster_radius_cells,
                "pointCount": cluster_points,
            }
        except ValueError:
            args.initial_view_mode = "percentile"

    if args.initial_view_mode == "percentile":
        x_values = sorted(row[0] for row in projected)
        y_values = sorted(row[1] for row in projected)
        tail = (1.0 - args.initial_view_fraction) / 2.0
        render_min_x = percentile(x_values, tail)
        render_max_x = percentile(x_values, 1.0 - tail)
        render_min_y = percentile(y_values, tail)
        render_max_y = percentile(y_values, 1.0 - tail)
        initial_view = {
            "mode": "central_percentile",
            "centralPointFraction": args.initial_view_fraction,
        }

    center_x = (render_min_x + render_max_x) / 2.0
    center_y = (render_min_y + render_max_y) / 2.0
    extent = max(render_max_x - render_min_x, render_max_y - render_min_y) or 1.0
    time_extent = max(max_t - min_t, 1)

    projected.sort(key=lambda row: row[2])
    triples = bytearray()
    for x, y, timestamp in projected:
        nx = ((x - center_x) / extent) * 2.0
        ny = ((y - center_y) / extent) * 2.0
        nt = (timestamp - min_t) / time_extent
        triples.extend(struct.pack("<fff", nx, ny, nt))

    (output_dir / "points.bin").write_bytes(triples)
    meta = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sourceArchive": str(export_zip),
        "totalRunSummaries": len(activities),
        "parsedRunActivities": parsed_activities,
        "uploadedFitFiles": len(fit_entries),
        "candidateGpsFiles": candidate_gps_files,
        "skippedNonRunGps": skipped_non_run,
        "skippedNoGps": skipped_no_gps,
        "skippedNoTimestamp": skipped_no_timestamp,
        "skippedDuplicateMatches": skipped_duplicate,
        "skippedBeforeStartDate": skipped_before_start,
        "pointCount": len(projected),
        "runProgress": sorted((timestamp - min_t) / time_extent for timestamp in activity_start_times),
        "maxPoints": args.max_points,
        "sampled": len(projected) >= args.max_points,
        "requestedStartDate": args.start_date,
        "start": datetime.fromtimestamp(min_t, timezone.utc).isoformat().replace("+00:00", "Z"),
        "end": datetime.fromtimestamp(max_t, timezone.utc).isoformat().replace("+00:00", "Z"),
        "bounds": {
            "minMercatorX": min_x,
            "maxMercatorX": max_x,
            "minMercatorY": min_y,
            "maxMercatorY": max_y,
        },
        "initialView": {
            **initial_view,
            "minMercatorX": render_min_x,
            "maxMercatorX": render_max_x,
            "minMercatorY": render_min_y,
            "maxMercatorY": render_max_y,
        },
        "privacy": {
            "method": "deterministic randomized per-activity start/end point trim",
            "trimFractionRange": [0.035, 0.075],
        },
    }
    (output_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export-zip", default="data/a22756ef-76bc-4c8e-9407-5dea56a67a6b_1.zip")
    parser.add_argument("--raw-dir", default="data/raw/garmin_export")
    parser.add_argument("--output-dir", default="public")
    parser.add_argument("--max-points", type=int, default=900_000)
    parser.add_argument("--start-date", default="2022-05-01", help="Ignore runs before this UTC date.")
    parser.add_argument("--limit", type=int, default=0, help="Use only the latest N run summaries.")
    parser.add_argument("--match-window-hours", type=int, default=8)
    parser.add_argument("--initial-view-fraction", type=float, default=0.80)
    parser.add_argument("--initial-view-mode", choices=["cluster", "percentile"], default="cluster")
    parser.add_argument("--cluster-cell-size", type=float, default=0.004)
    parser.add_argument("--cluster-radius-cells", type=int, default=2)
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> None:
    meta = build_visualization_data(parse_args())
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
