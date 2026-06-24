import { BlobReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, configure } from "../vendor/zip.js";

configure({ useWebWorkers: false });

export const GARMIN_EPOCH = 631065600;
const SEMICIRCLE_TO_DEGREES = 180 / 2 ** 31;
const MAX_ZIP_MEMBERS = 120_000;
const MAX_UNCOMPRESSED_BYTES = 12 * 1024 * 1024 * 1024;
const MAX_ZIP_MEMBER_BYTES = 750 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const MAX_WHOLE_ARCHIVE_COMPRESSION_RATIO = 80;
const MAX_NESTED_ACTIVITY_ZIPS = 2_000;
const MAX_SUMMARY_JSON_BYTES = 50 * 1024 * 1024;
const MAX_FIT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FIT_FILES = 40_000;
const MAX_FIT_RECORDS = 3_000_000;
const MAX_FIT_FIELD_COUNT = 255;
const MAX_FIT_FIELD_SIZE = 1024;
const MAX_PARSED_POINTS_BEFORE_DOWNSAMPLING = 8_000_000;
const MIN_ACTIVITY_UNIX_SECONDS = 946684800;
const MAX_ACTIVITY_UNIX_SECONDS = 4102444800;
const DEFAULT_START_DATE = "2022-05-01";
const RUN_ACTIVITY_TYPES = new Set([
  "running",
  "track_running",
  "trail_running",
  "street_running",
  "virtual_running",
  "treadmill_running",
]);
const WINDOWS_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
const BASE_TYPE_FORMATS = new Map([
  [0, ["uint8", 1]],
  [1, ["int8", 1]],
  [2, ["uint8", 1]],
  [3, ["int16", 2]],
  [4, ["uint16", 2]],
  [5, ["int32", 4]],
  [6, ["uint32", 4]],
  [8, ["float32", 4]],
  [9, ["float64", 8]],
  [10, ["uint8", 1]],
  [11, ["uint16", 2]],
  [12, ["uint32", 4]],
  [13, ["uint8", 1]],
  [14, ["int64", 8]],
  [15, ["uint64", 8]],
  [16, ["uint64", 8]],
]);

export class ProcessorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProcessorError";
    this.code = code;
  }
}

export class InvalidZipError extends ProcessorError {
  constructor(message = "Input is not a valid ZIP file.", code = "INVALID_ZIP") {
    super(code, message);
  }
}

export class NoRunsFoundError extends ProcessorError {
  constructor(message = "No running GPS activities were found.", code = "NO_RUNS_FOUND") {
    super(code, message);
  }
}

export class ParserFailureError extends ProcessorError {
  constructor(message = "Could not parse Garmin FIT data.") {
    super("PARSER_FAILURE", message);
  }
}

function zipTooLarge(message) {
  return new InvalidZipError(message, "ZIP_TOO_LARGE");
}

function unusualCompression(message) {
  return new InvalidZipError(message, "ZIP_UNUSUAL_COMPRESSION");
}

function abortIfNeeded(signal) {
  if (signal?.aborted) {
    throw new DOMException("Processing was canceled.", "AbortError");
  }
}

async function yieldToBrowser(signal) {
  abortIfNeeded(signal);
  await Promise.resolve();
}

function report(options, phase, detail = {}) {
  options.onProgress?.({ phase, ...detail });
}

function entryName(entry) {
  return String(entry.filename || "");
}

function entryCompressedSize(entry) {
  return Number(entry.compressedSize ?? entry.compressedSize64 ?? 0);
}

function entryUncompressedSize(entry) {
  return Number(entry.uncompressedSize ?? entry.uncompressedSize64 ?? 0);
}

function isDirectory(entry) {
  return Boolean(entry.directory || entryName(entry).endsWith("/"));
}

