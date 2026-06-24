#!/usr/bin/env python3
"""Build browser-ready running map assets from a Garmin account export ZIP."""

from __future__ import annotations

import argparse
import bisect
import json
import math
import random
import re
import shutil
import stat
import struct
import sys
import tempfile
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import IntEnum
from pathlib import Path, PurePosixPath

GARMIN_EPOCH = 631065600
SEMICIRCLE_TO_DEGREES = 180.0 / (2**31)
MAX_ZIP_MEMBERS = 120_000
MAX_UNCOMPRESSED_BYTES = 12 * 1024 * 1024 * 1024
MAX_ZIP_MEMBER_BYTES = 750 * 1024 * 1024
MAX_COMPRESSION_RATIO = 100
MAX_WHOLE_ARCHIVE_COMPRESSION_RATIO = 80
MAX_NESTED_ACTIVITY_ZIPS = 2_000
MAX_SUMMARY_JSON_BYTES = 50 * 1024 * 1024
MAX_FIT_FILE_BYTES = 50 * 1024 * 1024
MAX_FIT_FILES = 40_000
MAX_FIT_RECORDS = 3_000_000
MAX_FIT_FIELD_COUNT = 255
MAX_FIT_FIELD_SIZE = 1024
MAX_PARSED_POINTS_BEFORE_DOWNSAMPLING = 8_000_000
MIN_ACTIVITY_UNIX_SECONDS = 946684800
MAX_ACTIVITY_UNIX_SECONDS = 4102444800
RUN_ACTIVITY_TYPES = {
    "running",
    "track_running",
    "trail_running",
    "street_running",
    "virtual_running",
    "treadmill_running",
}
TEMPLATE_FILES = ("index.html", "app.js", "styles.css")
WINDOWS_DEVICE_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *{f"COM{index}" for index in range(1, 10)},
    *{f"LPT{index}" for index in range(1, 10)},
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


class ExitCode(IntEnum):
    OK = 0
    INVALID_ZIP = 2
    NO_RUNS_FOUND = 3
    PARSER_FAILURE = 4
    INTERNAL_ERROR = 5


class ProcessorError(Exception):
    exit_code = ExitCode.INTERNAL_ERROR
    code = "INTERNAL_ERROR"


class InvalidZipError(ProcessorError):
    exit_code = ExitCode.INVALID_ZIP
    code = "INVALID_ZIP"


class ZipTooLargeError(InvalidZipError):
    code = "ZIP_TOO_LARGE"


class ZipUnusualCompressionError(InvalidZipError):
    code = "ZIP_UNUSUAL_COMPRESSION"


class NoRunsFoundError(ProcessorError):
    exit_code = ExitCode.NO_RUNS_FOUND
    code = "NO_RUNS_FOUND"


class GarminExportNotFoundError(NoRunsFoundError):
    code = "GARMIN_EXPORT_NOT_FOUND"


class GarminActivityFilesMissingError(NoRunsFoundError):
    code = "GARMIN_ACTIVITY_FILES_MISSING"


class ParserFailureError(ProcessorError):
    exit_code = ExitCode.PARSER_FAILURE
    code = "PARSER_FAILURE"


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


def validate_fit_timestamp(timestamp: int | None) -> None:
    if timestamp is None:
        return
    unix_seconds = timestamp + GARMIN_EPOCH
    if not MIN_ACTIVITY_UNIX_SECONDS <= unix_seconds <= MAX_ACTIVITY_UNIX_SECONDS:
        raise ParserFailureError("FIT timestamp is outside the allowed range.")


