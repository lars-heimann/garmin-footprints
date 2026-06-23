from __future__ import annotations

import json
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from processor.build_visualization_data import ExitCode, build_visualization_site
from processor.tests.fixtures import create_sample_garmin_export

ROOT = Path(__file__).resolve().parents[2]


class BuildVisualizationDataTest(unittest.TestCase):
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
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "processor/build_visualization_data.py"),
                    str(invalid),
                    str(temp_path / "out"),
                    "--slug",
                    "runner",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, ExitCode.INVALID_ZIP)
            self.assertIn("INVALID_ZIP", result.stderr)

    def test_no_running_gps_returns_documented_exit_code(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            export_zip = temp_path / "garmin.zip"
            create_sample_garmin_export(export_zip, activity_type="cycling")
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "processor/build_visualization_data.py"),
                    str(export_zip),
                    str(temp_path / "out"),
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
            self.assertEqual(result.returncode, ExitCode.NO_RUNS_FOUND)
            self.assertIn("NO_RUNS_FOUND", result.stderr)

    def test_suspicious_zip_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            export_zip = temp_path / "garmin.zip"
            with zipfile.ZipFile(export_zip, "w") as archive:
                archive.writestr("../escape.txt", "bad")
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "processor/build_visualization_data.py"),
                    str(export_zip),
                    str(temp_path / "out"),
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
            self.assertEqual(result.returncode, ExitCode.INVALID_ZIP)


if __name__ == "__main__":
    unittest.main()