function normalizedZipName(entry) {
  const name = entryName(entry);
  if (!name || name.includes("\0") || name.includes("\\")) {
    throw new InvalidZipError(`Suspicious ZIP member path: ${JSON.stringify(name)}`);
  }
  if (name.startsWith("/")) {
    throw new InvalidZipError(`Suspicious ZIP member path: ${JSON.stringify(name)}`);
  }
  const parts = name.split("/").filter((part) => part.length > 0);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new InvalidZipError(`Suspicious ZIP member path: ${JSON.stringify(name)}`);
  }
  if (parts.some((part) => part.startsWith("."))) {
    throw new InvalidZipError(`Suspicious ZIP member path: ${JSON.stringify(name)}`);
  }
  if (parts[0] === "__MACOSX") {
    throw new InvalidZipError("ZIP contains hidden macOS metadata.");
  }
  for (const part of parts) {
    const stem = part.split(".", 1)[0].toUpperCase().replace(/\s+$/u, "");
    if (WINDOWS_DEVICE_NAMES.has(stem)) {
      throw new InvalidZipError(`ZIP member uses a reserved Windows device name: ${JSON.stringify(name)}`);
    }
  }
  return parts.join("/");
}

function validateZipEntry(entry) {
  const normalized = normalizedZipName(entry);
  const mode = Number(entry.externalFileAttribute ?? entry.externalFileAttributes ?? 0) >>> 16;
  const fileType = mode & 0xf000;
  if (fileType) {
    if (fileType === 0xa000) {
      throw new InvalidZipError(`ZIP member is a symlink: ${JSON.stringify(entryName(entry))}`);
    }
    if (![0x8000, 0x4000].includes(fileType)) {
      throw new InvalidZipError(`ZIP member is not a regular file: ${JSON.stringify(entryName(entry))}`);
    }
  }
  return normalized;
}

async function readZipEntries(reader, validationOptions = {}) {
  const zipReader = new ZipReader(reader);
  try {
    const entries = await zipReader.getEntries();
    validateZipEntries(entries, validationOptions);
    return { zipReader, entries };
  } catch (error) {
    await zipReader.close().catch(() => {});
    if (error instanceof ProcessorError) throw error;
    throw new InvalidZipError("Input is not a valid ZIP file.");
  }
}

function validateZipEntries(
  entries,
  {
    maxMembers = MAX_ZIP_MEMBERS,
    maxUncompressedBytes = MAX_UNCOMPRESSED_BYTES,
    maxMemberBytes = MAX_ZIP_MEMBER_BYTES,
  } = {}
) {
  if (entries.length > maxMembers) {
    throw new InvalidZipError("ZIP contains too many files.");
  }
  let totalUncompressed = 0;
  let totalCompressed = 0;
  const seenNames = new Set();
  for (const entry of entries) {
    const normalized = validateZipEntry(entry);
    if (seenNames.has(normalized)) {
      throw new InvalidZipError(`ZIP contains duplicate member path: ${JSON.stringify(normalized)}`);
    }
    seenNames.add(normalized);
    if (isDirectory(entry)) continue;
    const fileSize = entryUncompressedSize(entry);
    const compressedSize = entryCompressedSize(entry);
    if (fileSize > maxMemberBytes) {
      throw zipTooLarge("ZIP member is too large.");
    }
    totalUncompressed += fileSize;
    totalCompressed += compressedSize;
    if (compressedSize === 0 && fileSize > 0) {
      throw unusualCompression("ZIP member has an unusual compression ratio.");
    }
    if (compressedSize > 0 && fileSize / compressedSize > MAX_COMPRESSION_RATIO) {
      throw unusualCompression("ZIP member has an unusual compression ratio.");
    }
  }
  if (totalUncompressed > maxUncompressedBytes) {
    throw zipTooLarge("ZIP uncompressed contents are too large.");
  }
  if (totalCompressed > 0 && totalUncompressed / totalCompressed > MAX_WHOLE_ARCHIVE_COMPRESSION_RATIO) {
    throw unusualCompression("ZIP has an unusual compression ratio.");
  }
}