def parse_fit_records(blob: bytes, *, max_records: int = MAX_FIT_RECORDS) -> list[tuple[int | None, float, float]]:
    if len(blob) < 14:
        raise ParserFailureError("FIT file is too small.")
    header_size = blob[0]
    if header_size not in (12, 14) or blob[8:12] != b".FIT":
        raise ParserFailureError("FIT file header is invalid.")
    data_size = struct.unpack_from("<I", blob, 4)[0]
    offset = header_size
    end = header_size + data_size
    if end > len(blob):
        raise ParserFailureError("FIT file data section is truncated.")
    definitions: dict[int, MessageDef] = {}
    records: list[tuple[int | None, float, float]] = []
    last_timestamp: int | None = None
    scanned_records = 0

    while offset < end:
        header = blob[offset]
        offset += 1
        scanned_records += 1
        if scanned_records > max_records:
            raise ParserFailureError("FIT file contains too many records.")

        if header & 0x80:
            local_num = (header >> 5) & 0x03
            timestamp_offset = header & 0x1F
            msg_def = definitions.get(local_num)
            if not msg_def or offset + msg_def.size > end:
                raise ParserFailureError("FIT compressed timestamp record is malformed.")
            payload = blob[offset : offset + msg_def.size]
            offset += msg_def.size
            timestamp = None
            if last_timestamp is not None:
                timestamp = (last_timestamp & ~0x1F) + timestamp_offset
                if timestamp <= last_timestamp - 16:
                    timestamp += 32
                validate_fit_timestamp(timestamp)
                last_timestamp = timestamp
            add_record_point(records, msg_def, payload, timestamp)
            continue

        is_definition = bool(header & 0x40)
        local_num = header & 0x0F
        has_developer_fields = bool(header & 0x20)
        if header & 0x10:
            raise ParserFailureError("FIT record header uses reserved bits.")

        if is_definition:
            if offset + 5 > end:
                raise ParserFailureError("FIT definition record is truncated.")
            offset += 1
            architecture = blob[offset]
            offset += 1
            if architecture not in (0, 1):
                raise ParserFailureError("FIT architecture flag is invalid.")
            endian = "big" if architecture else "little"
            prefix = ">" if endian == "big" else "<"
            global_num = struct.unpack_from(prefix + "H", blob, offset)[0]
            offset += 2
            field_count = blob[offset]
            offset += 1
            if field_count > MAX_FIT_FIELD_COUNT:
                raise ParserFailureError("FIT definition contains too many fields.")
            fields: list[FieldDef] = []
            total_size = 0
            for _ in range(field_count):
                if offset + 3 > end:
                    raise ParserFailureError("FIT field definition is truncated.")
                number, size, base_type = blob[offset], blob[offset + 1], blob[offset + 2]
                if size > MAX_FIT_FIELD_SIZE:
                    raise ParserFailureError("FIT field is too large.")
                fields.append(FieldDef(number, size, base_type))
                total_size += size
                offset += 3
            if has_developer_fields:
                if offset >= end:
                    raise ParserFailureError("FIT developer field definition is truncated.")
                developer_field_count = blob[offset]
                offset += 1
                if developer_field_count > MAX_FIT_FIELD_COUNT:
                    raise ParserFailureError("FIT definition contains too many developer fields.")
                for _ in range(developer_field_count):
                    if offset + 3 > end:
                        raise ParserFailureError("FIT developer field definition is truncated.")
                    size = blob[offset + 1]
                    if size > MAX_FIT_FIELD_SIZE:
                        raise ParserFailureError("FIT developer field is too large.")
                    total_size += size
                    offset += 3
            definitions[local_num] = MessageDef(global_num, endian, fields, total_size)
            continue

        msg_def = definitions.get(local_num)
        if not msg_def or offset + msg_def.size > end:
            raise ParserFailureError("FIT data record is missing a valid definition.")
        payload = blob[offset : offset + msg_def.size]
        offset += msg_def.size
        timestamp = add_record_point(records, msg_def, payload, None)
        if timestamp is not None:
            validate_fit_timestamp(timestamp)
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
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ParserFailureError("FIT coordinate is outside the allowed range.")
    if not (lat == 0 and lon == 0):
        records.append((timestamp, lat, lon))
        if len(records) > MAX_PARSED_POINTS_BEFORE_DOWNSAMPLING:
            raise ParserFailureError("FIT file contains too many GPS points.")
    return timestamp


