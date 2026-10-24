#!/usr/bin/env python3
"""Offline parser for TikTok HTML saved from the user's visible Edge session.

The former ``--url`` route fetched webpage HTML directly and is now prohibited.
Only local HTML that the operator lawfully saved from the already-open, visible
Microsoft Edge session may be parsed; this never proves platform completion.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
from pathlib import Path


PROHIBITED_LIVE_FETCH_MESSAGE = (
    "prohibited_legacy: --url direct HTTP webpage fetching is disabled. "
    "Save the page from the user's existing visible Microsoft Edge session, then "
    "run the offline --html route with --source-edge-export. This restriction "
    "applies to three_hour_targeted_v1 and exhaustive_audit."
)


def fetch(url: str, timeout: int) -> str:
    """Reject the retired live-fetch route before any network operation."""
    del url, timeout
    raise RuntimeError(PROHIBITED_LIVE_FETCH_MESSAGE)


def read_html(args: argparse.Namespace) -> str:
    if args.html:
        return args.html.read_text(encoding="utf-8", errors="replace")
    raise RuntimeError("Offline parser requires --html.")


def extract(html_text: str) -> dict[str, object]:
    match = re.search(
        r"<script[^>]+id=[\"']__UNIVERSAL_DATA_FOR_REHYDRATION__[\"'][^>]*>(.*?)</script>",
        html_text,
        re.S,
    )
    if not match:
        return {
            "status": "missing_hydration_block",
            "error": "TikTok hydration script was not present in the supplied HTML.",
            "diagnostic_only": True,
            "negative_conclusion_eligible": False,
        }
    raw = html.unescape(match.group(1))
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return {
            "status": "invalid_hydration_json",
            "error": f"JSONDecodeError at line {exc.lineno} column {exc.colno}: {exc.msg}",
            "diagnostic_only": True,
            "negative_conclusion_eligible": False,
        }
    if not isinstance(data, dict):
        return {
            "status": "invalid_hydration_payload",
            "error": "Hydration JSON root must be an object.",
            "diagnostic_only": True,
            "negative_conclusion_eligible": False,
        }
    detail = data.get("__DEFAULT_SCOPE__", {}).get("webapp.user-detail", {})
    user_info = detail.get("userInfo", {}) if isinstance(detail, dict) else {}
    user = user_info.get("user", {}) if isinstance(user_info, dict) else {}
    stats = user_info.get("stats", {}) if isinstance(user_info, dict) else {}
    stats_v2 = user_info.get("statsV2", {}) if isinstance(user_info, dict) else {}
    item_list = user_info.get("itemList", []) if isinstance(user_info, dict) else []
    bio_link = user.get("bioLink") if isinstance(user.get("bioLink"), dict) else {}
    status_code = detail.get("statusCode", "") if isinstance(detail, dict) else ""
    if status_code not in {"", None, 0, "0"}:
        return {
            "status": "platform_status_error",
            "status_code": status_code,
            "status_message": detail.get("statusMsg", "") if isinstance(detail, dict) else "",
            "error": "TikTok hydration payload reported a non-success status code.",
            "diagnostic_only": True,
            "negative_conclusion_eligible": False,
        }
    if not isinstance(user, dict) or not str(user.get("uniqueId", "")).strip():
        return {
            "status": "missing_profile_data",
            "status_code": detail.get("statusCode", "") if isinstance(detail, dict) else "",
            "status_message": detail.get("statusMsg", "") if isinstance(detail, dict) else "",
            "error": "Hydration JSON did not contain a usable webapp.user-detail.userInfo.user profile.",
            "diagnostic_only": True,
            "negative_conclusion_eligible": False,
        }
    return {
        "status": "ok",
        "unique_id": user.get("uniqueId", ""),
        "user_id": user.get("id", ""),
        "sec_uid": user.get("secUid", ""),
        "nickname": user.get("nickname", ""),
        "signature": user.get("signature", ""),
        "bio_link": bio_link.get("link", "") if isinstance(bio_link, dict) else "",
        "verified": user.get("verified", ""),
        "private_account": user.get("privateAccount", ""),
        "commerce_category": (user.get("commerceUserInfo") or {}).get("category", "") if isinstance(user.get("commerceUserInfo"), dict) else "",
        "follower_count": stats.get("followerCount", ""),
        "following_count": stats.get("followingCount", ""),
        "heart_count": stats.get("heartCount", stats.get("heart", "")),
        "video_count": stats.get("videoCount", ""),
        "stats_v2": stats_v2,
        "item_list_count": len(item_list) if isinstance(item_list, list) else "",
        "status_code": status_code,
        "status_message": detail.get("statusMsg", "") if isinstance(detail, dict) else "",
        "boundary": "Hydration profile metadata only; itemList may be empty and comments are not covered.",
        "error": "",
        "diagnostic_only": True,
        "negative_conclusion_eligible": False,
    }


def result_exit_code(result: dict[str, object]) -> int:
    return 0 if result.get("status") == "ok" else 2


def run_self_test() -> int:
    failures: list[str] = []
    missing = extract("<html><title>no hydration</title></html>")
    invalid = extract('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{bad</script>')
    payload = {
        "__DEFAULT_SCOPE__": {
            "webapp.user-detail": {
                "statusCode": 0,
                "userInfo": {
                    "user": {"uniqueId": "fixture", "id": "1", "nickname": "Fixture"},
                    "stats": {"videoCount": 3},
                    "itemList": [],
                },
            }
        }
    }
    valid = extract(
        '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">'
        + json.dumps(payload, ensure_ascii=False)
        + "</script>"
    )
    error_payload = json.loads(json.dumps(payload))
    error_payload["__DEFAULT_SCOPE__"]["webapp.user-detail"]["statusCode"] = 10221
    platform_error = extract(
        '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">'
        + json.dumps(error_payload, ensure_ascii=False)
        + "</script>"
    )
    if missing.get("status") != "missing_hydration_block" or result_exit_code(missing) == 0:
        failures.append("missing-hydration-must-fail")
    if invalid.get("status") != "invalid_hydration_json" or result_exit_code(invalid) == 0:
        failures.append("invalid-json-must-fail")
    if platform_error.get("status") != "platform_status_error" or result_exit_code(platform_error) == 0:
        failures.append("platform-status-must-fail")
    if valid.get("status") != "ok" or valid.get("unique_id") != "fixture" or result_exit_code(valid) != 0:
        failures.append("valid-hydration")
    if valid.get("diagnostic_only") is not True or valid.get("negative_conclusion_eligible") is not False:
        failures.append("diagnostic-boundary")
    try:
        fetch("https://www.tiktok.com/@fixture", 1)
        failures.append("live-fetch-must-be-prohibited")
    except RuntimeError as exc:
        if "prohibited_legacy" not in str(exc):
            failures.append("live-fetch-error-message")
    print(json.dumps({"self_test": "failed" if failures else "passed", "failures": failures}, ensure_ascii=False))
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Offline-only TikTok metadata parser for HTML saved from the user's visible Edge session."
    )
    parser.add_argument("--html", type=Path, help="Local HTML saved from the user's existing visible Edge session.")
    parser.add_argument("--url", help="PROHIBITED legacy live-fetch argument; retained only for a clear policy error.")
    parser.add_argument(
        "--source-edge-export",
        action="store_true",
        help="Acknowledge that --html was lawfully saved from the user's existing visible Edge session.",
    )
    parser.add_argument("--out-json", type=Path)
    parser.add_argument("--out-csv", type=Path)
    parser.add_argument("--timeout", type=int, default=25)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return run_self_test()
    if args.url:
        print(json.dumps({
            "status": "prohibited_legacy",
            "execution_allowed": False,
            "network_attempted": False,
            "message": PROHIBITED_LIVE_FETCH_MESSAGE,
            "exit_code": 2,
        }, ensure_ascii=False), file=sys.stderr)
        return 2
    if args.out_json is None:
        parser.error("--out-json is required")
    if args.html is None:
        parser.error("--html is required; --url live fetching is prohibited")
    if not args.source_edge_export:
        print(json.dumps({
            "status": "source_attestation_required",
            "execution_allowed": False,
            "network_attempted": False,
            "message": "Offline parsing requires --source-edge-export to attest that --html came from the user's existing visible Edge session.",
            "exit_code": 2,
        }, ensure_ascii=False), file=sys.stderr)
        return 2
    try:
        result = extract(read_html(args))
    except Exception as exc:
        result = {
            "status": "input_or_fetch_error",
            "error": f"{type(exc).__name__}: {exc}",
            "diagnostic_only": True,
            "negative_conclusion_eligible": False,
        }
    exit_code = result_exit_code(result)
    result["source_mode"] = "edge_saved_html_offline"
    result["source_policy_acknowledged"] = True
    result["exit_code"] = exit_code
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.out_csv:
        args.out_csv.parent.mkdir(parents=True, exist_ok=True)
        fields = [k for k, v in result.items() if not isinstance(v, (dict, list))]
        with args.out_csv.open("w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            writer.writerow(result)
    print(json.dumps({
        "out_json": str(args.out_json),
        "status": result.get("status"),
        "error": result.get("error", ""),
        "diagnostic_only": True,
        "negative_conclusion_eligible": False,
        "exit_code": exit_code,
    }, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
