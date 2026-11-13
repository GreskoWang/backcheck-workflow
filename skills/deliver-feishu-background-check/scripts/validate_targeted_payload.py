#!/usr/bin/env python3
"""Validator for the bounded three-hour background-check handoff profile.

The targeted profile proves that the declared, human-sized review set was
completed and that every discovered risk is delivery-ready.  It intentionally
does not turn unselected results into fabricated item ledgers, does not require
a natural endpoint, and does not apply the exhaustive profile's full-query,
all-surface, account Top-10 full-audio, or double-clean-route gates.
"""

from __future__ import annotations
import os

import hashlib
import importlib.util
import json
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, parse_qsl, unquote, urlparse

_review_spec = importlib.util.spec_from_file_location(
    "background_check_targeted_review_proofs", Path(__file__).with_name("review_proofs.py"),
)
if _review_spec is None or _review_spec.loader is None:
    raise ImportError("required sibling review_proofs.py could not be loaded")
_review_module = importlib.util.module_from_spec(_review_spec)
_review_spec.loader.exec_module(_review_module)
validate_targeted_item_review = _review_module.validate_targeted_item_review


SCHEMA_VERSION = "1.11"
RESEARCH_PROFILE = "three_hour_targeted_v1"
EVIDENCE_ROOT = Path(os.environ["BACKGROUND_CHECK_WORKSPACE"]).resolve(strict=False)
RISK_STANDARD_PATH = EVIDENCE_ROOT / "背调风险提示.md"
MAX_IMAGE_BYTES = 20 * 1024 * 1024
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
UUID4_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

PLATFORMS = (
    "weibo", "bilibili", "douyin", "xiaohongshu", "zhihu", "netease_music",
    "tieba", "douban", "domestic_other", "x", "facebook", "instagram",
    "youtube", "overseas_other",
)
PLATFORM_DISPLAY = {
    "weibo": "微博", "bilibili": "B站", "douyin": "抖音", "xiaohongshu": "小红书",
    "zhihu": "知乎", "netease_music": "网易云音乐", "tieba": "贴吧", "douban": "豆瓣",
    "domestic_other": "境内其他内容", "x": "X", "facebook": "Facebook",
    "instagram": "INS", "youtube": "油管", "overseas_other": "境外其他网站",
}
DELIVERY_MODULES = {
    "weibo": ("homepage", "keyword_search", "topic"),
    "bilibili": ("homepage", "keyword_search"),
    "douyin": ("homepage", "keyword_search"),
    "xiaohongshu": ("homepage", "keyword_search"),
    "zhihu": ("homepage", "keyword_search"),
    "netease_music": ("homepage", "keyword_search"),
    "tieba": ("homepage", "topic_homepage", "keyword_search"),
    "douban": ("subject_homepage", "keyword_search"),
    "domestic_other": ("baidu_search",),
    "x": ("homepage", "keyword_search", "review_start_month"),
    "facebook": ("homepage", "keyword_search"),
    "instagram": ("homepage", "keyword_search"),
    "youtube": ("homepage", "keyword_search"),
    "overseas_other": ("google_search",),
}
HOMEPAGE_MODULES = {"homepage", "subject_homepage", "topic", "topic_homepage"}
ACCOUNT_HOMEPAGE_MODULES = {"homepage", "subject_homepage"}
SEARCH_MODULES = {"keyword_search", "baidu_search", "google_search"}
OTHER_TAIL_STATEMENTS = {
    "domestic_other": "其他境内平台暂未发现相关账号或相关内容的负面及敏感信息。",
    "overseas_other": "其他境外平台暂未发现相关账号或相关内容的负面及敏感信息。",
}
PLATFORM_HOST_SUFFIXES = {
    "weibo": ("weibo.com", "weibo.cn"),
    "bilibili": ("bilibili.com", "b23.tv"),
    "douyin": ("douyin.com",),
    "xiaohongshu": ("xiaohongshu.com", "xhslink.com"),
    "zhihu": ("zhihu.com", "zhihu.link"),
    "netease_music": ("music.163.com",),
    "tieba": ("tieba.baidu.com",),
    "douban": ("douban.com",),
    "x": ("x.com", "twitter.com"),
    "facebook": ("facebook.com", "fb.com"),
    "instagram": ("instagram.com",),
    "youtube": ("youtube.com", "youtu.be"),
    "domestic_other": ("baidu.com",),
    "overseas_other": ("google.com",),
}
RESULT_LEVELS = {"建议谨慎评估", "建议评估", "无合作风险"}
SUBJECT_TYPES = {"person", "organization", "company", "brand", "project", "other_entity"}
ACCOUNT_STATUSES = {"confirmed", "suspected_homepage", "unconfirmed_candidate", "excluded_candidate"}
DISCOVERY_STATUSES = {
    "confirmed_account", "suspected_account", "related_content_only",
    "no_account_after_targeted_search",
}
ROUTE_STATUSES = {"targeted_complete", "blocked", "failed"}
INTERACTIVE_BROWSER_TOOL_KINDS = {"browser_ui", "microsoft_edge_visible"}
TOOL_KINDS = INTERACTIVE_BROWSER_TOOL_KINDS | {
    "official_api", "authorized_export", "local_script",
}
TARGETED_ROUTE_FIELDS = {
    "route_id", "module_key", "surface", "account_or_query_url", "resolved_url",
    "tool_kind", "tool_name", "browser_family", "executor_id",
    "edge_window_continuity_id", "edge_page_continuity_id", "status",
    "termination", "selection_rule", "pages_checked", "items_selected", "items_reviewed",
    "flagged_items", "scope_stop_reason", "minimum_scope_met", "started_at", "completed_at",
    "query_kind", "query_text", "query_risk_group", "query_terms",
    "flagged_item_ledger_path", "flagged_item_ledger_sha256", "resolved_by_route_ids", "boundary",
}
SELECTION_RULES = {
    "platform_first_3_pages_or_30_results",
    "homepage_pinned_all_latest20_popular10_historical1_applicable_tabs",
    "homepage_all_public_text_to_natural_end",
    "topic_related_first_30_items",
    "main_name_first_10_pages",
    "combined_high_risk_first_3_pages",
    "user_risk_lead_targeted",
    "identity_resolution_targeted",
    "risk_context_followup",
}
SCOPE_STOP_REASONS = {
    "page_limit", "item_limit", "results_exhausted_early", "scope_sample_complete",
    "natural_end", "cursor_exhausted", "empty_timeline",
    "target_resolved", "access_boundary", "route_failed",
}
QUERY_KINDS = {
    "main_name", "strongest_handle", "alias", "combined_high_risk", "non_query",
    "targeted_followup",
}
TARGET_SCOPE = {
    "active_work_target_minutes": 180,
    "broad_discovery_freeze_minute": 90,
    "platform_search_max_pages": 3,
    "platform_search_max_results": 30,
    "general_search_main_name_max_pages": 10,
    "general_search_risk_query_max_pages": 3,
    "homepage_text_scope": "all_public_posts_to_natural_end",
    "media_latest_limit": 20,
    "media_popular_limit": 10,
    "media_historical_samples": 1,
    "comment_hot_limit": 20,
    "video_detail_trigger_interval_seconds": 10,
}
QA_FLAGS = {
    "all_fourteen_platforms_visited", "all_user_risk_leads_closed",
    "selected_items_reviewed", "all_found_risks_evidenced", "delivery_modules_mapped",
    "no_unresolved_platforms", "delivery_payload_validated",
}


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _temporary_browser_identity(value: Any) -> bool:
    """Reject explicit non-persistent browser identities, including joined aliases."""
    if not _text(value):
        return False
    lowered = str(value).strip().casefold()
    compact = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", lowered)
    tokens = set(re.findall(r"[a-z0-9]+", lowered))
    if any(marker in compact for marker in (
        "codex", "openai", "inapp", "embedded", "builtin",
        "hosted", "headless", "temporary", "ephemeral",
    )):
        return True
    if "iab" in tokens or "iabbrowser" in compact or any(marker in tokens for marker in {
        "hosted", "headless", "temporary", "ephemeral",
    }):
        return True
    return any(marker in lowered for marker in (
        "内置浏览器", "内嵌浏览器", "嵌入式浏览器", "应用内浏览器",
        "托管浏览器", "无头浏览器", "临时浏览器",
    ))


def _known_browser_brand(value: Any) -> str:
    if not _text(value):
        return ""
    lowered = str(value).strip().casefold()
    compact = re.sub(r"[^a-z0-9]+", "", lowered)
    tokens = set(re.findall(r"[a-z0-9]+", lowered))
    if "microsoftedge" in compact or "edge" in tokens:
        return "edge"
    if "googlechrome" in compact or "chrome" in tokens or "chromium" in tokens:
        return "chromium"
    if "firefox" in compact:
        return "firefox"
    if "safari" in compact:
        return "safari"
    return ""


def _url(value: Any) -> bool:
    if not _text(value):
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _normalized_url_identity(value: Any) -> tuple[str, str, tuple[tuple[str, str], ...]] | None:
    """Normalize harmless URL presentation/tracking differences for equality gates."""
    if not _url(value):
        return None
    parsed = urlparse(str(value))
    host = (parsed.hostname or "").lower().rstrip(".")
    path = unquote(parsed.path or "/")
    if path != "/":
        path = path.rstrip("/")
    tracking_names = {
        "fbclid", "gclid", "dclid", "msclkid", "igshid", "mc_cid", "mc_eid",
        "ref", "ref_src", "source", "feature", "si",
    }
    query_pairs = tuple(sorted(
        (name, item)
        for name, item in parse_qsl(parsed.query, keep_blank_values=True)
        if not name.lower().startswith("utm_") and name.lower() not in tracking_names
    ))
    return host, path, query_pairs


def _placeholder(value: Any) -> bool:
    if not _url(value):
        return False
    lowered = str(value).lower()
    return any(marker in lowered for marker in ("example.com", "example.org", "example.net", "placeholder"))


def _platform_url(platform_key: str, value: Any) -> bool:
    if not _url(value):
        return False
    host = (urlparse(str(value)).hostname or "").lower().rstrip(".")
    return any(host == suffix or host.endswith(f".{suffix}") for suffix in PLATFORM_HOST_SUFFIXES[platform_key])


def _first_nonempty_query_value(query: dict[str, list[str]], names: tuple[str, ...]) -> str | None:
    for name in names:
        for value in query.get(name, []):
            if _text(value):
                return value
    return None


def _path_has_identifier(path: str, *prefixes: str) -> bool:
    """Return true only when a content prefix is followed by a non-empty id."""
    lowered = unquote(path).lower()
    for prefix in prefixes:
        if lowered.startswith(prefix) and lowered[len(prefix):].strip("/"):
            return True
    return False


def _search_query_from_url(platform_key: str, value: Any) -> str | None:
    """Return the visible query only for a controlled platform search route."""
    if not _url(value) or not _platform_url(platform_key, value):
        return None
    parsed = urlparse(str(value))
    host = (parsed.hostname or "").lower().rstrip(".")
    path = unquote(parsed.path or "/").lower().rstrip("/") or "/"
    query = parse_qs(parsed.query, keep_blank_values=True)
    path_rules: dict[str, tuple[bool, tuple[str, ...]]] = {
        "weibo": (host == "s.weibo.com" and path in {"/weibo", "/user"}, ("q",)),
        "bilibili": (
            host == "search.bilibili.com"
            and path in {"/all", "/video", "/upuser", "/article", "/bangumi", "/live"},
            ("keyword",),
        ),
        "xiaohongshu": (path == "/search_result", ("keyword", "q")),
        "zhihu": (path == "/search", ("q",)),
        "tieba": (path == "/f/search/res", ("qw", "kw")),
        "douban": (path == "/search" or (host.startswith("search.") and "search" in path), ("q", "search_text")),
        "x": (path == "/search", ("q",)),
        "facebook": (path == "/search" or path.startswith("/search/"), ("q",)),
        "instagram": (path == "/explore/search" or path.startswith("/explore/search/"), ("q",)),
        "youtube": (path == "/results", ("search_query",)),
        "domestic_other": (path == "/s", ("wd", "word")),
        "overseas_other": (path == "/search", ("q",)),
    }
    if platform_key in path_rules:
        path_matches, parameter_names = path_rules[platform_key]
        if not path_matches:
            return None
        return _first_nonempty_query_value(query, parameter_names)
    if platform_key == "douyin":
        if _path_has_identifier(path, "/search/"):
            return unquote(path[len("/search/"):]).strip("/")
        return None
    if platform_key == "netease_music":
        fragment_path, separator, fragment_query_text = parsed.fragment.partition("?")
        if not separator or not unquote(fragment_path).lower().startswith("/search/"):
            return None
        fragment_query = parse_qs(fragment_query_text, keep_blank_values=True)
        return _first_nonempty_query_value(fragment_query, ("s", "q", "keyword", "keywords"))
    return None