def validate_zip_signature(zip_path: Path) -> None:
    try:
        with zip_path.open("rb") as file:
            signature = file.read(4)
    except OSError as error:
        raise InvalidZipError("ZIP file could not be read.") from error
    if signature not in (b"PK\x03\x04", b"PK\x05\x06"):
        raise InvalidZipError("Input is not a valid ZIP file.")


def normalized_zip_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    if "\0" in name or "\\" in name:
        raise InvalidZipError(f"Suspicious ZIP member path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise InvalidZipError(f"Suspicious ZIP member path: {name!r}")
    parts = tuple(part for part in path.parts if part != "/")
    if any(part.startswith(".") for part in parts):
        raise InvalidZipError(f"Suspicious ZIP member path: {name!r}")
    if parts and parts[0] == "__MACOSX":
        raise InvalidZipError("ZIP contains hidden macOS metadata.")
    for part in parts:
        stem = part.split(".", 1)[0].upper().rstrip(" ")
        if stem in WINDOWS_DEVICE_NAMES:
            raise InvalidZipError(f"ZIP member uses a reserved Windows device name: {name!r}")
    return "/".join(parts).rstrip("/")


def validate_zip_member(info: zipfile.ZipInfo) -> str:
    normalized = normalized_zip_name(info)
    mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(mode)
    if file_type:
        if file_type == stat.S_IFLNK:
            raise InvalidZipError(f"ZIP member is a symlink: {info.filename!r}")
        if file_type not in (stat.S_IFREG, stat.S_IFDIR):
            raise InvalidZipError(f"ZIP member is not a regular file: {info.filename!r}")
    return normalized


def bounded_zip_read(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    max_bytes: int,
    *,
    message: str,
) -> bytes:
    if info.file_size > max_bytes:
        raise ZipTooLargeError(message)
    return archive.read(info)


def validate_zip_file(
    zip_path: Path,
    *,
    max_members: int = MAX_ZIP_MEMBERS,
    max_uncompressed_bytes: int = MAX_UNCOMPRESSED_BYTES,
    max_member_bytes: int = MAX_ZIP_MEMBER_BYTES,
) -> None:
    validate_zip_signature(zip_path)
    try:
        with zipfile.ZipFile(zip_path) as archive:
            infos = archive.infolist()
            if len(infos) > max_members:
                raise InvalidZipError("ZIP contains too many files.")
            total_uncompressed = 0
            total_compressed = 0
            seen_names: set[str] = set()
            for info in infos:
                normalized = validate_zip_member(info)
                if normalized in seen_names:
                    raise InvalidZipError(f"ZIP contains duplicate member path: {normalized!r}")
                seen_names.add(normalized)
                if info.is_dir():
                    continue
                if info.file_size > max_member_bytes:
                    raise ZipTooLargeError("ZIP member is too large.")
                total_uncompressed += info.file_size
                total_compressed += info.compress_size
                if info.compress_size == 0 and info.file_size > 0:
                    raise ZipUnusualCompressionError("ZIP member has an unusual compression ratio.")
                if info.compress_size > 0 and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
                    raise ZipUnusualCompressionError("ZIP member has an unusual compression ratio.")
            if total_uncompressed > max_uncompressed_bytes:
                raise ZipTooLargeError("ZIP uncompressed contents are too large.")
            if total_compressed > 0 and total_uncompressed / total_compressed > MAX_WHOLE_ARCHIVE_COMPRESSION_RATIO:
                raise ZipUnusualCompressionError("ZIP has an unusual compression ratio.")
            bad_member = archive.testzip()
            if bad_member:
                raise InvalidZipError(f"ZIP member failed CRC check: {bad_member}")
    except zipfile.BadZipFile as error:
        raise InvalidZipError("Input is not a valid ZIP file.") from error


def parse_garmin_millis(value) -> int:
    if value is None:
        return 0
    if isinstance(value, int | float):
        return int(value)
    text = str(value).strip()
    if not text:
        return 0
    if text.isdigit():
        return int(text)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return 0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return int(parsed.timestamp() * 1000)


def validate_activity_millis(value: int, *, context: str) -> None:
    if value <= 0:
        raise ParserFailureError(f"{context} timestamp is missing or invalid.")
    seconds = value // 1000
    if not MIN_ACTIVITY_UNIX_SECONDS <= seconds <= MAX_ACTIVITY_UNIX_SECONDS:
        raise ParserFailureError(f"{context} timestamp is outside the allowed range.")


def iter_summarized_activities(export_zip: Path) -> list[Activity]:
    activities: list[Activity] = []
    has_di_connect = False
    summary_files = 0
    seen_activity_ids: set[int] = set()
    try:
        with zipfile.ZipFile(export_zip) as archive:
            for info in archive.infolist():
                name = validate_zip_member(info)
                if name.startswith("DI_CONNECT/"):
                    has_di_connect = True
                if not name.endswith("_summarizedActivities.json"):
                    continue
                summary_files += 1
                payload = json.loads(
                    bounded_zip_read(
                        archive,
                        info,
                        MAX_SUMMARY_JSON_BYTES,
                        message="Garmin activity summary JSON is too large.",
                    )
                )
                if not isinstance(payload, list):
                    raise ParserFailureError("Garmin activity summary JSON has an unexpected shape.")
                for block in payload:
                    if not isinstance(block, dict):
                        raise ParserFailureError("Garmin activity summary JSON has an unexpected block.")
                    rows = block.get("summarizedActivitiesExport", [])
                    if not isinstance(rows, list):
                        raise ParserFailureError("Garmin activity summary JSON has an unexpected activities list.")
                    for row in rows:
                        if not isinstance(row, dict):
                            raise ParserFailureError("Garmin activity summary row has an unexpected shape.")
                        activity_type = str(row.get("activityType", "")).lower()
                        if activity_type not in RUN_ACTIVITY_TYPES:
                            continue
                        activity_id = row.get("activityId")
                        if activity_id is None:
                            continue
                        try:
                            activity_id = int(activity_id)
                            start_ms = parse_garmin_millis(row.get("startTimeGmt") or row.get("beginTimestamp"))
                            distance_m = float(row.get("distance") or 0) / 100.0
                        except (TypeError, ValueError) as error:
                            raise ParserFailureError("Garmin activity summary contains invalid field types.") from error
                        if activity_id in seen_activity_ids:
                            raise ParserFailureError("Garmin activity summary contains duplicate activity IDs.")
                        seen_activity_ids.add(activity_id)
                        validate_activity_millis(start_ms, context="Garmin activity")
                        if distance_m < 0 or distance_m > 1_000_000:
                            raise ParserFailureError("Garmin activity distance is outside the allowed range.")
                        activities.append(
                            Activity(
                                activity_id=activity_id,
                                name=str(row.get("name") or "Run")[:160],
                                activity_type=activity_type,
                                start_ms=start_ms,
                                distance_m=distance_m,
                            )
                        )
    except (json.JSONDecodeError, OSError, zipfile.BadZipFile) as error:
        raise ParserFailureError("Could not parse Garmin activity summaries.") from error
    if not has_di_connect:
        raise GarminExportNotFoundError("This ZIP does not contain Garmin account export folders.")
    if summary_files == 0:
        raise GarminActivityFilesMissingError("Garmin export found, but activity summaries were missing.")
    activities.sort(key=lambda item: item.start_ms)
    return activities


def safe_nested_zip_name(name: str, index: int) -> str:
    basename = PurePosixPath(name).name
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", basename).strip(".-")
    if not stem:
        stem = f"uploaded-{index}.zip"
    if not stem.lower().endswith(".zip"):
        stem = f"{stem}.zip"
    return f"{index:05d}-{stem}"


def extract_uploaded_zips(export_zip: Path, raw_dir: Path) -> list[Path]:
    raw_dir.mkdir(parents=True, exist_ok=True)
    extracted: list[Path] = []
    try:
        with zipfile.ZipFile(export_zip) as archive:
            for info in archive.infolist():
                name = validate_zip_member(info)
                if not re.search(r"DI_CONNECT/DI-Connect-Uploaded-Files/.*\.zip$", name):
                    continue
                if len(extracted) >= MAX_NESTED_ACTIVITY_ZIPS:
                    raise InvalidZipError("Garmin export contains too many nested activity ZIPs.")
                target = raw_dir / safe_nested_zip_name(name, len(extracted) + 1)
                with archive.open(info) as source, target.open("wb") as destination:
                    shutil.copyfileobj(source, destination)
                validate_zip_file(target, max_member_bytes=MAX_FIT_FILE_BYTES)
                extracted.append(target)
    except zipfile.BadZipFile as error:
        raise InvalidZipError("Input is not a valid Garmin export ZIP.") from error
    return sorted(extracted)


def list_fit_entries(uploaded_zips: Iterable[Path]) -> list[FitEntry]:
    entries: list[FitEntry] = []
    for zip_path in uploaded_zips:
        try:
            with zipfile.ZipFile(zip_path) as archive:
                for info in archive.infolist():
                    name = validate_zip_member(info)
                    if info.is_dir():
                        continue
                    if name.lower().endswith(".zip"):
                        raise InvalidZipError("Nested ZIPs beyond Garmin activity ZIPs are not allowed.")
                    if not name.lower().endswith(".fit"):
                        continue
                    if info.file_size > MAX_FIT_FILE_BYTES:
                        raise ZipTooLargeError("FIT file is too large.")
                    entries.append(FitEntry(zip_path, name))
                    if len(entries) > MAX_FIT_FILES:
                        raise InvalidZipError("Garmin export contains too many FIT files.")
        except zipfile.BadZipFile as error:
            raise InvalidZipError(f"Nested Garmin upload is not a valid ZIP: {zip_path.name}") from error
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
        raise NoRunsFoundError("No projected points were available.")
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
    best_cell = max(counts, key=lambda key: counts[key])
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
    unix_seconds = timestamp + GARMIN_EPOCH if timestamp is not None else fallback_ms / 1000.0
    return datetime.fromtimestamp(unix_seconds, UTC).isoformat().replace("+00:00", "Z")


def parse_start_date(value: str) -> int:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("Use YYYY-MM-DD for --start-date.") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return int(parsed.timestamp())


def copy_template_assets(template_dir: Path, output_dir: Path) -> None:
    missing = [name for name in TEMPLATE_FILES if not (template_dir / name).is_file()]
    if missing:
        raise ParserFailureError(f"Template is missing required files: {', '.join(missing)}")
    for name in TEMPLATE_FILES:
        shutil.copy2(template_dir / name, output_dir / name)


def possessive_title(display_name: str) -> str:
    name = display_name.strip()
    if not name:
        return "Running Footprints"
    suffix = "'" if name.lower().endswith("s") else "'s"
    return f"{name}{suffix} Running Footprints"


def build_visualization_site(
    export_zip: Path,
    output_dir: Path,
    raw_dir: Path,
    template_dir: Path,
    *,
    slug: str,
    display_name: str,
    site_url: str | None,
    start_date: str | None,
    max_points: int,
    match_window_hours: int = 8,
    initial_view_fraction: float = 0.80,
    initial_view_mode: str = "cluster",
    cluster_cell_size: float = 0.004,
    cluster_radius_cells: int = 2,
    verbose: bool = False,
) -> dict:
    if max_points <= 0:
        raise ParserFailureError("--max-points must be greater than zero.")

    validate_zip_file(export_zip)
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)
    start_timestamp = parse_start_date(start_date) if start_date else None

    activities = iter_summarized_activities(export_zip)
    uploaded_zips = extract_uploaded_zips(export_zip, raw_dir)
    if not uploaded_zips:
        raise GarminActivityFilesMissingError("Garmin export found, but activity files were missing.")
    fit_entries = list_fit_entries(uploaded_zips)
    if not fit_entries:
        raise GarminActivityFilesMissingError("Garmin export found, but FIT activity files were missing.")
    if not activities:
        raise NoRunsFoundError("No running GPS activities were found in the Garmin export.")
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
    try:
        for zip_path in uploaded_zips:
            names = [entry.name for entry in fit_entries if entry.zip_path == zip_path]
            with zipfile.ZipFile(zip_path) as archive:
                for fit_name in names:
                    scanned += 1
                    if verbose and scanned % 1000 == 0:
                        print(
                            f"scanned {scanned}/{len(fit_entries)} FIT files; "
                            f"gps_candidates={candidate_gps_files}; matched_runs={parsed_activities}; "
                            f"points={len(projected):,}"
                        )
                    fit_info = archive.getinfo(fit_name)
                    points = parse_fit_records(
                        bounded_zip_read(
                            archive,
                            fit_info,
                            MAX_FIT_FILE_BYTES,
                            message="FIT file is too large.",
                        )
                    )
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
                    activity = match_activity(fit_start, match_window_hours * 3600)
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
                        unix_seconds = (
                            (timestamp + GARMIN_EPOCH) if timestamp is not None else activity.start_ms // 1000
                        )
                        projected.append((x, y, int(unix_seconds)))
                    if len(projected) > MAX_PARSED_POINTS_BEFORE_DOWNSAMPLING:
                        raise ParserFailureError("Too many parsed GPS points before downsampling.")
                    activity_start_times.append(
                        int((points[0][0] + GARMIN_EPOCH) if points[0][0] is not None else activity.start_ms // 1000)
                    )
                    activity_start = iso_from_fit_timestamp(points[0][0], activity.start_ms)
                    activity_end = iso_from_fit_timestamp(points[-1][0], activity.start_ms)
                    start_iso = activity_start if start_iso is None or activity_start < start_iso else start_iso
                    end_iso = activity_end if end_iso is None or activity_end > end_iso else end_iso
    except zipfile.BadZipFile as error:
        raise InvalidZipError("Nested Garmin upload is not a valid ZIP.") from error
    except (OSError, struct.error) as error:
        raise ParserFailureError("Could not parse Garmin FIT data.") from error

    if not projected:
        raise NoRunsFoundError("No running GPS data was found in the Garmin export.")

    original_point_count = len(projected)
    sampled = original_point_count > max_points
    if sampled:
        rng = random.Random(42)
        projected = rng.sample(projected, max_points)

    min_x = min(row[0] for row in projected)
    max_x = max(row[0] for row in projected)
    min_y = min(row[1] for row in projected)
    max_y = max(row[1] for row in projected)
    min_t = min(row[2] for row in projected)
    max_t = max(row[2] for row in projected)
    initial_view: dict[str, float | int | str]
    render_min_x: float
    render_max_x: float
    render_min_y: float
    render_max_y: float
    effective_view_mode = initial_view_mode

    if effective_view_mode == "cluster":
        try:
            render_min_x, render_max_x, render_min_y, render_max_y, cluster_points = densest_cluster_bounds(
                projected,
                cluster_cell_size,
                cluster_radius_cells,
            )
            initial_view = {
                "mode": "densest_cluster",
                "cellSize": cluster_cell_size,
                "radiusCells": cluster_radius_cells,
                "pointCount": cluster_points,
            }
        except ValueError:
            effective_view_mode = "percentile"

    if effective_view_mode == "percentile":
        x_values = sorted(row[0] for row in projected)
        y_values = sorted(row[1] for row in projected)
        tail = (1.0 - initial_view_fraction) / 2.0
        render_min_x = percentile(x_values, tail)
        render_max_x = percentile(x_values, 1.0 - tail)
        render_min_y = percentile(y_values, tail)
        render_max_y = percentile(y_values, 1.0 - tail)
        initial_view = {
            "mode": "central_percentile",
            "centralPointFraction": initial_view_fraction,
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

    copy_template_assets(template_dir, output_dir)
    (output_dir / "points.bin").write_bytes(triples)
    meta = {
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "slug": slug,
        "displayName": display_name,
        "viewerTitle": possessive_title(display_name),
        "siteUrl": site_url,
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
        "originalPointCount": original_point_count,
        "runProgress": sorted((timestamp - min_t) / time_extent for timestamp in activity_start_times),
        "maxPoints": max_points,
        "sampled": sampled,
        "requestedStartDate": start_date,
        "start": datetime.fromtimestamp(min_t, UTC).isoformat().replace("+00:00", "Z"),
        "end": datetime.fromtimestamp(max_t, UTC).isoformat().replace("+00:00", "Z"),
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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export_zip", type=Path, help="Garmin account export ZIP.")
    parser.add_argument("output_dir", type=Path, help="Directory for generated static site assets.")
    parser.add_argument("--slug", required=True, help="Public site slug.")
    parser.add_argument("--display-name", default="", help="Optional display name for the generated map.")
    parser.add_argument("--site-url", default=None, help="Final public URL, if known.")
    parser.add_argument("--template-dir", type=Path, default=Path("template"))
    parser.add_argument("--raw-dir", type=Path, default=None, help="Temporary directory for nested Garmin upload ZIPs.")
    parser.add_argument("--max-points", type=int, default=900_000)
    parser.add_argument("--start-date", default="2022-05-01", help="Ignore runs before this UTC date.")
    parser.add_argument("--match-window-hours", type=int, default=8)
    parser.add_argument("--initial-view-fraction", type=float, default=0.80)
    parser.add_argument("--initial-view-mode", choices=["cluster", "percentile"], default="cluster")
    parser.add_argument("--cluster-cell-size", type=float, default=0.004)
    parser.add_argument("--cluster-radius-cells", type=int, default=2)
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.raw_dir is None:
            with tempfile.TemporaryDirectory(prefix="garmin-footprints-") as temp_dir:
                meta = build_visualization_site(
                    args.export_zip,
                    args.output_dir,
                    Path(temp_dir),
                    args.template_dir,
                    slug=args.slug,
                    display_name=args.display_name,
                    site_url=args.site_url,
                    start_date=args.start_date,
                    max_points=args.max_points,
                    match_window_hours=args.match_window_hours,
                    initial_view_fraction=args.initial_view_fraction,
                    initial_view_mode=args.initial_view_mode,
                    cluster_cell_size=args.cluster_cell_size,
                    cluster_radius_cells=args.cluster_radius_cells,
                    verbose=args.verbose,
                )
        else:
            meta = build_visualization_site(
                args.export_zip,
                args.output_dir,
                args.raw_dir,
                args.template_dir,
                slug=args.slug,
                display_name=args.display_name,
                site_url=args.site_url,
                start_date=args.start_date,
                max_points=args.max_points,
                match_window_hours=args.match_window_hours,
                initial_view_fraction=args.initial_view_fraction,
                initial_view_mode=args.initial_view_mode,
                cluster_cell_size=args.cluster_cell_size,
                cluster_radius_cells=args.cluster_radius_cells,
                verbose=args.verbose,
            )
        print(json.dumps(meta, indent=2))
        return ExitCode.OK
    except ProcessorError as error:
        print(json.dumps({"errorCode": error.code, "errorMessage": str(error)}), file=sys.stderr)
        return int(error.exit_code)
    except Exception as error:  # pragma: no cover - defensive CLI boundary
        print(
            json.dumps({"errorCode": "INTERNAL_ERROR", "errorMessage": f"{type(error).__name__}: {error}"}),
            file=sys.stderr,
        )
        return int(ExitCode.INTERNAL_ERROR)


if __name__ == "__main__":
    raise SystemExit(main())