async function boundedEntryRead(entry, maxBytes, message) {
  if (entryUncompressedSize(entry) > maxBytes) {
    throw zipTooLarge(message);
  }
  try {
    return await entry.getData(new Uint8ArrayWriter());
  } catch (error) {
    if (error instanceof ProcessorError) throw error;
    throw new InvalidZipError("ZIP member failed validation.");
  }
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function parseGarminMillis(value) {
  if (value == null) return 0;
  if (typeof value === "number") return Math.trunc(value);
  const text = String(value).trim();
  if (!text) return 0;
  if (/^\d+$/u.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validateActivityMillis(value, context) {
  if (value <= 0) {
    throw new ParserFailureError(`${context} timestamp is missing or invalid.`);
  }
  const seconds = Math.trunc(value / 1000);
  if (seconds < MIN_ACTIVITY_UNIX_SECONDS || seconds > MAX_ACTIVITY_UNIX_SECONDS) {
    throw new ParserFailureError(`${context} timestamp is outside the allowed range.`);
  }
}

async function parseActivities(rootEntries, options) {
  const activities = [];
  let hasDiConnect = false;
  let summaryFiles = 0;
  const seenActivityIds = new Set();
  const maxSummaryBytes = options.limits?.maxSummaryJsonBytes ?? MAX_SUMMARY_JSON_BYTES;
  for (const entry of rootEntries) {
    const name = validateZipEntry(entry);
    if (name.startsWith("DI_CONNECT/")) hasDiConnect = true;
    if (!name.endsWith("_summarizedActivities.json")) continue;
    summaryFiles += 1;
    const payload = JSON.parse(
      decodeUtf8(await boundedEntryRead(entry, maxSummaryBytes, "Garmin activity summary JSON is too large."))
    );
    if (!Array.isArray(payload)) {
      throw new ParserFailureError("Garmin activity summary JSON has an unexpected shape.");
    }
    for (const block of payload) {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        throw new ParserFailureError("Garmin activity summary JSON has an unexpected block.");
      }
      const rows = block.summarizedActivitiesExport ?? [];
      if (!Array.isArray(rows)) {
        throw new ParserFailureError("Garmin activity summary JSON has an unexpected activities list.");
      }
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          throw new ParserFailureError("Garmin activity summary row has an unexpected shape.");
        }
        const activityType = String(row.activityType || "").toLowerCase();
        if (!RUN_ACTIVITY_TYPES.has(activityType) || row.activityId == null) continue;
        const activityId = Number(row.activityId);
        const startMs = parseGarminMillis(row.startTimeGmt || row.beginTimestamp);
        const distanceM = Number(row.distance || 0) / 100;
        if (!Number.isInteger(activityId) || !Number.isFinite(distanceM)) {
          throw new ParserFailureError("Garmin activity summary contains invalid field types.");
        }
        if (seenActivityIds.has(activityId)) {
          throw new ParserFailureError("Garmin activity summary contains duplicate activity IDs.");
        }
        validateActivityMillis(startMs, "Garmin activity");
        if (distanceM < 0 || distanceM > 1_000_000) {
          throw new ParserFailureError("Garmin activity distance is outside the allowed range.");
        }
        seenActivityIds.add(activityId);
        activities.push({
          activityId,
          name: String(row.name || "Run").slice(0, 160),
          activityType,
          startMs,
          distanceM,
        });
      }
    }
    await yieldToBrowser(options.signal);
  }
  if (!hasDiConnect) {
    throw new NoRunsFoundError("This ZIP does not contain Garmin account export folders.", "GARMIN_EXPORT_NOT_FOUND");
  }
  if (summaryFiles === 0) {
    throw new NoRunsFoundError(
      "Garmin export found, but activity summaries were missing.",
      "GARMIN_ACTIVITY_FILES_MISSING"
    );
  }
  activities.sort((left, right) => left.startMs - right.startMs);
  return activities;
}

function validateFitTimestamp(timestamp) {
  if (timestamp == null) return;
  const unixSeconds = timestamp + GARMIN_EPOCH;
  if (unixSeconds < MIN_ACTIVITY_UNIX_SECONDS || unixSeconds > MAX_ACTIVITY_UNIX_SECONDS) {
    throw new ParserFailureError("FIT timestamp is outside the allowed range.");
  }
}