def _homepage_or_topic_url(platform_key: str, module_key: str, value: Any) -> bool:
    """Recognize a Chapter 4 homepage/topic URL and reject search/content pages."""
    if not _url(value) or _placeholder(value):
        return False
    parsed = urlparse(str(value))
    host = (parsed.hostname or "").lower().rstrip(".")
    path = unquote(parsed.path or "/").lower().rstrip("/") or "/"
    query = parse_qs(parsed.query, keep_blank_values=True)

    if module_key.startswith("subplatform:"):
        search_hosts = (
            "google.", "bing.com", "baidu.com", "yahoo.com", "yandex.",
            "duckduckgo.com", "sogou.com", "so.com",
        )
        search_parameters = {"q", "query", "keyword", "wd", "word", "search_query"}
        obvious_content_path = re.search(
            r"/(?:artworks?|posts?|videos?|watch|shorts?|reels?|status|detail|articles?|read|notes?|items?|tracks?|albums?|p)/?(?:/|[^/])",
            path,
        ) is not None
        obvious_content_query = _first_nonempty_query_value(
            query, ("v", "video_id", "post_id", "artwork_id", "status_id")
        ) is not None
        return not (
            any(marker in host for marker in search_hosts)
            or path.startswith(("/search", "/web/search", "/s/search"))
            or any(_first_nonempty_query_value(query, (name,)) is not None for name in search_parameters)
            or obvious_content_path
            or obvious_content_query
        )

    if not _platform_url(platform_key, value):
        return False
    native_search_query = _search_query_from_url(platform_key, value)
    if platform_key == "weibo" and module_key == "topic" and native_search_query is not None:
        topic_query = native_search_query.strip()
        return len(topic_query) > 2 and topic_query.startswith("#") and topic_query.endswith("#")
    if native_search_query is not None:
        return False

    # A search parameter on a profile-shaped path is still not acceptable as
    # search evidence, and it is too ambiguous to accept as a homepage sample.
    search_parameters = {
        "weibo": ("q",), "bilibili": ("keyword",), "douyin": ("keyword", "q"),
        "xiaohongshu": ("keyword", "q"), "zhihu": ("q",), "douban": ("q", "search_text"),
        "x": ("q",), "facebook": ("q",), "instagram": ("q",), "youtube": ("search_query",),
    }.get(platform_key, ())
    if _first_nonempty_query_value(query, search_parameters) is not None:
        return False

    if platform_key == "weibo":
        if module_key == "topic":
            if path == "/p/index":
                return _first_nonempty_query_value(query, ("containerid",)) is not None
            return _path_has_identifier(path, "/p/", "/topic/")
        if _direct_content_url(platform_key, value):
            return False
        reserved = {"/", "/search", "/login", "/signup", "/hot", "/newlogin"}
        return path not in reserved and bool(
            re.match(r"^/(?:u|n|profile)/[^/]+$", path)
            or re.match(r"^/[^/]+$", path)
        )
    if _direct_content_url(platform_key, value):
        return False
    if platform_key == "bilibili":
        return host == "space.bilibili.com" and bool(re.match(r"^/[^/]+$", path))
    if platform_key == "douyin":
        return _path_has_identifier(path, "/user/")
    if platform_key == "xiaohongshu":
        return _path_has_identifier(path, "/user/profile/")
    if platform_key == "zhihu":
        return _path_has_identifier(path, "/people/", "/org/")
    if platform_key == "netease_music":
        location = str(value).lower()
        return any(marker in location for marker in ("/artist?", "/user/home?", "#/artist?", "#/user/home?")) and bool(
            re.search(r"(?:[?&])id=[^&#]+", location)
        )
    if platform_key == "tieba":
        if module_key == "topic_homepage":
            return path == "/f" and _first_nonempty_query_value(query, ("kw",)) is not None
        return path == "/home/main" and _first_nonempty_query_value(query, ("id", "un")) is not None
    if platform_key == "douban":
        return bool(re.match(r"^/(?:people|celebrity|author)/[^/]+$", path))
    if platform_key == "x":
        reserved = {"home", "explore", "search", "notifications", "messages", "i", "settings", "compose"}
        segments = [segment for segment in path.split("/") if segment]
        return len(segments) == 1 and segments[0] not in reserved
    if platform_key == "facebook":
        if path == "/profile.php":
            return _first_nonempty_query_value(query, ("id",)) is not None
        reserved = {"search", "watch", "reel", "reels", "stories", "groups", "events", "marketplace"}
        segments = [segment for segment in path.split("/") if segment]
        return len(segments) == 1 and segments[0] not in reserved
    if platform_key == "instagram":
        reserved = {"explore", "accounts", "direct", "reels", "stories", "p", "reel", "tv"}
        segments = [segment for segment in path.split("/") if segment]
        return len(segments) == 1 and segments[0] not in reserved
    if platform_key == "youtube":
        return bool(
            re.match(r"^/@[^/]+$", path)
            or re.match(r"^/(?:channel|c|user)/[^/]+$", path)
        )
    return False


