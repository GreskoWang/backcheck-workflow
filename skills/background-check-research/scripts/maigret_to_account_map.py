#!/usr/bin/env python3
"""Flatten Maigret JSON/NDJSON reports into an account lead CSV."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any, Iterable


USERNAME_KEY_PARTS = (
    "username",
    "screen_name",
    "handle",
    "nickname",
    "email_username",
)


FIELDNAMES = [
    "source_file",
    "input_username",
    "site",
    "profile_url",
    "status",
    "http_status",
    "tags",
    "extracted_usernames",
    "extracted_links",
    "ids_json",
    "lead_note",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert Maigret JSON or NDJSON reports into account leads."
    )
    parser.add_argument(
        "inputs",
        nargs="+",
        help="Maigret JSON/NDJSON report files generated with --json simple or --json ndjson.",
    )
    parser.add_argument("--out", required=True, help="Output CSV path.")
    return parser.parse_args()


def load_json_or_ndjson(path: Path) -> Iterable[tuple[str, dict[str, Any]]]:
    text = path.read_text(encoding="utf-8-sig")
    stripped = text.strip()
    if not stripped:
        return

    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        for line_no, line in enumerate(text.splitlines(), start=1):
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(
                    f"{path}:{line_no}: invalid JSON line: {exc}"
                ) from exc
            if isinstance(item, dict):
                yield "", item
        return

    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                yield "", item
        return

    if not isinstance(data, dict):
        return

    if "status" in data and ("url_user" in data or "sitename" in data or "site" in data):
        yield "", data
        return

    for key, value in data.items():
        if isinstance(value, dict):
            yield str(key), value


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def walk_values(value: Any) -> Iterable[Any]:
    if isinstance(value, dict):
        for nested in value.values():
            yield from walk_values(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from walk_values(nested)
    else:
        yield value


def collect_links(ids: dict[str, Any]) -> list[str]:
    links: list[str] = []
    for value in walk_values(ids):
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            links.append(value)
    return sorted(set(links))


def collect_usernames(ids: dict[str, Any]) -> list[str]:
    usernames: list[str] = []
    for key, value in ids.items():
        key_l = key.lower()
        if any(part in key_l for part in USERNAME_KEY_PARTS):
            for item in as_list(value):
                if isinstance(item, (str, int)):
                    usernames.append(str(item))
    return sorted(set(usernames))


def compact_json(value: Any) -> str:
    if value in (None, "", [], {}):
        return ""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def get_site_name(source_key: str, record: dict[str, Any], status: dict[str, Any]) -> str:
    site = record.get("sitename") or status.get("site_name") or source_key
    if site:
        return str(site)
    site_data = record.get("site")
    if isinstance(site_data, dict):
        for key in ("name", "site_name", "urlMain", "url_main"):
            if site_data.get(key):
                return str(site_data[key])
    return ""


def to_row(source_file: Path, source_key: str, record: dict[str, Any]) -> dict[str, str]:
    status_raw = record.get("status")
    status = status_raw if isinstance(status_raw, dict) else {}
    site_raw = record.get("site")
    site = site_raw if isinstance(site_raw, dict) else {}

    ids_raw = status.get("ids") or record.get("ids_data") or {}
    ids = ids_raw if isinstance(ids_raw, dict) else {}

    tags = status.get("tags") or site.get("tags") or []
    if isinstance(tags, str):
        tags_text = tags
    else:
        tags_text = "; ".join(str(item) for item in as_list(tags) if item)

    extracted_usernames = collect_usernames(ids)
    extracted_links = collect_links(ids)

    notes = ["manual-verification-required"]
    if ids:
        notes.insert(0, "profile-data")
    if extracted_usernames:
        notes.insert(0, "extracted-usernames")
    if extracted_links:
        notes.insert(0, "extracted-links")

    status_text = str(status.get("status") or status_raw or "")

    return {
        "source_file": str(source_file),
        "input_username": str(status.get("username") or record.get("username") or ""),
        "site": get_site_name(source_key, record, status),
        "profile_url": str(status.get("url") or record.get("url_user") or record.get("url") or ""),
        "status": status_text,
        "http_status": str(record.get("http_status") or ""),
        "tags": tags_text,
        "extracted_usernames": "; ".join(extracted_usernames),
        "extracted_links": "; ".join(extracted_links),
        "ids_json": compact_json(ids),
        "lead_note": "; ".join(notes),
    }


def main() -> int:
    args = parse_args()
    rows: list[dict[str, str]] = []

    for input_arg in args.inputs:
        path = Path(input_arg)
        if not path.exists():
            raise SystemExit(f"Input file does not exist: {path}")
        for source_key, record in load_json_or_ndjson(path):
            row = to_row(path, source_key, record)
            if row["profile_url"] or row["site"]:
                rows.append(row)

    rows.sort(key=lambda row: (row["input_username"].lower(), row["site"].lower(), row["profile_url"]))

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} Maigret account leads to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