function decodeValue(payload, cursor, field, littleEndian) {
  const typeNum = field.baseType & 0x1f;
  if (typeNum === 7) {
    const raw = payload.subarray(cursor, cursor + field.size);
    const nullIndex = raw.indexOf(0);
    return decodeUtf8(nullIndex === -1 ? raw : raw.subarray(0, nullIndex));
  }
  const info = BASE_TYPE_FORMATS.get(typeNum);
  if (!info) return null;
  const kind = String(info[0]);
  const width = Number(info[1]);
  if (field.size < width) return null;
  const count = Math.trunc(field.size / width);
  const view = new DataView(payload.buffer, payload.byteOffset + cursor, count * width);
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * width;
    if (kind === "uint8") values.push(view.getUint8(offset));
    else if (kind === "int8") values.push(view.getInt8(offset));
    else if (kind === "uint16") values.push(view.getUint16(offset, littleEndian));
    else if (kind === "int16") values.push(view.getInt16(offset, littleEndian));
    else if (kind === "uint32") values.push(view.getUint32(offset, littleEndian));
    else if (kind === "int32") values.push(view.getInt32(offset, littleEndian));
    else if (kind === "float32") values.push(view.getFloat32(offset, littleEndian));
    else if (kind === "float64") values.push(view.getFloat64(offset, littleEndian));
    else if (kind === "int64") values.push(Number(view.getBigInt64(offset, littleEndian)));
    else if (kind === "uint64") values.push(Number(view.getBigUint64(offset, littleEndian)));
  }
  return values.length === 1 ? values[0] : values;
}

function addRecordPoint(records, messageDef, payload, compressedTimestamp) {
  if (messageDef.globalNum !== 20) return null;
  let cursor = 0;
  let timestamp = compressedTimestamp;
  let latRaw = null;
  let lonRaw = null;
  for (const field of messageDef.fields) {
    if ([0, 1, 253].includes(field.number)) {
      const value = decodeValue(payload, cursor, field, messageDef.littleEndian);
      if (value != null) {
        if (field.number === 253) timestamp = Math.trunc(Number(value));
        else if (field.number === 0) latRaw = Math.trunc(Number(value));
        else if (field.number === 1) lonRaw = Math.trunc(Number(value));
      }
    }
    cursor += field.size;
  }
  if (latRaw == null || lonRaw == null) return timestamp;
  if ([0x7fffffff, -0x80000000].includes(latRaw) || [0x7fffffff, -0x80000000].includes(lonRaw)) {
    return timestamp;
  }
  const lat = latRaw * SEMICIRCLE_TO_DEGREES;
  const lon = lonRaw * SEMICIRCLE_TO_DEGREES;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new ParserFailureError("FIT coordinate is outside the allowed range.");
  }
  if (!(lat === 0 && lon === 0)) {
    records.push([timestamp, lat, lon]);
    if (records.length > MAX_PARSED_POINTS_BEFORE_DOWNSAMPLING) {
      throw new ParserFailureError("FIT file contains too many GPS points.");
    }
  }
  return timestamp;
}

