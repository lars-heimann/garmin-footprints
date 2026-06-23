#!/usr/bin/env python3
"""Compatibility wrapper for the standalone processor CLI."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from processor.build_visualization_data import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
