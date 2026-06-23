#!/usr/bin/env python3
"""Process a queued Garmin Footprints job through the Worker processor API."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

try:
    from processor.build_visualization_data import ProcessorError, build_visualization_site
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from processor.build_visualization_data import ProcessorError, build_visualization_site


ASSET_NAMES = {"index.html", "app.js", "styles.css", "meta.json", "points.bin"}


def processor_request(
    api_base: str,
    token: str,
    method: str,
    path: str,
    *,
    body: bytes | None = None,
    content_type: str = "application/json",
):
    url = api_base.rstrip("/") + path
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        return urllib.request.urlopen(request, timeout=120)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {path} failed with HTTP {error.code}: {detail}") from error


def processor_json(api_base: str, token: str, method: str, path: str, payload: dict | None = None) -> dict:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    with processor_request(api_base, token, method, path, body=body) as response:
        return json.loads(response.read().decode("utf-8"))


def download_upload(api_base: str, token: str, job_id: str, target: Path) -> None:
    with processor_request(api_base, token, "GET", f"/api/processor/jobs/{job_id}/download") as response:
        with target.open("wb") as file:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                file.write(chunk)


def upload_assets(api_base: str, token: str, job_id: str, output_dir: Path) -> None:
    for path in sorted(output_dir.iterdir()):
        if not path.is_file() or path.name not in ASSET_NAMES:
            continue
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        with path.open("rb") as file:
            body = file.read()
        with processor_request(
            api_base,
            token,
            "PUT",
            f"/api/processor/jobs/{job_id}/assets/{path.name}",
            body=body,
            content_type=content_type,
        ):
            pass


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--api-base", default=os.environ.get("WORKER_API_BASE"))
    parser.add_argument("--processor-token", default=os.environ.get("PROCESSOR_TOKEN"))
    parser.add_argument("--template-dir", type=Path, default=Path("template"))
    parser.add_argument("--work-dir", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.api_base or not args.processor_token:
        print("WORKER_API_BASE and PROCESSOR_TOKEN are required.", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="garmin-job-", dir=args.work_dir) as temp_root:
        temp_dir = Path(temp_root)
        input_zip = temp_dir / "garmin-export.zip"
        output_dir = temp_dir / "site"
        raw_dir = temp_dir / "raw"
        status_path = f"/api/processor/jobs/{args.job_id}"

        try:
            job = processor_json(args.api_base, args.processor_token, "GET", status_path)
            processor_json(args.api_base, args.processor_token, "POST", f"{status_path}/start", {})
            download_upload(args.api_base, args.processor_token, args.job_id, input_zip)
            meta = build_visualization_site(
                input_zip,
                output_dir,
                raw_dir,
                args.template_dir,
                slug=job["slug"],
                display_name=job.get("displayName") or "",
                site_url=job.get("siteUrl"),
                start_date=job.get("startDate") or "2022-05-01",
                max_points=int(job.get("maxPoints") or 900_000),
            )
            upload_assets(args.api_base, args.processor_token, args.job_id, output_dir)
            processor_json(
                args.api_base,
                args.processor_token,
                "POST",
                f"{status_path}/complete",
                {"status": "ready", "pointCount": meta["pointCount"]},
            )
            print(json.dumps({"jobId": args.job_id, "status": "ready", "pointCount": meta["pointCount"]}))
            return 0
        except ProcessorError as error:
            processor_json(
                args.api_base,
                args.processor_token,
                "POST",
                f"{status_path}/complete",
                {"status": "failed", "errorCode": error.code, "errorMessage": str(error)},
            )
            print(json.dumps({"jobId": args.job_id, "status": "failed", "errorCode": error.code}), file=sys.stderr)
            return int(error.exit_code)
        except Exception as error:
            try:
                processor_json(
                    args.api_base,
                    args.processor_token,
                    "POST",
                    f"{status_path}/complete",
                    {"status": "failed", "errorCode": "INTERNAL_ERROR", "errorMessage": str(error)},
                )
            except Exception:
                pass
            print(json.dumps({"jobId": args.job_id, "status": "failed", "errorMessage": str(error)}), file=sys.stderr)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