export function parseFitRecords(blob, maxRecords = MAX_FIT_RECORDS) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.length < 14) throw new ParserFailureError("FIT file is too small.");
  const headerSize = bytes[0];
  if (![12, 14].includes(headerSize) || decodeUtf8(bytes.subarray(8, 12)) !== ".FIT") {
    throw new ParserFailureError("FIT file header is invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataSize = view.getUint32(4, true);
  let offset = headerSize;
  const end = headerSize + dataSize;
  if (end > bytes.length) throw new ParserFailureError("FIT file data section is truncated.");
  const definitions = new Map();
  const records = [];
  let lastTimestamp = null;
  let scannedRecords = 0;

  while (offset < end) {
    const header = bytes[offset];
    offset += 1;
    scannedRecords += 1;
    if (scannedRecords > maxRecords) throw new ParserFailureError("FIT file contains too many records.");

    if (header & 0x80) {
      const localNum = (header >> 5) & 0x03;
      const timestampOffset = header & 0x1f;
      const messageDef = definitions.get(localNum);
      if (!messageDef || offset + messageDef.size > end) {
        throw new ParserFailureError("FIT compressed timestamp record is malformed.");
      }
      const payload = bytes.subarray(offset, offset + messageDef.size);
      offset += messageDef.size;
      let timestamp = null;
      if (lastTimestamp != null) {
        const previousTimestamp = Number(lastTimestamp);
        timestamp = (previousTimestamp & ~0x1f) + timestampOffset;
        if (timestamp <= previousTimestamp - 16) timestamp += 32;
        validateFitTimestamp(timestamp);
        lastTimestamp = timestamp;
      }
      addRecordPoint(records, messageDef, payload, timestamp);
      continue;
    }

    const isDefinition = Boolean(header & 0x40);
    const localNum = header & 0x0f;
    const hasDeveloperFields = Boolean(header & 0x20);
    if (header & 0x10) throw new ParserFailureError("FIT record header uses reserved bits.");

    if (isDefinition) {
      if (offset + 5 > end) throw new ParserFailureError("FIT definition record is truncated.");
      offset += 1;
      const architecture = bytes[offset];
      offset += 1;
      if (![0, 1].includes(architecture)) throw new ParserFailureError("FIT architecture flag is invalid.");
      const littleEndian = architecture === 0;
      const globalNum = view.getUint16(offset, littleEndian);
      offset += 2;
      const fieldCount = bytes[offset];
      offset += 1;
      if (fieldCount > MAX_FIT_FIELD_COUNT) throw new ParserFailureError("FIT definition contains too many fields.");
      const fields = [];
      let totalSize = 0;
      for (let index = 0; index < fieldCount; index += 1) {
        if (offset + 3 > end) throw new ParserFailureError("FIT field definition is truncated.");
        const number = bytes[offset];
        const size = bytes[offset + 1];
        const baseType = bytes[offset + 2];
        if (size > MAX_FIT_FIELD_SIZE) throw new ParserFailureError("FIT field is too large.");
        fields.push({ number, size, baseType });
        totalSize += size;
        offset += 3;
      }
      if (hasDeveloperFields) {
        if (offset >= end) throw new ParserFailureError("FIT developer field definition is truncated.");
        const developerFieldCount = bytes[offset];
        offset += 1;
        if (developerFieldCount > MAX_FIT_FIELD_COUNT) {
          throw new ParserFailureError("FIT definition contains too many developer fields.");
        }
        for (let index = 0; index < developerFieldCount; index += 1) {
          if (offset + 3 > end) throw new ParserFailureError("FIT developer field definition is truncated.");
          const size = bytes[offset + 1];
          if (size > MAX_FIT_FIELD_SIZE) throw new ParserFailureError("FIT developer field is too large.");
          totalSize += size;
          offset += 3;
        }
      }
      definitions.set(localNum, { globalNum, littleEndian, fields, size: totalSize });
      continue;
    }

    const messageDef = definitions.get(localNum);
    if (!messageDef || offset + messageDef.size > end) {
      throw new ParserFailureError("FIT data record is missing a valid definition.");
    }
    const payload = bytes.subarray(offset, offset + messageDef.size);
    offset += messageDef.size;
    const timestamp = addRecordPoint(records, messageDef, payload, null);
    if (timestamp != null) {
      validateFitTimestamp(timestamp);
      lastTimestamp = timestamp;
    }
  }
  return records;
}

function buildActivityMatcher(activities) {
  const starts = activities
    .map((activity) => [Math.trunc(activity.startMs / 1000), activity])
    .sort((a, b) => a[0] - b[0]);
  const timestamps = starts.map((item) => item[0]);
  return (timestamp, windowSeconds) => {
    if (timestamp == null) return null;
    let low = 0;
    let high = timestamps.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (timestamps[mid] < timestamp) low = mid + 1;
      else high = mid;
    }
    const candidates = [];
    if (low < starts.length) candidates.push(starts[low]);
    if (low > 0) candidates.push(starts[low - 1]);
    if (!candidates.length) return null;
    const [nearestTs, activity] = candidates.reduce((best, item) =>
      Math.abs(item[0] - timestamp) < Math.abs(best[0] - timestamp) ? item : best
    );
    return Math.abs(nearestTs - timestamp) <= windowSeconds ? activity : null;
  };
}

function hashUnit(value) {
  let state = Math.imul(Number(value) || 0, 0x9e3779b1) >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x85ebca6b) >>> 0;
  state ^= state >>> 13;
  state = Math.imul(state, 0xc2b2ae35) >>> 0;
  state ^= state >>> 16;
  return state / 0xffffffff;
}

function trimActivityPoints(activityId, points) {
  if (points.length < 30) return [];
  points.sort((left, right) => (left[0] ?? -1) - (right[0] ?? -1));
  const fraction = 0.035 + hashUnit(activityId) * 0.04;
  const trimEachSide = Math.min(Math.max(10, Math.trunc(points.length * fraction)), Math.trunc(points.length / 3));
  return points.slice(trimEachSide, points.length - trimEachSide);
}

