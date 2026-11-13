#!/usr/bin/env python3
"""Profile-dispatching validator for background-check research handoffs.

Schema 1.10 retains the legacy exhaustive-audit validator unchanged.  Schema
1.11 uses the bounded three-hour targeted validator in the sibling module.
"""

from __future__ import annotations
import os

import argparse
import base64
import copy
import hashlib
import importlib.util
import ipaddress
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, parse_qsl, quote, unquote, urlencode, urlparse

_review_spec = importlib.util.spec_from_file_location(
    "background_check_review_proofs", Path(__file__).with_name("review_proofs.py"),
)
if _review_spec is None or _review_spec.loader is None:
    raise ImportError("required sibling review_proofs.py could not be loaded")
_review_module = importlib.util.module_from_spec(_review_spec)
_review_spec.loader.exec_module(_review_module)
content_sha256 = _review_module.content_sha256
validate_completion_proof = _review_module.validate_completion_proof
validate_item_review = _review_module.validate_item_review

_targeted_spec = importlib.util.spec_from_file_location(
    "background_check_targeted_payload", Path(__file__).with_name("validate_targeted_payload.py"),
)
if _targeted_spec is None or _targeted_spec.loader is None:
    raise ImportError("required sibling validate_targeted_payload.py could not be loaded")
_targeted_module = importlib.util.module_from_spec(_targeted_spec)
_targeted_spec.loader.exec_module(_targeted_module)
validate_targeted_payload = _targeted_module.validate


PLATFORMS = (
    "weibo", "bilibili", "douyin", "xiaohongshu", "zhihu", "netease_music",
    "tieba", "douban", "domestic_other", "x", "facebook", "instagram",
    "youtube", "overseas_other",
)

SCHEMA_VERSION = "1.10"
TARGETED_SCHEMA_VERSION = "1.11"
TARGETED_RESEARCH_PROFILE = "three_hour_targeted_v1"
ROUTE_EVIDENCE_SCHEMA_VERSION = "route-evidence-1.4"
EDGE_ROUTE_EVIDENCE_SCHEMA_VERSION = "edge-route-evidence-1.2"
BROWSER_REACHABILITY_SCHEMA_VERSION = "browser-reachability-evidence-1.2"
NETWORK_PREFLIGHT_SCHEMA_VERSION = "network-preflight-1.4"
EDGE_CAPTURE_SCOPE = "full_visible_edge_window_with_tab_strip"
BROWSER_CAPTURE_SCOPE = "full_visible_browser_window_with_tab_strip"
BROWSER_CAPTURE_SCOPES = {BROWSER_CAPTURE_SCOPE, EDGE_CAPTURE_SCOPE}

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

SURFACE_MATRIX = {
    ("weibo", "homepage"): ("timeline",),
    ("weibo", "keyword_search"): ("native_search",),
    ("weibo", "topic"): ("topic_posts",),
    ("bilibili", "homepage"): ("dynamics", "videos", "articles", "live_replays", "collections_courses"),
    ("bilibili", "keyword_search"): ("search_videos", "search_articles", "search_other"),
    ("douyin", "homepage"): ("works", "photo_posts", "reposts_updates"),
    ("douyin", "keyword_search"): ("native_search",),
    ("xiaohongshu", "homepage"): ("notes", "videos"),
    ("xiaohongshu", "keyword_search"): ("search_all", "search_image_text", "search_videos", "search_users"),
    ("zhihu", "homepage"): ("answers", "articles", "pins", "questions", "videos"),
    ("zhihu", "keyword_search"): ("search_all", "search_content", "search_users"),
    ("netease_music", "homepage"): ("profile_events", "works_albums_programs", "videos"),
    ("netease_music", "keyword_search"): ("native_search",),
    ("tieba", "homepage"): ("profile_threads", "profile_replies"),
    ("tieba", "topic_homepage"): ("topic_threads",),
    ("tieba", "keyword_search"): ("search_all", "search_posts", "search_bars", "search_users"),
    ("douban", "subject_homepage"): ("subject_related_content", "broadcasts_comments_discussions"),
    ("douban", "keyword_search"): ("search_all", "search_people", "search_members", "search_content"),
    ("domestic_other", "baidu_search"): ("general_search",),
    ("x", "homepage"): ("posts", "replies", "reposts_quotes", "media"),
    ("x", "keyword_search"): ("native_search",),
    ("facebook", "homepage"): ("posts", "reels", "videos", "photos"),
    ("facebook", "keyword_search"): ("native_search",),
    ("instagram", "homepage"): ("posts", "reels", "highlights", "tagged"),
    ("instagram", "keyword_search"): ("native_search",),
    ("youtube", "homepage"): ("videos", "shorts", "live_archives", "community_posts", "public_playlists"),
    ("youtube", "keyword_search"): ("native_search",),
    ("overseas_other", "google_search"): ("general_search",),
}

HOMEPAGE_MODULES = {"homepage", "topic", "topic_homepage", "subject_homepage"}
SEARCH_MODULES = {"keyword_search", "baidu_search", "google_search"}
MODULE_STATUSES = {"confirmed", "suspected", "not_found"}
SEARCH_RESULT_STATUSES = {"risk", "no_risk", "no_related_content"}
HOMEPAGE_REVIEW_STATUSES = {"exhausted", "not_found_after_multiroute", "not_applicable"}
NATIVE_SEARCH_REVIEW_STATUSES = {"exhausted", "not_applicable"}
ROUTE_STATUSES = {"complete", "blocked", "failed"}
INTERACTIVE_BROWSER_TOOL_KINDS = {"browser_ui", "microsoft_edge_visible"}
LEGACY_EDGE_ROUTE_FAMILIES = {
    "microsoft_edge_visible_surface", "microsoft_edge_index_discovery",
    "microsoft_edge_crosslink_discovery", "microsoft_edge_institutional_discovery",
}
BROWSER_UI_ROUTE_FAMILIES = {
    "browser_ui_surface", "browser_ui_index_discovery",
    "browser_ui_crosslink_discovery", "browser_ui_institutional_discovery",
}
TOOL_KINDS = INTERACTIVE_BROWSER_TOOL_KINDS | {
    "local_script", "official_api", "authorized_export",
}
ROUTE_FAMILIES = {
    *LEGACY_EDGE_ROUTE_FAMILIES, *BROWSER_UI_ROUTE_FAMILIES,
    "official_api", "authorized_export", "approved_research_product",
}
AUTHORIZATION_STATUSES = {
    "not_required_browser_ui", "not_required_edge_visible",
    "public_official_api", "approved_app_permission",
    "approved_research_access", "written_platform_permission", "authorized_export",
    "permission_missing",
}
AUTHORIZATION_EVIDENCE_KINDS = {
    "official_api_terms", "app_permission", "research_access", "written_platform_permission",
    "authorized_export_manifest",
}
RAW_EVIDENCE_KINDS = {
    "collector_status", "api_response", "browser_snapshot", "terminal_screenshot",
    "manual_review_log", "authorized_export_manifest",
}
COMPLETE_TERMINATIONS = {"natural_end", "cursor_exhausted", "empty_result_after_full_query"}
LOGIN_TERMINATIONS = {"login_wall", "login_required", "authentication_required"}
FORBIDDEN_COMPLETE_TERMINATIONS = {
    "max_pages", "max_items", "max_scrolls", "max_comments", "sample_complete",
    "first_page_only", "repeated_page_state", "repeated_cursor", "no_cursor",
    "no_bottom_cursor", "http_error", "non_json", *LOGIN_TERMINATIONS, "captcha",
    "rate_limited", "timeout", "collector_error", "manual_stop",
}

EDGE_SESSION_STATES = {"public_visible", "login_required", "user_login_completed"}
EDGE_ROUTE_EVIDENCE_FIELDS = {
    "schema_version", "route_id", "account_or_query_url", "final_visible_url", "browser_family", "window_mode",
    "edge_session_state", "edge_window_continuity_id", "user_login_completed_at",
    "edge_page_continuity_id", "max_task_open_edge_pages", "serial_route_index",
    "linear_pass_index", "capture_scope", "review_start_mode", "review_started_at",
    "captured_at", "artifact_path", "artifact_sha256", "artifact_kind",
}

DISCOVERY_STATUSES = {
    "confirmed_account", "suspected_account", "related_content_only",
    "no_account_after_multiroute_search", "access_blocked_unresolved",
}

OTHER_TAIL_STATEMENTS = {
    "domestic_other": "其他境内平台暂未发现相关账号或相关内容的负面及敏感信息。",
    "overseas_other": "其他境外平台暂未发现相关账号或相关内容的负面及敏感信息。",
}

PLATFORM_DISPLAY = {
    "weibo": "微博", "bilibili": "B站", "douyin": "抖音", "xiaohongshu": "小红书",
    "zhihu": "知乎", "netease_music": "网易云音乐", "tieba": "贴吧", "douban": "豆瓣",
    "domestic_other": "境内其他内容", "x": "X", "facebook": "Facebook",
    "instagram": "INS", "youtube": "油管", "overseas_other": "境外其他网站",
}

TOP_LEVEL = {
    "schema_version", "subject", "verdict", "accounts", "representative_works",
    "risk_summary_order", "risk_groups", "platforms", "coverage", "qa",
}
PLATFORM_FIELDS = {
    "display_name", "discovery_status", "risk_group_ids",
    "subplatforms", "delivery_modules", "research_completion",
}
QA_FLAGS = (
    "all_risks_grouped", "all_risks_mapped_to_platforms", "mandatory_platforms_complete",
    "source_urls_checked", "screenshots_mapped", "risk_terms_complete_and_hashed",
    "network_preflight_complete", "baidu_general_search_complete",
    "google_general_search_complete", "all_required_surfaces_exhausted",
    "all_items_reviewed", "platform_discovery_reconciled", "other_platform_tail_present",
    "no_unresolved_platforms", "single_edge_page_serial_complete",
)

RESULT_LEVELS = {"建议谨慎评估", "建议评估", "无合作风险"}
SUBJECT_TYPES = {"person", "organization", "company", "brand", "project", "other_entity"}
ACCOUNT_STATUSES = {
    "confirmed", "suspected_homepage", "unconfirmed_candidate", "excluded_candidate",
}
DELIVERED_ACCOUNT_STATUSES = {"confirmed", "suspected_homepage"}
CANDIDATE_NAME_MATCHES = {"exact_display_name", "exact_alias", "other"}
CANDIDATE_ANCHOR_NAMES = {
    "direct_crosslink", "field", "content_theme", "works_history", "language_style",
    "avatar_visual", "associated_person", "location",
}
CANDIDATE_ANCHOR_STRENGTHS = {"none", "weak", "confirming"}
CANDIDATE_ANCHOR_SCORES = {"none": 0, "weak": 1, "confirming": 10}
CANDIDATE_NAME_SCORES = {"exact_display_name": 100, "exact_alias": 90, "other": 0}
ITEM_KINDS = {"content", "account_candidate"}
ACCOUNT_LIKE_CONTENT_TYPES = {
    "account", "artist_profile", "channel", "creator_profile", "homepage",
    "official_page", "profile", "user",
}
SERVICE_DOMAIN_ALIASES = {
    "b23.tv": "bilibili",
    "pixiv.net": "pixiv",
    "pixiv.me": "pixiv",
    "twitter.com": "x",
    "x.com": "x",
    "youtu.be": "youtube",
    "youtube.com": "youtube",
    "fb.com": "facebook",
    "facebook.com": "facebook",
    "xhslink.com": "xiaohongshu",
    "zhihu.link": "zhihu",
}
SERVICE_HOST_SUFFIX_ALIASES = {
    "artstation.com": "artstation",
    "bandcamp.com": "bandcamp",
    "blogspot.com": "blogspot",
    "bsky.app": "bluesky",
    "carrd.co": "carrd",
    "deviantart.com": "deviantart",
    "fanbox.cc": "pixiv_fanbox",
    "github.io": "github_pages",
    "gumroad.com": "gumroad",
    "imdb.com": "imdb",
    "itch.io": "itch_io",
    "linkedin.com": "linkedin",
    "notion.site": "notion_sites",
    "patreon.com": "patreon",
    "pixiv.me": "pixiv",
    "pixiv.net": "pixiv",
    "skland.com": "skland",
    "spotify.com": "spotify",
    "substack.com": "substack",
    "threads.net": "threads",
    "tiktok.com": "tiktok",
    "tumblr.com": "tumblr",
    "vimeo.com": "vimeo",
    "webflow.io": "webflow",
    "wixsite.com": "wixsite",
    "wordpress.com": "wordpress",
}
EXTRA_ACCOUNT_PATH_PATTERNS = {
    "bluesky": (r"/profile/[^/]+",),
    "imdb": (r"/name/nm\d+",),
    "linkedin": (r"/(?:in|company|school)/[^/]+",),
    "pixiv": (r"/users/\d+",),
    "spotify": (r"/(?:intl-[a-z-]+/)?(?:artist|user|show)/[^/]+",),
    "threads": (r"/@[^/]+",),
    "tiktok": (r"/@[^/]+",),
    "tumblr": (r"/blog/view/[^/]+",),
    "pixiv_fanbox": (r"/@[^/]+",),
    "substack": (r"/@[^/]+",),
    "patreon": (r"/c/[^/]+",),
    "vimeo": (r"/user\d+",),
}
EXTRA_SINGLE_SEGMENT_ACCOUNT_RESERVED = {
    "artstation": {
        "about", "blogs", "channels", "jobs", "learning", "marketplace", "prints", "search",
    },
    "deviantart": {
        "about", "core-membership", "daily-deviations", "join", "search", "shop", "tag", "topic",
    },
    "gumroad": {
        "about", "affiliates", "discover", "help", "library", "login", "settings", "signup",
    },
    "patreon": {
        "about", "c", "checkout", "create", "explore", "home", "join", "login", "memberships",
        "messages", "posts", "signup",
    },
    "tumblr": {
        "about", "blog", "dashboard", "explore", "login", "register", "search", "settings", "tagged",
    },
    "vimeo": {
        "blog", "categories", "channels", "create", "features", "groups", "help", "join", "log_in",
        "ondemand", "ott", "upgrade", "watch",
    },
}
EXTRA_TENANT_ROOT_HOST_SUFFIXES = {
    "artstation": ("artstation.com",),
    "bandcamp": ("bandcamp.com",),
    "blogspot": ("blogspot.com",),
    "carrd": ("carrd.co",),
    "deviantart": ("deviantart.com",),
    "pixiv_fanbox": ("fanbox.cc",),
    "github_pages": ("github.io",),
    "gumroad": ("gumroad.com",),
    "itch_io": ("itch.io",),
    "notion_sites": ("notion.site",),
    "substack": ("substack.com",),
    "tumblr": ("tumblr.com",),
    "webflow": ("webflow.io",),
    "weebly.com": ("weebly.com",),
    "wixsite": ("wixsite.com",),
    "wordpress": ("wordpress.com",),
}
EXTRA_TENANT_RESERVED_LABELS = {
    "about", "api", "blog", "community", "dev", "developers", "docs", "help", "login", "m",
    "search", "signup", "status", "support", "www",
}
EXTRA_TENANT_SERVICE_RESERVED_LABELS = {
    "bandcamp": {"daily"},
}
EXTRA_TENANT_SINGLE_SEGMENT_ACCOUNT_SERVICES = {"notion_sites", "wixsite"}
RISK_DECISIONS = {"risk", "no_risk", "false_positive", "out_of_scope"}
ITEM_REVIEW_STATUSES = {"complete", "not_applicable"}
VIDEO_CONTENT_TYPES = {
    "video", "video_post", "short_video", "short", "clip", "reel", "live",
    "live_video", "live_stream", "livestream", "live_replay", "live_archive",
}

VIDEO_ONLY_SURFACES = {
    ("bilibili", "videos"), ("bilibili", "live_replays"),
    ("bilibili", "search_videos"),
    ("xiaohongshu", "videos"), ("xiaohongshu", "search_videos"),
    ("zhihu", "videos"), ("netease_music", "videos"),
    ("facebook", "reels"), ("facebook", "videos"),
    ("instagram", "reels"), ("youtube", "videos"),
    ("youtube", "shorts"), ("youtube", "live_archives"),
}
MEDIA_KINDS = {"none", "image", "audio", "video", "animated_image", "document"}
VIDEO_METADATA_FIELDS = {
    "detail_url", "detail_capture_kind", "title_state", "cover_state", "cover_path", "cover_sha256",
    "description_state", "play_count_status", "play_count", "play_count_source_text",
    "observed_at", "native_rank_evidence",
}
VIDEO_TEXT_STATES = {"present", "empty_on_source"}
VIDEO_DESCRIPTION_STATES = {"complete_expanded", "empty_on_source"}
VIDEO_DETAIL_CAPTURE_KIND = "video_detail_page"
VIDEO_PLAY_COUNT_STATUSES = {
    "observed", "native_top_rank", "not_public", "not_comparable", "not_applicable",
}
VIDEO_TRIAGE_RESULTS = {"clear", "suspected_risk", "risk_signal"}
VIDEO_TRIAGE_UPGRADE_RESULTS = {"suspected_risk", "risk_signal"}
NATIVE_RANK_EVIDENCE_FIELDS = {
    "source_account_url", "source_video_url", "source_surface", "sort_mode", "ranking_scope",
    "native_rank", "visible_order_text", "observed_at",
    "ranking_snapshot_path", "ranking_snapshot_sha256",
}
NATIVE_RANK_SNAPSHOT_FIELDS = {
    "source_account_url", "source_surface", "sort_mode", "ranking_scope", "observed_at",
    "ordered_video_urls",
}
NATIVE_RANK_SCOPE = "account_all_videos"
NATIVE_RANK_SOURCE_SURFACE = "account_native_popular"
NATIVE_RANK_SORT_MODES = {"popular", "most_viewed"}
ACCOUNT_VIDEO_TOP_LIMIT = 10
PLAY_COUNT_VALUE_PATTERN = (
    r"(?<![\d,.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*"
    r"(万|亿|[kKmMbB])?(?![\d,.+])"
)
PLAY_COUNT_SUFFIX_RE = re.compile(
    PLAY_COUNT_VALUE_PATTERN
    + r"\s*(?:次?\s*(?:播放(?!量|次数)|观看(?!量|次数))|views?|plays?)",
    re.I,
)
PLAY_COUNT_PREFIX_RE = re.compile(
    r"(?:(?:播放|观看)(?:量|次数)?|views?|plays?)\s*[：:]?\s*"
    + PLAY_COUNT_VALUE_PATTERN,
    re.I,
)
PLAY_COUNT_ONLY_RE = re.compile(r"^\s*" + PLAY_COUNT_VALUE_PATTERN + r"\s*$", re.I)
VIDEO_SAMPLING_METHOD = "equal_interval_plus_keyframes_scene_changes"
VIDEO_AUDIO_SCAN_METHODS = {
    "asr_full_audio", "official_subtitles_full", "manual_transcript_full", "combined_full",
}
VIDEO_HIT_EVIDENCE_KINDS = {"screenshot", "frame", "transcript_excerpt"}
FRAME_CAPTURE_KINDS = {"interval_sample", "keyframe", "scene_change"}
AUDIO_SEGMENT_KINDS = {
    "speech", "subtitle", "onscreen_text", "music_lyrics", "silence", "unintelligible",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
EDGE_WINDOW_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
EVIDENCE_ROOT = Path(os.environ["BACKGROUND_CHECK_WORKSPACE"]).resolve(strict=False)
MAX_IMAGE_BYTES = 20 * 1024 * 1024
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

PLATFORM_HOST_SUFFIXES = {
    "weibo": ("weibo.com", "weibo.cn"),
    "bilibili": ("bilibili.com",),
    "douyin": ("douyin.com",),
    "xiaohongshu": ("xiaohongshu.com",),
    "zhihu": ("zhihu.com",),
    "netease_music": ("music.163.com",),
    "tieba": ("tieba.baidu.com",),
    "douban": ("douban.com",),
    "x": ("x.com", "twitter.com"),
    "facebook": ("facebook.com",),
    "instagram": ("instagram.com",),
    "youtube": ("youtube.com",),
}


def _is_nonempty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _temporary_browser_identity(value: Any) -> bool:
    """Reject explicit non-persistent browser identities, including joined aliases."""
    if not _is_nonempty_text(value):
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
    if not _is_nonempty_text(value):
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


def _is_url(value: Any) -> bool:
    if not _is_nonempty_text(value):
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _is_placeholder_url(value: Any) -> bool:
    if not _is_url(value):
        return False
    lowered = str(value).lower()
    return any(marker in lowered for marker in ("example.com", "example.org", "example.net", "placeholder"))


def _host_matches(host: str, suffix: str) -> bool:
    host = host.lower().rstrip(".")
    suffix = suffix.lower().rstrip(".")
    return host == suffix or host.endswith(f".{suffix}")


def _is_platform_native_url(platform_key: str, value: Any) -> bool:
    if not _is_url(value):
        return False
    suffixes = PLATFORM_HOST_SUFFIXES.get(platform_key, ())
    host = (urlparse(str(value)).hostname or "").lower()
    return bool(suffixes) and any(_host_matches(host, suffix) for suffix in suffixes)


def _looks_like_video_url(platform_key: str, value: Any) -> bool:
    """Recognize unambiguous video paths even when found through another platform's search."""
    return _stable_video_identity(str(value)) is not None


def _validate_platform_module_url(
    platform_key: str,
    module_key: str,
    value: Any,
    prefix: str,
    errors: list[str],
) -> None:
    """Reject a URL that cannot be the named Chapter 4 platform/module surface."""
    if not _is_url(value) or _is_placeholder_url(value) or module_key.startswith("subplatform:"):
        return
    parsed = urlparse(str(value))
    host = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    query = parse_qs(parsed.query)
    if platform_key == "domestic_other" and module_key == "baidu_search":
        if not _host_matches(host, "baidu.com") or path.rstrip("/") != "/s" or not ({"wd", "word"} & set(query)):
            errors.append(f"{prefix}: must be a Baidu general-search result URL with wd/word query")
        return
    if platform_key == "overseas_other" and module_key == "google_search":
        if not (host == "google.com" or host.endswith(".google.com") or host.startswith("www.google.")):
            errors.append(f"{prefix}: must use a Google search host")
        if path.rstrip("/") != "/search" or "q" not in query:
            errors.append(f"{prefix}: must be a Google /search result URL with q query")
        return
    suffixes = PLATFORM_HOST_SUFFIXES.get(platform_key)
    if suffixes and not any(_host_matches(host, suffix) for suffix in suffixes):
        errors.append(f"{prefix}: host does not belong to {PLATFORM_DISPLAY.get(platform_key, platform_key)}")
        return
    if module_key not in SEARCH_MODULES:
        return
    if platform_key == "netease_music":
        fragment_path, separator, fragment_query_text = parsed.fragment.partition("?")
        fragment_query = parse_qs(fragment_query_text) if separator else {}
        if not fragment_path.lower().startswith("/search/") or not ({"s", "keywords"} & set(fragment_query)):
            errors.append(f"{prefix}: NetEase Music search URL requires a /search/ fragment and s/keywords query")
        return
    if platform_key == "instagram":
        if not path.startswith("/explore/search/") or "q" not in query:
            errors.append(f"{prefix}: Instagram search URL requires /explore/search/ and q query")
        return
    search_semantics = {
        "weibo": ("search",),
        "bilibili": ("search",),
        "douyin": ("search",),
        "xiaohongshu": ("search",),
        "zhihu": ("search",),
        "tieba": ("search",),
        "douban": ("search",),
        "x": ("search",),
        "facebook": ("search",),
        "youtube": ("results",),
    }
    markers = search_semantics.get(platform_key, ("search",))
    haystack = f"{host}{path}?{parsed.query}".lower()
    if platform_key == "weibo" and _host_matches(host, "s.weibo.com"):
        pass
    elif not any(marker in haystack for marker in markers):
        errors.append(f"{prefix}: URL does not have the platform's native-search semantics")
    if platform_key == "youtube" and "search_query" not in query:
        errors.append(f"{prefix}: YouTube search URL requires search_query")


def _looks_like_extra_account_homepage(value: Any) -> bool:
    """Recognize high-confidence account URLs on controlled extra-platform services."""
    if not _is_url(value):
        return False
    parsed = urlparse(str(value))
    host = (parsed.hostname or "").lower().rstrip(".")
    clean_path = parsed.path.rstrip("/").lower() or "/"
    segments = [segment for segment in clean_path.split("/") if segment]
    service_id = _normalized_service_domain(value)

    if service_id == "skland":
        return clean_path == "/profile" and any(parse_qs(parsed.query).get("id", []))
    if service_id == "pixiv" and _host_matches(host, "pixiv.me"):
        return len(segments) == 1 and segments[0] not in {"about", "login", "signup"}
    if any(
        re.fullmatch(pattern, clean_path)
        for pattern in EXTRA_ACCOUNT_PATH_PATTERNS.get(service_id, ())
    ):
        return True
    if service_id == "vimeo" and len(segments) == 1 and segments[0].isdigit():
        return False
    reserved = EXTRA_SINGLE_SEGMENT_ACCOUNT_RESERVED.get(service_id)
    if reserved is not None and len(segments) == 1 and segments[0] not in reserved:
        return True
    if clean_path != "/" and not (
        service_id in EXTRA_TENANT_SINGLE_SEGMENT_ACCOUNT_SERVICES and len(segments) == 1
    ):
        return False
    for suffix in EXTRA_TENANT_ROOT_HOST_SUFFIXES.get(service_id, ()):
        suffix = suffix.lower().rstrip(".")
        if not host.endswith(f".{suffix}"):
            continue
        tenant_prefix = host[: -(len(suffix) + 1)]
        tenant_label = tenant_prefix.rsplit(".", 1)[-1]
        service_reserved = EXTRA_TENANT_SERVICE_RESERVED_LABELS.get(service_id, set())
        if (
            tenant_label
            and tenant_label not in EXTRA_TENANT_RESERVED_LABELS
            and tenant_label not in service_reserved
        ):
            return True
    return False


def _looks_like_account_homepage(platform_key: str, value: Any) -> bool:
    """Recognize account URLs that search ledgers must rank as candidates."""
    if not _is_url(value):
        return False
    parsed = urlparse(str(value))
    host = (parsed.hostname or "").lower()
    path = parsed.path.rstrip("/")
    lowered = path.lower()
    segments = [segment for segment in lowered.split("/") if segment]
    if platform_key == "weibo":
        if _host_matches(host, "weibo.cn"):
            return lowered.startswith(("/u/", "/n/"))
        reserved = {"search", "tv", "hot", "newlogin", "login", "signup", "p", "ajax"}
        return lowered.startswith(("/u/", "/n/")) or (len(segments) == 1 and segments[0] not in reserved)
    if platform_key == "bilibili":
        return _host_matches(host, "space.bilibili.com")
    if platform_key == "douyin":
        return lowered.startswith("/user/")
    if platform_key == "xiaohongshu":
        return lowered.startswith("/user/profile/")
    if platform_key == "zhihu":
        return lowered.startswith(("/people/", "/org/"))
    if platform_key == "netease_music":
        fragment = parsed.fragment.lower()
        return fragment.startswith(("/user/home", "/artist"))
    if platform_key == "tieba":
        return lowered.startswith(("/home/main", "/i/sys/jump"))
    if platform_key == "douban":
        return lowered.startswith("/people/")
    if platform_key == "x":
        reserved = {
            "compose", "explore", "hashtag", "home", "i", "intent", "login", "messages",
            "notifications", "search", "settings", "share", "tos",
        }
        return len(segments) == 1 and segments[0] not in reserved
    if platform_key == "facebook":
        if lowered == "/profile.php" and "id" in parse_qs(parsed.query):
            return True
        reserved = {
            "events", "groups", "marketplace", "pages", "photo", "photos", "posts",
            "reel", "reels", "search", "share", "stories", "watch",
        }
        return len(segments) == 1 and segments[0] not in reserved
    if platform_key == "instagram":
        reserved = {"accounts", "direct", "explore", "p", "reel", "reels", "stories", "tv"}
        return len(segments) == 1 and segments[0] not in reserved
    if platform_key == "youtube":
        return lowered.startswith(("/@", "/channel/", "/c/", "/user/"))
    if platform_key in {"domestic_other", "overseas_other"}:
        named_platform = _named_platform_for_url(value)
        if named_platform is not None:
            return _looks_like_account_homepage(named_platform, value)
        return _looks_like_extra_account_homepage(value)
    return False


def _normalize_query_text(value: Any) -> str:
    """Normalize a visibly submitted search string without weakening token checks."""
    if not isinstance(value, str):
        return ""
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()


def _normalize_exact_identity_name(value: Any) -> str:
    """Apply only the workflow's allowed display-name cleanup."""
    if not isinstance(value, str):
        return ""
    normalized = value.strip()
    if normalized.startswith("@"):
        normalized = normalized[1:].strip()
    return normalized


def _resolve_psl_executable() -> Path | None:
    candidates: list[Path] = []
    if os.environ.get("BACKCHECK_PSL_PATH"):
        candidates.append(Path(os.environ["BACKCHECK_PSL_PATH"]))
    git = shutil.which("git")
    if git:
        candidates.append(Path(git).resolve().parent.parent / "mingw64/bin/psl.exe")
    command = shutil.which("psl") or shutil.which("psl.exe")
    if command:
        candidates.append(Path(command))
    runtime_candidate = (
        Path(sys.executable).resolve(strict=False).parent.parent
        / "native" / "git" / "mingw64" / "bin" / "psl.exe"
    )
    candidates.append(runtime_candidate)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


PSL_EXECUTABLE = _resolve_psl_executable()


@lru_cache(maxsize=4096)
def _psl_registrable_domain(host: str) -> str:
    if PSL_EXECUTABLE is None:
        return ""
    try:
        completed = subprocess.run(
            [
                str(PSL_EXECUTABLE), "--use-builtin-data", "--batch",
                "--print-reg-domain", host,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if completed.returncode != 0:
        return ""
    value = completed.stdout.strip().splitlines()
    if len(value) != 1 or value[0] in {"", "(null)"}:
        return ""
    return value[0].lower().rstrip(".")


def _search_query_texts(platform_key: str, value: Any) -> list[str]:
    """Extract only the platform's actual native-search input, never arbitrary URL fields."""
    if not _is_url(value):
        return []
    parsed = urlparse(str(value))
    query = parse_qs(parsed.query, keep_blank_values=True)
    keys_by_platform = {
        "weibo": ("q", "keyword"),
        "bilibili": ("keyword", "search_keyword"),
        "douyin": ("keyword", "q"),
        "xiaohongshu": ("keyword",),
        "zhihu": ("q", "search"),
        "tieba": ("qw", "kw", "word"),
        "douban": ("q", "search_text"),
        "domestic_other": ("wd", "word"),
        "x": ("q",),
        "facebook": ("q",),
        "instagram": ("q",),
        "youtube": ("search_query",),
        "overseas_other": ("q",),
    }
    values = [item for key in keys_by_platform.get(platform_key, ()) for item in query.get(key, [])]
    if platform_key == "netease_music":
        _fragment_path, separator, fragment_query_text = parsed.fragment.partition("?")
        fragment_query = parse_qs(fragment_query_text, keep_blank_values=True) if separator else {}
        values.extend(item for key in ("s", "keywords") for item in fragment_query.get(key, []))
    if platform_key == "douyin":
        match = re.search(r"/search/([^/?#]+)", parsed.path, flags=re.IGNORECASE)
        if match:
            values.append(unquote(match.group(1)))
    if platform_key == "weibo" and _host_matches((parsed.hostname or "").lower(), "s.weibo.com"):
        match = re.search(r"/weibo/([^/?#]+)", parsed.path, flags=re.IGNORECASE)
        if match:
            values.append(unquote(match.group(1)))
    return [item for item in values if _is_nonempty_text(item)]


def _normalized_service_domain(value: Any) -> str:
    """Return a conservative registrable-service key for extra-platform accounting."""
    if not _is_url(value):
        return ""
    host = (urlparse(str(value)).hostname or "").lower().rstrip(".")
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return ""
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return host
    for suffix, service_id in SERVICE_HOST_SUFFIX_ALIASES.items():
        if _host_matches(host, suffix):
            return service_id
    for prefix in ("www.", "m.", "mobile.", "web."):
        remainder = host[len(prefix):] if host.startswith(prefix) else ""
        if remainder and "." in remainder:
            host = remainder
            break
    if host in SERVICE_DOMAIN_ALIASES:
        return SERVICE_DOMAIN_ALIASES[host]
    registrable_service = _psl_registrable_domain(host)
    if not registrable_service:
        return host
    return SERVICE_DOMAIN_ALIASES.get(registrable_service, registrable_service)


def _actual_platform_slot(platform_key: Any, url: Any) -> tuple[str, str]:
    key = str(platform_key)
    if key in {"domestic_other", "overseas_other"}:
        return ("extra", _normalized_service_domain(url))
    return ("named", key)


def _named_platform_for_url(value: Any) -> str | None:
    if not _is_url(value):
        return None
    host = (urlparse(str(value)).hostname or "").lower()
    for key, suffixes in PLATFORM_HOST_SUFFIXES.items():
        if any(_host_matches(host, suffix) for suffix in suffixes):
            return key
    alias = _normalized_service_domain(value)
    if alias in PLATFORM_HOST_SUFFIXES:
        return alias
    return None


def _validate_supplied_canonicalizations(
    supplied_homepages: list[dict[str, Any]],
    route_contexts: list[dict[str, Any]],
    *,
    errors: list[str],
) -> None:
    """Bind every non-identical supplied/canonical URL pair to visible redirect evidence."""
    routes_by_id: dict[str, list[dict[str, Any]]] = {}
    authorized_redirect_route_ids: set[str] = set()
    for context in route_contexts:
        route = context.get("route") if isinstance(context, dict) else None
        if isinstance(route, dict) and _is_nonempty_text(route.get("route_id")):
            routes_by_id.setdefault(str(route["route_id"]), []).append(context)
    for index, supplied in enumerate(supplied_homepages):
        if not isinstance(supplied, dict):
            continue
        prefix = f"subject.user_supplied_homepages[{index}]"
        input_url = supplied.get("input_url")
        canonical_url = supplied.get("canonical_url")
        route_id = supplied.get("canonicalization_route_id")
        if not isinstance(route_id, str):
            errors.append(f"{prefix}.canonicalization_route_id: must be text")
            continue
        if input_url == canonical_url:
            if route_id:
                errors.append(
                    f"{prefix}.canonicalization_route_id: must be empty when input_url already equals canonical_url"
                )
            continue
        if not route_id:
            errors.append(
                f"{prefix}.canonicalization_route_id: differing URLs require a completed interactive-browser redirect route"
            )
            continue
        authorized_redirect_route_ids.add(route_id)
        contexts = routes_by_id.get(route_id, [])
        if len(contexts) != 1:
            errors.append(f"{prefix}.canonicalization_route_id: must reference exactly one research route")
            continue
        context = contexts[0]
        route = context["route"]
        if context.get("platform_key") != supplied.get("platform_key"):
            errors.append(f"{prefix}.canonicalization_route_id: route must belong to the supplied platform bucket")
        if (
            route.get("status") != "complete"
            or route.get("tool_kind") not in INTERACTIVE_BROWSER_TOOL_KINDS
        ):
            errors.append(
                f"{prefix}.canonicalization_route_id: route must be completed in an interactive browser UI"
            )
        if route.get("linear_pass_index") != 0:
            errors.append(f"{prefix}.canonicalization_route_id: redirect proof must be a discovery prepass route")
        if route.get("surface") != "account_discovery":
            errors.append(f"{prefix}.canonicalization_route_id: route surface must be account_discovery")
        if route.get("account_or_query_url") != input_url or route.get("evidence_origin") != input_url:
            errors.append(f"{prefix}.canonicalization_route_id: route must start from the exact input_url")
        if route.get("resolved_url") != canonical_url:
            errors.append(f"{prefix}.canonicalization_route_id: route resolved_url must equal canonical_url")
    for context in route_contexts:
        route = context.get("route") if isinstance(context, dict) else None
        if not isinstance(route, dict):
            continue
        if (
            route.get("status") == "complete"
            and
            route.get("resolved_url") != route.get("account_or_query_url")
            and route.get("route_id") not in authorized_redirect_route_ids
        ):
            errors.append(
                f"{context.get('prefix', 'route')}.resolved_url: may differ from account_or_query_url "
                "only for a user-supplied canonicalization route"
            )


def _candidate_similarity_score(value: dict[str, Any]) -> int:
    name_score = CANDIDATE_NAME_SCORES.get(str(value.get("name_match")), 0)
    claim_score = 1 if value.get("all_platform_name_claim") is True else 0
    strengths = value.get("anchor_strengths") if isinstance(value.get("anchor_strengths"), dict) else {}
    anchor_score = sum(CANDIDATE_ANCHOR_SCORES.get(str(strengths.get(name)), 0) for name in CANDIDATE_ANCHOR_NAMES)
    return name_score + claim_score + anchor_score


def _merge_candidate_evaluations(
    target: dict[str, dict[str, Any]],
    incoming: dict[str, dict[str, Any]],
    *,
    prefix: str,
    errors: list[str],
) -> None:
    for candidate_url, evaluation in incoming.items():
        previous = target.get(candidate_url)
        if previous is not None and previous != evaluation:
            errors.append(f"{prefix}: candidate {candidate_url} has inconsistent identity evaluation")
        else:
            target[candidate_url] = evaluation


def _accumulate_candidate_evidence(
    target: dict[str, dict[str, Any]],
    incoming: dict[str, dict[str, Any]],
    *,
    prefix: str,
    errors: list[str],
) -> None:
    """Retain the strongest identity evidence ever recorded for each candidate."""
    name_rank = {"other": 0, "exact_alias": 1, "exact_display_name": 2}
    anchor_rank = {"none": 0, "weak": 1, "confirming": 2}
    for candidate_url, evaluation in incoming.items():
        previous = target.get(candidate_url)
        if previous is None:
            target[candidate_url] = copy.deepcopy(evaluation)
            continue
        for field in ("candidate_platform_key", "candidate_subplatform"):
            if previous.get(field) != evaluation.get(field):
                errors.append(
                    f"{prefix}: candidate {candidate_url} has inconsistent {field} across passes"
                )
        merged = copy.deepcopy(previous)
        if name_rank.get(str(evaluation.get("name_match")), -1) > name_rank.get(
            str(merged.get("name_match")), -1
        ):
            merged["name_match"] = evaluation.get("name_match")
        merged["all_platform_name_claim"] = bool(
            previous.get("all_platform_name_claim") or evaluation.get("all_platform_name_claim")
        )
        previous_strengths = (
            previous.get("anchor_strengths") if isinstance(previous.get("anchor_strengths"), dict) else {}
        )
        incoming_strengths = (
            evaluation.get("anchor_strengths") if isinstance(evaluation.get("anchor_strengths"), dict) else {}
        )
        merged_strengths: dict[str, str] = {}
        for anchor in CANDIDATE_ANCHOR_NAMES:
            old = str(previous_strengths.get(anchor, "none"))
            new = str(incoming_strengths.get(anchor, "none"))
            merged_strengths[anchor] = new if anchor_rank.get(new, -1) > anchor_rank.get(old, -1) else old
        merged["anchor_strengths"] = merged_strengths
        merged["explicit_identity_conflict"] = bool(
            previous.get("explicit_identity_conflict") or evaluation.get("explicit_identity_conflict")
        )
        merged["similarity_score"] = _candidate_similarity_score(merged)
        target[candidate_url] = merged


def _validate_final_candidate_evidence(
    all_seen: dict[str, dict[str, Any]],
    final_pass: dict[str, dict[str, Any]],
    supplied_urls: set[str],
    *,
    errors: list[str],
) -> None:
    missing_final_candidates = sorted(set(all_seen) - set(final_pass) - supplied_urls)
    if missing_final_candidates:
        errors.append(
            "identity_candidates: every reviewed account candidate seen in any route must be re-evaluated "
            "in a completed final reconciliation-cycle ledger: " + ", ".join(missing_final_candidates)
        )
    comparable_urls = (set(all_seen) & set(final_pass)) - supplied_urls
    for candidate_url in sorted(comparable_urls):
        if final_pass[candidate_url] != all_seen[candidate_url]:
            errors.append(
                f"identity_candidates[{candidate_url}]: final reconciliation-cycle evaluation must preserve the strongest "
                "name, claim, anchor, and conflict evidence recorded in any reviewed route"
            )


def _validate_identity_selection(
    *,
    account_records_by_url: dict[str, tuple[int, dict[str, Any]]],
    user_supplied_homepages: list[dict[str, Any]],
    candidate_evaluations: dict[str, dict[str, Any]],
    check_files: bool,
    errors: list[str],
) -> None:
    supplied_urls: set[str] = set()
    supplied_suspected_slots: set[tuple[str, str]] = set()
    for supplied_index, supplied in enumerate(user_supplied_homepages):
        if not isinstance(supplied, dict):
            continue
        canonical_url = str(supplied.get("canonical_url", ""))
        if not _is_url(canonical_url):
            continue
        supplied_urls.add(canonical_url)
        record = account_records_by_url.get(canonical_url)
        prefix = f"subject.user_supplied_homepages[{supplied_index}]"
        if record is None:
            errors.append(f"{prefix}.canonical_url: must match one delivered accounts record")
            continue
        account_index, account = record
        if account.get("status") not in DELIVERED_ACCOUNT_STATUSES:
            errors.append(
                f"{prefix}.canonical_url: accounts[{account_index}] must be confirmed or suspected_homepage"
            )
        if account.get("platform_key") != supplied.get("platform_key"):
            errors.append(f"{prefix}.platform_key: must match accounts[{account_index}]")
        if str(account.get("subplatform", "")) != str(supplied.get("subplatform", "")):
            errors.append(f"{prefix}.subplatform: must match accounts[{account_index}]")
        sources = account.get("source_urls") if isinstance(account.get("source_urls"), list) else []
        required_supplied_sources = {str(supplied.get("input_url", "")), canonical_url}
        if not required_supplied_sources.issubset(set(sources)):
            errors.append(
                f"accounts[{account_index}].source_urls: must contain both the supplied input and canonical URL"
            )
        if account.get("status") == "suspected_homepage":
            supplied_suspected_slots.add(_actual_platform_slot(account.get("platform_key"), canonical_url))

    if not check_files:
        return

    for candidate_url, evaluation in candidate_evaluations.items():
        record = account_records_by_url.get(candidate_url)
        if record is None:
            errors.append(f"identity_candidates[{candidate_url}]: candidate ledger URL has no accounts record")
            continue
        account_index, account = record
        if account.get("platform_key") != evaluation.get("candidate_platform_key"):
            errors.append(
                f"identity_candidates[{candidate_url}].candidate_platform_key: must match accounts[{account_index}]"
            )
        if str(account.get("subplatform", "")) != str(evaluation.get("candidate_subplatform", "")):
            errors.append(
                f"identity_candidates[{candidate_url}].candidate_subplatform: must match accounts[{account_index}]"
            )

    for account_url, (account_index, account) in account_records_by_url.items():
        if account_url in supplied_urls:
            continue
        if account_url not in candidate_evaluations:
            errors.append(
                f"accounts[{account_index}].url: non-user-supplied account must appear as account_candidate "
                "in a completed final reconciliation-cycle item ledger"
            )

    unresolved_by_slot: dict[tuple[str, str], list[tuple[str, dict[str, Any], dict[str, Any], int]]] = {}
    for candidate_url, evaluation in candidate_evaluations.items():
        record = account_records_by_url.get(candidate_url)
        if record is None or candidate_url in supplied_urls:
            continue
        account_index, account = record
        status = account.get("status")
        strengths = evaluation.get("anchor_strengths") if isinstance(evaluation.get("anchor_strengths"), dict) else {}
        has_confirming_anchor = any(value == "confirming" for value in strengths.values())
        has_conflict = evaluation.get("explicit_identity_conflict") is True
        name_match = evaluation.get("name_match")
        if has_conflict:
            if status != "excluded_candidate":
                errors.append(
                    f"accounts[{account_index}].status: explicit identity conflict requires excluded_candidate"
                )
            continue
        if has_confirming_anchor:
            if status != "confirmed":
                errors.append(
                    f"accounts[{account_index}].status: confirming identity anchor requires confirmed"
                )
            continue
        if name_match not in {"exact_display_name", "exact_alias"}:
            if status != "unconfirmed_candidate":
                errors.append(
                    f"accounts[{account_index}].status: non-exact candidate without confirming anchor "
                    "must remain unconfirmed_candidate"
                )
            continue
        if status not in {"suspected_homepage", "unconfirmed_candidate"}:
            errors.append(
                f"accounts[{account_index}].status: exact-name candidate without confirming anchor "
                "must be suspected_homepage or unconfirmed_candidate"
            )
        score = evaluation.get("similarity_score")
        if _is_int(score):
            slot = _actual_platform_slot(evaluation.get("candidate_platform_key"), candidate_url)
            unresolved_by_slot.setdefault(slot, []).append((candidate_url, evaluation, account, account_index))

    for slot, candidates in unresolved_by_slot.items():
        highest_score = max(int(evaluation["similarity_score"]) for _, evaluation, _, _ in candidates)
        highest = [item for item in candidates if item[1].get("similarity_score") == highest_score]
        automatically_selected = [
            item for item in candidates if item[2].get("status") == "suspected_homepage"
        ]
        if slot in supplied_suspected_slots:
            if automatically_selected:
                errors.append(
                    f"identity_candidates[{slot}]: a user-supplied suspected homepage already occupies this platform slot"
                )
            continue
        if len(highest) == 1:
            highest_url, _evaluation, highest_account, highest_index = highest[0]
            if highest_account.get("status") != "suspected_homepage":
                errors.append(
                    f"accounts[{highest_index}].status: unique highest-similarity candidate {highest_url} "
                    "must be the selected suspected_homepage"
                )
            for candidate_url, _evaluation, account, account_index in candidates:
                if candidate_url != highest_url and account.get("status") != "unconfirmed_candidate":
                    errors.append(
                        f"accounts[{account_index}].status: lower-similarity candidate must remain unconfirmed_candidate"
                    )
        else:
            if automatically_selected:
                errors.append(
                    f"identity_candidates[{slot}]: tied highest-similarity candidates forbid selecting a suspected homepage"
                )


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fingerprint_hashes(values: list[str]) -> str:
    return hashlib.sha256("|".join(sorted(values)).encode("utf-8")).hexdigest()


def _route_independence_key(route: dict[str, Any]) -> tuple[str, str, str, str, str]:
    """Use controlled provenance, not a researcher-supplied group label."""
    return (
        str(route.get("route_family", "")),
        str(route.get("evidence_origin", "")),
        str(route.get("official_product", "")),
        str(route.get("official_endpoint", "")),
        str(route.get("evidence_fingerprint", "")),
    )


def _independent_route_keys(routes: list[dict[str, Any]]) -> set[tuple[str, str, str, str, str]]:
    """Count neither shared raw evidence nor duplicate upstream provenance twice."""
    keys: set[tuple[str, str, str, str, str]] = set()
    fingerprints: set[str] = set()
    provenances: set[tuple[str, str, str, str]] = set()
    for route in routes:
        key = _route_independence_key(route)
        provenance = key[:4]
        fingerprint = key[4]
        if not all(provenance) and not (provenance[0] and provenance[1]):
            continue
        if fingerprint in fingerprints or provenance in provenances:
            continue
        fingerprints.add(fingerprint)
        provenances.add(provenance)
        keys.add(key)
    return keys


def _validate_authorization_evidence(
    value: Any,
    *,
    route: dict[str, Any],
    prefix: str,
    check_files: bool,
    errors: list[str],
) -> None:
    status = route.get("authorization_status")
    tool_kind = route.get("tool_kind")
    if tool_kind in INTERACTIVE_BROWSER_TOOL_KINDS:
        if value is not None:
            errors.append(f"{prefix}: interactive browser UI route must use null authorization_evidence")
        return
    if route.get("status") != "complete" and value is None:
        return
    if not isinstance(value, dict):
        errors.append(f"{prefix}: completed non-manual route requires hashed authorization evidence")
        return
    expected = {"kind", "source_url", "path", "sha256", "verified_at"}
    _validate_exact_fields(value, expected, prefix, errors)
    if value.get("kind") not in AUTHORIZATION_EVIDENCE_KINDS:
        errors.append(f"{prefix}.kind: invalid authorization evidence kind")
    if not _is_url(value.get("source_url")) or _is_placeholder_url(value.get("source_url")):
        errors.append(f"{prefix}.source_url: must be a real official http(s) permission/product URL")
    if not _is_nonempty_text(value.get("verified_at")):
        errors.append(f"{prefix}.verified_at: must be non-empty text")
    path_value = value.get("path")
    sha = value.get("sha256")
    if not _is_nonempty_text(path_value):
        errors.append(f"{prefix}.path: must be a sanitized local authorization-evidence file")
        return
    if not isinstance(sha, str) or not SHA256_RE.fullmatch(sha):
        errors.append(f"{prefix}.sha256: must be lowercase SHA-256")
        return
    if check_files:
        evidence_path = _path_under_root(path_value, f"{prefix}.path", errors)
        if not evidence_path.is_file():
            errors.append(f"{prefix}.path: file does not exist: {evidence_path}")
        elif _sha256(evidence_path) != sha:
            errors.append(f"{prefix}.sha256: does not match authorization evidence file")
    expected_kind = {
        "public_official_api": "official_api_terms",
        "approved_app_permission": "app_permission",
        "approved_research_access": "research_access",
        "written_platform_permission": "written_platform_permission",
        "authorized_export": "authorized_export_manifest",
    }.get(str(status))
    if expected_kind is not None and value.get("kind") != expected_kind:
        errors.append(f"{prefix}.kind: must match authorization_status {status}")


def _image_kind(path: Path) -> str | None:
    header = path.read_bytes()[:16]
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if header.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if header.startswith(b"RIFF") and len(header) >= 12 and header[8:12] == b"WEBP":
        return "webp"
    return None


def _path_under_root(value: str, prefix: str, errors: list[str]) -> Path:
    path = Path(value).resolve(strict=False)
    try:
        path.relative_to(EVIDENCE_ROOT)
    except ValueError:
        errors.append(f"{prefix}: must be under {EVIDENCE_ROOT}")
    return path


def _zoned_datetime(value: Any, prefix: str, errors: list[str]) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{prefix}: must be non-empty ISO-8601 text with a timezone offset")
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        errors.append(f"{prefix}: must be ISO-8601")
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        errors.append(f"{prefix}: must include a timezone offset")
        return None
    return parsed


def _validate_exact_fields(obj: dict[str, Any], expected: set[str], prefix: str, errors: list[str]) -> None:
    missing = sorted(expected - set(obj))
    extra = sorted(set(obj) - expected)
    if missing:
        errors.append(f"{prefix}: missing fields: {', '.join(missing)}")
    if extra:
        errors.append(f"{prefix}: unexpected/redundant fields: {', '.join(extra)}")


def _required_surfaces(platform_key: str, module_key: str, module: dict[str, Any]) -> tuple[str, ...]:
    if module_key.startswith("subplatform:"):
        return ("homepage_content",)
    if module_key in HOMEPAGE_MODULES and module.get("status") == "not_found":
        return ("account_discovery",)
    return SURFACE_MATRIX.get((platform_key, module_key), ())


def _validate_module(
    module: Any,
    *,
    module_name: str,
    prefix: str,
    valid_group_ids: set[str],
    errors: list[str],
) -> set[str]:
    if not isinstance(module, dict):
        errors.append(f"{prefix}: must be an object")
        return set()
    if module_name in HOMEPAGE_MODULES:
        expected_fields = {"status", "urls", "url_risk_group_ids", "risk_group_ids"}
        is_account_homepage = module_name in {"homepage", "subject_homepage"}
        if is_account_homepage:
            expected_fields.add("url_identity_statuses")
        _validate_exact_fields(module, expected_fields, prefix, errors)
        status = module.get("status")
        urls = module.get("urls")
        allowed_statuses = MODULE_STATUSES if is_account_homepage else {"confirmed", "not_found"}
        if status not in allowed_statuses:
            errors.append(
                f"{prefix}.status: must be "
                + ("confirmed, suspected, or not_found" if "suspected" in allowed_statuses else "confirmed or not_found")
            )
        if not isinstance(urls, list):
            errors.append(f"{prefix}.urls: must be a list")
            urls = []
        for index, url in enumerate(urls):
            if not _is_url(url) or _is_placeholder_url(url):
                errors.append(f"{prefix}.urls[{index}]: must be a real non-placeholder http(s) URL")
        if len(urls) != len(set(urls)):
            errors.append(f"{prefix}.urls: values must be unique and ordered primary-first")
        if status in {"confirmed", "suspected"} and not urls:
            errors.append(f"{prefix}.urls: {status} module requires at least one URL")
        if status == "not_found" and urls:
            errors.append(f"{prefix}.urls: must be empty when status is not_found")
        if is_account_homepage:
            identity_statuses = module.get("url_identity_statuses")
            if not isinstance(identity_statuses, dict):
                errors.append(f"{prefix}.url_identity_statuses: must be an object keyed by homepage URL")
                identity_statuses = {}
            if set(identity_statuses) != set(urls):
                errors.append(f"{prefix}.url_identity_statuses: keys must exactly equal urls")
            invalid_identity_statuses = sorted(
                {str(value) for value in identity_statuses.values()} - {"confirmed", "suspected"}
            )
            if invalid_identity_statuses:
                errors.append(
                    f"{prefix}.url_identity_statuses: invalid values: {', '.join(invalid_identity_statuses)}"
                )
            if status == "confirmed" and "confirmed" not in identity_statuses.values():
                errors.append(f"{prefix}.status: confirmed requires at least one confirmed URL")
            if status == "suspected" and (
                not identity_statuses or set(identity_statuses.values()) != {"suspected"}
            ):
                errors.append(f"{prefix}.status: suspected requires only suspected URLs")
            if status == "not_found" and identity_statuses:
                errors.append(f"{prefix}.url_identity_statuses: must be empty when status is not_found")
            seen_suspected = False
            for url in urls:
                url_status = identity_statuses.get(url)
                if url_status == "suspected":
                    seen_suspected = True
                elif url_status == "confirmed" and seen_suspected:
                    errors.append(
                        f"{prefix}.urls: confirmed URLs must precede the selected suspected homepage"
                    )
        per_url = module.get("url_risk_group_ids")
        if not isinstance(per_url, dict):
            errors.append(f"{prefix}.url_risk_group_ids: must be an object keyed by homepage URL")
            per_url = {}
        if set(per_url) != set(urls):
            errors.append(f"{prefix}.url_risk_group_ids: keys must exactly equal urls")
        per_url_union: set[str] = set()
        for url, group_list in per_url.items():
            item_prefix = f"{prefix}.url_risk_group_ids[{url!r}]"
            if not isinstance(group_list, list) or any(not _is_nonempty_text(item) for item in group_list):
                errors.append(f"{item_prefix}: must be a text list")
                continue
            if len(group_list) != len(set(group_list)):
                errors.append(f"{item_prefix}: values must be unique")
            unknown_url_groups = sorted(set(group_list) - valid_group_ids)
            if unknown_url_groups:
                errors.append(f"{item_prefix}: unknown groups: {', '.join(unknown_url_groups)}")
            per_url_union.update(group_list)
    elif module_name in SEARCH_MODULES:
        _validate_exact_fields(module, {"url", "result_status", "risk_group_ids"}, prefix, errors)
        if not _is_url(module.get("url")) or _is_placeholder_url(module.get("url")):
            errors.append(f"{prefix}.url: must be a real non-placeholder http(s) URL")
        if module.get("result_status") not in SEARCH_RESULT_STATUSES:
            errors.append(f"{prefix}.result_status: invalid final result state")
    else:
        errors.append(f"{prefix}: unsupported module type")
    ids = module.get("risk_group_ids")
    if not isinstance(ids, list) or any(not _is_nonempty_text(item) for item in ids):
        errors.append(f"{prefix}.risk_group_ids: must be a text list")
        ids = []
    if len(ids) != len(set(ids)):
        errors.append(f"{prefix}.risk_group_ids: values must be unique")
    unknown = sorted(set(ids) - valid_group_ids)
    if unknown:
        errors.append(f"{prefix}.risk_group_ids: unknown groups: {', '.join(unknown)}")
    if module_name in HOMEPAGE_MODULES and module.get("status") == "not_found" and ids:
        errors.append(f"{prefix}.risk_group_ids: not_found module cannot contain risks")
    if module_name in HOMEPAGE_MODULES and set(ids) != per_url_union:
        errors.append(f"{prefix}.risk_group_ids: must equal union of url_risk_group_ids")
    if module_name in SEARCH_MODULES:
        if ids and module.get("result_status") != "risk":
            errors.append(f"{prefix}.result_status: module with risks must be risk")
        if module.get("result_status") == "risk" and not ids:
            errors.append(f"{prefix}.risk_group_ids: risk module requires at least one group")
    return set(ids)


def _validate_identity_candidate(
    value: Any,
    *,
    platform_key: str,
    candidate_url: str,
    visible_account_name: str,
    subject_display_name: str,
    subject_aliases: set[str],
    source_inventory: set[str],
    prefix: str,
    errors: list[str],
) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        errors.append(f"{prefix}: account_candidate row requires an identity_candidate object")
        return None
    _validate_exact_fields(
        value,
        {
            "candidate_platform_key", "candidate_subplatform", "name_match",
            "all_platform_name_claim", "anchor_strengths", "explicit_identity_conflict",
            "similarity_score", "evidence_urls",
        },
        prefix,
        errors,
    )
    candidate_key = value.get("candidate_platform_key")
    recognized_named_platform = (
        _named_platform_for_url(candidate_url)
        if platform_key in {"domestic_other", "overseas_other"}
        else None
    )
    expected_candidate_key = recognized_named_platform or platform_key
    if candidate_key != expected_candidate_key:
        errors.append(
            f"{prefix}.candidate_platform_key: must equal URL-attributable platform "
            f"{expected_candidate_key!r}"
        )
    candidate_subplatform = value.get("candidate_subplatform")
    if not isinstance(candidate_subplatform, str):
        errors.append(f"{prefix}.candidate_subplatform: must be text")
        candidate_subplatform = ""
    elif candidate_key in {"domestic_other", "overseas_other"}:
        if not candidate_subplatform.strip():
            errors.append(f"{prefix}.candidate_subplatform: extra-platform candidate requires a service name")
    elif candidate_subplatform:
        errors.append(f"{prefix}.candidate_subplatform: named-platform candidate must leave this empty")
    name_match = value.get("name_match")
    if name_match not in CANDIDATE_NAME_MATCHES:
        errors.append(f"{prefix}.name_match: invalid controlled value")
    normalized_visible_name = _normalize_exact_identity_name(visible_account_name)
    normalized_display_name = _normalize_exact_identity_name(subject_display_name)
    normalized_aliases = {
        normalized
        for alias in subject_aliases
        if (normalized := _normalize_exact_identity_name(alias))
    }
    derived_name_match = (
        "exact_display_name"
        if normalized_visible_name and normalized_visible_name == normalized_display_name
        else "exact_alias"
        if normalized_visible_name and normalized_visible_name in normalized_aliases
        else "other"
    )
    if name_match != derived_name_match:
        errors.append(
            f"{prefix}.name_match: must equal validator-derived match {derived_name_match!r} "
            "from the ledger row author and subject name/aliases"
        )
    if not isinstance(value.get("all_platform_name_claim"), bool):
        errors.append(f"{prefix}.all_platform_name_claim: must be boolean")
    if not isinstance(value.get("explicit_identity_conflict"), bool):
        errors.append(f"{prefix}.explicit_identity_conflict: must be boolean")
    strengths = value.get("anchor_strengths")
    if not isinstance(strengths, dict):
        errors.append(f"{prefix}.anchor_strengths: must be an object")
        strengths = {}
    else:
        _validate_exact_fields(strengths, set(CANDIDATE_ANCHOR_NAMES), f"{prefix}.anchor_strengths", errors)
    for name in CANDIDATE_ANCHOR_NAMES:
        if strengths.get(name) not in CANDIDATE_ANCHOR_STRENGTHS:
            errors.append(f"{prefix}.anchor_strengths.{name}: invalid controlled strength")
    evidence_urls = value.get("evidence_urls")
    if not isinstance(evidence_urls, list) or any(
        not _is_url(url) or _is_placeholder_url(url) for url in evidence_urls
    ):
        errors.append(f"{prefix}.evidence_urls: must be a list of real non-placeholder URLs")
        evidence_urls = []
    elif len(evidence_urls) != len(set(evidence_urls)):
        errors.append(f"{prefix}.evidence_urls: values must be unique")
    evidence_claimed = (
        value.get("all_platform_name_claim") is True
        or value.get("explicit_identity_conflict") is True
        or any(strengths.get(name) in {"weak", "confirming"} for name in CANDIDATE_ANCHOR_NAMES)
    )
    if evidence_claimed and not evidence_urls:
        errors.append(
            f"{prefix}.evidence_urls: every claimed name statement, anchor, or conflict requires source URLs"
        )
    missing_evidence_urls = sorted(set(evidence_urls) - source_inventory)
    if missing_evidence_urls:
        errors.append(
            f"{prefix}.evidence_urls: URLs missing from coverage.source_inventory: "
            + ", ".join(missing_evidence_urls)
        )
    claimed_score = value.get("similarity_score")
    derived_score = _candidate_similarity_score(value)
    if not _is_int(claimed_score) or claimed_score != derived_score:
        errors.append(f"{prefix}.similarity_score: must equal validator-derived score {derived_score}")
    if not _is_url(candidate_url) or _is_placeholder_url(candidate_url):
        return None
    return {
        "candidate_platform_key": str(candidate_key),
        "candidate_subplatform": str(candidate_subplatform),
        "name_match": str(name_match),
        "all_platform_name_claim": value.get("all_platform_name_claim") is True,
        "anchor_strengths": {name: str(strengths.get(name)) for name in sorted(CANDIDATE_ANCHOR_NAMES)},
        "explicit_identity_conflict": value.get("explicit_identity_conflict") is True,
        "similarity_score": claimed_score,
    }


def _is_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _stable_video_identity(value: str) -> str | None:
    """Normalize recognized native video URL aliases to one platform/video key."""
    if not _is_url(value):
        return None
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    segments = [unquote(segment) for segment in parsed.path.split("/") if segment]
    lowered = [segment.casefold() for segment in segments]
    query = parse_qs(parsed.query)
    video_id: str | None = None
    family: str | None = None
    if _host_matches(host, "youtube.com"):
        if lowered[:1] == ["watch"] and query.get("v"):
            video_id = query["v"][0]
        elif lowered[:1] in (["shorts"], ["live"]) and len(segments) >= 2:
            video_id = segments[1]
        family = "youtube"
    elif _host_matches(host, "youtu.be"):
        video_id = segments[0] if segments else None
        family = "youtube"
    elif _host_matches(host, "bilibili.com") and lowered[:1] == ["video"]:
        video_id = segments[1] if len(segments) >= 2 else None
        family = "bilibili"
    elif _host_matches(host, "douyin.com") and lowered[:1] == ["video"]:
        video_id = segments[1] if len(segments) >= 2 else None
        family = "douyin"
    elif _host_matches(host, "instagram.com") and lowered[:1] in (["reel"], ["reels"], ["tv"]):
        video_id = segments[1] if len(segments) >= 2 else None
        family = "instagram"
    elif _host_matches(host, "facebook.com"):
        if parsed.path.rstrip("/").casefold() == "/watch" and query.get("v"):
            video_id = query["v"][0]
        elif lowered[:1] in (["reel"], ["reels"], ["watch"], ["videos"]):
            video_id = segments[1] if len(segments) >= 2 else None
        elif "videos" in lowered:
            marker = lowered.index("videos")
            video_id = segments[marker + 1] if len(segments) > marker + 1 else None
        family = "facebook"
    elif _host_matches(host, "zhihu.com") and lowered[:1] == ["zvideo"]:
        video_id = segments[1] if len(segments) >= 2 else None
        family = "zhihu"
    elif any(_host_matches(host, suffix) for suffix in PLATFORM_HOST_SUFFIXES["weibo"]):
        if lowered[:2] in (["tv", "show"], ["tv", "v"]) and len(segments) >= 3:
            video_id = segments[2]
        family = "weibo"
    elif _host_matches(host, "music.163.com"):
        fragment_path, separator, fragment_query_text = parsed.fragment.partition("?")
        fragment_segments = [
            unquote(segment) for segment in fragment_path.split("/") if segment
        ]
        fragment_lowered = [segment.casefold() for segment in fragment_segments]
        fragment_query = (
            parse_qs(fragment_query_text, keep_blank_values=True) if separator else {}
        )
        if fragment_lowered[:1] in (["video"], ["mv"]) and fragment_query.get("id"):
            video_id = fragment_query["id"][0]
            family = f"netease_{fragment_lowered[0]}"
    if family is None or not _is_nonempty_text(video_id):
        return None
    return f"{family}:{str(video_id).strip()}"


def _stable_content_identity(value: str) -> str | None:
    """Normalize stable content URLs without implying that every item is a video."""
    video_identity = _stable_video_identity(value)
    if video_identity is not None:
        return video_identity
    if not _is_url(value):
        return None
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    segments = [unquote(segment) for segment in parsed.path.split("/") if segment]
    lowered = [segment.casefold() for segment in segments]
    content_id: str | None = None
    family: str | None = None
    if _host_matches(host, "xiaohongshu.com"):
        if lowered[:1] == ["explore"] and len(segments) >= 2:
            content_id = segments[1]
        elif lowered[:2] == ["discovery", "item"] and len(segments) >= 3:
            content_id = segments[2]
        family = "xiaohongshu_note"
    elif _host_matches(host, "x.com") or _host_matches(host, "twitter.com"):
        if "status" in lowered:
            marker = lowered.index("status")
            content_id = segments[marker + 1] if len(segments) > marker + 1 else None
        family = "x_status"
    elif _host_matches(host, "instagram.com") and lowered[:1] == ["p"]:
        content_id = segments[1] if len(segments) >= 2 else None
        family = "instagram_post"
    if family is None or not _is_nonempty_text(content_id):
        return None
    return f"{family}:{str(content_id).strip()}"


def _canonical_rank_url(value: str) -> str:
    """Return a deterministic canonical URL for de-duplication and Top-10 ties."""
    stable_identity = _stable_content_identity(value)
    if stable_identity is not None:
        family, video_id = stable_identity.split(":", 1)
        encoded_id = quote(video_id, safe="-._~:")
        canonical_video_urls = {
            "youtube": f"https://www.youtube.com/watch?v={quote(video_id, safe='-._~')}",
            "bilibili": f"https://www.bilibili.com/video/{encoded_id}",
            "douyin": f"https://www.douyin.com/video/{encoded_id}",
            "instagram": f"https://www.instagram.com/reel/{encoded_id}",
            "facebook": f"https://www.facebook.com/videos/{encoded_id}",
            "zhihu": f"https://www.zhihu.com/zvideo/{encoded_id}",
            "weibo": f"https://weibo.com/tv/show/{encoded_id}",
            "netease_video": f"https://music.163.com/#/video?id={encoded_id}",
            "netease_mv": f"https://music.163.com/#/mv?id={encoded_id}",
            "xiaohongshu_note": f"https://www.xiaohongshu.com/explore/{encoded_id}",
            "x_status": f"https://x.com/i/status/{encoded_id}",
            "instagram_post": f"https://www.instagram.com/p/{encoded_id}",
        }
        return canonical_video_urls[family]
    parsed = urlparse(value)
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/")
    normalized_query = urlencode(sorted(parse_qsl(parsed.query, keep_blank_values=True)), doseq=True)
    return parsed._replace(
        scheme=parsed.scheme.lower(),
        netloc=parsed.netloc.lower(),
        path=path,
        query=normalized_query,
        # Unknown hash-router fragments may carry the content identity. Keep
        # them by default; recognized stable identities above deliberately
        # replace the entire URL with a fragment/query-free canonical form.
        fragment=parsed.fragment,
    ).geturl()


def _parse_explicit_play_count(value: Any) -> int | None:
    """Parse only common, unambiguous playback-count forms; never guess free prose."""
    if not _is_nonempty_text(value):
        return None
    text = str(value).strip()
    if re.search(r"\d[ \t\u00a0\u202f]+\d", text):
        # Space-grouped numbers are locale-dependent. Reject the whole token
        # instead of starting a false match at its final group.
        return None
    match = (
        PLAY_COUNT_ONLY_RE.fullmatch(text)
        or PLAY_COUNT_SUFFIX_RE.search(text)
        or PLAY_COUNT_PREFIX_RE.search(text)
    )
    if match is None:
        return None
    number_text = match.group(1).replace(",", "")
    unit = (match.group(2) or "").casefold()
    multipliers = {
        "": Decimal(1), "k": Decimal(1000), "m": Decimal(1000000),
        "b": Decimal(1000000000), "万": Decimal(10000), "亿": Decimal(100000000),
    }
    try:
        normalized = Decimal(number_text) * multipliers[unit]
    except (InvalidOperation, KeyError):
        return None
    if normalized < 0 or normalized != normalized.to_integral_value():
        return None
    return int(normalized)


def _validate_native_rank_evidence(
    value: Any,
    *,
    account_url: str | None,
    item_url: str,
    observed_at: Any,
    prefix: str,
    errors: list[str],
) -> dict[str, Any]:
    result = {"native_rank": None, "native_rank_provenance": None}
    initial_error_count = len(errors)
    if not isinstance(value, dict):
        errors.append(f"{prefix}: requires exactly path and sha256")
        return result
    _validate_exact_fields(value, {"path", "sha256"}, prefix, errors)
    path_value = value.get("path")
    expected_sha = value.get("sha256")
    if not _is_nonempty_text(path_value):
        errors.append(f"{prefix}.path: must be a non-empty evidence path")
        return result
    if not isinstance(expected_sha, str) or not SHA256_RE.fullmatch(expected_sha):
        errors.append(f"{prefix}.sha256: must be lowercase SHA-256")
    path = _path_under_root(str(path_value), f"{prefix}.path", errors)
    if path.suffix.lower() != ".json":
        errors.append(f"{prefix}.path: native rank evidence must be UTF-8 JSON")
    if not path.is_file():
        errors.append(f"{prefix}.path: file does not exist: {path}")
        return result
    if isinstance(expected_sha, str) and SHA256_RE.fullmatch(expected_sha) and _sha256(path) != expected_sha:
        errors.append(f"{prefix}.sha256: does not match native rank evidence")
    try:
        evidence = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"{prefix}.path: invalid UTF-8 JSON: {exc}")
        return result
    if not isinstance(evidence, dict):
        errors.append(f"{prefix}.path: native rank evidence must contain one object")
        return result
    _validate_exact_fields(evidence, NATIVE_RANK_EVIDENCE_FIELDS, f"{prefix}.file", errors)
    if account_url is None:
        errors.append(f"{prefix}: native account ranking is allowed only for a delivered account route")
    elif evidence.get("source_account_url") != account_url:
        errors.append(f"{prefix}.file.source_account_url: must equal the delivered account URL")
    if evidence.get("source_video_url") != item_url:
        errors.append(f"{prefix}.file.source_video_url: must equal the reviewed item URL")
    if evidence.get("source_surface") != NATIVE_RANK_SOURCE_SURFACE:
        errors.append(
            f"{prefix}.file.source_surface: must equal {NATIVE_RANK_SOURCE_SURFACE}; "
            "search and third-party rankings are not account-native evidence"
        )
    if evidence.get("sort_mode") not in NATIVE_RANK_SORT_MODES:
        errors.append(f"{prefix}.file.sort_mode: must be popular or most_viewed")
    if evidence.get("ranking_scope") != NATIVE_RANK_SCOPE:
        errors.append(
            f"{prefix}.file.ranking_scope: must equal {NATIVE_RANK_SCOPE}; "
            "search or per-surface order cannot prove account-wide Top 10"
        )
    native_rank = evidence.get("native_rank")
    if not _is_int(native_rank) or native_rank <= 0:
        errors.append(f"{prefix}.file.native_rank: must be a positive integer")
        native_rank_value: int | None = None
    else:
        native_rank_value = native_rank
        result["native_rank"] = native_rank
    if not _is_nonempty_text(evidence.get("visible_order_text")):
        errors.append(f"{prefix}.file.visible_order_text: must preserve the visible native-order label")
    if evidence.get("observed_at") != observed_at:
        errors.append(f"{prefix}.file.observed_at: must equal video_metadata.observed_at")
    _zoned_datetime(evidence.get("observed_at"), f"{prefix}.file.observed_at", errors)

    snapshot_path_value = evidence.get("ranking_snapshot_path")
    snapshot_sha = evidence.get("ranking_snapshot_sha256")
    if not _is_nonempty_text(snapshot_path_value):
        errors.append(f"{prefix}.file.ranking_snapshot_path: must be a non-empty account snapshot path")
        return result
    if not isinstance(snapshot_sha, str) or not SHA256_RE.fullmatch(snapshot_sha):
        errors.append(f"{prefix}.file.ranking_snapshot_sha256: must be lowercase SHA-256")
    snapshot_path = _path_under_root(
        str(snapshot_path_value), f"{prefix}.file.ranking_snapshot_path", errors,
    )
    if snapshot_path.suffix.lower() != ".json":
        errors.append(f"{prefix}.file.ranking_snapshot_path: must be a UTF-8 JSON snapshot")
    if not snapshot_path.is_file():
        errors.append(f"{prefix}.file.ranking_snapshot_path: file does not exist: {snapshot_path}")
        return result
    if (
        isinstance(snapshot_sha, str)
        and SHA256_RE.fullmatch(snapshot_sha)
        and _sha256(snapshot_path) != snapshot_sha
    ):
        errors.append(f"{prefix}.file.ranking_snapshot_sha256: does not match account snapshot")
    try:
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"{prefix}.file.ranking_snapshot_path: invalid UTF-8 JSON: {exc}")
        return result
    if not isinstance(snapshot, dict):
        errors.append(f"{prefix}.file.ranking_snapshot_path: account snapshot must contain one object")
        return result
    _validate_exact_fields(snapshot, NATIVE_RANK_SNAPSHOT_FIELDS, f"{prefix}.snapshot", errors)
    for field in ("source_account_url", "source_surface", "sort_mode", "ranking_scope", "observed_at"):
        if snapshot.get(field) != evidence.get(field):
            errors.append(f"{prefix}.snapshot.{field}: must equal the per-item native-rank evidence")
    ordered_urls = snapshot.get("ordered_video_urls")
    normalized_snapshot_identities: list[str] = []
    if (
        not isinstance(ordered_urls, list)
        or not ordered_urls
        or any(not _is_url(snapshot_url) for snapshot_url in ordered_urls)
    ):
        errors.append(f"{prefix}.snapshot.ordered_video_urls: must be a non-empty URL list")
    else:
        for snapshot_url in ordered_urls:
            normalized_snapshot_identities.append(
                _stable_content_identity(str(snapshot_url)) or f"url:{_canonical_rank_url(str(snapshot_url))}"
            )
        if len(normalized_snapshot_identities) != len(set(normalized_snapshot_identities)):
            errors.append(
                f"{prefix}.snapshot.ordered_video_urls: stable video identities must be unique"
            )
        if native_rank_value is not None:
            if native_rank_value > len(normalized_snapshot_identities):
                errors.append(f"{prefix}.file.native_rank: exceeds the account snapshot length")
            else:
                item_identity = _stable_content_identity(item_url) or f"url:{_canonical_rank_url(item_url)}"
                if normalized_snapshot_identities[native_rank_value - 1] != item_identity:
                    errors.append(
                        f"{prefix}.file.native_rank: snapshot item at this rank is not the reviewed video"
                    )
    if len(errors) == initial_error_count:
        result["native_rank_provenance"] = (
            str(snapshot_path).casefold(), str(snapshot_sha), evidence.get("source_account_url"),
            evidence.get("source_surface"), evidence.get("sort_mode"), evidence.get("ranking_scope"),
            evidence.get("observed_at"),
        )
    return result


def _validate_video_metadata(
    value: Any,
    *,
    row: dict[str, Any],
    account_url: str | None,
    route_started_at: datetime | None,
    route_completed_at: datetime | None,
    prefix: str,
    errors: list[str],
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "play_count_status": None,
        "play_count": None,
        "native_rank": None,
        "native_rank_provenance": None,
        "observed_at": None,
    }
    if not isinstance(value, dict):
        errors.append(f"{prefix}: every real video requires an exact video_metadata object")
        return result
    _validate_exact_fields(value, VIDEO_METADATA_FIELDS, prefix, errors)
    item_url = str(row.get("url", ""))
    if value.get("detail_url") != item_url:
        errors.append(f"{prefix}.detail_url: must equal the direct reviewed item URL")
    if value.get("detail_capture_kind") != VIDEO_DETAIL_CAPTURE_KIND:
        errors.append(f"{prefix}.detail_capture_kind: must equal {VIDEO_DETAIL_CAPTURE_KIND}")

    title_state = value.get("title_state")
    if title_state not in VIDEO_TEXT_STATES:
        errors.append(f"{prefix}.title_state: must be present or empty_on_source")
    elif (title_state == "present") != _is_nonempty_text(row.get("title")):
        errors.append(f"{prefix}.title_state: must match the complete detail-page title")

    description_state = value.get("description_state")
    if description_state not in VIDEO_DESCRIPTION_STATES:
        errors.append(f"{prefix}.description_state: must be complete_expanded or empty_on_source")
    elif (description_state == "complete_expanded") != _is_nonempty_text(row.get("text")):
        errors.append(f"{prefix}.description_state: must match the complete expanded detail-page description")

    cover_state = value.get("cover_state")
    cover_path_value = value.get("cover_path")
    cover_sha = value.get("cover_sha256")
    if cover_state not in VIDEO_TEXT_STATES:
        errors.append(f"{prefix}.cover_state: must be present or empty_on_source")
    elif cover_state == "empty_on_source":
        if cover_path_value is not None or cover_sha is not None:
            errors.append(f"{prefix}: empty_on_source cover requires null cover_path and cover_sha256")
    else:
        if not _is_nonempty_text(cover_path_value):
            errors.append(f"{prefix}.cover_path: present cover requires a non-empty path")
        if not isinstance(cover_sha, str) or not SHA256_RE.fullmatch(cover_sha):
            errors.append(f"{prefix}.cover_sha256: present cover requires lowercase SHA-256")
        if _is_nonempty_text(cover_path_value):
            cover_path = _path_under_root(str(cover_path_value), f"{prefix}.cover_path", errors)
            if not cover_path.is_file():
                errors.append(f"{prefix}.cover_path: file does not exist: {cover_path}")
            else:
                if isinstance(cover_sha, str) and SHA256_RE.fullmatch(cover_sha) and _sha256(cover_path) != cover_sha:
                    errors.append(f"{prefix}.cover_sha256: does not match cover file")
                if _image_kind(cover_path) is None:
                    errors.append(f"{prefix}.cover_path: cover must be PNG, JPEG, or WebP")

    status = value.get("play_count_status")
    result["play_count_status"] = status
    if status not in VIDEO_PLAY_COUNT_STATUSES:
        errors.append(f"{prefix}.play_count_status: invalid controlled value")
    if not _is_nonempty_text(value.get("play_count_source_text")):
        errors.append(f"{prefix}.play_count_source_text: must preserve the visible value or exact unavailable reason")
    parsed_source_count = _parse_explicit_play_count(value.get("play_count_source_text"))
    play_count = value.get("play_count")
    if status == "observed":
        if not _is_int(play_count) or play_count < 0:
            errors.append(f"{prefix}.play_count: observed playback count must be a non-negative integer")
        else:
            result["play_count"] = play_count
            if parsed_source_count is not None and play_count != parsed_source_count:
                errors.append(
                    f"{prefix}.play_count: must equal the unambiguous normalized value in "
                    "play_count_source_text"
                )
    elif play_count is not None:
        errors.append(f"{prefix}.play_count: only observed status may carry a numeric value")
    elif parsed_source_count is not None:
        errors.append(
            f"{prefix}.play_count_status: non-observed status contradicts the explicit playback "
            "count in play_count_source_text"
        )
    if account_url is not None and status == "not_applicable":
        errors.append(f"{prefix}.play_count_status: delivered-account video cannot use not_applicable")
    if account_url is None and status == "native_top_rank":
        errors.append(f"{prefix}.play_count_status: search/non-account video cannot claim native_top_rank")

    observed_at = _zoned_datetime(value.get("observed_at"), f"{prefix}.observed_at", errors)
    result["observed_at"] = observed_at
    if (
        observed_at is not None
        and route_started_at is not None
        and observed_at < route_started_at
    ) or (
        observed_at is not None
        and route_completed_at is not None
        and observed_at > route_completed_at
    ):
        errors.append(f"{prefix}.observed_at: must fall inside its corresponding route interval")
    rank_evidence = value.get("native_rank_evidence")
    if rank_evidence is not None:
        if status not in {"observed", "native_top_rank"}:
            errors.append(
                f"{prefix}.native_rank_evidence: only observed or native_top_rank may carry native order evidence"
            )
        rank_result = _validate_native_rank_evidence(
            rank_evidence,
            account_url=account_url,
            item_url=item_url,
            observed_at=value.get("observed_at"),
            prefix=f"{prefix}.native_rank_evidence",
            errors=errors,
        )
        result.update(rank_result)
    elif status == "native_top_rank":
        errors.append(f"{prefix}.native_rank_evidence: native_top_rank requires hashed account-wide rank evidence")
    return result


def _published_rank_key(value: Any) -> tuple[int, int, int, int, int, int, int]:
    """Unknown/invalid publication dates sort after every valid date."""
    if not _is_nonempty_text(value):
        return (0, 0, 0, 0, 0, 0, 0)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed_date = date.fromisoformat(str(value))
        except ValueError:
            return (0, 0, 0, 0, 0, 0, 0)
        return (parsed_date.year, parsed_date.month, parsed_date.day, 0, 0, 0, 0)
    if parsed.tzinfo is not None and parsed.utcoffset() is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return (
        parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, parsed.second,
        parsed.microsecond,
    )


def _validate_frame_manifest(
    path_value: Any,
    expected_sha256: Any,
    *,
    item_url: str,
    sampled_timestamps: list[float],
    keyframe_timestamps: list[float],
    prefix: str,
    errors: list[str],
) -> dict[float, tuple[str, str, set[str]]]:
    frames: dict[float, tuple[str, str, set[str]]] = {}
    if not _is_nonempty_text(path_value):
        errors.append(f"{prefix}: frame manifest path is required")
        return frames
    if not isinstance(expected_sha256, str) or not SHA256_RE.fullmatch(expected_sha256):
        errors.append(f"{prefix.replace('_path', '_sha256')}: must be lowercase SHA-256")
    path = _path_under_root(str(path_value), prefix, errors)
    if path.suffix.lower() != ".jsonl":
        errors.append(f"{prefix}: must be a UTF-8 JSONL file")
    if not path.is_file():
        errors.append(f"{prefix}: file does not exist: {path}")
        return frames
    if isinstance(expected_sha256, str) and SHA256_RE.fullmatch(expected_sha256) and _sha256(path) != expected_sha256:
        errors.append(f"{prefix.replace('_path', '_sha256')}: does not match frame manifest")
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except UnicodeError:
        errors.append(f"{prefix}: must be UTF-8 text")
        return frames
    required = {"source_video_url", "timestamp_seconds", "frame_path", "frame_sha256", "capture_kinds"}
    seen_frame_paths: set[str] = set()
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        row_prefix = f"{prefix}:{line_number}"
        try:
            frame = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"{row_prefix}: invalid JSON: {exc.msg}")
            continue
        if not isinstance(frame, dict):
            errors.append(f"{row_prefix}: row must be an object")
            continue
        _validate_exact_fields(frame, required, row_prefix, errors)
        if frame.get("source_video_url") != item_url:
            errors.append(f"{row_prefix}.source_video_url: must equal the reviewed item URL")
        timestamp = frame.get("timestamp_seconds")
        if not _is_number(timestamp):
            errors.append(f"{row_prefix}.timestamp_seconds: must be a finite number")
            continue
        timestamp_value = float(timestamp)
        if timestamp_value in frames:
            errors.append(f"{row_prefix}.timestamp_seconds: duplicate sampled timestamp")
        frame_path_value = frame.get("frame_path")
        frame_sha = frame.get("frame_sha256")
        capture_kinds = frame.get("capture_kinds")
        if (
            not isinstance(capture_kinds, list)
            or not capture_kinds
            or any(kind not in FRAME_CAPTURE_KINDS for kind in capture_kinds)
        ):
            errors.append(
                f"{row_prefix}.capture_kinds: must be a non-empty list using only "
                f"{sorted(FRAME_CAPTURE_KINDS)!r}"
            )
            capture_kind_set: set[str] = set()
        else:
            capture_kind_set = set(capture_kinds)
            if len(capture_kinds) != len(capture_kind_set):
                errors.append(f"{row_prefix}.capture_kinds: values must be unique")
        if not _is_nonempty_text(frame_path_value):
            errors.append(f"{row_prefix}.frame_path: must be non-empty")
        if not isinstance(frame_sha, str) or not SHA256_RE.fullmatch(frame_sha):
            errors.append(f"{row_prefix}.frame_sha256: must be lowercase SHA-256")
        if _is_nonempty_text(frame_path_value):
            normalized_frame_path = str(_path_under_root(str(frame_path_value), f"{row_prefix}.frame_path", errors))
            if normalized_frame_path in seen_frame_paths:
                errors.append(f"{row_prefix}.frame_path: one frame file cannot represent two timestamps")
            seen_frame_paths.add(normalized_frame_path)
            frame_path = Path(normalized_frame_path)
            if not frame_path.is_file():
                errors.append(f"{row_prefix}.frame_path: file does not exist: {frame_path}")
            else:
                if isinstance(frame_sha, str) and SHA256_RE.fullmatch(frame_sha) and _sha256(frame_path) != frame_sha:
                    errors.append(f"{row_prefix}.frame_sha256: does not match frame file")
                if _image_kind(frame_path) is None:
                    errors.append(f"{row_prefix}.frame_path: frame must be PNG, JPEG, or WebP")
            frames[timestamp_value] = (normalized_frame_path, str(frame_sha), capture_kind_set)
    if set(frames) != set(sampled_timestamps):
        missing = sorted(set(sampled_timestamps) - set(frames))
        extra = sorted(set(frames) - set(sampled_timestamps))
        if missing:
            errors.append(f"{prefix}: missing sampled timestamp rows: {missing}")
        if extra:
            errors.append(f"{prefix}: unexpected timestamp rows: {extra}")
    for timestamp in keyframe_timestamps:
        record = frames.get(timestamp)
        if record is not None and not (record[2] & {"keyframe", "scene_change"}):
            errors.append(
                f"{prefix}: keyframe/scene-change timestamp {timestamp:g} requires the corresponding "
                "capture_kinds marker"
            )
    return frames


def _validate_audio_timeline(
    path_value: Any,
    expected_sha256: Any,
    *,
    item_url: str,
    duration: float,
    prefix: str,
    errors: list[str],
) -> None:
    if not _is_nonempty_text(path_value):
        errors.append(f"{prefix}: full-audio timeline path is required")
        return
    if not isinstance(expected_sha256, str) or not SHA256_RE.fullmatch(expected_sha256):
        errors.append(f"{prefix.replace('_path', '_sha256')}: must be lowercase SHA-256")
    path = _path_under_root(str(path_value), prefix, errors)
    if path.suffix.lower() != ".jsonl":
        errors.append(f"{prefix}: must be a UTF-8 JSONL timeline")
    if not path.is_file():
        errors.append(f"{prefix}: file does not exist: {path}")
        return
    if isinstance(expected_sha256, str) and SHA256_RE.fullmatch(expected_sha256) and _sha256(path) != expected_sha256:
        errors.append(f"{prefix.replace('_path', '_sha256')}: does not match audio timeline")
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except UnicodeError:
        errors.append(f"{prefix}: must be UTF-8 text")
        return
    required = {"source_video_url", "start_seconds", "end_seconds", "text", "segment_kind"}
    intervals: list[tuple[float, float]] = []
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        row_prefix = f"{prefix}:{line_number}"
        try:
            segment = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"{row_prefix}: invalid JSON: {exc.msg}")
            continue
        if not isinstance(segment, dict):
            errors.append(f"{row_prefix}: row must be an object")
            continue
        _validate_exact_fields(segment, required, row_prefix, errors)
        if segment.get("source_video_url") != item_url:
            errors.append(f"{row_prefix}.source_video_url: must equal the reviewed item URL")
        start = segment.get("start_seconds")
        end = segment.get("end_seconds")
        if not _is_number(start) or not _is_number(end):
            errors.append(f"{row_prefix}: start_seconds and end_seconds must be finite numbers")
        else:
            start_value = float(start)
            end_value = float(end)
            if not (0 <= start_value < end_value <= duration):
                errors.append(f"{row_prefix}: interval must satisfy 0 <= start < end <= duration_seconds")
            intervals.append((start_value, end_value))
        segment_kind = segment.get("segment_kind")
        if segment_kind not in AUDIO_SEGMENT_KINDS:
            errors.append(f"{row_prefix}.segment_kind: invalid controlled value")
        elif segment_kind == "unintelligible":
            errors.append(
                f"{row_prefix}.segment_kind: unintelligible audio must be recorded honestly but "
                "cannot support completed full-audio review"
            )
        text_value = segment.get("text")
        if not isinstance(text_value, str):
            errors.append(f"{row_prefix}.text: must be text")
        elif segment_kind != "silence" and not text_value.strip():
            errors.append(f"{row_prefix}.text: non-silence segment requires transcript/subtitle text")
    if not intervals:
        errors.append(f"{prefix}: must contain at least one timed audio segment")
        return
    if abs(intervals[0][0]) > 0.001:
        errors.append(f"{prefix}: first segment must start at 0")
    for index, ((previous_start, previous_end), (current_start, current_end)) in enumerate(
        zip(intervals, intervals[1:]), 2
    ):
        if current_start < previous_start:
            errors.append(f"{prefix}:{index}: segments must be in ascending timeline order")
        if abs(current_start - previous_end) > 0.001:
            errors.append(f"{prefix}:{index}: audio timeline must be continuous without gaps or overlaps")
    if abs(intervals[-1][1] - duration) > 0.001:
        errors.append(f"{prefix}: final segment must end at duration_seconds")


def _validate_video_review_evidence(
    value: Any,
    *,
    row: dict[str, Any],
    risk_terms_sha256: str,
    prefix: str,
    errors: list[str],
) -> None:
    if not isinstance(value, dict):
        errors.append(f"{prefix}: video item requires a video_review_evidence object")
        return
    expected = {
        "duration_seconds", "timeline_start_seconds", "timeline_end_seconds",
        "sampling_method", "max_sampling_interval_seconds", "sampled_frame_timestamps_seconds",
        "keyframe_scene_change_timestamps_seconds", "keyframe_scene_change_reviewed",
        "frame_manifest_path", "frame_manifest_sha256",
        "full_audio_coverage", "audio_scan_method", "audio_text_path", "audio_text_sha256",
        "audio_risk_terms_sha256", "ocr_visual_sensitive_elements_reviewed", "hits",
    }
    _validate_exact_fields(value, expected, prefix, errors)
    duration = value.get("duration_seconds")
    start = value.get("timeline_start_seconds")
    end = value.get("timeline_end_seconds")
    max_interval = value.get("max_sampling_interval_seconds")
    if not _is_number(duration) or duration <= 0:
        errors.append(f"{prefix}.duration_seconds: must be a positive number")
        duration = 0.0
    else:
        duration = float(duration)
    if not _is_number(start) or float(start) != 0.0:
        errors.append(f"{prefix}.timeline_start_seconds: must equal 0")
    if not _is_number(end) or abs(float(end) - duration) > 0.001:
        errors.append(f"{prefix}.timeline_end_seconds: must equal duration_seconds")
    if value.get("sampling_method") != VIDEO_SAMPLING_METHOD:
        errors.append(
            f"{prefix}.sampling_method: must equal {VIDEO_SAMPLING_METHOD!r}"
        )
    if not _is_number(max_interval) or not (0 < float(max_interval) <= 10):
        errors.append(f"{prefix}.max_sampling_interval_seconds: must be greater than 0 and at most 10")
        max_interval_value = 10.0
    else:
        max_interval_value = float(max_interval)
    samples = value.get("sampled_frame_timestamps_seconds")
    valid_samples: list[float] = []
    if not isinstance(samples, list) or len(samples) < 2 or any(not _is_number(item) for item in samples):
        errors.append(f"{prefix}.sampled_frame_timestamps_seconds: must contain at least two numeric timestamps")
    else:
        valid_samples = [float(item) for item in samples]
        if valid_samples != sorted(set(valid_samples)):
            errors.append(f"{prefix}.sampled_frame_timestamps_seconds: must be strictly increasing and unique")
        if valid_samples and abs(valid_samples[0]) > 0.001:
            errors.append(f"{prefix}.sampled_frame_timestamps_seconds: first sample must be 0")
        if valid_samples and abs(valid_samples[-1] - duration) > 0.001:
            errors.append(f"{prefix}.sampled_frame_timestamps_seconds: last sample must equal duration_seconds")
        if any(item < 0 or item > duration for item in valid_samples):
            errors.append(f"{prefix}.sampled_frame_timestamps_seconds: timestamps must stay within the full timeline")
        if any(
            later - earlier > max_interval_value + 0.001
            for earlier, later in zip(valid_samples, valid_samples[1:])
        ):
            errors.append(
                f"{prefix}.sampled_frame_timestamps_seconds: every sampling gap must be at most "
                "max_sampling_interval_seconds (and therefore at most 10 seconds)"
            )
    keyframes = value.get("keyframe_scene_change_timestamps_seconds")
    normalized_keyframes: list[float] = []
    if not isinstance(keyframes, list) or any(not _is_number(item) for item in keyframes):
        errors.append(f"{prefix}.keyframe_scene_change_timestamps_seconds: must be a numeric list")
    else:
        normalized_keyframes = [float(item) for item in keyframes]
        if normalized_keyframes != sorted(set(normalized_keyframes)):
            errors.append(f"{prefix}.keyframe_scene_change_timestamps_seconds: must be increasing and unique")
        if any(item < 0 or item > duration for item in normalized_keyframes):
            errors.append(f"{prefix}.keyframe_scene_change_timestamps_seconds: timestamps must stay within the video")
        sample_set = set(valid_samples)
        if any(item not in sample_set for item in normalized_keyframes):
            errors.append(
                f"{prefix}.keyframe_scene_change_timestamps_seconds: every detected keyframe/scene-change "
                "timestamp must also be preserved in sampled_frame_timestamps_seconds"
            )
    if value.get("keyframe_scene_change_reviewed") is not True:
        errors.append(f"{prefix}.keyframe_scene_change_reviewed: must be true")
    item_url = str(row.get("url", ""))
    frame_records = _validate_frame_manifest(
        value.get("frame_manifest_path"), value.get("frame_manifest_sha256"),
        item_url=item_url,
        sampled_timestamps=valid_samples,
        keyframe_timestamps=normalized_keyframes,
        prefix=f"{prefix}.frame_manifest_path",
        errors=errors,
    )
    if value.get("full_audio_coverage") is not True:
        errors.append(f"{prefix}.full_audio_coverage: must be true")
    if value.get("audio_scan_method") not in VIDEO_AUDIO_SCAN_METHODS:
        errors.append(f"{prefix}.audio_scan_method: invalid full-audio scan method")
    if value.get("audio_risk_terms_sha256") != risk_terms_sha256:
        errors.append(f"{prefix}.audio_risk_terms_sha256: must match the route's full risk_terms_sha256")
    if value.get("ocr_visual_sensitive_elements_reviewed") is not True:
        errors.append(f"{prefix}.ocr_visual_sensitive_elements_reviewed: must be true")
    audio_path_value = value.get("audio_text_path")
    audio_sha = value.get("audio_text_sha256")
    _validate_audio_timeline(
        audio_path_value, audio_sha,
        item_url=item_url,
        duration=duration,
        prefix=f"{prefix}.audio_text_path",
        errors=errors,
    )
    hits = value.get("hits")
    if not isinstance(hits, list):
        errors.append(f"{prefix}.hits: must be a list")
        hits = []
    if row.get("risk_decision") != "no_risk" and not hits:
        errors.append(f"{prefix}.hits: every risk/false-positive/out-of-scope video decision requires hit evidence")
    hit_fields = {
        "source_video_url", "timestamp_seconds", "context_start_seconds", "context_end_seconds",
        "evidence_kind", "evidence_path", "evidence_sha256",
        "original_or_transcript", "context", "conclusion",
    }
    for index, hit in enumerate(hits):
        hit_prefix = f"{prefix}.hits[{index}]"
        if not isinstance(hit, dict):
            errors.append(f"{hit_prefix}: must be an object")
            continue
        _validate_exact_fields(hit, hit_fields, hit_prefix, errors)
        if hit.get("source_video_url") != item_url:
            errors.append(f"{hit_prefix}.source_video_url: must equal the reviewed item URL")
        timestamp = hit.get("timestamp_seconds")
        context_start = hit.get("context_start_seconds")
        context_end = hit.get("context_end_seconds")
        if not _is_number(timestamp) or not (0 <= float(timestamp) <= duration):
            errors.append(f"{hit_prefix}.timestamp_seconds: must be within the video timeline")
            timestamp_value = 0.0
        else:
            timestamp_value = float(timestamp)
        minimum_start = max(0.0, timestamp_value - 15.0)
        minimum_end = min(duration, timestamp_value + 15.0)
        if (
            not _is_number(context_start)
            or not (0 <= float(context_start) <= timestamp_value)
            or float(context_start) > minimum_start + 0.001
        ):
            errors.append(
                f"{hit_prefix}.context_start_seconds: must be within the video and preserve at "
                "least 15 seconds before the hit, truncated only at 0"
            )
        if (
            not _is_number(context_end)
            or not (timestamp_value <= float(context_end) <= duration)
            or float(context_end) < minimum_end - 0.001
        ):
            errors.append(
                f"{hit_prefix}.context_end_seconds: must be within the video and preserve at "
                "least 15 seconds after the hit, truncated only at video end"
            )
        evidence_kind = hit.get("evidence_kind")
        if evidence_kind not in VIDEO_HIT_EVIDENCE_KINDS:
            errors.append(f"{hit_prefix}.evidence_kind: invalid value")
        evidence_path_value = hit.get("evidence_path")
        evidence_sha = hit.get("evidence_sha256")
        if not _is_nonempty_text(evidence_path_value):
            errors.append(f"{hit_prefix}.evidence_path: must be non-empty")
        if not isinstance(evidence_sha, str) or not SHA256_RE.fullmatch(evidence_sha):
            errors.append(f"{hit_prefix}.evidence_sha256: must be lowercase SHA-256")
        if _is_nonempty_text(evidence_path_value):
            evidence_path = _path_under_root(str(evidence_path_value), f"{hit_prefix}.evidence_path", errors)
            if not evidence_path.is_file():
                errors.append(f"{hit_prefix}.evidence_path: file does not exist: {evidence_path}")
            else:
                if isinstance(evidence_sha, str) and SHA256_RE.fullmatch(evidence_sha) and _sha256(evidence_path) != evidence_sha:
                    errors.append(f"{hit_prefix}.evidence_sha256: does not match evidence file")
                if evidence_kind in {"screenshot", "frame"} and _image_kind(evidence_path) is None:
                    errors.append(f"{hit_prefix}.evidence_path: screenshot/frame evidence must be PNG, JPEG, or WebP")
        if evidence_kind in {"screenshot", "frame"} and _is_number(timestamp):
            frame_record = frame_records.get(float(timestamp))
            if frame_record is None:
                errors.append(
                    f"{hit_prefix}: screenshot/frame hit timestamp must exist in the frame manifest"
                )
            elif (
                str(Path(str(evidence_path_value)).resolve(strict=False)) != frame_record[0]
                or evidence_sha != frame_record[1]
            ):
                errors.append(
                    f"{hit_prefix}: screenshot/frame hit path and hash must match the frame-manifest row "
                    "at timestamp_seconds"
                )
        if evidence_kind == "transcript_excerpt" and (
            str(Path(str(evidence_path_value)).resolve(strict=False))
            != str(Path(str(audio_path_value)).resolve(strict=False))
            or evidence_sha != audio_sha
        ):
            errors.append(
                f"{hit_prefix}: transcript_excerpt hit must bind to the validated full-audio timeline path and hash"
            )
        for field in ("original_or_transcript", "context", "conclusion"):
            if not _is_nonempty_text(hit.get(field)):
                errors.append(f"{hit_prefix}.{field}: must be non-empty text")


def _validate_item_ledger(
    path: Path,
    *,
    prefix: str,
    platform_key: str,
    module_key: str,
    subject_display_name: str,
    subject_aliases: set[str],
    source_inventory: set[str],
    route_origin_url: str,
    expected_surface: str,
    expected_origin_url: str | None,
    query_counts: dict[str, int] | None,
    expected_count: int,
    valid_group_ids: set[str],
    risk_terms_sha256: str,
    account_url: str | None,
    route_started_at: datetime | None,
    route_completed_at: datetime | None,
    errors: list[str],
) -> tuple[
    set[tuple[str, str, str, str, str]], set[str], set[tuple[str, str]], dict[str, dict[str, Any]],
    list[dict[str, Any]],
]:
    risk_refs: set[tuple[str, str, str, str, str]] = set()
    decisions: set[str] = set()
    item_keys: set[tuple[str, str]] = set()
    candidate_evaluations: dict[str, dict[str, Any]] = {}
    item_observations: list[dict[str, Any]] = []
    route_native_provenances: set[tuple[Any, ...]] = set()
    if path.suffix.lower() != ".jsonl":
        errors.append(f"{prefix}: must be a UTF-8 .jsonl file")
        return risk_refs, decisions, item_keys, candidate_evaluations, item_observations
    if not path.is_file():
        errors.append(f"{prefix}: file does not exist: {path}")
        return risk_refs, decisions, item_keys, candidate_evaluations, item_observations
    try:
        raw_lines = path.read_text(encoding="utf-8-sig").splitlines()
    except UnicodeError:
        errors.append(f"{prefix}: must be UTF-8 text")
        return risk_refs, decisions, item_keys, candidate_evaluations, item_observations
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw_lines, 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"{prefix}:{line_number}: invalid JSON: {exc.msg}")
            continue
        if not isinstance(row, dict):
            errors.append(f"{prefix}:{line_number}: row must be an object")
            continue
        rows.append(row)
    item_ids: set[str] = set()
    item_urls: set[str] = set()
    required = {
        "platform_key", "surface", "query_or_account_urls", "item_id", "url", "item_kind", "content_type",
        "author", "published_at", "title", "text", "media_kinds", "media_review_status",
        "subject_interaction_review_status", "review_status", "risk_decision", "risk_group_id",
    }
    query_row_counts: Counter[str] = Counter()
    for index, row in enumerate(rows):
        row_prefix = f"{prefix}[{index}]"
        missing = sorted(required - set(row))
        if missing:
            errors.append(f"{row_prefix}: missing fields: {', '.join(missing)}")
        if row.get("platform_key") != platform_key:
            errors.append(f"{row_prefix}.platform_key: must be {platform_key}")
        if row.get("surface") != expected_surface:
            errors.append(f"{row_prefix}.surface: must equal route surface {expected_surface!r}")
        for field in ("surface", "item_id", "content_type", "author"):
            if not _is_nonempty_text(row.get(field)):
                errors.append(f"{row_prefix}.{field}: must be non-empty text")
        item_kind = row.get("item_kind")
        if item_kind not in ITEM_KINDS:
            errors.append(f"{row_prefix}.item_kind: must be content or account_candidate")
        if expected_surface == "account_discovery" and item_kind != "account_candidate":
            errors.append(
                f"{row_prefix}.item_kind: account_discovery rows must be account_candidate "
                "so no discovered account can bypass final ranking"
            )
        for field in ("published_at", "title", "text", "risk_group_id"):
            if not isinstance(row.get(field), str):
                errors.append(f"{row_prefix}.{field}: must be text")
        origins = row.get("query_or_account_urls")
        if not isinstance(origins, list) or not origins or any(not _is_url(item) for item in origins):
            errors.append(f"{row_prefix}.query_or_account_urls: must be a non-empty URL list")
            origins = []
        if len(origins) != len(set(origins)):
            errors.append(f"{row_prefix}.query_or_account_urls: values must be unique")
        if expected_origin_url is not None and origins != [expected_origin_url]:
            errors.append(f"{row_prefix}.query_or_account_urls: homepage row must contain only its route URL")
        if query_counts is not None:
            unknown_origins = sorted(set(origins) - set(query_counts))
            if unknown_origins:
                errors.append(f"{row_prefix}.query_or_account_urls: URLs absent from query ledger: {unknown_origins}")
            for origin in set(origins) & set(query_counts):
                query_row_counts[origin] += 1
        item_url = row.get("url")
        if not _is_url(item_url) or _is_placeholder_url(item_url):
            errors.append(f"{row_prefix}.url: must be a real direct http(s) URL")
        elif platform_key in PLATFORM_HOST_SUFFIXES:
            _validate_platform_module_url(platform_key, "homepage", item_url, f"{row_prefix}.url", errors)
        if _is_url(item_url):
            if item_url in item_urls:
                errors.append(f"{row_prefix}.url: duplicate direct item URL")
            item_urls.add(str(item_url))
        content_type = row.get("content_type")
        normalized_content_type = str(content_type).strip().casefold().replace("-", "_").replace(" ", "_")
        account_like_result = (
            normalized_content_type in ACCOUNT_LIKE_CONTENT_TYPES
            or _looks_like_account_homepage(platform_key, item_url)
        )
        if item_kind != "account_candidate" and account_like_result:
            errors.append(
                f"{row_prefix}.item_kind: account/profile/channel search results and account-homepage URLs "
                "must be account_candidate so they cannot bypass final ranking"
            )
        if item_kind == "account_candidate":
            if content_type != "account_candidate":
                errors.append(f"{row_prefix}.content_type: account_candidate item_kind requires matching content_type")
            if (
                not _looks_like_account_homepage(platform_key, item_url)
                or _looks_like_video_url(platform_key, item_url)
            ):
                errors.append(
                    f"{row_prefix}.item_kind: account_candidate URL must be an account-like homepage "
                    "and not a video URL"
                )
            evaluation = _validate_identity_candidate(
                row.get("identity_candidate"),
                platform_key=platform_key,
                candidate_url=str(item_url),
                visible_account_name=str(row.get("author", "")),
                subject_display_name=subject_display_name,
                subject_aliases=subject_aliases,
                source_inventory=source_inventory,
                prefix=f"{row_prefix}.identity_candidate",
                errors=errors,
            )
            if evaluation is not None and _is_url(item_url):
                candidate_evaluations[str(item_url)] = evaluation
        else:
            if content_type == "account_candidate":
                errors.append(f"{row_prefix}.item_kind: account_candidate content_type requires matching item_kind")
        if item_kind != "account_candidate" and "identity_candidate" in row:
            errors.append(f"{row_prefix}.identity_candidate: allowed only for item_kind account_candidate")
        item_id = row.get("item_id")
        if _is_nonempty_text(item_id):
            if item_id in item_ids:
                errors.append(f"{row_prefix}.item_id: duplicate stable item id")
            item_ids.add(item_id)
            if _is_url(item_url):
                item_keys.add((str(item_id), str(item_url)))
        if row.get("review_status") != "reviewed":
            errors.append(f"{row_prefix}.review_status: must equal reviewed")
        if row.get("media_review_status") not in ITEM_REVIEW_STATUSES:
            errors.append(f"{row_prefix}.media_review_status: must be complete or not_applicable")
        media_kinds = row.get("media_kinds")
        if (
            not isinstance(media_kinds, list)
            or not media_kinds
            or any(kind not in MEDIA_KINDS for kind in media_kinds)
        ):
            errors.append(
                f"{row_prefix}.media_kinds: must be a non-empty list using only {sorted(MEDIA_KINDS)!r}"
            )
            media_kind_set: set[str] = set()
        else:
            media_kind_set = set(media_kinds)
            if len(media_kinds) != len(media_kind_set):
                errors.append(f"{row_prefix}.media_kinds: values must be unique")
            if "none" in media_kind_set and len(media_kind_set) > 1:
                errors.append(f"{row_prefix}.media_kinds: none cannot be combined with another media kind")
        semantic_video = (
            normalized_content_type in VIDEO_CONTENT_TYPES
            or _looks_like_video_url(platform_key, item_url)
        )
        surface_video = (platform_key, expected_surface) in VIDEO_ONLY_SURFACES
        if surface_video and "video" not in media_kind_set:
            errors.append(
                f"{row_prefix}.media_kinds: video-only surface {expected_surface!r} must include video"
            )
        if semantic_video and "video" not in media_kind_set:
            errors.append(
                f"{row_prefix}.media_kinds: a video content_type or recognizable video URL must include video"
            )
        real_video = semantic_video or surface_video or "video" in media_kind_set
        if real_video and item_kind != "content":
            errors.append(f"{row_prefix}.item_kind: every real video must use item_kind content")
        animated_only = not real_video and "animated_image" in media_kind_set
        validate_item_review(
            row,
            root=EVIDENCE_ROOT,
            prefix=row_prefix,
            errors=errors,
            require_video_triage=real_video,
        )
        decision = row.get("risk_decision")
        triage: dict[str, Any] = {}
        proof = row.get("review_evidence")
        if real_video and isinstance(proof, dict) and isinstance(proof.get("video_triage"), dict):
            triage = proof["video_triage"]
            if triage.get("risk_terms_sha256") != risk_terms_sha256:
                errors.append(
                    f"{row_prefix}.review_evidence.video_triage.risk_terms_sha256: must match coverage"
                )
            if decision in {"risk", "false_positive", "out_of_scope"} and triage.get("result") == "clear":
                errors.append(
                    f"{row_prefix}.review_evidence.video_triage.result: "
                    "a non-no_risk decision cannot use clear"
                )
        metadata_result = {
            "play_count_status": None,
            "play_count": None,
            "native_rank": None,
            "native_rank_provenance": None,
            "observed_at": None,
        }
        if real_video:
            if row.get("media_review_status") != "complete":
                errors.append(f"{row_prefix}.media_review_status: real video must equal complete")
            metadata_result = _validate_video_metadata(
                row.get("video_metadata"),
                row=row,
                account_url=account_url,
                route_started_at=route_started_at,
                route_completed_at=route_completed_at,
                prefix=f"{row_prefix}.video_metadata",
                errors=errors,
            )
            if (
                account_url is not None
                and isinstance(metadata_result.get("native_rank_provenance"), tuple)
            ):
                route_native_provenances.add(metadata_result["native_rank_provenance"])
            row_requires_full = (
                triage.get("result") in VIDEO_TRIAGE_UPGRADE_RESULTS
                or decision in {"risk", "false_positive", "out_of_scope"}
            )
            full_evidence = row.get("video_review_evidence")
            if row_requires_full and not isinstance(full_evidence, dict):
                errors.append(
                    f"{row_prefix}.video_review_evidence: risk/suspected or non-no_risk video "
                    "requires detailed full-timeline evidence"
                )
            if isinstance(full_evidence, dict):
                _validate_video_review_evidence(
                    full_evidence,
                    row=row,
                    risk_terms_sha256=risk_terms_sha256,
                    prefix=f"{row_prefix}.video_review_evidence",
                    errors=errors,
                )
                if (
                    triage.get("result") in VIDEO_TRIAGE_UPGRADE_RESULTS
                    and not full_evidence.get("hits")
                ):
                    errors.append(
                        f"{row_prefix}.video_review_evidence.hits: a risk/suspected triage "
                        "requires at least one contextual hit even when the final decision is no_risk"
                    )
            elif "video_review_evidence" in row and full_evidence is not None:
                errors.append(f"{row_prefix}.video_review_evidence: must be an object when present")
        elif animated_only:
            if "video_metadata" in row:
                errors.append(f"{row_prefix}.video_metadata: pure animated_image must not impersonate a real video")
            if row.get("media_review_status") != "complete":
                errors.append(f"{row_prefix}.media_review_status: animated image must equal complete")
            _validate_video_review_evidence(
                row.get("video_review_evidence"),
                row=row,
                risk_terms_sha256=risk_terms_sha256,
                prefix=f"{row_prefix}.video_review_evidence",
                errors=errors,
            )
        else:
            if "video_metadata" in row:
                errors.append(f"{row_prefix}.video_metadata: allowed only for a real video")
            if "video_review_evidence" in row:
                errors.append(
                    f"{row_prefix}.video_review_evidence: allowed only for a real video or pure animated image"
                )
        if item_kind == "content" and _is_nonempty_text(item_id) and _is_url(item_url):
            item_observations.append({
                "prefix": row_prefix,
                "account_url": account_url,
                "item_id": str(item_id),
                "item_url": str(item_url),
                "canonical_url": _canonical_rank_url(str(item_url)),
                "stable_video_identity": _stable_content_identity(str(item_url)),
                "is_video": real_video,
                "animated_only": animated_only,
                "triage_result": triage.get("result"),
                "risk_decision": decision,
                "has_full_review": isinstance(row.get("video_review_evidence"), dict),
                "play_count_status": metadata_result.get("play_count_status"),
                "play_count": metadata_result.get("play_count"),
                "native_rank": metadata_result.get("native_rank"),
                "native_rank_provenance": metadata_result.get("native_rank_provenance"),
                "metadata_observed_at": metadata_result.get("observed_at"),
                "route_completed_at": route_completed_at,
                "published_at": row.get("published_at"),
                "media_kinds": tuple(sorted(media_kind_set)),
            })
        if row.get("subject_interaction_review_status") not in ITEM_REVIEW_STATUSES:
            errors.append(f"{row_prefix}.subject_interaction_review_status: must be complete or not_applicable")
        group_id = row.get("risk_group_id")
        if decision not in RISK_DECISIONS:
            errors.append(f"{row_prefix}.risk_decision: invalid value")
        else:
            decisions.add(decision)
        if decision == "risk":
            if group_id not in valid_group_ids:
                errors.append(f"{row_prefix}.risk_group_id: risk row requires a valid group id")
            elif _is_url(row.get("url")) and route_origin_url in origins:
                risk_refs.add((platform_key, module_key, route_origin_url, group_id, row["url"]))
        elif group_id not in {"", None}:
            errors.append(f"{row_prefix}.risk_group_id: non-risk row must leave this empty")
    if len(route_native_provenances) > 1:
        errors.append(
            f"{prefix}: native rank rows within one account route must share one "
            "account-ranking snapshot provenance"
        )
    if len(rows) != expected_count:
        errors.append(f"{prefix}: unique row count {len(rows)} differs from route count {expected_count}")
    if query_counts is not None:
        for query_url, discovered in query_counts.items():
            if query_row_counts[query_url] != discovered:
                errors.append(
                    f"{prefix}: query ledger count for {query_url} is {discovered}, "
                    f"but {query_row_counts[query_url]} unique item row(s) cite that query"
                )
    return risk_refs, decisions, item_keys, candidate_evaluations, item_observations


def _observation_time_key(observation: dict[str, Any]) -> tuple[int, int, int, int, int, int, int]:
    value = observation.get("metadata_observed_at") or observation.get("route_completed_at")
    if not isinstance(value, datetime):
        return (0, 0, 0, 0, 0, 0, 0)
    if value.tzinfo is not None and value.utcoffset() is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return (
        value.year, value.month, value.day, value.hour, value.minute, value.second,
        value.microsecond,
    )


def _validate_item_observation_consistency(
    observations: list[dict[str, Any]],
    *,
    prefix: str,
    errors: list[str],
) -> None:
    ids_to_identities: dict[str, str] = {}
    identities_to_ids: dict[str, str] = {}
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for observation in observations:
        item_id = str(observation.get("item_id", ""))
        canonical_url = str(observation.get("canonical_url", ""))
        stable_video_identity = observation.get("stable_video_identity")
        identity_key = (
            f"video:{stable_video_identity}"
            if _is_nonempty_text(stable_video_identity)
            else f"url:{canonical_url}"
        )
        previous_identity = ids_to_identities.setdefault(item_id, identity_key)
        if previous_identity != identity_key:
            errors.append(
                f"{prefix}: stable item_id {item_id!r} maps to multiple canonical URLs/video "
                f"identities: {previous_identity!r}, {identity_key!r}"
            )
        previous_id = identities_to_ids.setdefault(identity_key, item_id)
        if previous_id != item_id:
            errors.append(
                f"{prefix}: canonical item URL/stable video identity {identity_key!r} maps to "
                "multiple stable IDs: "
                f"{previous_id!r}, {item_id!r}"
            )
        grouped.setdefault((item_id, identity_key), []).append(observation)
    for (item_id, identity_key), records in grouped.items():
        canonical_url = str(records[0].get("canonical_url", identity_key))
        video_states = {record.get("is_video") is True for record in records}
        if len(video_states) > 1:
            errors.append(
                f"{prefix}: item {item_id!r} {canonical_url!r} changes between video and non-video "
                "across routes; media classification cannot be downgraded"
            )
        media_kind_states = {tuple(record.get("media_kinds", ())) for record in records}
        if len(media_kind_states) > 1:
            errors.append(
                f"{prefix}: item {item_id!r} {canonical_url!r} changes media_kinds across routes; "
                "media facts must remain stable"
            )
        ordered = sorted(records, key=_observation_time_key)
        observed_counts_by_time: dict[tuple[int, int, int, int, int, int, int], set[int]] = {}
        for record in ordered:
            if record.get("play_count_status") == "observed" and _is_int(record.get("play_count")):
                observed_counts_by_time.setdefault(_observation_time_key(record), set()).add(
                    int(record["play_count"])
                )
        if any(len(counts) > 1 for counts in observed_counts_by_time.values()):
            errors.append(
                f"{prefix}: item {item_id!r} {canonical_url!r} has conflicting observed "
                "play_count values at the same observation time"
            )
        nonclear_seen = False
        previous_count: int | None = None
        previous_count_time: tuple[int, int, int, int, int, int, int] | None = None
        for record in ordered:
            triage_result = record.get("triage_result")
            if triage_result in VIDEO_TRIAGE_UPGRADE_RESULTS:
                nonclear_seen = True
            elif triage_result == "clear" and nonclear_seen:
                errors.append(
                    f"{prefix}: item {item_id!r} {canonical_url!r} downgrades an earlier "
                    "risk/suspected video triage to clear"
                )
            count = record.get("play_count")
            current_time = _observation_time_key(record)
            if record.get("play_count_status") == "observed" and _is_int(count):
                if (
                    previous_count is not None
                    and previous_count_time is not None
                    and current_time > previous_count_time
                    and count < previous_count
                ):
                    errors.append(
                        f"{prefix}: item {item_id!r} {canonical_url!r} has a later observed "
                        "play_count lower than its earlier evidence"
                    )
                previous_count = count
                previous_count_time = current_time


def _select_numeric_account_top10(
    items: list[dict[str, Any]],
    snapshot_rankings: dict[tuple[Any, ...], dict[int, dict[str, Any]]],
    snapshot_times: dict[tuple[Any, ...], tuple[int, int, int, int, int, int, int]],
) -> list[dict[str, Any]]:
    ordered = sorted(
        items,
        key=lambda item: (-int(item["play_count"]), str(item["canonical_url"])),
    )
    boundary_count = int(ordered[ACCOUNT_VIDEO_TOP_LIMIT - 1]["play_count"])
    higher = [item for item in ordered if int(item["play_count"]) > boundary_count]
    tied = [item for item in ordered if int(item["play_count"]) == boundary_count]
    slots = ACCOUNT_VIDEO_TOP_LIMIT - len(higher)
    if len(tied) <= slots:
        return higher + tied
    coherent_snapshots: list[tuple[Any, ...]] = []
    tied_identity_keys = {str(item["video_identity_key"]) for item in tied}
    for provenance, rank_map in snapshot_rankings.items():
        identity_to_rank = {
            str(item["video_identity_key"]): rank for rank, item in rank_map.items()
        }
        tied_ranks = [identity_to_rank.get(identity) for identity in tied_identity_keys]
        if all(_is_int(rank) and rank > 0 for rank in tied_ranks) and len(set(tied_ranks)) == len(tied_ranks):
            coherent_snapshots.append(provenance)
    if coherent_snapshots:
        selected_snapshot = max(
            coherent_snapshots,
            key=lambda provenance: (snapshot_times.get(provenance, (0,) * 7), repr(provenance)),
        )
        identity_to_rank = {
            str(item["video_identity_key"]): rank
            for rank, item in snapshot_rankings[selected_snapshot].items()
        }
        selected_tied = sorted(
            tied, key=lambda item: identity_to_rank[str(item["video_identity_key"])]
        )[:slots]
    else:
        # Stable sort in two passes gives publication date descending, then
        # canonical URL ascending for equal or unavailable dates.
        selected_tied = sorted(tied, key=lambda item: str(item["canonical_url"]))
        selected_tied.sort(key=lambda item: _published_rank_key(item.get("published_at")), reverse=True)
        selected_tied = selected_tied[:slots]
    return higher + selected_tied


def _validate_account_video_top10(
    observations: list[dict[str, Any]],
    *,
    delivered_account_urls: set[str],
    prefix: str,
    errors: list[str],
) -> None:
    by_account: dict[str, dict[str, list[dict[str, Any]]]] = {
        url: {} for url in delivered_account_urls
    }
    for observation in observations:
        account_url = observation.get("account_url")
        if account_url not in delivered_account_urls or observation.get("is_video") is not True:
            continue
        video_identity = observation.get("stable_video_identity")
        identity_key = (
            f"video:{video_identity}"
            if _is_nonempty_text(video_identity)
            else f"url:{observation.get('canonical_url', '')}"
        )
        by_account[str(account_url)].setdefault(identity_key, []).append(observation)
    for account_url, per_video_records in by_account.items():
        items: list[dict[str, Any]] = []
        for identity_key, records in per_video_records.items():
            latest = max(records, key=_observation_time_key)
            item_ids = {str(record.get("item_id", "")) for record in records}
            item_id = str(latest.get("item_id", identity_key))
            if len(item_ids) > 1:
                errors.append(
                    f"{prefix}: account {account_url!r} stable video identity {identity_key!r} "
                    "maps to multiple item_ids"
                )
            nonempty_publication_dates = {
                str(record.get("published_at"))
                for record in records
                if _is_nonempty_text(record.get("published_at"))
            }
            if len(nonempty_publication_dates) > 1:
                errors.append(
                    f"{prefix}: account {account_url!r} video {item_id!r} has inconsistent published_at values"
                )
            merged = dict(latest)
            observed_records = [
                record for record in records
                if record.get("play_count_status") == "observed"
                and _is_int(record.get("play_count"))
            ]
            if observed_records:
                # A later surface that hides the count must not erase a valid
                # earlier account observation and thereby evade Top-10 review.
                latest_observed = max(observed_records, key=_observation_time_key)
                merged["play_count_status"] = "observed"
                merged["play_count"] = latest_observed["play_count"]
            merged["video_identity_key"] = identity_key
            merged["native_rank_records"] = [
                record for record in records
                if _is_int(record.get("native_rank"))
                and record["native_rank"] > 0
                and isinstance(record.get("native_rank_provenance"), tuple)
            ]
            merged["has_full_review"] = any(record.get("has_full_review") is True for record in records)
            items.append(merged)
        if not items:
            continue
        snapshot_rankings: dict[tuple[Any, ...], dict[int, dict[str, Any]]] = {}
        snapshot_times: dict[tuple[Any, ...], tuple[int, int, int, int, int, int, int]] = {}
        for item in items:
            for record in item["native_rank_records"]:
                provenance = record["native_rank_provenance"]
                rank = int(record["native_rank"])
                rank_map = snapshot_rankings.setdefault(provenance, {})
                previous = rank_map.get(rank)
                if previous is not None and previous["video_identity_key"] != item["video_identity_key"]:
                    errors.append(
                        f"{prefix}: account {account_url!r} native snapshot rank {rank} is duplicated"
                    )
                else:
                    rank_map[rank] = item
                snapshot_times[provenance] = max(
                    snapshot_times.get(provenance, (0,) * 7), _observation_time_key(record),
                )
        if len(items) <= ACCOUNT_VIDEO_TOP_LIMIT:
            selected = items
        elif all(
            item.get("play_count_status") == "observed" and _is_int(item.get("play_count"))
            for item in items
        ):
            selected = _select_numeric_account_top10(items, snapshot_rankings, snapshot_times)
        else:
            # Only a complete, unique account-wide native order for positions
            # 1..10 establishes a Top 10. Otherwise the user's accepted
            # efficiency boundary applies: do not guess, block, or upgrade all.
            complete_snapshots = [
                provenance for provenance, rank_map in snapshot_rankings.items()
                if all(rank in rank_map for rank in range(1, ACCOUNT_VIDEO_TOP_LIMIT + 1))
            ]
            if complete_snapshots:
                selected_snapshot = max(
                    complete_snapshots,
                    key=lambda provenance: (
                        snapshot_times.get(provenance, (0,) * 7), repr(provenance),
                    ),
                )
                selected = [
                    snapshot_rankings[selected_snapshot][rank]
                    for rank in range(1, ACCOUNT_VIDEO_TOP_LIMIT + 1)
                ]
            else:
                selected = []
        for item in selected:
            if item.get("has_full_review") is not True:
                errors.append(
                    f"{prefix}: account {account_url!r} Top-10 video requires detailed "
                    f"video_review_evidence: {item.get('item_url')}"
                )


def _validate_query_ledger(
    path: Path,
    *,
    prefix: str,
    platform_key: str,
    module_key: str,
    aliases: set[str],
    keyword_groups: set[str],
    expected_sha256: str,
    errors: list[str],
) -> dict[str, int]:
    counts: dict[str, int] = {}
    if path.suffix.lower() != ".jsonl":
        errors.append(f"{prefix}: must be a UTF-8 .jsonl file")
        return counts
    if not path.is_file():
        errors.append(f"{prefix}: file does not exist: {path}")
        return counts
    if not SHA256_RE.fullmatch(expected_sha256):
        errors.append(f"{prefix}: query_ledger_sha256 must be lowercase SHA-256")
    elif _sha256(path) != expected_sha256:
        errors.append(f"{prefix}: query_ledger_sha256 does not match file")
    try:
        raw_lines = path.read_text(encoding="utf-8-sig").splitlines()
    except UnicodeError:
        errors.append(f"{prefix}: must be UTF-8 text")
        return counts
    expected_pairs = {(alias, "") for alias in aliases} | {
        (alias, group) for alias in aliases for group in keyword_groups
    }
    actual_pairs: set[tuple[str, str]] = set()
    query_ids: set[str] = set()
    required = {
        "query_id", "alias", "keyword_group", "query_text", "query_url", "termination",
        "discovered_items", "reviewed_items", "unreviewed_items",
    }
    for line_number, line in enumerate(raw_lines, 1):
        if not line.strip():
            continue
        row_prefix = f"{prefix}:{line_number}"
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"{row_prefix}: invalid JSON: {exc.msg}")
            continue
        if not isinstance(row, dict):
            errors.append(f"{row_prefix}: row must be an object")
            continue
        _validate_exact_fields(row, required, row_prefix, errors)
        query_id = row.get("query_id")
        if not _is_nonempty_text(query_id):
            errors.append(f"{row_prefix}.query_id: must be non-empty text")
        elif query_id in query_ids:
            errors.append(f"{row_prefix}.query_id: duplicate")
        else:
            query_ids.add(query_id)
        alias = row.get("alias")
        group = row.get("keyword_group")
        if alias not in aliases:
            errors.append(f"{row_prefix}.alias: not present in route aliases_covered")
        if not isinstance(group, str) or (group and group not in keyword_groups):
            errors.append(f"{row_prefix}.keyword_group: invalid or uncovered group")
        if isinstance(alias, str) and isinstance(group, str):
            pair = (alias, group)
            if pair in actual_pairs:
                errors.append(f"{row_prefix}: duplicate alias/keyword_group query")
            actual_pairs.add(pair)
        query_text = row.get("query_text")
        if not _is_nonempty_text(query_text):
            errors.append(f"{row_prefix}.query_text: must be non-empty text")
        elif isinstance(alias, str) and isinstance(group, str):
            expected_query_text = alias if not group else f"{alias} {group}"
            if _normalize_query_text(query_text) != _normalize_query_text(expected_query_text):
                errors.append(
                    f"{row_prefix}.query_text: must equal the canonical submitted query "
                    f"{expected_query_text!r}"
                )
        query_url = row.get("query_url")
        if not _is_url(query_url) or _is_placeholder_url(query_url):
            errors.append(f"{row_prefix}.query_url: must be a real http(s) URL")
        elif query_url in counts:
            errors.append(f"{row_prefix}.query_url: duplicate")
        _validate_platform_module_url(platform_key, module_key, query_url, f"{row_prefix}.query_url", errors)
        if _is_nonempty_text(query_text) and _is_url(query_url):
            extracted_queries = {
                _normalize_query_text(item) for item in _search_query_texts(platform_key, query_url)
            }
            if _normalize_query_text(query_text) not in extracted_queries:
                errors.append(
                    f"{row_prefix}.query_url: platform-native search input must exactly equal query_text"
                )
        termination = row.get("termination")
        if termination not in COMPLETE_TERMINATIONS:
            errors.append(f"{row_prefix}.termination: must be a verified natural end")
        for field in ("discovered_items", "reviewed_items", "unreviewed_items"):
            value = row.get(field)
            if not _is_int(value) or value < 0:
                errors.append(f"{row_prefix}.{field}: must be a non-negative integer")
        discovered = row.get("discovered_items")
        reviewed = row.get("reviewed_items")
        if _is_int(discovered) and _is_int(reviewed) and discovered != reviewed:
            errors.append(f"{row_prefix}: discovered_items must equal reviewed_items")
        if row.get("unreviewed_items") != 0:
            errors.append(f"{row_prefix}.unreviewed_items: must equal 0")
        if _is_url(query_url) and _is_int(discovered) and discovered >= 0:
            counts[str(query_url)] = discovered
    if actual_pairs != expected_pairs:
        missing = sorted(expected_pairs - actual_pairs)
        extra = sorted(actual_pairs - expected_pairs)
        if missing:
            errors.append(f"{prefix}: missing alias/keyword_group combinations: {missing}")
        if extra:
            errors.append(f"{prefix}: unexpected alias/keyword_group combinations: {extra}")
    return counts


def _sentinel_only_item_urls(
    query_path: Path,
    item_path: Path,
    *,
    sentinel_groups: set[str],
) -> set[str]:
    """Return sentinel-query items absent from every identity-only result in one route."""
    try:
        query_rows = [
            json.loads(line) for line in query_path.read_text(encoding="utf-8-sig").splitlines()
            if line.strip()
        ]
        item_rows = [
            json.loads(line) for line in item_path.read_text(encoding="utf-8-sig").splitlines()
            if line.strip()
        ]
    except (OSError, UnicodeError, json.JSONDecodeError):
        return set()
    identity_query_urls = {
        str(row.get("query_url")) for row in query_rows
        if isinstance(row, dict) and row.get("keyword_group") == "" and _is_url(row.get("query_url"))
    }
    sentinel_query_urls = {
        str(row.get("query_url")) for row in query_rows
        if isinstance(row, dict)
        and row.get("keyword_group") in sentinel_groups
        and _is_url(row.get("query_url"))
    }
    identity_items: set[str] = set()
    sentinel_items: set[str] = set()
    for row in item_rows:
        if not isinstance(row, dict) or not _is_url(row.get("url")):
            continue
        origins = row.get("query_or_account_urls")
        if not isinstance(origins, list):
            continue
        origin_set = {str(origin) for origin in origins if _is_url(origin)}
        item_url = str(row["url"])
        if origin_set & identity_query_urls:
            identity_items.add(item_url)
        if origin_set & sentinel_query_urls:
            sentinel_items.add(item_url)
    return sentinel_items - identity_items


def _completed_search_group_mode(
    platform_key: str,
    route_groups: set[str],
    *,
    coverage_keyword_groups: set[str],
    native_search_sentinel_groups: set[str],
) -> str | None:
    if route_groups == coverage_keyword_groups:
        return "full"
    if (
        platform_key not in {"domestic_other", "overseas_other"}
        and route_groups == native_search_sentinel_groups
    ):
        return "adaptive"
    return None


def _validate_adaptive_search_strategy(
    routes: list[dict[str, Any]],
    *,
    prefix: str,
    platform_key: str,
    coverage_keyword_groups: set[str],
    native_search_sentinel_groups: set[str],
    platform_has_confirmed_account: bool,
    platform_declared_risk: bool,
    platform_user_risk_lead: bool,
    ledger_decisions: dict[str, set[str]],
    candidate_evaluations: dict[str, dict[str, Any]],
    check_files: bool,
    errors: list[str],
) -> None:
    if platform_key in {"domestic_other", "overseas_other"}:
        return
    completed_search_routes = [
        route for route in routes
        if isinstance(route, dict)
        and route.get("status") == "complete"
        and _is_int(route.get("linear_pass_index"))
        and route.get("linear_pass_index") > 0
        and route.get("module_key") in SEARCH_MODULES
    ]
    adaptive_routes = [
        route for route in completed_search_routes
        if set(route.get("keyword_groups_covered", [])) == native_search_sentinel_groups
        and native_search_sentinel_groups != coverage_keyword_groups
    ]
    if not adaptive_routes:
        return
    triggers: list[str] = []
    if not platform_has_confirmed_account:
        triggers.append("the platform has no confirmed subject account")
    if platform_declared_risk or any("risk" in decisions for decisions in ledger_decisions.values()):
        triggers.append("the platform has a risk_group_id or reviewed risk item")
    if platform_user_risk_lead:
        triggers.append("coverage.user_risk_leads explicitly targets this platform")
    same_name_candidates = {
        url for url, evaluation in candidate_evaluations.items()
        if evaluation.get("candidate_platform_key") == platform_key
        and evaluation.get("name_match") in {"exact_display_name", "exact_alias"}
        and evaluation.get("explicit_identity_conflict") is not True
    }
    if len(same_name_candidates) >= 2:
        triggers.append("at least two unresolved exact display-name/alias candidates were found")
    if check_files:
        sentinel_only_urls: set[str] = set()
        for route in completed_search_routes:
            query_value = route.get("query_ledger_path")
            item_value = route.get("item_ledger_path")
            if not _is_nonempty_text(query_value) or not _is_nonempty_text(item_value):
                continue
            query_path = _path_under_root(str(query_value), f"{prefix}.adaptive.query_ledger_path", errors)
            item_path = _path_under_root(str(item_value), f"{prefix}.adaptive.item_ledger_path", errors)
            if query_path.is_file() and item_path.is_file():
                sentinel_only_urls.update(
                    _sentinel_only_item_urls(
                        query_path, item_path,
                        sentinel_groups=native_search_sentinel_groups,
                    )
                )
        if sentinel_only_urls:
            triggers.append(
                "a sentinel query returned item URL(s) absent from every identity-only query: "
                + ", ".join(sorted(sentinel_only_urls))
            )
    if triggers:
        reason = "; ".join(triggers)
        for route in adaptive_routes:
            route_id = route.get("route_id", "<unknown>")
            errors.append(
                f"{prefix}.route_results[route_id={route_id}].keyword_groups_covered: "
                f"adaptive search must upgrade the entire platform to full keyword_groups_checked because {reason}"
            )


def _iter_control_values(value: Any, path: str = ""):
    """Yield only machine-control fields from arbitrary JSON evidence."""
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            if str(key).lower() in {
                "status", "completion_status", "stop_reason", "termination", "reason",
                "exit_code", "negative_conclusion_eligible",
            }:
                yield child_path, child
            yield from _iter_control_values(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_control_values(child, f"{path}[{index}]")


def _validate_route_result_log(
    route: dict[str, Any],
    log_path: Path,
    *,
    prefix: str,
    errors: list[str],
    platform_key: str | None = None,
) -> None:
    """Cross-check a normalized route log and its hashed raw terminal evidence."""
    if not log_path.is_file():
        errors.append(f"{prefix}: file does not exist: {log_path}")
        return
    try:
        log = json.loads(log_path.read_text(encoding="utf-8-sig"))
    except UnicodeError:
        errors.append(f"{prefix}: must be UTF-8 JSON")
        return
    except json.JSONDecodeError as exc:
        errors.append(f"{prefix}: invalid JSON: {exc.msg}")
        return
    if not isinstance(log, dict):
        errors.append(f"{prefix}: must contain one JSON object")
        return
    expected = {
        "schema_version", "route_id", "module_key", "surface", "account_or_query_url", "resolved_url",
        "route_family", "evidence_origin", "evidence_fingerprint",
        "serial_route_index", "linear_pass_index",
        "tool_kind", "tool_sha256", "permission_basis", "official_product", "official_endpoint",
        "authorization_status", "authorization_evidence", "status",
        "edge_session_state", "edge_window_continuity_id", "user_login_completed_at",
        "edge_page_continuity_id", "max_task_open_edge_pages",
        "edge_evidence_path", "edge_evidence_sha256",
        "termination", "discovered_items", "reviewed_items", "unreviewed_items",
        "item_ledger_sha256", "query_ledger_sha256", "resolved_by_route_ids",
        "started_at", "completed_at", "raw_evidence",
    }
    if "completion_evidence" in log:
        expected.add("completion_evidence")
    _validate_exact_fields(log, expected, prefix, errors)
    validate_completion_proof(
        route, log, platform_key=platform_key, root=EVIDENCE_ROOT, prefix=prefix, errors=errors,
    )
    if log.get("schema_version") != ROUTE_EVIDENCE_SCHEMA_VERSION:
        errors.append(f"{prefix}.schema_version: must equal {ROUTE_EVIDENCE_SCHEMA_VERSION}")
    for field in (
        "route_id", "module_key", "surface", "account_or_query_url", "resolved_url",
        "route_family", "evidence_origin", "evidence_fingerprint", "tool_kind", "tool_sha256",
        "serial_route_index", "linear_pass_index",
        "permission_basis", "official_product", "official_endpoint", "authorization_status",
        "authorization_evidence", "edge_session_state", "edge_window_continuity_id",
        "edge_page_continuity_id", "max_task_open_edge_pages", "user_login_completed_at",
        "edge_evidence_path", "edge_evidence_sha256",
        "status", "termination",
        "discovered_items", "reviewed_items", "unreviewed_items", "started_at", "completed_at",
        "item_ledger_sha256", "query_ledger_sha256", "resolved_by_route_ids",
    ):
        if log.get(field) != route.get(field):
            errors.append(f"{prefix}.{field}: must exactly match route_results")
    raw_evidence = log.get("raw_evidence")
    if not isinstance(raw_evidence, list) or not raw_evidence:
        errors.append(f"{prefix}.raw_evidence: must be a non-empty list")
        return
    seen_paths: set[str] = set()
    raw_hashes: list[str] = []
    for index, raw in enumerate(raw_evidence):
        raw_prefix = f"{prefix}.raw_evidence[{index}]"
        if not isinstance(raw, dict):
            errors.append(f"{raw_prefix}: must be an object")
            continue
        _validate_exact_fields(raw, {"path", "sha256", "kind"}, raw_prefix, errors)
        if raw.get("kind") not in RAW_EVIDENCE_KINDS:
            errors.append(f"{raw_prefix}.kind: unsupported evidence kind")
        if not _is_nonempty_text(raw.get("path")):
            errors.append(f"{raw_prefix}.path: must be non-empty text")
            continue
        raw_path = _path_under_root(raw["path"], f"{raw_prefix}.path", errors)
        normalized = str(raw_path).lower()
        if normalized in seen_paths:
            errors.append(f"{raw_prefix}.path: duplicate raw evidence file")
        seen_paths.add(normalized)
        if raw_path == log_path:
            errors.append(f"{raw_prefix}.path: result log cannot cite itself as raw evidence")
        sha = raw.get("sha256")
        if not isinstance(sha, str) or not SHA256_RE.fullmatch(sha):
            errors.append(f"{raw_prefix}.sha256: must be lowercase SHA-256")
        else:
            raw_hashes.append(sha)
        if not raw_path.is_file():
            errors.append(f"{raw_prefix}.path: file does not exist: {raw_path}")
            continue
        if isinstance(sha, str) and SHA256_RE.fullmatch(sha) and _sha256(raw_path) != sha:
            errors.append(f"{raw_prefix}.sha256: does not match file")
        if route.get("status") != "complete" or raw_path.suffix.lower() != ".json":
            continue
        try:
            raw_json = json.loads(raw_path.read_text(encoding="utf-8-sig"))
        except (UnicodeError, json.JSONDecodeError):
            continue
        for control_path, control_value in _iter_control_values(raw_json):
            if control_path.endswith("negative_conclusion_eligible") and control_value is False:
                errors.append(f"{raw_prefix}.{control_path}: raw evidence forbids a negative conclusion")
            if control_path.endswith("exit_code") and _is_int(control_value) and control_value != 0:
                errors.append(f"{raw_prefix}.{control_path}: completed route cannot cite nonzero exit code")
            if isinstance(control_value, str):
                lowered = control_value.strip().lower()
                normalized = re.sub(r"[^a-z0-9]+", "_", lowered).strip("_")
                unfinished = {
                    "partial", "blocked", "failed", "error", "incomplete", "blocked_unresolved",
                    "permission_missing", "challenge", "verification_required",
                }
                forbidden_markers = FORBIDDEN_COMPLETE_TERMINATIONS | {
                    "max_pages_reached", "max_items_reached", "max_scrolls_reached",
                    "max_comments_reached", "login_required", "please_wait_shell",
                }
                if normalized in unfinished or any(
                    normalized == marker or normalized.startswith(f"{marker}_")
                    for marker in forbidden_markers
                ):
                    errors.append(f"{raw_prefix}.{control_path}: raw evidence contains unfinished state {control_value!r}")
    fingerprint_hashes = list(raw_hashes)
    if (
        route.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
        and isinstance(route.get("edge_evidence_sha256"), str)
    ):
        fingerprint_hashes.append(route["edge_evidence_sha256"])
    if fingerprint_hashes and route.get("evidence_fingerprint") != _fingerprint_hashes(fingerprint_hashes):
        errors.append(
            f"{prefix}.evidence_fingerprint: must be derived from all raw-evidence hashes "
            "and the interactive-browser evidence hash when applicable"
        )


def _validate_edge_route_evidence_manifest(
    path: Path,
    *,
    route: dict[str, Any],
    prefix: str,
    errors: list[str],
) -> tuple[bool, str]:
    """Validate one route-bound interactive-browser evidence manifest."""
    valid = True
    artifact_key = ""
    if path.suffix.lower() != ".json":
        errors.append(f"{prefix}: interactive-browser evidence must be a UTF-8 JSON manifest")
        return False, artifact_key
    try:
        manifest = json.loads(path.read_text(encoding="utf-8-sig"))
    except UnicodeError:
        errors.append(f"{prefix}: interactive-browser evidence manifest must be UTF-8")
        return False, artifact_key
    except json.JSONDecodeError as exc:
        errors.append(f"{prefix}: invalid interactive-browser evidence manifest JSON: {exc.msg}")
        return False, artifact_key
    if not isinstance(manifest, dict):
        errors.append(f"{prefix}: interactive-browser evidence manifest must contain one object")
        return False, artifact_key
    before = len(errors)
    _validate_exact_fields(manifest, EDGE_ROUTE_EVIDENCE_FIELDS, prefix, errors)
    valid = valid and len(errors) == before
    if manifest.get("schema_version") != EDGE_ROUTE_EVIDENCE_SCHEMA_VERSION:
        errors.append(f"{prefix}.schema_version: must equal {EDGE_ROUTE_EVIDENCE_SCHEMA_VERSION}")
        valid = False
    expected_pairs = {
        "route_id": route.get("route_id"),
        "account_or_query_url": route.get("account_or_query_url"),
        "final_visible_url": route.get("resolved_url"),
        "serial_route_index": route.get("serial_route_index"),
        "linear_pass_index": route.get("linear_pass_index"),
        "edge_session_state": route.get("edge_session_state"),
        "edge_window_continuity_id": route.get("edge_window_continuity_id"),
        "edge_page_continuity_id": route.get("edge_page_continuity_id"),
        "max_task_open_edge_pages": route.get("max_task_open_edge_pages"),
        "user_login_completed_at": route.get("user_login_completed_at"),
    }
    for field, expected in expected_pairs.items():
        if manifest.get(field) != expected:
            errors.append(f"{prefix}.{field}: must exactly match route_results")
            valid = False
    if route.get("tool_kind") == "microsoft_edge_visible":
        if manifest.get("browser_family") != "microsoft_edge":
            errors.append(f"{prefix}.browser_family: legacy microsoft_edge_visible route must equal microsoft_edge")
            valid = False
    elif not _is_nonempty_text(manifest.get("browser_family")):
        errors.append(f"{prefix}.browser_family: browser_ui route must name the actual persistent desktop browser family")
        valid = False
    elif _temporary_browser_identity(manifest.get("browser_family")):
        errors.append(
            f"{prefix}.browser_family: browser_ui must use a persistent desktop browser, "
            "not a Codex/OpenAI/in-app/iab/embedded/builtin/hosted/headless/temporary/ephemeral browser"
        )
        valid = False
    elif route.get("tool_kind") == "browser_ui":
        tool_brand = _known_browser_brand(route.get("tool_name"))
        family_brand = _known_browser_brand(manifest.get("browser_family"))
        if tool_brand and family_brand and tool_brand != family_brand:
            errors.append(f"{prefix}.browser_family: must identify the same desktop browser as route tool_name")
            valid = False
    if manifest.get("window_mode") != "visible":
        errors.append(f"{prefix}.window_mode: must equal visible")
        valid = False
    if not isinstance(manifest.get("edge_window_continuity_id"), str) or not EDGE_WINDOW_ID_RE.fullmatch(
        str(manifest.get("edge_window_continuity_id", ""))
    ):
        errors.append(f"{prefix}.edge_window_continuity_id: must be a canonical lowercase UUIDv4")
        valid = False
    if not isinstance(manifest.get("edge_page_continuity_id"), str) or not EDGE_WINDOW_ID_RE.fullmatch(
        str(manifest.get("edge_page_continuity_id", ""))
    ):
        errors.append(f"{prefix}.edge_page_continuity_id: must be a canonical lowercase UUIDv4")
        valid = False
    if (
        not _is_int(manifest.get("max_task_open_edge_pages"))
        or manifest.get("max_task_open_edge_pages") <= 0
    ):
        errors.append(f"{prefix}.max_task_open_edge_pages: must be a positive task-wide observed maximum")
        valid = False
    expected_capture_scope = (
        EDGE_CAPTURE_SCOPE
        if route.get("tool_kind") == "microsoft_edge_visible"
        else BROWSER_CAPTURE_SCOPE
    )
    if manifest.get("capture_scope") != expected_capture_scope:
        errors.append(f"{prefix}.capture_scope: must equal {expected_capture_scope}")
        valid = False

    started_at = _zoned_datetime(route.get("started_at"), f"{prefix}.route_started_at", errors)
    completed_at = _zoned_datetime(route.get("completed_at"), f"{prefix}.route_completed_at", errors)
    captured_at = _zoned_datetime(manifest.get("captured_at"), f"{prefix}.captured_at", errors)
    login_at: datetime | None = None
    if route.get("edge_session_state") == "user_login_completed":
        login_at = _zoned_datetime(
            manifest.get("user_login_completed_at"), f"{prefix}.user_login_completed_at", errors,
        )
    review_mode = manifest.get("review_start_mode")
    review_value = manifest.get("review_started_at")
    review_at: datetime | None = None
    if review_mode in {"surface_start", "checkpoint_resume"}:
        review_at = _zoned_datetime(review_value, f"{prefix}.review_started_at", errors)
    elif review_mode == "not_started":
        if review_value is not None:
            errors.append(f"{prefix}.review_started_at: not_started requires null")
            valid = False
    else:
        errors.append(f"{prefix}.review_start_mode: must be surface_start, checkpoint_resume, or not_started")
        valid = False
    if route.get("status") == "complete" and review_mode not in {"surface_start", "checkpoint_resume"}:
        errors.append(f"{prefix}.review_start_mode: completed route must use surface_start or checkpoint_resume")
        valid = False
    if review_mode == "checkpoint_resume" and route.get("edge_session_state") != "user_login_completed":
        errors.append(f"{prefix}.review_start_mode: checkpoint_resume is allowed only after user_login_completed")
        valid = False
    if route.get("edge_session_state") == "login_required" and route.get("status") == "complete":
        errors.append(f"{prefix}.edge_session_state: login_required cannot complete")
        valid = False
    if started_at is not None and completed_at is not None and started_at > completed_at:
        errors.append(f"{prefix}: route started_at must not be after completed_at")
        valid = False
    for label, moment in (("captured_at", captured_at), ("review_started_at", review_at), ("user_login_completed_at", login_at)):
        if moment is not None and started_at is not None and moment < started_at:
            errors.append(f"{prefix}.{label}: must not be before route started_at")
            valid = False
        if moment is not None and completed_at is not None and moment > completed_at:
            errors.append(f"{prefix}.{label}: must not be after route completed_at")
            valid = False
    if login_at is not None and review_at is not None and review_at < login_at:
        errors.append(f"{prefix}.review_started_at: must be at or after the user's completed login")
        valid = False

    artifact_value = manifest.get("artifact_path")
    artifact_sha = manifest.get("artifact_sha256")
    artifact_kind = manifest.get("artifact_kind")
    if not _is_nonempty_text(artifact_value):
        errors.append(f"{prefix}.artifact_path: must be non-empty text")
        return False, artifact_key
    artifact_path = _path_under_root(str(artifact_value), f"{prefix}.artifact_path", errors)
    artifact_key = str(artifact_path).lower()
    if artifact_path == path:
        errors.append(f"{prefix}.artifact_path: manifest cannot cite itself")
        valid = False
    if not isinstance(artifact_sha, str) or not SHA256_RE.fullmatch(artifact_sha):
        errors.append(f"{prefix}.artifact_sha256: must be lowercase SHA-256")
        valid = False
    if not artifact_path.is_file():
        errors.append(f"{prefix}.artifact_path: file does not exist")
        return False, artifact_key
    if isinstance(artifact_sha, str) and SHA256_RE.fullmatch(artifact_sha) and _sha256(artifact_path) != artifact_sha:
        errors.append(f"{prefix}.artifact_sha256: does not match artifact file")
        valid = False
    suffix = artifact_path.suffix.lower()
    if artifact_kind != "browser_screenshot":
        errors.append(
            f"{prefix}.artifact_kind: must equal browser_screenshot; "
            "browser_snapshot and JSON/HTML artifacts are forbidden"
        )
        valid = False
    elif suffix not in IMAGE_EXTENSIONS or _image_kind(artifact_path) is None:
        errors.append(f"{prefix}.artifact_path: browser screenshot must be a real PNG/JPEG/WebP image")
        valid = False
    return valid, artifact_key


def _validate_browser_evidence_manifest(
    path: Path,
    *,
    check: dict[str, Any],
    prefix: str,
    errors: list[str],
) -> tuple[bool, str]:
    valid = True
    artifact_key = ""
    if path.suffix.lower() != ".json":
        errors.append(f"{prefix}: browser evidence must be a UTF-8 JSON manifest")
        return False, artifact_key
    try:
        manifest = json.loads(path.read_text(encoding="utf-8-sig"))
    except UnicodeError:
        errors.append(f"{prefix}: browser evidence manifest must be UTF-8")
        return False, artifact_key
    except json.JSONDecodeError as exc:
        errors.append(f"{prefix}: invalid browser evidence manifest JSON: {exc.msg}")
        return False, artifact_key
    if not isinstance(manifest, dict):
        errors.append(f"{prefix}: browser evidence manifest must contain one object")
        return False, artifact_key
    expected = {
        "schema_version", "url", "browser_family", "window_mode",
        "edge_window_continuity_id", "edge_page_continuity_id",
        "max_task_open_edge_pages", "capture_scope", "preflight_serial_index",
        "started_at", "captured_at", "completed_at",
        "artifact_path", "artifact_sha256", "artifact_kind",
    }
    before = len(errors)
    _validate_exact_fields(manifest, expected, prefix, errors)
    valid = valid and len(errors) == before
    if manifest.get("schema_version") != BROWSER_REACHABILITY_SCHEMA_VERSION:
        errors.append(f"{prefix}.schema_version: must equal {BROWSER_REACHABILITY_SCHEMA_VERSION}")
        valid = False
    for field in (
        "url", "browser_family", "window_mode", "edge_window_continuity_id",
        "edge_page_continuity_id", "max_task_open_edge_pages", "capture_scope",
        "preflight_serial_index", "started_at", "captured_at", "completed_at",
    ):
        if manifest.get(field) != check.get(field):
            errors.append(f"{prefix}.{field}: must exactly match the browser check")
            valid = False
    if not _is_nonempty_text(manifest.get("browser_family")):
        errors.append(f"{prefix}.browser_family: must name the actual persistent desktop browser family")
        valid = False
    elif _temporary_browser_identity(manifest.get("browser_family")):
        errors.append(
            f"{prefix}.browser_family: browser evidence must use a persistent desktop browser, "
            "not a Codex/OpenAI/in-app/iab/embedded/builtin/hosted/headless/temporary/ephemeral browser"
        )
        valid = False
    if manifest.get("window_mode") != "visible":
        errors.append(f"{prefix}.window_mode: must equal visible")
        valid = False
    for field in ("edge_window_continuity_id", "edge_page_continuity_id"):
        value = manifest.get(field)
        if not isinstance(value, str) or not EDGE_WINDOW_ID_RE.fullmatch(value):
            errors.append(f"{prefix}.{field}: must be a canonical lowercase UUIDv4")
            valid = False
    if manifest.get("max_task_open_edge_pages") != 1:
        errors.append(f"{prefix}.max_task_open_edge_pages: must equal 1")
        valid = False
    if manifest.get("capture_scope") not in BROWSER_CAPTURE_SCOPES:
        errors.append(
            f"{prefix}.capture_scope: must be a full visible interactive-browser window capture"
        )
        valid = False
    if not _is_int(manifest.get("preflight_serial_index")) or manifest.get("preflight_serial_index") <= 0:
        errors.append(f"{prefix}.preflight_serial_index: must be a positive integer")
        valid = False
    started_at = _zoned_datetime(manifest.get("started_at"), f"{prefix}.started_at", errors)
    captured_at = _zoned_datetime(manifest.get("captured_at"), f"{prefix}.captured_at", errors)
    completed_at = _zoned_datetime(manifest.get("completed_at"), f"{prefix}.completed_at", errors)
    if started_at is not None and completed_at is not None and started_at > completed_at:
        errors.append(f"{prefix}: started_at must not be after completed_at")
        valid = False
    if captured_at is not None and started_at is not None and captured_at < started_at:
        errors.append(f"{prefix}.captured_at: must not be before started_at")
        valid = False
    if captured_at is not None and completed_at is not None and captured_at > completed_at:
        errors.append(f"{prefix}.captured_at: must not be after completed_at")
        valid = False
    artifact_value = manifest.get("artifact_path")
    artifact_sha = manifest.get("artifact_sha256")
    artifact_kind = manifest.get("artifact_kind")
    if not _is_nonempty_text(artifact_value):
        errors.append(f"{prefix}.artifact_path: must be non-empty text")
        return False, artifact_key
    artifact_path = _path_under_root(str(artifact_value), f"{prefix}.artifact_path", errors)
    artifact_key = str(artifact_path).lower()
    if artifact_path == path:
        errors.append(f"{prefix}.artifact_path: manifest cannot cite itself")
        valid = False
    if not isinstance(artifact_sha, str) or not SHA256_RE.fullmatch(artifact_sha):
        errors.append(f"{prefix}.artifact_sha256: must be lowercase SHA-256")
        valid = False
    if not artifact_path.is_file():
        errors.append(f"{prefix}.artifact_path: file does not exist")
        return False, artifact_key
    if isinstance(artifact_sha, str) and SHA256_RE.fullmatch(artifact_sha) and _sha256(artifact_path) != artifact_sha:
        errors.append(f"{prefix}.artifact_sha256: does not match artifact file")
        valid = False
    suffix = artifact_path.suffix.lower()
    if artifact_kind != "browser_screenshot":
        errors.append(
            f"{prefix}.artifact_kind: must equal browser_screenshot; "
            "browser_snapshot and JSON/HTML artifacts are forbidden"
        )
        valid = False
    elif suffix not in IMAGE_EXTENSIONS or _image_kind(artifact_path) is None:
        errors.append(f"{prefix}.artifact_path: browser screenshot must be a real PNG/JPEG/WebP image")
        valid = False
    return valid, artifact_key


def _requires_edge_network_preflight(platforms: Any) -> bool:
    """Derive the interactive-browser prerequisite from actual routes.

    The legacy function name is retained because schema 1.10 keeps its public
    ``edge_*`` compatibility fields.
    """
    declared_routes = [
        route
        for platform in (platforms.values() if isinstance(platforms, dict) else [])
        if isinstance(platform, dict)
        for scope in [
            platform,
            *(platform.get("subplatforms", []) if isinstance(platform.get("subplatforms"), list) else []),
        ]
        if isinstance(scope, dict)
        for completion in [scope.get("research_completion")]
        if isinstance(completion, dict)
        for route in (
            completion.get("route_results", [])
            if isinstance(completion.get("route_results"), list) else []
        )
    ]
    # Empty or unrecognized routes cannot opt a run out of browser validation.
    # API/export authorization, raw evidence and coverage are checked separately.
    non_browser_families = {
        "official_api": {"official_api", "approved_research_product"},
        "authorized_export": {"authorized_export"},
        "local_script": {"official_api", "approved_research_product"},
    }
    return not declared_routes or any(
        not isinstance(route, dict)
        or route.get("route_family") not in non_browser_families.get(str(route.get("tool_kind")), set())
        for route in declared_routes
    )


def _validate_network_preflight_log(
    preflight: dict[str, Any], path: Path, errors: list[str],
    *, require_edge: bool = True,
) -> dict[str, Any] | None:
    prefix = "coverage.network_preflight.log_path"
    if not path.is_file():
        errors.append(f"{prefix}: file does not exist")
        return None
    try:
        log = json.loads(path.read_text(encoding="utf-8-sig"))
    except UnicodeError:
        errors.append(f"{prefix}: must be UTF-8 JSON")
        return None
    except json.JSONDecodeError as exc:
        errors.append(f"{prefix}: invalid JSON: {exc.msg}")
        return None
    if not isinstance(log, dict):
        errors.append(f"{prefix}: must contain one JSON object")
        return None
    expected = {
        "schema_version", "status", "checked_at", "proxy_configured", "proxy_reachable",
        "direct_https_reachable", "browser_session_reachable", "domestic_route_reachable",
        "overseas_route_reachable", "tested_hosts", "checks",
    }
    _validate_exact_fields(log, expected, prefix, errors)
    if log.get("schema_version") != NETWORK_PREFLIGHT_SCHEMA_VERSION:
        errors.append(f"{prefix}.schema_version: must equal {NETWORK_PREFLIGHT_SCHEMA_VERSION}")
    for field in expected - {"schema_version", "checks"}:
        if log.get(field) != preflight.get(field):
            errors.append(f"{prefix}.{field}: must exactly match network_preflight")
    checks = log.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append(f"{prefix}.checks: must be a non-empty list")
        return None
    families = {"domestic": False, "overseas": False}
    browser_families = {"domestic": False, "overseas": False}
    browser_evidence_paths: set[str] = set()
    browser_artifact_paths: set[str] = set()
    browser_checks: list[tuple[int, dict[str, Any], str, datetime | None, datetime | None]] = []
    transport_url_families: dict[str, set[str]] = {}
    observed_hosts: set[str] = set()
    proven_direct = False
    for index, check in enumerate(checks):
        check_prefix = f"{prefix}.checks[{index}]"
        if not isinstance(check, dict):
            errors.append(f"{check_prefix}: must be an object")
            continue
        expected_check = {
            "family", "route", "url", "host", "reachable", "http_status", "error",
            "browser_family", "window_mode", "evidence_path", "evidence_sha256", "evidence_kind",
            "edge_window_continuity_id", "edge_page_continuity_id",
            "max_task_open_edge_pages", "capture_scope", "preflight_serial_index",
            "started_at", "captured_at", "completed_at",
        }
        _validate_exact_fields(check, expected_check, check_prefix, errors)
        family = check.get("family")
        if family not in families:
            errors.append(f"{check_prefix}.family: must be domestic or overseas")
        route_kind = check.get("route")
        if route_kind not in {"direct_https", "configured_proxy", "browser_session"}:
            errors.append(f"{check_prefix}.route: invalid route")
        if not _is_url(check.get("url")):
            errors.append(f"{check_prefix}.url: must be an http(s) URL")
        if not _is_nonempty_text(check.get("host")):
            errors.append(f"{check_prefix}.host: must be non-empty text")
        if not require_edge and _is_url(check.get("url")):
            parsed_url = urlparse(check["url"])
            observed_hosts.add(str(parsed_url.hostname or ""))
            if check.get("host") != parsed_url.hostname:
                errors.append(f"{check_prefix}.host: must match the tested URL hostname")
            normalized_url = parsed_url._replace(
                scheme=parsed_url.scheme.lower(), netloc=parsed_url.netloc.lower(),
                path=parsed_url.path or "/", fragment="",
            ).geturl()
            transport_url_families.setdefault(normalized_url, set()).add(str(family))
        if not isinstance(check.get("reachable"), bool):
            errors.append(f"{check_prefix}.reachable: must be boolean")
        if check.get("http_status") is not None and not _is_int(check.get("http_status")):
            errors.append(f"{check_prefix}.http_status: must be null or integer")
        if not isinstance(check.get("error"), str):
            errors.append(f"{check_prefix}.error: must be text")
        proven = False
        if route_kind in {"direct_https", "configured_proxy"}:
            for field in (
                "browser_family", "window_mode", "evidence_path", "evidence_sha256", "evidence_kind",
                "edge_window_continuity_id", "edge_page_continuity_id",
                "max_task_open_edge_pages", "capture_scope", "preflight_serial_index",
                "started_at", "captured_at", "completed_at",
            ):
                if check.get(field) is not None:
                    errors.append(f"{check_prefix}.{field}: non-browser check must be null")
            if check.get("reachable") is True:
                if not _is_int(check.get("http_status")):
                    errors.append(f"{check_prefix}.http_status: reachable transport check requires an HTTP response code")
                elif not require_edge and (
                    not 200 <= check["http_status"] < 400 or check.get("error") != ""
                ):
                    errors.append(
                        f"{check_prefix}: API/export transport reachability requires a successful "
                        "HTTP response without an error"
                    )
                else:
                    proven = True
        elif route_kind == "browser_session":
            if check.get("http_status") is not None:
                errors.append(f"{check_prefix}.http_status: browser session check must be null")
            if not _is_nonempty_text(check.get("browser_family")):
                errors.append(
                    f"{check_prefix}.browser_family: must name the actual interactive browser family"
                )
            if check.get("window_mode") != "visible":
                errors.append(f"{check_prefix}.window_mode: must equal visible")
            if check.get("evidence_kind") != "browser_evidence_manifest":
                errors.append(f"{check_prefix}.evidence_kind: must equal browser_evidence_manifest")
            for field in ("edge_window_continuity_id", "edge_page_continuity_id"):
                value = check.get(field)
                if not isinstance(value, str) or not EDGE_WINDOW_ID_RE.fullmatch(value):
                    errors.append(f"{check_prefix}.{field}: must be a canonical lowercase UUIDv4")
            if check.get("max_task_open_edge_pages") != 1:
                errors.append(f"{check_prefix}.max_task_open_edge_pages: must equal 1")
            if check.get("capture_scope") not in BROWSER_CAPTURE_SCOPES:
                errors.append(
                    f"{check_prefix}.capture_scope: must be a full visible interactive-browser window capture"
                )
            preflight_serial_index = check.get("preflight_serial_index")
            if not _is_int(preflight_serial_index) or preflight_serial_index <= 0:
                errors.append(f"{check_prefix}.preflight_serial_index: must be a positive integer")
            started_at = _zoned_datetime(check.get("started_at"), f"{check_prefix}.started_at", errors)
            captured_at = _zoned_datetime(check.get("captured_at"), f"{check_prefix}.captured_at", errors)
            completed_at = _zoned_datetime(check.get("completed_at"), f"{check_prefix}.completed_at", errors)
            if started_at is not None and completed_at is not None and started_at > completed_at:
                errors.append(f"{check_prefix}: started_at must not be after completed_at")
            if captured_at is not None and started_at is not None and captured_at < started_at:
                errors.append(f"{check_prefix}.captured_at: must not be before started_at")
            if captured_at is not None and completed_at is not None and captured_at > completed_at:
                errors.append(f"{check_prefix}.captured_at: must not be after completed_at")
            evidence_value = check.get("evidence_path")
            evidence_sha = check.get("evidence_sha256")
            if not _is_nonempty_text(evidence_value):
                errors.append(f"{check_prefix}.evidence_path: must be non-empty text")
            elif not isinstance(evidence_sha, str) or not SHA256_RE.fullmatch(evidence_sha):
                errors.append(f"{check_prefix}.evidence_sha256: must be lowercase SHA-256")
            else:
                evidence_path = _path_under_root(str(evidence_value), f"{check_prefix}.evidence_path", errors)
                normalized_path = str(evidence_path).lower()
                if normalized_path in browser_evidence_paths:
                    errors.append(f"{check_prefix}.evidence_path: one browser manifest cannot prove two route checks")
                browser_evidence_paths.add(normalized_path)
                if not evidence_path.is_file():
                    errors.append(f"{check_prefix}.evidence_path: file does not exist")
                elif _sha256(evidence_path) != evidence_sha:
                    errors.append(f"{check_prefix}.evidence_sha256: does not match browser evidence file")
                else:
                    manifest_valid, artifact_key = _validate_browser_evidence_manifest(
                        evidence_path, check=check, prefix=f"{check_prefix}.evidence_path", errors=errors,
                    )
                    if artifact_key:
                        if artifact_key in browser_artifact_paths:
                            errors.append(
                                f"{check_prefix}.evidence_path: one browser artifact cannot prove two route checks"
                            )
                            manifest_valid = False
                        browser_artifact_paths.add(artifact_key)
                    if manifest_valid and check.get("reachable") is True:
                        proven = True
            if _is_int(preflight_serial_index):
                browser_checks.append((preflight_serial_index, check, check_prefix, started_at, completed_at))
        if family in families and proven:
            if route_kind == "browser_session":
                browser_families[family] = True
            if (require_edge and route_kind == "browser_session") or (
                not require_edge and route_kind in {"direct_https", "configured_proxy"}
            ):
                families[family] = True
        if proven and route_kind == "direct_https":
            proven_direct = True
    proven_browser = all(browser_families.values())
    for family, proven in families.items():
        expected_family = preflight.get(f"{family}_route_reachable")
        if expected_family is not proven:
            errors.append(f"{prefix}.{family}_route_reachable: must be derived from validated checks")
    if preflight.get("direct_https_reachable") is not proven_direct:
        errors.append(f"{prefix}.direct_https_reachable: must be derived from validated checks")
    if preflight.get("browser_session_reachable") is not proven_browser:
        errors.append(f"{prefix}.browser_session_reachable: must be derived from hashed browser evidence")
    if not require_edge:
        declared_hosts = log.get("tested_hosts")
        if (
            not isinstance(declared_hosts, list)
            or any(not isinstance(host, str) for host in declared_hosts)
            or len(declared_hosts) != len(set(declared_hosts))
            or set(declared_hosts) != observed_hosts
        ):
            errors.append(f"{prefix}.tested_hosts: must exactly list the unique tested URL hostnames")
        if any(len(families_for_url) > 1 for families_for_url in transport_url_families.values()):
            errors.append(f"{prefix}.checks: one API test URL cannot prove both domestic and overseas routes")
        # No interactive-browser route exists: transport evidence proves reachability, while
        # each API/export route still has its own authorization, raw-evidence,
        # natural-end and item-ledger gates. Never invent browser evidence here.
        return None
    if len(browser_checks) != 2:
        errors.append(f"{prefix}.checks: must contain exactly two visible interactive-browser session checks")
        return None
    browser_checks.sort(key=lambda item: item[0])
    indexes = [item[0] for item in browser_checks]
    if indexes != [1, 2]:
        errors.append(f"{prefix}.checks: browser preflight_serial_index values must equal [1, 2]")
    expected_families = ["domestic", "overseas"]
    actual_families = [str(item[1].get("family")) for item in browser_checks]
    if actual_families != expected_families:
        errors.append(f"{prefix}.checks: browser checks must run domestic then overseas")
    window_ids = {item[1].get("edge_window_continuity_id") for item in browser_checks}
    page_ids = {item[1].get("edge_page_continuity_id") for item in browser_checks}
    if len(window_ids) != 1:
        errors.append(f"{prefix}.checks: browser checks must use one edge_window_continuity_id")
    if len(page_ids) != 1:
        errors.append(f"{prefix}.checks: browser checks must use one edge_page_continuity_id")
    first_completed = browser_checks[0][4]
    second_started = browser_checks[1][3]
    if first_completed is not None and second_started is not None and first_completed > second_started:
        errors.append(f"{prefix}.checks: browser preflight intervals must not overlap")
    last_completed = browser_checks[-1][4]
    if indexes != [1, 2] or actual_families != expected_families or len(window_ids) != 1 or len(page_ids) != 1:
        return None
    return {
        "edge_window_continuity_id": next(iter(window_ids)),
        "edge_page_continuity_id": next(iter(page_ids)),
        "completed_at": last_completed,
    }


def _validate_parallel_execution(
    route_contexts: list[dict[str, Any]],
    *,
    final_linear_pass_index: int,
    coverage_started_at: datetime | None,
    coverage_completed_at: datetime | None,
    preflight_serial: dict[str, Any] | None,
    errors: list[str],
) -> None:
    """Validate route identity, per-page exclusivity, and parallel-safe coverage."""
    if not route_contexts:
        errors.append("platforms: no research routes were recorded")
        return

    indexed: list[tuple[int, dict[str, Any], datetime | None, datetime | None]] = []
    route_ids: dict[str, str] = {}
    for context in route_contexts:
        route = context["route"]
        prefix = context["prefix"]
        route_id = route.get("route_id")
        if _is_nonempty_text(route_id):
            prior_prefix = route_ids.get(str(route_id))
            if prior_prefix is not None:
                errors.append(
                    f"{prefix}.route_id: must be globally unique; also used by {prior_prefix}"
                )
            else:
                route_ids[str(route_id)] = prefix
        serial_index = route.get("serial_route_index")
        started_at = _zoned_datetime(route.get("started_at"), f"{prefix}.started_at", errors)
        completed_at = _zoned_datetime(route.get("completed_at"), f"{prefix}.completed_at", errors)
        if _is_int(serial_index) and serial_index > 0:
            indexed.append((serial_index, context, started_at, completed_at))

    indexed.sort(key=lambda item: item[0])
    indexes = [item[0] for item in indexed]
    expected_indexes = list(range(1, len(route_contexts) + 1))
    if indexes != expected_indexes:
        errors.append(
            "platforms.route_results.serial_route_index: must be globally unique and exactly "
            f"1..{len(route_contexts)} without gaps; got {indexes!r}"
        )
    if not indexed:
        return

    browser_contexts = [
        item
        for item in indexed
        if item[1]["route"].get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
    ]
    page_windows: dict[str, set[str]] = {}
    max_page_values: set[int] = set()
    for _record_index, context, _started_at, _completed_at in browser_contexts:
        route = context["route"]
        page_id = route.get("edge_page_continuity_id")
        window_id = route.get("edge_window_continuity_id")
        if isinstance(page_id, str) and isinstance(window_id, str):
            page_windows.setdefault(page_id, set()).add(window_id)
        max_pages = route.get("max_task_open_edge_pages")
        if _is_int(max_pages) and max_pages > 0:
            max_page_values.add(max_pages)
    for page_id, window_ids in page_windows.items():
        if len(window_ids) > 1:
            errors.append(
                "platforms.route_results.edge_page_continuity_id: page id "
                f"{page_id!r} is bound to multiple interactive-browser window ids"
            )
    if len(max_page_values) > 1:
        errors.append(
            "platforms.route_results.max_task_open_edge_pages: all interactive-browser routes must record the same "
            "task-wide observed maximum"
        )

    # Different browser pages/windows and non-browser routes may run concurrently.
    # One physical interactive-browser page remains exclusive to one route at a time.
    for position, current in enumerate(browser_contexts):
        current_route = current[1]["route"]
        current_page = current_route.get("edge_page_continuity_id")
        current_started = current[2]
        current_completed = current[3]
        if current_started is None or current_completed is None:
            continue
        for previous in browser_contexts[:position]:
            previous_route = previous[1]["route"]
            if previous_route.get("edge_page_continuity_id") != current_page:
                continue
            previous_started = previous[2]
            previous_completed = previous[3]
            if previous_started is None or previous_completed is None:
                continue
            if current_started < previous_completed and previous_started < current_completed:
                errors.append(
                    f"{current[1]['prefix']}.started_at: interactive-browser routes sharing one "
                    "edge_page_continuity_id must not overlap; conflicts with "
                    f"{previous[1]['prefix']}"
                )

    # The compatibility field records an observed task-wide peak. It no longer
    # acts as a fixed single-page limit, but it cannot understate demonstrable
    # concurrent active pages in the route intervals.
    peak_parallel_pages = 0
    moments = sorted({item[2] for item in browser_contexts if item[2] is not None})
    for moment in moments:
        active_pages = {
            item[1]["route"].get("edge_page_continuity_id")
            for item in browser_contexts
            if item[2] is not None
            and item[3] is not None
            and item[2] <= moment
            and (moment < item[3] or item[2] == item[3] == moment)
        }
        peak_parallel_pages = max(peak_parallel_pages, len(active_pages))
    if len(max_page_values) == 1 and next(iter(max_page_values)) < peak_parallel_pages:
        errors.append(
            "platforms.route_results.max_task_open_edge_pages: observed maximum is lower than "
            f"the evidenced parallel browser-page peak {peak_parallel_pages}"
        )

    for _serial_index, context, started_at, completed_at in indexed:
        prefix = context["prefix"]
        if coverage_started_at is not None and started_at is not None and started_at < coverage_started_at:
            errors.append(f"{prefix}.started_at: must not be before coverage.started_at")
        if coverage_completed_at is not None and completed_at is not None and completed_at > coverage_completed_at:
            errors.append(f"{prefix}.completed_at: must not be after coverage.completed_at")

    pass_values = [
        item[1]["route"].get("linear_pass_index")
        for item in indexed
        if _is_int(item[1]["route"].get("linear_pass_index"))
    ]
    if 0 not in pass_values:
        errors.append(
            "platforms.route_results.linear_pass_index: must include at least one discovery prepass route with value 0"
        )
    positive_passes = sorted({value for value in pass_values if value > 0})
    if not positive_passes:
        errors.append("platforms.route_results.linear_pass_index: at least one positive coverage wave is required")
    elif max(positive_passes) != final_linear_pass_index:
        errors.append(
            "platforms.route_results.linear_pass_index: highest positive coverage wave must equal "
            f"coverage.final_linear_pass_index={final_linear_pass_index}; got {positive_passes!r}"
        )

    for _record_index, context, _started_at, _completed_at in indexed:
        route = context["route"]
        if route.get("linear_pass_index") == 0 and route.get("surface") != "account_discovery":
            errors.append(
                f"{context['prefix']}.linear_pass_index: discovery wave 0 is reserved for account_discovery"
            )

    first_browser_started_at = min(
        (item[2] for item in browser_contexts if item[2] is not None),
        default=None,
    )
    if preflight_serial is not None:
        preflight_completed_at = preflight_serial.get("completed_at")
        if (
            isinstance(preflight_completed_at, datetime)
            and first_browser_started_at is not None
            and preflight_completed_at > first_browser_started_at
        ):
            errors.append(
                "coverage.network_preflight: both visible browser preflight checks must finish before any "
                "research interactive-browser route starts"
            )


def _validate_x_review_start_month(
    completion: Any,
    homepage_urls: set[str],
    claimed_month: Any,
    *,
    prefix: str,
    errors: list[str],
) -> None:
    """Derive X's displayed review-start month from every reviewed homepage ledger."""
    if not homepage_urls or not isinstance(completion, dict):
        return
    dates: list[date] = []
    routes = completion.get("route_results")
    if not isinstance(routes, list):
        return
    seen_ledgers: set[str] = set()
    for route_index, route in enumerate(routes):
        if not isinstance(route, dict) or route.get("status") != "complete":
            continue
        if route.get("module_key") != "homepage" or route.get("account_or_query_url") not in homepage_urls:
            continue
        ledger_value = route.get("item_ledger_path")
        if not _is_nonempty_text(ledger_value):
            continue
        ledger_path = _path_under_root(str(ledger_value), f"{prefix}.route_results[{route_index}].item_ledger_path", errors)
        ledger_key = str(ledger_path).lower()
        if ledger_key in seen_ledgers or not ledger_path.is_file():
            continue
        seen_ledgers.add(ledger_key)
        try:
            lines = ledger_path.read_text(encoding="utf-8-sig").splitlines()
        except UnicodeError:
            continue
        for line_number, line in enumerate(lines, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            value = row.get("published_at")
            if not _is_nonempty_text(value):
                errors.append(
                    f"{prefix}.route_results[{route_index}].item_ledger_path:{line_number}.published_at: "
                    "X homepage item requires a date"
                )
                continue
            try:
                parsed = date.fromisoformat(str(value)[:10])
            except ValueError:
                errors.append(
                    f"{prefix}.route_results[{route_index}].item_ledger_path:{line_number}.published_at: "
                    "must begin with a real ISO YYYY-MM-DD date"
                )
                continue
            dates.append(parsed)
    if not dates:
        errors.append(f"{prefix}: delivered confirmed or suspected X homepage has no dated reviewed item for review_start_month")
        return
    derived = min(dates).strftime("%Y-%m")
    if claimed_month != derived:
        errors.append(f"{prefix}.review_start_month: must equal earliest reviewed X homepage item month {derived}")


def _validate_completion(
    completion: Any,
    *,
    prefix: str,
    platform_key: str,
    modules: dict[str, dict[str, Any]],
    subject_display_name: str,
    subject_aliases: set[str],
    source_inventory: set[str],
    coverage_aliases: set[str],
    coverage_keyword_groups: set[str],
    native_search_sentinel_groups: set[str],
    risk_terms_sha256: str,
    final_linear_pass_index: int,
    valid_group_ids: set[str],
    platform_has_confirmed_account: bool,
    platform_declared_risk: bool,
    platform_user_risk_lead: bool,
    delivered_account_urls: set[str],
    check_files: bool,
    errors: list[str],
) -> tuple[
    list[dict[str, Any]], set[tuple[str, str, str, str, str]],
    dict[str, dict[str, Any]], dict[str, dict[str, Any]],
]:
    ledger_risk_refs: set[tuple[str, str, str, str, str]] = set()
    ledger_decisions: dict[str, set[str]] = {}
    candidate_evaluations: dict[str, dict[str, Any]] = {}
    all_pass_candidate_evaluations: dict[str, dict[str, Any]] = {}
    all_item_observations: list[dict[str, Any]] = []
    complete_item_observations: list[dict[str, Any]] = []
    if not isinstance(completion, dict):
        errors.append(f"{prefix}: must be an object")
        return [], ledger_risk_refs, candidate_evaluations, all_pass_candidate_evaluations
    expected_fields = {
        "status", "homepage_review", "native_search_review", "route_results",
        "unreviewed_relevant_hits", "completion_note",
    }
    _validate_exact_fields(completion, expected_fields, prefix, errors)
    if completion.get("status") != "complete":
        errors.append(f"{prefix}.status: final handoff requires complete")
    homepage_modules = {
        name: module for name, module in modules.items()
        if name in HOMEPAGE_MODULES or name.startswith("subplatform:")
    }
    search_modules = {name: module for name, module in modules.items() if name in SEARCH_MODULES}
    if homepage_modules:
        expected_homepage = "exhausted" if any(
            module.get("status") in {"confirmed", "suspected"} for module in homepage_modules.values()
        ) else "not_found_after_multiroute"
    else:
        expected_homepage = "not_applicable"
    if completion.get("homepage_review") not in HOMEPAGE_REVIEW_STATUSES:
        errors.append(f"{prefix}.homepage_review: invalid status")
    elif completion.get("homepage_review") != expected_homepage:
        errors.append(f"{prefix}.homepage_review: expected {expected_homepage}")
    expected_search = "exhausted" if search_modules else "not_applicable"
    if completion.get("native_search_review") not in NATIVE_SEARCH_REVIEW_STATUSES:
        errors.append(f"{prefix}.native_search_review: invalid status")
    elif completion.get("native_search_review") != expected_search:
        errors.append(f"{prefix}.native_search_review: expected {expected_search}")
    if completion.get("unreviewed_relevant_hits") != 0:
        errors.append(f"{prefix}.unreviewed_relevant_hits: must equal 0")
    if not _is_nonempty_text(completion.get("completion_note")):
        errors.append(f"{prefix}.completion_note: must be non-empty text")
    routes = completion.get("route_results")
    if not isinstance(routes, list) or not routes:
        errors.append(f"{prefix}.route_results: must be a non-empty list")
        return [], ledger_risk_refs, candidate_evaluations, all_pass_candidate_evaluations
    route_ids: set[str] = set()
    complete_routes: list[dict[str, Any]] = []
    edge_evidence_paths: set[str] = set()
    edge_artifact_paths: set[str] = set()
    edge_review_start_modes_by_route_id: dict[str, str] = {}
    ledger_item_keys_by_route_id: dict[str, set[tuple[str, str]]] = {}
    partial_risk_refs_by_route_id: dict[str, set[tuple[str, str, str, str, str]]] = {}
    partial_decisions_by_route_id: dict[str, set[str]] = {}
    partial_candidates_by_route_id: dict[str, dict[str, Any]] = {}
    partial_item_observations_by_route_id: dict[str, list[dict[str, Any]]] = {}
    expected_route_fields = {
        "route_id", "module_key", "surface", "route_family", "evidence_origin",
        "evidence_fingerprint", "account_or_query_url", "resolved_url",
        "serial_route_index", "linear_pass_index",
        "tool_name", "tool_version", "tool_kind", "tool_path", "tool_sha256", "status", "termination",
        "permission_basis", "official_product", "official_endpoint", "authorization_status",
        "authorization_evidence", "edge_session_state", "edge_window_continuity_id",
        "edge_page_continuity_id", "max_task_open_edge_pages", "user_login_completed_at",
        "edge_evidence_path", "edge_evidence_sha256",
        "discovered_items", "reviewed_items", "unreviewed_items", "result_log_path",
        "item_ledger_path", "item_ledger_sha256", "query_ledger_path", "query_ledger_sha256",
        "aliases_covered", "keyword_groups_covered", "resolved_by_route_ids",
        "risk_terms_sha256", "started_at", "completed_at", "boundary",
    }
    for index, route in enumerate(routes):
        route_prefix = f"{prefix}.route_results[{index}]"
        if not isinstance(route, dict):
            errors.append(f"{route_prefix}: must be an object")
            continue
        _validate_exact_fields(route, expected_route_fields, route_prefix, errors)
        for field in (
            "route_id", "module_key", "surface", "route_family", "evidence_origin",
            "evidence_fingerprint", "tool_name",
            "tool_version", "permission_basis", "result_log_path", "item_ledger_path",
            "started_at", "completed_at",
        ):
            if not _is_nonempty_text(route.get(field)):
                errors.append(f"{route_prefix}.{field}: must be non-empty text")
        if route.get("route_family") not in ROUTE_FAMILIES:
            errors.append(f"{route_prefix}.route_family: invalid controlled route family")
        if not _is_url(route.get("evidence_origin")):
            errors.append(f"{route_prefix}.evidence_origin: must be a reproducible http(s) origin URL")
        if not isinstance(route.get("evidence_fingerprint"), str) or not SHA256_RE.fullmatch(str(route.get("evidence_fingerprint", ""))):
            errors.append(f"{route_prefix}.evidence_fingerprint: must be lowercase SHA-256")
        route_id = route.get("route_id")
        if _is_nonempty_text(route_id):
            if route_id in route_ids:
                errors.append(f"{route_prefix}.route_id: must be unique within completion")
            route_ids.add(route_id)
        serial_route_index = route.get("serial_route_index")
        if not _is_int(serial_route_index) or serial_route_index <= 0:
            errors.append(f"{route_prefix}.serial_route_index: must be a positive integer")
        linear_pass_index = route.get("linear_pass_index")
        if not _is_int(linear_pass_index) or linear_pass_index < 0:
            errors.append(f"{route_prefix}.linear_pass_index: must be a non-negative integer")
        module_key = route.get("module_key")
        tool_kind = route.get("tool_kind")
        if module_key not in modules:
            errors.append(f"{route_prefix}.module_key: does not match a Chapter 4 module")
        else:
            allowed_surfaces = set(_required_surfaces(platform_key, str(module_key), modules[module_key]))
            if linear_pass_index == 0 and (
                module_key in {"homepage", "subject_homepage"}
                or str(module_key).startswith("subplatform:")
            ):
                allowed_surfaces.add("account_discovery")
            if route.get("surface") not in allowed_surfaces:
                errors.append(
                    f"{route_prefix}.surface: must be one of {sorted(allowed_surfaces)!r} "
                    f"for {platform_key}.{module_key}"
                )
        if not _is_url(route.get("account_or_query_url")) or _is_placeholder_url(route.get("account_or_query_url")):
            errors.append(f"{route_prefix}.account_or_query_url: must be a real http(s) URL")
        if not _is_url(route.get("resolved_url")) or _is_placeholder_url(route.get("resolved_url")):
            errors.append(f"{route_prefix}.resolved_url: must be a real final visible http(s) URL")
        elif (
            tool_kind not in INTERACTIVE_BROWSER_TOOL_KINDS
            and route.get("resolved_url") != route.get("account_or_query_url")
        ):
            errors.append(f"{route_prefix}.resolved_url: non-browser route must equal account_or_query_url")
        elif route.get("surface") == "account_discovery" and linear_pass_index == 0:
            _validate_platform_module_url(
                platform_key, str(module_key), route.get("resolved_url"),
                f"{route_prefix}.resolved_url", errors,
            )
        if route.get("surface") != "account_discovery":
            _validate_platform_module_url(
                platform_key, str(module_key), route.get("account_or_query_url"),
                f"{route_prefix}.account_or_query_url", errors,
            )
        status = route.get("status")
        tool_path = route.get("tool_path")
        if tool_kind not in TOOL_KINDS:
            errors.append(f"{route_prefix}.tool_kind: invalid tool kind")
        for field in ("official_product", "official_endpoint"):
            if not isinstance(route.get(field), str):
                errors.append(f"{route_prefix}.{field}: must be text")
        if tool_kind in INTERACTIVE_BROWSER_TOOL_KINDS and (
            route.get("official_product") or route.get("official_endpoint")
        ):
            errors.append(f"{route_prefix}: interactive browser UI route must leave official product/endpoint empty")
        if tool_kind == "microsoft_edge_visible" and route.get("tool_name") != "Microsoft Edge":
            errors.append(f"{route_prefix}.tool_name: legacy microsoft_edge_visible route must equal Microsoft Edge")
        if tool_kind == "browser_ui":
            if not _is_nonempty_text(route.get("tool_name")):
                errors.append(f"{route_prefix}.tool_name: browser_ui must name the actual persistent desktop browser")
            elif _temporary_browser_identity(route.get("tool_name")):
                errors.append(
                    f"{route_prefix}.tool_name: browser_ui must use a persistent desktop browser, "
                    "not a Codex/OpenAI/in-app/iab/embedded/builtin/hosted/headless/temporary/ephemeral browser"
                )
        authorization_status = route.get("authorization_status")
        if authorization_status not in AUTHORIZATION_STATUSES:
            errors.append(f"{route_prefix}.authorization_status: invalid value")
        if status == "complete" and authorization_status == "permission_missing":
            errors.append(f"{route_prefix}.authorization_status: permission_missing blocks completion")
        if (
            tool_kind in INTERACTIVE_BROWSER_TOOL_KINDS
            and authorization_status not in {"not_required_browser_ui", "not_required_edge_visible"}
        ):
            errors.append(
                f"{route_prefix}.authorization_status: interactive browser UI review must use "
                "not_required_browser_ui or legacy not_required_edge_visible"
            )
        if authorization_status == "not_required_manual_visible":
            errors.append(f"{route_prefix}.authorization_status: legacy not_required_manual_visible is forbidden")
        if (
            tool_kind in INTERACTIVE_BROWSER_TOOL_KINDS
            and route.get("evidence_origin") != route.get("account_or_query_url")
        ):
            errors.append(
                f"{route_prefix}.evidence_origin: interactive browser route must equal its visibly reviewed URL"
            )
        if tool_kind == "browser_ui" and route.get("route_family") not in BROWSER_UI_ROUTE_FAMILIES:
            errors.append(f"{route_prefix}.route_family: incompatible with browser_ui")
        if (
            tool_kind == "microsoft_edge_visible"
            and route.get("route_family") not in LEGACY_EDGE_ROUTE_FAMILIES
        ):
            errors.append(f"{route_prefix}.route_family: incompatible with legacy microsoft_edge_visible")
        if tool_kind == "official_api" and authorization_status not in {
            "public_official_api", "approved_app_permission", "approved_research_access",
        }:
            errors.append(f"{route_prefix}.authorization_status: official_api lacks applicable official authorization")
        if tool_kind == "official_api":
            if not _is_nonempty_text(route.get("official_product")):
                errors.append(f"{route_prefix}.official_product: official API route requires product name")
            if not _is_url(route.get("official_endpoint")):
                errors.append(f"{route_prefix}.official_endpoint: official API route requires public endpoint URL")
            elif route.get("evidence_origin") != route.get("official_endpoint"):
                errors.append(f"{route_prefix}.evidence_origin: official API route must equal official_endpoint")
        if tool_kind == "official_api" and route.get("route_family") not in {"official_api", "approved_research_product"}:
            errors.append(f"{route_prefix}.route_family: official_api tool requires official_api or approved_research_product")
        if tool_kind == "authorized_export" and authorization_status != "authorized_export":
            errors.append(f"{route_prefix}.authorization_status: authorized_export route requires authorized_export")
        if tool_kind == "authorized_export" and route.get("route_family") != "authorized_export":
            errors.append(f"{route_prefix}.route_family: authorized_export tool requires authorized_export")
        if tool_kind == "local_script" and status == "complete" and authorization_status not in {
            "public_official_api", "approved_app_permission", "approved_research_access",
            "written_platform_permission",
        }:
            errors.append(f"{route_prefix}.authorization_status: automated route lacks platform permission")
        if tool_kind == "local_script" and status == "complete" and route.get("route_family") not in {
            "official_api", "approved_research_product",
        }:
            errors.append(f"{route_prefix}.route_family: local script must use an official API/product route")
        _validate_authorization_evidence(
            route.get("authorization_evidence"), route=route,
            prefix=f"{route_prefix}.authorization_evidence", check_files=check_files, errors=errors,
        )
        route_started_at = _zoned_datetime(route.get("started_at"), f"{route_prefix}.started_at", errors)
        route_completed_at = _zoned_datetime(route.get("completed_at"), f"{route_prefix}.completed_at", errors)
        if route_started_at is not None and route_completed_at is not None and route_started_at > route_completed_at:
            errors.append(f"{route_prefix}: started_at must not be after completed_at")
        edge_fields = (
            "edge_session_state", "edge_window_continuity_id", "user_login_completed_at",
            "edge_page_continuity_id", "max_task_open_edge_pages",
            "edge_evidence_path", "edge_evidence_sha256",
        )
        if tool_kind in INTERACTIVE_BROWSER_TOOL_KINDS:
            edge_state = route.get("edge_session_state")
            if edge_state not in EDGE_SESSION_STATES:
                errors.append(f"{route_prefix}.edge_session_state: invalid interactive-browser session state")
            continuity_id = route.get("edge_window_continuity_id")
            if not isinstance(continuity_id, str) or not EDGE_WINDOW_ID_RE.fullmatch(continuity_id):
                errors.append(
                    f"{route_prefix}.edge_window_continuity_id: must be a canonical lowercase UUIDv4"
                )
            page_continuity_id = route.get("edge_page_continuity_id")
            if not isinstance(page_continuity_id, str) or not EDGE_WINDOW_ID_RE.fullmatch(page_continuity_id):
                errors.append(
                    f"{route_prefix}.edge_page_continuity_id: must be a canonical lowercase UUIDv4"
                )
            if (
                not _is_int(route.get("max_task_open_edge_pages"))
                or route.get("max_task_open_edge_pages") <= 0
            ):
                errors.append(
                    f"{route_prefix}.max_task_open_edge_pages: interactive-browser route requires a positive "
                    "task-wide observed maximum"
                )
            login_completed_at = route.get("user_login_completed_at")
            parsed_login_at: datetime | None = None
            if edge_state == "user_login_completed":
                parsed_login_at = _zoned_datetime(
                    login_completed_at, f"{route_prefix}.user_login_completed_at", errors,
                )
                if parsed_login_at is not None and route_started_at is not None and parsed_login_at < route_started_at:
                    errors.append(f"{route_prefix}.user_login_completed_at: must not be before route started_at")
                if parsed_login_at is not None and route_completed_at is not None and parsed_login_at > route_completed_at:
                    errors.append(f"{route_prefix}.user_login_completed_at: must not be after route completed_at")
            elif login_completed_at is not None:
                errors.append(
                    f"{route_prefix}.user_login_completed_at: only user_login_completed may carry a timestamp"
                )
            if edge_state == "login_required" and status == "complete":
                errors.append(f"{route_prefix}.edge_session_state: login_required blocks completion")
            edge_path_value = route.get("edge_evidence_path")
            edge_sha = route.get("edge_evidence_sha256")
            if not _is_nonempty_text(edge_path_value):
                errors.append(f"{route_prefix}.edge_evidence_path: interactive-browser route requires a path")
            if not isinstance(edge_sha, str) or not SHA256_RE.fullmatch(edge_sha):
                errors.append(
                    f"{route_prefix}.edge_evidence_sha256: interactive-browser route requires lowercase SHA-256"
                )
            if check_files and _is_nonempty_text(edge_path_value):
                edge_path = _path_under_root(str(edge_path_value), f"{route_prefix}.edge_evidence_path", errors)
                edge_key = str(edge_path).lower()
                if edge_key in edge_evidence_paths:
                    errors.append(
                        f"{route_prefix}.edge_evidence_path: one browser manifest cannot prove two routes"
                    )
                edge_evidence_paths.add(edge_key)
                if not edge_path.is_file():
                    errors.append(f"{route_prefix}.edge_evidence_path: file does not exist")
                elif isinstance(edge_sha, str) and SHA256_RE.fullmatch(edge_sha) and _sha256(edge_path) != edge_sha:
                    errors.append(
                        f"{route_prefix}.edge_evidence_sha256: does not match interactive-browser evidence file"
                    )
                elif isinstance(edge_sha, str) and SHA256_RE.fullmatch(edge_sha):
                    _manifest_valid, artifact_key = _validate_edge_route_evidence_manifest(
                        edge_path, route=route, prefix=f"{route_prefix}.edge_evidence_path", errors=errors,
                    )
                    try:
                        edge_manifest = json.loads(edge_path.read_text(encoding="utf-8-sig"))
                    except (OSError, UnicodeError, json.JSONDecodeError):
                        edge_manifest = None
                    if (
                        isinstance(edge_manifest, dict)
                        and _is_nonempty_text(route_id)
                        and isinstance(edge_manifest.get("review_start_mode"), str)
                    ):
                        edge_review_start_modes_by_route_id[str(route_id)] = edge_manifest["review_start_mode"]
                    if artifact_key:
                        if artifact_key in edge_artifact_paths:
                            errors.append(
                                f"{route_prefix}.edge_evidence_path: one browser artifact cannot prove two routes"
                            )
                        edge_artifact_paths.add(artifact_key)
        else:
            for field in edge_fields:
                if route.get(field) is not None:
                    errors.append(f"{route_prefix}.{field}: non-browser route requires null")
        if tool_path is not None and not _is_nonempty_text(tool_path):
            errors.append(f"{route_prefix}.tool_path: must be null or non-empty text")
        tool_sha = route.get("tool_sha256")
        if tool_sha is not None and (not isinstance(tool_sha, str) or not SHA256_RE.fullmatch(tool_sha)):
            errors.append(f"{route_prefix}.tool_sha256: must be null or lowercase SHA-256")
        if tool_kind == "local_script":
            if not _is_nonempty_text(tool_path):
                errors.append(f"{route_prefix}.tool_path: local_script requires an absolute script path")
            elif not Path(tool_path).is_absolute():
                errors.append(f"{route_prefix}.tool_path: local_script path must be absolute")
            if not isinstance(tool_sha, str) or not SHA256_RE.fullmatch(tool_sha):
                errors.append(f"{route_prefix}.tool_sha256: local_script requires lowercase SHA-256")
            if check_files and _is_nonempty_text(tool_path):
                resolved_tool = Path(tool_path).resolve(strict=False)
                if not resolved_tool.is_file():
                    errors.append(f"{route_prefix}.tool_path: file does not exist: {resolved_tool}")
                elif isinstance(tool_sha, str) and SHA256_RE.fullmatch(tool_sha) and _sha256(resolved_tool) != tool_sha:
                    errors.append(f"{route_prefix}.tool_sha256: does not match local script")
        elif tool_kind in TOOL_KINDS:
            if tool_path is not None or tool_sha is not None:
                errors.append(f"{route_prefix}: non-local tool requires null tool_path and tool_sha256")
        if status not in ROUTE_STATUSES:
            errors.append(f"{route_prefix}.status: invalid route status")
        termination = route.get("termination")
        if not _is_nonempty_text(termination):
            errors.append(f"{route_prefix}.termination: must be non-empty text")
        if termination in LOGIN_TERMINATIONS:
            if tool_kind not in INTERACTIVE_BROWSER_TOOL_KINDS:
                errors.append(
                    f"{route_prefix}.termination: login boundary must originate from an interactive browser UI"
                )
            if route.get("edge_session_state") != "login_required":
                errors.append(f"{route_prefix}.edge_session_state: login boundary requires login_required")
        elif route.get("edge_session_state") == "login_required":
            errors.append(
                f"{route_prefix}.termination: login_required session state requires one of "
                f"{sorted(LOGIN_TERMINATIONS)!r}"
            )
        for field in ("discovered_items", "reviewed_items", "unreviewed_items"):
            value = route.get(field)
            if not _is_int(value) or value < 0:
                errors.append(f"{route_prefix}.{field}: must be a non-negative integer")
        item_ledger_sha = route.get("item_ledger_sha256")
        if not isinstance(item_ledger_sha, str) or not SHA256_RE.fullmatch(item_ledger_sha):
            errors.append(f"{route_prefix}.item_ledger_sha256: must be lowercase SHA-256")
        if check_files and _is_nonempty_text(route.get("item_ledger_path")):
            hashed_ledger_path = _path_under_root(
                str(route["item_ledger_path"]), f"{route_prefix}.item_ledger_path", errors,
            )
            if not hashed_ledger_path.is_file():
                errors.append(f"{route_prefix}.item_ledger_path: file does not exist: {hashed_ledger_path}")
            elif (
                isinstance(item_ledger_sha, str)
                and SHA256_RE.fullmatch(item_ledger_sha)
                and _sha256(hashed_ledger_path) != item_ledger_sha
            ):
                errors.append(f"{route_prefix}.item_ledger_sha256: does not match item ledger file")
        aliases = route.get("aliases_covered")
        groups = route.get("keyword_groups_covered")
        resolved_by = route.get("resolved_by_route_ids")
        if not isinstance(aliases, list) or any(not _is_nonempty_text(item) for item in aliases):
            errors.append(f"{route_prefix}.aliases_covered: must be a text list")
            aliases = []
        elif len(aliases) != len(set(aliases)):
            errors.append(f"{route_prefix}.aliases_covered: values must be unique")
        if not isinstance(groups, list) or any(not _is_nonempty_text(item) for item in groups):
            errors.append(f"{route_prefix}.keyword_groups_covered: must be a text list")
            groups = []
        elif len(groups) != len(set(groups)):
            errors.append(f"{route_prefix}.keyword_groups_covered: values must be unique")
        if not isinstance(resolved_by, list) or any(not _is_nonempty_text(item) for item in resolved_by):
            errors.append(f"{route_prefix}.resolved_by_route_ids: must be a text list")
            resolved_by = []
        elif len(resolved_by) != len(set(resolved_by)):
            errors.append(f"{route_prefix}.resolved_by_route_ids: values must be unique")
        query_path_value = route.get("query_ledger_path")
        query_sha = route.get("query_ledger_sha256")
        if module_key in SEARCH_MODULES:
            if status == "complete":
                if not _is_nonempty_text(query_path_value):
                    errors.append(f"{route_prefix}.query_ledger_path: completed search route requires a path")
                if not isinstance(query_sha, str) or not SHA256_RE.fullmatch(query_sha):
                    errors.append(f"{route_prefix}.query_ledger_sha256: completed search route requires lowercase SHA-256")
                if set(aliases) != coverage_aliases:
                    errors.append(f"{route_prefix}.aliases_covered: must exactly equal coverage aliases")
                route_groups = set(groups)
                route_search_mode = _completed_search_group_mode(
                    platform_key, route_groups,
                    coverage_keyword_groups=coverage_keyword_groups,
                    native_search_sentinel_groups=native_search_sentinel_groups,
                )
                if route_search_mode is None and platform_key in {"domestic_other", "overseas_other"}:
                    errors.append(
                        f"{route_prefix}.keyword_groups_covered: Baidu/Google routes must exactly equal "
                        "coverage.keyword_groups_checked"
                    )
                elif route_search_mode is None:
                    errors.append(
                        f"{route_prefix}.keyword_groups_covered: named-platform completed search route must "
                        "equal either coverage.native_search_sentinel_groups (adaptive) or "
                        "coverage.keyword_groups_checked (full)"
                    )
            else:
                if (query_path_value is None) != (query_sha is None):
                    errors.append(f"{route_prefix}: blocked/failed query ledger path and hash must both be null or both set")
                if query_sha is not None and (not isinstance(query_sha, str) or not SHA256_RE.fullmatch(query_sha)):
                    errors.append(f"{route_prefix}.query_ledger_sha256: must be null or lowercase SHA-256")
                if not set(aliases).issubset(coverage_aliases):
                    errors.append(f"{route_prefix}.aliases_covered: contains unknown aliases")
                if not set(groups).issubset(coverage_keyword_groups):
                    errors.append(f"{route_prefix}.keyword_groups_covered: contains unknown groups")
        else:
            if query_path_value is not None or query_sha is not None:
                errors.append(f"{route_prefix}: non-search route requires null query ledger fields")
            if aliases or groups:
                errors.append(f"{route_prefix}: non-search route must leave alias/group coverage empty")
        if route.get("risk_terms_sha256") != risk_terms_sha256:
            errors.append(f"{route_prefix}.risk_terms_sha256: must match coverage")
        if not isinstance(route.get("boundary"), str):
            errors.append(f"{route_prefix}.boundary: must be text")
        if status == "complete":
            coverage_eligible = _is_int(linear_pass_index) and linear_pass_index > 0
            final_reconciliation_eligible = linear_pass_index == final_linear_pass_index
            if coverage_eligible:
                complete_routes.append(route)
            if route.get("boundary") != "":
                errors.append(f"{route_prefix}.boundary: completed route must be empty")
            if resolved_by:
                errors.append(f"{route_prefix}.resolved_by_route_ids: completed route must be empty")
            if termination not in COMPLETE_TERMINATIONS:
                marker = " (explicitly forbidden)" if termination in FORBIDDEN_COMPLETE_TERMINATIONS else ""
                errors.append(f"{route_prefix}.termination: not a verified natural end{marker}")
            discovered = route.get("discovered_items")
            reviewed = route.get("reviewed_items")
            unreviewed = route.get("unreviewed_items")
            if _is_int(discovered) and _is_int(reviewed) and discovered != reviewed:
                errors.append(f"{route_prefix}: discovered_items must equal reviewed_items")
            if unreviewed != 0:
                errors.append(f"{route_prefix}.unreviewed_items: must equal 0")
            if check_files:
                log_path = _path_under_root(str(route.get("result_log_path", "")), f"{route_prefix}.result_log_path", errors)
                ledger_path = _path_under_root(str(route.get("item_ledger_path", "")), f"{route_prefix}.item_ledger_path", errors)
                _validate_route_result_log(
                    route, log_path, prefix=f"{route_prefix}.result_log_path", errors=errors,
                    platform_key=platform_key,
                )
                query_counts = None
                if module_key in SEARCH_MODULES and _is_nonempty_text(query_path_value):
                    query_path = _path_under_root(query_path_value, f"{route_prefix}.query_ledger_path", errors)
                    query_counts = _validate_query_ledger(
                        query_path,
                        prefix=f"{route_prefix}.query_ledger_path",
                        platform_key=platform_key,
                        module_key=str(module_key),
                        aliases=set(aliases),
                        keyword_groups=set(groups),
                        expected_sha256=str(query_sha or ""),
                        errors=errors,
                    )
                    displayed_url = str(route.get("account_or_query_url", ""))
                    if displayed_url not in query_counts:
                        errors.append(
                            f"{route_prefix}.account_or_query_url: displayed Chapter 4 search URL "
                            "must be one of this route's completed query-ledger URLs"
                        )
                if _is_int(discovered) and discovered >= 0:
                    route_account_url = (
                        str(route.get("account_or_query_url", ""))
                        if (
                            (
                                module_key in {"homepage", "subject_homepage"}
                                or str(module_key).startswith("subplatform:")
                            )
                            and route.get("surface") != "account_discovery"
                            and route.get("account_or_query_url") in delivered_account_urls
                        )
                        else None
                    )
                    (
                        route_risk_refs,
                        route_decisions,
                        route_item_keys,
                        route_candidates,
                        route_item_observations,
                    ) = _validate_item_ledger(
                        ledger_path,
                        prefix=f"{route_prefix}.item_ledger_path",
                        platform_key=platform_key,
                        module_key=str(module_key),
                        subject_display_name=subject_display_name,
                        subject_aliases=subject_aliases,
                        source_inventory=source_inventory,
                        route_origin_url=str(route.get("account_or_query_url", "")),
                        expected_surface=str(route.get("surface", "")),
                        expected_origin_url=(
                            None if module_key in SEARCH_MODULES else str(route.get("account_or_query_url", ""))
                        ),
                        query_counts=query_counts,
                        expected_count=discovered,
                        valid_group_ids=valid_group_ids,
                        risk_terms_sha256=risk_terms_sha256,
                        account_url=route_account_url,
                        route_started_at=route_started_at,
                        route_completed_at=route_completed_at,
                        errors=errors,
                    )
                    all_item_observations.extend(route_item_observations)
                    if coverage_eligible:
                        complete_item_observations.extend(route_item_observations)
                    _accumulate_candidate_evidence(
                        all_pass_candidate_evaluations,
                        route_candidates,
                        prefix=f"{route_prefix}.item_ledger_path",
                        errors=errors,
                    )
                    if coverage_eligible:
                        ledger_risk_refs.update(route_risk_refs)
                        ledger_decisions.setdefault(str(module_key), set()).update(route_decisions)
                    if final_reconciliation_eligible:
                        for candidate_url, evaluation in route_candidates.items():
                            previous = candidate_evaluations.get(candidate_url)
                            if previous is not None and previous != evaluation:
                                errors.append(
                                    f"{route_prefix}.item_ledger_path: candidate {candidate_url} "
                                    "has inconsistent identity evaluation across final reconciliation-cycle routes"
                                )
                            else:
                                candidate_evaluations[candidate_url] = evaluation
                    if _is_nonempty_text(route_id):
                        ledger_item_keys_by_route_id[str(route_id)] = route_item_keys
        elif status in {"blocked", "failed"}:
            if not _is_nonempty_text(route.get("boundary")):
                errors.append(f"{route_prefix}.boundary: blocked/failed route requires exact reason")
            if termination in COMPLETE_TERMINATIONS:
                errors.append(f"{route_prefix}.termination: blocked/failed route cannot claim a natural end")
            if check_files and _is_nonempty_text(route.get("result_log_path")):
                log_path = _path_under_root(route["result_log_path"], f"{route_prefix}.result_log_path", errors)
                _validate_route_result_log(
                    route, log_path, prefix=f"{route_prefix}.result_log_path", errors=errors,
                    platform_key=platform_key,
                )
            if (
                check_files
                and _is_nonempty_text(route.get("item_ledger_path"))
                and _is_int(route.get("reviewed_items"))
            ):
                partial_ledger_path = _path_under_root(
                    str(route["item_ledger_path"]), f"{route_prefix}.item_ledger_path", errors,
                )
                partial_account_url = (
                    str(route.get("account_or_query_url", ""))
                    if (
                        (
                            module_key in {"homepage", "subject_homepage"}
                            or str(module_key).startswith("subplatform:")
                        )
                        and route.get("surface") != "account_discovery"
                        and route.get("account_or_query_url") in delivered_account_urls
                    )
                    else None
                )
                (
                    _partial_risks,
                    _partial_decisions,
                    partial_item_keys,
                    partial_candidates,
                    partial_item_observations,
                ) = _validate_item_ledger(
                    partial_ledger_path,
                    prefix=f"{route_prefix}.item_ledger_path",
                    platform_key=platform_key,
                    module_key=str(module_key),
                    subject_display_name=subject_display_name,
                    subject_aliases=subject_aliases,
                    source_inventory=source_inventory,
                    route_origin_url=str(route.get("account_or_query_url", "")),
                    expected_surface=str(route.get("surface", "")),
                    expected_origin_url=(
                        None if module_key in SEARCH_MODULES else str(route.get("account_or_query_url", ""))
                    ),
                    query_counts=None,
                    expected_count=int(route["reviewed_items"]),
                    valid_group_ids=valid_group_ids,
                    risk_terms_sha256=risk_terms_sha256,
                    account_url=partial_account_url,
                    route_started_at=route_started_at,
                    route_completed_at=route_completed_at,
                    errors=errors,
                )
                all_item_observations.extend(partial_item_observations)
                # A candidate already shown and reviewed before any blocked or
                # failed boundary must survive into the completed final
                # reconciliation cycle;
                # otherwise a higher-scoring candidate could disappear merely
                # because the route did not reach its natural endpoint.
                _accumulate_candidate_evidence(
                    all_pass_candidate_evaluations,
                    partial_candidates,
                    prefix=f"{route_prefix}.item_ledger_path",
                    errors=errors,
                )
                if _is_nonempty_text(route_id):
                    ledger_item_keys_by_route_id[str(route_id)] = partial_item_keys
                    partial_risk_refs_by_route_id[str(route_id)] = _partial_risks
                    partial_decisions_by_route_id[str(route_id)] = _partial_decisions
                    partial_candidates_by_route_id[str(route_id)] = partial_candidates
                    partial_item_observations_by_route_id[str(route_id)] = partial_item_observations
    routes_by_id = {
        str(route.get("route_id")): route
        for route in routes
        if isinstance(route, dict) and _is_nonempty_text(route.get("route_id"))
    }
    checkpoint_resume_resolver_ids: set[str] = set()
    for index, route in enumerate(routes):
        if not isinstance(route, dict) or route.get("status") not in {"blocked", "failed"}:
            continue
        route_prefix = f"{prefix}.route_results[{index}]"
        resolver_ids = route.get("resolved_by_route_ids")
        if not isinstance(resolver_ids, list) or not resolver_ids:
            errors.append(f"{route_prefix}.resolved_by_route_ids: final handoff requires an equivalent completed resolver")
            continue
        if route.get("termination") in LOGIN_TERMINATIONS and len(resolver_ids) != 1:
            errors.append(
                f"{route_prefix}.resolved_by_route_ids: login boundary requires exactly one same-page resolver"
            )
        for resolver_id in resolver_ids:
            resolver = routes_by_id.get(str(resolver_id))
            if resolver is None:
                errors.append(f"{route_prefix}.resolved_by_route_ids: unknown route {resolver_id!r}")
                continue
            if resolver.get("status") != "complete":
                errors.append(f"{route_prefix}.resolved_by_route_ids: resolver {resolver_id!r} is not complete")
            for field in ("module_key", "surface", "account_or_query_url"):
                if resolver.get(field) != route.get(field):
                    errors.append(
                        f"{route_prefix}.resolved_by_route_ids: resolver {resolver_id!r} "
                        f"does not cover the same {field}"
                    )
            if route.get("termination") in LOGIN_TERMINATIONS:
                if resolver.get("tool_kind") not in INTERACTIVE_BROWSER_TOOL_KINDS:
                    errors.append(
                        f"{route_prefix}.resolved_by_route_ids: login boundary resolver {resolver_id!r} "
                        "must be a completed interactive browser UI route; API/export cannot resolve the webpage boundary"
                    )
                elif resolver.get("edge_session_state") != "user_login_completed":
                    errors.append(
                        f"{route_prefix}.resolved_by_route_ids: login boundary resolver {resolver_id!r} "
                        "must record edge_session_state=user_login_completed"
                    )
                resolver_review_mode = edge_review_start_modes_by_route_id.get(str(resolver_id))
                if resolver_review_mode == "checkpoint_resume":
                    checkpoint_resume_resolver_ids.add(str(resolver_id))
                if (
                    resolver.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
                    and resolver.get("edge_window_continuity_id") != route.get("edge_window_continuity_id")
                ):
                    errors.append(
                        f"{route_prefix}.resolved_by_route_ids: login boundary resolver {resolver_id!r} "
                        "must use the same edge_window_continuity_id"
                    )
                if (
                    resolver.get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
                    and resolver.get("edge_page_continuity_id") != route.get("edge_page_continuity_id")
                ):
                    errors.append(
                        f"{route_prefix}.resolved_by_route_ids: login boundary resolver {resolver_id!r} "
                        "must use the same edge_page_continuity_id"
                    )
                resolver_login_at = _zoned_datetime(
                    resolver.get("user_login_completed_at"),
                    f"{route_prefix}.resolved_by_route_ids[{resolver_id!r}].user_login_completed_at",
                    errors,
                )
                boundary_completed_at = _zoned_datetime(
                    route.get("completed_at"), f"{route_prefix}.completed_at", errors,
                )
                resolver_started_at = _zoned_datetime(
                    resolver.get("started_at"),
                    f"{route_prefix}.resolved_by_route_ids[{resolver_id!r}].started_at",
                    errors,
                )
                if (
                    resolver_started_at is not None
                    and boundary_completed_at is not None
                    and resolver_started_at < boundary_completed_at
                ):
                    errors.append(
                        f"{route_prefix}.resolved_by_route_ids: same-page login resolver must start "
                        "after the login-boundary route ends"
                    )
                if (
                    resolver_login_at is not None
                    and boundary_completed_at is not None
                    and resolver_login_at < boundary_completed_at
                ):
                    errors.append(
                        f"{route_prefix}.resolved_by_route_ids: user login must complete after the login boundary"
                    )
            if route.get("termination") in LOGIN_TERMINATIONS:
                blocked_ledger_keys = ledger_item_keys_by_route_id.get(str(route.get("route_id")))
                resolver_ledger_keys = ledger_item_keys_by_route_id.get(str(resolver_id))
                if blocked_ledger_keys is None:
                    errors.append(
                        f"{route_prefix}.item_ledger_path: login-boundary ledger could not be validated"
                    )
                elif resolver_ledger_keys is None:
                    errors.append(
                        f"{route_prefix}.resolved_by_route_ids: resolver {resolver_id!r} ledger could not be validated"
                    )
                else:
                    resolver_review_mode = edge_review_start_modes_by_route_id.get(str(resolver_id))
                    missing_prelogin_items = sorted(blocked_ledger_keys - resolver_ledger_keys)
                    duplicate_checkpoint_items = sorted(blocked_ledger_keys & resolver_ledger_keys)
                    if resolver_review_mode == "surface_start" and missing_prelogin_items:
                        errors.append(
                            f"{route_prefix}.resolved_by_route_ids: resolver {resolver_id!r} post-login "
                            f"surface_start ledger is missing pre-login item_id/URL pairs: {missing_prelogin_items}"
                        )
                    elif resolver_review_mode == "checkpoint_resume" and duplicate_checkpoint_items:
                        errors.append(
                            f"{route_prefix}.resolved_by_route_ids: resolver {resolver_id!r} checkpoint_resume "
                            f"ledger duplicates pre-login item_id/URL pairs: {duplicate_checkpoint_items}"
                        )
                    if resolver_review_mode == "checkpoint_resume":
                        blocked_route_id = str(route.get("route_id"))
                        ledger_risk_refs.update(partial_risk_refs_by_route_id.get(blocked_route_id, set()))
                        ledger_decisions.setdefault(str(route.get("module_key")), set()).update(
                            partial_decisions_by_route_id.get(blocked_route_id, set())
                        )
                        complete_item_observations.extend(
                            partial_item_observations_by_route_id.get(blocked_route_id, [])
                        )
                        if resolver.get("linear_pass_index") == final_linear_pass_index:
                            for candidate_url, evaluation in partial_candidates_by_route_id.get(
                                blocked_route_id, {}
                            ).items():
                                previous = candidate_evaluations.get(candidate_url)
                                if previous is not None and previous != evaluation:
                                    errors.append(
                                        f"{route_prefix}.resolved_by_route_ids: checkpoint candidate "
                                        f"{candidate_url} conflicts with final resolver evidence"
                                    )
                                else:
                                    candidate_evaluations[candidate_url] = evaluation
    for route_id, review_mode in edge_review_start_modes_by_route_id.items():
        if review_mode == "checkpoint_resume" and route_id not in checkpoint_resume_resolver_ids:
            errors.append(
                f"{prefix}.route_results[route_id={route_id}].edge_evidence_path.review_start_mode: "
                "checkpoint_resume is valid only for the completed same-page resolver of a login boundary"
            )
    complete_by_module: dict[str, list[dict[str, Any]]] = {}
    for route in complete_routes:
        complete_by_module.setdefault(str(route.get("module_key")), []).append(route)
    for module_key, module in modules.items():
        candidates = complete_by_module.get(module_key, [])
        eligible_candidates = candidates  # Each completed route is validated above, including API provenance.
        module_prefix = f"{prefix}.route_results[module_key={module_key}]"
        if module_key in SEARCH_MODULES:
            url = module.get("url")
            if not any(route.get("account_or_query_url") == url for route in eligible_candidates):
                errors.append(
                    f"{module_prefix}: no completed permitted exhaustive route matches the displayed search URL"
                )
            for surface in _required_surfaces(platform_key, module_key, module):
                if not any(
                    route.get("account_or_query_url") == url and route.get("surface") == surface
                    for route in eligible_candidates
                ):
                    errors.append(
                        f"{module_prefix}: missing completed permitted search surface {surface!r}"
                    )
            if not module.get("risk_group_ids"):
                for surface in _required_surfaces(platform_key, module_key, module):
                    groups = _independent_route_keys([
                        route for route in candidates
                        if route.get("account_or_query_url") == url and route.get("surface") == surface
                    ])
                    if len(groups) < 2:
                        errors.append(
                            f"{module_prefix}: clean search surface {surface!r} requires "
                            "two independent completed routes"
                        )
            if check_files:
                decisions = ledger_decisions.get(module_key, set())
                result_status = module.get("result_status")
                if result_status == "no_risk" and "no_risk" not in decisions:
                    errors.append(
                        f"{module_prefix}: result_status no_risk requires at least one reviewed no_risk item"
                    )
                if result_status == "no_related_content" and decisions & {"risk", "no_risk"}:
                    errors.append(
                        f"{module_prefix}: no_related_content contradicts a reviewed relevant item"
                    )
        elif module_key in HOMEPAGE_MODULES or module_key.startswith("subplatform:"):
            status = module.get("status")
            if status in {"confirmed", "suspected"}:
                per_url = module.get("url_risk_group_ids") if isinstance(module.get("url_risk_group_ids"), dict) else {}
                for url in module.get("urls", []):
                    if not any(route.get("account_or_query_url") == url for route in eligible_candidates):
                        errors.append(
                            f"{module_prefix}: homepage URL has no completed permitted exhaustive route: {url}"
                        )
                    for surface in _required_surfaces(platform_key, module_key, module):
                        if not any(
                            route.get("account_or_query_url") == url and route.get("surface") == surface
                            for route in eligible_candidates
                        ):
                            errors.append(
                                f"{module_prefix}: homepage URL {url} is missing required permitted surface {surface!r}"
                            )
                    if not per_url.get(url):
                        for surface in _required_surfaces(platform_key, module_key, module):
                            groups = _independent_route_keys([
                                route for route in candidates
                                if route.get("account_or_query_url") == url and route.get("surface") == surface
                            ])
                            if len(groups) < 2:
                                errors.append(
                                    f"{module_prefix}: clean homepage URL {url} surface {surface!r} "
                                    "requires two independent completed routes"
                                )
            elif status == "not_found":
                if not any(
                    route.get("surface") == "account_discovery"
                    and _is_platform_native_url(platform_key, route.get("account_or_query_url"))
                    for route in eligible_candidates
                ):
                    errors.append(
                        f"{module_prefix}: not_found requires a completed platform-native permitted account_discovery route"
                    )
                groups = _independent_route_keys(candidates)
                if len(groups) < 2:
                    errors.append(f"{module_prefix}: not_found requires two independent completed discovery routes")
    _validate_item_observation_consistency(
        all_item_observations,
        prefix=f"{prefix}.item_ledgers",
        errors=errors,
    )
    _validate_account_video_top10(
        complete_item_observations,
        delivered_account_urls=delivered_account_urls,
        prefix=f"{prefix}.account_video_top10",
        errors=errors,
    )
    _validate_adaptive_search_strategy(
        routes,
        prefix=prefix,
        platform_key=platform_key,
        coverage_keyword_groups=coverage_keyword_groups,
        native_search_sentinel_groups=native_search_sentinel_groups,
        platform_has_confirmed_account=platform_has_confirmed_account,
        platform_declared_risk=platform_declared_risk,
        platform_user_risk_lead=platform_user_risk_lead,
        ledger_decisions=ledger_decisions,
        candidate_evaluations=all_pass_candidate_evaluations,
        check_files=check_files,
        errors=errors,
    )
    return routes, ledger_risk_refs, candidate_evaluations, all_pass_candidate_evaluations


@lru_cache(maxsize=1)
def _prose_auditor():
    path = Path(__file__).resolve().parents[2] / "background-check-research" / "scripts" / "audit_handoff_prose.py"
    spec = importlib.util.spec_from_file_location("background_check_handoff_prose", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load prose auditor: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.audit_handoff_prose


def _prose_audit(payload: Any) -> dict[str, Any]:
    return _prose_auditor()(payload, input_kind="payload")


def _validate_exhaustive_payload(payload: Any, *, check_files: bool = True) -> list[str]:
    errors: list[str] = []
    if not check_files:
        errors.append("delivery_proof: structure-only diagnosis skips source/hash/review verification and cannot authorize delivery")
    if PSL_EXECUTABLE is None:
        errors.append(
            "runtime.psl: bundled Public Suffix List executable is required for fail-closed "
            "extra-platform suspect-slot validation"
        )
    if not isinstance(payload, dict):
        return ["payload: must be a JSON object"]
    try:
        for finding in _prose_audit(payload).get("findings", []):
            if finding.get("severity") == "error":
                errors.append(f"handoff_prose.{finding['path']}: {finding['rule']}: {finding['message']}")
    except (OSError, ImportError, ValueError, AttributeError, KeyError, TypeError) as exc:
        errors.append(f"handoff_prose: required prose audit unavailable or invalid: {exc}")
    _validate_exact_fields(payload, TOP_LEVEL, "payload", errors)
    if payload.get("schema_version") != SCHEMA_VERSION:
        if payload.get("schema_version") in {"1.8", "1.9"}:
            old_version = payload.get("schema_version")
            errors.append(
                f"schema_version: {old_version} is explicitly rejected; upgrade to 1.10 with genuine "
                "video_metadata, per-video video_triage, account Top-10 rank evidence where available, "
                "and all earlier route/media evidence; never infer or fabricate migration fields"
            )
        else:
            errors.append(f"schema_version: must equal {SCHEMA_VERSION}")

    subject = payload.get("subject")
    subject_aliases: list[str] = []
    basic_info_source_urls: set[str] = set()
    user_supplied_homepages: list[dict[str, Any]] = []
    user_supplied_canonical_urls: set[str] = set()
    user_supplied_input_urls: set[str] = set()
    if not isinstance(subject, dict):
        errors.append("subject: must be an object")
        subject = {}
    _validate_exact_fields(
        subject,
        {
            "display_name", "subject_type", "category", "basic_info", "basic_info_source_urls",
            "report_date", "aliases", "scope", "user_supplied_homepages",
        },
        "subject",
        errors,
    )
    for field in ("display_name", "category", "basic_info"):
        if not _is_nonempty_text(subject.get(field)):
            errors.append(f"subject.{field}: must be non-empty text")
    basic_info_sources = subject.get("basic_info_source_urls")
    if not isinstance(basic_info_sources, list) or not basic_info_sources or any(
        not _is_url(item) or _is_placeholder_url(item) for item in basic_info_sources
    ):
        errors.append("subject.basic_info_source_urls: must be a non-empty list of real http(s) URLs")
    else:
        if len(basic_info_sources) != len(set(basic_info_sources)):
            errors.append("subject.basic_info_source_urls: values must be unique")
        basic_info_source_urls = set(basic_info_sources)
    if subject.get("subject_type") not in SUBJECT_TYPES:
        errors.append(f"subject.subject_type: must be one of {sorted(SUBJECT_TYPES)!r}")
    report_date = subject.get("report_date")
    if not isinstance(report_date, str):
        errors.append("subject.report_date: must be ISO YYYY-MM-DD text")
    else:
        try:
            parsed_report_date = date.fromisoformat(report_date)
        except ValueError:
            errors.append("subject.report_date: must be a real ISO YYYY-MM-DD date")
        else:
            if parsed_report_date.isoformat() != report_date:
                errors.append("subject.report_date: must use zero-padded ISO YYYY-MM-DD")
    if not isinstance(subject.get("aliases"), list) or any(not _is_nonempty_text(item) for item in subject.get("aliases", [])):
        errors.append("subject.aliases: must be a text list")
    else:
        subject_aliases = list(subject["aliases"])
        if len(subject_aliases) != len(set(subject_aliases)):
            errors.append("subject.aliases: values must be unique")
    scope = subject.get("scope")
    if not isinstance(scope, dict):
        errors.append("subject.scope: must be an object")
    else:
        if not _is_nonempty_text(scope.get("unit")):
            errors.append("subject.scope.unit: must be non-empty text")
        if not isinstance(scope.get("included"), list) or not scope.get("included") or any(
            not _is_nonempty_text(item) for item in scope.get("included", [])
        ):
            errors.append("subject.scope.included: must be a non-empty text list")
        if not isinstance(scope.get("excluded"), list) or any(
            not _is_nonempty_text(item) for item in scope.get("excluded", [])
        ):
            errors.append("subject.scope.excluded: must be a text list")
    supplied = subject.get("user_supplied_homepages")
    if not isinstance(supplied, list):
        errors.append("subject.user_supplied_homepages: must be a list")
        supplied = []
    for index, item in enumerate(supplied):
        prefix = f"subject.user_supplied_homepages[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix}: must be an object")
            continue
        _validate_exact_fields(
            item,
            {"platform_key", "subplatform", "input_url", "canonical_url", "canonicalization_route_id"},
            prefix,
            errors,
        )
        key = item.get("platform_key")
        subplatform = item.get("subplatform")
        input_url = item.get("input_url")
        canonical_url = item.get("canonical_url")
        if not isinstance(item.get("canonicalization_route_id"), str):
            errors.append(f"{prefix}.canonicalization_route_id: must be text")
        if key not in PLATFORMS:
            errors.append(f"{prefix}.platform_key: must be a platform that supports subject homepages")
        if not isinstance(subplatform, str):
            errors.append(f"{prefix}.subplatform: must be text")
            subplatform = ""
        elif key in {"domestic_other", "overseas_other"}:
            if not subplatform.strip():
                errors.append(f"{prefix}.subplatform: extra-platform homepage requires a service name")
        elif subplatform:
            errors.append(f"{prefix}.subplatform: named-platform homepage must leave this empty")
        for field, url in (("input_url", input_url), ("canonical_url", canonical_url)):
            if not _is_url(url) or _is_placeholder_url(url):
                errors.append(f"{prefix}.{field}: must be a real non-placeholder http(s) URL")
        if key in PLATFORM_HOST_SUFFIXES:
            if _is_url(canonical_url):
                _validate_platform_module_url(str(key), "homepage", canonical_url, f"{prefix}.canonical_url", errors)
            input_platform = _named_platform_for_url(input_url)
            if input_platform != key:
                errors.append(
                    f"{prefix}.input_url: must itself belong to the declared platform or one of its "
                    "controlled short-link hosts"
                )
        if key in {"domestic_other", "overseas_other"} and _named_platform_for_url(canonical_url):
            errors.append(f"{prefix}.canonical_url: named-platform URL must use its named platform bucket")
        if key in {"domestic_other", "overseas_other"} and _named_platform_for_url(input_url):
            errors.append(f"{prefix}.input_url: named-platform URL must use its named platform bucket")
        if (
            key in {"domestic_other", "overseas_other"}
            and _is_url(input_url)
            and _is_url(canonical_url)
            and _actual_platform_slot(key, input_url) != _actual_platform_slot(key, canonical_url)
        ):
            errors.append(
                f"{prefix}: input_url and canonical_url must resolve to the same PSL/alias-normalized "
                "extra-platform service slot"
            )
        if _is_url(input_url):
            if str(input_url) in user_supplied_input_urls:
                errors.append(f"{prefix}.input_url: must be globally unique")
            user_supplied_input_urls.add(str(input_url))
        if _is_url(canonical_url):
            user_supplied_canonical_urls.add(str(canonical_url))
        user_supplied_homepages.append(item)

    verdict = payload.get("verdict")
    if not isinstance(verdict, dict):
        errors.append("verdict: must be an object")
        verdict = {}
    _validate_exact_fields(verdict, {"has_risk", "result_level", "overall_conclusion"}, "verdict", errors)
    if not isinstance(verdict.get("has_risk"), bool):
        errors.append("verdict.has_risk: must be boolean")
    if verdict.get("result_level") not in RESULT_LEVELS:
        errors.append("verdict.result_level: invalid tier")
    if not _is_nonempty_text(verdict.get("overall_conclusion")):
        errors.append("verdict.overall_conclusion: must be non-empty text")

    accounts = payload.get("accounts")
    if not isinstance(accounts, list):
        errors.append("accounts: must be a list")
        accounts = []
    confirmed_accounts: dict[tuple[str, str], set[str]] = {}
    suspected_accounts: dict[tuple[str, str], set[str]] = {}
    delivered_accounts: dict[tuple[str, str], set[str]] = {}
    delivered_account_names: dict[tuple[str, str], set[str]] = {}
    delivered_account_statuses: dict[tuple[str, str, str], str] = {}
    automatically_selected_suspected_slots: dict[tuple[str, str], int] = {}
    seen_account_urls: dict[str, int] = {}
    account_records_by_url: dict[str, tuple[int, dict[str, Any]]] = {}
    for index, account in enumerate(accounts):
        prefix = f"accounts[{index}]"
        if not isinstance(account, dict):
            errors.append(f"{prefix}: must be an object")
            continue
        _validate_exact_fields(
            account,
            {
                "platform_key", "subplatform", "subplatform_entry_id", "url", "handle",
                "status", "identity_basis", "source_urls",
            },
            prefix,
            errors,
        )
        key = account.get("platform_key")
        if key not in PLATFORMS:
            errors.append(f"{prefix}.platform_key: invalid platform")
        if not isinstance(account.get("subplatform"), str):
            errors.append(f"{prefix}.subplatform: must be text")
        if not isinstance(account.get("subplatform_entry_id"), str):
            errors.append(f"{prefix}.subplatform_entry_id: must be text")
        if not _is_url(account.get("url")) or _is_placeholder_url(account.get("url")):
            errors.append(f"{prefix}.url: must be a real http(s) URL")
        if key in PLATFORM_HOST_SUFFIXES:
            _validate_platform_module_url(str(key), "homepage", account.get("url"), f"{prefix}.url", errors)
        if not isinstance(account.get("handle"), str):
            errors.append(f"{prefix}.handle: must be text")
        status = account.get("status")
        if status not in ACCOUNT_STATUSES:
            errors.append(f"{prefix}.status: invalid account status")
        if not _is_nonempty_text(account.get("identity_basis")):
            errors.append(f"{prefix}.identity_basis: must be non-empty text")
        source_urls = account.get("source_urls")
        if not isinstance(source_urls, list) or not source_urls or any(
            not _is_url(item) or _is_placeholder_url(item) for item in source_urls
        ):
            errors.append(f"{prefix}.source_urls: must be a non-empty list of real URLs")
        sub = str(account.get("subplatform", ""))
        entry_id = str(account.get("subplatform_entry_id", ""))
        account_url = str(account.get("url", ""))
        if _is_url(account_url):
            if account_url in seen_account_urls:
                errors.append(
                    f"{prefix}.url: duplicates accounts[{seen_account_urls[account_url]}].url"
                )
            else:
                seen_account_urls[account_url] = index
                account_records_by_url[account_url] = (index, account)
        if key in PLATFORMS:
            if key not in {"domestic_other", "overseas_other"}:
                if sub:
                    errors.append(f"{prefix}.subplatform: named platform account must leave this empty")
                if entry_id:
                    errors.append(f"{prefix}.subplatform_entry_id: named platform account must leave this empty")
            else:
                if not sub:
                    errors.append(f"{prefix}.subplatform: extra platform account requires its service name")
                named_owner = _named_platform_for_url(account_url)
                if named_owner is not None:
                    errors.append(
                        f"{prefix}.url: URL belongs to named platform {named_owner!r}, not an other-platform bucket"
                    )
                if status in DELIVERED_ACCOUNT_STATUSES and not entry_id:
                    errors.append(f"{prefix}.subplatform_entry_id: delivered extra-platform account requires an entry id")
                if status in {"unconfirmed_candidate", "excluded_candidate"} and entry_id:
                    errors.append(f"{prefix}.subplatform_entry_id: non-delivered candidate must leave this empty")
        if (
            status == "suspected_homepage"
            and key in PLATFORMS
            and account_url not in user_supplied_canonical_urls
        ):
            slot = _actual_platform_slot(key, account_url)
            previous_index = automatically_selected_suspected_slots.get(slot)
            if previous_index is not None:
                errors.append(
                    f"{prefix}.status: at most one automatically selected suspected homepage is allowed per actual platform; "
                    f"already used by accounts[{previous_index}]"
                )
            else:
                automatically_selected_suspected_slots[slot] = index
        if status in DELIVERED_ACCOUNT_STATUSES and key in PLATFORMS and _is_url(account.get("url")):
            delivered_accounts.setdefault((key, entry_id), set()).add(account["url"])
            delivered_account_names.setdefault((key, entry_id), set()).add(sub)
            delivered_account_statuses[(str(key), entry_id, account["url"])] = (
                "confirmed" if status == "confirmed" else "suspected"
            )
            if status == "confirmed":
                confirmed_accounts.setdefault((key, entry_id), set()).add(account["url"])
            elif status == "suspected_homepage":
                suspected_accounts.setdefault((key, entry_id), set()).add(account["url"])

    works = payload.get("representative_works")
    if not isinstance(works, list):
        errors.append("representative_works: must be a list")
        works = []
    for index, work in enumerate(works):
        prefix = f"representative_works[{index}]"
        if not isinstance(work, dict):
            errors.append(f"{prefix}: must be an object")
            continue
        _validate_exact_fields(
            work, {"title", "role", "client_or_publisher", "source_url", "notes"}, prefix, errors,
        )
        if not _is_nonempty_text(work.get("title")):
            errors.append(f"{prefix}.title: must be non-empty text")
        for field in ("role", "client_or_publisher", "notes"):
            if not isinstance(work.get(field), str):
                errors.append(f"{prefix}.{field}: must be text")
        if not _is_url(work.get("source_url")) or _is_placeholder_url(work.get("source_url")):
            errors.append(f"{prefix}.source_url: must be a real URL")

    risk_groups = payload.get("risk_groups")
    if not isinstance(risk_groups, list):
        errors.append("risk_groups: must be a list")
        risk_groups = []
    group_ids: list[str] = []
    for index, group in enumerate(risk_groups):
        if isinstance(group, dict) and _is_nonempty_text(group.get("id")):
            group_ids.append(group["id"])
        else:
            errors.append(f"risk_groups[{index}].id: must be non-empty text")
    if len(group_ids) != len(set(group_ids)):
        errors.append("risk_groups: ids must be unique")
    valid_group_ids = set(group_ids)
    order = payload.get("risk_summary_order")
    if not isinstance(order, list) or any(not _is_nonempty_text(item) for item in order):
        errors.append("risk_summary_order: must be a text list")
        order = []
    if order != group_ids:
        errors.append("risk_summary_order: must equal risk_groups ids in exact order")
    if verdict.get("has_risk") != bool(risk_groups):
        errors.append("verdict.has_risk: must equal whether risk_groups is non-empty")
    if risk_groups and verdict.get("result_level") == "无合作风险":
        errors.append("verdict.result_level: risk payload cannot be 无合作风险")
    if not risk_groups and verdict.get("result_level") != "无合作风险":
        errors.append("verdict.result_level: no-risk payload must be 无合作风险")

    screenshot_contexts: dict[str, set[tuple[str, str]]] = {}
    instance_refs: list[tuple[str, str, str, list[tuple[str, str]], str]] = []
    expected_ledger_risks: set[tuple[str, str, str, str, str]] = set()
    suspected_risk_group_ids: set[str] = set()
    for group_index, group in enumerate(risk_groups):
        prefix = f"risk_groups[{group_index}]"
        if not isinstance(group, dict):
            errors.append(f"{prefix}: must be an object")
            continue
        _validate_exact_fields(
            group, {"id", "title", "category", "summary", "explanation", "instances"},
            prefix, errors,
        )
        for field in ("title", "category", "summary", "explanation"):
            if not _is_nonempty_text(group.get(field)):
                errors.append(f"{prefix}.{field}: must be non-empty text")
        instances = group.get("instances")
        if not isinstance(instances, list) or not instances:
            errors.append(f"{prefix}.instances: must be a non-empty list")
            instances = []
        for item_index, instance in enumerate(instances):
            item_prefix = f"{prefix}.instances[{item_index}]"
            if not isinstance(instance, dict):
                errors.append(f"{item_prefix}: must be an object")
                continue
            _validate_exact_fields(
                instance,
                {
                    "platform_key", "subplatform", "module_targets", "published_at", "finding",
                    "source_url", "source_type", "screenshots",
                },
                item_prefix,
                errors,
            )
            key = instance.get("platform_key")
            subplatform = instance.get("subplatform")
            module_targets = instance.get("module_targets")
            if key not in PLATFORMS:
                errors.append(f"{item_prefix}.platform_key: invalid platform")
            if not isinstance(subplatform, str):
                errors.append(f"{item_prefix}.subplatform: must be text")
                subplatform = ""
            parsed_targets: list[tuple[str, str]] = []
            if not isinstance(module_targets, list) or not module_targets:
                errors.append(f"{item_prefix}.module_targets: must be a non-empty list")
                module_targets = []
            for target_index, target in enumerate(module_targets):
                target_prefix = f"{item_prefix}.module_targets[{target_index}]"
                if not isinstance(target, dict):
                    errors.append(f"{target_prefix}: must be an object")
                    continue
                _validate_exact_fields(target, {"module_key", "module_url"}, target_prefix, errors)
                module_key = target.get("module_key")
                module_url = target.get("module_url")
                if not _is_nonempty_text(module_key):
                    errors.append(f"{target_prefix}.module_key: must be non-empty text")
                if not _is_url(module_url) or _is_placeholder_url(module_url):
                    errors.append(f"{target_prefix}.module_url: must be a real Chapter 4 URL")
                if _is_nonempty_text(module_key) and _is_url(module_url):
                    parsed_targets.append((module_key, module_url))
            if len(parsed_targets) != len(set(parsed_targets)):
                errors.append(f"{item_prefix}.module_targets: module_key/module_url pairs must be unique")
            if key in PLATFORMS:
                valid_modules = set(DELIVERY_MODULES[key]) - {"review_start_month"}
                for module_key, _module_url in parsed_targets:
                    if key in {"domestic_other", "overseas_other"} and module_key.startswith("subplatform:"):
                        if not subplatform:
                            errors.append(f"{item_prefix}.module_targets: extra-platform target requires subplatform name")
                    elif module_key not in valid_modules:
                        errors.append(f"{item_prefix}.module_targets: invalid module {module_key!r}")
            for field in ("published_at", "finding", "source_type"):
                if not _is_nonempty_text(instance.get(field)):
                    errors.append(f"{item_prefix}.{field}: must be non-empty text")
            has_suspected_target = False
            for module_key, module_url in parsed_targets:
                target_entry_id = (
                    module_key.removeprefix("subplatform:")
                    if module_key.startswith("subplatform:")
                    else ""
                )
                if delivered_account_statuses.get((str(key), target_entry_id, module_url)) == "suspected":
                    has_suspected_target = True
            if has_suspected_target and not str(instance.get("finding", "")).startswith("该疑似主页账号"):
                errors.append(
                    f"{item_prefix}.finding: suspected-homepage evidence must begin with '该疑似主页账号'"
                )
            if has_suspected_target and _is_nonempty_text(group.get("id")):
                suspected_risk_group_ids.add(str(group["id"]))
            source_url = instance.get("source_url")
            if not _is_url(source_url) or _is_placeholder_url(source_url):
                errors.append(f"{item_prefix}.source_url: must be a real direct URL")
            elif _is_nonempty_text(group.get("id")):
                if key in PLATFORM_HOST_SUFFIXES:
                    _validate_platform_module_url(str(key), "homepage", source_url, f"{item_prefix}.source_url", errors)
                for module_key, module_url in parsed_targets:
                    expected_ledger_risks.add((str(key), module_key, module_url, group["id"], source_url))
            screenshots = instance.get("screenshots")
            if not isinstance(screenshots, list) or not screenshots:
                errors.append(f"{item_prefix}.screenshots: must be a non-empty list")
                screenshots = []
            for shot_index, shot in enumerate(screenshots):
                shot_prefix = f"{item_prefix}.screenshots[{shot_index}]"
                if not isinstance(shot, dict):
                    errors.append(f"{shot_prefix}: must be an object")
                    continue
                _validate_exact_fields(
                    shot, {"path", "caption", "platform_label", "visible_text", "sha256"},
                    shot_prefix, errors,
                )
                for field in ("path", "caption", "platform_label", "visible_text", "sha256"):
                    if not _is_nonempty_text(shot.get(field)):
                        errors.append(f"{shot_prefix}.{field}: must be non-empty text")
                if _is_nonempty_text(shot.get("sha256")) and not SHA256_RE.fullmatch(shot["sha256"]):
                    errors.append(f"{shot_prefix}.sha256: must be lowercase SHA-256")
                if _is_nonempty_text(shot.get("path")):
                    resolved = _path_under_root(shot["path"], f"{shot_prefix}.path", errors)
                    screenshot_contexts.setdefault(str(resolved).lower(), set()).add((str(key), str(source_url)))
                    if resolved.suffix.lower() not in IMAGE_EXTENSIONS:
                        errors.append(f"{shot_prefix}.path: unsupported image extension")
                    if check_files:
                        if not resolved.is_file():
                            errors.append(f"{shot_prefix}.path: file does not exist: {resolved}")
                        else:
                            if resolved.stat().st_size > MAX_IMAGE_BYTES:
                                errors.append(f"{shot_prefix}.path: image exceeds 20 MB")
                            if _image_kind(resolved) is None:
                                errors.append(f"{shot_prefix}.path: invalid image signature")
                            if SHA256_RE.fullmatch(str(shot.get("sha256", ""))) and _sha256(resolved) != shot["sha256"]:
                                errors.append(f"{shot_prefix}.sha256: does not match file")
            if _is_nonempty_text(group.get("id")) and key in PLATFORMS:
                instance_refs.append((group["id"], key, str(subplatform), parsed_targets, str(source_url)))
    for group_index, group in enumerate(risk_groups):
        if not isinstance(group, dict) or str(group.get("id", "")) not in suspected_risk_group_ids:
            continue
        for field in ("summary", "explanation"):
            if "疑似主页" not in str(group.get(field, "")):
                errors.append(
                    f"risk_groups[{group_index}].{field}: suspected-homepage risk must contain '疑似主页'"
                )
    if suspected_risk_group_ids and "疑似主页" not in str(verdict.get("overall_conclusion", "")):
        errors.append(
            "verdict.overall_conclusion: payload with suspected-homepage risk must contain '疑似主页'"
        )
    for screenshot_path, contexts in screenshot_contexts.items():
        if len(contexts) > 1:
            errors.append(f"screenshots: one file is reused across different platform/source contexts: {screenshot_path}")

    coverage = payload.get("coverage")
    coverage_aliases: set[str] = set()
    keyword_groups: set[str] = set()
    native_search_sentinel_groups: set[str] = set()
    user_risk_lead_platforms: set[str] = set()
    coverage_source_inventory: set[str] = set()
    risk_terms_sha256 = ""
    final_linear_pass_index = 0
    coverage_started_at: datetime | None = None
    coverage_completed_at: datetime | None = None
    preflight_serial: dict[str, Any] | None = None
    if not isinstance(coverage, dict):
        errors.append("coverage: must be an object")
        coverage = {}
    required_coverage = {
        "started_at", "completed_at", "network_preflight", "risk_standard_path",
        "risk_standard_sha256", "risk_terms_path", "risk_terms_sha256", "risk_terms_count",
        "aliases_checked", "keyword_groups_checked", "native_search_sentinel_groups", "user_risk_leads",
        "search_engines_checked",
        "source_inventory", "final_linear_pass_index", "pending_cross_platform_leads",
    }
    _validate_exact_fields(coverage, required_coverage, "coverage", errors)
    for field in ("started_at", "completed_at", "risk_standard_path", "risk_standard_sha256", "risk_terms_path", "risk_terms_sha256"):
        if not _is_nonempty_text(coverage.get(field)):
            errors.append(f"coverage.{field}: must be non-empty text")
    for field in ("risk_standard_sha256", "risk_terms_sha256"):
        value = coverage.get(field)
        if _is_nonempty_text(value) and not SHA256_RE.fullmatch(value):
            errors.append(f"coverage.{field}: must be lowercase SHA-256")
    if _is_nonempty_text(coverage.get("risk_terms_sha256")):
        risk_terms_sha256 = coverage["risk_terms_sha256"]
    coverage_started_at = _zoned_datetime(coverage.get("started_at"), "coverage.started_at", errors)
    coverage_completed_at = _zoned_datetime(coverage.get("completed_at"), "coverage.completed_at", errors)
    if (
        coverage_started_at is not None
        and coverage_completed_at is not None
        and coverage_started_at > coverage_completed_at
    ):
        errors.append("coverage: started_at must not be after completed_at")
    if not _is_int(coverage.get("final_linear_pass_index")) or coverage.get("final_linear_pass_index") <= 0:
        errors.append("coverage.final_linear_pass_index: must be a positive integer")
    else:
        final_linear_pass_index = int(coverage["final_linear_pass_index"])
    pending_cross_platform_leads = coverage.get("pending_cross_platform_leads")
    if not isinstance(pending_cross_platform_leads, list):
        errors.append("coverage.pending_cross_platform_leads: must be an empty list in a final payload")
    elif pending_cross_platform_leads:
        errors.append("coverage.pending_cross_platform_leads: must be empty before final delivery")
    if not _is_int(coverage.get("risk_terms_count")) or coverage.get("risk_terms_count", 0) <= 0:
        errors.append("coverage.risk_terms_count: must be a positive integer")
    aliases_checked = coverage.get("aliases_checked")
    if not isinstance(aliases_checked, list) or not aliases_checked or any(not _is_nonempty_text(item) for item in aliases_checked):
        errors.append("coverage.aliases_checked: must be a non-empty text list")
    else:
        coverage_aliases = set(aliases_checked)
    delivered_account_handles = {
        str(account.get("handle"))
        for account in accounts
        if isinstance(account, dict)
        and account.get("status") in DELIVERED_ACCOUNT_STATUSES
        and _is_nonempty_text(account.get("handle"))
    }
    required_aliases = {
        str(subject.get("display_name", "")), *subject_aliases, *delivered_account_handles,
    } - {""}
    if not required_aliases.issubset(coverage_aliases):
        errors.append(
            "coverage.aliases_checked: must include the subject display name, every subject alias, "
            "and every non-empty confirmed/suspected homepage handle in its original submitted form"
        )
    groups_checked = coverage.get("keyword_groups_checked")
    if not isinstance(groups_checked, list) or not groups_checked or any(not _is_nonempty_text(item) for item in groups_checked):
        errors.append("coverage.keyword_groups_checked: must be a non-empty text list")
    else:
        keyword_groups = set(groups_checked)
        if len(groups_checked) != len(keyword_groups):
            errors.append("coverage.keyword_groups_checked: values must be unique")
    sentinel_groups = coverage.get("native_search_sentinel_groups")
    if not isinstance(sentinel_groups, list) or any(not _is_nonempty_text(item) for item in sentinel_groups):
        errors.append("coverage.native_search_sentinel_groups: must be a text list")
    else:
        native_search_sentinel_groups = set(sentinel_groups)
        if len(sentinel_groups) != len(native_search_sentinel_groups):
            errors.append("coverage.native_search_sentinel_groups: values must be unique")
        if len(native_search_sentinel_groups) < 4:
            errors.append("coverage.native_search_sentinel_groups: must contain at least four unique groups")
        if not native_search_sentinel_groups < keyword_groups:
            errors.append(
                "coverage.native_search_sentinel_groups: must be a non-empty proper subset of "
                "coverage.keyword_groups_checked"
            )
    user_risk_leads = coverage.get("user_risk_leads")
    if not isinstance(user_risk_leads, list):
        errors.append("coverage.user_risk_leads: must be a list")
    else:
        seen_lead_ids: set[str] = set()
        named_platforms = set(PLATFORMS) - {"domestic_other", "overseas_other"}
        for index, lead in enumerate(user_risk_leads):
            lead_prefix = f"coverage.user_risk_leads[{index}]"
            if not isinstance(lead, dict):
                errors.append(f"{lead_prefix}: must be an object")
                continue
            _validate_exact_fields(
                lead, {"lead_id", "platform_keys", "keyword_groups", "description"},
                lead_prefix, errors,
            )
            lead_id = lead.get("lead_id")
            if not _is_nonempty_text(lead_id) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", str(lead_id)):
                errors.append(f"{lead_prefix}.lead_id: must be a stable lowercase id using a-z, 0-9, _ or -")
            elif str(lead_id) in seen_lead_ids:
                errors.append(f"{lead_prefix}.lead_id: must be unique")
            else:
                seen_lead_ids.add(str(lead_id))
            platform_keys = lead.get("platform_keys")
            if (
                not isinstance(platform_keys, list)
                or not platform_keys
                or any(key not in named_platforms for key in platform_keys)
            ):
                errors.append(f"{lead_prefix}.platform_keys: must be a non-empty list of the twelve named platform keys")
                platform_keys = []
            elif len(platform_keys) != len(set(platform_keys)):
                errors.append(f"{lead_prefix}.platform_keys: values must be unique")
            user_risk_lead_platforms.update(str(key) for key in platform_keys)
            lead_groups = lead.get("keyword_groups")
            if (
                not isinstance(lead_groups, list)
                or not lead_groups
                or any(not _is_nonempty_text(group) or group not in keyword_groups for group in lead_groups)
            ):
                errors.append(f"{lead_prefix}.keyword_groups: must be a non-empty list drawn from coverage.keyword_groups_checked")
            elif len(lead_groups) != len(set(lead_groups)):
                errors.append(f"{lead_prefix}.keyword_groups: values must be unique")
            if not _is_nonempty_text(lead.get("description")):
                errors.append(f"{lead_prefix}.description: must be non-empty text")
    engines = coverage.get("search_engines_checked")
    if not isinstance(engines, list) or any(not _is_nonempty_text(item) for item in engines):
        errors.append("coverage.search_engines_checked: must be a text list")
    elif not {"baidu", "google"}.issubset({item.lower() for item in engines}):
        errors.append("coverage.search_engines_checked: must include baidu and google")
    if not isinstance(coverage.get("source_inventory"), list):
        errors.append("coverage.source_inventory: must be a list")
    if isinstance(coverage.get("source_inventory"), list):
        if not coverage["source_inventory"]:
            errors.append("coverage.source_inventory: must not be empty")
        elif any(not _is_url(item) or _is_placeholder_url(item) for item in coverage["source_inventory"]):
            errors.append("coverage.source_inventory: every item must be a real non-placeholder http(s) URL")
        else:
            coverage_source_inventory = set(coverage["source_inventory"])
            missing_basic_sources = sorted(basic_info_source_urls - set(coverage["source_inventory"]))
            if missing_basic_sources:
                errors.append(
                    "subject.basic_info_source_urls: URLs missing from coverage.source_inventory: "
                    + ", ".join(missing_basic_sources)
                )
            supplied_source_urls = {
                str(item.get(field))
                for item in user_supplied_homepages
                if isinstance(item, dict)
                for field in ("input_url", "canonical_url")
                if _is_url(item.get(field))
            }
            missing_supplied_sources = sorted(supplied_source_urls - set(coverage["source_inventory"]))
            if missing_supplied_sources:
                errors.append(
                    "subject.user_supplied_homepages: URLs missing from coverage.source_inventory: "
                    + ", ".join(missing_supplied_sources)
                )
    preflight = coverage.get("network_preflight")
    requires_edge_preflight = _requires_edge_network_preflight(payload.get("platforms"))
    if not isinstance(preflight, dict):
        errors.append("coverage.network_preflight: must be an object")
    else:
        expected = {
            "status", "checked_at", "proxy_configured", "proxy_reachable",
            "direct_https_reachable", "browser_session_reachable", "domestic_route_reachable",
            "overseas_route_reachable", "tested_hosts", "log_path",
        }
        _validate_exact_fields(preflight, expected, "coverage.network_preflight", errors)
        if preflight.get("status") != "complete":
            errors.append("coverage.network_preflight.status: must equal complete")
        if not _is_nonempty_text(preflight.get("checked_at")):
            errors.append("coverage.network_preflight.checked_at: must be non-empty text")
        elif not requires_edge_preflight:
            _zoned_datetime(preflight["checked_at"], "coverage.network_preflight.checked_at", errors)
        for field in (
            "proxy_configured", "proxy_reachable", "direct_https_reachable",
            "browser_session_reachable", "domestic_route_reachable", "overseas_route_reachable",
        ):
            if not isinstance(preflight.get(field), bool):
                errors.append(f"coverage.network_preflight.{field}: must be boolean")
        if preflight.get("domestic_route_reachable") is not True:
            errors.append("coverage.network_preflight: no working domestic route was proven")
        if preflight.get("overseas_route_reachable") is not True:
            errors.append("coverage.network_preflight: no working overseas route was proven")
        if not isinstance(preflight.get("tested_hosts"), list) or not preflight.get("tested_hosts") or any(
            not _is_nonempty_text(item) for item in preflight.get("tested_hosts", [])
        ):
            errors.append("coverage.network_preflight.tested_hosts: must be a non-empty text list")
        if not _is_nonempty_text(preflight.get("log_path")):
            errors.append("coverage.network_preflight.log_path: must be non-empty text")
        elif check_files:
            path = _path_under_root(preflight["log_path"], "coverage.network_preflight.log_path", errors)
            preflight_serial = _validate_network_preflight_log(
                preflight, path, errors, require_edge=requires_edge_preflight,
            )
    if check_files:
        for path_field, sha_field in (("risk_standard_path", "risk_standard_sha256"), ("risk_terms_path", "risk_terms_sha256")):
            if not _is_nonempty_text(coverage.get(path_field)):
                continue
            path = _path_under_root(coverage[path_field], f"coverage.{path_field}", errors)
            if not path.is_file():
                errors.append(f"coverage.{path_field}: file does not exist: {path}")
                continue
            if SHA256_RE.fullmatch(str(coverage.get(sha_field, ""))) and _sha256(path) != coverage[sha_field]:
                errors.append(f"coverage.{sha_field}: does not match file")
            if path_field == "risk_terms_path":
                try:
                    lines = [line.strip() for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip() and not line.lstrip().startswith("#")]
                except UnicodeError:
                    errors.append("coverage.risk_terms_path: must be UTF-8 text")
                    lines = []
                unique_lines = list(dict.fromkeys(lines))
                if coverage.get("risk_terms_count") != len(unique_lines):
                    errors.append("coverage.risk_terms_count: must equal unique non-comment term lines")
                if not coverage_aliases.issubset(set(unique_lines)):
                    errors.append("coverage.risk_terms_path: missing checked aliases")

    platforms = payload.get("platforms")
    if not isinstance(platforms, dict):
        errors.append("platforms: must be an object")
        platforms = {}
    if set(platforms) != set(PLATFORMS):
        missing = sorted(set(PLATFORMS) - set(platforms))
        extra = sorted(set(platforms) - set(PLATFORMS))
        if missing:
            errors.append(f"platforms: missing keys: {', '.join(missing)}")
        if extra:
            errors.append(f"platforms: unexpected keys: {', '.join(extra)}")
    platform_module_links: dict[tuple[str, str], set[str]] = {}
    platform_module_url_links: dict[tuple[str, str, str], set[str]] = {}
    platform_group_links: dict[str, set[str]] = {}
    subplatform_entries: dict[str, dict[str, str]] = {"domestic_other": {}, "overseas_other": {}}
    all_ledger_risk_refs: set[tuple[str, str, str, str, str]] = set()
    all_candidate_evaluations: dict[str, dict[str, Any]] = {}
    all_pass_candidate_evaluations: dict[str, dict[str, Any]] = {}
    all_route_contexts: list[dict[str, Any]] = []
    supplied_suspected_order_by_platform: dict[str, list[str]] = {}
    for supplied_homepage in user_supplied_homepages:
        supplied_key = str(supplied_homepage.get("platform_key", ""))
        supplied_url = str(supplied_homepage.get("canonical_url", ""))
        supplied_account = account_records_by_url.get(supplied_url)
        if supplied_account is None or supplied_account[1].get("status") != "suspected_homepage":
            continue
        ordered_urls = supplied_suspected_order_by_platform.setdefault(supplied_key, [])
        if supplied_url not in ordered_urls:
            ordered_urls.append(supplied_url)
    for key in PLATFORMS:
        record = platforms.get(key)
        prefix = f"platforms.{key}"
        if not isinstance(record, dict):
            errors.append(f"{prefix}: must be an object")
            continue
        expected_fields = set(PLATFORM_FIELDS)
        if key in OTHER_TAIL_STATEMENTS:
            expected_fields.add("other_platform_tail")
        _validate_exact_fields(record, expected_fields, prefix, errors)
        if record.get("display_name") != PLATFORM_DISPLAY[key]:
            errors.append(f"{prefix}.display_name: must be {PLATFORM_DISPLAY[key]!r}")
        if record.get("discovery_status") not in DISCOVERY_STATUSES:
            errors.append(f"{prefix}.discovery_status: invalid value")
        if record.get("discovery_status") == "access_blocked_unresolved":
            errors.append(f"{prefix}.discovery_status: unresolved access blocks final handoff")
        for field in ("risk_group_ids", "subplatforms"):
            if not isinstance(record.get(field), list):
                errors.append(f"{prefix}.{field}: must be a list")
        record_ids = record.get("risk_group_ids") if isinstance(record.get("risk_group_ids"), list) else []
        if any(not _is_nonempty_text(item) for item in record_ids):
            errors.append(f"{prefix}.risk_group_ids: must be a text list")
            record_ids = []
        if len(record_ids) != len(set(record_ids)):
            errors.append(f"{prefix}.risk_group_ids: values must be unique")
        unknown = sorted(set(record_ids) - valid_group_ids)
        if unknown:
            errors.append(f"{prefix}.risk_group_ids: unknown groups: {', '.join(unknown)}")
        platform_group_links[key] = set(record_ids)
        modules = record.get("delivery_modules")
        if not isinstance(modules, dict):
            errors.append(f"{prefix}.delivery_modules: must be an object")
            modules = {}
        expected_module_names = set(DELIVERY_MODULES[key])
        if set(modules) != expected_module_names:
            missing = sorted(expected_module_names - set(modules))
            extra = sorted(set(modules) - expected_module_names)
            if missing:
                errors.append(f"{prefix}.delivery_modules: missing modules: {', '.join(missing)}")
            if extra:
                errors.append(f"{prefix}.delivery_modules: unexpected modules: {', '.join(extra)}")
        validated_modules: dict[str, dict[str, Any]] = {}
        module_union: set[str] = set()
        for module_name in DELIVERY_MODULES[key]:
            module = modules.get(module_name)
            module_prefix = f"{prefix}.delivery_modules.{module_name}"
            if module_name == "review_start_month":
                homepage = modules.get("homepage")
                has_homepage = isinstance(homepage, dict) and homepage.get("status") in {"confirmed", "suspected"}
                if has_homepage:
                    if not isinstance(module, str) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", module):
                        errors.append(f"{module_prefix}: delivered X homepage requires YYYY-MM")
                elif module is not None:
                    errors.append(f"{module_prefix}: must be null when no X homepage is delivered")
                continue
            ids = _validate_module(module, module_name=module_name, prefix=module_prefix, valid_group_ids=valid_group_ids, errors=errors)
            if isinstance(module, dict):
                validated_modules[module_name] = module
                if module_name in HOMEPAGE_MODULES:
                    for url_index, url in enumerate(module.get("urls", []) if isinstance(module.get("urls"), list) else []):
                        _validate_platform_module_url(key, module_name, url, f"{module_prefix}.urls[{url_index}]", errors)
                elif module_name in SEARCH_MODULES:
                    _validate_platform_module_url(key, module_name, module.get("url"), f"{module_prefix}.url", errors)
            platform_module_links[(key, module_name)] = ids
            if isinstance(module, dict):
                if module_name in HOMEPAGE_MODULES:
                    per_url = module.get("url_risk_group_ids")
                    if isinstance(per_url, dict):
                        for url, url_ids in per_url.items():
                            if isinstance(url_ids, list):
                                platform_module_url_links[(key, module_name, str(url))] = set(url_ids)
                elif module_name in SEARCH_MODULES and _is_url(module.get("url")):
                    platform_module_url_links[(key, module_name, str(module["url"]))] = set(ids)
            module_union.update(ids)
        subplatforms = record.get("subplatforms") if isinstance(record.get("subplatforms"), list) else []
        if key not in {"domestic_other", "overseas_other"} and subplatforms:
            errors.append(f"{prefix}.subplatforms: only other buckets may contain entries")
        subplatform_union: set[str] = set()
        for sub_index, sub in enumerate(subplatforms):
            sub_prefix = f"{prefix}.subplatforms[{sub_index}]"
            if not isinstance(sub, dict):
                errors.append(f"{sub_prefix}: must be an object")
                continue
            _validate_exact_fields(sub, {"entry_id", "name", "homepage", "research_completion"}, sub_prefix, errors)
            entry_id = sub.get("entry_id")
            if not _is_nonempty_text(entry_id) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", str(entry_id)):
                errors.append(f"{sub_prefix}.entry_id: must be a stable lowercase id using a-z, 0-9, _ or -")
                continue
            name = sub.get("name")
            if not _is_nonempty_text(name):
                errors.append(f"{sub_prefix}.name: must be non-empty text")
                continue
            if str(entry_id) in subplatform_entries.setdefault(key, {}):
                errors.append(f"{sub_prefix}.entry_id: duplicate within bucket")
            subplatform_entries[key][str(entry_id)] = str(name)
            module_key = f"subplatform:{entry_id}"
            home_ids = _validate_module(sub.get("homepage"), module_name="homepage", prefix=f"{sub_prefix}.homepage", valid_group_ids=valid_group_ids, errors=errors)
            homepage = sub.get("homepage") if isinstance(sub.get("homepage"), dict) else {}
            if homepage.get("status") not in {"confirmed", "suspected"}:
                errors.append(f"{sub_prefix}.homepage.status: extra platform entry must be confirmed or suspected")
            if isinstance(homepage.get("urls"), list) and len(homepage["urls"]) != 1:
                errors.append(f"{sub_prefix}.homepage.urls: each Chapter 4 extra-platform module requires exactly one homepage URL")
            platform_module_links[(key, module_key)] = home_ids
            per_url = homepage.get("url_risk_group_ids")
            if isinstance(per_url, dict):
                for url, url_ids in per_url.items():
                    if isinstance(url_ids, list):
                        platform_module_url_links[(key, module_key, str(url))] = set(url_ids)
            subplatform_union.update(home_ids)
            sub_routes, refs, candidate_evaluations, seen_candidate_evaluations = _validate_completion(
                sub.get("research_completion"), prefix=f"{sub_prefix}.research_completion",
                platform_key=key, modules={module_key: homepage},
                subject_display_name=str(subject.get("display_name", "")),
                subject_aliases=set(subject_aliases),
                source_inventory=coverage_source_inventory,
                coverage_aliases=coverage_aliases, coverage_keyword_groups=keyword_groups,
                native_search_sentinel_groups=native_search_sentinel_groups,
                risk_terms_sha256=risk_terms_sha256,
                final_linear_pass_index=final_linear_pass_index,
                valid_group_ids=valid_group_ids,
                platform_has_confirmed_account=homepage.get("status") == "confirmed",
                platform_declared_risk=bool(home_ids),
                platform_user_risk_lead=False,
                delivered_account_urls=set(delivered_accounts.get((key, str(entry_id)), set())),
                check_files=check_files, errors=errors,
            )
            for route_index, route in enumerate(sub_routes):
                if isinstance(route, dict):
                    all_route_contexts.append({
                        "platform_key": key,
                        "platform_rank": PLATFORMS.index(key),
                        "work_unit_rank": sub_index + 1,
                        "prefix": f"{sub_prefix}.research_completion.route_results[{route_index}]",
                        "route": route,
                    })
            all_ledger_risk_refs.update(refs)
            _merge_candidate_evaluations(
                all_candidate_evaluations,
                candidate_evaluations,
                prefix=f"{sub_prefix}.research_completion",
                errors=errors,
            )
            _accumulate_candidate_evidence(
                all_pass_candidate_evaluations,
                seen_candidate_evaluations,
                prefix=f"{sub_prefix}.research_completion",
                errors=errors,
            )
            delivered = delivered_accounts.get((key, str(entry_id)), set())
            confirmed = confirmed_accounts.get((key, str(entry_id)), set())
            suspected = suspected_accounts.get((key, str(entry_id)), set())
            home_urls = set(homepage.get("urls", [])) if isinstance(homepage.get("urls"), list) else set()
            if delivered != home_urls:
                errors.append(f"{sub_prefix}.homepage.urls: must equal delivered accounts for this entry_id")
            expected_home_status = "confirmed" if confirmed else "suspected" if suspected else "not_found"
            if homepage.get("status") != expected_home_status:
                errors.append(f"{sub_prefix}.homepage.status: expected {expected_home_status} from account statuses")
            identity_statuses = homepage.get("url_identity_statuses")
            expected_identity_statuses = {
                url: delivered_account_statuses[(key, str(entry_id), url)]
                for url in home_urls
                if (key, str(entry_id), url) in delivered_account_statuses
            }
            if identity_statuses != expected_identity_statuses:
                errors.append(f"{sub_prefix}.homepage.url_identity_statuses: must match delivered account statuses")
            if delivered_account_names.get((key, str(entry_id)), set()) not in ({str(name)}, set()):
                errors.append(f"{sub_prefix}.name: must equal the account subplatform label for this entry_id")
        if key in OTHER_TAIL_STATEMENTS and record.get("other_platform_tail") != OTHER_TAIL_STATEMENTS[key]:
            errors.append(f"{prefix}.other_platform_tail: must match the exact Chapter 4 tail")
        if key in {"domestic_other", "overseas_other"}:
            expected_supplied_suspected = supplied_suspected_order_by_platform.get(key, [])
            expected_set = set(expected_supplied_suspected)
            actual_supplied_suspected: list[str] = []
            for sub in subplatforms:
                if not isinstance(sub, dict):
                    continue
                homepage = sub.get("homepage") if isinstance(sub.get("homepage"), dict) else {}
                identity_statuses = (
                    homepage.get("url_identity_statuses")
                    if isinstance(homepage.get("url_identity_statuses"), dict)
                    else {}
                )
                for url in homepage.get("urls", []) if isinstance(homepage.get("urls"), list) else []:
                    if url in expected_set and identity_statuses.get(url) == "suspected":
                        actual_supplied_suspected.append(url)
            if actual_supplied_suspected != expected_supplied_suspected:
                errors.append(
                    f"{prefix}.subplatforms: suspected homepage modules must preserve "
                    "user-supplied suspected-page order"
                )
        if set(record_ids) != module_union | subplatform_union:
            errors.append(f"{prefix}.risk_group_ids: must equal the union of module and subplatform risk links")
        platform_routes, refs, candidate_evaluations, seen_candidate_evaluations = _validate_completion(
            record.get("research_completion"), prefix=f"{prefix}.research_completion",
            platform_key=key, modules=validated_modules,
            subject_display_name=str(subject.get("display_name", "")),
            subject_aliases=set(subject_aliases),
            source_inventory=coverage_source_inventory,
            coverage_aliases=coverage_aliases, coverage_keyword_groups=keyword_groups,
            native_search_sentinel_groups=native_search_sentinel_groups,
            risk_terms_sha256=risk_terms_sha256,
            final_linear_pass_index=final_linear_pass_index,
            valid_group_ids=valid_group_ids,
            platform_has_confirmed_account=any(
                account_key == key and urls
                for (account_key, _entry_id), urls in confirmed_accounts.items()
            ),
            platform_declared_risk=bool(record_ids),
            platform_user_risk_lead=key in user_risk_lead_platforms,
            delivered_account_urls=(
                set() if key in {"domestic_other", "overseas_other"}
                else set(delivered_accounts.get((key, ""), set()))
            ),
            check_files=check_files, errors=errors,
        )
        for route_index, route in enumerate(platform_routes):
            if isinstance(route, dict):
                all_route_contexts.append({
                    "platform_key": key,
                    "platform_rank": PLATFORMS.index(key),
                    "work_unit_rank": 0,
                    "prefix": f"{prefix}.research_completion.route_results[{route_index}]",
                    "route": route,
                })
        all_ledger_risk_refs.update(refs)
        _merge_candidate_evaluations(
            all_candidate_evaluations,
            candidate_evaluations,
            prefix=f"{prefix}.research_completion",
            errors=errors,
        )
        _accumulate_candidate_evidence(
            all_pass_candidate_evaluations,
            seen_candidate_evaluations,
            prefix=f"{prefix}.research_completion",
            errors=errors,
        )
        if key == "x" and check_files:
            x_homepage = modules.get("homepage") if isinstance(modules, dict) else None
            x_urls = set(x_homepage.get("urls", [])) if isinstance(x_homepage, dict) and isinstance(x_homepage.get("urls"), list) else set()
            _validate_x_review_start_month(
                record.get("research_completion"), x_urls, modules.get("review_start_month"),
                prefix=f"{prefix}.research_completion", errors=errors,
            )
        delivered_named = delivered_accounts.get((key, ""), set())
        confirmed_named = confirmed_accounts.get((key, ""), set())
        suspected_named = suspected_accounts.get((key, ""), set())
        account_module_name = {"douban": "subject_homepage"}.get(key, "homepage")
        account_module = modules.get(account_module_name) if isinstance(modules, dict) else None
        expected_named_accounts = set(account_module.get("urls", [])) if isinstance(account_module, dict) and isinstance(account_module.get("urls"), list) else set()
        if key in {"domestic_other", "overseas_other"}:
            if delivered_named:
                errors.append(f"{prefix}: other-platform accounts must use an exact subplatform name")
            has_confirmed_account = any(account_key == key and urls for (account_key, _), urls in confirmed_accounts.items())
            has_suspected_account = any(account_key == key and urls for (account_key, _), urls in suspected_accounts.items())
        else:
            if delivered_named != expected_named_accounts:
                errors.append(
                    f"{prefix}.delivery_modules.{account_module_name}.urls: must equal confirmed and selected suspected platform accounts"
                )
            if isinstance(account_module, dict) and account_module_name in {"homepage", "subject_homepage"}:
                expected_module_status = (
                    "confirmed" if confirmed_named else "suspected" if suspected_named else "not_found"
                )
                if account_module.get("status") != expected_module_status:
                    errors.append(
                        f"{prefix}.delivery_modules.{account_module_name}.status: expected {expected_module_status} from account statuses"
                    )
                expected_identity_statuses = {
                    url: delivered_account_statuses[(key, "", url)]
                    for url in expected_named_accounts
                    if (key, "", url) in delivered_account_statuses
                }
                if account_module.get("url_identity_statuses") != expected_identity_statuses:
                    errors.append(
                        f"{prefix}.delivery_modules.{account_module_name}.url_identity_statuses: must match delivered account statuses"
                    )
                expected_supplied_suspected = supplied_suspected_order_by_platform.get(key, [])
                expected_set = set(expected_supplied_suspected)
                module_identity_statuses = account_module.get("url_identity_statuses")
                if not isinstance(module_identity_statuses, dict):
                    module_identity_statuses = {}
                actual_supplied_suspected = [
                    url
                    for url in account_module.get("urls", [])
                    if url in expected_set and module_identity_statuses.get(url) == "suspected"
                ]
                if actual_supplied_suspected != expected_supplied_suspected:
                    errors.append(
                        f"{prefix}.delivery_modules.{account_module_name}.urls: must preserve "
                        "user-supplied suspected-page order"
                    )
            has_suspected_account = bool(suspected_named)
            has_confirmed_account = bool(confirmed_named)
        related_page = False
        if key == "weibo":
            topic = modules.get("topic") if isinstance(modules, dict) else None
            related_page = isinstance(topic, dict) and topic.get("status") == "confirmed"
        elif key == "tieba":
            topic = modules.get("topic_homepage") if isinstance(modules, dict) else None
            related_page = isinstance(topic, dict) and topic.get("status") == "confirmed"
        search_has_related_content = any(
            isinstance(module, dict) and module.get("result_status") in {"risk", "no_risk"}
            for module_name, module in validated_modules.items()
            if module_name in SEARCH_MODULES
        )
        has_related_content = bool(record_ids or related_page or search_has_related_content)
        expected_discovery = (
            "confirmed_account" if has_confirmed_account
            else "suspected_account" if has_suspected_account
            else "related_content_only" if has_related_content
            else "no_account_after_multiroute_search"
        )
        if record.get("discovery_status") != expected_discovery:
            errors.append(
                f"{prefix}.discovery_status: expected {expected_discovery} from delivered account and search/topic state"
            )
    for key in PLATFORMS:
        if not any(
            context.get("platform_key") == key
            and isinstance(context.get("route"), dict)
            and context["route"].get("status") == "complete"
            and context["route"].get("tool_kind") in INTERACTIVE_BROWSER_TOOL_KINDS
            for context in all_route_contexts
        ):
            errors.append(
                f"platforms.{key}.research_completion.route_results: final exhaustive handoff requires "
                "at least one complete interactive browser UI route in this platform bucket; "
                "API/export may complete specific surfaces but cannot replace the mandatory browser visit"
            )
    _validate_supplied_canonicalizations(
        user_supplied_homepages,
        all_route_contexts,
        errors=errors,
    )
    _validate_final_candidate_evidence(
        all_pass_candidate_evaluations,
        all_candidate_evaluations,
        user_supplied_canonical_urls,
        errors=errors,
    )
    _validate_identity_selection(
        account_records_by_url=account_records_by_url,
        user_supplied_homepages=user_supplied_homepages,
        candidate_evaluations=all_candidate_evaluations,
        check_files=check_files,
        errors=errors,
    )
    _validate_parallel_execution(
        all_route_contexts,
        final_linear_pass_index=final_linear_pass_index,
        coverage_started_at=coverage_started_at,
        coverage_completed_at=coverage_completed_at,
        preflight_serial=preflight_serial,
        errors=errors,
    )
    for (key, entry_id), urls in delivered_accounts.items():
        if key not in {"domestic_other", "overseas_other"}:
            continue
        entry_name = subplatform_entries.get(key, {}).get(entry_id)
        account_prefix = f"accounts[delivered {key}:{entry_id or '<empty>'}]"
        if entry_name is None:
            errors.append(
                f"{account_prefix}: delivered extra-platform account has no matching platforms.{key}.subplatforms entry"
            )
            continue
        if delivered_account_names.get((key, entry_id), set()) != {entry_name}:
            errors.append(f"{account_prefix}: subplatform name must equal the matching entry name")
    for group_id, key, subplatform, module_targets, _source_url in instance_refs:
        if group_id not in platform_group_links.get(key, set()):
            errors.append(f"risk_groups.{group_id}: missing platform cross-link on {key}")
        for module_key, module_url in module_targets:
            if module_key.startswith("subplatform:"):
                entry_id = module_key.removeprefix("subplatform:")
                expected_name = subplatform_entries.get(key, {}).get(entry_id)
                if expected_name is None or subplatform != expected_name:
                    errors.append(f"risk_groups.{group_id}: unknown/mismatched subplatform module {module_key}")
            if group_id not in platform_module_links.get((key, module_key), set()):
                errors.append(f"risk_groups.{group_id}: missing module cross-link {key}.{module_key}")
            if group_id not in platform_module_url_links.get((key, module_key, module_url), set()):
                errors.append(
                    f"risk_groups.{group_id}: missing or mismatched URL cross-link "
                    f"{key}.{module_key} {module_url}"
                )
    for (key, module_key, module_url), ids in platform_module_url_links.items():
        for group_id in ids:
            if not any(
                ref_group == group_id and ref_key == key and (module_key, module_url) in ref_targets
                for ref_group, ref_key, _sub, ref_targets, _url in instance_refs
            ):
                errors.append(
                    f"platforms.{key}.{module_key}[{module_url}]: linked risk group has no matching instance"
                )
    if check_files:
        for key, module_key, module_url, group_id, url in sorted(expected_ledger_risks - all_ledger_risk_refs):
            errors.append(
                "item_ledgers: risk instance target is absent from its reviewed route ledger: "
                f"{key}.{module_key} {module_url} {group_id} {url}"
            )
    qa = payload.get("qa")
    if not isinstance(qa, dict):
        errors.append("qa: must be an object")
    else:
        _validate_exact_fields(qa, set(QA_FLAGS), "qa", errors)
        for flag in QA_FLAGS:
            if qa.get(flag) is not True:
                errors.append(f"qa.{flag}: must be true")
    return errors


def validate(payload: Any, *, check_files: bool = True) -> list[str]:
    """Dispatch schema 1.11 to targeted review and keep schema 1.10 exact.

    A missing ``research_profile`` on schema 1.10 intentionally means the
    legacy ``exhaustive_audit`` profile.  No compatibility shim fabricates a
    profile field or relaxes the old validator.
    """
    if isinstance(payload, dict) and (
        payload.get("schema_version") == TARGETED_SCHEMA_VERSION
        or payload.get("research_profile") == TARGETED_RESEARCH_PROFILE
    ):
        errors: list[str] = []
        try:
            for finding in _prose_audit(payload).get("findings", []):
                if finding.get("severity") == "error":
                    errors.append(
                        f"handoff_prose.{finding['path']}: {finding['rule']}: {finding['message']}"
                    )
        except (OSError, ImportError, ValueError, AttributeError, KeyError, TypeError) as exc:
            errors.append(f"handoff_prose: required prose audit unavailable or invalid: {exc}")
        errors.extend(validate_targeted_payload(payload, check_files=check_files))
        return errors
    return _validate_exhaustive_payload(payload, check_files=check_files)


def _self_test_payload(
    temp_path: Path,
    *,
    api_homepages: bool = False,
    api_only: bool = False,
    browser_ui: bool = True,
    adaptive_no_risk: bool = False,
    google_adaptive: bool = False,
    video_ranking_mode: str = "observed",
    video_fixture_count: int = 11,
) -> dict[str, Any]:
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
    screenshot = temp_path / "risk.png"
    screenshot.write_bytes(png)
    standard = temp_path / "risk-standard.md"
    standard.write_text("完整风险标准\n", encoding="utf-8")
    aliases = ["测试对象", "fixturevalid", "@fixturevalid"]
    keyword_groups = ["政治／主权", "内容调性", "历史争议", "商业诚信", "违法违规"]
    terms = aliases + keyword_groups
    terms_path = temp_path / "risk-terms.txt"
    terms_path.write_text("\n".join(terms) + "\n", encoding="utf-8")
    edge_window_continuity_id = "00000000-0000-4000-8000-000000000001"
    edge_page_continuity_id = "00000000-0000-4000-8000-000000000002"
    browser_tool_kind = "browser_ui" if browser_ui else "microsoft_edge_visible"
    browser_family = "fixture_interactive_browser" if browser_ui else "microsoft_edge"
    browser_tool_name = "Fixture Interactive Browser" if browser_ui else "Microsoft Edge"
    browser_capture_scope = BROWSER_CAPTURE_SCOPE if browser_ui else EDGE_CAPTURE_SCOPE
    browser_authorization_status = (
        "not_required_browser_ui" if browser_ui else "not_required_edge_visible"
    )
    browser_evidence: dict[str, Path] = {}
    preflight_intervals = {
        "domestic": (
            "2026-09-02T08:55:00+08:00",
            "2026-09-02T08:55:20+08:00",
            "2026-09-02T08:55:30+08:00",
            1,
        ),
        "overseas": (
            "2026-09-02T08:55:30+08:00",
            "2026-09-02T08:55:50+08:00",
            "2026-09-02T08:56:00+08:00",
            2,
        ),
    }
    for family, url, label in (
        ("domestic", "https://www.baidu.com/", "baidu"),
        ("overseas", "https://www.google.com/", "google"),
    ):
        preflight_started, preflight_captured, preflight_completed, preflight_index = (
            preflight_intervals[family]
        )
        artifact = temp_path / f"{family}-browser-screenshot.png"
        artifact.write_bytes(png)
        manifest = temp_path / f"{family}-browser-evidence.json"
        manifest.write_text(json.dumps({
            "schema_version": BROWSER_REACHABILITY_SCHEMA_VERSION,
            "url": url, "browser_family": browser_family, "window_mode": "visible",
            "edge_window_continuity_id": edge_window_continuity_id,
            "edge_page_continuity_id": edge_page_continuity_id,
            "max_task_open_edge_pages": 1,
            "capture_scope": browser_capture_scope,
            "preflight_serial_index": preflight_index,
            "started_at": preflight_started,
            "captured_at": preflight_captured,
            "completed_at": preflight_completed,
            "artifact_path": str(artifact), "artifact_sha256": _sha256(artifact),
            "artifact_kind": "browser_screenshot",
        }) + "\n", encoding="utf-8")
        browser_evidence[family] = manifest
    authorization_file = temp_path / "official-api-authorization.txt"
    authorization_file.write_text("self-test official API authorization evidence\n", encoding="utf-8")
    preflight_log = temp_path / "network-preflight.json"
    preflight_summary = {
        "status": "complete", "checked_at": "2026-09-02T08:55:00+08:00",
        "proxy_configured": True, "proxy_reachable": False, "direct_https_reachable": True,
        "browser_session_reachable": True, "domestic_route_reachable": True,
        "overseas_route_reachable": True,
        "tested_hosts": ["www.baidu.com", "www.google.com", "www.youtube.com"],
    }
    preflight_log.write_text(json.dumps({
        "schema_version": NETWORK_PREFLIGHT_SCHEMA_VERSION, **preflight_summary,
        "checks": [
            {
                "family": "domestic", "route": "direct_https", "url": "https://www.baidu.com/",
                "host": "www.baidu.com", "reachable": True, "http_status": 200, "error": "",
                "browser_family": None, "window_mode": None, "evidence_path": None,
                "evidence_sha256": None, "evidence_kind": None,
                "edge_window_continuity_id": None, "edge_page_continuity_id": None,
                "max_task_open_edge_pages": None, "capture_scope": None,
                "preflight_serial_index": None, "started_at": None,
                "captured_at": None, "completed_at": None,
            },
            {
                "family": "domestic", "route": "browser_session", "url": "https://www.baidu.com/",
                "host": "www.baidu.com", "reachable": True, "http_status": None, "error": "",
                "browser_family": browser_family, "window_mode": "visible",
                "evidence_path": str(browser_evidence["domestic"]),
                "evidence_sha256": _sha256(browser_evidence["domestic"]),
                "evidence_kind": "browser_evidence_manifest",
                "edge_window_continuity_id": edge_window_continuity_id,
                "edge_page_continuity_id": edge_page_continuity_id,
                "max_task_open_edge_pages": 1, "capture_scope": browser_capture_scope,
                "preflight_serial_index": 1,
                "started_at": preflight_intervals["domestic"][0],
                "captured_at": preflight_intervals["domestic"][1],
                "completed_at": preflight_intervals["domestic"][2],
            },
            {
                "family": "overseas", "route": "browser_session", "url": "https://www.google.com/",
                "host": "www.google.com", "reachable": True, "http_status": None, "error": "",
                "browser_family": browser_family, "window_mode": "visible",
                "evidence_path": str(browser_evidence["overseas"]),
                "evidence_sha256": _sha256(browser_evidence["overseas"]),
                "evidence_kind": "browser_evidence_manifest",
                "edge_window_continuity_id": edge_window_continuity_id,
                "edge_page_continuity_id": edge_page_continuity_id,
                "max_task_open_edge_pages": 1, "capture_scope": browser_capture_scope,
                "preflight_serial_index": 2,
                "started_at": preflight_intervals["overseas"][0],
                "captured_at": preflight_intervals["overseas"][1],
                "completed_at": preflight_intervals["overseas"][2],
            },
        ],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    terms_hash = _sha256(terms_path)
    route_serial = 0
    search_urls = {
        "weibo": "https://s.weibo.com/weibo?q=fixturevalid",
        "bilibili": "https://search.bilibili.com/all?keyword=fixturevalid",
        "douyin": "https://www.douyin.com/search/fixturevalid",
        "xiaohongshu": "https://www.xiaohongshu.com/search_result?keyword=fixturevalid",
        "zhihu": "https://www.zhihu.com/search?q=fixturevalid",
        "netease_music": "https://music.163.com/#/search/m/?s=fixturevalid",
        "tieba": "https://tieba.baidu.com/f/search/res?ie=utf-8&qw=fixturevalid",
        "douban": "https://www.douban.com/search?q=fixturevalid",
        "domestic_other": "https://www.baidu.com/s?wd=fixturevalid",
        "x": "https://x.com/search?q=fixturevalid&src=typed_query",
        "facebook": "https://www.facebook.com/search/top?q=fixturevalid",
        "instagram": "https://www.instagram.com/explore/search/keyword/?q=fixturevalid",
        "youtube": "https://www.youtube.com/results?search_query=fixturevalid",
        "overseas_other": "https://www.google.com/search?q=fixturevalid",
    }

    def fixture_query_url(platform_key: str, query_text: str) -> str:
        encoded = quote(query_text, safe="")
        return {
            "weibo": f"https://s.weibo.com/weibo?q={encoded}",
            "bilibili": f"https://search.bilibili.com/all?keyword={encoded}",
            "douyin": f"https://www.douyin.com/search/{encoded}",
            "xiaohongshu": f"https://www.xiaohongshu.com/search_result?keyword={encoded}",
            "zhihu": f"https://www.zhihu.com/search?q={encoded}",
            "netease_music": f"https://music.163.com/#/search/m/?s={encoded}",
            "tieba": f"https://tieba.baidu.com/f/search/res?ie=utf-8&qw={encoded}",
            "douban": f"https://www.douban.com/search?q={encoded}",
            "domestic_other": f"https://www.baidu.com/s?wd={encoded}",
            "x": f"https://x.com/search?q={encoded}&src=typed_query",
            "facebook": f"https://www.facebook.com/search/top?q={encoded}",
            "instagram": f"https://www.instagram.com/explore/search/keyword/?q={encoded}",
            "youtube": f"https://www.youtube.com/results?search_query={encoded}",
            "overseas_other": f"https://www.google.com/search?q={encoded}",
        }[platform_key]
    native_discovery_urls = {
        "weibo": search_urls["weibo"],
        "bilibili": search_urls["bilibili"],
        "douyin": search_urls["douyin"],
        "xiaohongshu": search_urls["xiaohongshu"],
        "zhihu": search_urls["zhihu"],
        "netease_music": search_urls["netease_music"],
        "tieba": search_urls["tieba"],
        "douban": search_urls["douban"],
        "x": search_urls["x"],
        "facebook": search_urls["facebook"],
        "instagram": search_urls["instagram"],
        "youtube": search_urls["youtube"],
    }
    risk_url = "https://www.youtube.com/watch?v=fixturevalid123"
    youtube_canonical_url = "https://www.youtube.com/@fixturevalid"
    facebook_canonical_url = "https://www.facebook.com/fixturevalid"
    youtube_supplied_input_url = (
        youtube_canonical_url if api_only else "https://youtu.be/fixturevalid123"
    )

    def route(
        key: str,
        module_key: str,
        url: str,
        route_kind: str,
        *,
        surface: str,
        item: bool = False,
        pass_index: int = 1,
        resolved_url: str | None = None,
        query_groups: list[str] | None = None,
    ) -> dict[str, Any]:
        nonlocal route_serial
        route_serial += 1
        final_visible_url = resolved_url or url
        stem = f"{key}-{route_serial}"
        started_dt = datetime.fromisoformat("2026-09-02T09:00:00+08:00") + timedelta(
            minutes=(route_serial - 1) * 2
        )
        completed_dt = started_dt + timedelta(minutes=1)
        started_at = started_dt.isoformat()
        completed_at = completed_dt.isoformat()
        log_path = temp_path / f"{stem}-status.json"
        raw_path = temp_path / f"{stem}-raw.json"
        ledger_path = temp_path / f"{stem}-items.jsonl"
        query_ledger_path = temp_path / f"{stem}-queries.jsonl"
        rows: list[dict[str, Any]] = []
        if item:
            if video_ranking_mode not in {
                "observed", "native", "unranked", "observed_tie", "observed_tie_native",
                "observed_tie_url",
            }:
                raise ValueError(f"unsupported self-test video ranking mode: {video_ranking_mode}")

            def full_video_evidence(
                video_url: str,
                item_token: str,
                *,
                risk_item: bool,
            ) -> dict[str, Any]:
                sample_timestamps = [0, 10, 15, 20, 30, 40, 50, 60] if risk_item else [0, 10]
                duration = 60 if risk_item else 10
                keyframes = [15, 30] if risk_item else []
                frame_paths: dict[int, Path] = {}
                frame_rows: list[dict[str, Any]] = []
                for timestamp in sample_timestamps:
                    frame_path = temp_path / f"{stem}-{item_token}-frame-{timestamp:04d}.png"
                    frame_path.write_bytes(png)
                    frame_paths[timestamp] = frame_path
                    capture_kinds = ["interval_sample"]
                    if risk_item and timestamp == 15:
                        capture_kinds = ["keyframe"]
                    elif risk_item and timestamp == 30:
                        capture_kinds = ["scene_change"]
                    frame_rows.append({
                        "source_video_url": video_url,
                        "timestamp_seconds": timestamp,
                        "frame_path": str(frame_path),
                        "frame_sha256": _sha256(frame_path),
                        "capture_kinds": capture_kinds,
                    })
                frame_manifest_path = temp_path / f"{stem}-{item_token}-frame-manifest.jsonl"
                frame_manifest_path.write_text(
                    "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in frame_rows),
                    encoding="utf-8",
                )
                audio_text_path = temp_path / f"{stem}-{item_token}-full-audio.jsonl"
                audio_rows = ([
                    {
                        "source_video_url": video_url, "start_seconds": 0, "end_seconds": 20,
                        "text": "完整音轨自测转写第一段。", "segment_kind": "speech",
                    },
                    {
                        "source_video_url": video_url, "start_seconds": 20, "end_seconds": 40,
                        "text": "00:30 出现一项需要评估的内容。", "segment_kind": "speech",
                    },
                    {
                        "source_video_url": video_url, "start_seconds": 40, "end_seconds": 60,
                        "text": "", "segment_kind": "silence",
                    },
                ] if risk_item else [{
                    "source_video_url": video_url, "start_seconds": 0, "end_seconds": 10,
                    "text": "", "segment_kind": "silence",
                }])
                audio_text_path.write_text(
                    "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in audio_rows),
                    encoding="utf-8",
                )
                hits = ([{
                    "source_video_url": video_url,
                    "timestamp_seconds": 30,
                    "context_start_seconds": 10,
                    "context_end_seconds": 50,
                    "evidence_kind": "frame",
                    "evidence_path": str(frame_paths[30]),
                    "evidence_sha256": _sha256(frame_paths[30]),
                    "original_or_transcript": "00:30 出现一项需要评估的内容。",
                    "context": "已回看命中点前后各15秒，语境与风险判定一致。",
                    "conclusion": "保留为测试风险。",
                }] if risk_item else [])
                return {
                    "duration_seconds": duration,
                    "timeline_start_seconds": 0,
                    "timeline_end_seconds": duration,
                    "sampling_method": VIDEO_SAMPLING_METHOD,
                    "max_sampling_interval_seconds": 10,
                    "sampled_frame_timestamps_seconds": sample_timestamps,
                    "keyframe_scene_change_timestamps_seconds": keyframes,
                    "keyframe_scene_change_reviewed": True,
                    "frame_manifest_path": str(frame_manifest_path),
                    "frame_manifest_sha256": _sha256(frame_manifest_path),
                    "full_audio_coverage": True,
                    "audio_scan_method": "combined_full",
                    "audio_text_path": str(audio_text_path),
                    "audio_text_sha256": _sha256(audio_text_path),
                    "audio_risk_terms_sha256": terms_hash,
                    "ocr_visual_sensitive_elements_reviewed": True,
                    "hits": hits,
                }

            is_risk_account = key == "youtube" and not adaptive_no_risk
            video_count = 1 if is_risk_account else video_fixture_count

            def fixture_video_url(video_index: int) -> str:
                return (
                    risk_url
                    if is_risk_account
                    else f"https://www.facebook.com/fixturevalid/videos/{1000 + video_index}"
                )

            ranking_snapshot_path: Path | None = None
            ranking_snapshot_sha: str | None = None
            if not is_risk_account and video_ranking_mode in {"native", "observed_tie_native"}:
                native_order = list(range(1, video_count + 1))
                if video_ranking_mode == "observed_tie_native" and video_count >= 11:
                    native_order[9], native_order[10] = native_order[10], native_order[9]
                snapshot_observed_at = (started_dt + timedelta(seconds=30)).isoformat()
                ranking_snapshot_path = temp_path / f"{stem}-account-native-ranking.json"
                ranking_snapshot_path.write_text(json.dumps({
                    "source_account_url": url,
                    "source_surface": NATIVE_RANK_SOURCE_SURFACE,
                    "sort_mode": "popular",
                    "ranking_scope": NATIVE_RANK_SCOPE,
                    "observed_at": snapshot_observed_at,
                    "ordered_video_urls": [fixture_video_url(index) for index in native_order],
                }, ensure_ascii=False) + "\n", encoding="utf-8")
                ranking_snapshot_sha = _sha256(ranking_snapshot_path)
            for video_index in range(1, video_count + 1):
                video_url = fixture_video_url(video_index)
                item_id = "fixture-video-1" if is_risk_account else f"fixture-clear-video-{video_index:02d}"
                risk_item = is_risk_account and video_index == 1
                observed_at = (started_dt + timedelta(seconds=30)).isoformat()
                rank_evidence: dict[str, Any] | None = None
                if is_risk_account or video_ranking_mode in {
                    "observed", "observed_tie", "observed_tie_native", "observed_tie_url",
                }:
                    play_status = "observed"
                    play_count: int | None = 2000 if is_risk_account else 1200 - video_index
                    if not is_risk_account and video_ranking_mode in {
                        "observed_tie", "observed_tie_native", "observed_tie_url",
                    } and video_index in {10, 11}:
                        play_count = 1190
                    play_text = f"{play_count} views"
                    if video_ranking_mode == "observed_tie_native" and video_index in {10, 11}:
                        native_rank = 11 if video_index == 10 else 10
                        rank_path = temp_path / f"{stem}-{item_id}-native-rank.json"
                        rank_path.write_text(json.dumps({
                            "source_account_url": url,
                            "source_video_url": video_url,
                            "source_surface": NATIVE_RANK_SOURCE_SURFACE,
                            "sort_mode": "popular",
                            "ranking_scope": NATIVE_RANK_SCOPE,
                            "native_rank": native_rank,
                            "visible_order_text": f"同播放量原生排序第{native_rank}名",
                            "observed_at": observed_at,
                            "ranking_snapshot_path": str(ranking_snapshot_path),
                            "ranking_snapshot_sha256": ranking_snapshot_sha,
                        }, ensure_ascii=False) + "\n", encoding="utf-8")
                        rank_evidence = {"path": str(rank_path), "sha256": _sha256(rank_path)}
                elif video_ranking_mode == "native":
                    play_status = "native_top_rank"
                    play_count = None
                    play_text = f"热门排序第{video_index}名"
                    rank_path = temp_path / f"{stem}-{item_id}-native-rank.json"
                    rank_path.write_text(json.dumps({
                        "source_account_url": url,
                        "source_video_url": video_url,
                        "source_surface": NATIVE_RANK_SOURCE_SURFACE,
                        "sort_mode": "popular",
                        "ranking_scope": NATIVE_RANK_SCOPE,
                        "native_rank": video_index,
                        "visible_order_text": play_text,
                        "observed_at": observed_at,
                        "ranking_snapshot_path": str(ranking_snapshot_path),
                        "ranking_snapshot_sha256": ranking_snapshot_sha,
                    }, ensure_ascii=False) + "\n", encoding="utf-8")
                    rank_evidence = {"path": str(rank_path), "sha256": _sha256(rank_path)}
                else:
                    play_status = "not_public"
                    play_count = None
                    play_text = "平台未公开可比较播放量，且无账号级原生热门排序。"
                cover_path = temp_path / f"{stem}-{item_id}-cover.png"
                cover_path.write_bytes(png)
                row: dict[str, Any] = {
                    "platform_key": key, "surface": surface, "query_or_account_urls": [url],
                    "item_id": item_id, "url": video_url, "item_kind": "content", "content_type": "video",
                    "author": "测试对象", "published_at": (
                        "2026-01-02"
                        if video_ranking_mode == "observed_tie_url" and video_index in {10, 11}
                        else f"2026-01-{12 - video_index:02d}"
                    ),
                    "title": "测试风险视频" if risk_item else f"测试普通视频{video_index}",
                    "text": "出现一项需要评估的内容。" if risk_item else "完整简介仅介绍测试视频内容。",
                    "media_kinds": ["video"],
                    "video_metadata": {
                        "detail_url": video_url,
                        "detail_capture_kind": VIDEO_DETAIL_CAPTURE_KIND,
                        "title_state": "present",
                        "cover_state": "present",
                        "cover_path": str(cover_path),
                        "cover_sha256": _sha256(cover_path),
                        "description_state": "complete_expanded",
                        "play_count_status": play_status,
                        "play_count": play_count,
                        "play_count_source_text": play_text,
                        "observed_at": observed_at,
                        "native_rank_evidence": rank_evidence,
                    },
                    "media_review_status": "complete",
                    "subject_interaction_review_status": "complete", "review_status": "reviewed",
                    "risk_decision": "risk" if risk_item else "no_risk",
                    "risk_group_id": "risk-001" if risk_item else "",
                }
                requires_top10_full = is_risk_account or (
                    video_ranking_mode in {"observed", "native", "observed_tie", "observed_tie_url"}
                    and video_index <= min(ACCOUNT_VIDEO_TOP_LIMIT, video_count)
                ) or (
                    video_ranking_mode == "observed_tie_native"
                    and (video_index <= 9 or video_index == 11)
                )
                if requires_top10_full:
                    row["video_review_evidence"] = full_video_evidence(
                        video_url, item_id, risk_item=risk_item,
                    )
                rows.append(row)
        ledger_path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        is_search = module_key in SEARCH_MODULES
        route_keyword_groups = keyword_groups if query_groups is None else query_groups
        query_rows: list[dict[str, Any]] = []
        if is_search:
            query_serial = 0
            for alias in aliases:
                for group in ["", *route_keyword_groups]:
                    query_serial += 1
                    query_text = alias if not group else f"{alias} {group}"
                    query_url = fixture_query_url(key, query_text)
                    query_rows.append({
                        "query_id": f"{stem}-query-{query_serial}", "alias": alias,
                        "keyword_group": group, "query_text": query_text,
                        "query_url": query_url,
                        "termination": "empty_result_after_full_query",
                        "discovered_items": 0, "reviewed_items": 0, "unreviewed_items": 0,
                    })
            query_ledger_path.write_text(
                "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in query_rows),
                encoding="utf-8",
            )
        query_path_value = str(query_ledger_path) if is_search else None
        query_sha = _sha256(query_ledger_path) if is_search else None
        termination = "natural_end" if rows else "empty_result_after_full_query"
        raw_path.write_text(json.dumps({
            "route_id": stem, "status": "complete", "termination": termination, "exit_code": 0,
            "terminal_evidence": "fixture natural endpoint",
            "scope": {"platform_key": key, "surface": surface, "url": final_visible_url},
            "has_more": False, "items": rows,
        }, ensure_ascii=False) + "\n", encoding="utf-8")
        raw_sha = _sha256(raw_path)
        # Synthetic self-test evidence only. Never infer these attestations for
        # historical or production ledgers during validation or migration.
        for item_index, row in enumerate(rows):
            detail_ref = {
                "path": str(raw_path), "sha256": raw_sha,
                "locator": f"json:/items/{item_index}",
            }
            row["review_evidence"] = {
                "content_sha256": content_sha256(row), "decision": row["risk_decision"],
                "context_reason": (
                    "Synthetic fixture: the cited item explicitly contains the test concern."
                    if row["risk_decision"] == "risk"
                    else "Synthetic fixture: title, cover and full description contain no test concern."
                ),
                "reviewer": "self-test fixture", "review_mode": "agent_context",
                "reviewed_at": completed_at,
                "evidence_refs": [detail_ref],
                "video_triage": {
                    "title_reviewed": True,
                    "cover_reviewed": True,
                    "description_reviewed": True,
                    "result": "risk_signal" if row["risk_decision"] == "risk" else "clear",
                    "reason": (
                        "标题、封面及完整简介中存在测试风险线索。"
                        if row["risk_decision"] == "risk"
                        else "标题、封面及完整简介仅为普通测试内容。"
                    ),
                    "risk_terms_sha256": terms_hash,
                    "detail_source_ref": detail_ref,
                },
            }
        ledger_path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        is_official = api_only or route_kind == "official_api"
        tool_kind = "official_api" if is_official else browser_tool_kind
        route_family = "official_api" if is_official else (
            ("browser_ui_index_discovery" if browser_ui else "microsoft_edge_index_discovery")
            if route_kind == "independent_index"
            else ("browser_ui_surface" if browser_ui else "microsoft_edge_visible_surface")
        )
        official_product = "Fixture Official API" if is_official else ""
        official_endpoint = f"https://api.{urlparse(url).hostname}/v1/{surface}" if is_official else ""
        if api_only:
            # Distinct fixture products provide independent provenance; merely
            # re-labelling duplicate upstream evidence must continue to fail.
            official_product += f" ({route_kind})"
            official_endpoint += f"/{route_kind}"
        auth_status = "public_official_api" if is_official else browser_authorization_status
        auth_evidence = ({
            "kind": "official_api_terms", "source_url": official_endpoint,
            "path": str(authorization_file), "sha256": _sha256(authorization_file),
            "verified_at": "2026-09-02T08:50:00+08:00",
        } if is_official else None)
        evidence_origin = official_endpoint if is_official else url
        edge_state = None if is_official else "public_visible"
        edge_continuity_id = None if is_official else edge_window_continuity_id
        edge_page_id = None if is_official else edge_page_continuity_id
        max_open_edge_pages = None if is_official else 1
        login_completed_at = None
        edge_evidence_path: str | None = None
        edge_evidence_sha: str | None = None
        if not is_official:
            edge_artifact = temp_path / f"{stem}-edge-screenshot.png"
            edge_artifact.write_bytes(png)
            edge_manifest = temp_path / f"{stem}-edge-evidence.json"
            edge_manifest.write_text(json.dumps({
                "schema_version": EDGE_ROUTE_EVIDENCE_SCHEMA_VERSION, "route_id": stem,
                "account_or_query_url": url, "final_visible_url": final_visible_url,
                "browser_family": browser_family,
                "window_mode": "visible", "edge_session_state": edge_state,
                "edge_window_continuity_id": edge_continuity_id,
                "edge_page_continuity_id": edge_page_id,
                "max_task_open_edge_pages": max_open_edge_pages,
                "serial_route_index": route_serial,
                "linear_pass_index": pass_index,
                "capture_scope": browser_capture_scope,
                "user_login_completed_at": None, "review_start_mode": "surface_start",
                "review_started_at": (started_dt + timedelta(seconds=10)).isoformat(),
                "captured_at": (started_dt + timedelta(seconds=50)).isoformat(),
                "artifact_path": str(edge_artifact), "artifact_sha256": _sha256(edge_artifact),
                "artifact_kind": "browser_screenshot",
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            edge_evidence_path = str(edge_manifest)
            edge_evidence_sha = _sha256(edge_manifest)
        fingerprint_parts = [raw_sha] + ([edge_evidence_sha] if edge_evidence_sha else [])
        evidence_fingerprint = _fingerprint_hashes(fingerprint_parts)
        tool_name = "fixture-official-api" if is_official else browser_tool_name
        permission_basis = "公开官方 API 及其授权凭据。" if is_official else "可见交互式浏览器 UI 只读浏览。"
        route_record = {
            "route_id": stem, "module_key": module_key, "surface": surface,
            "route_family": route_family, "evidence_origin": evidence_origin,
            "evidence_fingerprint": evidence_fingerprint, "account_or_query_url": url,
            "resolved_url": final_visible_url,
            "serial_route_index": route_serial, "linear_pass_index": pass_index,
            "tool_name": tool_name, "tool_version": "self-test",
            "tool_kind": tool_kind, "tool_path": None,
            "tool_sha256": None, "status": "complete", "termination": termination,
            "permission_basis": permission_basis,
            "official_product": official_product, "official_endpoint": official_endpoint,
            "authorization_status": auth_status, "authorization_evidence": auth_evidence,
            "edge_session_state": edge_state, "edge_window_continuity_id": edge_continuity_id,
            "edge_page_continuity_id": edge_page_id,
            "max_task_open_edge_pages": max_open_edge_pages,
            "user_login_completed_at": login_completed_at,
            "edge_evidence_path": edge_evidence_path, "edge_evidence_sha256": edge_evidence_sha,
            "discovered_items": len(rows), "reviewed_items": len(rows), "unreviewed_items": 0,
            "result_log_path": str(log_path), "item_ledger_path": str(ledger_path),
            "item_ledger_sha256": _sha256(ledger_path),
            "query_ledger_path": query_path_value, "query_ledger_sha256": query_sha,
            "aliases_covered": aliases if is_search else [],
            "keyword_groups_covered": route_keyword_groups if is_search else [],
            "resolved_by_route_ids": [],
            "risk_terms_sha256": terms_hash, "started_at": started_at,
            "completed_at": completed_at, "boundary": "",
        }
        log_path.write_text(json.dumps({
            "schema_version": ROUTE_EVIDENCE_SCHEMA_VERSION, "route_id": stem,
            "module_key": module_key, "surface": surface, "account_or_query_url": url,
            "resolved_url": final_visible_url,
            "route_family": route_family, "evidence_origin": evidence_origin,
            "evidence_fingerprint": evidence_fingerprint,
            "serial_route_index": route_serial, "linear_pass_index": pass_index,
            "tool_kind": tool_kind, "tool_sha256": None,
            "permission_basis": permission_basis,
            "official_product": official_product, "official_endpoint": official_endpoint,
            "authorization_status": auth_status, "authorization_evidence": auth_evidence,
            "edge_session_state": edge_state, "edge_window_continuity_id": edge_continuity_id,
            "edge_page_continuity_id": edge_page_id,
            "max_task_open_edge_pages": max_open_edge_pages,
            "user_login_completed_at": login_completed_at,
            "edge_evidence_path": edge_evidence_path, "edge_evidence_sha256": edge_evidence_sha,
            "status": "complete", "termination": termination,
            "discovered_items": len(rows), "reviewed_items": len(rows), "unreviewed_items": 0,
            "item_ledger_sha256": _sha256(ledger_path),
            "query_ledger_sha256": query_sha, "resolved_by_route_ids": [],
            "started_at": started_at, "completed_at": completed_at,
            "completion_evidence": {
                "kind": "content_end" if rows else "empty_query" if is_search or surface == "account_discovery" else "empty_surface",
                "platform_key": key, "surface": surface, "url": final_visible_url,
                "discovered_items": len(rows), "observed_at": completed_at,
                "source_ref": {"path": str(raw_path), "sha256": raw_sha, "locator": "json:/has_more"},
                "scope_locator": "/scope", "signal": "has_more_false", "marker": None,
            },
            "raw_evidence": [{
                "path": str(raw_path), "sha256": raw_sha, "kind": "api_response",
            }],
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return route_record

    def modules_for(key: str) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for module_name in DELIVERY_MODULES[key]:
            if module_name == "review_start_month":
                result[module_name] = None
            elif module_name in HOMEPAGE_MODULES:
                if key == "youtube" and module_name == "homepage" and not adaptive_no_risk:
                    result[module_name] = {
                        "status": "confirmed", "urls": [youtube_canonical_url],
                        "url_identity_statuses": {youtube_canonical_url: "confirmed"},
                        "url_risk_group_ids": {youtube_canonical_url: ["risk-001"]},
                        "risk_group_ids": ["risk-001"],
                    }
                elif key == "facebook" and module_name == "homepage" and adaptive_no_risk:
                    result[module_name] = {
                        "status": "confirmed", "urls": [facebook_canonical_url],
                        "url_identity_statuses": {facebook_canonical_url: "confirmed"},
                        "url_risk_group_ids": {facebook_canonical_url: []},
                        "risk_group_ids": [],
                    }
                else:
                    result[module_name] = {
                        "status": "not_found", "urls": [], "url_risk_group_ids": {},
                        "risk_group_ids": [],
                    }
                    if module_name in {"homepage", "subject_homepage"}:
                        result[module_name]["url_identity_statuses"] = {}
            else:
                result[module_name] = {"url": search_urls[key], "result_status": "no_related_content", "risk_group_ids": []}
        return result

    platforms: dict[str, Any] = {}
    youtube_canonicalization_route: dict[str, Any] | None = None
    for key in PLATFORMS:
        modules = modules_for(key)
        routes: list[dict[str, Any]] = []
        if key == "weibo":
            routes.append(route(
                key,
                "homepage",
                native_discovery_urls[key],
                "manual",
                surface="account_discovery",
                pass_index=0,
            ))
            # Create every discovery-prepass route before the first positive-pass
            # route, even though this one is stored under the later YouTube bucket.
            if not adaptive_no_risk:
                youtube_canonicalization_route = route(
                    "youtube",
                    "homepage",
                    youtube_supplied_input_url,
                    "manual",
                    surface="account_discovery",
                    pass_index=0,
                    resolved_url=youtube_canonical_url,
                )
        if key == "youtube" and not adaptive_no_risk:
            assert youtube_canonicalization_route is not None
            routes.append(youtube_canonicalization_route)
        for module_name, module in modules.items():
            if module_name == "review_start_month":
                continue
            if module_name in SEARCH_MODULES:
                route_query_groups = (
                    keyword_groups[:4]
                    if (adaptive_no_risk and key == "facebook")
                    or (google_adaptive and key == "overseas_other")
                    else keyword_groups
                )
                for surface in _required_surfaces(key, module_name, module):
                    routes.append(route(
                        key, module_name, module["url"], "manual", surface=surface,
                        query_groups=route_query_groups,
                    ))
                    routes.append(route(
                        key, module_name, module["url"], "official_api",
                        surface=surface, query_groups=route_query_groups,
                    ))
            elif module["status"] in {"confirmed", "suspected"}:
                for surface_index, surface in enumerate(_required_surfaces(key, module_name, module)):
                    is_fixture_account = (
                        (key == "youtube" and not adaptive_no_risk)
                        or (key == "facebook" and adaptive_no_risk)
                    )
                    # The Facebook positive fixture intentionally observes the
                    # same stable videos once on `posts` and once on `videos`.
                    # This exercises account-wide de-duplication across
                    # distinct completed surfaces without multiplying rows.
                    include_video_fixture = is_fixture_account and (
                        surface_index == 0 or (
                            adaptive_no_risk and key == "facebook" and surface == "videos"
                        )
                    )
                    routes.append(route(
                        key, module_name, module["urls"][0], "official_api" if api_homepages else "manual",
                        surface=surface, item=include_video_fixture and surface_index == 0,
                    ))
                    if adaptive_no_risk and key == "facebook":
                        routes.append(route(
                            key, module_name, module["urls"][0], "official_api", surface=surface,
                            item=include_video_fixture and surface == "videos",
                        ))
            else:
                routes.append(route(
                    key, module_name, native_discovery_urls[key], "manual", surface="account_discovery",
                ))
                routes.append(route(key, module_name, f"https://www.google.com/search?q=site-search-{key}-{module_name}", "independent_index", surface="account_discovery"))
        has_home = any(name in HOMEPAGE_MODULES for name in modules)
        has_search = any(name in SEARCH_MODULES for name in modules)
        platform_risks = ["risk-001"] if key == "youtube" and not adaptive_no_risk else []
        platform_confirmed = (
            (key == "youtube" and not adaptive_no_risk)
            or (key == "facebook" and adaptive_no_risk)
        )
        record: dict[str, Any] = {
            "display_name": PLATFORM_DISPLAY[key],
            "discovery_status": "confirmed_account" if platform_confirmed else "no_account_after_multiroute_search",
            "risk_group_ids": platform_risks, "subplatforms": [],
            "delivery_modules": modules,
            "research_completion": {
                "status": "complete",
                "homepage_review": "exhausted" if platform_confirmed else ("not_found_after_multiroute" if has_home else "not_applicable"),
                "native_search_review": "exhausted" if has_search else "not_applicable",
                "route_results": routes, "unreviewed_relevant_hits": 0,
                "completion_note": "所有必需表面均逐条复核到自然终点。",
            },
        }
        if key in OTHER_TAIL_STATEMENTS:
            record["other_platform_tail"] = OTHER_TAIL_STATEMENTS[key]
        platforms[key] = record
    if adaptive_no_risk:
        subject_basic_source_url = facebook_canonical_url
        supplied_homepages = [{
            "platform_key": "facebook", "subplatform": "",
            "input_url": facebook_canonical_url,
            "canonical_url": facebook_canonical_url,
            "canonicalization_route_id": "",
        }]
        accounts = [{
            "platform_key": "facebook", "subplatform": "", "subplatform_entry_id": "",
            "url": facebook_canonical_url,
            "handle": "@fixturevalid", "status": "confirmed",
            "identity_basis": "自测固定身份锚点。", "source_urls": [facebook_canonical_url],
        }]
        verdict = {
            "has_risk": False, "result_level": "无合作风险",
            "overall_conclusion": "未发现相关风险。",
        }
        representative_works: list[dict[str, Any]] = []
        risk_summary_order: list[str] = []
        risk_groups: list[dict[str, Any]] = []
        source_inventory = [facebook_canonical_url]
    else:
        subject_basic_source_url = risk_url
        supplied_homepages = [{
            "platform_key": "youtube", "subplatform": "",
            "input_url": youtube_supplied_input_url,
            "canonical_url": youtube_canonical_url,
            "canonicalization_route_id": (
                "" if api_only else str(youtube_canonicalization_route["route_id"])
            ),
        }]
        accounts = [{
            "platform_key": "youtube", "subplatform": "", "subplatform_entry_id": "",
            "url": youtube_canonical_url,
            "handle": "@fixturevalid", "status": "confirmed", "identity_basis": "自测固定身份锚点。",
            "source_urls": list(dict.fromkeys([youtube_supplied_input_url, youtube_canonical_url])),
        }]
        verdict = {"has_risk": True, "result_level": "建议评估", "overall_conclusion": "发现一项需评估内容。"}
        representative_works = [{
            "title": "测试作品", "role": "创作者", "client_or_publisher": "测试发布方",
            "source_url": risk_url, "notes": "验证器自测。",
        }]
        risk_summary_order = ["risk-001"]
        risk_groups = [{
            "id": "risk-001", "title": "测试风险", "category": "内容调性",
            "summary": "公开内容存在一项需评估事项。", "explanation": "该事项用于验证交接结构。",
            "instances": [{
                "platform_key": "youtube", "subplatform": "",
                "module_targets": [{
                    "module_key": "homepage", "module_url": youtube_canonical_url,
                }],
                "published_at": "2026-01-01", "finding": "视频包含一项需评估内容。",
                "source_url": risk_url, "source_type": "official_account_content",
                "screenshots": [{
                    "path": str(screenshot), "caption": "油管视频页面", "platform_label": "油管",
                    "visible_text": "自测风险文字", "sha256": _sha256(screenshot),
                }],
            }],
        }]
        source_inventory = list(dict.fromkeys([risk_url, youtube_supplied_input_url, youtube_canonical_url]))
    return {
        "schema_version": SCHEMA_VERSION,
        "subject": {
            "display_name": "测试对象", "subject_type": "person", "category": "视频创作者",
            "report_date": "2026-09-02", "aliases": ["fixturevalid"],
            "basic_info": "用于验证器自测的虚构对象。",
            "basic_info_source_urls": [subject_basic_source_url],
            "user_supplied_homepages": supplied_homepages,
            "scope": {"unit": "个人", "included": ["本人公开账号与公开内容"], "excluded": []},
        },
        "verdict": verdict,
        "accounts": accounts,
        "representative_works": representative_works,
        "risk_summary_order": risk_summary_order,
        "risk_groups": risk_groups,
        "platforms": platforms,
        "coverage": {
            "started_at": "2026-09-02T08:55:00+08:00",
            "completed_at": "2026-09-03T00:00:00+08:00",
            "network_preflight": {
                **preflight_summary,
                "log_path": str(preflight_log),
            },
            "risk_standard_path": str(standard), "risk_standard_sha256": _sha256(standard),
            "risk_terms_path": str(terms_path), "risk_terms_sha256": terms_hash,
            "risk_terms_count": len(terms), "aliases_checked": aliases,
            "keyword_groups_checked": keyword_groups,
            "native_search_sentinel_groups": keyword_groups[:4],
            "user_risk_leads": [],
            "search_engines_checked": ["baidu", "google"],
            "source_inventory": source_inventory,
            "final_linear_pass_index": 1,
            "pending_cross_platform_leads": [],
        },
        "qa": {flag: True for flag in QA_FLAGS},
    }


def run_self_test() -> int:
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=EVIDENCE_ROOT) as temp_dir:
        payload = _self_test_payload(Path(temp_dir))
        edge_png = Path(payload["risk_groups"][0]["instances"][0]["screenshots"][0]["path"]).read_bytes()
        valid_errors = validate(payload, check_files=True)
        if valid_errors:
            print("SELF-TEST valid fixture unexpectedly failed")
            for error in valid_errors:
                print(error)
            return 1

        legacy_browser_dir = Path(temp_dir) / "legacy-microsoft-edge-visible"
        legacy_browser_dir.mkdir()
        legacy_browser_payload = _self_test_payload(legacy_browser_dir, browser_ui=False)
        legacy_browser_errors = validate(legacy_browser_payload, check_files=True)
        if legacy_browser_errors:
            print("SELF-TEST legacy microsoft_edge_visible fixture unexpectedly failed")
            print("\n".join(legacy_browser_errors))
            return 1

        adaptive_dir = Path(temp_dir) / "adaptive-no-risk"
        adaptive_dir.mkdir()
        adaptive_payload = _self_test_payload(adaptive_dir, adaptive_no_risk=True)
        adaptive_errors = validate(adaptive_payload, check_files=True)
        if adaptive_errors:
            print("SELF-TEST complete adaptive no-risk payload unexpectedly failed")
            print("\n".join(adaptive_errors))
            return 1

        native_rank_dir = Path(temp_dir) / "native-rank-top10"
        native_rank_dir.mkdir()
        native_rank_payload = _self_test_payload(
            native_rank_dir,
            adaptive_no_risk=True,
            video_ranking_mode="native",
        )
        native_rank_errors = validate(native_rank_payload, check_files=True)
        if native_rank_errors:
            print("SELF-TEST native account Top-10 payload unexpectedly failed")
            print("\n".join(native_rank_errors))
            return 1

        unranked_dir = Path(temp_dir) / "unranked-video-boundary"
        unranked_dir.mkdir()
        unranked_payload = _self_test_payload(
            unranked_dir,
            adaptive_no_risk=True,
            video_ranking_mode="unranked",
        )
        unranked_errors = validate(unranked_payload, check_files=True)
        if unranked_errors:
            print("SELF-TEST accepted unrankable-video boundary unexpectedly failed")
            print("\n".join(unranked_errors))
            return 1

        ranked_payloads: dict[str, dict[str, Any]] = {}
        for tag, mode, count in (
            ("fewer-than-ten", "observed", 9),
            ("numeric-boundary-tie", "observed_tie", 11),
            ("native-boundary-tie", "observed_tie_native", 11),
            ("canonical-url-boundary-tie", "observed_tie_url", 11),
        ):
            ranked_dir = Path(temp_dir) / tag
            ranked_dir.mkdir()
            ranked_payload = _self_test_payload(
                ranked_dir,
                adaptive_no_risk=True,
                video_ranking_mode=mode,
                video_fixture_count=count,
            )
            ranked_payloads[tag] = ranked_payload
            ranked_errors = validate(ranked_payload, check_files=True)
            if ranked_errors:
                print(f"SELF-TEST {tag} Top-10 payload unexpectedly failed")
                print("\n".join(ranked_errors))
                return 1

        search_video_ranking_errors: list[str] = []
        _validate_account_video_top10(
            [{
                "account_url": None,
                "item_id": "search-video-not-account-ranked",
                "item_url": "https://www.facebook.com/watch/?v=search-fixture",
                "canonical_url": "https://www.facebook.com/watch/?v=search-fixture",
                "is_video": True,
                "has_full_review": False,
                "play_count_status": "observed",
                "play_count": 999999999,
                "native_rank": None,
                "metadata_observed_at": datetime.fromisoformat("2026-09-02T10:00:00+08:00"),
                "route_completed_at": datetime.fromisoformat("2026-09-02T10:01:00+08:00"),
                "published_at": "2026-09-01",
            }],
            delivered_account_urls={"https://www.facebook.com/fixturevalid"},
            prefix="self_test.search_video_top10_exclusion",
            errors=search_video_ranking_errors,
        )
        if search_video_ranking_errors:
            print("SELF-TEST search/non-account video unexpectedly entered account Top-10")
            print("\n".join(search_video_ranking_errors))
            return 1
        partial_native_errors: list[str] = []
        partial_native_provenance = (
            "self-test-partial-native-snapshot.json", "0" * 64,
            "https://www.facebook.com/fixturevalid", NATIVE_RANK_SOURCE_SURFACE,
            "popular", NATIVE_RANK_SCOPE, "2026-09-02T10:00:00+08:00",
        )
        _validate_account_video_top10(
            [
                {
                    "account_url": "https://www.facebook.com/fixturevalid",
                    "item_id": f"partial-native-{index:02d}",
                    "item_url": f"https://www.facebook.com/fixturevalid/videos/{index}",
                    "canonical_url": f"https://www.facebook.com/videos/{index}",
                    "stable_video_identity": f"facebook:{index}",
                    "is_video": True,
                    "has_full_review": False,
                    "play_count_status": "native_top_rank" if index <= 9 else "not_public",
                    "play_count": None,
                    "native_rank": index if index <= 9 else None,
                    "native_rank_provenance": partial_native_provenance if index <= 9 else None,
                    "metadata_observed_at": datetime.fromisoformat(
                        "2026-09-02T10:00:00+08:00"
                    ),
                    "route_completed_at": datetime.fromisoformat(
                        "2026-09-02T10:01:00+08:00"
                    ),
                    "published_at": f"2026-01-{12 - index:02d}",
                }
                for index in range(1, 12)
            ],
            delivered_account_urls={"https://www.facebook.com/fixturevalid"},
            prefix="self_test.partial_native_order_boundary",
            errors=partial_native_errors,
        )
        if partial_native_errors:
            print("SELF-TEST incomplete native order was guessed or over-upgraded")
            print("\n".join(partial_native_errors))
            return 1
        if not (
            _observation_time_key({
                "metadata_observed_at": datetime.fromisoformat("2026-09-02T03:00:00+00:00"),
            })
            > _observation_time_key({
                "metadata_observed_at": datetime.fromisoformat("2026-09-02T10:30:00+08:00"),
            })
        ):
            print("SELF-TEST cross-timezone latest observation ordering failed")
            return 1
        if not (
            _published_rank_key("2026-01-01T17:00:00+00:00")
            > _published_rank_key("2026-01-02T00:30:00+08:00")
        ):
            print("SELF-TEST cross-timezone published_at ordering failed")
            return 1
        youtube_aliases = {
            "https://www.youtube.com/watch?v=AliasFixture&utm_source=one",
            "https://youtu.be/AliasFixture?utm_source=two",
            "https://www.youtube.com/shorts/AliasFixture?feature=share",
            "https://www.youtube.com/live/AliasFixture",
        }
        if len({_stable_video_identity(url) for url in youtube_aliases}) != 1:
            print("SELF-TEST YouTube stable video identity alias normalization failed")
            return 1
        if len({_canonical_rank_url(url) for url in youtube_aliases}) != 1:
            print("SELF-TEST YouTube canonical rank URL alias normalization failed")
            return 1
        netease_videos = {
            "https://music.163.com/#/video?id=NetEaseVideoOne",
            "https://music.163.com/#/video?id=NetEaseVideoTwo",
        }
        if len({_stable_video_identity(url) for url in netease_videos}) != 2:
            print("SELF-TEST NetEase hash-router video identities collided")
            return 1
        if len({_canonical_rank_url(url) for url in netease_videos}) != 2:
            print("SELF-TEST NetEase hash-router canonical URLs collided")
            return 1
        xiaohongshu_aliases = {
            "https://www.xiaohongshu.com/explore/NoteFixture?xsec_token=one&utm_source=share",
            "https://www.xiaohongshu.com/discovery/item/NoteFixture?xsec_token=two",
        }
        x_status_aliases = {
            "https://x.com/fixture/status/123456789?utm_source=one",
            "https://twitter.com/i/web/status/123456789?ref_src=two",
        }
        instagram_post_aliases = {
            "https://www.instagram.com/p/PostFixture/?utm_source=one",
            "https://instagram.com/p/PostFixture?igsh=two",
        }
        for label, aliases in (
            ("Xiaohongshu note", xiaohongshu_aliases),
            ("X/Twitter status", x_status_aliases),
            ("Instagram post", instagram_post_aliases),
        ):
            if len({_stable_content_identity(url) for url in aliases}) != 1:
                print(f"SELF-TEST {label} stable content identity alias normalization failed")
                return 1
            if len({_canonical_rank_url(url) for url in aliases}) != 1:
                print(f"SELF-TEST {label} canonical rank URL alias normalization failed")
                return 1
            if any(_stable_video_identity(url) is not None for url in aliases):
                print(f"SELF-TEST generic {label} URL was misclassified as a video")
                return 1
        unknown_hash_urls = {
            "https://extra.example.test/#/video?id=one",
            "https://extra.example.test/#/video?id=two",
        }
        if len({_canonical_rank_url(url) for url in unknown_hash_urls}) != 2:
            print("SELF-TEST unknown hash-router content identities collided")
            return 1
        xhs_duplicate_identity_errors: list[str] = []
        _validate_item_observation_consistency(
            [
                {
                    "item_id": f"xhs-duplicate-{index}",
                    "canonical_url": _canonical_rank_url(url),
                    "stable_video_identity": _stable_content_identity(url),
                    "is_video": True,
                    "media_kinds": ("video",),
                    "triage_result": "clear",
                }
                for index, url in enumerate(sorted(xiaohongshu_aliases), start=1)
            ],
            prefix="self_test.xhs_duplicate_identity",
            errors=xhs_duplicate_identity_errors,
        )
        if not any("multiple stable IDs" in error for error in xhs_duplicate_identity_errors):
            print("SELF-TEST Xiaohongshu alias duplicate item-id bypass was not rejected")
            return 1
        explicit_count_cases = {
            "1次播放": 1,
            "1.2万次播放": 12000,
            "播放量：1.2万": 12000,
            "观看次数：1.2万": 12000,
            "播放次数 1.2万": 12000,
            "1,234 views": 1234,
            "Views: 1.2M": 1200000,
            "1.2K views": 1200,
        }
        if any(_parse_explicit_play_count(text) != expected for text, expected in explicit_count_cases.items()):
            print("SELF-TEST explicit playback-count normalization failed")
            return 1
        if any(
            _parse_explicit_play_count(text) is not None
            for text in (
                "12,34 views", "1.2万+次播放", "平台未公开播放量",
                "评论10 播放量不可见", "点赞 10 播放量未公开",
                "1 234 views", "1\u00a0234 views", "1\u202f234 views",
            )
        ):
            print("SELF-TEST ambiguous/malformed playback-count text was guessed")
            return 1

        # Public API enumeration can fully cover a homepage surface without
        # duplicating that surface in Edge. Each platform bucket still retains
        # a separate completed visible-Edge visit.
        api_dir = Path(temp_dir) / "api-homepages"
        api_dir.mkdir()
        api_payload = _self_test_payload(api_dir, api_homepages=True)
        api_errors = validate(api_payload, check_files=True)
        if api_errors:
            print("SELF-TEST complete API homepage coverage unexpectedly failed")
            print("\n".join(api_errors))
            return 1

        suspected_payload = copy.deepcopy(payload)
        suspected_payload["accounts"][0]["status"] = "suspected_homepage"
        suspected_homepage = suspected_payload["platforms"]["youtube"]["delivery_modules"]["homepage"]
        suspected_homepage["status"] = "suspected"
        suspected_homepage["url_identity_statuses"]["https://www.youtube.com/@fixturevalid"] = "suspected"
        suspected_payload["platforms"]["youtube"]["discovery_status"] = "suspected_account"
        suspected_payload["risk_groups"][0]["instances"][0]["finding"] = "该疑似主页账号发布的视频包含一项需评估内容。"
        suspected_payload["risk_groups"][0]["summary"] = "疑似主页账号公开内容存在一项需评估事项。"
        suspected_payload["risk_groups"][0]["explanation"] = "该事项来自疑似主页，账号归属尚未确认。"
        suspected_payload["verdict"]["overall_conclusion"] = "疑似主页出现一项需评估内容，账号归属尚未确认。"
        suspected_errors = validate(suspected_payload, check_files=True)
        if suspected_errors:
            print("SELF-TEST selected suspected-homepage fixture unexpectedly failed")
            for error in suspected_errors:
                print(error)
            return 1

        def fixture_routes(fixture: dict[str, Any]) -> list[dict[str, Any]]:
            flattened: list[dict[str, Any]] = []
            for platform in fixture["platforms"].values():
                flattened.extend(platform["research_completion"]["route_results"])
                for subplatform in platform.get("subplatforms", []):
                    flattened.extend(subplatform["research_completion"]["route_results"])
            return flattened

        expected_missing_browser_visit_errors = {
            f"platforms.{key}.research_completion.route_results: final exhaustive handoff requires "
            "at least one complete interactive browser UI route in this platform bucket; "
            "API/export may complete specific surfaces but cannot replace the mandatory browser visit"
            for key in PLATFORMS
        }

        adaptive_video_surfaces = {
            str(route_record.get("surface"))
            for route_record in fixture_routes(adaptive_payload)
            if route_record.get("discovered_items") == 11
        }
        if adaptive_video_surfaces != {"posts", "videos"}:
            print(
                "SELF-TEST account-wide duplicate video fixture did not span posts and videos: "
                f"{sorted(adaptive_video_surfaces)}"
            )
            return 1

        def transport_preflight(fixture: dict[str, Any], *, tag: str) -> None:
            """Use real-shaped non-browser HTTP checks, never Edge placeholders."""
            summary = fixture["coverage"]["network_preflight"]
            old_log = json.loads(Path(summary["log_path"]).read_text(encoding="utf-8"))
            transport = next(check for check in old_log["checks"] if check["route"] == "direct_https")
            checks = []
            for family, key in (("domestic", "weibo"), ("overseas", "youtube")):
                endpoint = next(
                    route_record["official_endpoint"]
                    for route_record in fixture["platforms"][key]["research_completion"]["route_results"]
                    if route_record["tool_kind"] == "official_api"
                )
                checks.append({
                    **transport, "family": family, "url": endpoint,
                    "host": urlparse(endpoint).hostname, "reachable": True,
                    "http_status": 200, "error": "",
                })
            summary.update({
                "browser_session_reachable": False,
                "tested_hosts": [check["host"] for check in checks],
            })
            log_path = Path(temp_dir) / f"{tag}-network-preflight.json"
            log_path.write_text(json.dumps({
                "schema_version": NETWORK_PREFLIGHT_SCHEMA_VERSION,
                **{key: value for key, value in summary.items() if key != "log_path"},
                "checks": checks,
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            summary["log_path"] = str(log_path)

        api_only_dir = Path(temp_dir) / "api-only"
        api_only_dir.mkdir()
        api_only_payload = _self_test_payload(api_only_dir, api_only=True)
        transport_preflight(api_only_payload, tag="api-only")
        api_only_errors = validate(api_only_payload, check_files=True)
        if set(api_only_errors) != expected_missing_browser_visit_errors:
            print("SELF-TEST API-only payload did not fail only on the fourteen mandatory browser visits")
            print("\n".join(api_only_errors))
            return 1

        export_only_payload = copy.deepcopy(api_only_payload)
        for route_record in fixture_routes(export_only_payload):
            log_data = json.loads(Path(route_record["result_log_path"]).read_text(encoding="utf-8"))
            route_record.update({
                "tool_kind": "authorized_export", "tool_name": "fixture-authorized-export",
                "route_family": "authorized_export", "authorization_status": "authorized_export",
                "official_product": route_record["official_product"].replace("Official API", "Authorized Export"),
                "official_endpoint": "", "permission_basis": "自测授权导出及完整逐项复核。",
                "authorization_evidence": {
                    **route_record["authorization_evidence"], "kind": "authorized_export_manifest",
                },
            })
            for field in (
                "tool_kind", "route_family", "authorization_status", "official_product",
                "official_endpoint", "permission_basis", "authorization_evidence",
            ):
                log_data[field] = route_record[field]
            for raw in log_data["raw_evidence"]:
                raw["kind"] = "authorized_export_manifest"
            export_log = Path(temp_dir) / f"export-only-{route_record['route_id']}-status.json"
            export_log.write_text(json.dumps(log_data, ensure_ascii=False) + "\n", encoding="utf-8")
            route_record["result_log_path"] = str(export_log)
        export_only_errors = validate(export_only_payload, check_files=True)
        if set(export_only_errors) != expected_missing_browser_visit_errors:
            print("SELF-TEST export-only payload did not fail only on the fourteen mandatory browser visits")
            print("\n".join(export_only_errors))
            return 1

        script_api_payload = copy.deepcopy(api_only_payload)
        script_route = fixture_routes(script_api_payload)[0]
        script_route.update({
            "tool_kind": "local_script", "tool_name": "fixture-official-api-script",
            "tool_path": str(Path(__file__).resolve()), "tool_sha256": _sha256(Path(__file__)),
        })
        script_log_data = json.loads(Path(script_route["result_log_path"]).read_text(encoding="utf-8"))
        script_log_data.update({"tool_kind": "local_script", "tool_sha256": script_route["tool_sha256"]})
        script_log = Path(temp_dir) / "script-api-status.json"
        script_log.write_text(json.dumps(script_log_data, ensure_ascii=False) + "\n", encoding="utf-8")
        script_route["result_log_path"] = str(script_log)
        script_api_errors = validate(script_api_payload, check_files=True)
        if set(script_api_errors) != expected_missing_browser_visit_errors:
            print("SELF-TEST authorized API script did not fail only on the fourteen mandatory browser visits")
            print("\n".join(script_api_errors))
            return 1

        for tag, shared_host in (("same-host-api-endpoints", True), ("proxy-fallback-api", False)):
            transport_payload = copy.deepcopy(api_only_payload)
            summary = transport_payload["coverage"]["network_preflight"]
            transport_log = json.loads(Path(summary["log_path"]).read_text(encoding="utf-8"))
            if shared_host:
                for check in transport_log["checks"]:
                    check.update({"url": f"https://api.github.com/fixture/{check['family']}", "host": "api.github.com"})
                summary["tested_hosts"] = transport_log["tested_hosts"] = ["api.github.com"]
            else:
                proxy_check = copy.deepcopy(transport_log["checks"][0])
                proxy_check["route"] = "configured_proxy"
                transport_log["checks"][0].update({"reachable": False, "http_status": 403, "error": "http_403"})
                transport_log["checks"].append(proxy_check)
                for field in ("proxy_configured", "proxy_reachable"):
                    summary[field] = transport_log[field] = True
            transport_log_path = Path(temp_dir) / f"{tag}-network-preflight.json"
            transport_log_path.write_text(json.dumps(transport_log) + "\n", encoding="utf-8")
            summary["log_path"] = str(transport_log_path)
            transport_errors = validate(transport_payload, check_files=True)
            if set(transport_errors) != expected_missing_browser_visit_errors:
                print(f"SELF-TEST {tag} transport diagnostic produced errors beyond mandatory browser visits")
                print("\n".join(transport_errors))
                return 1

        extra_edge_platforms = copy.deepcopy(api_only_payload["platforms"])
        extra_edge_platforms["domestic_other"]["subplatforms"] = [{
            "research_completion": {"route_results": [{
                "tool_kind": "microsoft_edge_visible", "status": "blocked",
            }]},
        }]
        unknown_route_platforms = copy.deepcopy(api_only_payload["platforms"])
        unknown_route_platforms["weibo"]["research_completion"]["route_results"][0]["tool_kind"] = "hosted_browser"
        blocked_script_platforms = copy.deepcopy(api_only_payload["platforms"])
        blocked_script_platforms["weibo"]["research_completion"]["route_results"][0].update({
            "tool_kind": "local_script", "route_family": "microsoft_edge_visible_surface", "status": "blocked",
        })
        failed_script_platforms = copy.deepcopy(blocked_script_platforms)
        failed_script_platforms["weibo"]["research_completion"]["route_results"][0]["status"] = "failed"
        for name, platform_fixture, expected in (
            ("API-only mode", api_only_payload["platforms"], False),
            ("export-only mode", export_only_payload["platforms"], False),
            ("mixed browser/API mode", payload["platforms"], True),
            ("blocked extra-platform browser mode", extra_edge_platforms, True),
            ("unknown route cannot bypass browser mode", unknown_route_platforms, True),
            ("blocked browser-family script cannot bypass browser mode", blocked_script_platforms, True),
            ("failed browser-family script cannot bypass browser mode", failed_script_platforms, True),
            ("empty routes cannot bypass browser mode", {}, True),
        ):
            if _requires_edge_network_preflight(platform_fixture) is not expected:
                print(f"SELF-TEST {name} preflight selection failed")
                return 1

        def rewrite_fixture_route_serial(
            route_record: dict[str, Any], new_serial: int, *, tag: str,
        ) -> None:
            """Clone mirrored self-test evidence while changing a route serial."""
            route_record["serial_route_index"] = new_serial
            log_data = json.loads(
                Path(route_record["result_log_path"]).read_text(encoding="utf-8")
            )
            log_data["serial_route_index"] = new_serial
            if route_record["tool_kind"] in INTERACTIVE_BROWSER_TOOL_KINDS:
                manifest_data = json.loads(
                    Path(route_record["edge_evidence_path"]).read_text(encoding="utf-8")
                )
                manifest_data["serial_route_index"] = new_serial
                manifest_path = Path(temp_dir) / f"{tag}-{route_record['route_id']}-edge-evidence.json"
                manifest_path.write_text(
                    json.dumps(manifest_data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                route_record["edge_evidence_path"] = str(manifest_path)
                route_record["edge_evidence_sha256"] = _sha256(manifest_path)
                route_record["evidence_fingerprint"] = _fingerprint_hashes([
                    *[raw["sha256"] for raw in log_data["raw_evidence"]],
                    route_record["edge_evidence_sha256"],
                ])
                log_data.update({
                    "evidence_fingerprint": route_record["evidence_fingerprint"],
                    "edge_evidence_path": route_record["edge_evidence_path"],
                    "edge_evidence_sha256": route_record["edge_evidence_sha256"],
                })
            log_path = Path(temp_dir) / f"{tag}-{route_record['route_id']}-status.json"
            log_path.write_text(
                json.dumps(log_data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            route_record["result_log_path"] = str(log_path)

        def rewrite_fixture_route_parallel(
            route_record: dict[str, Any], *, lane: int, slot: int,
        ) -> None:
            """Clone mirrored evidence into one of two overlapping Edge lanes."""
            started_dt = datetime.fromisoformat("2026-09-02T09:00:00+08:00") + timedelta(
                minutes=slot * 2
            )
            completed_dt = started_dt + timedelta(minutes=1)
            route_record["started_at"] = started_dt.isoformat()
            route_record["completed_at"] = completed_dt.isoformat()
            log_data = json.loads(
                Path(route_record["result_log_path"]).read_text(encoding="utf-8")
            )
            log_data.update({
                "started_at": route_record["started_at"],
                "completed_at": route_record["completed_at"],
            })
            log_data["completion_evidence"]["observed_at"] = route_record["completed_at"]
            # The metadata observation is part of both the content proof and
            # the raw detail-page evidence. Retime all three together so this
            # parallel positive fixture proves the corresponding-route gate
            # instead of relying on a stale timestamp from the serial fixture.
            source_ledger_path = Path(route_record["item_ledger_path"])
            ledger_rows = [
                json.loads(line)
                for line in source_ledger_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            video_rows = [row for row in ledger_rows if isinstance(row.get("video_metadata"), dict)]
            if video_rows:
                new_observed_at = (started_dt + timedelta(seconds=30)).isoformat()
                raw_entry = log_data["raw_evidence"][0]
                source_raw_path = Path(raw_entry["path"])
                raw_document = json.loads(source_raw_path.read_text(encoding="utf-8"))
                raw_items = raw_document.get("items", [])
                for ledger_row in video_rows:
                    ledger_row["video_metadata"]["observed_at"] = new_observed_at
                    native_ref = ledger_row["video_metadata"].get("native_rank_evidence")
                    if isinstance(native_ref, dict):
                        source_native_path = Path(native_ref["path"])
                        native_document = json.loads(source_native_path.read_text(encoding="utf-8"))
                        native_document["observed_at"] = new_observed_at
                        native_path = Path(temp_dir) / (
                            f"parallel-{route_record['route_id']}-{ledger_row['item_id']}-native-rank.json"
                        )
                        native_path.write_text(
                            json.dumps(native_document, ensure_ascii=False) + "\n", encoding="utf-8"
                        )
                        native_ref["path"] = str(native_path)
                        native_ref["sha256"] = _sha256(native_path)
                    raw_match = next(
                        raw_item for raw_item in raw_items
                        if raw_item.get("item_id") == ledger_row.get("item_id")
                        and raw_item.get("url") == ledger_row.get("url")
                    )
                    raw_match["video_metadata"] = copy.deepcopy(ledger_row["video_metadata"])
                raw_path = Path(temp_dir) / f"parallel-{route_record['route_id']}-raw.json"
                raw_path.write_text(
                    json.dumps(raw_document, ensure_ascii=False) + "\n", encoding="utf-8"
                )
                raw_sha = _sha256(raw_path)
                raw_entry["path"] = str(raw_path)
                raw_entry["sha256"] = raw_sha
                log_data["completion_evidence"]["source_ref"]["path"] = str(raw_path)
                log_data["completion_evidence"]["source_ref"]["sha256"] = raw_sha
                for ledger_row in video_rows:
                    proof = ledger_row["review_evidence"]
                    proof["content_sha256"] = content_sha256(ledger_row)
                    for evidence_ref in proof["evidence_refs"]:
                        if evidence_ref.get("path") == str(source_raw_path):
                            evidence_ref["path"] = str(raw_path)
                            evidence_ref["sha256"] = raw_sha
                    detail_ref = proof["video_triage"]["detail_source_ref"]
                    if detail_ref.get("path") == str(source_raw_path):
                        detail_ref["path"] = str(raw_path)
                        detail_ref["sha256"] = raw_sha
                ledger_path = Path(temp_dir) / f"parallel-{route_record['route_id']}-items.jsonl"
                ledger_path.write_text(
                    "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in ledger_rows),
                    encoding="utf-8",
                )
                route_record["item_ledger_path"] = str(ledger_path)
                route_record["item_ledger_sha256"] = _sha256(ledger_path)
                log_data["item_ledger_sha256"] = route_record["item_ledger_sha256"]
            if route_record["tool_kind"] in INTERACTIVE_BROWSER_TOOL_KINDS:
                window_id = f"00000000-0000-4000-8000-{lane + 101:012d}"
                page_id = f"00000000-0000-4000-8000-{lane + 201:012d}"
                route_record.update({
                    "edge_window_continuity_id": window_id,
                    "edge_page_continuity_id": page_id,
                    "max_task_open_edge_pages": 2,
                })
                manifest_data = json.loads(
                    Path(route_record["edge_evidence_path"]).read_text(encoding="utf-8")
                )
                manifest_data.update({
                    "edge_window_continuity_id": window_id,
                    "edge_page_continuity_id": page_id,
                    "max_task_open_edge_pages": 2,
                    "review_started_at": (started_dt + timedelta(seconds=10)).isoformat(),
                    "captured_at": (started_dt + timedelta(seconds=50)).isoformat(),
                })
                manifest_path = Path(temp_dir) / (
                    f"parallel-{route_record['route_id']}-edge-evidence.json"
                )
                manifest_path.write_text(
                    json.dumps(manifest_data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                route_record["edge_evidence_path"] = str(manifest_path)
                route_record["edge_evidence_sha256"] = _sha256(manifest_path)
                route_record["evidence_fingerprint"] = _fingerprint_hashes([
                    *[raw["sha256"] for raw in log_data["raw_evidence"]],
                    route_record["edge_evidence_sha256"],
                ])
                log_data.update({
                    "edge_window_continuity_id": window_id,
                    "edge_page_continuity_id": page_id,
                    "max_task_open_edge_pages": 2,
                    "edge_evidence_path": route_record["edge_evidence_path"],
                    "edge_evidence_sha256": route_record["edge_evidence_sha256"],
                    "evidence_fingerprint": route_record["evidence_fingerprint"],
                })
            elif video_rows:
                route_record["evidence_fingerprint"] = _fingerprint_hashes([
                    raw["sha256"] for raw in log_data["raw_evidence"]
                ])
                log_data["evidence_fingerprint"] = route_record["evidence_fingerprint"]
            log_path = Path(temp_dir) / f"parallel-{route_record['route_id']}-status.json"
            log_path.write_text(
                json.dumps(log_data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            route_record["result_log_path"] = str(log_path)

        parallel_payload = copy.deepcopy(payload)
        edge_lane_slots = [0, 0]
        for route_record in sorted(
            fixture_routes(parallel_payload), key=lambda item: item["serial_route_index"]
        ):
            if route_record["tool_kind"] in INTERACTIVE_BROWSER_TOOL_KINDS:
                lane = min(range(2), key=lambda value: edge_lane_slots[value])
                slot = edge_lane_slots[lane]
                edge_lane_slots[lane] += 1
            else:
                lane = 0
                slot = 0
            rewrite_fixture_route_parallel(route_record, lane=lane, slot=slot)
        parallel_payload_errors = validate(parallel_payload, check_files=True)
        if parallel_payload_errors:
            print("SELF-TEST full parallel multi-page payload unexpectedly failed")
            print("\n".join(parallel_payload_errors))
            return 1

        earlier_wave_evidence_payload = copy.deepcopy(payload)
        earlier_wave_evidence_payload["coverage"]["final_linear_pass_index"] = 2
        later_wave_route = max(
            fixture_routes(earlier_wave_evidence_payload),
            key=lambda item: item["serial_route_index"],
        )
        later_wave_route["linear_pass_index"] = 2
        later_wave_log = json.loads(
            Path(later_wave_route["result_log_path"]).read_text(encoding="utf-8")
        )
        later_wave_log["linear_pass_index"] = 2
        if later_wave_route["tool_kind"] in INTERACTIVE_BROWSER_TOOL_KINDS:
            later_wave_manifest = json.loads(
                Path(later_wave_route["edge_evidence_path"]).read_text(encoding="utf-8")
            )
            later_wave_manifest["linear_pass_index"] = 2
            later_wave_manifest_path = Path(temp_dir) / "later-wave-edge-evidence.json"
            later_wave_manifest_path.write_text(
                json.dumps(later_wave_manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            later_wave_route["edge_evidence_path"] = str(later_wave_manifest_path)
            later_wave_route["edge_evidence_sha256"] = _sha256(later_wave_manifest_path)
            later_wave_route["evidence_fingerprint"] = _fingerprint_hashes([
                *[raw["sha256"] for raw in later_wave_log["raw_evidence"]],
                later_wave_route["edge_evidence_sha256"],
            ])
            later_wave_log.update({
                "edge_evidence_path": later_wave_route["edge_evidence_path"],
                "edge_evidence_sha256": later_wave_route["edge_evidence_sha256"],
                "evidence_fingerprint": later_wave_route["evidence_fingerprint"],
            })
        later_wave_log_path = Path(temp_dir) / "later-wave-status.json"
        later_wave_log_path.write_text(
            json.dumps(later_wave_log, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        later_wave_route["result_log_path"] = str(later_wave_log_path)
        earlier_wave_errors = validate(earlier_wave_evidence_payload, check_files=True)
        if earlier_wave_errors:
            print("SELF-TEST earlier positive-wave evidence unexpectedly failed")
            print("\n".join(earlier_wave_errors))
            return 1

        # Positive login-wall handoff: the blocked Edge attempt is preserved,
        # the user-completed login is timestamped, and the resolver restarts
        # the same platform/module/surface/URL from the visible surface start.
        login_payload = copy.deepcopy(payload)
        login_routes = login_payload["platforms"]["youtube"]["research_completion"]["route_results"]
        resolver = next(
            route for route in login_routes
            if route["module_key"] == "homepage"
            and route["surface"] == "videos"
            and route["tool_kind"] in INTERACTIVE_BROWSER_TOOL_KINDS
        )
        resolver_old_serial = resolver["serial_route_index"]
        for route_record in fixture_routes(login_payload):
            if route_record["serial_route_index"] >= resolver_old_serial:
                rewrite_fixture_route_serial(
                    route_record,
                    route_record["serial_route_index"] + 1,
                    tag="login-shift",
                )
        resolver_original_start = datetime.fromisoformat(resolver["started_at"])
        blocked_started_at = resolver_original_start
        blocked_completed_at = blocked_started_at + timedelta(seconds=15)
        resolver["started_at"] = blocked_completed_at.isoformat()
        login_completed_at = (blocked_started_at + timedelta(seconds=20)).isoformat()
        review_started_at = (blocked_started_at + timedelta(seconds=25)).isoformat()
        resolver_captured_at = (blocked_started_at + timedelta(seconds=50)).isoformat()
        resolver_artifact = Path(temp_dir) / "login-resolver-edge-screenshot.png"
        resolver_artifact.write_bytes(edge_png)
        resolver_manifest = Path(temp_dir) / "login-resolver-edge-evidence.json"
        resolver_manifest.write_text(json.dumps({
            "schema_version": EDGE_ROUTE_EVIDENCE_SCHEMA_VERSION, "route_id": resolver["route_id"],
            "account_or_query_url": resolver["account_or_query_url"],
            "final_visible_url": resolver["resolved_url"],
            "browser_family": "fixture_interactive_browser", "window_mode": "visible",
            "edge_session_state": "user_login_completed",
            "edge_window_continuity_id": resolver["edge_window_continuity_id"],
            "edge_page_continuity_id": resolver["edge_page_continuity_id"],
            "max_task_open_edge_pages": 1,
            "serial_route_index": resolver["serial_route_index"],
            "linear_pass_index": resolver["linear_pass_index"],
            "capture_scope": BROWSER_CAPTURE_SCOPE,
            "user_login_completed_at": login_completed_at,
            "review_start_mode": "surface_start", "review_started_at": review_started_at,
            "captured_at": resolver_captured_at,
            "artifact_path": str(resolver_artifact), "artifact_sha256": _sha256(resolver_artifact),
            "artifact_kind": "browser_screenshot",
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        resolver["edge_session_state"] = "user_login_completed"
        resolver["user_login_completed_at"] = login_completed_at
        resolver["edge_evidence_path"] = str(resolver_manifest)
        resolver["edge_evidence_sha256"] = _sha256(resolver_manifest)
        resolver_log_data = json.loads(Path(resolver["result_log_path"]).read_text(encoding="utf-8"))
        resolver["evidence_fingerprint"] = _fingerprint_hashes([
            *[raw["sha256"] for raw in resolver_log_data["raw_evidence"]],
            resolver["edge_evidence_sha256"],
        ])
        resolver_log_data.update({
            "evidence_fingerprint": resolver["evidence_fingerprint"],
            "edge_session_state": resolver["edge_session_state"],
            "user_login_completed_at": resolver["user_login_completed_at"],
            "edge_evidence_path": resolver["edge_evidence_path"],
            "edge_evidence_sha256": resolver["edge_evidence_sha256"],
            "started_at": resolver["started_at"],
        })
        resolver_log = Path(temp_dir) / "login-resolver-route-status.json"
        resolver_log.write_text(json.dumps(resolver_log_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        resolver["result_log_path"] = str(resolver_log)

        blocked = copy.deepcopy(resolver)
        blocked["route_id"] = f"{resolver['route_id']}-login-boundary"
        blocked["status"] = "blocked"
        blocked["termination"] = "login_wall"
        blocked["edge_session_state"] = "login_required"
        blocked["user_login_completed_at"] = None
        blocked["discovered_items"] = resolver["discovered_items"]
        blocked["reviewed_items"] = resolver["reviewed_items"]
        blocked["unreviewed_items"] = 0
        blocked["resolved_by_route_ids"] = [resolver["route_id"]]
        blocked["serial_route_index"] = resolver["serial_route_index"] - 1
        blocked["started_at"] = blocked_started_at.isoformat()
        blocked["completed_at"] = blocked_completed_at.isoformat()
        blocked["boundary"] = "login wall"
        blocked_ledger = Path(temp_dir) / "login-boundary-items.jsonl"
        blocked_rows = [
            json.loads(line)
            for line in Path(resolver["item_ledger_path"]).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        prelogin_observed_at = (blocked_started_at + timedelta(seconds=10)).isoformat()
        for blocked_row in blocked_rows:
            if isinstance(blocked_row.get("video_metadata"), dict):
                blocked_row["video_metadata"]["observed_at"] = prelogin_observed_at
            blocked_row["review_evidence"]["reviewed_at"] = prelogin_observed_at
        blocked_detail_raw = Path(temp_dir) / "login-boundary-detail-raw.json"
        blocked_detail_raw.write_text(
            json.dumps({
                "items": [
                    {key: copy.deepcopy(value) for key, value in blocked_row.items() if key != "review_evidence"}
                    for blocked_row in blocked_rows
                ],
            }, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        blocked_detail_sha = _sha256(blocked_detail_raw)
        for blocked_index, blocked_row in enumerate(blocked_rows):
            detail_ref = {
                "path": str(blocked_detail_raw),
                "sha256": blocked_detail_sha,
                "locator": f"json:/items/{blocked_index}",
            }
            blocked_row["review_evidence"]["content_sha256"] = content_sha256(blocked_row)
            blocked_row["review_evidence"]["evidence_refs"] = [detail_ref]
            blocked_row["review_evidence"]["video_triage"]["detail_source_ref"] = detail_ref
        blocked_ledger.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in blocked_rows),
            encoding="utf-8",
        )
        blocked["item_ledger_path"] = str(blocked_ledger)
        blocked["item_ledger_sha256"] = _sha256(blocked_ledger)
        blocked_artifact = Path(temp_dir) / "login-boundary-edge-screenshot.png"
        blocked_artifact.write_bytes(edge_png)
        blocked_manifest = Path(temp_dir) / "login-boundary-edge-evidence.json"
        blocked_manifest.write_text(json.dumps({
            "schema_version": EDGE_ROUTE_EVIDENCE_SCHEMA_VERSION, "route_id": blocked["route_id"],
            "account_or_query_url": blocked["account_or_query_url"],
            "final_visible_url": blocked["resolved_url"],
            "browser_family": "fixture_interactive_browser", "window_mode": "visible",
            "edge_session_state": "login_required",
            "edge_window_continuity_id": blocked["edge_window_continuity_id"],
            "edge_page_continuity_id": blocked["edge_page_continuity_id"],
            "max_task_open_edge_pages": 1,
            "serial_route_index": blocked["serial_route_index"],
            "linear_pass_index": blocked["linear_pass_index"],
            "capture_scope": BROWSER_CAPTURE_SCOPE,
            "user_login_completed_at": None,
            "review_start_mode": "not_started", "review_started_at": None,
            "captured_at": (blocked_started_at + timedelta(seconds=10)).isoformat(),
            "artifact_path": str(blocked_artifact), "artifact_sha256": _sha256(blocked_artifact),
            "artifact_kind": "browser_screenshot",
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        blocked["edge_evidence_path"] = str(blocked_manifest)
        blocked["edge_evidence_sha256"] = _sha256(blocked_manifest)
        blocked_raw = Path(temp_dir) / "login-boundary-raw.json"
        blocked_raw.write_text(
            json.dumps({"status": "blocked", "stop_reason": "login_wall", "exit_code": 2}) + "\n",
            encoding="utf-8",
        )
        blocked["evidence_fingerprint"] = _fingerprint_hashes([
            _sha256(blocked_raw), blocked_detail_sha, blocked["edge_evidence_sha256"],
        ])
        blocked_log_data = copy.deepcopy(resolver_log_data)
        blocked_log_data.update({
            "route_id": blocked["route_id"], "evidence_fingerprint": blocked["evidence_fingerprint"],
            "serial_route_index": blocked["serial_route_index"],
            "linear_pass_index": blocked["linear_pass_index"],
            "edge_session_state": "login_required",
            "edge_window_continuity_id": blocked["edge_window_continuity_id"],
            "edge_page_continuity_id": blocked["edge_page_continuity_id"],
            "max_task_open_edge_pages": blocked["max_task_open_edge_pages"],
            "user_login_completed_at": None,
            "edge_evidence_path": blocked["edge_evidence_path"],
            "edge_evidence_sha256": blocked["edge_evidence_sha256"],
            "status": "blocked", "termination": "login_wall",
            "discovered_items": blocked["discovered_items"],
            "reviewed_items": blocked["reviewed_items"], "unreviewed_items": 0,
            "item_ledger_sha256": blocked["item_ledger_sha256"],
            "resolved_by_route_ids": [resolver["route_id"]],
            "started_at": blocked["started_at"], "completed_at": blocked["completed_at"],
            "raw_evidence": [{
                "path": str(blocked_raw), "sha256": _sha256(blocked_raw), "kind": "collector_status",
            }, {
                "path": str(blocked_detail_raw), "sha256": blocked_detail_sha, "kind": "api_response",
            }],
        })
        blocked_log = Path(temp_dir) / "login-boundary-route-status.json"
        blocked_log.write_text(json.dumps(blocked_log_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        blocked["result_log_path"] = str(blocked_log)
        login_routes.append(blocked)
        login_errors = validate(login_payload, check_files=True)
        if login_errors:
            print("SELF-TEST user-login Edge resolver fixture unexpectedly failed")
            for error in login_errors:
                print(error)
            return 1

        def set_login_resolver_review_mode(
            fixture: dict[str, Any], mode: str, *, tag: str,
        ) -> tuple[dict[str, Any], dict[str, Any]]:
            """Rewrite only synthetic Edge evidence while preserving its hashes."""
            fixture_routes_for_platform = fixture["platforms"]["youtube"]["research_completion"]["route_results"]
            blocked_route = next(
                route for route in fixture_routes_for_platform if route["termination"] == "login_wall"
            )
            resolver_route = next(
                route for route in fixture_routes_for_platform
                if route["route_id"] == blocked_route["resolved_by_route_ids"][0]
            )
            manifest_data = json.loads(
                Path(resolver_route["edge_evidence_path"]).read_text(encoding="utf-8")
            )
            manifest_data["review_start_mode"] = mode
            manifest_path = Path(temp_dir) / f"{tag}-resolver-edge-evidence.json"
            manifest_path.write_text(
                json.dumps(manifest_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            resolver_route["edge_evidence_path"] = str(manifest_path)
            resolver_route["edge_evidence_sha256"] = _sha256(manifest_path)
            log_data = json.loads(
                Path(resolver_route["result_log_path"]).read_text(encoding="utf-8")
            )
            resolver_route["evidence_fingerprint"] = _fingerprint_hashes([
                *[raw["sha256"] for raw in log_data["raw_evidence"]],
                resolver_route["edge_evidence_sha256"],
            ])
            log_data.update({
                "edge_evidence_path": resolver_route["edge_evidence_path"],
                "edge_evidence_sha256": resolver_route["edge_evidence_sha256"],
                "evidence_fingerprint": resolver_route["evidence_fingerprint"],
            })
            log_path = Path(temp_dir) / f"{tag}-resolver-route-status.json"
            log_path.write_text(
                json.dumps(log_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            resolver_route["result_log_path"] = str(log_path)
            return blocked_route, resolver_route

        # Default checkpoint continuation: the pre-login risk row remains in
        # the blocked ledger, the resolver continues after it and reaches the
        # real endpoint with an empty post-checkpoint ledger. The validator
        # must merge both ledgers for the resolved surface's gates.
        checkpoint_payload = copy.deepcopy(login_payload)
        checkpoint_blocked, checkpoint_resolver = set_login_resolver_review_mode(
            checkpoint_payload, "checkpoint_resume", tag="checkpoint-positive",
        )
        checkpoint_empty_ledger = Path(temp_dir) / "checkpoint-positive-post-items.jsonl"
        checkpoint_empty_ledger.write_text("", encoding="utf-8")
        checkpoint_raw = Path(temp_dir) / "checkpoint-positive-terminal-raw.json"
        checkpoint_raw.write_text(json.dumps({
            "scope": {
                "platform_key": "youtube", "surface": checkpoint_resolver["surface"],
                "url": checkpoint_resolver["resolved_url"],
            },
            "items": [],
        }, ensure_ascii=False) + "\n", encoding="utf-8")
        checkpoint_resolver.update({
            "discovered_items": 0, "reviewed_items": 0, "unreviewed_items": 0,
            "item_ledger_path": str(checkpoint_empty_ledger),
            "item_ledger_sha256": _sha256(checkpoint_empty_ledger),
        })
        checkpoint_log_data = json.loads(
            Path(checkpoint_resolver["result_log_path"]).read_text(encoding="utf-8")
        )
        checkpoint_raw_sha = _sha256(checkpoint_raw)
        checkpoint_resolver["evidence_fingerprint"] = _fingerprint_hashes([
            checkpoint_raw_sha, checkpoint_resolver["edge_evidence_sha256"],
        ])
        checkpoint_log_data.update({
            "evidence_fingerprint": checkpoint_resolver["evidence_fingerprint"],
            "discovered_items": 0, "reviewed_items": 0, "unreviewed_items": 0,
            "item_ledger_sha256": checkpoint_resolver["item_ledger_sha256"],
            "raw_evidence": [{
                "path": str(checkpoint_raw), "sha256": checkpoint_raw_sha,
                "kind": "browser_snapshot",
            }],
            "completion_evidence": {
                "kind": "empty_surface", "platform_key": "youtube",
                "surface": checkpoint_resolver["surface"],
                "url": checkpoint_resolver["resolved_url"], "discovered_items": 0,
                "observed_at": checkpoint_resolver["completed_at"],
                "source_ref": {
                    "path": str(checkpoint_raw), "sha256": checkpoint_raw_sha,
                    "locator": "json:/items",
                },
                "scope_locator": "/scope", "signal": "empty_array", "marker": None,
            },
        })
        checkpoint_log = Path(temp_dir) / "checkpoint-positive-terminal-status.json"
        checkpoint_log.write_text(
            json.dumps(checkpoint_log_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        checkpoint_resolver["result_log_path"] = str(checkpoint_log)
        checkpoint_errors = validate(checkpoint_payload, check_files=True)
        if checkpoint_errors:
            print("SELF-TEST checkpoint-resume login resolver unexpectedly failed")
            for error in checkpoint_errors:
                print(error)
            return 1

        # A login wall may occur before any item becomes visible.  The blocked
        # route must still preserve a real, hashed (empty) ledger and the
        # post-login surface-start traversal remains the complete resolver.
        zero_login_payload = copy.deepcopy(login_payload)
        zero_blocked = next(
            route for route in zero_login_payload["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["termination"] == "login_wall"
        )
        empty_prelogin_ledger = Path(temp_dir) / "login-boundary-empty-items.jsonl"
        empty_prelogin_ledger.write_text("", encoding="utf-8")
        zero_blocked.update({
            "discovered_items": 0,
            "reviewed_items": 0,
            "unreviewed_items": 0,
            "item_ledger_path": str(empty_prelogin_ledger),
            "item_ledger_sha256": _sha256(empty_prelogin_ledger),
        })
        zero_blocked_log_data = json.loads(
            Path(zero_blocked["result_log_path"]).read_text(encoding="utf-8")
        )
        zero_blocked_log_data.update({
            "discovered_items": 0,
            "reviewed_items": 0,
            "unreviewed_items": 0,
            "item_ledger_sha256": zero_blocked["item_ledger_sha256"],
        })
        zero_blocked_log = Path(temp_dir) / "login-boundary-empty-route-status.json"
        zero_blocked_log.write_text(
            json.dumps(zero_blocked_log_data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        zero_blocked["result_log_path"] = str(zero_blocked_log)
        zero_login_errors = validate(zero_login_payload, check_files=True)
        if zero_login_errors:
            print("SELF-TEST empty pre-login ledger fixture unexpectedly failed")
            for error in zero_login_errors:
                print(error)
            return 1
        cases: list[tuple[str, dict[str, Any], str]] = []
        broken = copy.deepcopy(login_payload)
        _checkpoint_duplicate_blocked, _checkpoint_duplicate_resolver = set_login_resolver_review_mode(
            broken, "checkpoint_resume", tag="checkpoint-duplicate",
        )
        cases.append((
            "checkpoint resume duplicates a pre-login item",
            broken,
            "checkpoint_resume ledger duplicates pre-login item_id/URL pairs",
        ))

        broken = copy.deepcopy(checkpoint_payload)
        checkpoint_missing_blocked = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["termination"] == "login_wall"
        )
        checkpoint_missing_ledger = Path(temp_dir) / "checkpoint-missing-prelogin-items.jsonl"
        checkpoint_missing_ledger.write_text("", encoding="utf-8")
        checkpoint_missing_blocked.update({
            "discovered_items": 0, "reviewed_items": 0, "unreviewed_items": 0,
            "item_ledger_path": str(checkpoint_missing_ledger),
            "item_ledger_sha256": _sha256(checkpoint_missing_ledger),
        })
        checkpoint_missing_log_data = json.loads(
            Path(checkpoint_missing_blocked["result_log_path"]).read_text(encoding="utf-8")
        )
        checkpoint_missing_log_data.update({
            "discovered_items": 0, "reviewed_items": 0, "unreviewed_items": 0,
            "item_ledger_sha256": checkpoint_missing_blocked["item_ledger_sha256"],
        })
        checkpoint_missing_log = Path(temp_dir) / "checkpoint-missing-prelogin-status.json"
        checkpoint_missing_log.write_text(
            json.dumps(checkpoint_missing_log_data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        checkpoint_missing_blocked["result_log_path"] = str(checkpoint_missing_log)
        cases.append((
            "checkpoint union omits a pre-login risk item",
            broken,
            "risk instance target is absent from its reviewed route ledger",
        ))

        broken = copy.deepcopy(checkpoint_payload)
        checkpoint_switched_blocked = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["termination"] == "login_wall"
        )
        checkpoint_switched_resolver = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["route_id"] == checkpoint_switched_blocked["resolved_by_route_ids"][0]
        )
        checkpoint_switched_resolver["edge_page_continuity_id"] = "00000000-0000-4000-8000-00000000eeee"
        cases.append((
            "checkpoint resume switches Edge pages",
            broken,
            "must use the same edge_page_continuity_id",
        ))

        google_adaptive_dir = Path(temp_dir) / "google-adaptive"
        google_adaptive_dir.mkdir()
        cases.append((
            "Google cannot use adaptive sentinel groups",
            _self_test_payload(google_adaptive_dir, google_adaptive=True),
            "Baidu/Google routes must exactly equal coverage.keyword_groups_checked",
        ))
        broken = copy.deepcopy(adaptive_payload)
        broken["coverage"]["user_risk_leads"] = [{
            "lead_id": "facebook-specific-lead",
            "platform_keys": ["facebook"],
            "keyword_groups": ["内容调性"],
            "description": "用户明确要求核查 Facebook 上的一项具体内容风险线索。",
        }]
        cases.append((
            "user risk lead does not upgrade adaptive platform",
            broken,
            "coverage.user_risk_leads explicitly targets this platform",
        ))
        def add_transport_failure(name: str, mutate: Any, expected: str) -> None:
            broken_preflight_payload = copy.deepcopy(api_only_payload)
            summary = broken_preflight_payload["coverage"]["network_preflight"]
            log_data = json.loads(Path(summary["log_path"]).read_text(encoding="utf-8"))
            mutate(summary, log_data)
            log_path = Path(temp_dir) / f"api-only-negative-{len(cases)}-preflight.json"
            log_path.write_text(json.dumps(log_data, ensure_ascii=False) + "\n", encoding="utf-8")
            summary["log_path"] = str(log_path)
            cases.append((name, broken_preflight_payload, expected))

        broken = copy.deepcopy(api_only_payload)
        broken["coverage"].pop("network_preflight")
        cases.append(("API-only missing preflight", broken, "coverage.network_preflight: must be an object"))
        broken = copy.deepcopy(api_only_payload)
        broken["coverage"]["network_preflight"]["log_path"] = str(Path(temp_dir) / "absent-api-preflight.json")
        cases.append(("API-only missing preflight log", broken, "coverage.network_preflight.log_path: file does not exist"))
        add_transport_failure(
            "API-only missing overseas transport",
            lambda summary, log: log["checks"].pop(),
            "overseas_route_reachable: must be derived from validated checks",
        )
        add_transport_failure(
            "API-only transport lacks HTTP response",
            lambda summary, log: log["checks"][0].update({"http_status": None}),
            "reachable transport check requires an HTTP response code",
        )
        add_transport_failure(
            "API-only transport error is not reachability",
            lambda summary, log: log["checks"][0].update({"http_status": 403, "error": "forbidden"}),
            "API/export transport reachability requires a successful HTTP response",
        )
        add_transport_failure(
            "API-only fabricated browser reachability",
            lambda summary, log: (summary.update({"browser_session_reachable": True}), log.update({"browser_session_reachable": True})),
            "browser_session_reachable: must be derived from hashed browser evidence",
        )
        add_transport_failure(
            "API-only transport fabricates Edge field",
            lambda summary, log: log["checks"][0].update({"browser_family": "microsoft_edge"}),
            "browser_family: non-browser check must be null",
        )
        add_transport_failure(
            "API-only host mismatches URL",
            lambda summary, log: log["checks"][0].update({"host": "www.google.com"}),
            "host: must match the tested URL hostname",
        )
        add_transport_failure(
            "API-only host inventory has extra entry",
            lambda summary, log: (summary["tested_hosts"].append("unused-host.invalid"), log["tested_hosts"].append("unused-host.invalid")),
            "tested_hosts: must exactly list the unique tested URL hostnames",
        )
        add_transport_failure(
            "API-only host inventory omits entry",
            lambda summary, log: (summary["tested_hosts"].pop(), log["tested_hosts"].pop()),
            "tested_hosts: must exactly list the unique tested URL hostnames",
        )
        add_transport_failure(
            "API-only one URL cannot prove two families",
            lambda summary, log: log["checks"][1].update({"url": log["checks"][0]["url"], "host": log["checks"][0]["host"]}),
            "one API test URL cannot prove both domestic and overseas routes",
        )
        for invalid_checked_at in ("not a timestamp", "2026-09-02T08:55:00"):
            add_transport_failure(
                f"API-only invalid checked_at {invalid_checked_at}",
                lambda summary, log, value=invalid_checked_at: (summary.update({"checked_at": value}), log.update({"checked_at": value})),
                "coverage.network_preflight.checked_at:",
            )
        broken = copy.deepcopy(payload)
        broken["coverage"]["network_preflight"] = copy.deepcopy(api_only_payload["coverage"]["network_preflight"])
        cases.append((
            "mixed browser/API run cannot use transport-only preflight", broken,
            "must contain exactly two visible interactive-browser session checks",
        ))
        broken = copy.deepcopy(login_payload)
        broken["coverage"]["network_preflight"] = copy.deepcopy(api_only_payload["coverage"]["network_preflight"])
        cases.append((
            "blocked and resolved browser run cannot use transport-only preflight", broken,
            "must contain exactly two visible interactive-browser session checks",
        ))
        broken = copy.deepcopy(api_only_payload)
        fixture_routes(broken)[0]["authorization_evidence"] = None
        cases.append(("API-only missing authorization", broken, "completed non-manual route requires hashed authorization evidence"))
        broken = copy.deepcopy(api_only_payload)
        fixture_routes(broken)[0]["termination"] = "max_pages"
        cases.append(("API-only capped route is not complete", broken, "not a verified natural end"))
        broken = copy.deepcopy(api_only_payload)
        fixture_routes(broken)[0]["reviewed_items"] = 1
        cases.append(("API-only item-count mismatch", broken, "discovered_items must equal reviewed_items"))
        broken = copy.deepcopy(api_only_payload)
        missing_raw_route = fixture_routes(broken)[0]
        missing_raw_log = json.loads(Path(missing_raw_route["result_log_path"]).read_text(encoding="utf-8"))
        missing_raw_log["raw_evidence"] = []
        missing_raw_path = Path(temp_dir) / "api-only-missing-raw-status.json"
        missing_raw_path.write_text(json.dumps(missing_raw_log) + "\n", encoding="utf-8")
        missing_raw_route["result_log_path"] = str(missing_raw_path)
        cases.append(("API-only missing raw evidence", broken, "raw_evidence: must be a non-empty list"))
        broken = copy.deepcopy(suspected_payload)
        broken["accounts"].append({
            "platform_key": "youtube", "subplatform": "", "subplatform_entry_id": "",
            "url": "https://www.youtube.com/@fixturesecond", "handle": "@fixturesecond",
            "status": "suspected_homepage", "identity_basis": "第二个疑似主页，自测应被拒绝。",
            "source_urls": ["https://www.youtube.com/@fixturesecond"],
        })
        cases.append((
            "automatic suspected homepage lacks final candidate evidence",
            broken,
            "non-user-supplied account must appear as account_candidate",
        ))
        broken = copy.deepcopy(suspected_payload)
        broken["platforms"]["youtube"]["delivery_modules"]["homepage"]["url_identity_statuses"][
            "https://www.youtube.com/@fixturevalid"
        ] = "confirmed"
        cases.append(("suspected homepage identity map mismatch", broken, "must match delivered account statuses"))
        broken = copy.deepcopy(suspected_payload)
        second_supplied_url = "https://www.youtube.com/@fixturesecondsupplied"
        broken["subject"]["user_supplied_homepages"].append({
            "platform_key": "youtube", "subplatform": "",
            "input_url": second_supplied_url, "canonical_url": second_supplied_url,
            "canonicalization_route_id": "",
        })
        broken["accounts"].append({
            "platform_key": "youtube", "subplatform": "", "subplatform_entry_id": "",
            "url": second_supplied_url, "handle": "@fixturesecondsupplied",
            "status": "suspected_homepage", "identity_basis": "第二个用户提供主页。",
            "source_urls": [second_supplied_url],
        })
        broken["coverage"]["source_inventory"].append(second_supplied_url)
        reversed_homepage = broken["platforms"]["youtube"]["delivery_modules"]["homepage"]
        first_supplied_url = "https://www.youtube.com/@fixturevalid"
        reversed_homepage["urls"] = [second_supplied_url, first_supplied_url]
        reversed_homepage["url_identity_statuses"] = {
            second_supplied_url: "suspected", first_supplied_url: "suspected",
        }
        reversed_homepage["url_risk_group_ids"] = {
            second_supplied_url: [], first_supplied_url: ["risk-001"],
        }
        cases.append((
            "multiple user-supplied suspected homepages are reversed before delivery",
            broken,
            "must preserve user-supplied suspected-page order",
        ))
        broken = copy.deepcopy(suspected_payload)
        broken["risk_groups"][0]["instances"][0]["finding"] = "视频包含一项需评估内容。"
        cases.append(("suspected homepage risk loses attribution boundary", broken, "must begin with '该疑似主页账号'"))
        broken = copy.deepcopy(suspected_payload)
        broken["risk_groups"][0]["summary"] = "公开内容存在一项需评估事项。"
        cases.append(("suspected homepage summary loses attribution boundary", broken, "summary: suspected-homepage risk must contain '疑似主页'"))
        broken = copy.deepcopy(suspected_payload)
        broken["risk_groups"][0]["explanation"] = "该事项用于验证交接结构。"
        cases.append(("suspected homepage explanation loses attribution boundary", broken, "explanation: suspected-homepage risk must contain '疑似主页'"))
        broken = copy.deepcopy(suspected_payload)
        broken["verdict"]["overall_conclusion"] = "发现一项需评估内容。"
        cases.append(("suspected homepage verdict loses attribution boundary", broken, "overall_conclusion: payload with suspected-homepage risk must contain '疑似主页'"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["netease_music"]["delivery_modules"]["keyword_search"]["url"] = "https://music.163.com/#/user/home?id=1"
        cases.append(("NetEase homepage cannot replace keyword search", broken, "NetEase Music search URL requires"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["instagram"]["delivery_modules"]["keyword_search"]["url"] = "https://www.instagram.com/fixturevalid/"
        cases.append(("Instagram homepage cannot replace keyword search", broken, "Instagram search URL requires"))
        broken = copy.deepcopy(payload)
        broken["accounts"][0]["status"] = "unconfirmed_candidate"
        cases.append(("user-supplied homepage is not delivered", broken, "must be confirmed or suspected_homepage"))
        broken = copy.deepcopy(payload)
        unrelated_input = "https://www.skland.com/profile?id=999999999"
        broken["subject"]["user_supplied_homepages"][0]["input_url"] = unrelated_input
        broken["coverage"]["source_inventory"].append(unrelated_input)
        broken["accounts"][0]["source_urls"].append(unrelated_input)
        cases.append((
            "user-supplied homepage is substituted by unrelated canonical URL",
            broken,
            "must itself belong to the declared platform or one of its controlled short-link hosts",
        ))
        broken = copy.deepcopy(payload)
        canonicalization_route_id = broken["subject"]["user_supplied_homepages"][0][
            "canonicalization_route_id"
        ]
        canonicalization_route = next(
            route for route in fixture_routes(broken)
            if route["route_id"] == canonicalization_route_id
        )
        canonicalization_route["resolved_url"] = "https://www.youtube.com/@wrongaccount"
        cases.append((
            "user-supplied homepage canonicalization resolves to a different account",
            broken,
            "route resolved_url must equal canonical_url",
        ))
        broken = copy.deepcopy(payload)
        broken["schema_version"] = "1.3"
        cases.append(("old schema", broken, "schema_version"))
        broken = copy.deepcopy(payload)
        broken["schema_version"] = "1.8"
        cases.append(("schema 1.8 requires genuine migration", broken, "1.8 is explicitly rejected"))
        broken = copy.deepcopy(payload)
        broken["schema_version"] = "1.9"
        cases.append(("schema 1.9 requires genuine migration", broken, "1.9 is explicitly rejected"))
        broken = copy.deepcopy(payload)
        broken["coverage"].pop("native_search_sentinel_groups")
        cases.append((
            "missing native search sentinel groups",
            broken,
            "missing fields: native_search_sentinel_groups",
        ))
        broken = copy.deepcopy(payload)
        broken["coverage"]["aliases_checked"].remove("@fixturevalid")
        cases.append((
            "delivered account handle missing from identity queries",
            broken,
            "every non-empty confirmed/suspected homepage handle",
        ))
        broken = copy.deepcopy(payload)
        duplicate_source = broken["platforms"]["weibo"]["research_completion"]["route_results"][0]
        duplicate_target = broken["platforms"]["bilibili"]["research_completion"]["route_results"][0]
        duplicate_target["route_id"] = duplicate_source["route_id"]
        cases.append(("route id reused across platforms", broken, "must be globally unique"))
        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["bilibili"]["research_completion"]["route_results"][0]
        route0["serial_route_index"] -= 1
        cases.append(("global serial route index duplicated", broken, "without gaps"))
        broken = copy.deepcopy(payload)
        ordered_routes = sorted(fixture_routes(broken), key=lambda item: item["serial_route_index"])
        ordered_routes[1]["started_at"] = ordered_routes[0]["started_at"]
        cases.append((
            "same interactive-browser page routes overlap",
            broken,
            "interactive-browser routes sharing one edge_page_continuity_id must not overlap",
        ))
        broken = copy.deepcopy(payload)
        final_route = max(fixture_routes(broken), key=lambda item: item["serial_route_index"])
        final_route["linear_pass_index"] = 0
        cases.append((
            "non-discovery route is mislabeled as discovery wave zero",
            broken,
            "discovery wave 0 is reserved for account_discovery",
        ))
        broken = copy.deepcopy(payload)
        for route in fixture_routes(broken):
            route["linear_pass_index"] = 1
        cases.append((
            "required discovery prepass missing",
            broken,
            "must include at least one discovery prepass route with value 0",
        ))
        broken = copy.deepcopy(payload)
        broken["coverage"]["pending_cross_platform_leads"] = [{
            "platform_key": "weibo",
            "url": "https://weibo.com/u/pending",
        }]
        cases.append((
            "pending cross-platform lead remains",
            broken,
            "pending_cross_platform_leads: must be empty before final delivery",
        ))
        broken = copy.deepcopy(payload)
        prepass_route = next(
            route for route in broken["platforms"]["weibo"]["research_completion"]["route_results"]
            if route["linear_pass_index"] == 0 and route["surface"] == "account_discovery"
        )
        vanished_candidate_url = "https://weibo.com/u/987654321"
        vanished_candidate = {
            "platform_key": "weibo", "surface": "account_discovery",
            "query_or_account_urls": [prepass_route["account_or_query_url"]],
            "item_id": "prepass-vanished-candidate", "url": vanished_candidate_url,
            "item_kind": "account_candidate", "content_type": "account_candidate",
            "author": "测试对象", "published_at": "", "title": "", "text": "同名候选",
            "media_kinds": ["none"],
            "media_review_status": "not_applicable",
            "subject_interaction_review_status": "not_applicable",
            "review_status": "reviewed", "risk_decision": "no_risk", "risk_group_id": "",
            "identity_candidate": {
                "candidate_platform_key": "weibo", "candidate_subplatform": "",
                "name_match": "exact_display_name", "all_platform_name_claim": False,
                "anchor_strengths": {name: "none" for name in CANDIDATE_ANCHOR_NAMES},
                "explicit_identity_conflict": False, "similarity_score": 100,
                "evidence_urls": [],
            },
        }
        vanished_ledger = Path(temp_dir) / "prepass-vanished-candidate.jsonl"
        vanished_ledger.write_text(json.dumps(vanished_candidate, ensure_ascii=False) + "\n", encoding="utf-8")
        prepass_route["item_ledger_path"] = str(vanished_ledger)
        prepass_route["item_ledger_sha256"] = _sha256(vanished_ledger)
        prepass_route["discovered_items"] = 1
        prepass_route["reviewed_items"] = 1
        prepass_route["termination"] = "natural_end"
        prepass_log = json.loads(Path(prepass_route["result_log_path"]).read_text(encoding="utf-8"))
        prepass_log["item_ledger_sha256"] = prepass_route["item_ledger_sha256"]
        prepass_log["discovered_items"] = 1
        prepass_log["reviewed_items"] = 1
        prepass_log["termination"] = "natural_end"
        vanished_log = Path(temp_dir) / "prepass-vanished-candidate-status.json"
        vanished_log.write_text(json.dumps(prepass_log, ensure_ascii=False) + "\n", encoding="utf-8")
        prepass_route["result_log_path"] = str(vanished_log)
        cases.append((
            "earlier-pass account candidate vanishes before final ranking",
            broken,
            "must be re-evaluated in a completed final reconciliation-cycle ledger",
        ))
        broken = copy.deepcopy(payload)
        mislabeled_discovery_route = next(
            route for route in broken["platforms"]["weibo"]["research_completion"]["route_results"]
            if route["linear_pass_index"] == 0 and route["surface"] == "account_discovery"
        )
        mislabeled_discovery_row = {
            "platform_key": "weibo", "surface": "account_discovery",
            "query_or_account_urls": [mislabeled_discovery_route["account_or_query_url"]],
            "item_id": "mislabeled-discovered-account", "url": "https://weibo.com/u/987654320",
            "item_kind": "content", "content_type": "profile",
            "author": "测试对象", "published_at": "", "title": "", "text": "同名账号结果",
            "media_kinds": ["none"],
            "media_review_status": "not_applicable",
            "subject_interaction_review_status": "not_applicable",
            "review_status": "reviewed", "risk_decision": "no_risk", "risk_group_id": "",
        }
        mislabeled_discovery_ledger = Path(temp_dir) / "mislabeled-discovered-account.jsonl"
        mislabeled_discovery_ledger.write_text(
            json.dumps(mislabeled_discovery_row, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        mislabeled_discovery_route.update({
            "discovered_items": 1, "reviewed_items": 1,
            "item_ledger_path": str(mislabeled_discovery_ledger),
            "item_ledger_sha256": _sha256(mislabeled_discovery_ledger),
            "termination": "natural_end",
        })
        mislabeled_discovery_log = json.loads(
            Path(mislabeled_discovery_route["result_log_path"]).read_text(encoding="utf-8")
        )
        mislabeled_discovery_log.update({
            "discovered_items": 1, "reviewed_items": 1,
            "item_ledger_sha256": mislabeled_discovery_route["item_ledger_sha256"],
            "termination": "natural_end",
        })
        mislabeled_discovery_log_path = Path(temp_dir) / "mislabeled-discovered-account-status.json"
        mislabeled_discovery_log_path.write_text(
            json.dumps(mislabeled_discovery_log, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        mislabeled_discovery_route["result_log_path"] = str(mislabeled_discovery_log_path)
        cases.append((
            "account discovery result is mislabeled as ordinary content",
            broken,
            "account_discovery rows must be account_candidate",
        ))
        broken = copy.deepcopy(payload)
        blocked_prepass = next(
            route for route in broken["platforms"]["weibo"]["research_completion"]["route_results"]
            if route["linear_pass_index"] == 0 and route["surface"] == "account_discovery"
        )
        completed_discovery = next(
            route for route in broken["platforms"]["weibo"]["research_completion"]["route_results"]
            if route["linear_pass_index"] == 1
            and route["module_key"] == "homepage"
            and route["surface"] == "account_discovery"
            and route["tool_kind"] in INTERACTIVE_BROWSER_TOOL_KINDS
        )
        blocked_candidate_url = "https://weibo.com/u/987654322"
        blocked_candidate = {
            "platform_key": "weibo", "surface": "account_discovery",
            "query_or_account_urls": [blocked_prepass["account_or_query_url"]],
            "item_id": "blocked-route-vanished-candidate", "url": blocked_candidate_url,
            "item_kind": "account_candidate", "content_type": "account_candidate",
            "author": "测试对象", "published_at": "", "title": "", "text": "同名候选",
            "media_kinds": ["none"],
            "media_review_status": "not_applicable",
            "subject_interaction_review_status": "not_applicable",
            "review_status": "reviewed", "risk_decision": "no_risk", "risk_group_id": "",
            "identity_candidate": {
                "candidate_platform_key": "weibo", "candidate_subplatform": "",
                "name_match": "exact_display_name", "all_platform_name_claim": False,
                "anchor_strengths": {name: "none" for name in CANDIDATE_ANCHOR_NAMES},
                "explicit_identity_conflict": False, "similarity_score": 100,
                "evidence_urls": [],
            },
        }
        blocked_candidate_ledger = Path(temp_dir) / "blocked-route-vanished-candidate.jsonl"
        blocked_candidate_ledger.write_text(
            json.dumps(blocked_candidate, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        blocked_prepass.update({
            "status": "blocked", "termination": "timeout",
            "boundary": "公开页面在已复核候选后超时。",
            "discovered_items": 1, "reviewed_items": 1, "unreviewed_items": 0,
            "item_ledger_path": str(blocked_candidate_ledger),
            "item_ledger_sha256": _sha256(blocked_candidate_ledger),
            "resolved_by_route_ids": [completed_discovery["route_id"]],
        })
        blocked_prepass_log = json.loads(
            Path(blocked_prepass["result_log_path"]).read_text(encoding="utf-8")
        )
        blocked_prepass_log.update({
            "status": "blocked", "termination": "timeout",
            "boundary": blocked_prepass["boundary"],
            "discovered_items": 1, "reviewed_items": 1, "unreviewed_items": 0,
            "item_ledger_sha256": blocked_prepass["item_ledger_sha256"],
            "resolved_by_route_ids": [completed_discovery["route_id"]],
        })
        blocked_candidate_log = Path(temp_dir) / "blocked-route-vanished-candidate-status.json"
        blocked_candidate_log.write_text(
            json.dumps(blocked_prepass_log, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        blocked_prepass["result_log_path"] = str(blocked_candidate_log)
        cases.append((
            "reviewed candidate in a non-login blocked route vanishes before final ranking",
            broken,
            "must be re-evaluated in a completed final reconciliation-cycle ledger",
        ))
        broken = copy.deepcopy(payload)
        preflight_data = json.loads(
            Path(broken["coverage"]["network_preflight"]["log_path"]).read_text(encoding="utf-8")
        )
        overseas_browser = next(
            check for check in preflight_data["checks"]
            if check["route"] == "browser_session" and check["family"] == "overseas"
        )
        overseas_browser["completed_at"] = "2026-09-02T09:00:01+08:00"
        delayed_preflight = Path(temp_dir) / "delayed-network-preflight.json"
        delayed_preflight.write_text(
            json.dumps(preflight_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        broken["coverage"]["network_preflight"]["log_path"] = str(delayed_preflight)
        cases.append((
            "preflight overlaps first research route",
            broken,
            "must finish before any research interactive-browser route starts",
        ))
        broken = copy.deepcopy(payload)
        del broken["subject"]["category"]
        cases.append(("missing delivery category", broken, "subject: missing fields: category"))
        broken = copy.deepcopy(payload)
        broken["subject"]["report_date"] = "2026-02-30"
        cases.append(("invalid report date", broken, "must be a real ISO"))
        broken = copy.deepcopy(payload)
        broken["subject"]["basic_info_source_urls"] = ["https://source.example.test/missing"]
        cases.append(("basic info source absent from inventory", broken, "URLs missing from coverage.source_inventory"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["weibo"]["conclusion"] = "无问题"
        cases.append(("redundant platform conclusion", broken, "unexpected/redundant"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["weibo"]["findings"] = ["free narrative"]
        cases.append(("redundant free platform findings", broken, "unexpected/redundant"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["facebook"]["delivery_modules"]["keyword_search"]["result_status"] = "no_risk"
        broken["platforms"]["facebook"]["discovery_status"] = "related_content_only"
        cases.append(("no_risk search without reviewed relevant item", broken, "requires at least one reviewed no_risk item"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["facebook"]["delivery_modules"]["keyword_search"]["result_status"] = "access_blocked"
        cases.append(("blocked search promoted to final", broken, "invalid final result"))
        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["x"]["research_completion"]["route_results"][0]
        route0["termination"] = "max_pages"
        cases.append(("fixed cap promoted to complete", broken, "not a verified natural end"))
        broken = copy.deepcopy(payload)
        route0 = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route.get("status") == "complete" and route.get("discovered_items", 0) > 0
        )
        route0["reviewed_items"] = 0
        cases.append(("discovered reviewed mismatch", broken, "discovered_items must equal"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["xiaohongshu"]["research_completion"]["status"] = "blocked_unresolved"
        cases.append(("unfinished platform", broken, "requires complete"))
        broken = copy.deepcopy(payload)
        broken["coverage"]["search_engines_checked"] = ["baidu"]
        cases.append(("missing google", broken, "must include baidu and google"))
        broken = copy.deepcopy(payload)
        broken["coverage"]["source_inventory"].append("https://example.com/placeholder-source")
        cases.append(("placeholder in source inventory", broken, "real non-placeholder http(s) URL"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["youtube"]["delivery_modules"]["homepage"]["risk_group_ids"] = []
        cases.append(("risk missing module link", broken, "missing module cross-link"))
        broken = copy.deepcopy(payload)
        broken["coverage"]["network_preflight"]["direct_https_reachable"] = False
        broken["coverage"]["network_preflight"]["browser_session_reachable"] = False
        broken["coverage"]["network_preflight"]["domestic_route_reachable"] = False
        broken["coverage"]["network_preflight"]["overseas_route_reachable"] = False
        cases.append(("no network route", broken, "no working domestic route"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["facebook"]["research_completion"]["unreviewed_relevant_hits"] = 1
        cases.append(("unreviewed relevant hit", broken, "must equal 0"))
        broken = copy.deepcopy(payload)
        broken["coverage"]["access_boundaries"] = []
        cases.append(("redundant boundary summary", broken, "unexpected/redundant"))
        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        route0["tool_kind"] = "local_script"
        cases.append(("local script without path and hash", broken, "local_script requires"))
        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        original_log = json.loads(Path(route0["result_log_path"]).read_text(encoding="utf-8"))
        original_log["termination"] = "login_wall"
        bad_log = Path(temp_dir) / "forged-route-status.json"
        bad_log.write_text(json.dumps(original_log, ensure_ascii=False) + "\n", encoding="utf-8")
        route0["result_log_path"] = str(bad_log)
        cases.append(("route log contradicts payload", broken, "must exactly match route_results"))
        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        blocked_raw = Path(temp_dir) / "blocked-raw-status.json"
        blocked_raw.write_text('{"status":"blocked","stop_reason":"login_wall","exit_code":2}\n', encoding="utf-8")
        blocked_log_data = json.loads(Path(route0["result_log_path"]).read_text(encoding="utf-8"))
        blocked_log_data["raw_evidence"] = [{
            "path": str(blocked_raw), "sha256": _sha256(blocked_raw), "kind": "collector_status",
        }]
        blocked_log = Path(temp_dir) / "blocked-raw-route-status.json"
        blocked_log.write_text(json.dumps(blocked_log_data, ensure_ascii=False) + "\n", encoding="utf-8")
        route0["result_log_path"] = str(blocked_log)
        cases.append(("blocked raw evidence promoted to complete", broken, "raw evidence contains unfinished state"))
        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["bilibili"]["research_completion"]["route_results"][0]
        route0["surface"] = "homepage_timeline"
        cases.append(("generic homepage route replaces required surface", broken, ".surface: must be one of"))
        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        route0["boundary"] = "login wall remained"
        cases.append(("complete route retains boundary", broken, "completed route must be empty"))
        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        route0["authorization_status"] = "permission_missing"
        cases.append(("permission missing promoted to complete", broken, "permission_missing blocks completion"))
        broken = copy.deepcopy(payload)
        official_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["tool_kind"] == "official_api"
        )
        official_route["authorization_evidence"] = None
        cases.append(("official route without authorization evidence", broken, "requires hashed authorization evidence"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["youtube"]["research_completion"]["negative_conclusion_eligible"] = False
        cases.append(("removed redundant negative gate", broken, "unexpected/redundant"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["youtube"]["delivery_modules"]["homepage"]["url_risk_group_ids"] = {
            "https://www.youtube.com/@fixturevalid": []
        }
        cases.append(("homepage URL loses its risk mapping", broken, "must equal union of url_risk_group_ids"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["facebook"]["discovery_status"] = "confirmed_account"
        cases.append(("free-form discovery status", broken, "expected no_account_after_multiroute_search"))
        broken = copy.deepcopy(payload)
        broken["accounts"].append({
            "platform_key": "domestic_other", "subplatform": "GhostPlatform",
            "subplatform_entry_id": "ghost", "url": "https://ghost.example.test/profile",
            "handle": "ghost", "status": "confirmed", "identity_basis": "fixture",
            "source_urls": ["https://ghost.example.test/profile"],
        })
        cases.append(("orphan confirmed extra-platform account", broken, "has no matching platforms.domestic_other.subplatforms entry"))
        broken = copy.deepcopy(payload)
        broken["accounts"].append({
            "platform_key": "facebook", "subplatform": "Facebook", "subplatform_entry_id": "candidate",
            "url": "https://www.facebook.com/fixturecandidate", "handle": "fixturecandidate",
            "status": "unconfirmed_candidate", "identity_basis": "fixture candidate",
            "source_urls": ["https://www.facebook.com/fixturecandidate"],
        })
        cases.append(("named-platform candidate uses extra fields", broken, "named platform account must leave this empty"))
        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        route0["status"] = "blocked"
        route0["termination"] = "login_wall"
        route0["boundary"] = "login wall"
        route0["resolved_by_route_ids"] = []
        cases.append(("blocked route lacks equivalent resolver", broken, "final handoff requires an equivalent completed resolver"))
        broken = copy.deepcopy(payload)
        route0 = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["module_key"] == "keyword_search"
        )
        query_lines = Path(route0["query_ledger_path"]).read_text(encoding="utf-8").splitlines()
        incomplete_query = Path(temp_dir) / "incomplete-query-ledger.jsonl"
        incomplete_query.write_text("\n".join(query_lines[:-1]) + "\n", encoding="utf-8")
        route0["query_ledger_path"] = str(incomplete_query)
        route0["query_ledger_sha256"] = _sha256(incomplete_query)
        query_log_data = json.loads(Path(route0["result_log_path"]).read_text(encoding="utf-8"))
        query_log_data["query_ledger_sha256"] = route0["query_ledger_sha256"]
        incomplete_query_log = Path(temp_dir) / "incomplete-query-route-status.json"
        incomplete_query_log.write_text(json.dumps(query_log_data, ensure_ascii=False) + "\n", encoding="utf-8")
        route0["result_log_path"] = str(incomplete_query_log)
        cases.append(("query Cartesian product incomplete", broken, "missing alias/keyword_group combinations"))
        broken = copy.deepcopy(payload)
        broken["platforms"]["bilibili"]["delivery_modules"]["keyword_search"]["url"] = "https://www.youtube.com/results?search_query=fixturevalid"
        cases.append(("wrong platform search domain", broken, "host does not belong to B站"))
        broken = copy.deepcopy(payload)
        search_routes = [
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["module_key"] == "keyword_search" and route["surface"] == "native_search"
        ]
        first, second = search_routes[:2]
        for field in (
            "route_family", "evidence_origin", "evidence_fingerprint", "tool_kind", "tool_path",
            "tool_sha256", "official_product", "official_endpoint", "authorization_status",
            "authorization_evidence",
        ):
            second[field] = copy.deepcopy(first[field])
        cases.append(("two labels reuse one upstream and evidence", broken, "requires two independent completed routes"))
        broken = copy.deepcopy(payload)
        route0 = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["module_key"] == "keyword_search"
        )
        query_rows = [json.loads(line) for line in Path(route0["query_ledger_path"]).read_text(encoding="utf-8").splitlines() if line.strip()]
        displayed_query_row = next(
            row for row in query_rows if row["query_url"] == route0["account_or_query_url"]
        )
        displayed_query_row["query_url"] = f"{displayed_query_row['query_url']}&replaced=1"
        missing_display_query = Path(temp_dir) / "missing-displayed-query.jsonl"
        missing_display_query.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in query_rows), encoding="utf-8",
        )
        route0["query_ledger_path"] = str(missing_display_query)
        route0["query_ledger_sha256"] = _sha256(missing_display_query)
        query_log = json.loads(Path(route0["result_log_path"]).read_text(encoding="utf-8"))
        query_log["query_ledger_sha256"] = route0["query_ledger_sha256"]
        missing_display_log = Path(temp_dir) / "missing-displayed-query-status.json"
        missing_display_log.write_text(json.dumps(query_log, ensure_ascii=False) + "\n", encoding="utf-8")
        route0["result_log_path"] = str(missing_display_log)
        cases.append(("displayed search URL absent from query ledger", broken, "displayed Chapter 4 search URL"))
        broken = copy.deepcopy(payload)
        route0 = next(
            route for route in broken["platforms"]["instagram"]["research_completion"]["route_results"]
            if route["module_key"] == "keyword_search"
        )
        query_rows = [
            json.loads(line)
            for line in Path(route0["query_ledger_path"]).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        query_rows[1]["query_text"] = "fixturevalid unrelated"
        unrelated_query = Path(temp_dir) / "unrelated-search-text.jsonl"
        unrelated_query.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in query_rows), encoding="utf-8",
        )
        route0["query_ledger_path"] = str(unrelated_query)
        route0["query_ledger_sha256"] = _sha256(unrelated_query)
        query_log = json.loads(Path(route0["result_log_path"]).read_text(encoding="utf-8"))
        query_log["query_ledger_sha256"] = route0["query_ledger_sha256"]
        unrelated_query_log = Path(temp_dir) / "unrelated-search-text-status.json"
        unrelated_query_log.write_text(json.dumps(query_log, ensure_ascii=False) + "\n", encoding="utf-8")
        route0["result_log_path"] = str(unrelated_query_log)
        cases.append((
            "query ledger label does not match submitted search text",
            broken,
            "must equal the canonical submitted query",
        ))
        broken = copy.deepcopy(payload)
        route0 = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["module_key"] == "keyword_search"
            and route["surface"] == "native_search"
            and route["tool_kind"] in INTERACTIVE_BROWSER_TOOL_KINDS
        )
        query_rows = [
            json.loads(line)
            for line in Path(route0["query_ledger_path"]).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        displayed_query_row = next(
            row for row in query_rows if row["query_url"] == route0["account_or_query_url"]
        )
        displayed_query_row.update({
            "termination": "natural_end", "discovered_items": 1,
            "reviewed_items": 1, "unreviewed_items": 0,
        })
        hidden_candidate_query_ledger = Path(temp_dir) / "hidden-search-candidate-queries.jsonl"
        hidden_candidate_query_ledger.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in query_rows),
            encoding="utf-8",
        )
        hidden_candidate_item = {
            "platform_key": "youtube", "surface": "native_search",
            "query_or_account_urls": [displayed_query_row["query_url"]],
            "item_id": "hidden-search-account", "url": "https://www.youtube.com/@fixturehidden",
            "item_kind": "content", "content_type": "profile", "author": "测试对象",
            "published_at": "", "title": "", "text": "站内搜索返回同名频道主页。",
            "media_kinds": ["none"],
            "media_review_status": "not_applicable",
            "subject_interaction_review_status": "not_applicable",
            "review_status": "reviewed", "risk_decision": "no_risk", "risk_group_id": "",
        }
        hidden_candidate_item_ledger = Path(temp_dir) / "hidden-search-candidate-items.jsonl"
        hidden_candidate_item_ledger.write_text(
            json.dumps(hidden_candidate_item, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        route0.update({
            "query_ledger_path": str(hidden_candidate_query_ledger),
            "query_ledger_sha256": _sha256(hidden_candidate_query_ledger),
            "item_ledger_path": str(hidden_candidate_item_ledger),
            "item_ledger_sha256": _sha256(hidden_candidate_item_ledger),
            "discovered_items": 1, "reviewed_items": 1, "unreviewed_items": 0,
            "termination": "natural_end",
        })
        hidden_candidate_log = json.loads(Path(route0["result_log_path"]).read_text(encoding="utf-8"))
        hidden_candidate_log.update({
            "query_ledger_sha256": route0["query_ledger_sha256"],
            "item_ledger_sha256": route0["item_ledger_sha256"],
            "discovered_items": 1, "reviewed_items": 1, "unreviewed_items": 0,
            "termination": "natural_end",
        })
        hidden_candidate_log_path = Path(temp_dir) / "hidden-search-candidate-status.json"
        hidden_candidate_log_path.write_text(
            json.dumps(hidden_candidate_log, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        route0["result_log_path"] = str(hidden_candidate_log_path)
        cases.append((
            "platform search account result is mislabeled as ordinary content",
            broken,
            "account/profile/channel search results and account-homepage URLs must be account_candidate",
        ))
        broken = copy.deepcopy(payload)
        youtube_search = broken["platforms"]["youtube"]["delivery_modules"]["keyword_search"]
        youtube_search["result_status"] = "risk"
        youtube_search["risk_group_ids"] = ["risk-001"]
        broken["platforms"]["youtube"]["risk_group_ids"] = ["risk-001"]
        broken["risk_groups"][0]["instances"][0]["module_targets"].append({
            "module_key": "keyword_search", "module_url": youtube_search["url"],
        })
        cases.append(("risk target absent from its route ledger", broken, "risk instance target is absent from its reviewed route ledger"))
        broken = copy.deepcopy(payload)
        preflight_data = json.loads(Path(broken["coverage"]["network_preflight"]["log_path"]).read_text(encoding="utf-8"))
        preflight_data["checks"][1]["evidence_path"] = str(Path(temp_dir) / "missing-browser.png")
        bad_preflight = Path(temp_dir) / "missing-browser-preflight.json"
        bad_preflight.write_text(json.dumps(preflight_data, ensure_ascii=False) + "\n", encoding="utf-8")
        broken["coverage"]["network_preflight"]["log_path"] = str(bad_preflight)
        cases.append(("browser reachability without evidence file", broken, "evidence_path: file does not exist"))
        broken = copy.deepcopy(payload)
        preflight_data = json.loads(Path(broken["coverage"]["network_preflight"]["log_path"]).read_text(encoding="utf-8"))
        browser_check = preflight_data["checks"][1]
        manifest_data = json.loads(Path(browser_check["evidence_path"]).read_text(encoding="utf-8"))
        manifest_data["url"] = "https://example.test/not-the-checked-url"
        wrong_url_manifest = Path(temp_dir) / "wrong-url-browser-evidence.json"
        wrong_url_manifest.write_text(json.dumps(manifest_data) + "\n", encoding="utf-8")
        browser_check["evidence_path"] = str(wrong_url_manifest)
        browser_check["evidence_sha256"] = _sha256(wrong_url_manifest)
        bad_preflight = Path(temp_dir) / "wrong-url-browser-preflight.json"
        bad_preflight.write_text(json.dumps(preflight_data, ensure_ascii=False) + "\n", encoding="utf-8")
        broken["coverage"]["network_preflight"]["log_path"] = str(bad_preflight)
        cases.append(("browser manifest URL contradicts check", broken, ".url: must exactly match the browser check"))

        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        route0["tool_kind"] = "manual_visible_browser"
        cases.append(("uncontrolled legacy browser tool kind", broken, ".tool_kind: invalid tool kind"))

        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        route0["tool_kind"] = "hosted_browser"
        cases.append(("uncontrolled hosted browser tool kind", broken, ".tool_kind: invalid tool kind"))

        for actual_browser_name in (
            "Chromium",
            "Microsoft Edge",
            "Microsoft Edge Stable",
            "Google Chrome",
            "Google Chrome Stable",
        ):
            arbitrary_browser_name = copy.deepcopy(payload)
            arbitrary_browser_route = next(
                route
                for route in arbitrary_browser_name["platforms"]["youtube"]["research_completion"]["route_results"]
                if route["tool_kind"] == "browser_ui"
            )
            arbitrary_browser_route["tool_name"] = actual_browser_name
            arbitrary_browser_errors = validate(arbitrary_browser_name, check_files=True)
            if arbitrary_browser_errors:
                print(f"SELF-TEST browser_ui persistent product name unexpectedly failed: {actual_browser_name}")
                print("\n".join(arbitrary_browser_errors))
                return 1

        for rejected_browser_name in (
            "Codex built-in browser",
            "in_app",
            "IABBrowser",
            "HeadlessChrome",
            "HostedChrome",
            "TemporaryChrome",
            "HeadlessFirefox",
        ):
            broken = copy.deepcopy(payload)
            route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
            route0["tool_name"] = rejected_browser_name
            cases.append((
                f"browser_ui rejects non-persistent identity {rejected_browser_name}",
                broken,
                ".tool_name: browser_ui must use a persistent desktop browser",
            ))

        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        route0["authorization_status"] = "not_required_manual_visible"
        cases.append(("legacy manual browser authorization", broken, "legacy not_required_manual_visible is forbidden"))

        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        route0["route_family"] = "manual_visible_surface"
        cases.append(("uncontrolled browser route family", broken, "invalid controlled route family"))

        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        route0["edge_evidence_path"] = None
        route0["edge_evidence_sha256"] = None
        cases.append(("browser route without evidence", broken, "interactive-browser route requires a path"))

        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        edge_manifest_data = json.loads(Path(route0["edge_evidence_path"]).read_text(encoding="utf-8"))
        edge_manifest_data["browser_family"] = ""
        non_edge_manifest = Path(temp_dir) / "unnamed-browser-route-evidence.json"
        non_edge_manifest.write_text(json.dumps(edge_manifest_data) + "\n", encoding="utf-8")
        route0["edge_evidence_path"] = str(non_edge_manifest)
        route0["edge_evidence_sha256"] = _sha256(non_edge_manifest)
        cases.append((
            "browser route evidence omits actual family", broken,
            ".browser_family: browser_ui route must name the actual persistent desktop browser family",
        ))

        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        edge_manifest_data = json.loads(Path(route0["edge_evidence_path"]).read_text(encoding="utf-8"))
        edge_manifest_data["browser_family"] = "hosted_browser"
        hosted_manifest = Path(temp_dir) / "hosted-browser-route-evidence.json"
        hosted_manifest.write_text(json.dumps(edge_manifest_data) + "\n", encoding="utf-8")
        route0["edge_evidence_path"] = str(hosted_manifest)
        route0["edge_evidence_sha256"] = _sha256(hosted_manifest)
        cases.append((
            "browser route evidence uses a hosted temporary browser",
            broken,
            ".browser_family: browser_ui must use a persistent desktop browser",
        ))

        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        edge_manifest_data = json.loads(Path(route0["edge_evidence_path"]).read_text(encoding="utf-8"))
        edge_manifest_data["window_mode"] = "hidden"
        hidden_edge_manifest = Path(temp_dir) / "hidden-edge-route-evidence.json"
        hidden_edge_manifest.write_text(json.dumps(edge_manifest_data) + "\n", encoding="utf-8")
        route0["edge_evidence_path"] = str(hidden_edge_manifest)
        route0["edge_evidence_sha256"] = _sha256(hidden_edge_manifest)
        cases.append(("route evidence uses hidden Edge", broken, ".window_mode: must equal visible"))

        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        edge_manifest_data = json.loads(Path(route0["edge_evidence_path"]).read_text(encoding="utf-8"))
        edge_manifest_data["artifact_kind"] = "browser_snapshot"
        snapshot_edge_manifest = Path(temp_dir) / "snapshot-edge-route-evidence.json"
        snapshot_edge_manifest.write_text(json.dumps(edge_manifest_data) + "\n", encoding="utf-8")
        route0["edge_evidence_path"] = str(snapshot_edge_manifest)
        route0["edge_evidence_sha256"] = _sha256(snapshot_edge_manifest)
        cases.append((
            "Edge route tries to use browser snapshot",
            broken,
            "browser_snapshot and JSON/HTML artifacts are forbidden",
        ))

        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        route0["edge_window_continuity_id"] = "edge-window-user@example.test"
        cases.append((
            "Edge continuity label is not an opaque UUID",
            broken,
            "must be a canonical lowercase UUIDv4",
        ))

        broken = copy.deepcopy(payload)
        official_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["tool_kind"] == "official_api"
        )
        official_route["edge_session_state"] = "public_visible"
        cases.append(("non-browser route carries browser state", broken, "non-browser route requires null"))

        broken = copy.deepcopy(payload)
        youtube_video_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["module_key"] == "homepage" and route["surface"] == "videos"
        )
        youtube_video_route["tool_kind"] = "official_api"
        cases.append(("API relabel lacks API authorization", broken, "official_api lacks applicable official authorization"))

        broken = copy.deepcopy(payload)
        facebook_native = next(
            route for route in broken["platforms"]["facebook"]["research_completion"]["route_results"]
            if route["module_key"] == "homepage"
            and route["surface"] == "account_discovery"
            and _is_platform_native_url("facebook", route["account_or_query_url"])
        )
        facebook_native["account_or_query_url"] = "https://www.google.com/search?q=fixturevalid-facebook"
        facebook_native["evidence_origin"] = facebook_native["account_or_query_url"]
        cases.append((
            "named platform not-found lacks native Edge discovery", broken,
            "platform-native permitted account_discovery route",
        ))

        broken = copy.deepcopy(login_payload)
        blocked_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["termination"] == "login_wall"
        )
        resolver_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["route_id"] == blocked_route["resolved_by_route_ids"][0]
        )
        resolver_route["tool_kind"] = "official_api"
        cases.append((
            "API/export cannot resolve login boundary",
            broken,
            "API/export cannot resolve the webpage boundary",
        ))

        broken = copy.deepcopy(login_payload)
        blocked_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["termination"] == "login_wall"
        )
        resolver_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["route_id"] == blocked_route["resolved_by_route_ids"][0]
        )
        resolver_route["edge_session_state"] = "public_visible"
        resolver_route["user_login_completed_at"] = None
        cases.append(("login wall resolver lacks user completion", broken, "must record edge_session_state=user_login_completed"))

        broken = copy.deepcopy(login_payload)
        blocked_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["termination"] == "login_wall"
        )
        resolver_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["route_id"] == blocked_route["resolved_by_route_ids"][0]
        )
        resolver_route["user_login_completed_at"] = "2026-09-02T09:00:00+08:00"
        cases.append(("user login predates login boundary", broken, "user login must complete after the login boundary"))

        broken = copy.deepcopy(login_payload)
        blocked_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["termination"] == "login_wall"
        )
        resolver_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["route_id"] == blocked_route["resolved_by_route_ids"][0]
        )
        resolver_route["edge_window_continuity_id"] = "00000000-0000-4000-8000-00000000ffff"
        cases.append((
            "login resolver switches Edge windows",
            broken,
            "must use the same edge_window_continuity_id",
        ))

        broken = copy.deepcopy(login_payload)
        blocked_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["termination"] == "login_wall"
        )
        resolver_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["route_id"] == blocked_route["resolved_by_route_ids"][0]
        )
        resolver_route["edge_page_continuity_id"] = "00000000-0000-4000-8000-00000000ffff"
        cases.append((
            "login resolver switches Edge pages",
            broken,
            "must use the same edge_page_continuity_id",
        ))

        broken = copy.deepcopy(login_payload)
        blocked_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["termination"] == "login_wall"
        )
        blocked_route["item_ledger_sha256"] = None
        cases.append((
            "login boundary omits hashed item ledger",
            broken,
            ".item_ledger_sha256: must be lowercase SHA-256",
        ))

        broken = copy.deepcopy(login_payload)
        blocked_route = next(
            route for route in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route["termination"] == "login_wall"
        )
        prelogin_rows = [
            json.loads(line)
            for line in Path(blocked_route["item_ledger_path"]).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        prelogin_rows[0]["item_id"] = "prelogin-only-item"
        prelogin_rows[0]["url"] = "https://www.youtube.com/watch?v=preloginonly123"
        prelogin_only_ledger = Path(temp_dir) / "login-boundary-prelogin-only-items.jsonl"
        prelogin_only_ledger.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in prelogin_rows),
            encoding="utf-8",
        )
        blocked_route["item_ledger_path"] = str(prelogin_only_ledger)
        blocked_route["item_ledger_sha256"] = _sha256(prelogin_only_ledger)
        blocked_log_data = json.loads(Path(blocked_route["result_log_path"]).read_text(encoding="utf-8"))
        blocked_log_data["item_ledger_sha256"] = blocked_route["item_ledger_sha256"]
        prelogin_only_log = Path(temp_dir) / "login-boundary-prelogin-only-status.json"
        prelogin_only_log.write_text(
            json.dumps(blocked_log_data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        blocked_route["result_log_path"] = str(prelogin_only_log)
        cases.append((
            "post-login traversal drops a pre-login item",
            broken,
            "surface_start ledger is missing pre-login item_id/URL pairs",
        ))

        broken = copy.deepcopy(payload)
        preflight_data = json.loads(
            Path(broken["coverage"]["network_preflight"]["log_path"]).read_text(encoding="utf-8")
        )
        browser_check = next(check for check in preflight_data["checks"] if check["route"] == "browser_session")
        browser_manifest_data = json.loads(
            Path(browser_check["evidence_path"]).read_text(encoding="utf-8")
        )
        browser_manifest_data["artifact_kind"] = "browser_snapshot"
        snapshot_browser_manifest = Path(temp_dir) / "snapshot-browser-reachability-evidence.json"
        snapshot_browser_manifest.write_text(
            json.dumps(browser_manifest_data, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        browser_check["evidence_path"] = str(snapshot_browser_manifest)
        browser_check["evidence_sha256"] = _sha256(snapshot_browser_manifest)
        snapshot_preflight = Path(temp_dir) / "snapshot-browser-preflight.json"
        snapshot_preflight.write_text(
            json.dumps(preflight_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        broken["coverage"]["network_preflight"]["log_path"] = str(snapshot_preflight)
        cases.append((
            "network preflight tries to use browser snapshot",
            broken,
            "browser_snapshot and JSON/HTML artifacts are forbidden",
        ))

        broken = copy.deepcopy(payload)
        route0 = broken["platforms"]["facebook"]["research_completion"]["route_results"][0]
        route0["started_at"] = (
            datetime.fromisoformat(route0["completed_at"]) + timedelta(seconds=1)
        ).isoformat()
        cases.append(("route timestamps reversed", broken, "started_at must not be after completed_at"))

        broken = copy.deepcopy(payload)
        preflight_data = json.loads(Path(broken["coverage"]["network_preflight"]["log_path"]).read_text(encoding="utf-8"))
        preflight_data["checks"] = [preflight_data["checks"][0]]
        direct_only_preflight = Path(temp_dir) / "direct-only-preflight.json"
        direct_only_preflight.write_text(json.dumps(preflight_data, ensure_ascii=False) + "\n", encoding="utf-8")
        broken["coverage"]["network_preflight"]["log_path"] = str(direct_only_preflight)
        cases.append(("direct HTTP promoted to preflight completion", broken, "must be derived from validated checks"))

        def video_row_negative_payload(tag: str, mutate: Any) -> dict[str, Any]:
            broken_video = copy.deepcopy(payload)
            video_route = next(
                route for route in fixture_routes(broken_video)
                if route.get("discovered_items") == 1
            )
            item_rows = [
                json.loads(line)
                for line in Path(video_route["item_ledger_path"]).read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            mutate(item_rows[0])
            item_path = Path(temp_dir) / f"video-negative-{tag}-items.jsonl"
            item_path.write_text(
                "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in item_rows),
                encoding="utf-8",
            )
            video_route["item_ledger_path"] = str(item_path)
            video_route["item_ledger_sha256"] = _sha256(item_path)
            log_data = json.loads(Path(video_route["result_log_path"]).read_text(encoding="utf-8"))
            log_data["item_ledger_sha256"] = video_route["item_ledger_sha256"]
            log_path = Path(temp_dir) / f"video-negative-{tag}-status.json"
            log_path.write_text(json.dumps(log_data, ensure_ascii=False) + "\n", encoding="utf-8")
            video_route["result_log_path"] = str(log_path)
            return broken_video

        def video_negative_payload(tag: str, mutate: Any) -> dict[str, Any]:
            return video_row_negative_payload(
                tag, lambda row: mutate(row["video_review_evidence"]),
            )

        def video_jsonl_negative_payload(
            tag: str,
            *,
            path_field: str,
            sha_field: str,
            mutate: Any,
        ) -> dict[str, Any]:
            def mutate_row(row: dict[str, Any]) -> None:
                evidence = row["video_review_evidence"]
                source_path = Path(evidence[path_field])
                artifact_rows = [
                    json.loads(line)
                    for line in source_path.read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
                mutate(artifact_rows)
                artifact_path = Path(temp_dir) / f"video-negative-{tag}.jsonl"
                artifact_path.write_text(
                    "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in artifact_rows),
                    encoding="utf-8",
                )
                evidence[path_field] = str(artifact_path)
                evidence[sha_field] = _sha256(artifact_path)

            return video_row_negative_payload(tag, mutate_row)

        def mutate_video_item_across_routes(
            source_fixture: dict[str, Any],
            tag: str,
            item_id: str,
            mutate: Any,
            *,
            max_routes: int | None = None,
        ) -> dict[str, Any]:
            """Mutate one stable video in one or all mirrored route ledgers."""
            broken_video = copy.deepcopy(source_fixture)
            changed_routes = 0
            for route_record in fixture_routes(broken_video):
                ledger_value = route_record.get("item_ledger_path")
                if not _is_nonempty_text(ledger_value):
                    continue
                source_path = Path(str(ledger_value))
                if not source_path.is_file():
                    continue
                item_rows = [
                    json.loads(line)
                    for line in source_path.read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
                matches = [row for row in item_rows if row.get("item_id") == item_id]
                if not matches:
                    continue
                for row in matches:
                    mutate(row, changed_routes)
                item_path = Path(temp_dir) / f"video-cross-route-{tag}-{changed_routes}-items.jsonl"
                item_path.write_text(
                    "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in item_rows),
                    encoding="utf-8",
                )
                route_record["item_ledger_path"] = str(item_path)
                route_record["item_ledger_sha256"] = _sha256(item_path)
                log_data = json.loads(
                    Path(route_record["result_log_path"]).read_text(encoding="utf-8")
                )
                log_data["item_ledger_sha256"] = route_record["item_ledger_sha256"]
                log_path = Path(temp_dir) / f"video-cross-route-{tag}-{changed_routes}-status.json"
                log_path.write_text(
                    json.dumps(log_data, ensure_ascii=False) + "\n", encoding="utf-8"
                )
                route_record["result_log_path"] = str(log_path)
                changed_routes += 1
                if max_routes is not None and changed_routes >= max_routes:
                    break
            if changed_routes == 0:
                raise AssertionError(f"self-test item not found: {item_id}")
            return broken_video

        cases.append((
            "video lacks full-audio coverage",
            video_negative_payload("audio", lambda evidence: evidence.update({"full_audio_coverage": False})),
            "full_audio_coverage: must be true",
        ))
        cases.append((
            "video sampling interval exceeds ten seconds",
            video_negative_payload("interval", lambda evidence: evidence.update({"max_sampling_interval_seconds": 11})),
            "max_sampling_interval_seconds: must be greater than 0 and at most 10",
        ))
        cases.append((
            "video hit has no contextual replay evidence",
            video_negative_payload("hit-context", lambda evidence: evidence["hits"].clear()),
            "every risk/false-positive/out-of-scope video decision requires hit evidence",
        ))
        cases.append((
            "video hit replay is shorter than fifteen seconds",
            video_negative_payload(
                "hit-short-context",
                lambda evidence: evidence["hits"][0].update({
                    "context_start_seconds": 20,
                    "context_end_seconds": 40,
                }),
            ),
            "preserve at least 15 seconds before the hit",
        ))
        cases.append((
            "video duration is NaN",
            video_negative_payload(
                "nan-duration", lambda evidence: evidence.update({"duration_seconds": float("nan")}),
            ),
            "duration_seconds: must be a positive number",
        ))
        cases.append((
            "video duration is infinite",
            video_negative_payload(
                "infinite-duration", lambda evidence: evidence.update({"duration_seconds": float("inf")}),
            ),
            "duration_seconds: must be a positive number",
        ))
        cases.append((
            "video content type contradicts media kinds",
            video_row_negative_payload(
                "content-type-media-kind-mismatch",
                lambda row: row.update({"media_kinds": ["animated_image"]}),
            ),
            "a video content_type or recognizable video URL must include video",
        ))

        def relabel_video_as_post(row: dict[str, Any]) -> None:
            row["content_type"] = "post"
            row["media_kinds"] = ["none"]
            row.pop("video_review_evidence", None)

        cases.append((
            "recognizable YouTube video is relabeled as a generic post",
            video_row_negative_payload("youtube-relabel-post", relabel_video_as_post),
            "requires detailed full-timeline evidence",
        ))

        def hide_video_on_video_only_surface(row: dict[str, Any]) -> None:
            row["url"] = "https://www.youtube.com/post/video-surface-fixture"
            row["content_type"] = "post"
            row["media_kinds"] = ["none"]
            row.pop("video_metadata", None)
            row.pop("video_review_evidence", None)
            row["review_evidence"].pop("video_triage", None)

        cases.append((
            "video-only surface row is relabeled as a generic post",
            video_row_negative_payload("video-surface-relabel", hide_video_on_video_only_surface),
            "video-only surface 'videos' must include video",
        ))

        def relabel_video_as_account_candidate(row: dict[str, Any]) -> None:
            row["item_kind"] = "account_candidate"
            row["content_type"] = "account_candidate"
            row["identity_candidate"] = {
                "candidate_platform_key": "youtube",
                "candidate_subplatform": "",
                "name_match": "exact_display_name",
                "all_platform_name_claim": False,
                "anchor_strengths": {name: "none" for name in CANDIDATE_ANCHOR_NAMES},
                "explicit_identity_conflict": False,
                "similarity_score": 100,
                "evidence_urls": [],
            }

        cases.append((
            "video URL is relabeled as an account candidate",
            video_row_negative_payload("video-as-account-candidate", relabel_video_as_account_candidate),
            "account_candidate URL must be an account-like homepage and not a video URL",
        ))
        cases.append((
            "real video omits detail-page metadata",
            video_row_negative_payload(
                "missing-video-metadata",
                lambda row: row.pop("video_metadata", None),
            ),
            "every real video requires an exact video_metadata object",
        ))
        cases.append((
            "real video omits title-cover-description triage",
            video_row_negative_payload(
                "missing-video-triage",
                lambda row: row["review_evidence"].pop("video_triage", None),
            ),
            "video item requires an exact triage object",
        ))
        cases.append((
            "video triage uses a different risk-term corpus",
            video_row_negative_payload(
                "wrong-triage-risk-hash",
                lambda row: row["review_evidence"]["video_triage"].update({
                    "risk_terms_sha256": "0" * 64,
                }),
            ),
            "video_triage.risk_terms_sha256: must match coverage",
        ))
        cases.append((
            "account video marks playback ranking not applicable",
            video_row_negative_payload(
                "account-play-count-not-applicable",
                lambda row: row["video_metadata"].update({
                    "play_count_status": "not_applicable",
                    "play_count": None,
                    "native_rank_evidence": None,
                    "play_count_source_text": "错误地跳过账号视频排名。",
                }),
            ),
            "delivered-account video cannot use not_applicable",
        ))
        cases.append((
            "observed playback count contradicts its visible source text",
            video_row_negative_payload(
                "observed-play-count-contradiction",
                lambda row: row["video_metadata"].update({
                    "play_count": 999999999,
                    "play_count_source_text": "1次播放",
                }),
            ),
            "must equal the unambiguous normalized value in play_count_source_text",
        ))
        cases.append((
            "not-public playback status hides an explicit visible count",
            video_row_negative_payload(
                "not-public-explicit-play-count",
                lambda row: row["video_metadata"].update({
                    "play_count_status": "not_public",
                    "play_count": None,
                    "native_rank_evidence": None,
                    "play_count_source_text": "1,234 views",
                }),
            ),
            "non-observed status contradicts the explicit playback count",
        ))
        cases.append((
            "video metadata observation is outside its route interval",
            video_row_negative_payload(
                "metadata-observed-outside-route",
                lambda row: row["video_metadata"].update({
                    "observed_at": "2030-01-01T00:00:00+08:00",
                }),
            ),
            "must fall inside its corresponding route interval",
        ))

        clear_top10_item = "fixture-clear-video-01"
        cases.append((
            "account Top-10 clear video omits detailed review",
            mutate_video_item_across_routes(
                adaptive_payload,
                "top10-missing-full",
                clear_top10_item,
                lambda row, _route_index: row.pop("video_review_evidence", None),
            ),
            "Top-10 video requires detailed video_review_evidence",
        ))

        def hide_later_observed_count(row: dict[str, Any], route_index: int) -> None:
            row.pop("video_review_evidence", None)
            if route_index == 1:
                row["video_metadata"].update({
                    "play_count_status": "not_public",
                    "play_count": None,
                    "native_rank_evidence": None,
                    "play_count_source_text": "该完成表面未显示播放量。",
                })

        cases.append((
            "later hidden count cannot erase an earlier observed Top-10 count",
            mutate_video_item_across_routes(
                adaptive_payload,
                "later-hidden-observed-count",
                clear_top10_item,
                hide_later_observed_count,
            ),
            "Top-10 video requires detailed video_review_evidence",
        ))

        def hide_later_native_rank(row: dict[str, Any], route_index: int) -> None:
            row.pop("video_review_evidence", None)
            if route_index == 1:
                row["video_metadata"].update({
                    "play_count_status": "not_public",
                    "play_count": None,
                    "native_rank_evidence": None,
                    "play_count_source_text": "该完成表面未显示原生热门顺序。",
                })

        cases.append((
            "later hidden surface cannot erase an earlier native Top-10 rank",
            mutate_video_item_across_routes(
                native_rank_payload,
                "later-hidden-native-rank",
                clear_top10_item,
                hide_later_native_rank,
            ),
            "Top-10 video requires detailed video_review_evidence",
        ))
        cases.append((
            "non-Top-10 suspected video must upgrade",
            mutate_video_item_across_routes(
                adaptive_payload,
                "eleventh-suspected-no-full",
                "fixture-clear-video-11",
                lambda row, _route_index: row["review_evidence"]["video_triage"].update({
                    "result": "suspected_risk",
                    "reason": "完整简介出现疑似风险线索，需要升级详细复核。",
                }),
            ),
            "requires detailed full-timeline evidence",
        ))
        cases.append((
            "non-Top-10 risk-signal video with final no_risk must upgrade",
            mutate_video_item_across_routes(
                adaptive_payload,
                "eleventh-risk-signal-no-full",
                "fixture-clear-video-11",
                lambda row, _route_index: row["review_evidence"]["video_triage"].update({
                    "result": "risk_signal",
                    "reason": "完整简介出现明确风险信号，即使最终结论为no_risk也必须升级详查。",
                }),
            ),
            "requires detailed full-timeline evidence",
        ))
        adaptive_video_route = next(
            route_record for route_record in fixture_routes(adaptive_payload)
            if route_record.get("discovered_items") == 11
        )
        adaptive_video_rows = [
            json.loads(line)
            for line in Path(adaptive_video_route["item_ledger_path"]).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        empty_hit_full_evidence = copy.deepcopy(
            next(
                row["video_review_evidence"] for row in adaptive_video_rows
                if row.get("item_id") == "fixture-clear-video-10"
            )
        )

        def suspected_with_empty_hits(row: dict[str, Any], _route_index: int) -> None:
            row["review_evidence"]["video_triage"].update({
                "result": "suspected_risk",
                "reason": "完整简介出现疑似风险线索，需要带语境命中证据的详细复核。",
            })
            row["video_review_evidence"] = copy.deepcopy(empty_hit_full_evidence)

        cases.append((
            "suspected triage with final no_risk omits contextual hits",
            mutate_video_item_across_routes(
                adaptive_payload,
                "suspected-empty-hits",
                "fixture-clear-video-11",
                suspected_with_empty_hits,
            ),
            "a risk/suspected triage requires at least one contextual hit",
        ))
        cases.append((
            "numeric cutoff tie omits the selected newer video",
            mutate_video_item_across_routes(
                ranked_payloads["numeric-boundary-tie"],
                "numeric-tie-selected-missing-full",
                "fixture-clear-video-10",
                lambda row, _route_index: row.pop("video_review_evidence", None),
            ),
            "Top-10 video requires detailed video_review_evidence",
        ))
        cases.append((
            "native cutoff tie omits the platform-selected video",
            mutate_video_item_across_routes(
                ranked_payloads["native-boundary-tie"],
                "native-tie-selected-missing-full",
                "fixture-clear-video-11",
                lambda row, _route_index: row.pop("video_review_evidence", None),
            ),
            "Top-10 video requires detailed video_review_evidence",
        ))
        cases.append((
            "native rank ten omits detailed review",
            mutate_video_item_across_routes(
                native_rank_payload,
                "native-rank-ten-missing-full",
                "fixture-clear-video-10",
                lambda row, _route_index: row.pop("video_review_evidence", None),
            ),
            "Top-10 video requires detailed video_review_evidence",
        ))

        def duplicate_native_rank(row: dict[str, Any], route_index: int) -> None:
            native_ref = row["video_metadata"]["native_rank_evidence"]
            native_document = json.loads(Path(native_ref["path"]).read_text(encoding="utf-8"))
            native_document["native_rank"] = 1
            native_path = Path(temp_dir) / f"duplicate-native-rank-{route_index}.json"
            native_path.write_text(
                json.dumps(native_document, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            native_ref["path"] = str(native_path)
            native_ref["sha256"] = _sha256(native_path)

        cases.append((
            "native account Top-10 rank is duplicated",
            mutate_video_item_across_routes(
                native_rank_payload,
                "duplicate-native-rank",
                "fixture-clear-video-02",
                duplicate_native_rank,
            ),
            "snapshot item at this rank is not the reviewed video",
        ))
        cases.append((
            "native ranking status omits its hashed evidence",
            mutate_video_item_across_routes(
                native_rank_payload,
                "native-rank-evidence-missing",
                clear_top10_item,
                lambda row, _route_index: row["video_metadata"].update({
                    "native_rank_evidence": None,
                }),
            ),
            "native_top_rank requires hashed account-wide rank evidence",
        ))

        def bind_native_rank_to_wrong_account(row: dict[str, Any], route_index: int) -> None:
            native_ref = row["video_metadata"]["native_rank_evidence"]
            native_document = json.loads(Path(native_ref["path"]).read_text(encoding="utf-8"))
            native_document["source_account_url"] = "https://www.facebook.com/wrong-account"
            native_path = Path(temp_dir) / f"wrong-native-account-{route_index}.json"
            native_path.write_text(
                json.dumps(native_document, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            native_ref["path"] = str(native_path)
            native_ref["sha256"] = _sha256(native_path)

        cases.append((
            "native rank evidence names a different account",
            mutate_video_item_across_routes(
                native_rank_payload,
                "native-rank-wrong-account",
                clear_top10_item,
                bind_native_rank_to_wrong_account,
                max_routes=1,
            ),
            "source_account_url: must equal the delivered account URL",
        ))

        def mutate_native_snapshot(
            row: dict[str, Any],
            route_index: int,
            *,
            tag: str,
            mutate: Any,
            keep_old_claimed_sha: bool = False,
        ) -> None:
            native_ref = row["video_metadata"]["native_rank_evidence"]
            native_document = json.loads(Path(native_ref["path"]).read_text(encoding="utf-8"))
            source_snapshot = Path(native_document["ranking_snapshot_path"])
            snapshot_document = json.loads(source_snapshot.read_text(encoding="utf-8"))
            mutate(snapshot_document)
            snapshot_path = Path(temp_dir) / f"{tag}-snapshot-{route_index}.json"
            snapshot_path.write_text(
                json.dumps(snapshot_document, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            native_document["ranking_snapshot_path"] = str(snapshot_path)
            if not keep_old_claimed_sha:
                native_document["ranking_snapshot_sha256"] = _sha256(snapshot_path)
            native_path = Path(temp_dir) / f"{tag}-rank-{route_index}.json"
            native_path.write_text(
                json.dumps(native_document, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            native_ref["path"] = str(native_path)
            native_ref["sha256"] = _sha256(native_path)

        cases.append((
            "native account snapshot omits an exact field",
            mutate_video_item_across_routes(
                native_rank_payload,
                "native-snapshot-missing-field",
                clear_top10_item,
                lambda row, route_index: mutate_native_snapshot(
                    row,
                    route_index,
                    tag="native-snapshot-missing-field",
                    mutate=lambda snapshot: snapshot.pop("ranking_scope", None),
                ),
                max_routes=1,
            ),
            "snapshot: missing fields: ranking_scope",
        ))
        cases.append((
            "native account snapshot hash does not match",
            mutate_video_item_across_routes(
                native_rank_payload,
                "native-snapshot-wrong-hash",
                clear_top10_item,
                lambda row, route_index: mutate_native_snapshot(
                    row,
                    route_index,
                    tag="native-snapshot-wrong-hash",
                    mutate=lambda snapshot: snapshot.update({"ranking_scope": "changed-scope"}),
                    keep_old_claimed_sha=True,
                ),
                max_routes=1,
            ),
            "ranking_snapshot_sha256: does not match account snapshot",
        ))
        cases.append((
            "native account snapshot repeats one stable video URL",
            mutate_video_item_across_routes(
                native_rank_payload,
                "native-snapshot-duplicate-url",
                clear_top10_item,
                lambda row, route_index: mutate_native_snapshot(
                    row,
                    route_index,
                    tag="native-snapshot-duplicate-url",
                    mutate=lambda snapshot: snapshot["ordered_video_urls"].__setitem__(
                        1, snapshot["ordered_video_urls"][0]
                    ),
                ),
                max_routes=1,
            ),
            "stable video identities must be unique",
        ))

        def split_native_snapshot(row: dict[str, Any], route_index: int) -> None:
            native_ref = row["video_metadata"]["native_rank_evidence"]
            native_document = json.loads(Path(native_ref["path"]).read_text(encoding="utf-8"))
            source_snapshot = Path(native_document["ranking_snapshot_path"])
            snapshot_document = json.loads(source_snapshot.read_text(encoding="utf-8"))
            snapshot_document["sort_mode"] = "most_viewed"
            snapshot_path = Path(temp_dir) / f"split-native-snapshot-{route_index}.json"
            snapshot_path.write_text(
                json.dumps(snapshot_document, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            native_document.update({
                "sort_mode": "most_viewed",
                "ranking_snapshot_path": str(snapshot_path),
                "ranking_snapshot_sha256": _sha256(snapshot_path),
            })
            native_path = Path(temp_dir) / f"split-native-rank-{route_index}.json"
            native_path.write_text(
                json.dumps(native_document, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            native_ref["path"] = str(native_path)
            native_ref["sha256"] = _sha256(native_path)

        cases.append((
            "one account route splices different native ranking snapshots",
            mutate_video_item_across_routes(
                native_rank_payload,
                "split-native-snapshot",
                clear_top10_item,
                split_native_snapshot,
                max_routes=1,
            ),
            "must share one account-ranking snapshot provenance",
        ))

        def relabel_as_pure_animated_image(row: dict[str, Any], _route_index: int) -> None:
            row["url"] = "https://www.facebook.com/fixturevalid/posts/animated-image"
            row["content_type"] = "post"
            row["media_kinds"] = ["animated_image"]
            row.pop("video_metadata", None)
            row.pop("video_review_evidence", None)
            row["review_evidence"].pop("video_triage", None)

        cases.append((
            "pure animated image omits full timeline review",
            mutate_video_item_across_routes(
                adaptive_payload,
                "animated-image-missing-full",
                "fixture-clear-video-11",
                relabel_as_pure_animated_image,
                max_routes=1,
            ),
            "video item requires a video_review_evidence object",
        ))

        cases.append((
            "same canonical video URL changes stable item id across routes",
            mutate_video_item_across_routes(
                adaptive_payload,
                "same-url-different-id",
                clear_top10_item,
                lambda row, _route_index: row.update({"item_id": "fixture-video-id-swapped"}),
                max_routes=1,
            ),
            "canonical item URL",
        ))
        cases.append((
            "known aliases of one platform video use different stable item ids",
            mutate_video_item_across_routes(
                adaptive_payload,
                "video-alias-different-id",
                clear_top10_item,
                lambda row, _route_index: row.update({
                    "item_id": "fixture-video-alias-swapped",
                    "url": "https://www.facebook.com/watch?v=1001&utm_source=alias-test",
                }),
                max_routes=1,
            ),
            "stable video identity",
        ))
        cases.append((
            "same stable item id changes canonical video URL across routes",
            mutate_video_item_across_routes(
                adaptive_payload,
                "same-id-different-url",
                clear_top10_item,
                lambda row, _route_index: row.update({
                    "url": "https://www.facebook.com/fixturevalid/videos/999999",
                }),
                max_routes=1,
            ),
            "stable item_id",
        ))
        cases.append((
            "same video changes media kinds across routes",
            mutate_video_item_across_routes(
                adaptive_payload,
                "cross-route-media-kind-change",
                clear_top10_item,
                lambda row, _route_index: row.update({"media_kinds": ["audio", "video"]}),
                max_routes=1,
            ),
            "changes media_kinds across routes",
        ))
        cases.append((
            "frame manifest omits a sampled frame",
            video_jsonl_negative_payload(
                "frame-missing", path_field="frame_manifest_path",
                sha_field="frame_manifest_sha256", mutate=lambda rows: rows.pop(),
            ),
            "missing sampled timestamp rows",
        ))
        cases.append((
            "frame manifest binds a frame to the wrong video URL",
            video_jsonl_negative_payload(
                "frame-wrong-url", path_field="frame_manifest_path",
                sha_field="frame_manifest_sha256",
                mutate=lambda rows: rows[0].update({
                    "source_video_url": "https://www.youtube.com/watch?v=wrongvideo",
                }),
            ),
            "source_video_url: must equal the reviewed item URL",
        ))
        cases.append((
            "frame manifest claims the wrong frame hash",
            video_jsonl_negative_payload(
                "frame-wrong-hash", path_field="frame_manifest_path",
                sha_field="frame_manifest_sha256",
                mutate=lambda rows: rows[0].update({"frame_sha256": "0" * 64}),
            ),
            "frame_sha256: does not match frame file",
        ))
        cases.append((
            "frame manifest row contains an uncontrolled field",
            video_jsonl_negative_payload(
                "frame-extra-field", path_field="frame_manifest_path",
                sha_field="frame_manifest_sha256",
                mutate=lambda rows: rows[0].update({"uncontrolled_note": "not allowed"}),
            ),
            "unexpected/redundant fields: uncontrolled_note",
        ))

        def arbitrary_audio_text(row: dict[str, Any]) -> None:
            arbitrary_path = Path(temp_dir) / "video-negative-arbitrary-audio.txt"
            arbitrary_path.write_text("任意非空文本不能证明完整音轨覆盖。\n", encoding="utf-8")
            evidence = row["video_review_evidence"]
            evidence["audio_text_path"] = str(arbitrary_path)
            evidence["audio_text_sha256"] = _sha256(arbitrary_path)

        cases.append((
            "arbitrary text cannot replace a timed full-audio timeline",
            video_row_negative_payload("audio-arbitrary-text", arbitrary_audio_text),
            "must be a UTF-8 JSONL timeline",
        ))
        cases.append((
            "full-audio timeline has a gap",
            video_jsonl_negative_payload(
                "audio-gap", path_field="audio_text_path", sha_field="audio_text_sha256",
                mutate=lambda rows: rows[1].update({"start_seconds": 21}),
            ),
            "audio timeline must be continuous without gaps or overlaps",
        ))
        cases.append((
            "full-audio timeline binds a segment to the wrong video URL",
            video_jsonl_negative_payload(
                "audio-wrong-url", path_field="audio_text_path", sha_field="audio_text_sha256",
                mutate=lambda rows: rows[0].update({
                    "source_video_url": "https://www.youtube.com/watch?v=wrongvideo",
                }),
            ),
            "source_video_url: must equal the reviewed item URL",
        ))
        cases.append((
            "full-audio timeline row contains an uncontrolled field",
            video_jsonl_negative_payload(
                "audio-extra-field", path_field="audio_text_path", sha_field="audio_text_sha256",
                mutate=lambda rows: rows[0].update({"uncontrolled_note": "not allowed"}),
            ),
            "unexpected/redundant fields: uncontrolled_note",
        ))
        cases.append((
            "unintelligible audio cannot claim completed review",
            video_jsonl_negative_payload(
                "audio-unintelligible", path_field="audio_text_path", sha_field="audio_text_sha256",
                mutate=lambda rows: rows[0].update({"segment_kind": "unintelligible", "text": "无法辨识"}),
            ),
            "cannot support completed full-audio review",
        ))
        cases.append((
            "video hit binds to the wrong source URL",
            video_negative_payload(
                "hit-wrong-url",
                lambda evidence: evidence["hits"][0].update({
                    "source_video_url": "https://www.youtube.com/watch?v=wrongvideo",
                }),
            ),
            "source_video_url: must equal the reviewed item URL",
        ))

        def bind_hit_to_wrong_frame(evidence: dict[str, Any]) -> None:
            manifest_rows = [
                json.loads(line)
                for line in Path(evidence["frame_manifest_path"]).read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            wrong_frame = manifest_rows[0]
            evidence["hits"][0].update({
                "evidence_path": wrong_frame["frame_path"],
                "evidence_sha256": wrong_frame["frame_sha256"],
            })

        cases.append((
            "frame hit does not bind to its timestamped manifest row",
            video_negative_payload("hit-wrong-frame", bind_hit_to_wrong_frame),
            "screenshot/frame hit path and hash must match the frame-manifest row",
        ))

        def detach_transcript_hit(evidence: dict[str, Any]) -> None:
            evidence["hits"][0].update({
                "evidence_kind": "transcript_excerpt",
                "evidence_path": evidence["frame_manifest_path"],
                "evidence_sha256": evidence["frame_manifest_sha256"],
            })

        cases.append((
            "transcript hit is detached from the full-audio timeline",
            video_negative_payload("hit-detached-transcript", detach_transcript_hit),
            "transcript_excerpt hit must bind to the validated full-audio timeline path and hash",
        ))
        for name, fixture, expected in cases:
            result = validate(fixture, check_files=True)
            if not any(expected in error for error in result):
                print(f"SELF-TEST {name!r} did not emit expected fragment {expected!r}")
                for error in result:
                    print(error)
                return 1

        full_groups = set(payload["coverage"]["keyword_groups_checked"])
        sentinel_groups = set(payload["coverage"]["native_search_sentinel_groups"])
        adaptive_aliases = {"测试对象", "fixturevalid"}
        adaptive_queries: list[dict[str, Any]] = []
        adaptive_query_serial = 0
        for alias in sorted(adaptive_aliases):
            for group in ["", *sorted(sentinel_groups)]:
                adaptive_query_serial += 1
                query_text = alias if not group else f"{alias} {group}"
                adaptive_queries.append({
                    "query_id": f"adaptive-query-{adaptive_query_serial}",
                    "alias": alias,
                    "keyword_group": group,
                    "query_text": query_text,
                    "query_url": f"https://www.facebook.com/search/top?q={quote(query_text, safe='')}",
                    "termination": "empty_result_after_full_query",
                    "discovered_items": 0,
                    "reviewed_items": 0,
                    "unreviewed_items": 0,
                })
        adaptive_query_path = Path(temp_dir) / "adaptive-positive-queries.jsonl"
        adaptive_query_path.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in adaptive_queries),
            encoding="utf-8",
        )
        adaptive_item_path = Path(temp_dir) / "adaptive-positive-items.jsonl"
        adaptive_item_path.write_text("", encoding="utf-8")
        adaptive_query_errors: list[str] = []
        _validate_query_ledger(
            adaptive_query_path,
            prefix="targeted.adaptive.query_ledger_path",
            platform_key="facebook",
            module_key="keyword_search",
            aliases=adaptive_aliases,
            keyword_groups=sentinel_groups,
            expected_sha256=_sha256(adaptive_query_path),
            errors=adaptive_query_errors,
        )
        adaptive_route = {
            "route_id": "targeted-adaptive-facebook",
            "status": "complete",
            "linear_pass_index": 1,
            "module_key": "keyword_search",
            "keyword_groups_covered": sorted(sentinel_groups),
            "query_ledger_path": str(adaptive_query_path),
            "item_ledger_path": str(adaptive_item_path),
        }
        _validate_adaptive_search_strategy(
            [adaptive_route],
            prefix="targeted.adaptive",
            platform_key="facebook",
            coverage_keyword_groups=full_groups,
            native_search_sentinel_groups=sentinel_groups,
            platform_has_confirmed_account=True,
            platform_declared_risk=False,
            platform_user_risk_lead=False,
            ledger_decisions={},
            candidate_evaluations={},
            check_files=True,
            errors=adaptive_query_errors,
        )
        if adaptive_query_errors:
            print("SELF-TEST adaptive named-platform positive check failed")
            print("\n".join(adaptive_query_errors))
            return 1
        if _completed_search_group_mode(
            "facebook", sentinel_groups,
            coverage_keyword_groups=full_groups,
            native_search_sentinel_groups=sentinel_groups,
        ) != "adaptive":
            print("SELF-TEST adaptive named-platform mode inference failed")
            return 1
        if _completed_search_group_mode(
            "domestic_other", sentinel_groups,
            coverage_keyword_groups=full_groups,
            native_search_sentinel_groups=sentinel_groups,
        ) is not None:
            print("SELF-TEST Baidu adaptive search negative check failed")
            return 1

        no_confirmed_errors: list[str] = []
        _validate_adaptive_search_strategy(
            [adaptive_route], prefix="targeted.adaptive", platform_key="facebook",
            coverage_keyword_groups=full_groups,
            native_search_sentinel_groups=sentinel_groups,
            platform_has_confirmed_account=False, platform_declared_risk=False,
            platform_user_risk_lead=False,
            ledger_decisions={}, candidate_evaluations={}, check_files=True,
            errors=no_confirmed_errors,
        )
        if not any("no confirmed subject account" in error for error in no_confirmed_errors):
            print("SELF-TEST adaptive search without confirmed account negative check failed")
            print("\n".join(no_confirmed_errors))
            return 1

        risk_upgrade_errors: list[str] = []
        _validate_adaptive_search_strategy(
            [adaptive_route], prefix="targeted.adaptive", platform_key="facebook",
            coverage_keyword_groups=full_groups,
            native_search_sentinel_groups=sentinel_groups,
            platform_has_confirmed_account=True, platform_declared_risk=False,
            platform_user_risk_lead=False,
            ledger_decisions={"keyword_search": {"risk"}}, candidate_evaluations={},
            check_files=True, errors=risk_upgrade_errors,
        )
        if not any("reviewed risk item" in error for error in risk_upgrade_errors):
            print("SELF-TEST adaptive risk-hit upgrade negative check failed")
            print("\n".join(risk_upgrade_errors))
            return 1

        candidate_upgrade_errors: list[str] = []
        same_name_evaluation = {
            "candidate_platform_key": "facebook", "candidate_subplatform": "",
            "name_match": "exact_display_name", "all_platform_name_claim": False,
            "anchor_strengths": {name: "none" for name in CANDIDATE_ANCHOR_NAMES},
            "explicit_identity_conflict": False, "similarity_score": 100,
        }
        _validate_adaptive_search_strategy(
            [adaptive_route], prefix="targeted.adaptive", platform_key="facebook",
            coverage_keyword_groups=full_groups,
            native_search_sentinel_groups=sentinel_groups,
            platform_has_confirmed_account=True, platform_declared_risk=False,
            platform_user_risk_lead=False,
            ledger_decisions={},
            candidate_evaluations={
                "https://www.facebook.com/same-name-one": same_name_evaluation,
                "https://www.facebook.com/same-name-two": same_name_evaluation,
            },
            check_files=True, errors=candidate_upgrade_errors,
        )
        if not any("at least two unresolved exact" in error for error in candidate_upgrade_errors):
            print("SELF-TEST adaptive same-name candidate upgrade negative check failed")
            print("\n".join(candidate_upgrade_errors))
            return 1

        sentinel_query_url = next(
            row["query_url"] for row in adaptive_queries if row["keyword_group"]
        )
        sentinel_item_url = "https://www.facebook.com/watch/?v=adaptive-new-item"
        sentinel_item_path = Path(temp_dir) / "adaptive-sentinel-new-item.jsonl"
        sentinel_item_path.write_text(json.dumps({
            "url": sentinel_item_url,
            "query_or_account_urls": [sentinel_query_url],
        }, ensure_ascii=False) + "\n", encoding="utf-8")
        sentinel_route = {
            **adaptive_route,
            "route_id": "targeted-adaptive-sentinel-new-url",
            "item_ledger_path": str(sentinel_item_path),
        }
        sentinel_upgrade_errors: list[str] = []
        _validate_adaptive_search_strategy(
            [sentinel_route], prefix="targeted.adaptive", platform_key="facebook",
            coverage_keyword_groups=full_groups,
            native_search_sentinel_groups=sentinel_groups,
            platform_has_confirmed_account=True, platform_declared_risk=False,
            platform_user_risk_lead=False,
            ledger_decisions={}, candidate_evaluations={}, check_files=True,
            errors=sentinel_upgrade_errors,
        )
        if not any(sentinel_item_url in error for error in sentinel_upgrade_errors):
            print("SELF-TEST adaptive sentinel-new-URL upgrade negative check failed")
            print("\n".join(sentinel_upgrade_errors))
            return 1

        # Positive parallel unit: record ordinals do not imply timing, platform
        # ranks may be out of order, positive waves need not be consecutive,
        # and different Edge pages/windows may overlap.
        parallel_contexts: list[dict[str, Any]] = []

        def add_parallel_context(
            record_index: int,
            pass_index: int,
            platform_rank: int,
            page_suffix: int,
            window_suffix: int,
            started_at: str,
            completed_at: str,
            *,
            surface: str = "native_search",
        ) -> None:
            parallel_contexts.append({
                "platform_key": PLATFORMS[platform_rank],
                "platform_rank": platform_rank,
                "work_unit_rank": 0,
                "prefix": f"targeted.route_results[{record_index - 1}]",
                "route": {
                    "route_id": f"targeted-route-{record_index}",
                    "serial_route_index": record_index,
                    "linear_pass_index": pass_index,
                    "surface": surface,
                    "tool_kind": "microsoft_edge_visible",
                    "edge_window_continuity_id": f"00000000-0000-4000-8000-{window_suffix:012d}",
                    "edge_page_continuity_id": f"00000000-0000-4000-8000-{page_suffix:012d}",
                    "max_task_open_edge_pages": 3,
                    "started_at": started_at,
                    "completed_at": completed_at,
                },
            })

        add_parallel_context(
            1, 0, 12, 1, 1,
            "2026-09-02T08:57:00+08:00", "2026-09-02T08:57:30+08:00",
            surface="account_discovery",
        )
        add_parallel_context(
            2, 2, 12, 2, 1,
            "2026-09-02T09:00:00+08:00", "2026-09-02T09:02:00+08:00",
        )
        add_parallel_context(
            3, 1, 0, 3, 2,
            "2026-09-02T09:00:15+08:00", "2026-09-02T09:01:30+08:00",
        )
        add_parallel_context(
            4, 2, 9, 4, 2,
            "2026-09-02T09:00:30+08:00", "2026-09-02T09:01:00+08:00",
        )
        parallel_errors: list[str] = []
        _validate_parallel_execution(
            parallel_contexts,
            final_linear_pass_index=2,
            coverage_started_at=datetime.fromisoformat("2026-09-02T08:55:00+08:00"),
            coverage_completed_at=datetime.fromisoformat("2026-09-02T12:00:00+08:00"),
            preflight_serial={
                "completed_at": datetime.fromisoformat("2026-09-02T08:56:00+08:00"),
            },
            errors=parallel_errors,
        )
        if parallel_errors:
            print("SELF-TEST parallel platform/page/wave positive check failed")
            print("\n".join(parallel_errors))
            return 1

        same_page_overlap = copy.deepcopy(parallel_contexts)
        same_page_overlap[2]["route"]["edge_page_continuity_id"] = same_page_overlap[1]["route"][
            "edge_page_continuity_id"
        ]
        same_page_overlap[2]["route"]["edge_window_continuity_id"] = same_page_overlap[1]["route"][
            "edge_window_continuity_id"
        ]
        same_page_errors: list[str] = []
        _validate_parallel_execution(
            same_page_overlap,
            final_linear_pass_index=2,
            coverage_started_at=datetime.fromisoformat("2026-09-02T08:55:00+08:00"),
            coverage_completed_at=datetime.fromisoformat("2026-09-02T12:00:00+08:00"),
            preflight_serial={
                "completed_at": datetime.fromisoformat("2026-09-02T08:56:00+08:00"),
            },
            errors=same_page_errors,
        )
        if not any("sharing one edge_page_continuity_id must not overlap" in error for error in same_page_errors):
            print("SELF-TEST same-page overlap negative check failed")
            print("\n".join(same_page_errors))
            return 1
        mixed_module_errors: list[str] = []
        _validate_module(
            {
                "status": "confirmed",
                "urls": ["https://github.com/octocat", "https://github.com/torvalds"],
                "url_identity_statuses": {
                    "https://github.com/octocat": "confirmed",
                    "https://github.com/torvalds": "suspected",
                },
                "url_risk_group_ids": {
                    "https://github.com/octocat": [],
                    "https://github.com/torvalds": [],
                },
                "risk_group_ids": [],
            },
            module_name="homepage",
            prefix="targeted.mixed_homepage",
            valid_group_ids=set(),
            errors=mixed_module_errors,
        )
        if mixed_module_errors:
            print("SELF-TEST mixed confirmed/suspected homepage module unexpectedly failed")
            print("\n".join(mixed_module_errors))
            return 1
        def candidate_evaluation(
            *, name_match: str, weak_anchor: str = "none", score: int | None = None,
        ) -> dict[str, Any]:
            strengths = {name: "none" for name in CANDIDATE_ANCHOR_NAMES}
            strengths["content_theme"] = weak_anchor
            value: dict[str, Any] = {
                "candidate_platform_key": "youtube", "candidate_subplatform": "",
                "name_match": name_match, "all_platform_name_claim": False,
                "anchor_strengths": strengths, "explicit_identity_conflict": False,
            }
            value["similarity_score"] = _candidate_similarity_score(value) if score is None else score
            return value

        high_url = "https://www.youtube.com/@fixturehigh"
        low_url = "https://www.youtube.com/@fixturelow"
        candidate_accounts = {
            high_url: (0, {
                "platform_key": "youtube", "subplatform": "", "status": "suspected_homepage",
                "source_urls": [high_url],
            }),
            low_url: (1, {
                "platform_key": "youtube", "subplatform": "", "status": "unconfirmed_candidate",
                "source_urls": [low_url],
            }),
        }
        candidate_values = {
            high_url: candidate_evaluation(name_match="exact_display_name", weak_anchor="weak"),
            low_url: candidate_evaluation(name_match="exact_alias"),
        }
        candidate_errors: list[str] = []
        _validate_identity_selection(
            account_records_by_url=candidate_accounts,
            user_supplied_homepages=[], candidate_evaluations=candidate_values,
            check_files=True, errors=candidate_errors,
        )
        if candidate_errors:
            print("SELF-TEST highest-similarity candidate positive check failed")
            print("\n".join(candidate_errors))
            return 1
        wrong_accounts = copy.deepcopy(candidate_accounts)
        wrong_accounts[high_url][1]["status"] = "unconfirmed_candidate"
        wrong_accounts[low_url][1]["status"] = "suspected_homepage"
        wrong_errors: list[str] = []
        _validate_identity_selection(
            account_records_by_url=wrong_accounts,
            user_supplied_homepages=[], candidate_evaluations=candidate_values,
            check_files=True, errors=wrong_errors,
        )
        if not any("unique highest-similarity candidate" in error for error in wrong_errors):
            print("SELF-TEST lower-similarity selection negative check failed")
            print("\n".join(wrong_errors))
            return 1
        tied_values = {
            high_url: candidate_evaluation(name_match="exact_display_name"),
            low_url: candidate_evaluation(name_match="exact_display_name"),
        }
        tied_accounts = copy.deepcopy(candidate_accounts)
        tied_accounts[high_url][1]["status"] = "unconfirmed_candidate"
        tied_accounts[low_url][1]["status"] = "unconfirmed_candidate"
        tied_errors: list[str] = []
        _validate_identity_selection(
            account_records_by_url=tied_accounts,
            user_supplied_homepages=[], candidate_evaluations=tied_values,
            check_files=True, errors=tied_errors,
        )
        if tied_errors:
            print("SELF-TEST tied common-name candidates positive check failed")
            print("\n".join(tied_errors))
            return 1
        tied_selected_accounts = copy.deepcopy(tied_accounts)
        tied_selected_accounts[high_url][1]["status"] = "suspected_homepage"
        tied_selected_errors: list[str] = []
        _validate_identity_selection(
            account_records_by_url=tied_selected_accounts,
            user_supplied_homepages=[], candidate_evaluations=tied_values,
            check_files=True, errors=tied_selected_errors,
        )
        if not any("tied highest-similarity candidates" in error for error in tied_selected_errors):
            print("SELF-TEST tied candidate selection negative check failed")
            print("\n".join(tied_selected_errors))
            return 1
        supplied_a = "https://www.youtube.com/@supplied-a"
        supplied_b = "https://www.youtube.com/@supplied-b"
        automatic_url = "https://www.youtube.com/@automatic"
        supplied_account_records = {
            supplied_a: (0, {
                "platform_key": "youtube", "subplatform": "", "status": "suspected_homepage",
                "source_urls": [supplied_a],
            }),
            supplied_b: (1, {
                "platform_key": "youtube", "subplatform": "", "status": "suspected_homepage",
                "source_urls": [supplied_b],
            }),
            automatic_url: (2, {
                "platform_key": "youtube", "subplatform": "", "status": "unconfirmed_candidate",
                "source_urls": [automatic_url],
            }),
        }
        supplied_rows = [
            {
                "platform_key": "youtube", "subplatform": "",
                "input_url": url, "canonical_url": url, "canonicalization_route_id": "",
            }
            for url in (supplied_a, supplied_b)
        ]
        supplied_selection_errors: list[str] = []
        _validate_identity_selection(
            account_records_by_url=supplied_account_records,
            user_supplied_homepages=supplied_rows,
            candidate_evaluations={
                automatic_url: candidate_evaluation(name_match="exact_display_name"),
            },
            check_files=True,
            errors=supplied_selection_errors,
        )
        if supplied_selection_errors:
            print("SELF-TEST multiple supplied suspects with automatic-candidate suppression failed")
            print("\n".join(supplied_selection_errors))
            return 1
        all_seen_candidate_evidence: dict[str, dict[str, Any]] = {}
        earlier_evaluation = candidate_evaluation(
            name_match="exact_display_name", weak_anchor="weak"
        )
        downgraded_final_evaluation = candidate_evaluation(name_match="exact_alias")
        _accumulate_candidate_evidence(
            all_seen_candidate_evidence,
            {automatic_url: earlier_evaluation},
            prefix="targeted.candidate_history",
            errors=supplied_selection_errors,
        )
        _accumulate_candidate_evidence(
            all_seen_candidate_evidence,
            {automatic_url: downgraded_final_evaluation},
            prefix="targeted.candidate_history",
            errors=supplied_selection_errors,
        )
        downgrade_errors: list[str] = []
        _validate_final_candidate_evidence(
            all_seen_candidate_evidence,
            {automatic_url: downgraded_final_evaluation},
            set(),
            errors=downgrade_errors,
        )
        if not any("must preserve the strongest" in error for error in downgrade_errors):
            print("SELF-TEST final reconciliation-cycle candidate evidence downgrade negative check failed")
            print("\n".join(downgrade_errors))
            return 1
        if not (
            _actual_platform_slot("domestic_other", "https://www.pixiv.net/users/1")
            == _actual_platform_slot("overseas_other", "https://pixiv.me/example")
            == ("extra", "pixiv")
        ):
            print("SELF-TEST extra-platform canonical-slot normalization check failed")
            return 1
        for host_a, host_b, service_id in (
            ("alice.artstation.com", "bob.artstation.com", "artstation"),
            ("alice.bandcamp.com", "bob.bandcamp.com", "bandcamp"),
            ("alice.substack.com", "bob.substack.com", "substack"),
            ("alice.wordpress.com", "bob.wordpress.com", "wordpress"),
            ("alice.carrd.co", "bob.carrd.co", "carrd"),
            ("alice.itch.io", "bob.itch.io", "itch_io"),
            ("alice.deviantart.com", "bob.deviantart.com", "deviantart"),
            ("alice.webflow.io", "bob.webflow.io", "webflow"),
            ("alice.notion.site", "bob.notion.site", "notion_sites"),
            ("alice.weebly.com", "bob.weebly.com", "weebly.com"),
            ("alice.unknown-host.test", "bob.unknown-host.test", "unknown-host.test"),
        ):
            if not (
                _actual_platform_slot("domestic_other", f"https://{host_a}/")
                == _actual_platform_slot("overseas_other", f"https://{host_b}/")
                == ("extra", service_id)
            ):
                print("SELF-TEST hosted-service suffix alias normalization check failed")
                return 1
        if (
            _actual_platform_slot("domestic_other", "https://alice.com.br/profile")
            == _actual_platform_slot("overseas_other", "https://bob.com.br/profile")
            or _actual_platform_slot("domestic_other", "https://203.0.113.10/profile")
            == _actual_platform_slot("overseas_other", "https://198.51.113.10/profile")
            or _actual_platform_slot("domestic_other", "https://web.de/profile")
            == _actual_platform_slot("overseas_other", "https://mobile.de/profile")
            or _actual_platform_slot("domestic_other", "https://alice.go.jp/profile")
            == _actual_platform_slot("overseas_other", "https://bob.go.jp/profile")
            or _actual_platform_slot("domestic_other", "https://alice.k12.ca.us/profile")
            == _actual_platform_slot("overseas_other", "https://bob.k12.ca.us/profile")
        ):
            print("SELF-TEST unrelated extra-platform hosts must not collapse into one slot")
            return 1
        extra_account_positive_urls = (
            "https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF",
            "https://www.pixiv.net/users/123456",
            "https://www.tiktok.com/@fixturevalid",
            "https://www.threads.net/@fixturevalid",
            "https://bsky.app/profile/fixturevalid.bsky.social",
            "https://www.linkedin.com/in/fixturevalid",
            "https://www.imdb.com/name/nm1234567/",
            "https://www.skland.com/profile?id=6388628879164",
            "https://fixturevalid.bandcamp.com/",
            "https://www.youtube.com/@fixturevalid",
            "https://fixturevalid.fanbox.cc/",
            "https://www.fanbox.cc/@fixturevalid",
            "https://fixturevalid.wixsite.com/portfolio",
            "https://fixturevalid.notion.site/Portfolio-1234567890abcdef",
            "https://open.spotify.com/intl-de/artist/0OdUWJ0sBjDrqHygGUXeCF",
        )
        missed_extra_account_urls = [
            url for url in extra_account_positive_urls
            if not _looks_like_account_homepage("overseas_other", url)
        ]
        if missed_extra_account_urls:
            print("SELF-TEST controlled extra-platform account-homepage recognition failed")
            print("\n".join(missed_extra_account_urls))
            return 1
        extra_account_negative_urls = (
            "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp",
            "https://www.pixiv.net/artworks/123456",
            "https://www.tiktok.com/@fixturevalid/video/123456",
            "https://www.threads.net/@fixturevalid/post/ABC123",
            "https://bsky.app/profile/fixturevalid.bsky.social/post/ABC123",
            "https://www.imdb.com/title/tt1234567/",
            "https://www.skland.com/article?id=123456",
            "https://fixturevalid.bandcamp.com/track/example",
            "https://www.youtube.com/watch?v=fixture123",
            "https://vimeo.com/123456789",
            "https://daily.bandcamp.com/",
        )
        false_extra_account_urls = [
            url for url in extra_account_negative_urls
            if _looks_like_account_homepage("overseas_other", url)
        ]
        if false_extra_account_urls:
            print("SELF-TEST extra-platform content URL misclassified as an account homepage")
            print("\n".join(false_extra_account_urls))
            return 1
        google_query = "https://www.google.com/search?q=fixturevalid+spotify"
        spotify_artist_url = extra_account_positive_urls[0]
        spotify_search_row = {
            "platform_key": "overseas_other", "surface": "general_search",
            "query_or_account_urls": [google_query], "item_id": "spotify-search-account",
            "url": spotify_artist_url, "item_kind": "content", "content_type": "search_result",
            "author": "测试对象", "published_at": "", "title": "", "text": "同名艺人主页。",
            "media_kinds": ["none"],
            "media_review_status": "not_applicable",
            "subject_interaction_review_status": "not_applicable",
            "review_status": "reviewed", "risk_decision": "no_risk", "risk_group_id": "",
        }
        spotify_search_ledger = Path(temp_dir) / "spotify-search-account-items.jsonl"
        spotify_search_ledger.write_text(
            json.dumps(spotify_search_row, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        spotify_search_errors: list[str] = []
        _spotify_refs, _spotify_decisions, _spotify_items, spotify_candidates, _spotify_observations = _validate_item_ledger(
            spotify_search_ledger,
            prefix="targeted.spotify_search", platform_key="overseas_other",
            module_key="google_search", subject_display_name="测试对象", subject_aliases=set(),
            source_inventory={spotify_artist_url}, route_origin_url=google_query,
            expected_surface="general_search", expected_origin_url=None,
            query_counts={google_query: 1}, expected_count=1, valid_group_ids=set(),
            risk_terms_sha256="0" * 64,
            account_url=None, route_started_at=None, route_completed_at=None,
            errors=spotify_search_errors,
        )
        if (
            not any("must be account_candidate" in error for error in spotify_search_errors)
            or spotify_candidates
        ):
            print("SELF-TEST Google-to-Spotify ordinary-content bypass negative check failed")
            print("\n".join(spotify_search_errors))
            return 1
        spotify_search_row.update({
            "item_kind": "account_candidate", "content_type": "account_candidate",
            "identity_candidate": {
                "candidate_platform_key": "overseas_other", "candidate_subplatform": "Spotify",
                "name_match": "exact_display_name", "all_platform_name_claim": False,
                "anchor_strengths": {name: "none" for name in CANDIDATE_ANCHOR_NAMES},
                "explicit_identity_conflict": False, "similarity_score": 100,
                "evidence_urls": [],
            },
        })
        def attest_synthetic_candidate(row: dict[str, Any], tag: str) -> None:
            """Test fixture only: create explicit source data, never migrate real rows."""
            row.pop("review_evidence", None)
            source_path = Path(temp_dir) / f"{tag}-source.json"
            source_path.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
            row["review_evidence"] = {
                "content_sha256": content_sha256(row), "decision": row["risk_decision"],
                "context_reason": "Synthetic candidate fixture: visible account name matches the tested subject name.",
                "reviewer": "self-test fixture", "review_mode": "agent_context",
                "reviewed_at": "2026-09-02T10:00:00+08:00",
                "evidence_refs": [{"path": str(source_path), "sha256": _sha256(source_path), "locator": "json:"}],
            }
        attest_synthetic_candidate(spotify_search_row, "spotify-candidate-review")
        spotify_candidate_ledger = Path(temp_dir) / "spotify-search-candidate-items.jsonl"
        spotify_candidate_ledger.write_text(
            json.dumps(spotify_search_row, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        spotify_candidate_errors: list[str] = []
        _spotify_refs, _spotify_decisions, _spotify_items, spotify_candidates, _spotify_observations = _validate_item_ledger(
            spotify_candidate_ledger,
            prefix="targeted.spotify_candidate", platform_key="overseas_other",
            module_key="google_search", subject_display_name="测试对象", subject_aliases=set(),
            source_inventory={spotify_artist_url}, route_origin_url=google_query,
            expected_surface="general_search", expected_origin_url=None,
            query_counts={google_query: 1}, expected_count=1, valid_group_ids=set(),
            risk_terms_sha256="0" * 64,
            account_url=None, route_started_at=None, route_completed_at=None,
            errors=spotify_candidate_errors,
        )
        if spotify_candidate_errors or spotify_artist_url not in spotify_candidates:
            print("SELF-TEST Google-to-Spotify candidate-ledger positive check failed")
            print("\n".join(spotify_candidate_errors))
            return 1
        cross_platform_youtube_url = "https://www.youtube.com/@fixturevalid"
        cross_platform_row = copy.deepcopy(spotify_search_row)
        cross_platform_row.update({
            "item_id": "google-cross-platform-youtube", "url": cross_platform_youtube_url,
            "identity_candidate": {
                **cross_platform_row["identity_candidate"],
                "candidate_platform_key": "youtube", "candidate_subplatform": "",
            },
        })
        attest_synthetic_candidate(cross_platform_row, "youtube-candidate-review")
        cross_platform_ledger = Path(temp_dir) / "google-cross-platform-youtube-items.jsonl"
        cross_platform_ledger.write_text(
            json.dumps(cross_platform_row, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        cross_platform_errors: list[str] = []
        _cross_refs, _cross_decisions, _cross_items, cross_platform_candidates, _cross_observations = _validate_item_ledger(
            cross_platform_ledger,
            prefix="targeted.cross_platform_youtube", platform_key="overseas_other",
            module_key="google_search", subject_display_name="测试对象", subject_aliases=set(),
            source_inventory={cross_platform_youtube_url}, route_origin_url=google_query,
            expected_surface="general_search", expected_origin_url=None,
            query_counts={google_query: 1}, expected_count=1, valid_group_ids=set(),
            risk_terms_sha256="0" * 64,
            account_url=None, route_started_at=None, route_completed_at=None,
            errors=cross_platform_errors,
        )
        if cross_platform_errors or cross_platform_youtube_url not in cross_platform_candidates:
            print("SELF-TEST general-search named-platform candidate routing failed")
            print("\n".join(cross_platform_errors))
            return 1
        redirect_errors: list[str] = []
        redirect_supplied = [
            {
                "platform_key": "bilibili", "input_url": "https://b23.tv/abc123",
                "canonical_url": "https://www.bilibili.com/video/BV1fixture",
                "canonicalization_route_id": "redirect-bilibili",
            },
            {
                "platform_key": "youtube", "input_url": "https://youtu.be/fixture123",
                "canonical_url": "https://www.youtube.com/@fixturevalid",
                "canonicalization_route_id": "redirect-youtube",
            },
        ]
        redirect_contexts = [
            {
                "platform_key": row["platform_key"],
                "route": {
                    "route_id": row["canonicalization_route_id"], "status": "complete",
                    "tool_kind": "microsoft_edge_visible", "linear_pass_index": 0,
                    "surface": "account_discovery", "account_or_query_url": row["input_url"],
                    "evidence_origin": row["input_url"], "resolved_url": row["canonical_url"],
                },
            }
            for row in redirect_supplied
        ]
        _validate_supplied_canonicalizations(redirect_supplied, redirect_contexts, errors=redirect_errors)
        if (
            redirect_errors
            or _named_platform_for_url("https://b23.tv/abc123") != "bilibili"
            or _named_platform_for_url("https://youtu.be/fixture123") != "youtube"
        ):
            print("SELF-TEST controlled short-link canonicalization check failed")
            print("\n".join(redirect_errors))
            return 1
        bad_score_errors: list[str] = []
        _validate_identity_candidate(
            {
                **candidate_evaluation(name_match="exact_display_name", score=999),
                "evidence_urls": [],
            },
            platform_key="youtube", candidate_url=high_url,
            visible_account_name="测试对象", subject_display_name="测试对象",
            subject_aliases={"fixturevalid"},
            source_inventory={high_url},
            prefix="targeted.identity_candidate", errors=bad_score_errors,
        )
        if not any("validator-derived score" in error for error in bad_score_errors):
            print("SELF-TEST candidate score recomputation negative check failed")
            print("\n".join(bad_score_errors))
            return 1
        bad_name_errors: list[str] = []
        _validate_identity_candidate(
            {
                **candidate_evaluation(name_match="exact_display_name"),
                "evidence_urls": [],
            },
            platform_key="youtube", candidate_url=high_url,
            visible_account_name="完全不同的账号名", subject_display_name="测试对象",
            subject_aliases={"fixturevalid"},
            source_inventory={high_url},
            prefix="targeted.identity_candidate", errors=bad_name_errors,
        )
        if not any("validator-derived match 'other'" in error for error in bad_name_errors):
            print("SELF-TEST candidate visible-name recomputation negative check failed")
            print("\n".join(bad_name_errors))
            return 1
        missing_candidate_evidence_errors: list[str] = []
        _validate_identity_candidate(
            {
                **candidate_evaluation(name_match="exact_display_name", weak_anchor="weak"),
                "evidence_urls": [],
            },
            platform_key="youtube", candidate_url=high_url,
            visible_account_name="测试对象", subject_display_name="测试对象",
            subject_aliases={"fixturevalid"}, source_inventory={high_url},
            prefix="targeted.identity_candidate", errors=missing_candidate_evidence_errors,
        )
        if not any("requires source URLs" in error for error in missing_candidate_evidence_errors):
            print("SELF-TEST candidate anchor without evidence URL negative check failed")
            print("\n".join(missing_candidate_evidence_errors))
            return 1
        x_ledger = Path(temp_dir) / "x-date-items.jsonl"
        x_ledger.write_text(json.dumps({"published_at": "2024-05-17"}) + "\n", encoding="utf-8")
        x_completion = {"route_results": [{
            "status": "complete", "module_key": "homepage",
            "account_or_query_url": "https://x.com/fixturevalid", "item_ledger_path": str(x_ledger),
        }]}
        x_errors: list[str] = []
        _validate_x_review_start_month(
            x_completion, {"https://x.com/fixturevalid"}, "2024-05",
            prefix="platforms.x.research_completion", errors=x_errors,
        )
        if x_errors:
            print("SELF-TEST X earliest-month positive check failed")
            print("\n".join(x_errors))
            return 1
        _validate_x_review_start_month(
            x_completion, {"https://x.com/fixturevalid"}, "2024-06",
            prefix="platforms.x.research_completion", errors=x_errors,
        )
        if not any("earliest reviewed X homepage item month 2024-05" in error for error in x_errors):
            print("SELF-TEST X earliest-month negative check failed")
            return 1
        print(f"SELF-TEST PASSED schema={SCHEMA_VERSION} negative_cases={len(cases)} targeted_checks=63")
        return 0


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload", nargs="?", type=Path, help="research_payload.json")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check-files", action="store_true", help="compatibility flag; file inspection is already the default")
    mode.add_argument("--structure-only", action="store_true", help="explicitly skip local evidence-file/hash inspection")
    parser.add_argument("--self-test", action="store_true", help="run built-in positive and negative tests")
    args = parser.parse_args()
    if args.self_test:
        return run_self_test()
    if args.payload is None:
        parser.error("provide a payload path or use --self-test")
    try:
        payload = json.loads(args.payload.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"INVALID cannot read payload: {exc}", file=sys.stderr)
        return 2
    errors = validate(payload, check_files=not args.structure_only)
    try:
        prose_warnings = [finding for finding in _prose_audit(payload).get("findings", [])
                          if finding.get("severity") == "warning"]
    except (OSError, ImportError, ValueError, AttributeError, KeyError, TypeError):
        prose_warnings = []  # validate() already fails closed on this error.
    for finding in prose_warnings:
        print(f"WARNING handoff_prose.{finding['path']}: {finding['rule']}: {finding['message']}")
    if prose_warnings:
        print(f"PROSE_MANUAL_REVIEW warnings={len(prose_warnings)}; not automatically cleared by QA flags")
    for error in errors:
        print(f"ERROR {error}")
    if errors:
        print(f"INVALID errors={len(errors)}")
        return 1
    print("VALID errors=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
