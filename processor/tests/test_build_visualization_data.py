from __future__ import annotations

import json
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from processor import build_visualization_data
from processor.build_visualization_data import ExitCode, build_visualization_site
from processor.tests.fixtures import create_sample_garmin_export

ROOT = Path(__file__).resolve().parents[2]


class BuildVisualizationDataTest(unittest.TestCase):
    def run_processor(self, export_zip: Path, output_dir: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(ROOT / "processor/build_visualization_data.py"),
                str(export_zip),
                str(output_dir),
                "--slug",
                "runner",
                "--template-dir",
                str(ROOT / "template"),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_valid_garmin_export_generates_consistent_site_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            export_zip = temp_path / "garmin.zip"
            output_dir = temp_path / "site"
            create_sample_garmin_export(export_zip)

            meta = build_visualization_site(
                export_zip,
                output_dir,
                temp_path / "raw",
                ROOT / "template",
                slug="runner",
                display_name="Test Runner",
                site_url="https://runner.runs.example.com",
                start_date="2022-05-01",
                max_points=10_000,
            )

            self.assertEqual(meta["slug"], "runner")
            self.assertEqual(meta["displayName"], "Test Runner")
            self.assertGreater(meta["pointCount"], 0)
            self.assertEqual((output_dir / "points.bin").stat().st_size, meta["pointCount"] * struct.calcsize("<fff"))
            self.assertEqual(json.loads((output_dir / "meta.json").read_text())["pointCount"], meta["pointCount"])
            for name in ("index.html", "app.js", "styles.css"):
                self.assertTrue((output_dir / name).is_file())

    def test_invalid_zip_returns_documented_exit_code(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            invalid = temp_path / "bad.zip"
            invalid.write_text("not a zip", encoding="utf-8")
            result = self.run_processor(invalid, temp_path / "out")
            self.assertEqual(result.returncode, ExitCode.INVALID_ZIP)
            self.assertIn("INVALID_ZIP", result.stderr)

    def test_no_running_gps_returns_documented_exit_code(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            export_zip = temp_path / "garmin.zip"
            create_sample_garmin_export(export_zip, activity_type="cycling")
            result = self.run_processor(export_zip, temp_path / "out")
            self.assertEqual(result.returncode, ExitCode.NO_RUNS_FOUND)
            self.assertIn("NO_RUNS_FOUND", result.stderr)

    def test_suspicious_zip_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            export_zip = temp_path / "garmin.zip"
            with zipfile.ZipFile(export_zip, "w") as archive:
                archive.writestr("../escape.txt", "bad")
            result = self.run_processor(export_zip, temp_path / "out")
            self.assertEqual(result.returncode, ExitCode.INVALID_ZIP)

    def test_non_garmin_zip_gets_specific_error(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            export_zip = temp_path / "not-garmin.zip"
            with zipfile.ZipFile(export_zip, "w") as archive:
                archive.writestr("strava/activities.csv", "nope")

            result = self.run_processor(export_zip, temp_path / "out")
            self.assertEqual(result.returncode, ExitCode.NO_RUNS_FOUND)
            self.assertIn("GARMIN_EXPORT_NOT_FOUND", result.stderr)

    def test_garmin_export_without_activity_zips_gets_specific_error(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            export_zip = temp_path / "garmin.zip"
            summary: list[dict[str, list[dict[str, object]]]] = [{"summarizedActivitiesExport": []}]
            with zipfile.ZipFile(export_zip, "w") as archive:
                archive.writestr("DI_CONNECT/DI-Connect-Fitness/test_summarizedActivities.json", json.dumps(summary))

            result = self.run_processor(export_zip, temp_path / "out")
            self.assertEqual(result.returncode, ExitCode.NO_RUNS_FOUND)
            self.assertIn("GARMIN_ACTIVITY_FILES_MISSING", result.stderr)

    def test_rejects_backslashes_absolute_hidden_duplicate_and_windows_device_paths(self):
        bad_members = [
            "/absolute.txt",
            "DI_CONNECT\\bad.txt",
            "__MACOSX/._hidden",
            "DI_CONNECT/.hidden/file.txt",
            "DI_CONNECT/CON.txt",
        ]
        for member in bad_members:
            with self.subTest(member=member), tempfile.TemporaryDirectory() as temp:
                temp_path = Path(temp)
                export_zip = temp_path / "bad.zip"
                with zipfile.ZipFile(export_zip, "w") as archive:
                    archive.writestr(member, "bad")
                result = self.run_processor(export_zip, temp_path / "out")
                self.assertEqual(result.returncode, ExitCode.INVALID_ZIP)

        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            export_zip = temp_path / "duplicate.zip"
            with zipfile.ZipFile(export_zip, "w") as archive:
                archive.writestr("DI_CONNECT/file.txt", "one")
                archive.writestr("DI_CONNECT/file.txt", "two")
            result = self.run_processor(export_zip, temp_path / "out")
            self.assertEqual(result.returncode, ExitCode.INVALID_ZIP)

    def test_rejects_symlink_entries(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            export_zip = temp_path / "symlink.zip"
            info = zipfile.ZipInfo("DI_CONNECT/link")
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(export_zip, "w") as archive:
                archive.writestr(info, "/etc/passwd")
            result = self.run_processor(export_zip, temp_path / "out")
            self.assertEqual(result.returncode, ExitCode.INVALID_ZIP)

    def test_rejects_unusual_compression_ratio(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            export_zip = temp_path / "bomb.zip"
            with zipfile.ZipFile(export_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("DI_CONNECT/repeated.txt", "A" * 100_000)
            result = self.run_processor(export_zip, temp_path / "out")
            self.assertEqual(result.returncode, ExitCode.INVALID_ZIP)
            self.assertIn("ZIP_UNUSUAL_COMPRESSION", result.stderr)

    def test_rejects_summary_json_over_configured_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            export_zip = temp_path / "garmin.zip"
            with zipfile.ZipFile(export_zip, "w") as archive:
                archive.writestr("DI_CONNECT/DI-Connect-Fitness/test_summarizedActivities.json", "[]")

            with (
                mock.patch.object(build_visualization_data, "MAX_SUMMARY_JSON_BYTES", 1),
                self.assertRaises(build_visualization_data.ZipTooLargeError),
            ):
                build_visualization_site(
                    export_zip,
                    temp_path / "site",
                    temp_path / "raw",
                    ROOT / "template",
                    slug="runner",
                    display_name="",
                    site_url=None,
                    start_date="2022-05-01",
                    max_points=10_000,
                )

    def test_rejects_nested_zip_beyond_activity_layer(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            nested = temp_path / "activities.zip"
            with zipfile.ZipFile(nested, "w") as archive:
                archive.writestr("deeper.zip", b"PK\x05\x06" + b"\0" * 18)
            export_zip = temp_path / "garmin.zip"
            summary = [
                {
                    "summarizedActivitiesExport": [
                        {
                            "activityId": 12345,
                            "activityType": "running",
                            "name": "Morning Run",
                            "beginTimestamp": 1710000000 * 1000,
                            "distance": 100000,
                        }
                    ]
                }
            ]
            with zipfile.ZipFile(export_zip, "w") as archive:
                archive.writestr("DI_CONNECT/DI-Connect-Fitness/test_summarizedActivities.json", json.dumps(summary))
                archive.write(nested, "DI_CONNECT/DI-Connect-Uploaded-Files/activities.zip")

            result = self.run_processor(export_zip, temp_path / "out")
            self.assertEqual(result.returncode, ExitCode.INVALID_ZIP)

    def test_rejects_malformed_fit_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            nested = temp_path / "activities.zip"
            malformed_fit = bytes([14, 16, 0, 0, 8, 0, 0, 0]) + b".FIT" + b"\0\0" + b"\x40\x00\x00\x14\x00\xff"
            with zipfile.ZipFile(nested, "w") as archive:
                archive.writestr("activity.fit", malformed_fit)
            export_zip = temp_path / "garmin.zip"
            summary = [
                {
                    "summarizedActivitiesExport": [
                        {
                            "activityId": 12345,
                            "activityType": "running",
                            "name": "Morning Run",
                            "beginTimestamp": 1710000000 * 1000,
                            "distance": 100000,
                        }
                    ]
                }
            ]
            with zipfile.ZipFile(export_zip, "w") as archive:
                archive.writestr("DI_CONNECT/DI-Connect-Fitness/test_summarizedActivities.json", json.dumps(summary))
                archive.write(nested, "DI_CONNECT/DI-Connect-Uploaded-Files/activities.zip")

            result = self.run_processor(export_zip, temp_path / "out")
            self.assertEqual(result.returncode, ExitCode.PARSER_FAILURE)
            self.assertIn("PARSER_FAILURE", result.stderr)

    def test_accepts_full_fit_uint8_field_count_range(self):
        field_count = 129
        data = bytearray()
        data.extend(b"\x40")
        data.extend(b"\x00")
        data.extend(b"\x00")
        data.extend(struct.pack("<H", 20))
        data.extend(bytes([field_count]))
        data.extend(b"\0" * field_count * 3)
        header = bytearray(14)
        header[0] = 14
        header[1] = 16
        struct.pack_into("<H", header, 2, 100)
        struct.pack_into("<I", header, 4, len(data))
        header[8:12] = b".FIT"

        self.assertEqual(build_visualization_data.parse_fit_records(bytes(header + data + b"\0\0")), [])


if __name__ == "__main__":
    unittest.main()