function mercator(lon, lat) {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  return [(lon * Math.PI) / 180, Math.log(Math.tan(Math.PI / 4 + latRad / 2))];
}

function percentile(values, fraction) {
  if (!values.length) throw new NoRunsFoundError("No projected points were available.");
  if (fraction <= 0) return values[0];
  if (fraction >= 1) return values.at(-1);
  const position = fraction * (values.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  const weight = position - lower;
  return values[lower] * (1 - weight) + values[upper] * weight;
}

function minMaxNumbers(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return [min, max];
}

function minNumber(values) {
  let min = Infinity;
  for (const value of values) {
    if (value < min) min = value;
  }
  return min;
}

function densestClusterBounds(projected, cellSize, radiusCells) {
  const counts = new Map();
  for (const [x, y] of projected) {
    const key = `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestKey = null;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  const [bestX, bestY] = bestKey.split(",").map(Number);
  const selected = projected.filter(
    ([x, y]) =>
      Math.abs(Math.floor(x / cellSize) - bestX) <= radiusCells &&
      Math.abs(Math.floor(y / cellSize) - bestY) <= radiusCells
  );
  if (selected.length < 1000) throw new Error("Densest cluster was too small for a useful initial view.");
  const xs = selected.map((row) => row[0]);
  const ys = selected.map((row) => row[1]);
  const [minX, maxX] = minMaxNumbers(xs);
  const [minY, maxY] = minMaxNumbers(ys);
  return [minX, maxX, minY, maxY, selected.length];
}

function parseStartDate(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ParserFailureError("Use YYYY-MM-DD for start date.");
  return Math.trunc(parsed / 1000);
}

function isoFromUnixSeconds(seconds) {
  return new Date(seconds * 1000).toISOString();
}

function deterministicSample(projected, maxPoints) {
  const keyed = projected.map((point, index) => [hashUnit((index + 1) * 2654435761), point]);
  keyed.sort((left, right) => left[0] - right[0]);
  return keyed.slice(0, maxPoints).map((row) => row[1]);
}

function generateAssets(projected, stats, options) {
  const maxPoints = options.maxPoints || 900_000;
  const originalPointCount = projected.length;
  const sampled = originalPointCount > maxPoints;
  if (sampled) projected = deterministicSample(projected, maxPoints);
  const xs = projected.map((row) => row[0]);
  const ys = projected.map((row) => row[1]);
  const ts = projected.map((row) => row[2]);
  const [minX, maxX] = minMaxNumbers(xs);
  const [minY, maxY] = minMaxNumbers(ys);
  const [minT, maxT] = minMaxNumbers(ts);
  let renderMinX;
  let renderMaxX;
  let renderMinY;
  let renderMaxY;
  let initialView;
  try {
    const [clusterMinX, clusterMaxX, clusterMinY, clusterMaxY, clusterPoints] = densestClusterBounds(
      projected,
      0.004,
      2
    );
    renderMinX = clusterMinX;
    renderMaxX = clusterMaxX;
    renderMinY = clusterMinY;
    renderMaxY = clusterMaxY;
    initialView = { mode: "densest_cluster", cellSize: 0.004, radiusCells: 2, pointCount: clusterPoints };
  } catch {
    const sortedX = [...xs].sort((a, b) => a - b);
    const sortedY = [...ys].sort((a, b) => a - b);
    const tail = 0.1;
    renderMinX = percentile(sortedX, tail);
    renderMaxX = percentile(sortedX, 1 - tail);
    renderMinY = percentile(sortedY, tail);
    renderMaxY = percentile(sortedY, 1 - tail);
    initialView = { mode: "central_percentile", centralPointFraction: 0.8 };
  }
  const centerX = (renderMinX + renderMaxX) / 2;
  const centerY = (renderMinY + renderMaxY) / 2;
  const extent = Math.max(renderMaxX - renderMinX, renderMaxY - renderMinY) || 1;
  const timeExtent = Math.max(maxT - minT, 1);
  projected.sort((left, right) => left[2] - right[2]);
  const points = new Float32Array(projected.length * 3);
  projected.forEach(([x, y, timestamp], index) => {
    points[index * 3] = ((x - centerX) / extent) * 2;
    points[index * 3 + 1] = ((y - centerY) / extent) * 2;
    points[index * 3 + 2] = (timestamp - minT) / timeExtent;
  });
  const meta = {
    generatedAt: new Date().toISOString(),
    slug: options.slug || "local-preview",
    displayName: options.displayName || "",
    viewerTitle: options.displayName ? `${options.displayName}'s Running Footprints` : "Running Footprints",
    siteUrl: null,
    totalRunSummaries: stats.activities,
    parsedRunActivities: stats.parsedActivities,
    uploadedFitFiles: stats.fitFiles,
    candidateGpsFiles: stats.candidateGpsFiles,
    skippedNonRunGps: stats.skippedNonRun,
    skippedNoGps: stats.skippedNoGps,
    skippedNoTimestamp: stats.skippedNoTimestamp,
    skippedDuplicateMatches: stats.skippedDuplicate,
    skippedBeforeStartDate: stats.skippedBeforeStart,
    skippedMalformedFit: stats.skippedMalformedFit,
    pointCount: points.length / 3,
    originalPointCount,
    runProgress: stats.activityStartTimes.map((timestamp) => (timestamp - minT) / timeExtent).sort((a, b) => a - b),
    maxPoints,
    sampled,
    requestedStartDate: options.startDate || DEFAULT_START_DATE,
    start: isoFromUnixSeconds(minT),
    end: isoFromUnixSeconds(maxT),
    bounds: {
      minMercatorX: minX,
      maxMercatorX: maxX,
      minMercatorY: minY,
      maxMercatorY: maxY,
    },
    initialView: {
      ...initialView,
      minMercatorX: renderMinX,
      maxMercatorX: renderMaxX,
      minMercatorY: renderMinY,
      maxMercatorY: renderMaxY,
    },
    privacy: {
      method: "deterministic hash-based per-activity start/end point trim",
      trimFractionRange: [0.035, 0.075],
    },
    localOnly: true,
  };
  return { meta, points };
}

async function parseNestedActivityZip(entry, options, context) {
  const nestedBytes = await boundedEntryRead(entry, MAX_ZIP_MEMBER_BYTES, "Nested Garmin activity ZIP is too large.");
  const maxFitFileBytes = options.limits?.maxFitFileBytes ?? MAX_FIT_FILE_BYTES;
  const { zipReader, entries } = await readZipEntries(new Uint8ArrayReader(nestedBytes), {
    maxMemberBytes: maxFitFileBytes,
  });
  try {
    const fitEntries = entries.filter((fitEntry) => {
      const name = validateZipEntry(fitEntry);
      if (isDirectory(fitEntry)) return false;
      if (name.toLowerCase().endsWith(".zip")) {
        throw new InvalidZipError("Nested ZIPs beyond Garmin activity ZIPs are not allowed.");
      }
      if (!name.toLowerCase().endsWith(".fit")) return false;
      if (entryUncompressedSize(fitEntry) > maxFitFileBytes) throw zipTooLarge("FIT file is too large.");
      return true;
    });
    context.fitFiles += fitEntries.length;
    if (context.fitFiles > MAX_FIT_FILES) {
      throw new InvalidZipError("Garmin export contains too many FIT files.");
    }
    return { zipReader, fitEntries };
  } catch (error) {
    await zipReader.close().catch(() => {});
    throw error;
  }
}

export async function buildVisualizationFromGarminFile(file, options = {}) {
  const signal = options.signal;
  abortIfNeeded(signal);
  report(options, "validating", { message: "Validating Garmin ZIP..." });
  const reader = file instanceof Uint8Array ? new Uint8ArrayReader(file) : new BlobReader(file);
  const { zipReader, entries } = await readZipEntries(reader, options.limits || {});
  try {
    report(options, "summaries", { message: "Reading Garmin activity summaries..." });
    const activities = await parseActivities(entries, options);
    if (!activities.length) throw new NoRunsFoundError("No running GPS activities were found in the Garmin export.");
    const activityMatcher = buildActivityMatcher(activities);
    const startTimestamp = parseStartDate(options.startDate || DEFAULT_START_DATE);
    const activityZipEntries = entries.filter((entry) =>
      /DI_CONNECT\/DI-Connect-Uploaded-Files\/.*\.zip$/u.test(validateZipEntry(entry))
    );
    if (!activityZipEntries.length) {
      throw new NoRunsFoundError(
        "Garmin export found, but activity files were missing.",
        "GARMIN_ACTIVITY_FILES_MISSING"
      );
    }
    if (activityZipEntries.length > MAX_NESTED_ACTIVITY_ZIPS) {
      throw new InvalidZipError("Garmin export contains too many nested activity ZIPs.");
    }

    const stats = {
      activities: activities.length,
      parsedActivities: 0,
      fitFiles: 0,
      candidateGpsFiles: 0,
      skippedNonRun: 0,
      skippedNoGps: 0,
      skippedNoTimestamp: 0,
      skippedDuplicate: 0,
      skippedBeforeStart: 0,
      skippedMalformedFit: 0,
      activityStartTimes: [],
    };
    const projected = [];
    const seenActivityIds = new Set();
    let scanned = 0;

    for (const activityZipEntry of activityZipEntries) {
      report(options, "activity-zips", {
        message: "Scanning Garmin activity ZIPs...",
        scanned,
        total: activityZipEntries.length,
      });
      const nested = await parseNestedActivityZip(activityZipEntry, options, stats);
      try {
        for (const fitEntry of nested.fitEntries) {
          scanned += 1;
          if (scanned % 25 === 0) {
            report(options, "fit", {
              message: "Parsing FIT GPS tracks...",
              scanned,
              total: stats.fitFiles,
              points: projected.length,
            });
            await yieldToBrowser(signal);
          }
          let points;
          try {
            points = parseFitRecords(
              await boundedEntryRead(
                fitEntry,
                options.limits?.maxFitFileBytes ?? MAX_FIT_FILE_BYTES,
                "FIT file is too large."
              )
            );
          } catch (error) {
            if (!(error instanceof ParserFailureError)) throw error;
            stats.skippedMalformedFit += 1;
            continue;
          }
          if (points.length < 30) {
            stats.skippedNoGps += 1;
            continue;
          }
          stats.candidateGpsFiles += 1;
          const timestamps = points.map((row) => row[0]).filter((timestamp) => timestamp != null);
          if (!timestamps.length) {
            stats.skippedNoTimestamp += 1;
            continue;
          }
          const fitStart = minNumber(timestamps) + GARMIN_EPOCH;
          if (fitStart < startTimestamp) {
            stats.skippedBeforeStart += 1;
            continue;
          }
          const activity = activityMatcher(fitStart, 8 * 3600);
          if (!activity) {
            stats.skippedNonRun += 1;
            continue;
          }
          if (seenActivityIds.has(activity.activityId)) {
            stats.skippedDuplicate += 1;
            continue;
          }
          seenActivityIds.add(activity.activityId);
          points = trimActivityPoints(activity.activityId, points);
          if (points.length < 10) {
            stats.skippedNoGps += 1;
            continue;
          }
          stats.parsedActivities += 1;
          for (const [timestamp, lat, lon] of points) {
            const [x, y] = mercator(lon, lat);
            const unixSeconds = timestamp != null ? timestamp + GARMIN_EPOCH : Math.trunc(activity.startMs / 1000);
            projected.push([x, y, unixSeconds]);
          }
          if (projected.length > MAX_PARSED_POINTS_BEFORE_DOWNSAMPLING) {
            throw new ParserFailureError("Too many parsed GPS points before downsampling.");
          }
          stats.activityStartTimes.push(
            points[0][0] != null ? points[0][0] + GARMIN_EPOCH : Math.trunc(activity.startMs / 1000)
          );
        }
      } finally {
        await nested.zipReader.close().catch(() => {});
      }
    }
    if (!projected.length) {
      throw new NoRunsFoundError("No running GPS data was found in the Garmin export.");
    }
    report(options, "generating", { message: "Generating local map data...", points: projected.length });
    return generateAssets(projected, stats, options);
  } catch (error) {
    if (error instanceof ProcessorError || error?.name === "AbortError") throw error;
    throw new ParserFailureError(error instanceof Error ? error.message : String(error));
  } finally {
    await zipReader.close().catch(() => {});
  }
}

export function messageForProcessorError(error) {
  if (error?.name === "AbortError") return "Processing was canceled.";
  if (error instanceof ProcessorError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
