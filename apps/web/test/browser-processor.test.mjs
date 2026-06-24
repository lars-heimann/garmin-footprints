import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildVisualizationFromGarminFile, parseFitRecords } from "../browser-processing/processor-core.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function tempDir() {
  return mkdtemp(join(tmpdir(), "runmaps-browser-processor-"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf-8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function runPython(code, args = []) {
  run("python3", ["-c", code, ...args]);
}

async function createSampleExport(exportZip) {
  run("python3", ["processor/tests/fixtures.py", exportZip]);
}

async function buildWithJs(exportZip, options = {}) {
  return buildVisualizationFromGarminFile(await readFile(exportZip), {
    displayName: "Test Runner",
    slug: "local-preview",
    startDate: "2022-05-01",
    maxPoints: 10_000,
    ...options,
  });
}

async function assertProcessorCode(exportZip, expectedCode, options = {}) {
  await assert.rejects(
    () => buildWithJs(exportZip, options),
    (error) => {
      assert.ok(error && typeof error === "object" && "code" in error);
      assert.equal(error.code, expectedCode);
      return true;
    }
  );
}

test("browser processor generates viewer-compatible data matching the Python fixture path", async () => {
  const dir = await tempDir();
  const exportZip = join(dir, "garmin.zip");
  const pythonOut = join(dir, "python-site");
  await createSampleExport(exportZip);
  await mkdir(pythonOut);

  run("python3", [
    "processor/build_visualization_data.py",
    exportZip,
    pythonOut,
    "--slug",
    "local-preview",
    "--display-name",
    "Test Runner",
    "--template-dir",
    "template",
    "--max-points",
    "10000",
    "--start-date",
    "2022-05-01",
  ]);

  const jsResult = await buildWithJs(exportZip);
  const pythonMeta = JSON.parse(await readFile(join(pythonOut, "meta.json"), "utf-8"));
  const pythonPointsBytes = await readFile(join(pythonOut, "points.bin"));
  const pythonPoints = new Float32Array(
    pythonPointsBytes.buffer.slice(
      pythonPointsBytes.byteOffset,
      pythonPointsBytes.byteOffset + pythonPointsBytes.byteLength
    )
  );

  assert.equal(jsResult.meta.slug, "local-preview");
  assert.equal(jsResult.meta.displayName, "Test Runner");
  assert.equal(jsResult.meta.localOnly, true);
  assert.equal(jsResult.meta.pointCount, pythonMeta.pointCount);
  assert.equal(jsResult.meta.parsedRunActivities, pythonMeta.parsedRunActivities);
  assert.equal(jsResult.meta.runProgress.length, jsResult.meta.parsedRunActivities);
  assert.equal(jsResult.meta.candidateGpsFiles, pythonMeta.candidateGpsFiles);
  assert.equal(jsResult.points.byteLength, jsResult.meta.pointCount * 12);
  assert.equal(jsResult.points.length, pythonPoints.length);
  assert.ok(Math.abs(jsResult.points[0] - pythonPoints[0]) < 0.0001);
  assert.ok(Math.abs(jsResult.points[1] - pythonPoints[1]) < 0.0001);
  assert.ok(Math.abs(jsResult.points.at(-1) - pythonPoints.at(-1)) < 0.0001);
});

test("browser processor reports specific errors for non-Garmin and no-run exports", async () => {
  const dir = await tempDir();
  const stravaZip = join(dir, "strava.zip");
  const cyclingZip = join(dir, "cycling.zip");
  runPython(
    `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("strava/activities.csv", "not garmin")
`,
    [stravaZip]
  );
  run("python3", [
    "-c",
    "from pathlib import Path; from processor.tests.fixtures import create_sample_garmin_export; create_sample_garmin_export(Path(__import__('sys').argv[1]), activity_type='cycling')",
    cyclingZip,
  ]);

  await assertProcessorCode(stravaZip, "GARMIN_EXPORT_NOT_FOUND");
  await assertProcessorCode(cyclingZip, "NO_RUNS_FOUND");
});

test("browser processor rejects suspicious root ZIP paths", async () => {
  const badMembers = [
    "/absolute.txt",
    "../escape.txt",
    "DI_CONNECT\\\\bad.txt",
    "__MACOSX/._hidden",
    "DI_CONNECT/.hidden/file.txt",
    "DI_CONNECT/CON.txt",
  ];

  for (const member of badMembers) {
    const dir = await tempDir();
    const exportZip = join(dir, "bad.zip");
    runPython(
      `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr(sys.argv[2], "bad")
`,
      [exportZip, member]
    );
    await assertProcessorCode(exportZip, "INVALID_ZIP");
  }
});

test("browser processor rejects duplicate names, symlinks, high compression, and too many entries", async () => {
  const duplicateDir = await tempDir();
  const duplicateZip = join(duplicateDir, "duplicate.zip");
  runPython(
    `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("DI_CONNECT/file.txt", "one")
    archive.writestr("DI_CONNECT/file.txt", "two")
`,
    [duplicateZip]
  );
  await assertProcessorCode(duplicateZip, "INVALID_ZIP");

  const symlinkDir = await tempDir();
  const symlinkZip = join(symlinkDir, "symlink.zip");
  runPython(
    `
import stat, sys, zipfile
info = zipfile.ZipInfo("DI_CONNECT/link")
info.external_attr = (stat.S_IFLNK | 0o777) << 16
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr(info, "/etc/passwd")
`,
    [symlinkZip]
  );
  await assertProcessorCode(symlinkZip, "INVALID_ZIP");

  const compressionDir = await tempDir();
  const compressionZip = join(compressionDir, "bomb.zip");
  runPython(
    `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("DI_CONNECT/repeated.txt", "A" * 100000)
`,
    [compressionZip]
  );
  await assertProcessorCode(compressionZip, "ZIP_UNUSUAL_COMPRESSION");

  const manyDir = await tempDir();
  const manyZip = join(manyDir, "many.zip");
  runPython(
    `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("DI_CONNECT/one.txt", "1")
    archive.writestr("DI_CONNECT/two.txt", "2")
    archive.writestr("DI_CONNECT/three.txt", "3")
`,
    [manyZip]
  );
  await assertProcessorCode(manyZip, "INVALID_ZIP", { limits: { maxMembers: 2 } });
});

test("browser processor rejects huge summary JSON and nested ZIPs beyond the activity layer", async () => {
  const summaryDir = await tempDir();
  const summaryZip = join(summaryDir, "summary.zip");
  runPython(
    `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("DI_CONNECT/DI-Connect-Fitness/test_summarizedActivities.json", "[]")
`,
    [summaryZip]
  );
  await assertProcessorCode(summaryZip, "ZIP_TOO_LARGE", { limits: { maxSummaryJsonBytes: 1 } });

  const nestedDir = await tempDir();
  const nestedZip = join(nestedDir, "nested.zip");
  runPython(
    `
import json, sys, zipfile
from pathlib import Path
base = Path(sys.argv[1]).parent
activities = base / "activities.zip"
with zipfile.ZipFile(activities, "w") as archive:
    archive.writestr("deeper.zip", b"PK\\x05\\x06" + b"\\0" * 18)
summary = [{"summarizedActivitiesExport": [{"activityId": 12345, "activityType": "running", "name": "Morning Run", "beginTimestamp": 1710000000 * 1000, "distance": 100000}]}]
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("DI_CONNECT/DI-Connect-Fitness/test_summarizedActivities.json", json.dumps(summary))
    archive.write(activities, "DI_CONNECT/DI-Connect-Uploaded-Files/activities.zip")
`,
    [nestedZip]
  );
  await assertProcessorCode(nestedZip, "INVALID_ZIP");
});

test("FIT parser fails closed on malformed records and honors cancellation before work starts", async () => {
  const malformedFit = Uint8Array.from([14, 16, 0, 0, 8, 0, 0, 0, 46, 70, 73, 84, 0, 0, 64, 0, 0, 20, 0, 255]);
  assert.throws(() => parseFitRecords(malformedFit), /too many fields|truncated|malformed|invalid/i);

  const dir = await tempDir();
  const exportZip = join(dir, "garmin.zip");
  await createSampleExport(exportZip);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => buildWithJs(exportZip, { signal: controller.signal }), /canceled|aborted/i);
});

test("browser processor skips malformed FIT files and keeps valid running tracks", async () => {
  const dir = await tempDir();
  const exportZip = join(dir, "mixed.zip");
  runPython(
    `
import json, sys, zipfile
from pathlib import Path
from processor.tests.fixtures import make_fit
base = Path(sys.argv[1]).parent
activities = base / "activities.zip"
malformed_fit = bytes([14, 16, 0, 0, 8, 0, 0, 0]) + b".FIT" + b"\\0\\0" + b"\\x40\\x00\\x00\\x14\\x00\\xff"
with zipfile.ZipFile(activities, "w") as archive:
    archive.writestr("device-settings.fit", malformed_fit)
    archive.writestr("activity.fit", make_fit())
summary = [{"summarizedActivitiesExport": [{"activityId": 12345, "activityType": "running", "name": "Morning Run", "beginTimestamp": 1710000000 * 1000, "distance": 100000}]}]
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("DI_CONNECT/DI-Connect-Fitness/test_summarizedActivities.json", json.dumps(summary))
    archive.write(activities, "DI_CONNECT/DI-Connect-Uploaded-Files/activities.zip")
`,
    [exportZip]
  );

  const result = await buildWithJs(exportZip);
  assert.equal(result.meta.parsedRunActivities, 1);
  assert.equal(result.meta.skippedMalformedFit, 1);
  assert.ok(result.meta.pointCount > 0);
});

test("FIT parser accepts the full FIT uint8 field-count range", () => {
  const fieldCount = 129;
  const data = Uint8Array.from([
    0x40,
    0x00,
    0x00,
    0x14,
    0x00,
    fieldCount,
    ...Array.from({ length: fieldCount * 3 }, () => 0),
  ]);
  const header = new Uint8Array(14);
  header[0] = 14;
  header[1] = 16;
  new DataView(header.buffer).setUint16(2, 100, true);
  new DataView(header.buffer).setUint32(4, data.byteLength, true);
  header.set([46, 70, 73, 84], 8);
  const fit = new Uint8Array(header.byteLength + data.byteLength + 2);
  fit.set(header, 0);
  fit.set(data, header.byteLength);
  assert.deepEqual(parseFitRecords(fit), []);
});

test("browser processor handles large point arrays without call stack overflow", async () => {
  const dir = await tempDir();
  const exportZip = join(dir, "large.zip");
  runPython(
    `
import json, sys, zipfile
from pathlib import Path
from processor.tests.fixtures import make_fit
base = Path(sys.argv[1]).parent
activities = base / "activities.zip"
with zipfile.ZipFile(activities, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("large-activity.fit", make_fit(points=150000))
summary = [{"summarizedActivitiesExport": [{"activityId": 12345, "activityType": "running", "name": "Long Run", "beginTimestamp": 1710000000 * 1000, "distance": 100000}]}]
with zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("DI_CONNECT/DI-Connect-Fitness/test_summarizedActivities.json", json.dumps(summary))
    archive.write(activities, "DI_CONNECT/DI-Connect-Uploaded-Files/activities.zip")
`,
    [exportZip]
  );

  const result = await buildWithJs(exportZip, { maxPoints: 200000 });
  assert.equal(result.meta.parsedRunActivities, 1);
  assert.ok(result.meta.pointCount > 100000);
  assert.equal(result.points.byteLength, result.meta.pointCount * 12);
});
