#!/usr/bin/env python3
"""Create a fail-closed legacy domestic/overseas network preflight log.

The legacy exhaustive_audit / research package schema 1.10 still uses serial
single-page evidence fields whose names mention Edge. They are retained for
schema compatibility. The formal browser channel defaults to a persistent
desktop Microsoft Edge profile and may accept another confirmed persistent
system desktop browser. Codex/in-app/IAB, temporary hosted, embedded, and
headless browser families are never valid platform-visit or screenshot
evidence. The runner may start Edge and create or select its own task page; the
user does not need to pre-open Edge or provide an endpoint or tab id.

The three_hour_targeted_v1 profile does not call this script; its parallel
browser routes are not restricted by the legacy max_task_open_edge_pages field.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import os
import re
import socket
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import ProxyHandler, Request, build_opener


EVIDENCE_ROOT = Path(os.environ["BACKGROUND_CHECK_WORKSPACE"]).resolve(strict=False)
DEFAULT_DOMESTIC = ["https://www.baidu.com/"]
DEFAULT_OVERSEAS = ["https://www.google.com/", "https://www.youtube.com/"]
BROWSER_EVIDENCE_FIELDS = {
    "schema_version", "url", "browser_family", "window_mode", "captured_at",
    "edge_window_continuity_id", "edge_page_continuity_id",
    "max_task_open_edge_pages", "capture_scope", "preflight_serial_index",
    "started_at", "completed_at",
    "artifact_path", "artifact_sha256", "artifact_kind",
}
EDGE_CHECK_FIELDS = (
    "browser_family", "window_mode", "evidence_path", "evidence_sha256",
    "evidence_kind", "edge_window_continuity_id", "edge_page_continuity_id",
    "max_task_open_edge_pages", "capture_scope", "preflight_serial_index",
    "started_at", "captured_at", "completed_at",
)
UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
CAPTURE_SCOPE = "full_visible_browser_window_with_tab_strip"
LEGACY_EDGE_CAPTURE_SCOPE = "full_visible_edge_window_with_tab_strip"
ALLOWED_CAPTURE_SCOPES = {CAPTURE_SCOPE, LEGACY_EDGE_CAPTURE_SCOPE}
PREFLIGHT_INDEX = {"domestic": 1, "overseas": 2}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _under_evidence_root(path: Path, label: str) -> Path:
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(EVIDENCE_ROOT)
    except ValueError as exc:
        raise ValueError(f"{label} must be under {EVIDENCE_ROOT}") from exc
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise ValueError(f"{label} must be a non-empty file")
    return resolved


def _image_kind(path: Path) -> str | None:
    header = path.read_bytes()[:16]
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if header.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if header.startswith(b"RIFF") and len(header) >= 12 and header[8:12] == b"WEBP":
        return "webp"
    return None


def _zoned_datetime(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{label} must be ISO-8601") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone offset")
    return parsed


def _empty_edge_check_fields() -> dict[str, Any]:
    return {field: None for field in EDGE_CHECK_FIELDS}


def _visible_browser_family(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("browser evidence manifest requires a non-empty browser_family")
    family = value.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", family):
        raise ValueError("browser evidence manifest browser_family must be a normalized identifier")
    compact = re.sub(r"[._-]+", "_", family)
    forbidden_markers = (
        "codex", "openai", "in_app", "inapp", "iab", "hosted", "headless",
        "embedded", "builtin", "built_in", "ephemeral",
    )
    if family in {"browser", "unknown", "other"} or any(
        marker in compact for marker in forbidden_markers
    ):
        raise ValueError(
            "browser evidence manifest browser_family must identify a persistent system "
            "desktop browser; Codex/in-app/IAB, hosted, embedded, and headless families "
            "are forbidden"
        )
    return family


def _browser_manifest(
    path: Path,
    expected_url: str,
    *,
    expected_serial_index: int | None = None,
) -> tuple[Path, dict[str, Any]]:
    manifest_path = _under_evidence_root(path, "browser evidence manifest")
    if manifest_path.suffix.lower() != ".json":
        raise ValueError("browser evidence must be a UTF-8 JSON manifest")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"browser evidence manifest is invalid UTF-8 JSON: {exc}") from exc
    if not isinstance(manifest, dict) or set(manifest) != BROWSER_EVIDENCE_FIELDS:
        raise ValueError("browser evidence manifest has missing or redundant fields")
    if manifest.get("schema_version") != "browser-reachability-evidence-1.2":
        raise ValueError("browser evidence manifest has the wrong schema_version")
    if manifest.get("url") != expected_url:
        raise ValueError("browser evidence manifest URL does not match the tested URL")
    browser_family = _visible_browser_family(manifest.get("browser_family"))
    if manifest.get("window_mode") != "visible":
        raise ValueError(
            "browser evidence manifest requires window_mode=visible; "
            "headless or hidden sessions cannot provide screenshot visual evidence"
        )
    for field in ("edge_window_continuity_id", "edge_page_continuity_id"):
        value = manifest.get(field)
        if not isinstance(value, str) or not UUID4_RE.fullmatch(value):
            raise ValueError(f"browser evidence manifest {field} must be a canonical lowercase UUIDv4")
    if manifest.get("max_task_open_edge_pages") != 1 or isinstance(
        manifest.get("max_task_open_edge_pages"), bool
    ):
        raise ValueError("browser evidence manifest max_task_open_edge_pages must equal 1")
    capture_scope = manifest.get("capture_scope")
    if capture_scope not in ALLOWED_CAPTURE_SCOPES:
        raise ValueError(
            "browser evidence manifest capture_scope must equal "
            f"{CAPTURE_SCOPE} or legacy {LEGACY_EDGE_CAPTURE_SCOPE}"
        )
    if capture_scope == LEGACY_EDGE_CAPTURE_SCOPE and browser_family != "microsoft_edge":
        raise ValueError(
            "legacy full_visible_edge_window_with_tab_strip requires "
            "browser_family=microsoft_edge"
        )
    serial_index = manifest.get("preflight_serial_index")
    if not isinstance(serial_index, int) or isinstance(serial_index, bool) or serial_index <= 0:
        raise ValueError("browser evidence manifest preflight_serial_index must be a positive integer")
    if expected_serial_index is not None and serial_index != expected_serial_index:
        raise ValueError(
            "browser evidence manifest preflight_serial_index does not match the required family order"
        )
    started_at = _zoned_datetime(manifest.get("started_at"), "browser evidence manifest started_at")
    captured_at = _zoned_datetime(manifest.get("captured_at"), "browser evidence manifest captured_at")
    completed_at = _zoned_datetime(manifest.get("completed_at"), "browser evidence manifest completed_at")
    if started_at > completed_at:
        raise ValueError("browser evidence manifest started_at must not be after completed_at")
    if captured_at < started_at or captured_at > completed_at:
        raise ValueError("browser evidence manifest captured_at must fall inside the check interval")
    artifact_value = manifest.get("artifact_path")
    if not isinstance(artifact_value, str) or not artifact_value:
        raise ValueError("browser evidence manifest requires artifact_path")
    artifact_path = _under_evidence_root(Path(artifact_value), "browser evidence artifact")
    if artifact_path == manifest_path:
        raise ValueError("browser evidence manifest cannot cite itself as the artifact")
    expected_sha = manifest.get("artifact_sha256")
    if not isinstance(expected_sha, str) or len(expected_sha) != 64 or any(
        char not in "0123456789abcdef" for char in expected_sha
    ):
        raise ValueError("browser evidence manifest requires lowercase artifact SHA-256")
    if _sha256(artifact_path) != expected_sha:
        raise ValueError("browser evidence artifact SHA-256 does not match")
    artifact_kind = manifest.get("artifact_kind")
    suffix = artifact_path.suffix.lower()
    if artifact_kind != "browser_screenshot":
        raise ValueError(
            "browser evidence artifact_kind must equal browser_screenshot; "
            "browser_snapshot and JSON/HTML artifacts are forbidden"
        )
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"} or _image_kind(artifact_path) is None:
        raise ValueError("browser screenshot artifact must be a real PNG/JPEG/WebP image")
    return manifest_path, manifest


def _configured_proxy() -> str | None:
    for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = os.environ.get(name, "").strip()
        if value:
            return value if "://" in value else f"http://{value}"
    return None


def _proxy_endpoint(proxy_url: str) -> tuple[str, int] | None:
    parsed = urlparse(proxy_url)
    if not parsed.hostname:
        return None
    if parsed.port:
        return parsed.hostname, parsed.port
    return parsed.hostname, 443 if parsed.scheme == "https" else 80


def _tcp_reachable(endpoint: tuple[str, int] | None, timeout: float) -> bool:
    if endpoint is None:
        return False
    try:
        with socket.create_connection(endpoint, timeout=timeout):
            return True
    except OSError:
        return False


def _http_check(
    url: str, *, family: str, route: str, proxy_url: str | None,
    timeout: float, require_success: bool = False,
) -> dict[str, Any]:
    parsed = urlparse(url)
    result = {
        "family": family,
        "route": route,
        "url": url,
        "host": parsed.hostname or "",
        "reachable": False,
        "http_status": None,
        "error": "",
        **_empty_edge_check_fields(),
    }
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        result["error"] = "invalid_url"
        return result
    proxy_map = {} if proxy_url is None else {"http": proxy_url, "https": proxy_url}
    opener = build_opener(ProxyHandler(proxy_map))
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 CodexNetworkPreflight/1.0"})
    try:
        with opener.open(request, timeout=timeout) as response:
            response.read(1)
            result["http_status"] = int(response.getcode())
            result["reachable"] = not require_success or 200 <= result["http_status"] < 400
            if not result["reachable"]:
                result["error"] = f"http_{result['http_status']}"
    except HTTPError as exc:
        # An HTTP response proves the transport path; it does not prove platform-content access.
        result["reachable"] = not require_success
        result["http_status"] = int(exc.code)
        result["error"] = f"http_{exc.code}"
    except (URLError, TimeoutError, OSError) as exc:
        result["error"] = type(exc).__name__
    return result


def _browser_check(url: str, family: str, evidence_path: Path) -> dict[str, Any]:
    expected_index = PREFLIGHT_INDEX[family]
    manifest_path, manifest = _browser_manifest(
        evidence_path, url, expected_serial_index=expected_index,
    )
    return {
        "family": family,
        "route": "browser_session",
        "url": url,
        "host": urlparse(url).hostname or "",
        "reachable": True,
        "http_status": None,
        "error": "",
        "browser_family": manifest["browser_family"],
        "window_mode": manifest["window_mode"],
        "evidence_path": str(manifest_path),
        "evidence_sha256": _sha256(manifest_path),
        "evidence_kind": "browser_evidence_manifest",
        "edge_window_continuity_id": manifest["edge_window_continuity_id"],
        "edge_page_continuity_id": manifest["edge_page_continuity_id"],
        "max_task_open_edge_pages": manifest["max_task_open_edge_pages"],
        "capture_scope": manifest["capture_scope"],
        "preflight_serial_index": manifest["preflight_serial_index"],
        "started_at": manifest["started_at"],
        "captured_at": manifest["captured_at"],
        "completed_at": manifest["completed_at"],
    }


def _validate_serial_edge_checks(checks: list[dict[str, Any]]) -> None:
    browser_checks = [check for check in checks if check.get("route") == "browser_session"]
    if not browser_checks:
        return
    if len(browser_checks) > len(PREFLIGHT_INDEX):
        raise ValueError("network preflight may contain only one domestic and one overseas browser check")
    seen_families: set[str] = set()
    for check in browser_checks:
        family = check.get("family")
        if family not in PREFLIGHT_INDEX:
            raise ValueError("browser preflight family must be domestic or overseas")
        if family in seen_families:
            raise ValueError(f"network preflight contains duplicate {family} browser checks")
        seen_families.add(str(family))
        if check.get("preflight_serial_index") != PREFLIGHT_INDEX[family]:
            raise ValueError("preflight_serial_index must be domestic=1 and overseas=2")
        if check.get("max_task_open_edge_pages") != 1 or isinstance(
            check.get("max_task_open_edge_pages"), bool
        ):
            raise ValueError(
                "legacy max_task_open_edge_pages must equal 1 for the full browser check interval"
            )
        if check.get("capture_scope") not in ALLOWED_CAPTURE_SCOPES:
            raise ValueError(
                f"capture_scope must equal {CAPTURE_SCOPE} or legacy {LEGACY_EDGE_CAPTURE_SCOPE}"
            )
        browser_family = _visible_browser_family(check.get("browser_family"))
        if (
            check.get("capture_scope") == LEGACY_EDGE_CAPTURE_SCOPE
            and browser_family != "microsoft_edge"
        ):
            raise ValueError(
                "legacy full_visible_edge_window_with_tab_strip requires "
                "browser_family=microsoft_edge"
            )
        if check.get("window_mode") != "visible":
            raise ValueError("browser check requires window_mode=visible")
        for field in ("edge_window_continuity_id", "edge_page_continuity_id"):
            value = check.get(field)
            if not isinstance(value, str) or not UUID4_RE.fullmatch(value):
                raise ValueError(f"{field} must be a canonical lowercase UUIDv4")
        started_at = _zoned_datetime(check.get("started_at"), "browser check started_at")
        captured_at = _zoned_datetime(check.get("captured_at"), "browser check captured_at")
        completed_at = _zoned_datetime(check.get("completed_at"), "browser check completed_at")
        if started_at > completed_at:
            raise ValueError("browser check started_at must not be after completed_at")
        if captured_at < started_at or captured_at > completed_at:
            raise ValueError("browser check captured_at must fall inside the check interval")

    ordered = sorted(browser_checks, key=lambda check: int(check["preflight_serial_index"]))
    serials = [int(check["preflight_serial_index"]) for check in ordered]
    if serials != list(range(1, len(ordered) + 1)):
        raise ValueError("preflight_serial_index values must be unique and contiguous from 1")
    if len({str(check["edge_window_continuity_id"]) for check in ordered}) != 1:
        raise ValueError(
            "domestic and overseas browser checks must use the same "
            "edge_window_continuity_id legacy field"
        )
    if len({str(check["edge_page_continuity_id"]) for check in ordered}) != 1:
        raise ValueError(
            "domestic and overseas browser checks must use the same "
            "edge_page_continuity_id legacy field"
        )
    for previous, current in zip(ordered, ordered[1:]):
        previous_completed = _zoned_datetime(previous.get("completed_at"), "previous browser check completed_at")
        current_started = _zoned_datetime(current.get("started_at"), "current browser check started_at")
        if current_started < previous_completed:
            raise ValueError("visible browser preflight check intervals must not overlap")


def _probe_urls(
    channel: str, domestic_urls: list[str], overseas_urls: list[str],
    *, browser_evidence_supplied: bool,
) -> tuple[list[str], list[str]]:
    if channel not in {"browser", "edge", "api"}:
        raise ValueError("channel must be browser, edge, or api")
    if channel == "api":
        if browser_evidence_supplied:
            raise ValueError(
                "--channel api cannot use --browser-*-evidence; "
                "mixed workflows use --channel browser (or legacy --channel edge)"
            )
        if not domestic_urls or not overseas_urls:
            raise ValueError("--channel api requires explicit --domestic-url and --overseas-url API test endpoints")
        if set(domestic_urls).intersection(overseas_urls):
            raise ValueError("one API test endpoint cannot stand for both domestic and overseas routes")
        credential_parameters = {
            "access_token", "api_key", "apikey", "authorization", "client_secret",
            "password", "cookie", "session_token", "csrf_token", "key", "token",
            "auth", "bearer", "secret",
        }
        for url in [*domestic_urls, *overseas_urls]:
            parsed = urlparse(url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                raise ValueError("API preflight endpoints must be HTTP(S) URLs")
            if parsed.username or parsed.password or parsed.fragment or credential_parameters.intersection(
                name.lower() for name in parse_qs(parsed.query, keep_blank_values=True)
            ):
                raise ValueError("API preflight endpoints must not contain credentials or URL fragments")
    return domestic_urls or DEFAULT_DOMESTIC, overseas_urls or DEFAULT_OVERSEAS


def _build_summary(
    checks: list[dict[str, Any]], *, proxy_configured: bool,
    proxy_reachable: bool, channel: str = "browser",
) -> dict[str, Any]:
    if channel not in {"browser", "edge", "api"}:
        raise ValueError("channel must be browser, edge, or api")
    if channel == "api" and any(check.get("route") == "browser_session" for check in checks):
        raise ValueError(
            "API preflight must not contain browser_session checks; "
            "mixed workflows use browser or legacy edge"
        )
    # Default/mixed workflows retain separately evidenced visible-browser checks. API-only
    # workflows prove HTTP reachability without asserting any browser access.
    _validate_serial_edge_checks(checks)
    browser_checks = [
        check for check in checks
        if check.get("route") == "browser_session"
        and check.get("reachable") is True
        and isinstance(check.get("browser_family"), str)
        and "headless" not in str(check.get("browser_family")).lower()
        and check.get("window_mode") == "visible"
        and check.get("capture_scope") in ALLOWED_CAPTURE_SCOPES
    ]
    successful_transport = [
        check for check in checks
        if check.get("route") in {"direct_https", "configured_proxy"}
        and check.get("reachable") is True
        and isinstance(check.get("http_status"), int)
        and not isinstance(check.get("http_status"), bool)
        and 200 <= check["http_status"] < 400
        and check.get("error") == ""
        and all(check.get(field) is None for field in EDGE_CHECK_FIELDS)
    ]
    proving_checks = successful_transport if channel == "api" else browser_checks
    domestic = any(check.get("family") == "domestic" for check in proving_checks)
    overseas = any(check.get("family") == "overseas" for check in proving_checks)
    direct = any(
        check.get("route") == "direct_https" and check.get("reachable") is True
        for check in (successful_transport if channel == "api" else checks)
    )
    browser = all(any(check.get("family") == family for check in browser_checks) for family in PREFLIGHT_INDEX)
    hosts = list(dict.fromkeys(str(check.get("host", "")) for check in checks if check.get("host")))
    return {
        "schema_version": "network-preflight-1.4",
        "status": "complete" if domestic and overseas else "blocked",
        "checked_at": _now(),
        "proxy_configured": proxy_configured,
        "proxy_reachable": proxy_reachable,
        "direct_https_reachable": direct,
        "browser_session_reachable": browser,
        "domestic_route_reachable": domestic,
        "overseas_route_reachable": overseas,
        "tested_hosts": hosts,
        "checks": checks,
    }


def _self_test() -> int:
    from contextlib import redirect_stdout
    from io import StringIO
    from unittest.mock import Mock, patch

    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []
    with tempfile.TemporaryDirectory(dir=EVIDENCE_ROOT) as temp_dir:
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        domestic_artifact = Path(temp_dir) / "domestic-browser-screenshot.png"
        overseas_artifact = Path(temp_dir) / "overseas-browser-screenshot.png"
        domestic_artifact.write_bytes(png)
        overseas_artifact.write_bytes(png)
        domestic_evidence = Path(temp_dir) / "domestic-browser-evidence.json"
        overseas_evidence = Path(temp_dir) / "overseas-browser-evidence.json"
        window_id = "11111111-1111-4111-8111-111111111111"
        page_id = "22222222-2222-4222-8222-222222222222"
        records: dict[str, dict[str, Any]] = {}
        for family, manifest_path, url, artifact, serial_index, started_at, captured_at, completed_at in (
            (
                "domestic", domestic_evidence, "https://www.baidu.com/", domestic_artifact, 1,
                "2026-09-02T08:50:00+08:00", "2026-09-02T08:50:30+08:00",
                "2026-09-02T08:51:00+08:00",
            ),
            (
                "overseas", overseas_evidence, "https://www.google.com/", overseas_artifact, 2,
                "2026-09-02T08:51:00+08:00", "2026-09-02T08:51:30+08:00",
                "2026-09-02T08:52:00+08:00",
            ),
        ):
            record = {
                "schema_version": "browser-reachability-evidence-1.2", "url": url,
                "browser_family": "microsoft_edge", "window_mode": "visible",
                "edge_window_continuity_id": window_id,
                "edge_page_continuity_id": page_id,
                "max_task_open_edge_pages": 1,
                "capture_scope": CAPTURE_SCOPE,
                "preflight_serial_index": serial_index,
                "started_at": started_at,
                "captured_at": captured_at,
                "completed_at": completed_at,
                "artifact_path": str(artifact), "artifact_sha256": _sha256(artifact),
                "artifact_kind": "browser_screenshot",
            }
            manifest_path.write_text(json.dumps(record) + "\n", encoding="utf-8")
            records[family] = record
        checks = [
            _browser_check("https://www.baidu.com/", "domestic", domestic_evidence),
            _browser_check("https://www.google.com/", "overseas", overseas_evidence),
        ]
        complete = _build_summary(checks, proxy_configured=True, proxy_reachable=False)
        chrome_checks = copy.deepcopy(checks)
        for check in chrome_checks:
            check["browser_family"] = "google_chrome"
        chrome_complete = _build_summary(
            chrome_checks, proxy_configured=False, proxy_reachable=False, channel="browser",
        )
        legacy_channel_complete = _build_summary(
            checks, proxy_configured=False, proxy_reachable=False, channel="edge",
        )
        if chrome_complete["status"] != "complete" or not chrome_complete["browser_session_reachable"]:
            failures.append("generic visible Chrome browser completion")
        if legacy_channel_complete["status"] != "complete":
            failures.append("legacy --channel edge compatibility")
        blocked = _build_summary(checks[:1], proxy_configured=False, proxy_reachable=False)
        direct_only = _build_summary([
            {
                "family": "domestic", "route": "direct_https", "url": "https://www.baidu.com/",
                "host": "www.baidu.com", "reachable": True, "http_status": 200, "error": "",
                **_empty_edge_check_fields(),
            },
            {
                "family": "overseas", "route": "direct_https", "url": "https://www.google.com/",
                "host": "www.google.com", "reachable": True, "http_status": 200, "error": "",
                **_empty_edge_check_fields(),
            },
        ], proxy_configured=False, proxy_reachable=False)
        api_checks = copy.deepcopy(direct_only["checks"])
        api_complete = _build_summary(
            api_checks, proxy_configured=False, proxy_reachable=False, channel="api",
        )
        if api_complete["status"] != "complete" or api_complete["browser_session_reachable"]:
            failures.append("API transport-only completion without browser assertion")
        if any(check[field] is not None for check in api_complete["checks"] for field in EDGE_CHECK_FIELDS):
            failures.append("API transport checks must have null browser-specific compatibility fields")
        api_missing = _build_summary(
            api_checks[:1], proxy_configured=False, proxy_reachable=False, channel="api",
        )
        if api_missing["status"] != "blocked" or api_missing["overseas_route_reachable"]:
            failures.append("API missing family remains blocked")
        for label, changes in (
            ("API HTTP 403 is not access", {"http_status": 403, "error": "http_403"}),
            ("API HTTP 429 is not access", {"http_status": 429, "error": "http_429"}),
            ("API missing HTTP code is not access", {"http_status": None}),
            ("API timeout is not access", {"reachable": False, "http_status": None, "error": "TimeoutError"}),
            ("API fake browser field is not access", {"browser_family": "microsoft_edge"}),
        ):
            partial_checks = copy.deepcopy(api_checks)
            partial_checks[1].update(changes)
            if _build_summary(partial_checks, proxy_configured=False, proxy_reachable=False, channel="api")["status"] != "blocked":
                failures.append(label)
        proxy_checks = copy.deepcopy(api_checks)
        for check in proxy_checks:
            check["route"] = "configured_proxy"
        proxy_only = _build_summary(proxy_checks, proxy_configured=True, proxy_reachable=True, channel="api")
        if proxy_only["status"] != "complete" or proxy_only["direct_https_reachable"] or proxy_only["browser_session_reachable"]:
            failures.append("API configured-proxy-only success")
        try:
            _build_summary(checks, proxy_configured=False, proxy_reachable=False, channel="api")
        except ValueError:
            pass
        else:
            failures.append("API mode must reject browser_session input")

        api_domestic_url = "https://api.weibo.com/2/help/test.json"
        api_overseas_url = "https://www.googleapis.com/youtube/v3/videos?part=id&id=fixture"
        for label, channel, domestic_urls, overseas_urls, browser_supplied in (
            ("API explicit URLs required", "api", [], [], False),
            ("API missing overseas URL", "api", [api_domestic_url], [], False),
            ("API mixed browser arguments", "api", [api_domestic_url], [api_overseas_url], True),
            ("API duplicate family URL", "api", [api_domestic_url], [api_domestic_url], False),
            ("API credential URL rejected", "api", [api_domestic_url + "?access_token=fixture-secret"], [api_overseas_url], False),
            ("API key URL rejected", "api", [api_domestic_url + "?key=fixture-secret"], [api_overseas_url], False),
            ("API token URL rejected", "api", [api_domestic_url + "?token=fixture-secret"], [api_overseas_url], False),
            ("API userinfo URL rejected", "api", ["https://name:secret@api.weibo.com/"], [api_overseas_url], False),
        ):
            try:
                _probe_urls(channel, domestic_urls, overseas_urls, browser_evidence_supplied=browser_supplied)
            except ValueError:
                pass
            else:
                failures.append(label)
        if _probe_urls("browser", [], [], browser_evidence_supplied=False) != (DEFAULT_DOMESTIC, DEFAULT_OVERSEAS):
            failures.append("default browser URLs")
        if _probe_urls("edge", [], [], browser_evidence_supplied=False) != (DEFAULT_DOMESTIC, DEFAULT_OVERSEAS):
            failures.append("legacy Edge channel compatibility")
        if _probe_urls("api", [api_domestic_url], [api_overseas_url], browser_evidence_supplied=False) != ([api_domestic_url], [api_overseas_url]):
            failures.append("explicit credential-free API URLs")

        # Exercise the HTTP and CLI paths with fake responses only; self-test
        # must never make a live request or open a browser.
        for label, outcome, expected_reachable, expected_status in (
            ("API HTTP response success", 200, True, 200),
            ("API HTTPError rejection", HTTPError(api_domestic_url, 403, "forbidden", {}, None), False, 403),
            ("API HTTP 404 rejection", HTTPError(api_domestic_url, 404, "not found", {}, None), False, 404),
            ("API timeout rejection", TimeoutError(), False, None),
        ):
            opener = Mock()
            if isinstance(outcome, Exception):
                opener.open.side_effect = outcome
            else:
                response = Mock()
                response.getcode.return_value = outcome
                opener.open.return_value.__enter__ = Mock(return_value=response)
                opener.open.return_value.__exit__ = Mock(return_value=False)
            with patch(__name__ + ".build_opener", return_value=opener):
                result = _http_check(
                    api_domestic_url, family="domestic", route="direct_https",
                    proxy_url=None, timeout=1, require_success=True,
                )
            if result["reachable"] is not expected_reachable or result["http_status"] != expected_status:
                failures.append(label)

        cli_output = Path(temp_dir) / "api-cli-preflight.json"
        def mock_http(url: str, *, family: str, route: str, **kwargs: Any) -> dict[str, Any]:
            return {
                "family": family, "route": route, "url": url, "host": urlparse(url).hostname,
                "reachable": True, "http_status": 200, "error": "", **_empty_edge_check_fields(),
            }
        with patch.object(sys, "argv", [
            "network_preflight.py", "--channel", "api", "--out", str(cli_output),
            "--domestic-url", api_domestic_url, "--overseas-url", api_overseas_url,
        ]), patch(__name__ + "._http_check", side_effect=mock_http), patch(
            __name__ + "._configured_proxy", return_value=None,
        ), patch(__name__ + "._browser_check", side_effect=AssertionError("self-test must not use a browser")), redirect_stdout(StringIO()):
            cli_status = main()
        cli_log = json.loads(cli_output.read_text(encoding="utf-8"))
        if cli_status != 0 or cli_log["status"] != "complete" or cli_log["browser_session_reachable"]:
            failures.append("mocked API CLI writes a complete non-browser preflight")

        # The formal channel accepts persistent system desktop browser families.
        # A real screenshot plus window_mode=visible is still required; Codex,
        # in-app/IAB, hosted, embedded and headless families are forbidden.
        for accepted_family in (
            "microsoft_edge", "google_chrome", "chromium", "mozilla_firefox",
        ):
            accepted_record = copy.deepcopy(records["domestic"])
            accepted_record["browser_family"] = accepted_family
            accepted_record["capture_scope"] = CAPTURE_SCOPE
            accepted_manifest = Path(temp_dir) / f"accepted-{accepted_family}.json"
            accepted_manifest.write_text(json.dumps(accepted_record) + "\n", encoding="utf-8")
            try:
                _browser_manifest(
                    accepted_manifest, "https://www.baidu.com/", expected_serial_index=1,
                )
            except ValueError as exc:
                failures.append(f"visible browser family {accepted_family} rejected: {exc}")

        legacy_edge_record = copy.deepcopy(records["domestic"])
        legacy_edge_record["browser_family"] = "microsoft_edge"
        legacy_edge_record["capture_scope"] = LEGACY_EDGE_CAPTURE_SCOPE
        legacy_edge_manifest = Path(temp_dir) / "accepted-legacy-edge.json"
        legacy_edge_manifest.write_text(json.dumps(legacy_edge_record) + "\n", encoding="utf-8")
        try:
            _browser_manifest(
                legacy_edge_manifest, "https://www.baidu.com/", expected_serial_index=1,
            )
        except ValueError as exc:
            failures.append(f"legacy Edge manifest compatibility: {exc}")

        manifest_cases: list[tuple[str, dict[str, Any], str]] = []
        for label, changes, expected in (
            ("old schema rejection", {"schema_version": "browser-reachability-evidence-1.1"}, "wrong schema_version"),
            ("Codex browser family rejection", {"browser_family": "codex_builtin_browser"}, "persistent system desktop browser"),
            ("in-app browser family rejection", {"browser_family": "in_app_browser"}, "persistent system desktop browser"),
            ("IAB browser family rejection", {"browser_family": "iab"}, "persistent system desktop browser"),
            ("hosted browser family rejection", {"browser_family": "hosted_chrome"}, "persistent system desktop browser"),
            ("embedded browser family rejection", {"browser_family": "embedded_browser"}, "persistent system desktop browser"),
            ("headless browser family rejection", {"browser_family": "headless_chromium"}, "persistent system desktop browser"),
            ("hidden browser rejection", {"window_mode": "hidden"}, "window_mode=visible"),
            ("headless window rejection", {"window_mode": "headless"}, "window_mode=visible"),
            ("two browser pages rejection", {"max_task_open_edge_pages": 2}, "max_task_open_edge_pages must equal 1"),
            ("wrong capture scope rejection", {"capture_scope": "page_content_only"}, "capture_scope must equal"),
            (
                "legacy Edge scope on Chrome rejection",
                {
                    "browser_family": "google_chrome",
                    "capture_scope": LEGACY_EDGE_CAPTURE_SCOPE,
                },
                "requires browser_family=microsoft_edge",
            ),
            ("wrong preflight index rejection", {"preflight_serial_index": 2}, "required family order"),
            ("invalid window UUID rejection", {"edge_window_continuity_id": "not-a-uuid"}, "canonical lowercase UUIDv4"),
            ("invalid page UUID rejection", {"edge_page_continuity_id": "not-a-uuid"}, "canonical lowercase UUIDv4"),
            (
                "reversed interval rejection",
                {"started_at": "2026-09-02T08:52:00+08:00", "completed_at": "2026-09-02T08:51:00+08:00"},
                "started_at must not be after completed_at",
            ),
            (
                "capture outside interval rejection",
                {"captured_at": "2026-09-02T08:52:00+08:00"},
                "captured_at must fall inside the check interval",
            ),
        ):
            record = copy.deepcopy(records["domestic"])
            record.update(changes)
            manifest_cases.append((label, record, expected))

        snapshot_artifact = Path(temp_dir) / "forbidden-browser-snapshot.json"
        snapshot_artifact.write_text('{"url":"https://www.baidu.com/"}\n', encoding="utf-8")
        bad_snapshot_record = copy.deepcopy(records["domestic"])
        bad_snapshot_record.update({
            "artifact_path": str(snapshot_artifact),
            "artifact_sha256": _sha256(snapshot_artifact),
            "artifact_kind": "browser_snapshot",
        })
        manifest_cases.append((
            "browser snapshot rejection", bad_snapshot_record,
            "browser_snapshot and JSON/HTML artifacts are forbidden",
        ))
        html_artifact = Path(temp_dir) / "forbidden-browser-page.html"
        html_artifact.write_text("<html><body>not a screenshot</body></html>\n", encoding="utf-8")
        bad_html_record = copy.deepcopy(records["domestic"])
        bad_html_record.update({
            "artifact_path": str(html_artifact),
            "artifact_sha256": _sha256(html_artifact),
        })
        manifest_cases.append(("HTML browser artifact rejection", bad_html_record, "real PNG/JPEG/WebP image"))

        for case_index, (label, record, expected_fragment) in enumerate(manifest_cases, start=1):
            manifest_path = Path(temp_dir) / f"bad-browser-evidence-{case_index}.json"
            manifest_path.write_text(json.dumps(record) + "\n", encoding="utf-8")
            try:
                _browser_manifest(
                    manifest_path, "https://www.baidu.com/", expected_serial_index=1,
                )
            except ValueError as exc:
                if expected_fragment not in str(exc):
                    failures.append(f"{label}: wrong error {exc}")
            else:
                failures.append(label)

        serial_cases: list[tuple[str, list[dict[str, Any]], str]] = []
        two_pages = copy.deepcopy(checks)
        two_pages[0]["max_task_open_edge_pages"] = 2
        serial_cases.append(("two-page serial check", two_pages, "max_task_open_edge_pages must equal 1"))
        duplicate_index = copy.deepcopy(checks)
        duplicate_index[1]["preflight_serial_index"] = 1
        serial_cases.append(("wrong serial index", duplicate_index, "domestic=1 and overseas=2"))
        overlapping = copy.deepcopy(checks)
        overlapping[1]["started_at"] = "2026-09-02T08:50:59+08:00"
        serial_cases.append(("overlapping intervals", overlapping, "must not overlap"))
        different_window = copy.deepcopy(checks)
        different_window[1]["edge_window_continuity_id"] = "33333333-3333-4333-8333-333333333333"
        serial_cases.append(("different Edge windows", different_window, "same edge_window_continuity_id"))
        different_page = copy.deepcopy(checks)
        different_page[1]["edge_page_continuity_id"] = "44444444-4444-4444-8444-444444444444"
        serial_cases.append(("different Edge pages", different_page, "same edge_page_continuity_id"))
        for label, mutated_checks, expected_fragment in serial_cases:
            try:
                _validate_serial_edge_checks(mutated_checks)
            except ValueError as exc:
                if expected_fragment not in str(exc):
                    failures.append(f"{label}: wrong error {exc}")
            else:
                failures.append(label)
    if complete["status"] != "complete" or not complete["domestic_route_reachable"] or not complete["overseas_route_reachable"]:
        failures.append("two-family completion")
    if blocked["status"] != "blocked" or blocked["overseas_route_reachable"]:
        failures.append("missing-family blocking")
    if direct_only["status"] != "blocked" or direct_only["domestic_route_reachable"] or direct_only["overseas_route_reachable"]:
        failures.append("direct HTTP must remain diagnostic")
    if _proxy_endpoint("http://127.0.0.1:10808") != ("127.0.0.1", 10808):
        failures.append("proxy parsing")
    print(json.dumps({"self_test": "failed" if failures else "passed", "failures": failures, "api_checks": 25}, ensure_ascii=False))
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog=(
            "Legacy compatibility only: use with exhaustive_audit / schema 1.10. "
            "Do not invoke for three_hour_targeted_v1; this preflight's serial "
            "single-page evidence rules do not restrict targeted parallel browser research. "
            "The executor defaults to launching persistent desktop Microsoft Edge and may "
            "create/select a task page; Codex/in-app/IAB, hosted, embedded, and headless "
            "browsers are invalid evidence. "
            "no pre-opened Edge session, endpoint, or tab id is required."
        ),
    )
    parser.add_argument("--out", type=Path, help="write legacy network-preflight-1.4 JSON under the configured workspace")
    parser.add_argument(
        "--channel", choices=("browser", "edge", "api"), default="browser",
        help=(
            "legacy exhaustive_audit/schema 1.10 preflight channel; browser is the formal "
            "visible-browser mode, edge is a compatibility alias, and api proves transport "
            "only, never platform permission or research completion; three_hour_targeted_v1 "
            "must not call this script"
        ),
    )
    parser.add_argument("--domestic-url", action="append", default=[], help="repeatable domestic test URL")
    parser.add_argument("--overseas-url", action="append", default=[], help="repeatable overseas test URL")
    parser.add_argument("--browser-domestic-evidence", type=Path, help="legacy schema 1.10 hashed browser-reachability-evidence-1.2 single-page visible-browser manifest for the domestic test URL")
    parser.add_argument("--browser-overseas-evidence", type=Path, help="legacy schema 1.10 hashed browser-reachability-evidence-1.2 single-page visible-browser manifest for the overseas test URL")
    parser.add_argument("--timeout", type=float, default=8.0)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return _self_test()
    if args.out is None:
        parser.error("--out is required")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    output = args.out.resolve(strict=False)
    try:
        output.relative_to(EVIDENCE_ROOT)
    except ValueError:
        parser.error(f"--out must be under {EVIDENCE_ROOT}")
    try:
        domestic_urls, overseas_urls = _probe_urls(
            args.channel, args.domestic_url, args.overseas_url,
            browser_evidence_supplied=bool(args.browser_domestic_evidence or args.browser_overseas_evidence),
        )
    except ValueError as exc:
        parser.error(str(exc))
    proxy_url = _configured_proxy()
    proxy_reachable = _tcp_reachable(_proxy_endpoint(proxy_url), args.timeout) if proxy_url else False
    checks: list[dict[str, Any]] = []
    for family, urls in (("domestic", domestic_urls), ("overseas", overseas_urls)):
        for url in urls:
            checks.append(_http_check(
                url, family=family, route="direct_https", proxy_url=None,
                timeout=args.timeout, require_success=args.channel == "api",
            ))
            if proxy_url and proxy_reachable:
                checks.append(_http_check(
                    url, family=family, route="configured_proxy", proxy_url=proxy_url,
                    timeout=args.timeout, require_success=args.channel == "api",
                ))
    try:
        if args.browser_domestic_evidence:
            checks.append(_browser_check(domestic_urls[0], "domestic", args.browser_domestic_evidence))
        if args.browser_overseas_evidence:
            checks.append(_browser_check(overseas_urls[0], "overseas", args.browser_overseas_evidence))
        result = _build_summary(
            checks, proxy_configured=proxy_url is not None, proxy_reachable=proxy_reachable,
            channel=args.channel,
        )
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": result["status"], "output": str(output),
        "channel": args.channel,
        "scope": "network reachability only; not platform permission or research completion",
        "domestic_route_reachable": result["domestic_route_reachable"],
        "overseas_route_reachable": result["overseas_route_reachable"],
    }, ensure_ascii=False))
    return 0 if result["status"] == "complete" else 2


if __name__ == "__main__":
    sys.exit(main())
