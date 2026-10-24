#!/usr/bin/env python3
"""Compatibility shim for the canonical fail-closed risk text scanner.

This retained package path contains no processing logic. It forwards every
argument to the implementation owned by the background-check-research skill
and returns that process's exit code unchanged.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


CANONICAL_TOOL = (
    Path.home()
    / ".codex"
    / "skills"
    / "background-check-research"
    / "scripts"
    / "platform_collectors"
    / "risk_text_scan.py"
)


def main() -> int:
    canonical = CANONICAL_TOOL.resolve()
    if not canonical.is_file():
        print(
            f"Canonical tool not found: {canonical}. "
            "Refusing to run a stale package-local implementation.",
            file=sys.stderr,
        )
        return 2
    if canonical == Path(__file__).resolve():
        print("Canonical tool resolves to this shim; refusing recursion.", file=sys.stderr)
        return 2
    try:
        completed = subprocess.run(
            [sys.executable, str(canonical), *sys.argv[1:]],
            check=False,
        )
    except OSError as exc:
        print(f"Could not launch canonical tool: {exc}", file=sys.stderr)
        return 2
    return int(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
