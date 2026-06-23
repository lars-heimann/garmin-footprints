from __future__ import annotations

import json
import math
import struct
import sys
import zipfile
from pathlib import Path

GARMIN_EPOCH = 631065600


def semicircles(degrees: float) -> int:
    return int(degrees * (2**31) / 180.0)


def make_fit(points: int = 80, start_timestamp: int = 1710000000 - GARMIN_EPOCH) -> bytes:
    data = bytearray()
    data.extend(b"\x40")
    data.extend(b"\x00")
    data.extend(b"\x00")
    data.extend(struct.pack("<H", 20))
    data.extend(b"\x03")
    data.extend(bytes([253, 4, 0x86]))
    data.extend(bytes([0, 4, 0x85]))
    data.extend(bytes([1, 4, 0x85]))

    for index in range(points):
        data.extend(b"\x00")
        timestamp = start_timestamp + index * 10
        lat = 52.50 + math.sin(index / 10) * 0.01
        lon = 13.40 + index * 0.0002
        data.extend(struct.pack("<Iii", timestamp, semicircles(lat), semicircles(lon)))

    header = bytearray(14)
    header[0] = 14
    header[1] = 16
    struct.pack_into("<H", header, 2, 100)
    struct.pack_into("<I", header, 4, len(data))
    header[8:12] = b".FIT"
    return bytes(header + data + b"\x00\x00")


def create_sample_garmin_export(path: Path, *, activity_type: str = "running", include_fit: bool = True) -> None:
    start_unix = 1710000000
    nested = path.with_suffix(".activities.zip")
    with zipfile.ZipFile(nested, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        if include_fit:
            archive.writestr("activity.fit", make_fit())

    summary = [
        {
            "summarizedActivitiesExport": [
                {
                    "activityId": 12345,
                    "activityType": activity_type,
                    "name": "Morning Run",
                    "beginTimestamp": start_unix * 1000,
                    "distance": 100000,
                }
            ]
        }
    ]
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("DI_CONNECT/DI-Connect-Fitness/test_summarizedActivities.json", json.dumps(summary))
        archive.write(nested, "DI_CONNECT/DI-Connect-Uploaded-Files/activities.zip")
    nested.unlink()


if __name__ == "__main__":
    create_sample_garmin_export(Path(sys.argv[1]))