def _direct_content_url(platform_key: str, value: Any) -> bool:
    """Reject profile roots and search pages masquerading as direct risk facts."""
    if not _url(value):
        return False
    parsed = urlparse(str(value))
    host = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    query = parse_qs(parsed.query, keep_blank_values=True)
    if platform_key in {"domestic_other", "overseas_other"}:
        if path in {"", "/"}:
            return False
        search_hosts = (
            "google.", "bing.com", "baidu.com", "yahoo.com", "yandex.",
            "duckduckgo.com", "sogou.com", "so.com",
        )
        if any(marker in host for marker in search_hosts):
            return False
        if path.startswith(("/search", "/web/search", "/s/search")):
            return False
        if {"q", "query", "keyword", "wd", "word", "search_query"} & set(query):
            return False
        return True
    if not _platform_url(platform_key, value):
        return False
    if platform_key == "weibo":
        segments = [segment for segment in path.split("/") if segment]
        return bool(
            re.match(r"^/detail/[a-z0-9]{7,}$", path)
            or (
                len(segments) == 2
                and segments[0] not in {"u", "n", "profile", "p", "topic", "tv", "ttarticle"}
                and re.fullmatch(r"[a-z0-9]{7,}", segments[1]) is not None
            )
            or (path == "/ttarticle/p/show" and _first_nonempty_query_value(query, ("id",)) is not None)
            or _path_has_identifier(path, "/tv/show/")
        )
    if platform_key == "bilibili":
        return bool(
            (host.endswith("b23.tv") and path.strip("/"))
            or _path_has_identifier(path, "/video/", "/opus/", "/read/", "/bangumi/play/")
        )
    if platform_key == "douyin":
        return _path_has_identifier(path, "/video/", "/note/")
    if platform_key == "xiaohongshu":
        return _path_has_identifier(path, "/explore/", "/discovery/item/")
    if platform_key == "zhihu":
        return bool(re.match(r"^/question/\d+(?:/answer/\d+)?/?$", path)) or _path_has_identifier(path, "/p/", "/zvideo/", "/pin/")
    if platform_key == "netease_music":
        lowered = str(value).lower()
        return any(marker in lowered for marker in ("/song?", "/mv?", "/video?", "/event?", "#/song?", "#/mv?", "#/video?", "#/event?")) and bool(
            re.search(r"(?:[?&])id=[^&#]+", lowered)
        )
    if platform_key == "tieba":
        return re.match(r"^/p/\d+", path) is not None
    if platform_key == "douban":
        return bool(
            re.match(r"^/(?:subject|note|review)/\d+", path)
            or re.match(r"^/group/topic/\d+", path)
            or re.match(r"^/people/[^/]+/status/\d+", path)
        )
    if platform_key == "x":
        return re.match(r"^/[^/]+/status/\d+", path) is not None
    if platform_key == "facebook":
        return bool(
            re.search(r"/(?:posts|videos)/[^/]+", path)
            or _path_has_identifier(path, "/reel/")
            or (path.rstrip("/") == "/watch" and _first_nonempty_query_value(query, ("v",)) is not None)
            or (path.endswith(("/story.php", "/permalink.php")) and _first_nonempty_query_value(query, ("story_fbid", "fbid")) is not None)
            or (path.endswith("/photo.php") and _first_nonempty_query_value(query, ("fbid",)) is not None)
        )
    if platform_key == "instagram":
        return _path_has_identifier(path, "/p/", "/reel/", "/tv/")
    if platform_key == "youtube":
        return bool(
            (host.endswith("youtu.be") and path.strip("/"))
            or _path_has_identifier(path, "/shorts/", "/live/", "/embed/")
            or (path == "/watch" and _first_nonempty_query_value(query, ("v",)) is not None)
        )
    return False


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _highest_priority_standard_group() -> tuple[str, str]:
    """Read the first explicitly highest-priority row from the live risk standard."""
    text = RISK_STANDARD_PATH.read_text(encoding="utf-8-sig")
    for line in text.splitlines():
        if not line.lstrip().startswith("|") or "最高优先" not in line:
            continue
        cells = [cell.strip().strip("`*") for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 2 and cells[0] and cells[1]:
            return cells[0], cells[1]
    raise ValueError("no explicit highest-priority risk row found")


def _standard_terms_for_group(group: str) -> str:
    """Return the keyword cell for an exact group label in the live standard."""
    text = RISK_STANDARD_PATH.read_text(encoding="utf-8-sig")
    for line in text.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip().strip("`*") for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 2 and cells[0] == group:
            return cells[1]
    return ""


def _standard_term_tokens(cell: str) -> set[str]:
    """Parse a risk-standard keyword cell into complete representative terms."""
    tokens: set[str] = set()
    for raw in re.split(r"[/／；;、，,\n]+", cell):
        cleaned = re.sub(r"[（(][^）)]*[）)]\s*$", "", raw).strip().casefold()
        if cleaned:
            tokens.add(cleaned)
    return tokens


def _exact(value: Any, fields: set[str], prefix: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        errors.append(f"{prefix}: must be an object")
        return {}
    missing = sorted(fields - set(value))
    extra = sorted(set(value) - fields)
    if missing:
        errors.append(f"{prefix}: missing fields: {', '.join(missing)}")
    if extra:
        errors.append(f"{prefix}: unexpected/redundant fields: {', '.join(extra)}")
    return value


def _time(value: Any, prefix: str, errors: list[str]) -> datetime | None:
    if not _text(value):
        errors.append(f"{prefix}: must be a timezone-bearing timestamp")
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        errors.append(f"{prefix}: must be ISO-8601")
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        errors.append(f"{prefix}: must include a timezone")
        return None
    return parsed


def _route_finishes_before(candidate: dict[str, Any], later: dict[str, Any]) -> bool:
    """Make a declared trigger chronologically prior, not merely earlier in JSON."""
    try:
        completed = datetime.fromisoformat(str(candidate.get("completed_at", "")).replace("Z", "+00:00"))
        started = datetime.fromisoformat(str(later.get("started_at", "")).replace("Z", "+00:00"))
    except ValueError:
        return False
    if completed.tzinfo is None or started.tzinfo is None:
        return False
    return completed <= started


def _path(value: Any, prefix: str, errors: list[str]) -> Path | None:
    if not _text(value):
        errors.append(f"{prefix}: must be an absolute evidence path")
        return None
    path = Path(value).resolve(strict=False)
    try:
        path.relative_to(EVIDENCE_ROOT)
    except ValueError:
        errors.append(f"{prefix}: must be under {EVIDENCE_ROOT}")
    return path


def _image_kind(path: Path) -> str | None:
    header = path.read_bytes()[:16]
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if header.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if header.startswith(b"RIFF") and len(header) >= 12 and header[8:12] == b"WEBP":
        return "webp"
    return None


def _string_list(value: Any, prefix: str, errors: list[str], *, nonempty: bool = False) -> list[str]:
    if not isinstance(value, list) or any(not _text(item) for item in value):
        errors.append(f"{prefix}: must be a text list")
        return []
    if nonempty and not value:
        errors.append(f"{prefix}: must not be empty")
    if len(value) != len(set(value)):
        errors.append(f"{prefix}: values must be unique")
    return list(value)


def _validate_subject(payload: dict[str, Any], errors: list[str]) -> tuple[dict[str, Any], set[str], list[dict[str, Any]]]:
    subject = _exact(payload.get("subject"), {
        "display_name", "subject_type", "category", "basic_info", "basic_info_source_urls",
        "report_date", "aliases", "strongest_handle", "user_supplied_homepages", "scope",
    }, "subject", errors)
    for field in ("display_name", "category", "basic_info"):
        if not _text(subject.get(field)):
            errors.append(f"subject.{field}: must be non-empty text")
    if subject.get("subject_type") not in SUBJECT_TYPES:
        errors.append("subject.subject_type: invalid subject type")
    try:
        parsed = date.fromisoformat(str(subject.get("report_date", "")))
        if parsed.isoformat() != subject.get("report_date"):
            raise ValueError
    except ValueError:
        errors.append("subject.report_date: must be a real zero-padded ISO YYYY-MM-DD date")
    aliases = _string_list(subject.get("aliases"), "subject.aliases", errors)
    if not isinstance(subject.get("strongest_handle"), str):
        errors.append("subject.strongest_handle: must be text and may be empty")
    sources = _string_list(subject.get("basic_info_source_urls"), "subject.basic_info_source_urls", errors, nonempty=True)
    for index, source in enumerate(sources):
        if not _url(source) or _placeholder(source):
            errors.append(f"subject.basic_info_source_urls[{index}]: must be a real source URL")
    scope = _exact(subject.get("scope"), {"unit", "included", "excluded"}, "subject.scope", errors)
    if not _text(scope.get("unit")):
        errors.append("subject.scope.unit: must be non-empty text")
    _string_list(scope.get("included"), "subject.scope.included", errors, nonempty=True)
    _string_list(scope.get("excluded"), "subject.scope.excluded", errors)
    supplied = subject.get("user_supplied_homepages")
    if not isinstance(supplied, list):
        errors.append("subject.user_supplied_homepages: must be a list")
        supplied = []
    seen_inputs: set[str] = set()
    for index, row in enumerate(supplied):
        prefix = f"subject.user_supplied_homepages[{index}]"
        row = _exact(row, {"platform_key", "subplatform", "input_url", "canonical_url", "canonicalization_route_id"}, prefix, errors)
        if row.get("platform_key") not in PLATFORMS:
            errors.append(f"{prefix}.platform_key: invalid platform")
        for field in ("subplatform", "canonicalization_route_id"):
            if not isinstance(row.get(field), str):
                errors.append(f"{prefix}.{field}: must be text")
        for field in ("input_url", "canonical_url"):
            if not _url(row.get(field)) or _placeholder(row.get(field)):
                errors.append(f"{prefix}.{field}: must be a real URL")
        if row.get("input_url") in seen_inputs:
            errors.append(f"{prefix}.input_url: values must be unique")
        seen_inputs.add(str(row.get("input_url")))
    return subject, set(sources), supplied


def _validate_accounts(
    payload: dict[str, Any], inventory: set[str], supplied_canonical_urls: set[str],
    errors: list[str],
) -> dict[tuple[str, str], dict[str, str]]:
    accounts = payload.get("accounts")
    if not isinstance(accounts, list):
        errors.append("accounts: must be a list")
        accounts = []
    delivered: dict[tuple[str, str], dict[str, str]] = {}
    seen: set[str] = set()
    seen_suspected_in_slot: set[tuple[str, str]] = set()
    automatic_suspects: dict[tuple[str, str], int] = {}
    supplied_suspect_slots: set[tuple[str, str]] = set()
    for index, row in enumerate(accounts):
        prefix = f"accounts[{index}]"
        row = _exact(row, {
            "platform_key", "subplatform", "subplatform_entry_id", "url", "handle", "status",
            "identity_basis", "source_urls",
        }, prefix, errors)
        key = row.get("platform_key")
        if key not in PLATFORMS:
            errors.append(f"{prefix}.platform_key: invalid platform")
        for field in ("subplatform", "subplatform_entry_id", "handle"):
            if not isinstance(row.get(field), str):
                errors.append(f"{prefix}.{field}: must be text")
        url = row.get("url")
        if not _url(url) or _placeholder(url):
            errors.append(f"{prefix}.url: must be a real URL")
        if url in seen:
            errors.append(f"{prefix}.url: duplicate account URL")
        seen.add(str(url))
        if row.get("status") not in ACCOUNT_STATUSES:
            errors.append(f"{prefix}.status: invalid account status")
        if not _text(row.get("identity_basis")):
            errors.append(f"{prefix}.identity_basis: must be non-empty text")
        source_urls = _string_list(row.get("source_urls"), f"{prefix}.source_urls", errors, nonempty=True)
        for source in source_urls:
            if not _url(source) or _placeholder(source):
                errors.append(f"{prefix}.source_urls: contains an invalid URL")
            elif source not in inventory:
                errors.append(f"{prefix}.source_urls: source missing from coverage.source_inventory: {source}")
        if url not in inventory:
            errors.append(f"{prefix}.url: missing from coverage.source_inventory")
        if row.get("status") in {"confirmed", "suspected_homepage"} and key in PLATFORMS:
            entry_id = str(row.get("subplatform_entry_id", ""))
            if key not in {"domestic_other", "overseas_other"} and entry_id:
                errors.append(f"{prefix}.subplatform_entry_id: named platform account must leave this empty")
            if key in {"domestic_other", "overseas_other"} and not entry_id:
                errors.append(f"{prefix}.subplatform_entry_id: delivered extra-platform account requires an entry id")
            slot = (str(key), entry_id)
            if row.get("status") == "confirmed" and slot in seen_suspected_in_slot:
                errors.append(f"{prefix}.status: confirmed homepages must precede suspected homepages in the same platform module")
            if row.get("status") == "suspected_homepage":
                seen_suspected_in_slot.add(slot)
                if str(url) in supplied_canonical_urls:
                    supplied_suspect_slots.add(slot)
                else:
                    automatic_suspects[slot] = automatic_suspects.get(slot, 0) + 1
            delivered.setdefault(slot, {})[str(url)] = (
                "confirmed" if row.get("status") == "confirmed" else "suspected"
            )
    for slot, count in automatic_suspects.items():
        if count > 1:
            errors.append(f"accounts[{slot[0]}:{slot[1]}]: at most one automatically selected suspected homepage is allowed")
        if slot in supplied_suspect_slots:
            errors.append(f"accounts[{slot[0]}:{slot[1]}]: a user-supplied suspected homepage forbids adding an automatic suspect")
    return delivered


def _validate_module(value: Any, module_key: str, valid_groups: set[str], prefix: str, errors: list[str]) -> tuple[set[str], dict[str, set[str]]]:
    per_url_links: dict[str, set[str]] = {}
    if module_key in HOMEPAGE_MODULES:
        fields = {"status", "urls", "url_risk_group_ids", "risk_group_ids"}
        if module_key in {"homepage", "subject_homepage"}:
            fields.add("url_identity_statuses")
        module = _exact(value, fields, prefix, errors)
        allowed = {"confirmed", "suspected", "not_found"} if "url_identity_statuses" in fields else {"confirmed", "not_found"}
        if module.get("status") not in allowed:
            errors.append(f"{prefix}.status: invalid homepage state")
        urls = _string_list(module.get("urls"), f"{prefix}.urls", errors)
        for url in urls:
            if not _url(url) or _placeholder(url):
                errors.append(f"{prefix}.urls: contains an invalid URL")
        if module.get("status") == "not_found" and urls:
            errors.append(f"{prefix}.urls: not_found must be empty")
        if module.get("status") != "not_found" and not urls:
            errors.append(f"{prefix}.urls: delivered homepage requires a URL")
        identities = module.get("url_identity_statuses")
        if "url_identity_statuses" in fields:
            if not isinstance(identities, dict) or set(identities) != set(urls):
                errors.append(f"{prefix}.url_identity_statuses: keys must equal urls")
            elif any(item not in {"confirmed", "suspected"} for item in identities.values()):
                errors.append(f"{prefix}.url_identity_statuses: invalid value")
            elif module.get("status") == "confirmed" and "confirmed" not in identities.values():
                errors.append(f"{prefix}.status: confirmed requires at least one confirmed URL")
            elif module.get("status") == "suspected" and set(identities.values()) != {"suspected"}:
                errors.append(f"{prefix}.status: suspected requires only suspected URLs")
            elif module.get("status") == "not_found" and identities:
                errors.append(f"{prefix}.url_identity_statuses: not_found must be empty")
            seen_suspected = False
            for url in urls:
                identity = identities.get(url) if isinstance(identities, dict) else None
                if identity == "suspected":
                    seen_suspected = True
                elif identity == "confirmed" and seen_suspected:
                    errors.append(f"{prefix}.urls: all confirmed homepages must precede suspected homepages")
        per_url = module.get("url_risk_group_ids")
        if not isinstance(per_url, dict) or set(per_url) != set(urls):
            errors.append(f"{prefix}.url_risk_group_ids: keys must equal urls")
            per_url = {}
        for url, ids in per_url.items():
            parsed = set(_string_list(ids, f"{prefix}.url_risk_group_ids[{url!r}]", errors))
            if parsed - valid_groups:
                errors.append(f"{prefix}.url_risk_group_ids[{url!r}]: unknown risk group")
            per_url_links[str(url)] = parsed
    elif module_key in SEARCH_MODULES:
        module = _exact(value, {"url", "result_status", "risk_group_ids"}, prefix, errors)
        if not _url(module.get("url")) or _placeholder(module.get("url")):
            errors.append(f"{prefix}.url: must be a real search URL")
        if module.get("result_status") not in {"risk", "no_risk", "no_related_content"}:
            errors.append(f"{prefix}.result_status: invalid delivery state")
        per_url_links[str(module.get("url", ""))] = set()
    else:
        errors.append(f"{prefix}: unsupported module")
        return set(), {}
    ids = set(_string_list(module.get("risk_group_ids"), f"{prefix}.risk_group_ids", errors))
    if ids - valid_groups:
        errors.append(f"{prefix}.risk_group_ids: unknown group")
    if module_key in HOMEPAGE_MODULES:
        per_url_union = set().union(*per_url_links.values()) if per_url_links else set()
        if ids != per_url_union:
            errors.append(f"{prefix}.risk_group_ids: must equal the URL-level risk union")
    if module_key in SEARCH_MODULES:
        if bool(ids) != (module.get("result_status") == "risk"):
            errors.append(f"{prefix}.result_status: must match whether the module has risk groups")
        per_url_links = {str(module.get("url", "")): ids}
    return ids, per_url_links


def _read_targeted_ledger(
    route: dict[str, Any], *, platform_key: str, valid_groups: set[str], check_files: bool,
    prefix: str, errors: list[str],
) -> tuple[list[dict[str, Any]], set[tuple[str, str, str, str]]]:
    rows: list[dict[str, Any]] = []
    risk_refs: set[tuple[str, str, str, str]] = set()
    flagged = route.get("flagged_items")
    if isinstance(flagged, bool) or not isinstance(flagged, int) or flagged < 0:
        errors.append(f"{prefix}.flagged_items: must be a non-negative integer")
        flagged = 0
    path_value = route.get("flagged_item_ledger_path")
    digest = route.get("flagged_item_ledger_sha256")
    if flagged == 0:
        if path_value is not None or digest is not None:
            errors.append(
                f"{prefix}.flagged_item_ledger_path: clean route uses null path/hash; do not create per-item proof"
            )
        return rows, risk_refs
    ledger_path = _path(path_value, f"{prefix}.flagged_item_ledger_path", errors)
    if not isinstance(digest, str) or SHA256_RE.fullmatch(digest) is None:
        errors.append(f"{prefix}.flagged_item_ledger_sha256: must be lowercase SHA-256")
    if not check_files or ledger_path is None:
        return rows, risk_refs
    if not ledger_path.is_file():
        errors.append(f"{prefix}.flagged_item_ledger_path: file does not exist: {ledger_path}")
        return rows, risk_refs
    if SHA256_RE.fullmatch(str(digest)) and _sha256(ledger_path) != digest:
        errors.append(f"{prefix}.flagged_item_ledger_sha256: does not match the flagged-item ledger")
    try:
        for physical_line, line in enumerate(ledger_path.read_text(encoding="utf-8-sig").splitlines(), 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"line {physical_line} is not an object")
            rows.append(row)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        errors.append(f"{prefix}.flagged_item_ledger_path: invalid UTF-8 JSONL: {exc}")
        return [], risk_refs
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    for index, row in enumerate(rows):
        row_prefix = f"{prefix}.selected_items[{index}]"
        validate_targeted_item_review(row, prefix=row_prefix, valid_group_ids=valid_groups, errors=errors)
        if (
            row.get("risk_decision") == "no_risk"
            and not ({"user_risk_lead", "risk_hit", "suspected_signal"} & set(row.get("selection_basis", [])))
        ):
            errors.append(
                f"{row_prefix}: flagged ledger is only for risk, user-lead, or suspected-signal items"
            )
        if row.get("platform_key") != platform_key:
            errors.append(f"{row_prefix}.platform_key: must match route platform {platform_key}")
        if not _url(row.get("url")) or _placeholder(row.get("url")):
            errors.append(f"{row_prefix}.url: must be a real direct URL")
        if row.get("item_id") in seen_ids:
            errors.append(f"{row_prefix}.item_id: duplicate within route")
        if row.get("url") in seen_urls:
            errors.append(f"{row_prefix}.url: duplicate within route")
        seen_ids.add(str(row.get("item_id")))
        seen_urls.add(str(row.get("url")))
        if row.get("risk_decision") == "risk":
            risk_refs.add((platform_key, str(route.get("module_key")), str(row.get("risk_group_id")), str(row.get("url"))))
    if len(rows) != flagged:
        errors.append(f"{prefix}.flagged_items: must equal flagged-item ledger rows")
    return rows, risk_refs


def _ledger_rows_for_cross_check(route: dict[str, Any]) -> list[dict[str, Any]]:
    """Best-effort reread of an already validated flagged ledger.

    The primary ledger validator reports path, hash, JSON and row errors. This
    helper only exposes valid object rows for cross-object lead checks without
    creating another proof requirement.
    """
    path_value = route.get("flagged_item_ledger_path")
    if not _text(path_value):
        return []
    try:
        lines = Path(str(path_value)).read_text(encoding="utf-8-sig").splitlines()
        rows = [json.loads(line) for line in lines if line.strip()]
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError):
        return []
    return [row for row in rows if isinstance(row, dict)]


def _validate_route(
    value: Any, *, platform_key: str, module_keys: set[str], valid_groups: set[str],
    check_files: bool, prefix: str, errors: list[str],
) -> tuple[dict[str, Any], set[tuple[str, str, str, str]]]:
    route = _exact(value, TARGETED_ROUTE_FIELDS, prefix, errors)
    if not _text(route.get("route_id")):
        errors.append(f"{prefix}.route_id: must be non-empty text")
    if route.get("module_key") not in module_keys:
        errors.append(f"{prefix}.module_key: must name a Chapter 4 module in this work unit")
    if not _text(route.get("surface")):
        errors.append(f"{prefix}.surface: must be non-empty text")
    if not _url(route.get("account_or_query_url")) or _placeholder(route.get("account_or_query_url")):
        errors.append(f"{prefix}.account_or_query_url: must be a real URL")
    if not _url(route.get("resolved_url")) or _placeholder(route.get("resolved_url")):
        errors.append(f"{prefix}.resolved_url: must be the real final URL")
    module_key = str(route.get("module_key", ""))
    if not module_key.startswith("subplatform:"):
        for field in ("account_or_query_url", "resolved_url"):
            if _url(route.get(field)) and not _platform_url(platform_key, route.get(field)):
                errors.append(f"{prefix}.{field}: must belong to the declared platform search/homepage")
    tool_kind = route.get("tool_kind")
    if tool_kind not in TOOL_KINDS:
        errors.append(
            f"{prefix}.tool_kind: only an interactive browser UI or a permitted API/export/script route is allowed"
        )
    if tool_kind == "browser_ui":
        for field in ("tool_name", "browser_family"):
            if not _text(route.get(field)):
                errors.append(f"{prefix}.{field}: browser_ui must name the actual persistent desktop browser")
            elif _temporary_browser_identity(route.get(field)):
                errors.append(
                    f"{prefix}.{field}: browser_ui must use a persistent desktop browser, not a Codex/OpenAI/in-app/iab/embedded/builtin/hosted/headless/temporary/ephemeral browser"
                )
        tool_brand = _known_browser_brand(route.get("tool_name"))
        family_brand = _known_browser_brand(route.get("browser_family"))
        if tool_brand and family_brand and tool_brand != family_brand:
            errors.append(f"{prefix}.browser_family: must identify the same desktop browser as tool_name")
    elif tool_kind == "microsoft_edge_visible":
        if route.get("tool_name") != "Microsoft Edge":
            errors.append(f"{prefix}.tool_name: legacy microsoft_edge_visible must equal Microsoft Edge")
        if route.get("browser_family") != "microsoft_edge":
            errors.append(f"{prefix}.browser_family: legacy microsoft_edge_visible must equal microsoft_edge")
    elif tool_kind in TOOL_KINDS:
        for field in ("tool_name", "browser_family"):
            if route.get(field) is not None:
                errors.append(f"{prefix}.{field}: non-browser-UI route must use null")
    if not _text(route.get("executor_id")):
        errors.append(f"{prefix}.executor_id: must identify the human/agent work owner")
    if tool_kind in INTERACTIVE_BROWSER_TOOL_KINDS:
        for field in ("edge_window_continuity_id", "edge_page_continuity_id"):
            if not isinstance(route.get(field), str) or UUID4_RE.fullmatch(route[field]) is None:
                errors.append(
                    f"{prefix}.{field}: interactive browser UI route requires a lowercase UUIDv4 continuity id"
                )
    else:
        for field in ("edge_window_continuity_id", "edge_page_continuity_id"):
            if route.get(field) is not None:
                errors.append(f"{prefix}.{field}: non-browser-UI route must use null")
    status = route.get("status")
    if status not in ROUTE_STATUSES:
        errors.append(f"{prefix}.status: must be targeted_complete, blocked, or failed")
    rule = route.get("selection_rule")
    if rule not in SELECTION_RULES:
        errors.append(f"{prefix}.selection_rule: invalid targeted selection rule")
    query_text = route.get("query_text")
    query_kind = route.get("query_kind")
    query_group = route.get("query_risk_group")
    query_terms = route.get("query_terms")
    if not isinstance(query_text, str):
        errors.append(f"{prefix}.query_text: must be text")
        query_text = ""
    if query_kind not in QUERY_KINDS:
        errors.append(f"{prefix}.query_kind: invalid controlled query kind")
    if not isinstance(query_group, str):
        errors.append(f"{prefix}.query_risk_group: must be text")
        query_group = ""
    if not isinstance(query_terms, list) or any(not _text(term) for term in query_terms):
        errors.append(f"{prefix}.query_terms: must be a text list")
        query_terms = []
    elif len(query_terms) != len(set(query_terms)):
        errors.append(f"{prefix}.query_terms: values must be unique")
    if rule in {
        "homepage_pinned_all_latest20_popular10_historical1_applicable_tabs",
        "homepage_all_public_text_to_natural_end",
        "topic_related_first_30_items",
    }:
        if query_kind != "non_query":
            errors.append(f"{prefix}.query_kind: homepage route requires non_query")
        if query_text or query_group or query_terms:
            errors.append(f"{prefix}.query_text: non-query homepage route requires empty query fields")
        for field in ("account_or_query_url", "resolved_url"):
            if _url(route.get(field)) and not _homepage_or_topic_url(
                platform_key, module_key, route.get(field)
            ):
                errors.append(
                    f"{prefix}.{field}: homepage/topic sample must be a real homepage/topic URL, not a search or content page"
                )
        if (
            rule == "homepage_all_public_text_to_natural_end"
            and route.get("tool_kind") not in (
                INTERACTIVE_BROWSER_TOOL_KINDS | {"official_api", "authorized_export"}
            )
        ):
            errors.append(
                f"{prefix}.tool_kind: full homepage text route allows only an interactive browser UI, official API, or authorized export"
            )
        if (
            rule == "homepage_all_public_text_to_natural_end"
            and module_key not in ACCOUNT_HOMEPAGE_MODULES
            and not module_key.startswith("subplatform:")
        ):
            errors.append(
                f"{prefix}.module_key: full-text natural-end review applies only to an account homepage, not a topic page"
            )
        if (
            rule == "homepage_pinned_all_latest20_popular10_historical1_applicable_tabs"
            and module_key not in ACCOUNT_HOMEPAGE_MODULES
            and not module_key.startswith("subplatform:")
        ):
            errors.append(
                f"{prefix}.module_key: homepage media sample applies only to an account homepage, not a topic page"
            )
        if (
            rule == "topic_related_first_30_items"
            and module_key not in {"topic", "topic_homepage"}
        ):
            errors.append(
                f"{prefix}.module_key: bounded topic review applies only to topic or topic_homepage"
            )
    elif rule == "platform_first_3_pages_or_30_results":
        if query_kind not in {"main_name", "strongest_handle", "alias"}:
            errors.append(f"{prefix}.query_kind: platform search requires main_name, strongest_handle, or alias")
        if not query_text.strip():
            errors.append(f"{prefix}.query_text: name-search route requires the actual submitted query")
        if query_group or query_terms:
            errors.append(f"{prefix}.query_risk_group: name-search route requires empty risk group/terms")
    elif rule == "main_name_first_10_pages":
        if query_kind != "main_name":
            errors.append(f"{prefix}.query_kind: main-name general search requires main_name")
        if not query_text.strip():
            errors.append(f"{prefix}.query_text: name-search route requires the actual submitted query")
        if query_group or query_terms:
            errors.append(f"{prefix}.query_risk_group: name-search route requires empty risk group/terms")
    elif rule == "combined_high_risk_first_3_pages":
        if query_kind != "combined_high_risk":
            errors.append(f"{prefix}.query_kind: combined-risk route requires combined_high_risk")
        if not query_text.strip() or not query_group.strip():
            errors.append(f"{prefix}: combined-risk route requires query_text and query_risk_group")
        if not 2 <= len(query_terms) <= 4:
            errors.append(f"{prefix}.query_terms: combined-risk route requires 2 to 4 representative terms")
        for term in query_terms:
            if term not in query_text:
                errors.append(f"{prefix}.query_text: must contain every representative query term")
    else:
        if query_kind != "targeted_followup":
            errors.append(f"{prefix}.query_kind: targeted follow-up route requires targeted_followup")
        if not query_text and (query_group or query_terms):
            errors.append(f"{prefix}.query_text: direct-page follow-up requires all query fields empty")
        if query_text and query_group and not 1 <= len(query_terms) <= 4:
            errors.append(f"{prefix}.query_terms: risk follow-up query requires 1 to 4 representative terms")
        if query_text and not query_group and query_terms:
            errors.append(f"{prefix}.query_risk_group: query terms require a non-empty risk group")
    if rule in {
        "platform_first_3_pages_or_30_results",
        "main_name_first_10_pages",
        "combined_high_risk_first_3_pages",
    }:
        submitted_query = _search_query_from_url(platform_key, route.get("account_or_query_url"))
        if submitted_query is None:
            errors.append(f"{prefix}.account_or_query_url: required search route must expose its native query")
        elif submitted_query != query_text:
            errors.append(
                f"{prefix}.query_text: must equal the query decoded from account_or_query_url"
            )
        if status == "targeted_complete":
            resolved_query = _search_query_from_url(platform_key, route.get("resolved_url"))
            if resolved_query != query_text:
                errors.append(
                    f"{prefix}.resolved_url: completed search route must preserve the same decoded query"
                )
    stop_reason = route.get("scope_stop_reason")
    if stop_reason not in SCOPE_STOP_REASONS:
        errors.append(f"{prefix}.scope_stop_reason: invalid controlled stop reason")
    pages = route.get("pages_checked")
    if isinstance(pages, bool) or not isinstance(pages, int) or pages < 0:
        errors.append(f"{prefix}.pages_checked: must be a non-negative integer")
        pages = 0
    selected = route.get("items_selected")
    reviewed = route.get("items_reviewed")
    for field, number in (("items_selected", selected), ("items_reviewed", reviewed)):
        if isinstance(number, bool) or not isinstance(number, int) or number < 0:
            errors.append(f"{prefix}.{field}: must be a non-negative integer")
    if isinstance(selected, int) and isinstance(reviewed, int) and selected != reviewed:
        errors.append(f"{prefix}: items_selected must equal items_reviewed")
    flagged = route.get("flagged_items")
    if isinstance(flagged, bool) or not isinstance(flagged, int) or flagged < 0:
        errors.append(f"{prefix}.flagged_items: must be a non-negative integer")
    elif isinstance(reviewed, int) and flagged > reviewed:
        errors.append(f"{prefix}.flagged_items: cannot exceed items_reviewed")
    started = _time(route.get("started_at"), f"{prefix}.started_at", errors)
    completed = _time(route.get("completed_at"), f"{prefix}.completed_at", errors)
    if started and completed and completed < started:
        errors.append(f"{prefix}: completed_at must not precede started_at")
    resolvers = _string_list(route.get("resolved_by_route_ids"), f"{prefix}.resolved_by_route_ids", errors)
    if status == "targeted_complete":
        if route.get("termination") != "target_scope_complete":
            errors.append(f"{prefix}.termination: targeted completion requires target_scope_complete")
        if route.get("minimum_scope_met") is not True:
            errors.append(f"{prefix}.minimum_scope_met: targeted completion requires true")
        if route.get("boundary") != "":
            errors.append(f"{prefix}.boundary: completed route must be empty")
        if resolvers:
            errors.append(f"{prefix}.resolved_by_route_ids: completed route must be empty")
        if stop_reason in {"access_boundary", "route_failed"}:
            errors.append(f"{prefix}.scope_stop_reason: completed route cannot claim an access/failure boundary")
    elif status in {"blocked", "failed"}:
        if route.get("termination") not in {"login_required", "verification_required", "access_blocked", "route_failed"}:
            errors.append(f"{prefix}.termination: blocked/failed route must state its boundary type")
        if route.get("minimum_scope_met") is not False:
            errors.append(f"{prefix}.minimum_scope_met: blocked/failed route must be false")
        if not _text(route.get("boundary")):
            errors.append(f"{prefix}.boundary: blocked/failed route must describe the exact boundary")
        if not resolvers:
            errors.append(f"{prefix}.resolved_by_route_ids: final payload must resolve every blocked/failed route")
        expected_stop = "access_boundary" if status == "blocked" else "route_failed"
        if stop_reason != expected_stop:
            errors.append(f"{prefix}.scope_stop_reason: {status} route requires {expected_stop}")
    if not isinstance(route.get("minimum_scope_met"), bool):
        errors.append(f"{prefix}.minimum_scope_met: must be boolean")

    if rule == "platform_first_3_pages_or_30_results":
        if not 1 <= pages <= 3:
            errors.append(f"{prefix}.pages_checked: platform search must stop within the first 3 pages")
        if isinstance(selected, int) and selected > 30:
            errors.append(f"{prefix}.items_selected: platform search target is at most 30 results")
        if status == "targeted_complete" and not (
            (pages == 3 and stop_reason == "page_limit")
            or (selected == 30 and stop_reason == "item_limit")
            or (pages < 3 and stop_reason == "results_exhausted_early")
        ):
            errors.append(
                f"{prefix}.scope_stop_reason: platform search needs page_limit at 3 pages, "
                "item_limit at 30 items, or results_exhausted_early"
            )
    elif rule == "main_name_first_10_pages":
        if not 1 <= pages <= 10:
            errors.append(f"{prefix}.pages_checked: main-name general search must stop within the first 10 pages")
        if status == "targeted_complete" and not (
            (pages == 10 and stop_reason == "page_limit")
            or (pages < 10 and stop_reason == "results_exhausted_early")
        ):
            errors.append(f"{prefix}.scope_stop_reason: main-name search requires page_limit at 10 or early exhaustion")
    elif rule == "combined_high_risk_first_3_pages":
        if not 1 <= pages <= 3:
            errors.append(f"{prefix}.pages_checked: combined-risk general search must stop within the first 3 pages")
        if status == "targeted_complete" and not (
            (pages == 3 and stop_reason == "page_limit")
            or (pages < 3 and stop_reason == "results_exhausted_early")
        ):
            errors.append(f"{prefix}.scope_stop_reason: combined-risk search requires page_limit at 3 or early exhaustion")
    elif rule == "homepage_pinned_all_latest20_popular10_historical1_applicable_tabs":
        if pages < 1:
            errors.append(f"{prefix}.pages_checked: homepage review must record at least one opened page")
        if status == "targeted_complete" and stop_reason != "scope_sample_complete":
            errors.append(f"{prefix}.scope_stop_reason: homepage review requires scope_sample_complete")
    elif rule == "homepage_all_public_text_to_natural_end":
        if pages < 1:
            errors.append(f"{prefix}.pages_checked: full homepage text review must record at least one opened page")
        if status == "targeted_complete" and stop_reason not in {
            "natural_end", "cursor_exhausted", "empty_timeline",
        }:
            errors.append(
                f"{prefix}.scope_stop_reason: full homepage text review requires natural_end, cursor_exhausted, or empty_timeline"
            )
        if status == "targeted_complete" and stop_reason == "empty_timeline":
            if selected != 0 or reviewed != 0:
                errors.append(
                    f"{prefix}: empty_timeline requires items_selected == items_reviewed == 0"
                )
        elif status == "targeted_complete" and stop_reason in {"natural_end", "cursor_exhausted"}:
            if (
                isinstance(selected, bool) or not isinstance(selected, int) or selected < 1
                or isinstance(reviewed, bool) or not isinstance(reviewed, int) or reviewed < 1
            ):
                errors.append(
                    f"{prefix}: natural_end/cursor_exhausted requires items_selected == items_reviewed >= 1"
                )
    elif rule == "topic_related_first_30_items":
        if pages < 1:
            errors.append(f"{prefix}.pages_checked: bounded topic review must record at least one opened page")
        if isinstance(selected, int) and not isinstance(selected, bool) and selected > 30:
            errors.append(f"{prefix}.items_selected: bounded topic review permits at most 30 related items")
        if status == "targeted_complete" and not (
            (selected == 30 and stop_reason == "item_limit")
            or (
                isinstance(selected, int) and not isinstance(selected, bool)
                and selected < 30 and stop_reason == "results_exhausted_early"
            )
        ):
            errors.append(
                f"{prefix}.scope_stop_reason: bounded topic review needs item_limit at 30 items or results_exhausted_early below 30"
            )
    elif rule in {"user_risk_lead_targeted", "identity_resolution_targeted", "risk_context_followup"}:
        if pages < 1:
            errors.append(f"{prefix}.pages_checked: targeted follow-up must open at least one page")
        if status == "targeted_complete" and stop_reason != "target_resolved":
            errors.append(f"{prefix}.scope_stop_reason: targeted follow-up requires target_resolved")

    _rows, risk_refs = _read_targeted_ledger(
        route, platform_key=platform_key, valid_groups=valid_groups, check_files=check_files,
        prefix=prefix, errors=errors,
    )
    return route, risk_refs


def _validate_completion(
    value: Any, *, platform_key: str, module_keys: set[str], valid_groups: set[str],
    declared_risks: set[str], check_files: bool, prefix: str, errors: list[str],
    require_browser_ui_visit: bool = False, required_module_keys: set[str] | None = None,
) -> tuple[list[dict[str, Any]], set[tuple[str, str, str, str]]]:
    completion = _exact(value, {"status", "scope_conclusion", "route_results", "completion_note"}, prefix, errors)
    if completion.get("status") != "targeted_complete":
        errors.append(f"{prefix}.status: final targeted handoff requires targeted_complete")
    expected_conclusion = "risk_found" if declared_risks else "no_risk_in_targeted_scope"
    if completion.get("scope_conclusion") != expected_conclusion:
        errors.append(f"{prefix}.scope_conclusion: expected {expected_conclusion}")
    if not _text(completion.get("completion_note")):
        errors.append(f"{prefix}.completion_note: must state the bounded scope actually reviewed")
    route_values = completion.get("route_results")
    if not isinstance(route_values, list) or not route_values:
        errors.append(f"{prefix}.route_results: must be a non-empty list")
        route_values = []
    routes: list[dict[str, Any]] = []
    risk_refs: set[tuple[str, str, str, str]] = set()
    for index, route_value in enumerate(route_values):
        route, refs = _validate_route(
            route_value, platform_key=platform_key, module_keys=module_keys,
            valid_groups=valid_groups, check_files=check_files,
            prefix=f"{prefix}.route_results[{index}]", errors=errors,
        )
        routes.append(route)
        risk_refs.update(refs)
    completed_browser_ui_modules = {
        str(route.get("module_key"))
        for route in routes
        if route.get("status") == "targeted_complete"
        and route.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
    }
    required = module_keys if required_module_keys is None else required_module_keys
    missing_modules = sorted(required - completed_browser_ui_modules)
    if missing_modules:
        errors.append(
            f"{prefix}.route_results: target scope not closed by an interactive browser UI for modules: "
            f"{', '.join(missing_modules)}"
        )
    if require_browser_ui_visit and not any(
        route.get("status") == "targeted_complete"
        and route.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
        for route in routes
    ):
        errors.append(
            f"{prefix}.route_results: this platform work unit requires a completed interactive browser UI visit"
        )
    for module_key in module_keys:
        completed_for_module = [
            route for route in routes
            if route.get("status") == "targeted_complete"
            and route.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
            and route.get("module_key") == module_key
        ]
        if module_key == "baidu_search" or module_key == "google_search":
            rules = {route.get("selection_rule") for route in completed_for_module}
            required = {"main_name_first_10_pages", "combined_high_risk_first_3_pages"}
            if not required <= rules:
                errors.append(
                    f"{prefix}.route_results: {module_key} requires main-name and combined-high-risk bounded routes"
                )
    return routes, risk_refs


def _validate_risks(payload: dict[str, Any], check_files: bool, errors: list[str]) -> tuple[set[str], list[dict[str, Any]]]:
    groups = payload.get("risk_groups")
    if not isinstance(groups, list):
        errors.append("risk_groups: must be a list")
        groups = []
    ids = [group.get("id") for group in groups if isinstance(group, dict) and _text(group.get("id"))]
    if len(ids) != len(groups):
        errors.append("risk_groups: every group requires an id")
    if len(ids) != len(set(ids)):
        errors.append("risk_groups: ids must be unique")
    if payload.get("risk_summary_order") != ids:
        errors.append("risk_summary_order: must equal risk group ids in exact order")
    valid = set(ids)
    screenshots: dict[str, set[tuple[str, str]]] = {}
    instances: list[dict[str, Any]] = []
    for group_index, group_value in enumerate(groups):
        prefix = f"risk_groups[{group_index}]"
        group = _exact(group_value, {"id", "title", "category", "summary", "explanation", "instances"}, prefix, errors)
        for field in ("title", "category", "summary", "explanation"):
            if not _text(group.get(field)):
                errors.append(f"{prefix}.{field}: must be non-empty text")
        rows = group.get("instances")
        if not isinstance(rows, list) or not rows:
            errors.append(f"{prefix}.instances: must be a non-empty list")
            rows = []
        for index, row_value in enumerate(rows):
            row_prefix = f"{prefix}.instances[{index}]"
            row = _exact(row_value, {
                "platform_key", "subplatform", "module_targets", "published_at", "finding",
                "source_url", "source_type", "screenshots",
            }, row_prefix, errors)
            if row.get("platform_key") not in PLATFORMS:
                errors.append(f"{row_prefix}.platform_key: invalid platform")
            if not isinstance(row.get("subplatform"), str):
                errors.append(f"{row_prefix}.subplatform: must be text")
            for field in ("published_at", "finding", "source_type"):
                if not _text(row.get(field)):
                    errors.append(f"{row_prefix}.{field}: must be non-empty text")
            if not _url(row.get("source_url")) or _placeholder(row.get("source_url")):
                errors.append(f"{row_prefix}.source_url: must be a real direct URL")
            targets = row.get("module_targets")
            if not isinstance(targets, list) or not targets:
                errors.append(f"{row_prefix}.module_targets: must be a non-empty list")
                targets = []
            parsed_targets: list[tuple[str, str]] = []
            for target_index, target_value in enumerate(targets):
                target_prefix = f"{row_prefix}.module_targets[{target_index}]"
                target = _exact(target_value, {"module_key", "module_url"}, target_prefix, errors)
                if not _text(target.get("module_key")):
                    errors.append(f"{target_prefix}.module_key: must be non-empty text")
                if not _url(target.get("module_url")) or _placeholder(target.get("module_url")):
                    errors.append(f"{target_prefix}.module_url: must be a real module URL")
                parsed_targets.append((str(target.get("module_key")), str(target.get("module_url"))))
            if len(parsed_targets) != len(set(parsed_targets)):
                errors.append(f"{row_prefix}.module_targets: values must be unique")
            shots = row.get("screenshots")
            if not isinstance(shots, list) or not shots:
                errors.append(f"{row_prefix}.screenshots: every found risk requires a screenshot")
                shots = []
            for shot_index, shot_value in enumerate(shots):
                shot_prefix = f"{row_prefix}.screenshots[{shot_index}]"
                shot = _exact(shot_value, {"path", "caption", "platform_label", "visible_text", "sha256"}, shot_prefix, errors)
                for field in ("path", "caption", "platform_label", "visible_text", "sha256"):
                    if not _text(shot.get(field)):
                        errors.append(f"{shot_prefix}.{field}: must be non-empty text")
                path = _path(shot.get("path"), f"{shot_prefix}.path", errors)
                digest = shot.get("sha256")
                if not isinstance(digest, str) or SHA256_RE.fullmatch(digest) is None:
                    errors.append(f"{shot_prefix}.sha256: must be lowercase SHA-256")
                if path is not None:
                    screenshots.setdefault(str(path).lower(), set()).add((str(row.get("platform_key")), str(row.get("source_url"))))
                    if path.suffix.lower() not in IMAGE_EXTENSIONS:
                        errors.append(f"{shot_prefix}.path: unsupported image extension")
                    if check_files:
                        if not path.is_file():
                            errors.append(f"{shot_prefix}.path: file does not exist: {path}")
                        else:
                            if path.stat().st_size > MAX_IMAGE_BYTES:
                                errors.append(f"{shot_prefix}.path: image exceeds 20 MB")
                            if _image_kind(path) is None:
                                errors.append(f"{shot_prefix}.path: invalid image signature")
                            if SHA256_RE.fullmatch(str(digest)) and _sha256(path) != digest:
                                errors.append(f"{shot_prefix}.sha256: does not match screenshot")
            instances.append({"group_id": group.get("id"), **row, "parsed_targets": parsed_targets})
    for path, contexts in screenshots.items():
        if len(contexts) > 1:
            errors.append(f"screenshots: one file is reused across risk contexts: {path}")
    return valid, instances


def validate(payload: Any, *, check_files: bool = True) -> list[str]:
    errors: list[str] = []
    if not check_files:
        errors.append("delivery_proof: structure-only diagnosis cannot authorize delivery")
    if not isinstance(payload, dict):
        return ["payload: must be a JSON object"]
    top = {
        "schema_version", "research_profile", "subject", "verdict", "accounts",
        "representative_works", "risk_summary_order", "risk_groups", "platforms",
        "coverage", "qa",
    }
    _exact(payload, top, "payload", errors)
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version: targeted profile requires {SCHEMA_VERSION}")
    if payload.get("research_profile") != RESEARCH_PROFILE:
        errors.append(f"research_profile: must equal {RESEARCH_PROFILE}")

    subject, basic_sources, supplied = _validate_subject(payload, errors)
    valid_groups, risk_instances = _validate_risks(payload, check_files, errors)
    verdict = _exact(payload.get("verdict"), {"has_risk", "result_level", "overall_conclusion"}, "verdict", errors)
    if not isinstance(verdict.get("has_risk"), bool):
        errors.append("verdict.has_risk: must be boolean")
    if verdict.get("has_risk") != bool(valid_groups):
        errors.append("verdict.has_risk: must equal whether risk_groups is non-empty")
    if verdict.get("result_level") not in RESULT_LEVELS:
        errors.append("verdict.result_level: invalid tier")
    if valid_groups and verdict.get("result_level") == "无合作风险":
        errors.append("verdict.result_level: risk payload cannot be 无合作风险")
    if not valid_groups and verdict.get("result_level") != "无合作风险":
        errors.append("verdict.result_level: no-risk payload must be 无合作风险")
    if not _text(verdict.get("overall_conclusion")):
        errors.append("verdict.overall_conclusion: must be non-empty text")

    coverage = _exact(payload.get("coverage"), {
        "started_at", "completed_at", "user_risk_leads", "search_engines_checked",
        "source_inventory", "pending_cross_platform_leads", "target_scope",
    }, "coverage", errors)
    coverage_started = _time(coverage.get("started_at"), "coverage.started_at", errors)
    coverage_completed = _time(coverage.get("completed_at"), "coverage.completed_at", errors)
    if coverage_started and coverage_completed and coverage_completed < coverage_started:
        errors.append("coverage.completed_at: must not precede started_at")
    if coverage.get("target_scope") != TARGET_SCOPE:
        errors.append("coverage.target_scope: must equal the three_hour_targeted_v1 limits")
    engines = _string_list(coverage.get("search_engines_checked"), "coverage.search_engines_checked", errors)
    if set(engines) != {"baidu", "google"}:
        errors.append("coverage.search_engines_checked: must contain exactly baidu and google")
    inventory_list = _string_list(coverage.get("source_inventory"), "coverage.source_inventory", errors, nonempty=True)
    inventory = set(inventory_list)
    for index, url in enumerate(inventory_list):
        if not _url(url) or _placeholder(url):
            errors.append(f"coverage.source_inventory[{index}]: must be a real URL")
    if basic_sources - inventory:
        errors.append("subject.basic_info_source_urls: every URL must appear in coverage.source_inventory")
    if coverage.get("pending_cross_platform_leads") != []:
        errors.append("coverage.pending_cross_platform_leads: must be empty before delivery")

    supplied_canonical_urls = {
        str(row.get("canonical_url"))
        for row in supplied
        if isinstance(row, dict) and _url(row.get("canonical_url"))
    }
    delivered = _validate_accounts(payload, inventory, supplied_canonical_urls, errors)
    works = payload.get("representative_works")
    if not isinstance(works, list):
        errors.append("representative_works: must be a list")
        works = []
    for index, work_value in enumerate(works):
        prefix = f"representative_works[{index}]"
        work = _exact(work_value, {"title", "role", "client_or_publisher", "source_url", "notes"}, prefix, errors)
        if not _text(work.get("title")):
            errors.append(f"{prefix}.title: must be non-empty text")
        for field in ("role", "client_or_publisher", "notes"):
            if not isinstance(work.get(field), str):
                errors.append(f"{prefix}.{field}: must be text")
        if not _url(work.get("source_url")) or _placeholder(work.get("source_url")):
            errors.append(f"{prefix}.source_url: must be a real URL")
        elif work.get("source_url") not in inventory:
            errors.append(f"{prefix}.source_url: missing from coverage.source_inventory")

    platforms = payload.get("platforms")
    if not isinstance(platforms, dict):
        errors.append("platforms: must be an object")
        platforms = {}
    if set(platforms) != set(PLATFORMS):
        missing = sorted(set(PLATFORMS) - set(platforms))
        extra = sorted(set(platforms) - set(PLATFORMS))
        if missing:
            errors.append(f"platforms: missing mandatory platforms: {', '.join(missing)}")
        if extra:
            errors.append(f"platforms: unexpected platforms: {', '.join(extra)}")

    all_routes: dict[str, tuple[str, dict[str, Any]]] = {}
    all_risk_refs: set[tuple[str, str, str, str]] = set()
    module_links: dict[tuple[str, str, str], set[str]] = {}
    platform_links: dict[str, set[str]] = {}
    extra_names: dict[tuple[str, str], str] = {}
    for key in PLATFORMS:
        prefix = f"platforms.{key}"
        fields = {"display_name", "discovery_status", "risk_group_ids", "subplatforms", "delivery_modules", "research_completion"}
        if key in OTHER_TAIL_STATEMENTS:
            fields.add("other_platform_tail")
        record = _exact(platforms.get(key), fields, prefix, errors)
        if record.get("display_name") != PLATFORM_DISPLAY[key]:
            errors.append(f"{prefix}.display_name: must equal {PLATFORM_DISPLAY[key]}")
        if record.get("discovery_status") not in DISCOVERY_STATUSES:
            errors.append(f"{prefix}.discovery_status: invalid targeted discovery state")
        record_ids = set(_string_list(record.get("risk_group_ids"), f"{prefix}.risk_group_ids", errors))
        if record_ids - valid_groups:
            errors.append(f"{prefix}.risk_group_ids: unknown risk group")
        platform_links[key] = record_ids
        modules = record.get("delivery_modules")
        if not isinstance(modules, dict):
            errors.append(f"{prefix}.delivery_modules: must be an object")
            modules = {}
        if set(modules) != set(DELIVERY_MODULES[key]):
            errors.append(f"{prefix}.delivery_modules: must contain the exact Chapter 4 modules")
        module_union: set[str] = set()
        module_keys: set[str] = set()
        for module_key in DELIVERY_MODULES[key]:
            if module_key == "review_start_month":
                month = modules.get(module_key)
                home = modules.get("homepage", {})
                if isinstance(home, dict) and home.get("urls"):
                    if not isinstance(month, str) or re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", month) is None:
                        errors.append(f"{prefix}.delivery_modules.review_start_month: homepage requires YYYY-MM")
                elif month is not None:
                    errors.append(f"{prefix}.delivery_modules.review_start_month: no homepage requires null")
                continue
            module_keys.add(module_key)
            ids, per_url = _validate_module(
                modules.get(module_key), module_key, valid_groups,
                f"{prefix}.delivery_modules.{module_key}", errors,
            )
            module_union.update(ids)
            for url, url_ids in per_url.items():
                module_links[(key, module_key, url)] = url_ids
                if url and url not in inventory:
                    errors.append(f"{prefix}.delivery_modules.{module_key}: module URL missing from source inventory")
                if url and not _platform_url(key, url):
                    errors.append(f"{prefix}.delivery_modules.{module_key}: URL must belong to this platform")
        subplatforms = record.get("subplatforms")
        if not isinstance(subplatforms, list):
            errors.append(f"{prefix}.subplatforms: must be a list")
            subplatforms = []
        if key not in {"domestic_other", "overseas_other"} and subplatforms:
            errors.append(f"{prefix}.subplatforms: named platform must be empty")
        sub_union: set[str] = set()
        for sub_index, sub_value in enumerate(subplatforms):
            sub_prefix = f"{prefix}.subplatforms[{sub_index}]"
            sub = _exact(sub_value, {"entry_id", "name", "homepage", "research_completion"}, sub_prefix, errors)
            if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", str(sub.get("entry_id", ""))):
                errors.append(f"{sub_prefix}.entry_id: invalid stable id")
            if not _text(sub.get("name")):
                errors.append(f"{sub_prefix}.name: must be non-empty text")
            module_key = f"subplatform:{sub.get('entry_id')}"
            ids, per_url = _validate_module(sub.get("homepage"), "homepage", valid_groups, f"{sub_prefix}.homepage", errors)
            homepage_value = sub.get("homepage") if isinstance(sub.get("homepage"), dict) else {}
            homepage_urls = homepage_value.get("urls") if isinstance(homepage_value.get("urls"), list) else []
            if homepage_value.get("status") == "not_found" or len(homepage_urls) != 1:
                errors.append(
                    f"{sub_prefix}.homepage: an included extra platform requires exactly one delivered homepage URL"
                )
            sub_union.update(ids)
            for url, url_ids in per_url.items():
                module_links[(key, module_key, url)] = url_ids
                if url not in inventory:
                    errors.append(f"{sub_prefix}.homepage: URL missing from source inventory")
            routes, refs = _validate_completion(
                sub.get("research_completion"), platform_key=key, module_keys={module_key},
                valid_groups=valid_groups, declared_risks=ids, check_files=check_files,
                prefix=f"{sub_prefix}.research_completion", errors=errors, require_browser_ui_visit=True,
                required_module_keys={module_key},
            )
            for homepage_url in homepage_urls:
                if not any(
                    route.get("status") == "targeted_complete"
                    and route.get("module_key") == module_key
                    and route.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
                    and route.get("selection_rule") == "homepage_pinned_all_latest20_popular10_historical1_applicable_tabs"
                    and route.get("account_or_query_url") == homepage_url
                    and route.get("resolved_url") == homepage_url
                    for route in routes
                ):
                    errors.append(
                        f"{sub_prefix}.research_completion.route_results: extra homepage URL requires its own exact interactive browser UI sample route: {homepage_url}"
                    )
                if not any(
                    route.get("status") == "targeted_complete"
                    and route.get("module_key") == module_key
                    and route.get("tool_kind") in (
                        INTERACTIVE_BROWSER_TOOL_KINDS | {"official_api", "authorized_export"}
                    )
                    and route.get("selection_rule") == "homepage_all_public_text_to_natural_end"
                    and route.get("account_or_query_url") == homepage_url
                    and route.get("resolved_url") == homepage_url
                    for route in routes
                ):
                    errors.append(
                        f"{sub_prefix}.research_completion.route_results: extra-platform account homepage URL requires its own completed all-public-post-text route to a natural endpoint: {homepage_url}"
                    )
            for route in routes:
                rid = str(route.get("route_id", ""))
                if rid in all_routes:
                    errors.append(f"{sub_prefix}.research_completion.route_results: duplicate route_id {rid}")
                all_routes[rid] = (key, route)
            all_risk_refs.update(refs)
            extra_names[(key, str(sub.get("entry_id")))] = str(sub.get("name"))
            delivered_slot = delivered.get((key, str(sub.get("entry_id"))), {})
            if list(homepage_value.get("urls", [])) != list(delivered_slot):
                errors.append(f"{sub_prefix}.homepage.urls: must preserve delivered account order for this entry")
            if homepage_value.get("url_identity_statuses") != delivered_slot:
                errors.append(f"{sub_prefix}.homepage.url_identity_statuses: must equal account records")
        if record_ids != module_union | sub_union:
            errors.append(f"{prefix}.risk_group_ids: must equal module and subplatform risk union")
        required_module_keys = {
            module_key
            for module_key in module_keys
            if module_key in SEARCH_MODULES
            or (
                isinstance(modules.get(module_key), dict)
                and modules[module_key].get("status") != "not_found"
            )
        }
        routes, refs = _validate_completion(
            record.get("research_completion"), platform_key=key, module_keys=module_keys,
            valid_groups=valid_groups, declared_risks=record_ids, check_files=check_files,
            prefix=f"{prefix}.research_completion", errors=errors, require_browser_ui_visit=True,
            required_module_keys=required_module_keys,
        )
        display_name = str(subject.get("display_name", ""))
        strongest_handle = str(subject.get("strongest_handle", ""))
        if key not in {"domestic_other", "overseas_other"}:
            native_search_routes = [
                route for route in routes
                if route.get("status") == "targeted_complete"
                and route.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
                and route.get("module_key") == "keyword_search"
                and route.get("selection_rule") == "platform_first_3_pages_or_30_results"
            ]
            if not any(
                route.get("query_kind") == "main_name" and route.get("query_text") == display_name
                for route in native_search_routes
            ):
                errors.append(
                    f"{prefix}.research_completion.route_results: keyword_search requires the exact main-name query"
                )
            normalized_name = display_name.strip().removeprefix("@").casefold()
            normalized_handle = strongest_handle.strip().removeprefix("@").casefold()
            if strongest_handle.strip() and normalized_handle != normalized_name and not any(
                route.get("query_kind") == "strongest_handle"
                and route.get("query_text") == strongest_handle
                for route in native_search_routes
            ):
                errors.append(
                    f"{prefix}.research_completion.route_results: keyword_search requires the exact strongest-handle query"
                )
            aliases = {
                str(alias) for alias in subject.get("aliases", [])
                if isinstance(alias, str) and alias.strip()
            }
            for route_index, route in enumerate(routes):
                if route.get("query_kind") != "alias":
                    continue
                if route.get("query_text") not in aliases:
                    errors.append(
                        f"{prefix}.research_completion.route_results: alias query_text must be an exact subject.aliases value"
                    )
                if (
                    route.get("tool_kind") not in INTERACTIVE_BROWSER_TOOL_KINDS
                    or route.get("status") != "targeted_complete"
                ):
                    errors.append(
                        f"{prefix}.research_completion.route_results: alias search must be a completed interactive browser UI route"
                    )
                prior_routes = routes[:route_index]
                no_result_primary = any(
                    candidate.get("status") == "targeted_complete"
                    and candidate.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
                    and candidate.get("module_key") == "keyword_search"
                    and candidate.get("query_kind") in {"main_name", "strongest_handle"}
                    and candidate.get("items_selected") == 0
                    and candidate.get("scope_stop_reason") == "results_exhausted_early"
                    and _route_finishes_before(candidate, route)
                    for candidate in prior_routes
                )
                contextual_trigger = any(
                    candidate.get("status") == "targeted_complete"
                    and candidate.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
                    and candidate.get("module_key") == route.get("module_key")
                    and candidate.get("surface") == route.get("surface")
                    and candidate.get("selection_rule") in {
                        "identity_resolution_targeted", "user_risk_lead_targeted",
                    }
                    and _route_finishes_before(candidate, route)
                    for candidate in prior_routes
                )
                if not (no_result_primary or contextual_trigger):
                    errors.append(
                        f"{prefix}.research_completion.route_results: alias search requires a prior empty primary search or identity/user-lead trigger"
                    )
        else:
            general_routes = [
                route for route in routes
                if route.get("status") == "targeted_complete"
                and route.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
            ]
            if not any(
                route.get("selection_rule") == "main_name_first_10_pages"
                and route.get("query_kind") == "main_name"
                and route.get("query_text") == display_name
                for route in general_routes
            ):
                errors.append(f"{prefix}.research_completion.route_results: general search requires exact main-name query")
            if not any(
                route.get("selection_rule") == "combined_high_risk_first_3_pages"
                and display_name in str(route.get("query_text", ""))
                for route in general_routes
            ):
                errors.append(f"{prefix}.research_completion.route_results: combined-risk query must include the subject name")
        for homepage_key in required_module_keys & HOMEPAGE_MODULES:
            homepage_value = modules.get(homepage_key)
            homepage_urls = (
                homepage_value.get("urls", []) if isinstance(homepage_value, dict) else []
            )
            for homepage_url in homepage_urls:
                required_visible_rule = (
                    "homepage_pinned_all_latest20_popular10_historical1_applicable_tabs"
                    if homepage_key in ACCOUNT_HOMEPAGE_MODULES
                    else "topic_related_first_30_items"
                )
                if not any(
                    route.get("status") == "targeted_complete"
                    and route.get("module_key") == homepage_key
                    and route.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
                    and route.get("selection_rule") == required_visible_rule
                    and route.get("account_or_query_url") == homepage_url
                    and route.get("resolved_url") == homepage_url
                    for route in routes
                ):
                    errors.append(
                        f"{prefix}.research_completion.route_results: {homepage_key} URL requires its own exact interactive browser UI route using {required_visible_rule}: {homepage_url}"
                    )
                if homepage_key in ACCOUNT_HOMEPAGE_MODULES:
                    if not any(
                        route.get("status") == "targeted_complete"
                        and route.get("module_key") == homepage_key
                        and route.get("tool_kind") in (
                            INTERACTIVE_BROWSER_TOOL_KINDS | {"official_api", "authorized_export"}
                        )
                        and route.get("selection_rule") == "homepage_all_public_text_to_natural_end"
                        and route.get("account_or_query_url") == homepage_url
                        and route.get("resolved_url") == homepage_url
                        for route in routes
                    ):
                        errors.append(
                            f"{prefix}.research_completion.route_results: account homepage URL requires its own completed all-public-post-text route to a natural endpoint: {homepage_url}"
                        )
        for module_key in module_keys & SEARCH_MODULES:
            module_value = modules.get(module_key)
            if isinstance(module_value, dict) and module_value.get("result_status") == "no_risk":
                reviewed_for_module = sum(
                    route.get("items_reviewed", 0)
                    for route in routes
                    if route.get("status") == "targeted_complete" and route.get("module_key") == module_key
                    and isinstance(route.get("items_reviewed"), int)
                )
                if reviewed_for_module < 1:
                    errors.append(
                        f"{prefix}.delivery_modules.{module_key}.result_status: no_risk requires at least one reviewed relevant item"
                    )
        for route in routes:
            rid = str(route.get("route_id", ""))
            if rid in all_routes:
                errors.append(f"{prefix}.research_completion.route_results: duplicate route_id {rid}")
            all_routes[rid] = (key, route)
        all_risk_refs.update(refs)
        if key in OTHER_TAIL_STATEMENTS and record.get("other_platform_tail") != OTHER_TAIL_STATEMENTS[key]:
            errors.append(f"{prefix}.other_platform_tail: must match the fixed Chapter 4 sentence")

        named_accounts = delivered.get((key, ""), {}) if key not in {"domestic_other", "overseas_other"} else {}
        if key not in {"domestic_other", "overseas_other"}:
            account_module = modules.get("subject_homepage" if key == "douban" else "homepage", {})
            if isinstance(account_module, dict):
                module_urls = account_module.get("urls", [])
                if list(module_urls) != list(named_accounts):
                    errors.append(f"{prefix}: homepage module URLs must preserve delivered account order")
                if account_module.get("url_identity_statuses") != named_accounts:
                    errors.append(f"{prefix}: homepage identity statuses must equal account records")
        has_confirmed = any(value == "confirmed" for (account_key, _), values in delivered.items() if account_key == key for value in values.values())
        has_suspected = any(value == "suspected" for (account_key, _), values in delivered.items() if account_key == key for value in values.values())
        search_related = any(
            isinstance(modules.get(name), dict) and modules[name].get("result_status") in {"risk", "no_risk"}
            for name in DELIVERY_MODULES[key] if name in SEARCH_MODULES
        )
        expected_discovery = (
            "confirmed_account" if has_confirmed else "suspected_account" if has_suspected
            else "related_content_only" if record_ids or search_related
            else "no_account_after_targeted_search"
        )
        if record.get("discovery_status") != expected_discovery:
            errors.append(f"{prefix}.discovery_status: expected {expected_discovery}")

    combined_query_plans = {
        (
            str(route.get("query_risk_group", "")),
            tuple(str(term) for term in route.get("query_terms", []) if isinstance(term, str)),
        )
        for key, route in all_routes.values()
        if key in {"domestic_other", "overseas_other"}
        and route.get("status") == "targeted_complete"
        and route.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
        and route.get("selection_rule") == "combined_high_risk_first_3_pages"
    }
    if len(combined_query_plans) > 1:
        errors.append(
            "coverage: Baidu and Google combined-risk routes must use the same selected risk group and ordered representative terms"
        )
    raw_user_leads = coverage.get("user_risk_leads")
    if isinstance(raw_user_leads, list) and raw_user_leads and combined_query_plans:
        first_lead = raw_user_leads[0] if isinstance(raw_user_leads[0], dict) else {}
        first_keyword_groups = first_lead.get("keyword_groups")
        if isinstance(first_keyword_groups, list) and first_keyword_groups and _text(first_keyword_groups[0]):
            required_priority_group = str(first_keyword_groups[0])
            if any(plan[0] != required_priority_group for plan in combined_query_plans):
                errors.append(
                    "coverage: combined-risk query group must equal the first keyword group of the highest-priority user lead"
                )
            try:
                standard_terms = _standard_terms_for_group(required_priority_group)
            except (OSError, UnicodeError):
                standard_terms = ""
            lead_terms = " ".join((
                required_priority_group,
                str(first_lead.get("description", "")),
                standard_terms,
            )).casefold()
            for _query_group, query_terms in combined_query_plans:
                if any(term.casefold() not in lead_terms for term in query_terms):
                    errors.append(
                        "coverage: user-led combined-risk representative terms must come from the first user risk expression, its description, or the matching risk-standard row"
                    )
    elif isinstance(raw_user_leads, list) and not raw_user_leads and combined_query_plans:
        try:
            standard_group, standard_terms = _highest_priority_standard_group()
        except (OSError, UnicodeError, ValueError) as exc:
            errors.append(f"coverage: cannot read the highest-priority group from {RISK_STANDARD_PATH}: {exc}")
        else:
            allowed_standard_terms = _standard_term_tokens(standard_terms)
            for query_group, query_terms in combined_query_plans:
                if query_group != standard_group:
                    errors.append(
                        "coverage: without user leads, combined-risk group must equal the current risk standard's first highest-priority group"
                    )
                if any(term.casefold() not in allowed_standard_terms for term in query_terms):
                    errors.append(
                        "coverage: without user leads, combined-risk representative terms must be complete keyword tokens from that highest-priority risk row"
                    )

    # One physical interactive-browser page label cannot drift between windows or carry
    # overlapping work. Different page ids may overlap, preserving parallelism.
    browser_page_windows: dict[str, str] = {}
    browser_page_intervals: dict[str, list[tuple[datetime, datetime, str]]] = {}
    for route_id, (_key, route) in all_routes.items():
        if route.get("tool_kind") not in INTERACTIVE_BROWSER_TOOL_KINDS:
            continue
        page_id = route.get("edge_page_continuity_id")
        window_id = route.get("edge_window_continuity_id")
        if not isinstance(page_id, str) or UUID4_RE.fullmatch(page_id) is None:
            continue
        if not isinstance(window_id, str) or UUID4_RE.fullmatch(window_id) is None:
            continue
        previous_window = browser_page_windows.setdefault(page_id, window_id)
        if previous_window != window_id:
            errors.append(
                f"routes.{route_id}.edge_window_continuity_id: one interactive browser page id must remain in one window"
            )
        try:
            started = datetime.fromisoformat(str(route.get("started_at", "")).replace("Z", "+00:00"))
            completed = datetime.fromisoformat(str(route.get("completed_at", "")).replace("Z", "+00:00"))
            if started.tzinfo is None or completed.tzinfo is None:
                continue
        except (ValueError, TypeError):
            continue
        browser_page_intervals.setdefault(page_id, []).append((started, completed, route_id))
    for page_id, intervals in browser_page_intervals.items():
        latest_end: datetime | None = None
        latest_route_id = ""
        for started, completed, route_id in sorted(intervals, key=lambda item: (item[0], item[1], item[2])):
            if latest_end is not None and started < latest_end:
                errors.append(
                    f"routes.{route_id}.started_at: interactive browser page {page_id} overlaps route {latest_route_id}"
                )
            if latest_end is None or completed > latest_end:
                latest_end = completed
                latest_route_id = route_id

    # A blocked/failed attempt may remain in history only when a completed route
    # explicitly closes the same module and surface.  This permits checkpointed
    # login recovery without allowing a blocked route to masquerade as clean.
    for route_id, (key, route) in all_routes.items():
        for field in ("account_or_query_url", "resolved_url"):
            if route.get(field) not in inventory:
                errors.append(f"routes.{route_id}.{field}: route URL missing from coverage.source_inventory")
        if route.get("status") not in {"blocked", "failed"}:
            continue
        for resolver_id in route.get("resolved_by_route_ids", []):
            resolver_entry = all_routes.get(resolver_id)
            if resolver_entry is None:
                errors.append(f"routes.{route_id}.resolved_by_route_ids: unknown resolver {resolver_id}")
                continue
            resolver_key, resolver = resolver_entry
            if resolver_key != key or resolver.get("status") != "targeted_complete":
                errors.append(f"routes.{route_id}.resolved_by_route_ids: resolver must be targeted_complete on the same platform")
            if resolver.get("module_key") != route.get("module_key") or resolver.get("surface") != route.get("surface"):
                errors.append(f"routes.{route_id}.resolved_by_route_ids: resolver must close the same module and surface")
            if (
                route.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
                and route.get("termination") in {"login_required", "verification_required"}
            ):
                if resolver.get("tool_kind") not in INTERACTIVE_BROWSER_TOOL_KINDS:
                    errors.append(
                        f"routes.{route_id}.resolved_by_route_ids: interactive-browser login recovery must remain an interactive browser UI route"
                    )
                else:
                    page_was_lost = str(route.get("boundary", "")).startswith(
                        "page_lost_new_continuity_required:"
                    )
                    if (
                        resolver.get("edge_page_continuity_id") != route.get("edge_page_continuity_id")
                        and not page_was_lost
                    ):
                        errors.append(
                            f"routes.{route_id}.resolved_by_route_ids: interactive-browser login recovery must resume on the same page id unless boundary begins page_lost_new_continuity_required:"
                        )
                    if resolver.get("account_or_query_url") != route.get("account_or_query_url"):
                        errors.append(
                            f"routes.{route_id}.resolved_by_route_ids: interactive-browser login recovery must reopen the same entry URL"
                        )
                    try:
                        blocked_completed = datetime.fromisoformat(
                            str(route.get("completed_at", "")).replace("Z", "+00:00")
                        )
                        resolver_started = datetime.fromisoformat(
                            str(resolver.get("started_at", "")).replace("Z", "+00:00")
                        )
                        if resolver_started < blocked_completed:
                            errors.append(
                                f"routes.{route_id}.resolved_by_route_ids: login resolver cannot start before the boundary route ends"
                            )
                    except (ValueError, TypeError):
                        pass

    # User-provided risk leads are authoritative and must each point to completed
    # targeted routes.  An omitted original lead remains a manual intake failure;
    # a recorded but unresolved lead is mechanically rejected here.
    leads = coverage.get("user_risk_leads")
    if not isinstance(leads, list):
        errors.append("coverage.user_risk_leads: must be a list")
        leads = []
    lead_ids: set[str] = set()
    for index, lead_value in enumerate(leads):
        prefix = f"coverage.user_risk_leads[{index}]"
        lead = _exact(lead_value, {
            "lead_id", "platform_keys", "keyword_groups", "description", "resolution_status",
            "risk_group_ids", "resolved_route_ids", "resolution_note",
        }, prefix, errors)
        lead_id = lead.get("lead_id")
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", str(lead_id or "")):
            errors.append(f"{prefix}.lead_id: invalid stable id")
        if lead_id in lead_ids:
            errors.append(f"{prefix}.lead_id: duplicate")
        lead_ids.add(str(lead_id))
        platform_keys = _string_list(lead.get("platform_keys"), f"{prefix}.platform_keys", errors, nonempty=True)
        if set(platform_keys) - set(PLATFORMS):
            errors.append(f"{prefix}.platform_keys: invalid platform")
        _string_list(lead.get("keyword_groups"), f"{prefix}.keyword_groups", errors, nonempty=True)
        if not _text(lead.get("description")) or not _text(lead.get("resolution_note")):
            errors.append(f"{prefix}: description and resolution_note must be non-empty")
        resolution = lead.get("resolution_status")
        if resolution not in {"risk_found", "no_risk_in_targeted_scope", "out_of_scope"}:
            errors.append(f"{prefix}.resolution_status: lead is not closed")
        lead_groups = set(_string_list(lead.get("risk_group_ids"), f"{prefix}.risk_group_ids", errors))
        if lead_groups - valid_groups:
            errors.append(f"{prefix}.risk_group_ids: unknown group")
        if (resolution == "risk_found") != bool(lead_groups):
            errors.append(f"{prefix}.risk_group_ids: must match risk_found resolution")
        resolver_ids = _string_list(lead.get("resolved_route_ids"), f"{prefix}.resolved_route_ids", errors, nonempty=True)
        resolved_platforms: set[str] = set()
        lead_flagged_route_seen = False
        lead_ledger_rows: list[dict[str, Any]] = []
        for route_id in resolver_ids:
            route_entry = all_routes.get(route_id)
            if route_entry is None:
                errors.append(f"{prefix}.resolved_route_ids: unknown route {route_id}")
            elif route_entry[1].get("status") != "targeted_complete":
                errors.append(f"{prefix}.resolved_route_ids: route {route_id} is not targeted_complete")
            else:
                resolver_route = route_entry[1]
                resolved_platforms.add(route_entry[0])
                if resolver_route.get("selection_rule") != "user_risk_lead_targeted":
                    errors.append(
                        f"{prefix}.resolved_route_ids: route {route_id} must use user_risk_lead_targeted"
                    )
                if resolver_route.get("tool_kind") not in INTERACTIVE_BROWSER_TOOL_KINDS:
                    errors.append(
                        f"{prefix}.resolved_route_ids: route {route_id} must be a completed interactive browser UI lead review"
                    )
                if isinstance(resolver_route.get("flagged_items"), int) and resolver_route.get("flagged_items", 0) > 0:
                    lead_flagged_route_seen = True
                    if check_files:
                        lead_ledger_rows.extend(_ledger_rows_for_cross_check(resolver_route))
        if set(platform_keys) - resolved_platforms:
            errors.append(f"{prefix}.resolved_route_ids: every implicated platform requires a completed route")
        if resolution == "risk_found":
            if not lead_flagged_route_seen:
                errors.append(f"{prefix}.resolved_route_ids: risk_found requires a flagged lead-review ledger")
            if check_files:
                selected_lead_rows = [
                    row for row in lead_ledger_rows
                    if "user_risk_lead" in row.get("selection_basis", [])
                ]
                if not selected_lead_rows:
                    errors.append(
                        f"{prefix}.resolved_route_ids: risk_found ledger must include a user_risk_lead selected row"
                    )
                ledger_groups = {
                    str(row.get("risk_group_id"))
                    for row in selected_lead_rows
                    if row.get("risk_decision") == "risk"
                }
                if lead_groups - ledger_groups:
                    errors.append(
                        f"{prefix}.risk_group_ids: every lead risk group must occur in its dedicated lead-review ledger"
                    )

    # Risk groups, platform/module links, selected-item ledgers and direct source
    # URLs form one closed graph.  This gate remains strict in both profiles.
    suspected_risk_groups: set[str] = set()
    forbidden_risk_source_urls = {
        module_url
        for (_platform_key, _module_key, module_url) in module_links
        if module_url
    }
    forbidden_risk_source_urls.update(
        account_url
        for slot_accounts in delivered.values()
        for account_url in slot_accounts
        if account_url
    )
    forbidden_risk_source_identities = {
        identity
        for identity in (
            _normalized_url_identity(url) for url in forbidden_risk_source_urls
        )
        if identity is not None
    }
    for instance in risk_instances:
        group_id = str(instance.get("group_id"))
        key = str(instance.get("platform_key"))
        source_url = str(instance.get("source_url"))
        if _normalized_url_identity(source_url) in forbidden_risk_source_identities:
            errors.append(
                f"risk_groups.{group_id}: direct source URL must not equal a homepage or search-module URL"
            )
        if (
            key in {"domestic_other", "overseas_other"}
            and _search_query_from_url(key, source_url) is not None
        ):
            errors.append(
                f"risk_groups.{group_id}: general-search result URL is not a direct risk source"
            )
        if _url(source_url) and not _direct_content_url(key, source_url):
            errors.append(
                f"risk_groups.{group_id}: risk source must be a direct content URL, not a profile root or search page"
            )
        if key not in {"domestic_other", "overseas_other"} and _url(source_url) and not _platform_url(key, source_url):
            errors.append(f"risk_groups.{group_id}: direct source URL must belong to platform {key}")
        if source_url not in inventory:
            errors.append(f"risk_groups.{group_id}: direct source URL missing from coverage.source_inventory")
        if group_id not in platform_links.get(key, set()):
            errors.append(f"risk_groups.{group_id}: missing platform cross-link on {key}")
        for module_key, module_url in instance.get("parsed_targets", []):
            entry_id = module_key.removeprefix("subplatform:") if module_key.startswith("subplatform:") else ""
            if delivered.get((key, entry_id), {}).get(module_url) == "suspected":
                suspected_risk_groups.add(group_id)
                if not str(instance.get("finding", "")).startswith("该疑似主页账号"):
                    errors.append(
                        f"risk_groups.{group_id}: suspected-homepage fact must begin with '该疑似主页账号'"
                    )
            if group_id not in module_links.get((key, module_key, module_url), set()):
                errors.append(f"risk_groups.{group_id}: missing module/URL cross-link {key}.{module_key}")
            if (key, module_key, group_id, source_url) not in all_risk_refs:
                errors.append(
                    f"risk_groups.{group_id}: discovered risk lacks a selected reviewed ledger row with its direct URL"
                )
    group_by_id = {
        str(group.get("id")): group
        for group in payload.get("risk_groups", [])
        if isinstance(group, dict)
    }
    for group_id in suspected_risk_groups:
        group = group_by_id.get(group_id, {})
        for field in ("summary", "explanation"):
            if "疑似主页" not in str(group.get(field, "")):
                errors.append(f"risk_groups.{group_id}.{field}: suspected-homepage risk must contain '疑似主页'")
    if suspected_risk_groups and "疑似主页" not in str(verdict.get("overall_conclusion", "")):
        errors.append("verdict.overall_conclusion: suspected-homepage risk must contain '疑似主页'")
    for (key, module_key, module_url), ids in module_links.items():
        for group_id in ids:
            if not any(
                str(instance.get("group_id")) == group_id
                and str(instance.get("platform_key")) == key
                and (module_key, module_url) in instance.get("parsed_targets", [])
                for instance in risk_instances
            ):
                errors.append(f"platforms.{key}.{module_key}: linked risk has no matching instance")

    for row in supplied:
        canonical = row.get("canonical_url")
        key = str(row.get("platform_key"))
        entry_id = ""
        if key in {"domestic_other", "overseas_other"}:
            matches = [slot for slot, name in extra_names.items() if slot[0] == key and name == row.get("subplatform")]
            if len(matches) == 1:
                entry_id = matches[0][1]
        if canonical not in delivered.get((key, entry_id), {}):
            errors.append("subject.user_supplied_homepages: canonical URL must be a delivered confirmed/suspected homepage")
        for source in (row.get("input_url"), canonical):
            if source not in inventory:
                errors.append("subject.user_supplied_homepages: input and canonical URLs must appear in source inventory")

    qa = _exact(payload.get("qa"), QA_FLAGS, "qa", errors)
    for flag in QA_FLAGS:
        if qa.get(flag) is not True:
            errors.append(f"qa.{flag}: must be true")
    return errors
