#!/usr/bin/env python3
"""Deterministic format audit for a single-subject Feishu background-check snapshot."""

from __future__ import annotations
import os

import argparse
import copy
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from disclaimer_gate import (DISCLAIMER_POLICY_VERSION, audit_disclaimer_review,
                             review_document_token, review_text_fingerprint)
from business_risk_gate import (audit_business_risk_review, block_location,
                                policy_source)

PLATFORMS = [
    "微博",
    "B站",
    "抖音",
    "小红书",
    "知乎",
    "网易云音乐",
    "贴吧",
    "豆瓣",
    "境内其他内容",
    "X",
    "Facebook",
    "INS",
    "油管",
    "境外其他网站",
]

SCRIPT_VERSION = "1.11.4+writing.20261030"
DOMESTIC_TAIL = "其他境内平台暂未发现相关账号或相关内容的负面及敏感信息。"
FOREIGN_TAIL = "其他境外平台暂未发现相关账号或相关内容的负面及敏感信息。"
# Read the same approved template as the uploader; synthetic fixtures remain offline-only.
_LOCAL_CONFIG = Path(os.environ.get("BACKCHECK_CONFIG_PATH") or (
    Path(os.environ.get("BACKGROUND_CHECK_WORKSPACE", str(Path(__file__).resolve().parents[3])))
    / "config" / "backcheck-local.json"
))
# Explicit self-tests/help never require a real account or approved cloud template.
TEMPLATE_TOKEN = ("OFFLINE_TEMPLATE_FIXTURE" if any(arg in sys.argv for arg in ("--self-test", "--help"))
    else json.loads(_LOCAL_CONFIG.read_text(encoding="utf-8-sig"))["template_document_token"])
if not re.fullmatch(r"[A-Za-z0-9_-]{10,128}", TEMPLATE_TOKEN) or TEMPLATE_TOKEN.startswith("SYNTHETIC"):
    raise ValueError("Configure the approved Feishu template before validation")
URL_RE = re.compile(r"https?://[^\s；。，、]+")
FULLWIDTH_NUMBER_RE = re.compile(r"^（(\d+)）")
HOME_PREFIX = r"(?:个人主页|官方主页|项目主页|疑似主页|疑似官方主页|疑似项目主页|无个人主页|无官方主页|无项目主页)"
SUSPECTED_HOME_PREFIX_RE = re.compile(r"^（\d+）(?:疑似主页|疑似官方主页|疑似项目主页)(?:\d+)?：")
OTHER_PLATFORMS = {"境内其他内容", "境外其他网站"}
NAMED_SUSPECTED_HOME_PREFIX_RE = re.compile(r"^（\d+）(.+?)(?:疑似主页|疑似官方主页|疑似项目主页)(?:\d+)?：")
X_TIME_RE = re.compile(r"^背调时间：(19|20)\d{2}年(?:[1-9]|1[0-2])月—至今$")
RESTRICTED_SOURCE_KIND = "restricted_source"
RESTRICTED_SOURCE_REASON = "minor_sexual_content_safety"
PLATFORM_REVIEW_ENTRY_SOURCE_KIND = "platform_review_entry"

# These expressions describe collection mechanics and reviewer limitations. They
# belong in the working record, never in the user-facing document. URLs are
# removed before matching so a legitimate query parameter cannot trigger this
# rule accidentally.
PROCESS_PROSE_TERMS = (
    "调查过程",
    "登录状态",
    "翻页轮次",
    "覆盖说明",
    "上滚",
    "下滚",
    "公开返回边界",
    "全量扫读",
    "未逐条完整播放",
    "以下链接为主页入口",
    "平台过程材料",
    "现有裁切图",
    "回滚复验",
    "页面失败",
    "API 调用",
    "API调用",
    "research_payload",
    "schema 校验",
    "哈希台账",
    "候选排序",
    "身份调试",
    "爬取过程",
    "抓取过程",
)
PROCESS_ASCII_TERM_RE = re.compile(r"(?<![A-Za-z0-9_])(?:href|shortcode|permalink)(?![A-Za-z0-9_])", re.IGNORECASE)

TEXT_KEYS = (
    "text",
    "heading1",
    "heading2",
    "heading3",
    "heading4",
    "heading5",
    "heading6",
    "heading7",
    "heading8",
    "heading9",
    "bullet",
    "ordered",
)

MODULE_PATTERNS: dict[str, list[str]] = {
    "微博": [rf"^（1）{HOME_PREFIX}", r"^（2）关键词搜索：", r"^（3）(?:超话/话题|无超话/话题)"],
    "B站": [rf"^（1）{HOME_PREFIX}", r"^（2）关键词搜索："],
    "抖音": [rf"^（1）{HOME_PREFIX}", r"^（2）关键词搜索："],
    "小红书": [rf"^（1）{HOME_PREFIX}", r"^（2）关键词搜索："],
    "知乎": [rf"^（1）{HOME_PREFIX}", r"^（2）关键词搜索："],
    "网易云音乐": [rf"^（1）(?:音乐人页|{HOME_PREFIX})"],
    "贴吧": [r"^（1）(?:主题贴吧|无主题贴吧)", r"^（2）关键词搜索："],
    "豆瓣": [rf"^（1）(?:豆瓣人物主页|豆瓣官方主页|豆瓣项目主页|无豆瓣人物主页|无豆瓣官方主页|无豆瓣项目主页|疑似豆瓣人物主页|疑似豆瓣官方主页|疑似豆瓣项目主页|{HOME_PREFIX})", r"^（2）关键词搜索："],
    "X": [rf"^（1）{HOME_PREFIX}", r"^（2）关键词搜索："],
    "Facebook": [rf"^（1）{HOME_PREFIX}", r"^（2）关键词搜索："],
    "INS": [rf"^（1）{HOME_PREFIX}"],
    "油管": [rf"^（1）{HOME_PREFIX}", r"^（2）关键词搜索："],
}

SEARCH_ENDINGS: dict[str, tuple[str, ...]] = {
    "微博": ("相关内容无问题", "无相关内容"),
    "B站": ("涉及的视频，专栏及其互动无问题", "无涉及的视频，专栏及其互动"),
    "抖音": ("相关内容无问题", "无相关内容"),
    "小红书": ("涉及的笔记及其互动无问题", "无涉及的笔记及其互动"),
    "知乎": ("相关内容无问题", "无相关内容"),
    "贴吧": ("涉及内容及其互动无问题", "无涉及内容及其互动"),
    "豆瓣": ("涉及的内容及其互动无问题", "无涉及的内容及其互动"),
    "境内其他内容": ("相关内容无问题", "无相关内容"),
    "X": ("涉及内容及其互动无问题", "无涉及内容及其互动"),
    "Facebook": ("相关内容无问题", "无相关内容"),
    "油管": ("相关内容无问题", "无相关内容"),
    "境外其他网站": ("相关内容无问题", "无相关内容"),
}

CHECKED_CLEAN_SEARCH = {
    "微博": "相关内容无问题",
    "B站": "涉及的视频，专栏及其互动无问题",
    "抖音": "相关内容无问题",
    "小红书": "涉及的笔记及其互动无问题",
    "知乎": "相关内容无问题",
    "贴吧": "涉及内容及其互动无问题",
    "豆瓣": "涉及的内容及其互动无问题",
    "境内其他内容": "相关内容无问题",
    "X": "涉及内容及其互动无问题",
    "Facebook": "相关内容无问题",
    "油管": "相关内容无问题",
    "境外其他网站": "相关内容无问题",
}

NO_RESULT_SEARCH = {
    "微博": "无相关内容",
    "B站": "无涉及的视频，专栏及其互动",
    "抖音": "无相关内容",
    "小红书": "无涉及的笔记及其互动",
    "知乎": "无相关内容",
    "贴吧": "无涉及内容及其互动",
    "豆瓣": "无涉及的内容及其互动",
    "境内其他内容": "无相关内容",
    "X": "无涉及内容及其互动",
    "Facebook": "无相关内容",
    "油管": "无相关内容",
    "境外其他网站": "无相关内容",
}

CHECKED_CLEAN_TOPIC = {
    "微博": "相关内容无问题",
    "贴吧": "相关内容无问题",
}

ALLOWED_FACT_EVIDENCE_TYPES = {
    "user_current_instruction",
    "research_record",
    "independent_platform_check",
}
FORBIDDEN_FACT_EVIDENCE_TYPES = {
    "document",
    "delivery_script",
    "expected_text",
    "snapshot_builder",
}

NO_HOME_EXACT = {
    "微博": "（1）无个人主页；",
    "B站": "（1）无个人主页；",
    "抖音": "（1）无个人主页；",
    "小红书": "（1）无个人主页；",
    "知乎": "（1）无个人主页；",
    "网易云音乐": "（1）无个人主页；",
    "豆瓣": "（1）无豆瓣人物主页；",
    "X": "（1）无个人主页；",
    "Facebook": "（1）无个人主页；",
    "INS": "（1）无个人主页；",
    "油管": "（1）无个人主页；",
}


def _json_from_mcp(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    if "structuredContent" in value and value["structuredContent"]:
        return _json_from_mcp(value["structuredContent"])
    if "content" in value and isinstance(value["content"], list):
        for part in value["content"]:
            if isinstance(part, dict) and part.get("type") == "text":
                try:
                    return _json_from_mcp(json.loads(part.get("text", "")))
                except json.JSONDecodeError:
                    continue
    return value


def normalize_input(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    meta = payload.get("document", {}) if isinstance(payload, dict) else {}
    review_context = payload.get("review_context") if isinstance(payload, dict) else None
    block_payload = payload.get("block_list", payload) if isinstance(payload, dict) else payload
    block_payload = _json_from_mcp(block_payload)
    if isinstance(block_payload, dict) and "data" in block_payload and isinstance(block_payload["data"], dict):
        block_payload = block_payload["data"]
    if not isinstance(block_payload, dict):
        raise ValueError("snapshot does not contain a block-list object")
    return meta, block_payload, review_context if isinstance(review_context, dict) else None


def block_payload(block: dict[str, Any]) -> dict[str, Any] | None:
    for key in TEXT_KEYS:
        value = block.get(key)
        if isinstance(value, dict):
            return value
    page = block.get("page")
    return page if isinstance(page, dict) else None


def elements(block: dict[str, Any]) -> list[dict[str, Any]]:
    payload = block_payload(block)
    value = payload.get("elements", []) if payload else []
    return value if isinstance(value, list) else []


def runs(block: dict[str, Any]) -> list[dict[str, Any]]:
    return [e["text_run"] for e in elements(block) if isinstance(e, dict) and isinstance(e.get("text_run"), dict)]


def text_of(block: dict[str, Any]) -> str:
    return "".join(str(run.get("content", "")) for run in runs(block))


def risk_highlight_links_match(
    highlight_elements: list[dict[str, Any]],
    expected_text: str,
    document_token: str,
    target_block_id: str,
    allowed_target_block_ids: set[str],
) -> bool:
    """Verify that the highlight has one exact internal destination allowed by its group."""

    if not highlight_elements or any(not isinstance(element, dict) or not isinstance(element.get("text_run"), dict) for element in highlight_elements):
        return False
    highlight_runs = [element["text_run"] for element in highlight_elements]
    if not all(isinstance(run.get("content"), str) and run["content"] for run in highlight_runs):
        return False
    if "".join(run["content"] for run in highlight_runs) != expected_text:
        return False

    actual_links = [link_url_of_run(run) for run in highlight_runs]
    expected_url = f"https://my.feishu.cn/docx/{document_token}#{target_block_id}"
    linked_urls = {url for url in actual_links if url is not None}
    return linked_urls == {expected_url} and target_block_id in allowed_target_block_ids


def _table_row_text(items_by_id: dict[str, dict[str, Any]], target_block_id: str) -> str | None:
    """Return the complete visible text of the table row containing one target text block."""

    target = items_by_id.get(target_block_id)
    if not isinstance(target, dict):
        return None
    cell = items_by_id.get(str(target.get("parent_id", "")))
    if not isinstance(cell, dict) or cell.get("block_type") != 32:
        return None
    table = items_by_id.get(str(cell.get("parent_id", "")))
    table_payload = table.get("table") if isinstance(table, dict) else None
    if not isinstance(table_payload, dict) or table.get("block_type") != 31:
        return None
    cells = table_payload.get("cells")
    property_data = table_payload.get("property")
    column_size = property_data.get("column_size") if isinstance(property_data, dict) else None
    if not isinstance(cells, list) or not isinstance(column_size, int) or column_size < 1:
        return None
    cell_id = str(cell.get("block_id", ""))
    try:
        cell_index = [str(value) for value in cells].index(cell_id)
    except ValueError:
        return None
    row_start = (cell_index // column_size) * column_size
    row_cell_ids = [str(value) for value in cells[row_start:row_start + column_size]]
    parts: list[str] = []
    pending = list(row_cell_ids)
    seen: set[str] = set()
    while pending:
        block_id = pending.pop(0)
        if block_id in seen:
            continue
        seen.add(block_id)
        block = items_by_id.get(block_id)
        if not isinstance(block, dict):
            continue
        value = text_of(block)
        if value:
            parts.append(value)
        children = block.get("children")
        if isinstance(children, list):
            pending.extend(str(child) for child in children)
    return "\n".join(parts)


def link_url_of_run(run: dict[str, Any]) -> str | None:
    style = run.get("text_element_style")
    link = style.get("link") if isinstance(style, dict) else None
    url = link.get("url") if isinstance(link, dict) else None
    return url if isinstance(url, str) else None


def is_blank_text(block: dict[str, Any]) -> bool:
    return block.get("block_type") == 2 and text_of(block) == ""


def _url_parts(value: str) -> tuple[str, str, dict[str, list[str]], str] | None:
    """Return normalized URL parts used by contract checks."""

    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return None
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return None
    host = parsed.hostname.lower()
    if host.startswith("www."):
        host = host[4:]
    path = unquote(parsed.path or "/").rstrip("/") or "/"
    return host, path, parse_qs(parsed.query, keep_blank_values=True), unquote(parsed.fragment or "")


def _url_route_key(value: str) -> tuple[str, str] | None:
    parts = _url_parts(value)
    if parts is None:
        return None
    host, path, _, _ = parts
    return host, path.casefold()


def _is_search_url(value: str) -> bool:
    parts = _url_parts(value)
    if parts is None:
        return False
    host, path, query, _ = parts
    lower_path = path.casefold()
    segments = [segment for segment in lower_path.split("/") if segment]
    if host == "s.weibo.com" or any(segment in {"search", "search_result", "search-results", "find"} for segment in segments):
        return True
    search_keys = {"q", "query", "keyword", "search_query", "search_keyword", "wd"}
    return bool(search_keys.intersection(key.casefold() for key in query)) and "search" in lower_path


def _read_index_json_locator(locator: Any) -> tuple[Any, dict[str, Any]]:
    """仅读已声明的绝对本地 JSON 与严格 JSON Pointer；不联网、不执行内容。"""
    if not isinstance(locator, str) or not locator or locator != locator.strip():
        raise ValueError("locator must be an exact non-empty string")
    filename, separator, pointer = locator.partition("#")
    path = Path(filename)
    if not path.is_absolute() or path.suffix.lower() != ".json" or not path.is_file():
        raise ValueError("locator must resolve to an existing absolute JSON file")
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("index source JSON exceeds the 2 MiB read bound")
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError("index source root must be an object")
    value: Any = document
    if separator and pointer:
        if not pointer.startswith("/") or re.search(r"~(?![01])", pointer):
            raise ValueError("source fragment must be a strict JSON Pointer")
        for segment in pointer[1:].split("/"):
            key = segment.replace("~1", "/").replace("~0", "~")
            if isinstance(value, list):
                if not re.fullmatch(r"0|[1-9][0-9]*", key):
                    raise ValueError("invalid array index in source pointer")
                value = value[int(key)]
            elif isinstance(value, dict):
                value = value[key]
            else:
                raise ValueError("source pointer does not resolve")
    return value, document


def _restricted_local_file(value: Any, suffixes: set[str], max_bytes: int) -> Path:
    """Resolve one bounded task-local evidence file without following it outside BACKGROUND_CHECK_WORKSPACE."""
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError("evidence path must be an exact non-empty string")
    path = Path(value)
    if not path.is_absolute() or path.suffix.lower() not in suffixes:
        raise ValueError("evidence path has an unsupported location or suffix")
    resolved = path.resolve(strict=True)
    root = Path(os.environ["BACKGROUND_CHECK_WORKSPACE"]).resolve(strict=True)
    if resolved != root and root not in resolved.parents:
        raise ValueError(f"evidence path must stay under {root}")
    if not resolved.is_file() or resolved.stat().st_size > max_bytes:
        raise ValueError("evidence file is missing or exceeds its read bound")
    return resolved


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validated_restricted_source(platform: str, risk_item: dict[str, Any],
                                 modules: list[dict[str, Any]], reviewer_id: Any) -> tuple[bool, str, str | None]:
    """Validate a local-only X source whose public link would expose sexualized-minor content."""
    if platform != "X" or risk_item.get("source_kind") != RESTRICTED_SOURCE_KIND:
        return False, "restricted-source handling is registered only for X", None
    if risk_item.get("url") not in (None, ""):
        return False, "restricted-source risk items must not publish or carry a URL", None
    proof = risk_item.get("restricted_source")
    required = {
        "reason", "record_path", "record_sha256", "direct_url_sha256",
        "original_image_path", "original_image_sha256", "safe_image_path",
        "safe_image_sha256", "reviewer_id", "checked_at",
    }
    if not isinstance(proof, dict) or not required.issubset(proof):
        return False, "complete restricted_source evidence metadata is required", None
    if proof.get("reason") != RESTRICTED_SOURCE_REASON:
        return False, "only the registered minor-sexual-content safety reason is supported", None
    if not isinstance(reviewer_id, str) or not reviewer_id or proof.get("reviewer_id") != reviewer_id:
        return False, "restricted source reviewer must match the current review context", None
    try:
        timestamp = datetime.fromisoformat(str(proof.get("checked_at", "")).replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError("timezone required")
    except ValueError:
        return False, "restricted source checked_at must be ISO-8601 with timezone", None
    hashes = (
        proof.get("record_sha256"), proof.get("direct_url_sha256"),
        proof.get("original_image_sha256"), proof.get("safe_image_sha256"),
    )
    if any(not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None for value in hashes):
        return False, "all restricted source hashes must be lowercase SHA-256", None
    try:
        record_path = _restricted_local_file(proof.get("record_path"), {".json"}, 2 * 1024 * 1024)
        original_path = _restricted_local_file(
            proof.get("original_image_path"), {".jpg", ".jpeg", ".png", ".webp"}, 10 * 1024 * 1024)
        safe_path = _restricted_local_file(
            proof.get("safe_image_path"), {".jpg", ".jpeg", ".png", ".webp"}, 10 * 1024 * 1024)
        if _file_sha256(record_path) != proof["record_sha256"]:
            return False, "restricted source record hash mismatch", None
        if _file_sha256(original_path) != proof["original_image_sha256"]:
            return False, "restricted original image hash mismatch", None
        if _file_sha256(safe_path) != proof["safe_image_sha256"]:
            return False, "restricted safe image hash mismatch", None
        if proof["original_image_sha256"] == proof["safe_image_sha256"]:
            return False, "safe image must be a distinct redacted derivative", None
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as exc:
        return False, "restricted source files cannot be verified: " + str(exc), None
    if not isinstance(record, dict):
        return False, "restricted source record must be a JSON object", None
    direct_url = record.get("source_url")
    if not isinstance(direct_url, str) or not _is_direct_content_url("X", direct_url):
        return False, "restricted record must contain one direct X status URL", None
    if hashlib.sha256(direct_url.encode("utf-8")).hexdigest() != proof["direct_url_sha256"]:
        return False, "restricted direct URL hash mismatch", None
    if (record.get("account_status") != "confirmed"
            or record.get("content_type") not in {"post", "reply"}
            or record.get("report_summary") != risk_item.get("fact_text")):
        return False, "restricted record must bind confirmed attribution and the exact safe report fact", None
    record_date = record.get("date")
    try:
        parsed_date = datetime.strptime(str(record_date), "%Y-%m-%d")
        date_marker = f"{parsed_date.year}年{parsed_date.month}月{parsed_date.day}日"
    except (ValueError, TypeError):
        return False, "restricted record date must be YYYY-MM-DD", None
    if date_marker not in str(risk_item.get("fact_text", "")):
        return False, "safe report fact must retain the restricted source date", None
    if (Path(str(record.get("screenshot", ""))).resolve() != original_path
            or Path(str(record.get("safe_screenshot", ""))).resolve() != safe_path):
        return False, "restricted record image paths do not match the declared original and safe files", None
    declared: set[str] = set()
    for module in modules:
        if not isinstance(module, dict):
            continue
        evidence = module.get("fact_evidence")
        if not isinstance(evidence, dict):
            continue
        if isinstance(evidence.get("source_locator"), str):
            declared.add(evidence["source_locator"])
        for source in evidence.get("source_locators", []) if isinstance(evidence.get("source_locators"), list) else []:
            if isinstance(source, dict) and isinstance(source.get("locator"), str):
                declared.add(source["locator"])
    declared_record = False
    for locator in declared:
        try:
            if Path(locator).resolve(strict=True) == record_path:
                declared_record = True
                break
        except (OSError, ValueError):
            continue
    if not declared_record:
        return False, "the restricted source record must be declared by the actual X module evidence", None
    return True, "restricted local evidence and safe public derivative verified", direct_url


def _validated_platform_review_entry(platform: str, risk_item: dict[str, Any],
                                     modules: list[dict[str, Any]], reviewer_id: Any) -> tuple[bool, str]:
    """Validate one public review entry when the platform exposes only a stable reviews-page URL."""

    if platform != "Facebook" or risk_item.get("source_kind") != PLATFORM_REVIEW_ENTRY_SOURCE_KIND:
        return False, "platform_review_entry is registered only for Facebook"
    risk_url = risk_item.get("url")
    try:
        parsed = urlsplit(risk_url) if isinstance(risk_url, str) else None
        if (parsed is None or parsed.scheme != "https" or parsed.username is not None
                or parsed.password is not None or parsed.port not in (None, 443)
                or (parsed.hostname or "").lower() not in {"facebook.com", "www.facebook.com"}
                or re.fullmatch(r"/[A-Za-z0-9._-]+/reviews/?", parsed.path or "") is None
                or parsed.query or parsed.fragment or risk_url != risk_url.strip()):
            return False, "an exact public Facebook Page reviews URL is required"
    except ValueError:
        return False, "invalid Facebook reviews URL"
    proof = risk_item.get("review_entry_evidence")
    required = {"record_path", "record_sha256", "screenshot_path", "screenshot_sha256",
                "reviewer_id", "checked_at"}
    if not isinstance(proof, dict) or not required.issubset(proof):
        return False, "complete review_entry_evidence metadata is required"
    if not isinstance(reviewer_id, str) or not reviewer_id or proof.get("reviewer_id") != reviewer_id:
        return False, "review entry reviewer must match the current review context"
    try:
        timestamp = datetime.fromisoformat(str(proof.get("checked_at", "")).replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError("timezone required")
    except ValueError:
        return False, "review entry checked_at must be ISO-8601 with timezone"
    for key in ("record_sha256", "screenshot_sha256"):
        if not isinstance(proof.get(key), str) or re.fullmatch(r"[0-9a-f]{64}", proof[key]) is None:
            return False, "review entry hashes must be lowercase SHA-256"
    try:
        record_path = _restricted_local_file(proof.get("record_path"), {".json"}, 2 * 1024 * 1024)
        screenshot_path = _restricted_local_file(
            proof.get("screenshot_path"), {".jpg", ".jpeg", ".png", ".webp"}, 10 * 1024 * 1024)
        if _file_sha256(record_path) != proof["record_sha256"]:
            return False, "review entry record hash mismatch"
        if _file_sha256(screenshot_path) != proof["screenshot_sha256"]:
            return False, "review entry screenshot hash mismatch"
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as exc:
        return False, "review entry evidence cannot be verified: " + str(exc)
    record_required = {"page_url", "author", "published_at", "text", "screenshot_path", "screenshot_sha256"}
    if not isinstance(record, dict) or not record_required.issubset(record):
        return False, "review entry record must contain page, author, date, text, and screenshot fields"
    if record.get("page_url") != risk_url:
        return False, "review entry record page URL does not match the displayed reviews URL"
    if (not isinstance(record.get("author"), str) or not record["author"].strip()
            or not isinstance(record.get("text"), str) or len(record["text"].strip()) < 10):
        return False, "review entry author and exact public text are required"
    try:
        published = datetime.strptime(str(record.get("published_at", "")), "%Y-%m-%d")
    except ValueError:
        return False, "review entry published_at must be YYYY-MM-DD"
    date_marker = f"{published.year}年{published.month}月{published.day}日"
    if date_marker not in str(risk_item.get("fact_text", "")):
        return False, "review risk fact must retain the entry date"
    try:
        if (Path(str(record.get("screenshot_path", ""))).resolve(strict=True) != screenshot_path
                or record.get("screenshot_sha256") != proof["screenshot_sha256"]):
            return False, "review entry screenshot fields do not match the declared file"
    except (OSError, ValueError):
        return False, "review entry screenshot path cannot be resolved"
    declared: set[str] = set()
    for module in modules:
        if not isinstance(module, dict):
            continue
        evidence = module.get("fact_evidence")
        if not isinstance(evidence, dict):
            continue
        if isinstance(evidence.get("source_locator"), str):
            declared.add(evidence["source_locator"])
        for source in evidence.get("source_locators", []) if isinstance(evidence.get("source_locators"), list) else []:
            if isinstance(source, dict) and isinstance(source.get("locator"), str):
                declared.add(source["locator"])
    if str(record_path) not in declared:
        return False, "the review entry record must be declared by the actual Facebook module evidence"
    return True, "content-bound Facebook review entry evidence verified"


def _validated_search_index_summary(platform: str, risk_item: dict[str, Any],
                                    modules: list[dict[str, Any]]) -> tuple[bool, str]:
    """仅登记已观察的百度索引→BOOTH private 店根证据；普通主页仍不是原帖。"""
    if platform != "境内其他内容" or risk_item.get("source_kind") != "search_index_summary":
        return False, "only the registered domestic Baidu index-summary kind is supported"
    proof = risk_item.get("search_index_evidence")
    if not isinstance(proof, dict) or proof.get("scope") != "index_only" or proof.get("current_product_details_unread") is not True:
        return False, "explicit index-only evidence with unread current product details is required"
    risk_url = risk_item.get("url")
    try:
        parsed = urlsplit(risk_url) if isinstance(risk_url, str) else None
        if (parsed is None or parsed.scheme != "https" or parsed.username is not None
                or parsed.password is not None or parsed.port not in (None, 443)
                or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.booth\.pm", parsed.hostname or "")
                or parsed.hostname == "www.booth.pm"
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or risk_url != risk_url.strip()):
            return False, "only an exact HTTPS/default-port BOOTH shop root is registered"
    except ValueError:
        return False, "invalid indexed destination URL"
    fact = risk_item.get("fact_text")
    if (not isinstance(fact, str) or not fact.startswith("百度检索摘要") or "BOOTH" not in fact
            or not fact.endswith("；该店当前为非公开状态。")
            or re.search(r"当前商品|商品详情|商品页面|现售|正在(?:出售|销售)|可(?:购买|下单)|已(?:读取|查看|核实).*(?:详情|商品页)", fact)):
        return False, "fact must identify the Baidu summary/private shop without claiming current product details"
    locator_names = ("query_record_locator", "destination_record_locator", "private_record_locator")
    locators = [risk_item.get("source_locator")] + [proof.get(name) for name in locator_names]
    if any(not isinstance(value, str) or not value.strip() for value in locators) or len(set(locators)) != 4:
        return False, "four distinct traceable index/query/destination/private JSON locators are required"
    declared: set[str] = set()
    search_modules: list[dict[str, Any]] = []
    for module in modules:
        if not isinstance(module, dict) or "百度关键词搜索：" not in str(module.get("text", "")):
            continue
        evidence = module.get("fact_evidence")
        if not isinstance(evidence, dict):
            continue
        search_modules.append(module)
        if isinstance(evidence.get("source_locator"), str):
            declared.add(evidence["source_locator"])
        for source in evidence.get("source_locators", []) if isinstance(evidence.get("source_locators"), list) else []:
            if isinstance(source, dict) and isinstance(source.get("locator"), str):
                declared.add(source["locator"])
    if not all(locator in declared for locator in locators):
        return False, "each source locator must be independently declared by the actual Baidu module"
    try:
        native, native_root = _read_index_json_locator(locators[0])
        query_record, _ = _read_index_json_locator(locators[1])
        destination, _ = _read_index_json_locator(locators[2])
        private_text, private_root = _read_index_json_locator(locators[3])
    except (OSError, UnicodeError, ValueError, KeyError, IndexError, TypeError) as exc:
        return False, "source JSON cannot be verified: " + str(exc)
    excerpt, claim = proof.get("excerpt"), proof.get("index_claim_literal")
    if (native_root.get("ok") is not True or not isinstance(native, dict)
            or not isinstance(excerpt, str) or len(excerpt) < 30 or native.get("text") != excerpt
            or not isinstance(claim, str) or len(claim) < 8 or claim not in excerpt
            or claim in {parsed.hostname, risk_url}):
        return False, "native index excerpt and meaningful literal claim must match the actual source exactly"
    host_pattern = r"(?<![A-Za-z0-9.-])" + re.escape(parsed.hostname or "") + r"/(?=$|\s)"
    if re.search(host_pattern, excerpt, re.IGNORECASE) is None:
        return False, "the observed index excerpt must display this exact destination host"
    if not isinstance(query_record, dict) or not isinstance(query_record.get("cards"), list):
        return False, "actual parsed query/title/cards record is required"
    query_matched = False
    for module in search_modules:
        for query_url in URL_RE.findall(str(module.get("text", ""))):
            try:
                query_parts = urlsplit(query_url)
                query_values = parse_qs(query_parts.query).get("wd", [])
                if (query_parts.scheme == "https" and query_parts.hostname in {"baidu.com", "www.baidu.com"}
                        and query_parts.username is None and query_parts.password is None
                        and query_parts.port in (None, 443) and query_parts.path == "/s"
                        and not query_parts.fragment and len(query_values) == 1 and query_values[0]
                        and query_record.get("title") == query_values[0] + "_百度搜索"):
                    query_matched = True
            except ValueError:
                continue
    if not query_matched:
        return False, "the actual Baidu query title must match the module's exact wd query"
    observed_card = False
    for card in query_record["cards"]:
        if not isinstance(card, dict) or card.get("text") != excerpt or not card.get("title"):
            continue
        try:
            outgoing = urlsplit(card.get("url", ""))
            if (outgoing.scheme in {"http", "https"} and outgoing.hostname in {"baidu.com", "www.baidu.com"}
                    and outgoing.username is None and outgoing.password is None
                    and outgoing.port in (None, 80 if outgoing.scheme == "http" else 443)
                    and outgoing.path == "/link" and not outgoing.fragment
                    and parse_qs(outgoing.query).get("url")):
                observed_card = True
        except ValueError:
            continue
    if not observed_card:
        return False, "matching original index card and its observed Baidu outgoing link are required"
    if (not isinstance(destination, dict) or destination.get("indexedShop") != risk_url
            or destination.get("nativeIndexTextVerified") is not True
            or destination.get("privateShopAndItemBoundaryVerified") is not True
            or destination.get("currentProductDetailsClaimed") is not False):
        return False, "independent destination/boundary record must match this URL and index-only scope"
    private_value = private_root.get("value")
    if (private_root.get("ok") is not True or not isinstance(private_value, dict)
            or private_value.get("found") is not True or private_value.get("truncated") is not False
            or not isinstance(private_text, str) or "Currently, this shop is private." not in private_text):
        return False, "actual untruncated BOOTH private-page text is required"
    return True, "registered index-only source verified; ordinary direct-post checks remain unchanged"


def _is_bilibili_public_list_source_url(value: str) -> bool:
    """Register only official HTTPS/default-port bangumi and favorite lists."""

    if not isinstance(value, str) or value != value.strip() or any(ord(char) < 32 for char in value):
        return False
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return False
    return bool(
        parsed.scheme.lower() == "https"
        and parsed.netloc.lower() in {"space.bilibili.com", "space.bilibili.com:443"}
        and parsed.hostname == "space.bilibili.com"
        and port in {None, 443}
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment
        and re.fullmatch(r"/[0-9]+/(?:bangumi|favlist)/?", parsed.path)
    )


def _is_profile_or_home_url(platform: str, value: str) -> bool:
    parts = _url_parts(value)
    if parts is None:
        return False
    host, path, query, _ = parts
    lower_path = path.casefold()
    if lower_path == "/":
        return True
    if platform == "微博":
        return bool(re.fullmatch(r"/(?:u/)?\d+", lower_path)) or lower_path.startswith("/profile/")
    if platform == "B站":
        return (host == "space.bilibili.com" and not _is_bilibili_public_list_source_url(value)) or lower_path.startswith("/space/")
    if platform == "抖音":
        return lower_path.startswith("/user/")
    if platform == "小红书":
        return host == "xiaohongshu.com" and bool(re.fullmatch(r"/user/profile/[^/]+", lower_path))
    if platform == "知乎":
        return lower_path.startswith("/people/") or lower_path.startswith("/org/")
    if platform == "网易云音乐":
        return lower_path in {"/artist", "/user/home"} or lower_path.startswith("/artist/")
    if platform == "贴吧":
        return lower_path.startswith("/f") or lower_path.startswith("/home/")
    if platform == "豆瓣":
        return bool(re.fullmatch(r"/(?:people|group)/[^/]+", lower_path))
    if platform == "X":
        return "/status/" not in lower_path
    if platform == "Facebook":
        if lower_path in {"/profile.php", "/pages", "/groups"}:
            return True
        return len([part for part in lower_path.split("/") if part]) == 1 and not query.get("story_fbid")
    if platform == "INS":
        return not re.match(r"^/(?:[^/]+/)?(?:p|reel|tv)/[^/]+", lower_path)
    if platform == "油管":
        return lower_path.startswith(("/@", "/channel/", "/c/", "/user/"))
    return lower_path in {"/home", "/index", "/index.html"} or lower_path.startswith(("/profile/", "/user/", "/users/", "/author/", "/about"))


def _is_direct_content_url(platform: str, value: str) -> bool:
    """Recognize registered public evidence URLs for a risk item."""

    parts = _url_parts(value)
    if parts is None or _is_search_url(value) or _is_profile_or_home_url(platform, value):
        return False
    host, path, query, fragment = parts
    lower_path = path.casefold()
    if platform == "微博":
        return bool(
            re.fullmatch(r"/detail/\d+", lower_path)
            or re.fullmatch(r"/status/\d+", lower_path)
            or re.fullmatch(r"/(?:u/)?\d+/[a-z0-9]+", lower_path)
        )
    if platform == "B站":
        return bool(
            _is_bilibili_public_list_source_url(value)
            or (host == "t.bilibili.com" and re.fullmatch(r"/\d+", lower_path))
            or re.match(r"^/(?:opus|video)/[^/]+", lower_path)
            or re.match(r"^/read/(?:cv)?\d+", lower_path)
            or re.match(r"^/audio/au\d+", lower_path)
        )
    if platform == "抖音":
        return bool(re.match(r"^/(?:video|note)/[^/]+", lower_path))
    if platform == "小红书":
        return host == "xiaohongshu.com" and bool(
            re.fullmatch(r"/user/profile/[0-9a-f]{24}/[0-9a-f]{24}", lower_path)
            or re.match(r"^/(?:explore|discovery/item)/[^/]+", lower_path)
        )
    if platform == "知乎":
        return bool(
            re.match(r"^/question/\d+(?:/answer/\d+)?", lower_path)
            or re.match(r"^/(?:p|zvideo)/\d+", lower_path)
        )
    if platform == "网易云音乐":
        combined = f"{lower_path}#{fragment.casefold()}"
        return any(marker in combined for marker in ("/song", "/event", "/mv", "/program")) and (bool(query) or "?" in fragment)
    if platform == "贴吧":
        return bool(re.match(r"^/p/\d+", lower_path))
    if platform == "豆瓣":
        return bool(re.match(r"^/(?:subject|review|note)/\d+", lower_path) or re.match(r"^/(?:group/topic|people/[^/]+/status)/\d+", lower_path))
    if platform == "X":
        return bool(re.search(r"/status/\d+(?:/|$)", lower_path))
    if platform == "Facebook":
        return bool(
            re.search(r"/(?:posts|photos|videos|reel|watch|share/[pv])(?:/|$)", lower_path)
            or lower_path in {"/story.php", "/permalink.php", "/photo.php"} and bool({"story_fbid", "fbid", "v"}.intersection(query))
        )
    if platform == "INS":
        return bool(re.match(r"^/(?:[^/]+/)?(?:p|reel|tv)/[^/]+", lower_path))
    if platform == "油管":
        return bool((lower_path == "/watch" and query.get("v")) or re.match(r"^/(?:shorts|live)/[^/]+", lower_path))
    # Other-site risks may be news or article URLs with site-specific routes.
    # Reject obvious roots/profiles/searches above, then require a real path.
    return lower_path != "/" and bool([part for part in lower_path.split("/") if part])


def layout_fingerprint(items: list[dict[str, Any]]) -> str:
    """Hash structure and visual styles while ignoring text and link targets."""

    records: list[dict[str, Any]] = []
    for block in sorted(items, key=lambda value: str(value.get("block_id", ""))):
        record: dict[str, Any] = {
            "block_id": str(block.get("block_id", "")),
            "block_type": block.get("block_type"),
            "parent_id": str(block.get("parent_id", "")),
            "children": [str(value) for value in block.get("children", [])],
        }
        payload = block_payload(block)
        if payload:
            record["block_style"] = payload.get("style", {})
            run_styles = []
            for element in elements(block):
                if not isinstance(element, dict) or not isinstance(element.get("text_run"), dict):
                    continue
                style = copy.deepcopy(element["text_run"].get("text_element_style", {}))
                if isinstance(style, dict) and "link" in style:
                    style["link"] = bool(style["link"])
                run_styles.append(style)
            record["run_styles"] = run_styles
        for key in ("callout", "grid", "grid_column", "image", "divider"):
            if isinstance(block.get(key), dict):
                record[key] = block[key]
        records.append(record)
    payload = json.dumps(records, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def jump_fingerprint(items: list[dict[str, Any]], token: str, source_block_id: str, target_block_id: str) -> str:
    """Bind a live jump observation to its anchor, destination and local tree paths.

    Unrelated text edits do not invalidate an observation. Anchor text/href,
    source/target placement and ancestor display structure do.
    """
    by_id = {str(block.get("block_id", "")): block for block in items}
    parents = {str(child): str(block.get("block_id", "")) for block in items for child in block.get("children", [])}

    def path(block_id: str) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        seen: set[str] = set()
        while block_id in by_id and block_id not in seen:
            seen.add(block_id)
            block = by_id[block_id]
            parent_id = parents.get(block_id, str(block.get("parent_id", "")))
            siblings = [str(child) for child in by_id.get(parent_id, {}).get("children", [])]
            record: dict[str, Any] = {"block_id": block_id, "block_type": block.get("block_type"), "parent_id": parent_id,
                                      "index": siblings.index(block_id) if block_id in siblings else None}
            payload = block_payload(block) or {}
            record["style"] = payload.get("style", {})
            record["run_styles"] = [run.get("text_element_style", {}) for run in runs(block)]
            for key in ("callout", "grid", "grid_column"):
                if key in block:
                    record[key] = block[key]
            result.append(record)
            block_id = parent_id
        return result

    source = by_id.get(source_block_id, {})
    binding = {"token": token, "source": path(source_block_id), "target": path(target_block_id),
               "anchor_text": text_of(source), "hrefs": [link_url_of_run(run) for run in runs(source)]}
    return hashlib.sha256(json.dumps(binding, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def audit_internal_jump(items: list[dict[str, Any]], token: str, source_block_id: str,
                        target_block_id: str, jump_checks: Any) -> list[dict[str, Any]]:
    """Validate an actual live/user-confirmed jump; no screenshots/package required."""
    location = f"review_context.visual_check.jump_checks[{source_block_id}]"
    issues: list[dict[str, Any]] = []

    def blocked(code: str, actual: Any, expected: str) -> None:
        issues.append({"code": code, "location": location, "actual": actual, "expected": expected})

    matches = [record for record in jump_checks if isinstance(record, dict) and record.get("source_block_id") == source_block_id] if isinstance(jump_checks, list) else []
    if len(matches) != 1:
        blocked("INTERNAL_JUMP_REQUIRED", len(matches), "one actual jump observation for this existing risk link")
        return issues
    record = matches[0]
    expected_fingerprint = jump_fingerprint(items, token, source_block_id, target_block_id)
    if record.get("token") != token or record.get("target_block_id") != target_block_id or record.get("jump_fingerprint") != expected_fingerprint:
        blocked("INTERNAL_JUMP_BINDING", {key: record.get(key) for key in ("token", "target_block_id", "jump_fingerprint")},
                f"current token={token}, target={target_block_id}, jump_fingerprint={expected_fingerprint}")
    if record.get("method") not in {"live_page", "user_confirmation"} or record.get("target_visible") is not True:
        blocked("INTERNAL_JUMP_VISIBLE", {key: record.get(key) for key in ("method", "target_visible")},
                "live_page or user_confirmation after actual click and visible expanded target body")
    try:
        timestamp = datetime.fromisoformat(str(record.get("checked_at", "")).replace("Z", "+00:00"))
        valid_time = timestamp.tzinfo is not None
    except ValueError:
        valid_time = False
    if not valid_time:
        blocked("INTERNAL_JUMP_TIME", record.get("checked_at"), "actual observation time in ISO-8601 with timezone")
    return issues


def _search_result_count_issue(evidence: dict[str, Any], status: str) -> tuple[str, str] | None:
    """只校验当前查询模块的零/有相关分支；其他路线内容不并入该查询计数。"""
    minimum_keys = (
        "related_result_count_verified_minimum",
        "related_result_count_exact_total_unknown",
        "related_result_count_minimum_source_locator",
    )
    if any(key in evidence for key in minimum_keys):
        # 新字段必须成组显式提供；旧 min/related_total_unknown 不自动迁移。
        if "related_result_count" not in evidence or evidence["related_result_count"] is not None:
            return ("SEARCH_RESULT_COUNT", "verified-minimum mode requires explicit related_result_count=null")
        if status not in {"checked_clean", "risk"}:
            return ("EVIDENCE_STATUS_MISMATCH", "no_result requires exact related_result_count=0; a minimum cannot prove zero")
        minimum = evidence.get("related_result_count_verified_minimum")
        if type(minimum) is not int or minimum < 1:
            return ("SEARCH_RESULT_COUNT", "related_result_count_verified_minimum must be a positive integer, excluding bool")
        if evidence.get("related_result_count_exact_total_unknown") is not True:
            return ("SEARCH_RESULT_COUNT", "related_result_count_exact_total_unknown must be literal true")
        locator = evidence.get("related_result_count_minimum_source_locator")
        if not isinstance(locator, str) or not locator.strip():
            return ("SEARCH_RESULT_COUNT", "verified minimum requires a non-empty independent current-task source locator")
        declared_locators = {evidence.get("source_locator")} if isinstance(evidence.get("source_locator"), str) else set()
        for source in evidence.get("source_locators", []) if isinstance(evidence.get("source_locators"), list) else []:
            if isinstance(source, dict) and isinstance(source.get("locator"), str):
                declared_locators.add(source["locator"])
        if locator not in declared_locators:
            return ("SEARCH_RESULT_COUNT", "minimum source locator must match source_locator or an explicitly declared source_locators[].locator")
        return None
    related_count = evidence.get("related_result_count")
    if type(related_count) is not int or related_count < 0:
        return ("SEARCH_RESULT_COUNT", "exact related_result_count must be an integer >= 0, excluding bool")
    if status == "no_result" and related_count != 0:
        return ("EVIDENCE_STATUS_MISMATCH", "no_result requires related_result_count=0")
    if status in {"checked_clean", "risk"} and related_count < 1:
        return ("EVIDENCE_STATUS_MISMATCH", "checked_clean/risk requires at least one related result when the platform has a separate no-result branch")
    return None


def _is_suspected_home_module(platform: str, module_text: str, module: dict[str, Any]) -> bool:
    if SUSPECTED_HOME_PREFIX_RE.match(module_text) is not None:
        return True
    if platform not in OTHER_PLATFORMS:
        return False
    name = module.get("platform_name")
    if (not isinstance(name, str) or not name.strip() or name != name.strip()
            or len(name) > 40 or re.fullmatch(r"[\w .&+\-]+", name) is None
            or any(word in name for word in ("主页", "疑似", "关键词搜索"))):
        return False
    return re.match(
        rf"^（\d+）{re.escape(name)}(?:疑似主页|疑似官方主页|疑似项目主页)(?:\d+)?：",
        module_text,
    ) is not None


def _empty_topic_evidence_issue(evidence: dict[str, Any], module_text: str) -> tuple[str, str] | None:
    """现存空超话仍是已发现主题；精确空内容结论必须有独立的双分类检查。"""
    count = evidence.get("related_topic_count")
    if type(count) is not int or count < 1:
        return ("EMPTY_TOPIC_EVIDENCE", "an existing topic requires exact related_topic_count>=1, excluding bool")
    content_count = evidence.get("topic_content_count")
    if type(content_count) is not int or content_count < 0:
        return ("EMPTY_TOPIC_EVIDENCE", "empty existing topic requires exact topic_content_count=0, excluding bool")
    if content_count != 0:
        return ("EMPTY_TOPIC_CONTENT_CONFLICT", "暂无帖子 contradicts a positive topic_content_count")
    surfaces = evidence.get("topic_surface_states")
    if not isinstance(surfaces, dict) or surfaces != {"hot": "empty", "latest": "empty"}:
        return ("EMPTY_TOPIC_EVIDENCE", "actual hot and latest topic surfaces must both be checked empty")
    match = URL_RE.search(module_text)
    query_urls = evidence.get("query_urls")
    if match is None or not isinstance(query_urls, list) or match.group(0) not in query_urls:
        return ("EMPTY_TOPIC_EVIDENCE", "the visible topic URL must match an actually checked query_urls entry")
    if module_text != f"（3）超话/话题：{match.group(0)} 暂无帖子，无问题":
        return ("EMPTY_TOPIC_TEXT", "exact existing-empty topic sentence without additional claims")
    return None


def _verified_user_waived_search(module: dict[str, Any], payload: dict[str, Any],
                                 is_search: bool) -> bool:
    """只豁免实际未查且有同批用户原话来源的搜索 URL；主页不适用。"""
    if (not is_search or module.get("status") != "not_applicable"
            or module.get("scope_waived") is not True
            or module.get("actually_searched") is not False):
        return False
    evidence = module.get("fact_evidence")
    if not isinstance(evidence, dict) or evidence.get("source_type") != "user_current_instruction":
        return False
    quote = evidence.get("quote")
    request_id = payload.get("requestId")
    if (not isinstance(quote, str) or not quote.strip()
            or not isinstance(request_id, str) or not request_id.strip()):
        return False
    try:
        value, source = _read_index_json_locator(evidence.get("source_locator"))
    except (OSError, ValueError, KeyError, IndexError, TypeError, RecursionError):
        return False
    if source.get("requestId") != request_id:
        return False
    # quote 必须在声明的实际来源节点中逐字出现，不能仅靠输入自报非空。
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str) and item == quote:
            return True
        if isinstance(item, dict):
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
    return False


def audit(payload: dict[str, Any]) -> dict[str, Any]:
    if (payload.get("review_context") or {}).get("document_mode") == "team_merge":
        from team_merge_audit import audit_team
        return audit_team(payload, audit, globals())
    errors: list[dict[str, str]] = []
    blocked: list[dict[str, str]] = []
    info: list[str] = []

    def fail(code: str, location: str, actual: Any, expected: str) -> None:
        errors.append({"code": code, "location": location, "actual": str(actual), "expected": expected})

    def mark_blocked(code: str, location: str, actual: Any, expected: str) -> None:
        blocked.append({"code": code, "location": location, "actual": str(actual), "expected": expected})

    try:
        meta, data, review_context = normalize_input(payload)
    except ValueError as exc:
        return {"schema_version": 1, "script_version": SCRIPT_VERSION, "verdict": "BLOCKED", "blocked": [{"code": "INPUT", "location": "snapshot", "actual": str(exc), "expected": "complete Feishu block list"}], "errors": [], "info": []}

    if data.get("has_more") is not False:
        mark_blocked("API_PAGINATION", "block_list", data.get("has_more"), "has_more=false after complete pagination")

    items = data.get("items")
    if not isinstance(items, list) or not items:
        mark_blocked("API_ITEMS", "block_list", type(items).__name__, "non-empty items array")
        return {"schema_version": 1, "script_version": SCRIPT_VERSION, "verdict": "BLOCKED", "blocked": blocked, "errors": errors, "info": info}
    current_layout_fingerprint = layout_fingerprint(items)

    if review_context is None:
        mark_blocked("REVIEW_CONTEXT", "review_context", "missing", "subject_type, stable revisions, 14 platform expectations, and risk_groups")
        review_context = {}
    disclaimer_result = audit_disclaimer_review(meta, items, payload.get("raw_content"), review_context.get("disclaimer_review"))
    errors.extend(disclaimer_result["errors"])
    blocked.extend(disclaimer_result["blocked"])
    info.extend(disclaimer_result["info"])
    subject_type = review_context.get("subject_type")
    if subject_type not in {"person", "organization", "project"}:
        mark_blocked("SUBJECT_TYPE", "review_context.subject_type", subject_type, "person, organization, or project")
    revision_id = meta.get("revision_id")
    before_revision = review_context.get("before_revision")
    after_revision = review_context.get("after_revision")
    if revision_id is None or before_revision is None or after_revision is None:
        mark_blocked("REVISION_CONTEXT", "review_context", {"document": revision_id, "before": before_revision, "after": after_revision}, "three present and identical revision ids")
    elif not (revision_id == before_revision == after_revision):
        mark_blocked("REVISION_CHANGED", "review_context", {"document": revision_id, "before": before_revision, "after": after_revision}, "three identical revision ids")
    expected_platforms = review_context.get("platforms")
    if not isinstance(expected_platforms, dict) or set(expected_platforms) != set(PLATFORMS):
        mark_blocked("PLATFORM_CONTEXT", "review_context.platforms", sorted(expected_platforms) if isinstance(expected_platforms, dict) else type(expected_platforms).__name__, "expectations for exactly all 14 platforms")
        expected_platforms = {}
    expected_risk_groups = review_context.get("risk_groups")
    if not isinstance(expected_risk_groups, list):
        mark_blocked("RISK_CONTEXT", "review_context.risk_groups", type(expected_risk_groups).__name__, "list, empty for a no-risk document")
        expected_risk_groups = []
    context_risk_items_all: list[dict[str, Any]] = []
    if isinstance(expected_platforms, dict):
        for platform_context in expected_platforms.values():
            if isinstance(platform_context, dict) and isinstance(platform_context.get("risk_items"), list):
                context_risk_items_all.extend(item for item in platform_context["risk_items"] if isinstance(item, dict))
    expected_group_indices = set(range(1, len(expected_risk_groups) + 1))
    document_target_group_indices = {
        index for index, group in enumerate(expected_risk_groups, 1)
        if isinstance(group, dict) and group.get("target_kind") == "document_block"
    }
    expected_platform_group_indices = expected_group_indices - document_target_group_indices
    if context_risk_items_all and not expected_risk_groups:
        mark_blocked("TOP_RISK_GROUP_REQUIRED", "review_context.risk_groups", [], "at least one top risk group for platform risk_items")
    if expected_platform_group_indices and not context_risk_items_all:
        mark_blocked("PLATFORM_RISK_REQUIRED", "review_context.platforms", "no risk_items", "platform risk_items corresponding to each platform-backed top risk group")
    actual_group_indices = {item.get("group_index") for item in context_risk_items_all if isinstance(item.get("group_index"), int)}
    if actual_group_indices != expected_platform_group_indices:
        mark_blocked("RISK_GROUP_MAPPING", "review_context.platforms.*.risk_items.group_index", sorted(actual_group_indices), f"cover exactly platform-backed groups {sorted(expected_platform_group_indices)}")
    writer_id = review_context.get("writer_id")
    reviewer_id = review_context.get("reviewer_id")
    if not writer_id or not reviewer_id:
        mark_blocked("REVIEW_ID", "review_context", {"writer_id": writer_id, "reviewer_id": reviewer_id}, "non-empty writer_id and reviewer_id")
    elif writer_id == reviewer_id:
        info.append("SAME_AGENT_DETERMINISTIC_REVIEW: allowed because PASS is decided by the read-only validator, not by an unverified self-assertion")
    visual_check = review_context.get("visual_check")
    if not isinstance(visual_check, dict):
        mark_blocked("VISUAL_CONTEXT", "review_context.visual_check", type(visual_check).__name__, "fresh or reuse_layout visual review record")
        visual_check = {}
    visual_mode = visual_check.get("mode")
    legacy_regions = visual_check.get("regions")
    if visual_mode is None and isinstance(legacy_regions, dict):
        legacy_passed = all(
            isinstance(value, dict) and value.get("passed") is True
            for value in legacy_regions.values()
        ) and bool(legacy_regions)
        visual_mode = "fresh"
        visual_check = dict(visual_check)
        visual_check["mode"] = "fresh"
        visual_check["checks"] = {
            "heading_levels": legacy_passed,
            "cards_and_grids": legacy_passed,
            "visible_platform_numbers": legacy_passed,
            "spacing": legacy_passed,
            "images": legacy_passed,
        }
        info.append("LEGACY_VISUAL_CONTEXT_ACCEPTED: screenshot-region PASS was normalized to fresh visual checks")
    if visual_mode not in {"fresh", "reuse_layout"}:
        mark_blocked("VISUAL_MODE", "review_context.visual_check.mode", visual_mode, "fresh or reuse_layout")
    if visual_check.get("revision_id") != revision_id:
        mark_blocked("VISUAL_REVISION", "review_context.visual_check.revision_id", visual_check.get("revision_id"), f"exact latest revision {revision_id}")
    if not visual_check.get("method"):
        mark_blocked("VISUAL_METHOD", "review_context.visual_check.method", visual_check.get("method"), "non-empty read-only viewing method")
    if not isinstance(visual_check.get("checked_at"), str) or not re.match(r"^\d{4}-\d{2}-\d{2}T", visual_check.get("checked_at", "")):
        mark_blocked("VISUAL_TIME", "review_context.visual_check.checked_at", visual_check.get("checked_at"), "ISO-8601 timestamp")
    if visual_mode == "fresh":
        required_visual_checks = ("heading_levels", "cards_and_grids", "visible_platform_numbers", "spacing", "images")
        visual_checks = visual_check.get("checks")
        if not isinstance(visual_checks, dict):
            mark_blocked("VISUAL_CHECKS", "review_context.visual_check.checks", visual_checks, f"true checks for {', '.join(required_visual_checks)}")
            visual_checks = {}
        for check_name in required_visual_checks:
            if visual_checks.get(check_name) is not True:
                mark_blocked("VISUAL_CHECK", f"review_context.visual_check.checks.{check_name}", visual_checks.get(check_name), "true after one live page pass")
    elif visual_mode == "reuse_layout":
        baseline_revision = visual_check.get("baseline_revision")
        baseline_verdict = visual_check.get("baseline_verdict")
        baseline_fingerprint = visual_check.get("baseline_layout_fingerprint")
        if not isinstance(baseline_revision, int) or baseline_revision >= revision_id:
            mark_blocked("VISUAL_BASELINE_REVISION", "review_context.visual_check.baseline_revision", baseline_revision, f"an earlier revision than {revision_id}")
        if baseline_verdict != "PASS":
            mark_blocked("VISUAL_BASELINE_VERDICT", "review_context.visual_check.baseline_verdict", baseline_verdict, "PASS")
        if baseline_fingerprint != current_layout_fingerprint:
            mark_blocked("VISUAL_LAYOUT_CHANGED", "review_context.visual_check.baseline_layout_fingerprint", baseline_fingerprint, current_layout_fingerprint)
        else:
            info.append(f"VISUAL_REUSED_LAYOUT: revision {baseline_revision} visual PASS reused because the layout fingerprint is unchanged")

    by_id = {str(block.get("block_id")): block for block in items if block.get("block_id")}
    pages = [block for block in items if block.get("block_type") == 1]
    if len(pages) != 1:
        fail("ROOT_PAGE", "document", len(pages), "exactly one page block")
        page = items[0]
    else:
        page = pages[0]

    document_token = str(page.get("block_id", ""))
    if visual_check.get("token") != document_token:
        mark_blocked("VISUAL_TOKEN", "review_context.visual_check.token", visual_check.get("token"), f"exact target token {document_token}")
    if document_token in (TEMPLATE_TOKEN, "SYNTHETICDOC0000000000000001"):
        fail("TEMPLATE_TARGET", "document", document_token, "target token must not be the read-only template token")

    business_result = audit_business_risk_review(
        review=review_context.get("business_risk_review"),
        items=items,
        document_token=document_token,
        revision_id=revision_id,
        reviewer_id=reviewer_id,
        expected_group_indices=expected_group_indices,
    )
    errors.extend(business_result["errors"])
    blocked.extend(business_result["blocked"])
    info.extend(business_result["info"])
    business_risk_verdict = business_result["verdict"]
    business_review_sha256 = business_result["record_sha256"]
    business_confirmed_hits_count = business_result["confirmed_hits"]

    title = str(meta.get("title") or text_of(page))
    if not re.fullmatch(r"\d{1,2}\.\d{1,2}-.+", title):
        fail("TITLE_FORMAT", "document title", title, "M.D-对象名")
    else:
        date = title.split("-", 1)[0]
        month, day = date.split(".")
        if (len(month) > 1 and month.startswith("0")) or (len(day) > 1 and day.startswith("0")):
            fail("TITLE_ZERO_PAD", "document title", title, "month and day without leading zero")

    root_ids = page.get("children", [])
    root = [by_id[block_id] for block_id in root_ids if block_id in by_id]
    if len(root) != len(root_ids):
        fail("ROOT_CHILDREN", "page.children", len(root), f"all {len(root_ids)} root child ids present in items")

    def root_matches(label: str, block_type: int | None = None) -> list[int]:
        return [i for i, block in enumerate(root) if text_of(block) == label and (block_type is None or block.get("block_type") == block_type)]

    key_indices: dict[str, int] = {}
    for label in ("风险摘要", "基本信息", "背调详情"):
        matches = root_matches(label, 5)
        if len(matches) != 1:
            fail("MAIN_HEADING", label, [(root[i].get("block_type"), text_of(root[i])) for i in root_matches(label)], f"exactly one H3 {label}")
        else:
            key_indices[label] = matches[0]

    # Continue auditing the section body even when the heading type/text is wrong.
    # This prevents one early heading failure from hiding grid, card, or works defects.
    section_indices: dict[str, int] = {}
    for label in ("风险摘要", "基本信息", "背调详情"):
        candidates = root_matches(label)
        if label == "风险摘要" and not candidates:
            candidates = [i for i, block in enumerate(root) if text_of(block).endswith("风险摘要")]
        if len(candidates) == 1:
            section_indices[label] = candidates[0]

    for block in root:
        value = text_of(block)
        if block.get("block_type") in (3, 4) and (value in {"风险摘要", "基本信息", "背调详情"} or value.endswith("风险摘要")):
            fail("LEGACY_HEADING", block.get("block_id", ""), f"type={block.get('block_type')} text={value}", "H3 main heading with exact text")

    if len(section_indices) == 3 and not (section_indices["风险摘要"] < section_indices["基本信息"] < section_indices["背调详情"]):
        fail("MAIN_ORDER", "root", section_indices, "风险摘要 before 基本信息 before 背调详情")

    risk_callout: dict[str, Any] | None = None
    if "风险摘要" in section_indices:
        idx = section_indices["风险摘要"]
        if idx + 1 >= len(root) or root[idx + 1].get("block_type") != 19:
            fail("RISK_CALLOUT", "风险摘要", "missing or displaced", "trophy Callout immediately after H3")
        else:
            risk_callout = root[idx + 1]
            callout = risk_callout.get("callout", {})
            if callout.get("emoji_id") != "trophy":
                fail("RISK_ICON", risk_callout.get("block_id", ""), callout.get("emoji_id"), "trophy")
            if callout.get("background_color") != 2 or callout.get("border_color") != 2:
                fail("RISK_CALLOUT_STYLE", risk_callout.get("block_id", ""), {"background_color": callout.get("background_color"), "border_color": callout.get("border_color")}, "background_color=2 and border_color=2")
            child_texts = [text_of(by_id[c]) for c in risk_callout.get("children", []) if c in by_id]
            if not child_texts or child_texts[0] != "风险摘要":
                fail("RISK_CHILD_TITLE", risk_callout.get("block_id", ""), child_texts, "first child text 风险摘要")
            if len(child_texts) >= 2 and child_texts[1] == "无":
                if child_texts != ["风险摘要", "无"]:
                    fail("NO_RISK_CHILDREN", risk_callout.get("block_id", ""), child_texts, "exactly 风险摘要 and 无")
                if "基本信息" in section_indices:
                    h4s = [text_of(b) for b in root[idx + 2:section_indices["基本信息"]] if b.get("block_type") == 6]
                    if h4s:
                        fail("NO_RISK_EXAMPLE", "风险摘要", h4s, "no H4 examples when summary is 无")
            elif len(child_texts) < 2:
                fail("RISK_CHILDREN", risk_callout.get("block_id", ""), child_texts, "summary title and at least one numbered risk line")
            else:
                for n, value in enumerate(child_texts[1:], 1):
                    if not value.startswith(f"{n}："):
                        fail("RISK_NUMBER", risk_callout.get("block_id", ""), value, f"{n}：…")

            if not expected_risk_groups:
                if child_texts != ["风险摘要", "无"]:
                    fail("RISK_CONTEXT_MISMATCH", risk_callout.get("block_id", ""), child_texts, "risk_groups=[] requires exactly 风险摘要 and 无")
            else:
                required_group_keys = {"title", "summary", "highlight_text", "target_block_id"}
                for n, group in enumerate(expected_risk_groups, 1):
                    if not isinstance(group, dict) or not required_group_keys.issubset(group):
                        mark_blocked("RISK_GROUP_SCHEMA", f"review_context.risk_groups[{n - 1}]", group, f"object with {sorted(required_group_keys)}")
                        continue
                    target_kind = group.get("target_kind", "platform_fact")
                    if target_kind not in {"platform_fact", "document_block"}:
                        mark_blocked("RISK_TARGET_KIND", f"review_context.risk_groups[{n - 1}].target_kind", target_kind, "platform_fact or document_block")
                    if target_kind == "document_block":
                        if not isinstance(group.get("target_text"), str) or not group["target_text"].strip():
                            mark_blocked("RISK_DOCUMENT_TARGET_TEXT", f"review_context.risk_groups[{n - 1}].target_text", group.get("target_text"), "nonempty exact destination text")
                        row_contains = group.get("target_row_contains")
                        if (not isinstance(row_contains, list) or len(row_contains) < 2
                                or any(not isinstance(value, str) or not value.strip() for value in row_contains)):
                            mark_blocked("RISK_DOCUMENT_TARGET_ROW", f"review_context.risk_groups[{n - 1}].target_row_contains", row_contains, "at least two nonempty strings binding the collaboration row's review and source")
                        top_evidence = group.get("top_evidence")
                        if not isinstance(top_evidence, list) or not top_evidence:
                            mark_blocked("RISK_DOCUMENT_TOP_EVIDENCE", f"review_context.risk_groups[{n - 1}].top_evidence", top_evidence, "nonempty top-evidence list")
                expected_summaries = [f"{n}：{group.get('summary', '')}" for n, group in enumerate(expected_risk_groups, 1) if isinstance(group, dict)]
                if child_texts[1:] != expected_summaries:
                    fail("RISK_SUMMARY_CONTEXT", risk_callout.get("block_id", ""), child_texts[1:], expected_summaries)

                if "基本信息" in section_indices:
                    risk_root = root[idx + 2:section_indices["基本信息"]]
                    cursor = 0
                    for n, group in enumerate(expected_risk_groups, 1):
                        if not isinstance(group, dict) or not required_group_keys.issubset(group):
                            continue
                        expected_h4 = f"举例{n}【{group['title']}】"
                        if cursor >= len(risk_root) or risk_root[cursor].get("block_type") != 6 or text_of(risk_root[cursor]) != expected_h4:
                            fail("RISK_H4", f"举例{n}", (risk_root[cursor].get("block_type"), text_of(risk_root[cursor])) if cursor < len(risk_root) else "missing", expected_h4)
                            break
                        if any(link_url_of_run(run) for run in runs(risk_root[cursor])):
                            fail("RISK_H4_LINK", f"举例{n}", text_of(risk_root[cursor]), "plain H4 title without a link")
                        cursor += 1
                        if cursor >= len(risk_root) or risk_root[cursor].get("block_type") != 19:
                            fail("RISK_PIN_CALLOUT", f"举例{n}", "missing", "round_pushpin Callout after H4")
                            break
                        pin = risk_root[cursor]
                        pin_style = pin.get("callout", {})
                        if pin_style.get("emoji_id") != "round_pushpin" or pin_style.get("background_color") != 2 or pin_style.get("border_color") != 2:
                            fail("RISK_PIN_STYLE", pin.get("block_id", ""), pin_style, "round_pushpin with background_color=2 and border_color=2")
                        pin_children = [by_id[c] for c in pin.get("children", []) if c in by_id]
                        if len(pin_children) != 1 or text_of(pin_children[0]) != group["highlight_text"]:
                            fail("RISK_HIGHLIGHT", pin.get("block_id", ""), [text_of(c) for c in pin_children], group["highlight_text"])
                        else:
                            highlight_elements = elements(pin_children[0])
                            actual_links = [link_url_of_run(r) for r in runs(pin_children[0])]
                            expected_internal_url = f"https://my.feishu.cn/docx/{document_token}#{group['target_block_id']}"
                            target_kind = group.get("target_kind", "platform_fact")
                            all_platform_group_items = [
                                item for item in context_risk_items_all
                                if item.get("group_index") == n
                            ]
                            top_platform_group_items = [
                                item for item in all_platform_group_items
                                if item.get("include_in_top", True) is not False
                            ]
                            target_block = by_id.get(str(group["target_block_id"]))
                            target_valid = False
                            allowed_target_block_ids: set[str] = set()
                            if target_kind == "document_block":
                                target_text = group.get("target_text")
                                row_contains = group.get("target_row_contains")
                                row_text = _table_row_text(by_id, str(group["target_block_id"]))
                                if target_block is None or text_of(target_block) != target_text:
                                    fail("RISK_DOCUMENT_TARGET_BLOCK", str(group["target_block_id"]), text_of(target_block) if target_block else "missing", f"existing exact destination text {target_text}")
                                elif row_text is None:
                                    fail("RISK_DOCUMENT_TARGET_ROW", str(group["target_block_id"]), "not in a table row", "a collaboration-table destination row")
                                elif not isinstance(row_contains, list) or any(value not in row_text for value in row_contains if isinstance(value, str)):
                                    fail("RISK_DOCUMENT_TARGET_ROW", str(group["target_block_id"]), row_text, f"row containing {row_contains}")
                                else:
                                    target_valid = True
                                    allowed_target_block_ids = {str(group["target_block_id"])}
                            else:
                                group_risk_facts = {str(item.get("fact_text")) for item in top_platform_group_items}
                                platform_root = root[section_indices["背调详情"] + 1:] if "背调详情" in section_indices else []
                                group_fact_blocks = [block for block in platform_root if block.get("block_type") == 2 and text_of(block) in group_risk_facts]
                                group_fact_block_ids = {str(block.get("block_id")) for block in group_fact_blocks}
                                first_fact_id = str(group_fact_blocks[0].get("block_id")) if group_fact_blocks else None
                                if str(group["target_block_id"]) != first_fact_id:
                                    fail("RISK_FIRST_PLATFORM_TARGET", f"举例{n}", group["target_block_id"], f"first selected platform risk fact block {first_fact_id}")
                                if target_block is None or str(group["target_block_id"]) not in group_fact_block_ids:
                                    fail("RISK_LINK_TARGET_BLOCK", str(group["target_block_id"]), text_of(target_block) if target_block else "missing", "existing selected platform risk fact block declared in this group's risk_items")
                                else:
                                    target_valid = True
                                    allowed_target_block_ids = group_fact_block_ids
                            if not risk_highlight_links_match(
                                highlight_elements,
                                group["highlight_text"],
                                document_token,
                                str(group["target_block_id"]),
                                allowed_target_block_ids,
                            ):
                                fail("RISK_INTERNAL_LINK", pin_children[0].get("block_id", ""), actual_links, f"one internal destination {expected_internal_url} on the pin sentence")
                            if target_valid:
                                blocked.extend(audit_internal_jump(items, document_token, str(pin_children[0].get("block_id", "")),
                                                                   str(group["target_block_id"]), visual_check.get("jump_checks")))
                        cursor += 1
                        if group.get("target_kind", "platform_fact") == "document_block":
                            group_items = [item for item in group.get("top_evidence", []) if isinstance(item, dict)]
                        else:
                            group_items = [
                                item for item in context_risk_items_all
                                if item.get("group_index") == n and item.get("include_in_top", True) is not False
                            ]
                        if not group_items:
                            mark_blocked("RISK_GROUP_EVIDENCE", f"review_context.risk_groups[{n - 1}]", [], "at least one selected top-evidence item")
                        for evidence_index, item in enumerate(group_items, 1):
                            expected_fact = item.get("fact_text")
                            if not isinstance(expected_fact, str) or not expected_fact.strip():
                                mark_blocked("RISK_TOP_EVIDENCE_SCHEMA", f"举例{n} evidence {evidence_index}", item, "nonempty fact_text and positive image_count")
                                continue
                            if "top_fact_text" in item:
                                top_fact = item.get("top_fact_text")
                                if not isinstance(top_fact, str) or not top_fact.strip():
                                    fail("TOP_FACT_SCHEMA", f"举例{n} evidence {evidence_index}", top_fact, "nonempty reviewed top fact")
                                else:
                                    if top_fact != expected_fact:
                                        reviewed = item.get("top_fact_review")
                                        required = {"status": "PASS", "fact_text": expected_fact,
                                                    "top_fact_text": top_fact, "token": document_token,
                                                    "revision_id": revision_id}
                                        if not isinstance(reviewed, dict) or any(reviewed.get(k) != v for k, v in required.items()) or not reviewed.get("reviewer_id") or not reviewed.get("checked_at"):
                                            mark_blocked("TOP_FACT_REVIEW", f"举例{n} evidence {evidence_index}", reviewed, "current document-bound semantic review of the exact body and top facts")
                                    expected_fact = top_fact
                            top_location = item.get("top_fact_location", "block")
                            if top_location == "highlight":
                                # A reviewed explanation in the pin needs no duplicate paragraph below it.
                                if len(pin_children) != 1 or text_of(pin_children[0]) != expected_fact:
                                    fail("RISK_FACT", f"举例{n} evidence {evidence_index}",
                                         [text_of(child) for child in pin_children], str(expected_fact))
                                    break
                            elif top_location == "block":
                                if cursor >= len(risk_root) or risk_root[cursor].get("block_type") != 2 or text_of(risk_root[cursor]) != expected_fact:
                                    fail("RISK_FACT", f"举例{n} evidence {evidence_index}", text_of(risk_root[cursor]) if cursor < len(risk_root) else "missing", str(expected_fact))
                                    break
                                cursor += 1
                            else:
                                fail("TOP_FACT_LOCATION", f"举例{n} evidence {evidence_index}", top_location, "block or highlight")
                                break
                            image_count = item.get("image_count")
                            if not isinstance(image_count, int) or image_count < 1:
                                mark_blocked("RISK_IMAGE_SCHEMA", f"review_context.platforms.*.risk_items[{evidence_index - 1}].image_count", image_count, "integer >= 1")
                                continue
                            actual_images = 0
                            while (cursor < len(risk_root) and risk_root[cursor].get("block_type") == 27
                                   and actual_images < image_count):
                                actual_images += 1
                                cursor += 1
                            if actual_images != image_count:
                                fail("RISK_IMAGES", f"举例{n} evidence {evidence_index}", actual_images, str(image_count))
                    residual = [b for b in risk_root[cursor:] if b.get("block_type") != 22 and not is_blank_text(b)]
                    if residual:
                        fail("RISK_EXTRA_BLOCKS", "风险摘要", [(b.get("block_type"), text_of(b)) for b in residual], "no unmanifested risk blocks")

    if len(section_indices) == 3:
        risk_i = section_indices["风险摘要"]
        basic_i = section_indices["基本信息"]
        detail_i = section_indices["背调详情"]
        dividers_before_basic = [i for i in range(risk_i + 1, basic_i) if root[i].get("block_type") == 22]
        if len(dividers_before_basic) != 1 or dividers_before_basic[0] != basic_i - 1:
            fail("TOP_DIVIDER", "before 基本信息", dividers_before_basic, "one divider immediately before 基本信息")

        between_basic = root[basic_i + 1:detail_i]
        grids = [b for b in between_basic if b.get("block_type") == 24]
        if len(grids) != 2:
            fail("BASIC_GRIDS", "基本信息", len(grids), "exactly two 50/50 grids")

        expected_icons = ["bust_in_silhouette", "books", "heart", "ledger"]
        expected_prefixes = ["背调对象：", "类别：", "背调结果：", "简介："]
        field_callouts: list[dict[str, Any]] = []
        for grid in grids:
            if grid.get("grid", {}).get("column_size") != 2:
                fail("GRID_SIZE", grid.get("block_id", ""), grid.get("grid", {}).get("column_size"), "2")
            columns = [by_id[c] for c in grid.get("children", []) if c in by_id]
            if len(columns) != 2:
                fail("GRID_COLUMNS", grid.get("block_id", ""), len(columns), "2")
            for column in columns:
                if column.get("block_type") != 25 or column.get("grid_column", {}).get("width_ratio") != 50:
                    fail("GRID_WIDTH", column.get("block_id", ""), column.get("grid_column", {}).get("width_ratio"), "grid column width_ratio=50")
                children = [by_id[c] for c in column.get("children", []) if c in by_id]
                if len(children) != 1 or children[0].get("block_type") != 19:
                    fail("COLUMN_STRUCTURE", column.get("block_id", ""), [(c.get("block_type"), text_of(c)) for c in children], "exactly one Callout and no column-level blank block")
                if children and children[0].get("block_type") == 19:
                    field_callouts.append(children[0])

        if len(field_callouts) == 4:
            for idx, callout in enumerate(field_callouts):
                icon = callout.get("callout", {}).get("emoji_id")
                if icon != expected_icons[idx]:
                    fail("FIELD_ICON", callout.get("block_id", ""), icon, expected_icons[idx])
                children = [by_id[c] for c in callout.get("children", []) if c in by_id]
                if len(children) != 1:
                    fail("FIELD_CHILDREN", callout.get("block_id", ""), len(children), "one field text child and no trailing blank")
                    continue
                value = text_of(children[0])
                if not value.startswith(expected_prefixes[idx]):
                    fail("FIELD_TEXT", children[0].get("block_id", ""), value, f"text starting {expected_prefixes[idx]}")
                field_runs = runs(children[0])
                if idx == 2:
                    if len(field_runs) != 2 or field_runs[0].get("content") != "背调结果：" or not all(r.get("text_element_style", {}).get("bold") is True for r in field_runs):
                        fail("RESULT_RUNS", children[0].get("block_id", ""), [(r.get("content"), r.get("text_element_style", {}).get("bold")) for r in field_runs], "two bold runs: 背调结果： and result value")
                    elif len(field_runs) == 2:
                        result_value = str(field_runs[1].get("content", ""))
                        result_color = field_runs[1].get("text_element_style", {}).get("text_color")
                        expected_result_colors = {"低合作风险": None, "建议评估": 2, "建议谨慎评估": 1}
                        if result_value not in expected_result_colors:
                            fail("RESULT_VALUE", children[0].get("block_id", ""), result_value, "低合作风险, 建议评估, or 建议谨慎评估")
                        else:
                            expected_color = expected_result_colors[result_value]
                            if expected_color is None:
                                if result_color not in (None, 0):
                                    fail("RESULT_COLOR", children[0].get("block_id", ""), result_color, "default color for 低合作风险")
                            elif result_color != expected_color:
                                fail("RESULT_COLOR", children[0].get("block_id", ""), result_color, str(expected_color))
                elif not field_runs or not all(r.get("text_element_style", {}).get("bold") is True for r in field_runs):
                    fail("FIELD_BOLD", children[0].get("block_id", ""), value, "entire field bold")

        representative = [b for b in between_basic if b.get("block_type") == 19 and b.get("callout", {}).get("emoji_id") == "white_check_mark"]
        if len(representative) != 1:
            fail("WORKS_CALLOUT", "基本信息", len(representative), "one white_check_mark representative-works Callout")
        else:
            works = representative[0]
            work_children = [by_id[c] for c in works.get("children", []) if c in by_id]
            work_texts = [text_of(c) for c in work_children]
            if not work_texts or work_texts[0] != "代表作：" or len(work_texts) < 2:
                fail("WORKS_CHILDREN", works.get("block_id", ""), work_texts, "代表作： followed by one text block per work")
            for child, value in zip(work_children[1:], work_texts[1:]):
                if not value:
                    fail("WORKS_BLANK", child.get("block_id", ""), "blank", "nonblank work text")
                if value.count("《") > 1:
                    fail("WORKS_SPLIT", child.get("block_id", ""), value, "one work per text block")
                if any(run.get("text_element_style", {}).get("link") for run in runs(child)):
                    fail("WORKS_LINK", child.get("block_id", ""), value, "plain text without link")
            works_index = root.index(works)
            if works_index + 1 >= len(root) or root[works_index + 1].get("block_type") != 22:
                fail("WORKS_DIVIDER", works.get("block_id", ""), "not followed directly by divider", "representative works Callout immediately followed by divider")

    platform_positions: dict[str, int] = {}
    title_blocks: dict[str, dict[str, Any]] = {}
    for number, platform in enumerate(PLATFORMS, 1):
        matches: list[tuple[int, dict[str, Any]]] = []
        for i, block in enumerate(root):
            value = text_of(block)
            if (block.get("block_type") == 13 and value == platform) or (block.get("block_type") == 2 and value == f"{number}. {platform}"):
                matches.append((i, block))
        if len(matches) != 1:
            fail("PLATFORM_TITLE", platform, [(i, b.get("block_type"), text_of(b)) for i, b in matches], f"exactly one visible title {number}. {platform}")
        else:
            platform_positions[platform], title_blocks[platform] = matches[0]
            block = matches[0][1]
            if block.get("block_type") == 13:
                sequence = str(block.get("ordered", {}).get("style", {}).get("sequence", ""))
                if sequence not in {str(number), "auto"}:
                    fail("PLATFORM_SEQUENCE", platform, sequence, f"{number}, or auto only when visual review confirms visible {number}")
                elif sequence == "auto":
                    info.append(f"VISUAL_SEQUENCE_REQUIRED: {platform} uses sequence=auto; visible number {number} must be confirmed in the revision-bound page review")

    if len(platform_positions) == 14:
        actual_order = sorted(platform_positions, key=platform_positions.get)
        if actual_order != PLATFORMS:
            fail("PLATFORM_ORDER", "背调详情", actual_order, " → ".join(PLATFORMS))

        for index, platform in enumerate(PLATFORMS):
            start = platform_positions[platform] + 1
            end = platform_positions[PLATFORMS[index + 1]] if index + 1 < len(PLATFORMS) else len(root)
            body = root[start:end]
            trailing_blanks = 0
            for block in reversed(body):
                if is_blank_text(block):
                    trailing_blanks += 1
                else:
                    break
            if trailing_blanks != 1:
                fail("PLATFORM_SPACER", platform, trailing_blanks, "exactly one trailing blank text block")
            nonblank = body[:-trailing_blanks] if trailing_blanks else body
            numbered = [(b, text_of(b)) for b in nonblank if FULLWIDTH_NUMBER_RE.match(text_of(b))]

            platform_context = expected_platforms.get(platform) if isinstance(expected_platforms, dict) else None
            if not isinstance(platform_context, dict):
                mark_blocked("PLATFORM_SCHEMA", f"review_context.platforms.{platform}", platform_context, "object with modules, risk_items, and expected_blocks")
                platform_context = {}
            context_modules = platform_context.get("modules")
            context_risk_items = platform_context.get("risk_items")
            context_blocks = platform_context.get("expected_blocks")
            if not isinstance(context_modules, list) or not all(isinstance(m, dict) and set(m) >= {"text", "status", "fact_evidence"} for m in context_modules):
                mark_blocked("MODULE_CONTEXT", f"review_context.platforms.{platform}.modules", context_modules, "list of {text, status, fact_evidence} objects")
                context_modules = []
            expected_module_count = len(MODULE_PATTERNS[platform]) if platform in MODULE_PATTERNS else None
            if expected_module_count is not None and len(context_modules) != expected_module_count:
                mark_blocked("MODULE_CONTEXT_COUNT", f"review_context.platforms.{platform}.modules", len(context_modules), str(expected_module_count))
            if platform in {"境内其他内容", "境外其他网站"} and len(context_modules) < 1:
                mark_blocked("MODULE_CONTEXT_COUNT", f"review_context.platforms.{platform}.modules", len(context_modules), "at least the mandatory Baidu/Google module")
            allowed_statuses = {"no_result", "checked_clean", "risk", "incomplete", "not_applicable"}
            for module_index, module in enumerate(context_modules):
                if module.get("status") not in allowed_statuses or not isinstance(module.get("text"), str):
                    mark_blocked("MODULE_STATUS", f"review_context.platforms.{platform}.modules[{module_index}]", module, f"string text and status in {sorted(allowed_statuses)}")
            if not isinstance(context_risk_items, list):
                mark_blocked("RISK_ITEM_CONTEXT", f"review_context.platforms.{platform}.risk_items", context_risk_items, "list, empty when no platform risk")
                context_risk_items = []
            required_risk_item_keys = {"group_index", "fact_text", "image_count"}
            for risk_index, risk_item in enumerate(context_risk_items):
                restricted = isinstance(risk_item, dict) and risk_item.get("source_kind") == RESTRICTED_SOURCE_KIND
                source_keys = {"restricted_source"} if restricted else {"url"}
                expected_keys = required_risk_item_keys | source_keys
                if not isinstance(risk_item, dict) or not expected_keys.issubset(risk_item):
                    mark_blocked("RISK_ITEM_SCHEMA", f"review_context.platforms.{platform}.risk_items[{risk_index}]", risk_item, f"object with {sorted(expected_keys)}")
                elif "include_in_top" in risk_item and not isinstance(risk_item.get("include_in_top"), bool):
                    mark_blocked("RISK_ITEM_TOP_SELECTION", f"review_context.platforms.{platform}.risk_items[{risk_index}].include_in_top", risk_item.get("include_in_top"), "boolean when supplied")
            if not isinstance(context_blocks, list) or not all(isinstance(entry, dict) and entry.get("kind") in {"text", "url", "image"} for entry in context_blocks):
                mark_blocked("EXPECTED_BLOCKS", f"review_context.platforms.{platform}.expected_blocks", context_blocks, "complete ordered list of text, url, and image entries excluding the trailing spacer")
                context_blocks = []
            elif not context_blocks:
                mark_blocked("EXPECTED_BLOCKS_EMPTY", f"review_context.platforms.{platform}.expected_blocks", context_blocks, "non-empty complete platform body")

            statuses = [module.get("status") for module in context_modules if isinstance(module, dict)]
            if "incomplete" in statuses:
                mark_blocked("INCOMPLETE_MODULE", platform, statuses, "all modules completed before final delivery")
            if "risk" in statuses and not context_risk_items:
                mark_blocked("RISK_ITEMS_REQUIRED", platform, statuses, "one or more risk_items for a risk-status module")
            if context_risk_items and "risk" not in statuses:
                mark_blocked("RISK_STATUS_REQUIRED", platform, statuses, "at least one risk-status module when risk_items is non-empty")

            expected_module_texts = [str(module.get("text", "")) for module in context_modules if isinstance(module, dict)]
            actual_module_texts = [value for _, value in numbered]
            if context_modules and actual_module_texts != expected_module_texts:
                fail("MODULE_CONTEXT_MISMATCH", platform, actual_module_texts, str(expected_module_texts))

            module_urls = {
                _url_route_key(url)
                for module_text in actual_module_texts
                for url in URL_RE.findall(module_text)
                if _url_route_key(url) is not None
                and (_is_search_url(url) or _is_profile_or_home_url(platform, url))
            }
            for risk_index, risk_item in enumerate(context_risk_items):
                restricted = isinstance(risk_item, dict) and risk_item.get("source_kind") == RESTRICTED_SOURCE_KIND
                source_keys = {"restricted_source"} if restricted else {"url"}
                if not isinstance(risk_item, dict) or not (required_risk_item_keys | source_keys).issubset(risk_item):
                    continue
                risk_url = risk_item.get("url")
                location = f"{platform} risk_items[{risk_index}].url"
                if restricted:
                    restricted_ok, restricted_reason, restricted_url = _validated_restricted_source(
                        platform, risk_item, context_modules, reviewer_id)
                    if not restricted_ok:
                        fail("RISK_RESTRICTED_SOURCE", f"{platform} risk_items[{risk_index}].restricted_source",
                             restricted_reason, "strict verified local evidence and a safe public derivative")
                    elif any(restricted_url and restricted_url in text_of(block) for block in items):
                        fail("RISK_RESTRICTED_URL_EXPOSED", platform, "restricted direct URL is visible",
                             "keep the direct URL only in the verified local record")
                    continue
                if not isinstance(risk_url, str) or _url_parts(risk_url) is None:
                    fail("RISK_URL_NOT_DIRECT", location, risk_url, "a complete HTTP(S) post, dynamic, video, or article URL")
                    continue
                if risk_item.get("source_kind") == "search_index_summary":
                    index_ok, index_reason = _validated_search_index_summary(platform, risk_item, context_modules)
                    if not index_ok:
                        fail("RISK_INDEX_SUMMARY_EVIDENCE", location, index_reason, "content-bound registered index-only source evidence")
                    continue
                if risk_item.get("source_kind") == PLATFORM_REVIEW_ENTRY_SOURCE_KIND:
                    review_ok, review_reason = _validated_platform_review_entry(platform, risk_item, context_modules, reviewer_id)
                    if not review_ok:
                        fail("RISK_REVIEW_ENTRY_EVIDENCE", location, review_reason, "content-bound public review entry evidence")
                    continue
                route_key = _url_route_key(risk_url)
                if route_key in module_urls or _is_search_url(risk_url) or _is_profile_or_home_url(platform, risk_url):
                    fail("RISK_URL_HOME_OR_SEARCH", location, risk_url, "the independent direct URL of the evidenced post or dynamic, not a homepage or search-results route")
                elif not _is_direct_content_url(platform, risk_url):
                    fail("RISK_URL_NOT_DIRECT", location, risk_url, "a platform-native post, dynamic, video, or article URL")

            subject_forbidden = {
                "person": ("官方主页", "项目主页", "此组织", "此项目"),
                "organization": ("个人主页", "豆瓣人物主页", "音乐人页", "此人", "项目主页", "此项目"),
                "project": ("个人主页", "豆瓣人物主页", "音乐人页", "此人", "官方主页", "此组织"),
            }
            for module_text in actual_module_texts:
                for forbidden in subject_forbidden.get(subject_type, ()):
                    if forbidden in module_text:
                        fail("SUBJECT_LABEL", platform, module_text, f"{subject_type}-appropriate homepage and subject wording")

            for module_index, module in enumerate(context_modules):
                if not isinstance(module, dict) or not isinstance(module.get("text"), str):
                    continue
                module_text = module["text"]
                status = module.get("status")
                # 仅按实际文案分类：明确关键词搜索优先，module_kind 不绕过合同。
                is_search = "关键词搜索：" in module_text
                is_home = ("主页" in module_text or "音乐人页" in module_text) and not is_search
                is_other_result = platform in {"境内其他内容", "境外其他网站"} and not is_home
                is_search_result = is_search or is_other_result
                is_no_home = is_home and re.match(r"^（\d+）无", module_text) is not None
                is_suspected_home = is_home and _is_suspected_home_module(platform, module_text, module)
                if (is_home and platform in OTHER_PLATFORMS
                        and NAMED_SUSPECTED_HOME_PREFIX_RE.match(module_text) is not None
                        and not is_suspected_home):
                    mark_blocked(
                        "OTHER_SUSPECTED_HOME_LABEL",
                        f"review_context.platforms.{platform}.modules[{module_index}].platform_name",
                        module.get("platform_name"),
                        "explicit current-task platform_name exactly matching the named suspected-homepage label",
                    )
                is_topic = "超话/话题" in module_text or "主题贴吧" in module_text
                is_no_topic = is_topic and "无" in module_text and "http" not in module_text
                requires_url = is_search_result or (is_home and not is_no_home) or (is_topic and not is_no_topic)
                if (requires_url and not URL_RE.search(module_text)
                        and not _verified_user_waived_search(module, payload, is_search)):
                    fail("MODULE_URL_REQUIRED", f"{platform} module {module_index + 1}", module_text, "complete visible URL required by this module")

                evidence = module.get("fact_evidence")
                evidence_location = f"review_context.platforms.{platform}.modules[{module_index}].fact_evidence"
                required_evidence_keys = {"source_type", "source_locator", "checked_at", "summary"}
                if not isinstance(evidence, dict) or not required_evidence_keys.issubset(evidence):
                    mark_blocked(
                        "FACT_EVIDENCE",
                        evidence_location,
                        evidence,
                        f"object with {sorted(required_evidence_keys)} built from current-task facts, not document wording",
                    )
                    evidence = {}
                source_type = evidence.get("source_type")
                if source_type in FORBIDDEN_FACT_EVIDENCE_TYPES or source_type not in ALLOWED_FACT_EVIDENCE_TYPES:
                    mark_blocked(
                        "FACT_EVIDENCE_SOURCE",
                        f"{evidence_location}.source_type",
                        source_type,
                        f"one of {sorted(ALLOWED_FACT_EVIDENCE_TYPES)}; document/delivery-script self-report is forbidden",
                    )
                if not isinstance(evidence.get("source_locator"), str) or not evidence.get("source_locator", "").strip():
                    mark_blocked("FACT_EVIDENCE_LOCATOR", f"{evidence_location}.source_locator", evidence.get("source_locator"), "non-empty current-task record locator or directly checked platform URL")
                if not isinstance(evidence.get("summary"), str) or not evidence.get("summary", "").strip():
                    mark_blocked("FACT_EVIDENCE_SUMMARY", f"{evidence_location}.summary", evidence.get("summary"), "non-empty fact summary independent of the final sentence")
                if not isinstance(evidence.get("checked_at"), str) or not re.match(r"^\d{4}-\d{2}-\d{2}T", evidence.get("checked_at", "")):
                    mark_blocked("FACT_EVIDENCE_TIME", f"{evidence_location}.checked_at", evidence.get("checked_at"), "ISO-8601 timestamp")

                if is_search_result and status in {"no_result", "checked_clean", "risk"}:
                    count_issue = _search_result_count_issue(evidence, status)
                    if count_issue is not None:
                        issue_code, requirement = count_issue
                        observed_count = {"status": status, "related_result_count": evidence.get("related_result_count")}
                        observed_count.update({key: evidence[key] for key in (
                            "related_result_count_verified_minimum", "related_result_count_exact_total_unknown",
                            "related_result_count_minimum_source_locator",
                        ) if key in evidence})
                        count_location = f"{evidence_location}.related_result_count" if issue_code == "SEARCH_RESULT_COUNT" else evidence_location
                        mark_blocked(issue_code, count_location, observed_count, requirement)
                    if platform == "B站":
                        checked_surfaces = evidence.get("checked_surfaces")
                        if not isinstance(checked_surfaces, list) or not {"video", "article"}.issubset(set(checked_surfaces)):
                            mark_blocked("BILIBILI_SURFACES", f"{evidence_location}.checked_surfaces", checked_surfaces, "list covering both video and article")
                if is_home and status in {"no_result", "checked_clean", "risk"}:
                    confirmed_count = evidence.get("confirmed_homepage_count")
                    suspected_count = evidence.get("suspected_homepage_count")
                    if not isinstance(confirmed_count, int) or confirmed_count < 0:
                        mark_blocked("HOMEPAGE_COUNT", f"{evidence_location}.confirmed_homepage_count", confirmed_count, "integer >= 0")
                    elif status == "no_result" and confirmed_count != 0:
                        mark_blocked("EVIDENCE_STATUS_MISMATCH", evidence_location, {"status": status, "confirmed_homepage_count": confirmed_count}, "no_result requires confirmed_homepage_count=0")
                    elif status in {"checked_clean", "risk"} and is_suspected_home and confirmed_count != 0:
                        mark_blocked(
                            "EVIDENCE_STATUS_MISMATCH",
                            evidence_location,
                            {"status": status, "confirmed_homepage_count": confirmed_count, "suspected_homepage_count": suspected_count},
                            "explicit suspected-homepage label requires confirmed_homepage_count=0",
                        )
                    elif status in {"checked_clean", "risk"} and not is_suspected_home and confirmed_count < 1:
                        mark_blocked("EVIDENCE_STATUS_MISMATCH", evidence_location, {"status": status, "confirmed_homepage_count": confirmed_count}, "checked_clean/risk homepage requires at least one confirmed homepage")
                    if suspected_count is not None and (not isinstance(suspected_count, int) or suspected_count < 0):
                        mark_blocked("HOMEPAGE_COUNT", f"{evidence_location}.suspected_homepage_count", suspected_count, "integer >= 0")
                    elif status == "no_result" and suspected_count not in {None, 0}:
                        mark_blocked(
                            "EVIDENCE_STATUS_MISMATCH",
                            evidence_location,
                            {"status": status, "confirmed_homepage_count": confirmed_count, "suspected_homepage_count": suspected_count},
                            "no_result requires suspected_homepage_count=0 when supplied",
                        )
                    elif status in {"checked_clean", "risk"} and is_suspected_home and (not isinstance(suspected_count, int) or suspected_count < 1):
                        mark_blocked(
                            "EVIDENCE_STATUS_MISMATCH",
                            evidence_location,
                            {"status": status, "confirmed_homepage_count": confirmed_count, "suspected_homepage_count": suspected_count},
                            "explicit suspected-homepage label requires suspected_homepage_count>=1",
                        )
                if is_topic and status in {"no_result", "checked_clean", "risk"}:
                    related_topic_count = evidence.get("related_topic_count")
                    if not isinstance(related_topic_count, int) or related_topic_count < 0:
                        mark_blocked("TOPIC_RESULT_COUNT", f"{evidence_location}.related_topic_count", related_topic_count, "integer >= 0")
                    elif status == "no_result" and related_topic_count != 0:
                        mark_blocked("EVIDENCE_STATUS_MISMATCH", evidence_location, {"status": status, "related_topic_count": related_topic_count}, "no_result requires related_topic_count=0")
                    elif status in {"checked_clean", "risk"} and related_topic_count < 1:
                        mark_blocked("EVIDENCE_STATUS_MISMATCH", evidence_location, {"status": status, "related_topic_count": related_topic_count}, "checked_clean/risk topic requires at least one related topic")
                empty_existing_topic = is_topic and evidence.get("empty_existing_topic") is True
                if empty_existing_topic:
                    if platform != "微博" or status != "checked_clean":
                        fail("EMPTY_TOPIC_BRANCH", evidence_location, {"platform": platform, "status": status}, "existing-empty branch is limited to a checked-clean Weibo topic")
                    else:
                        empty_issue = _empty_topic_evidence_issue(evidence, module_text)
                        if empty_issue is not None:
                            issue_code, requirement = empty_issue
                            reporter = fail if issue_code in {"EMPTY_TOPIC_CONTENT_CONFLICT", "EMPTY_TOPIC_TEXT"} else mark_blocked
                            reporter(issue_code, evidence_location, evidence, requirement)

                if status == "no_result":
                    if is_home and not is_no_home:
                        fail("NO_RESULT_HOME", f"{platform} module {module_index + 1}", module_text, "exact no-home sentence")
                    elif is_search_result:
                        expected_ending = NO_RESULT_SEARCH.get(platform)
                        if expected_ending is None:
                            mark_blocked("NO_RESULT_BRANCH_UNSPECIFIED", f"{platform} module {module_index + 1}", module_text, "user instruction or unambiguous platform-contract wording")
                        elif not module_text.endswith(expected_ending):
                            fail("NO_RESULT_CONCLUSION", f"{platform} module {module_index + 1}", module_text, expected_ending)
                    elif is_topic and not is_no_topic:
                        fail("NO_RESULT_TOPIC", f"{platform} module {module_index + 1}", module_text, "exact no-topic sentence")
                elif status == "checked_clean":
                    if is_search_result:
                        expected_ending = CHECKED_CLEAN_SEARCH.get(platform)
                        if expected_ending is None:
                            mark_blocked("CHECKED_CLEAN_BRANCH_UNSPECIFIED", f"{platform} module {module_index + 1}", module_text, "current platform contract phrase")
                            continue
                    elif is_home:
                        expected_ending = "相关内容无问题" if platform == "豆瓣" else "无问题"
                    elif is_topic:
                        expected_ending = "暂无帖子，无问题" if empty_existing_topic else CHECKED_CLEAN_TOPIC.get(platform, "相关内容无问题")
                    else:
                        expected_ending = "无问题"
                    if not module_text.endswith(expected_ending):
                        fail("CHECKED_CLEAN_CONCLUSION", f"{platform} module {module_index + 1}", module_text, expected_ending)

            def actual_entry(item: dict[str, Any]) -> dict[str, str]:
                if item.get("block_type") == 27:
                    return {"kind": "image"}
                value = text_of(item)
                if re.fullmatch(r"https?://\S+", value):
                    return {"kind": "url", "text": value}
                return {"kind": "text", "text": value}

            actual_entries = [actual_entry(item) for item in nonblank]
            normalized_expected_entries: list[dict[str, str]] = []
            for expected_entry in context_blocks:
                if not isinstance(expected_entry, dict):
                    continue
                kind = str(expected_entry.get("kind"))
                normalized = {"kind": kind}
                if kind in {"text", "url"}:
                    if not isinstance(expected_entry.get("text"), str):
                        mark_blocked("EXPECTED_BLOCK_TEXT", f"review_context.platforms.{platform}.expected_blocks", expected_entry, "text/url entries require exact string text")
                    normalized["text"] = str(expected_entry.get("text", ""))
                normalized_expected_entries.append(normalized)
            if context_blocks and actual_entries != normalized_expected_entries:
                fail("PLATFORM_BODY_CONTEXT", platform, actual_entries, str(normalized_expected_entries))

            if platform in MODULE_PATTERNS:
                patterns = MODULE_PATTERNS[platform]
                if len(numbered) != len(patterns):
                    fail("MODULE_COUNT", platform, [value for _, value in numbered], f"{len(patterns)} fixed numbered modules")
                for n, pattern in enumerate(patterns):
                    if n >= len(numbered):
                        continue
                    block, value = numbered[n]
                    if not re.match(pattern, value):
                        fail("MODULE_LABEL", f"{platform} {n + 1}", value, pattern)

                if numbered and platform != "贴吧":
                    home_text = numbered[0][1]
                    valid_home_start = re.compile(
                        r"^（1）(?:"
                        r"(?:无个人主页|无官方主页|无项目主页|无豆瓣人物主页|无豆瓣官方主页|无豆瓣项目主页)；"
                        r"|(?:个人主页|官方主页|项目主页|疑似主页|疑似官方主页|疑似项目主页|音乐人页|豆瓣人物主页|豆瓣官方主页|豆瓣项目主页|疑似豆瓣人物主页|疑似豆瓣官方主页|疑似豆瓣项目主页)(?:\d+)?："
                        r")"
                    )
                    if not valid_home_start.match(home_text):
                        fail("HOME_LABEL", platform, home_text, "approved homepage label, optional numeric suffix, and required colon/semicolon")
                    if "无个人主页" in home_text or "无豆瓣人物主页" in home_text:
                        expected = NO_HOME_EXACT[platform]
                        if home_text != expected:
                            fail("NO_HOME_TEXT", platform, home_text, expected)
                    elif not context_risk_items:
                        home_endings = ("相关内容无问题",) if platform == "豆瓣" else ("无问题",)
                        if "http" in home_text and not home_text.endswith(home_endings):
                            fail("HOME_CONCLUSION", platform, home_text, "homepage URL followed by platform-specific no-risk phrase")

                if not context_risk_items and numbered:
                    search_text = numbered[-1][1]
                    if "关键词搜索：" in search_text:
                        allowed_endings = SEARCH_ENDINGS.get(platform)
                        if allowed_endings is None:
                            fail("SEARCH_MODULE_FORBIDDEN", platform, search_text, "no keyword-search module under the current platform contract")
                        elif not search_text.endswith(allowed_endings):
                            fail("SEARCH_CONCLUSION", platform, search_text, "one exact clean conclusion from platform-format.md")

                if platform == "微博" and len(numbered) >= 3 and "无超话/话题" in numbered[2][1] and numbered[2][1] != "（3）无超话/话题；":
                    fail("WEIBO_TOPIC", platform, numbered[2][1], "（3）无超话/话题；")
                if platform == "贴吧" and numbered and "无主题贴吧" in numbered[0][1] and numbered[0][1] != "（1）无主题贴吧；":
                    fail("TIEBA_TOPIC", platform, numbered[0][1], "（1）无主题贴吧；")
                if platform == "抖音" and numbered:
                    home_urls = URL_RE.findall(numbered[0][1])
                    if home_urls and _is_search_url(home_urls[0]):
                        fail("DOUYIN_HOME_SEARCH_ROUTE", platform, home_urls[0], "an actual Douyin /user/ profile URL for a confirmed homepage")
                if platform == "X":
                    time_entries = [(index, text_of(block)) for index, block in enumerate(nonblank) if text_of(block).startswith("背调时间：")]
                    time_lines = [value for _, value in time_entries]
                    home_text = numbered[0][1] if numbered else ""
                    confirmed_home = bool(URL_RE.search(home_text)) and not re.match(r"^（1）(?:无|疑似)", home_text)
                    no_home = re.match(r"^（1）无(?:个人|官方|项目)主页；$", home_text) is not None
                    if no_home and time_lines:
                        fail("X_TIME_WITHOUT_HOME", platform, time_lines, "no back-check time when no homepage")
                    if confirmed_home and not time_lines:
                        fail("X_TIME_REQUIRED", platform, "missing", "exactly one line such as 背调时间：2019年2月—至今")
                    if len(time_lines) > 1:
                        fail("X_TIME_COUNT", platform, time_lines, "exactly one back-check time line")
                    for time_index, time_value in time_entries:
                        if "年 月" in time_value:
                            fail("X_TIME_PLACEHOLDER", platform, time_value, "actual earliest checked month")
                        elif not X_TIME_RE.fullmatch(time_value):
                            fail("X_TIME_FORMAT", platform, time_value, "背调时间：YYYY年M月—至今 with a real month")
                        if numbered:
                            first_module_index = next((i for i, block in enumerate(nonblank) if FULLWIDTH_NUMBER_RE.match(text_of(block))), len(nonblank))
                            if time_index != first_module_index - 1:
                                fail("X_TIME_ORDER", platform, time_value, "the back-check time line immediately before the numbered X modules")

            elif platform == "境内其他内容":
                values = [value for _, value in numbered]
                nums = [int(FULLWIDTH_NUMBER_RE.match(value).group(1)) for value in values]
                if nums != list(range(1, len(nums) + 1)):
                    fail("OTHER_NUMBER", platform, nums, "fullwidth numbering from 1 without gaps")
                if not values or not values[0].startswith("（1）百度关键词搜索："):
                    fail("DOMESTIC_FIRST", platform, values[:1], "（1）百度关键词搜索：…")
                elif not context_risk_items and not values[0].endswith(SEARCH_ENDINGS[platform]):
                    fail("DOMESTIC_BAIDU", platform, values[0], "Baidu URL followed by 无相关内容 or 相关内容无问题")
                if not nonblank or text_of(nonblank[-1]) != DOMESTIC_TAIL:
                    fail("DOMESTIC_TAIL", platform, text_of(nonblank[-1]) if nonblank else "", DOMESTIC_TAIL)
            elif platform == "境外其他网站":
                values = [value for _, value in numbered]
                nums = [int(FULLWIDTH_NUMBER_RE.match(value).group(1)) for value in values]
                if nums != list(range(1, len(nums) + 1)):
                    fail("OTHER_NUMBER", platform, nums, "fullwidth numbering from 1 without gaps")
                if not values or not values[0].startswith("（1）谷歌关键词搜索："):
                    fail("FOREIGN_FIRST", platform, values[:1], "（1）谷歌关键词搜索：…")
                elif not context_risk_items and not values[0].endswith(SEARCH_ENDINGS[platform]):
                    fail("FOREIGN_GOOGLE", platform, values[0], "Google URL followed by 无相关内容 or 相关内容无问题")
                if not nonblank or text_of(nonblank[-1]) != FOREIGN_TAIL:
                    fail("FOREIGN_TAIL", platform, text_of(nonblank[-1]) if nonblank else "", FOREIGN_TAIL)

            for item in nonblank:
                value = text_of(item)
                if "http" in value and (FULLWIDTH_NUMBER_RE.match(value) or "关键词搜索：" in value or "主页：" in value):
                    for visible_url in URL_RE.findall(value):
                        linked_runs = []
                        for run in runs(item):
                            style = run.get("text_element_style", {})
                            link = style.get("link") if isinstance(style, dict) else None
                            if run.get("content") == visible_url and isinstance(link, dict) and link.get("url"):
                                linked_runs.append(str(link["url"]))
                        if not linked_runs:
                            fail("VISIBLE_LINK", item.get("block_id", ""), visible_url, "visible URL in its own linked text run")
                        elif visible_url not in linked_runs:
                            fail("LINK_TARGET", item.get("block_id", ""), linked_runs, f"exact target {visible_url}")
                    linked_text_runs = [run for run in runs(item) if isinstance(run.get("text_element_style", {}).get("link"), dict)]
                    for linked_run in linked_text_runs:
                        content = str(linked_run.get("content", ""))
                        target = str(linked_run.get("text_element_style", {}).get("link", {}).get("url", ""))
                        if content not in URL_RE.findall(value):
                            fail("LINK_SCOPE", item.get("block_id", ""), content, "only each complete visible URL is linked")
                        elif target != content:
                            fail("LINK_TARGET", item.get("block_id", ""), target, f"exact target {content}")
                if re.fullmatch(r"https?://\S+", value):
                    if any(run.get("text_element_style", {}).get("link") for run in runs(item)):
                        fail("RISK_URL_STYLE", item.get("block_id", ""), value, "platform risk URL displayed as unlinked plain text")

            for risk_index, risk_item in enumerate(context_risk_items):
                restricted = isinstance(risk_item, dict) and risk_item.get("source_kind") == RESTRICTED_SOURCE_KIND
                source_keys = {"restricted_source"} if restricted else {"url"}
                if not isinstance(risk_item, dict) or not (required_risk_item_keys | source_keys).issubset(risk_item):
                    continue
                fact_indices = [i for i, item in enumerate(nonblank) if item.get("block_type") == 2 and text_of(item) == risk_item["fact_text"]]
                # 主页与名称搜索可以各展示同一事实；必须在本平台预期区块中逐处声明。
                declared_indices = [i for i, entry in enumerate(context_blocks)
                                    if entry.get("kind") == "text" and entry.get("text") == risk_item["fact_text"]]
                if not declared_indices or len(fact_indices) != len(declared_indices):
                    fail("RISK_FACT_CONTEXT", f"{platform} risk_items[{risk_index}]", fact_indices,
                         f"exactly {len(declared_indices)} explicitly declared fact occurrences in this platform: {risk_item['fact_text']}")
                    continue
                expected_image_count = risk_item["image_count"] if type(risk_item["image_count"]) is int and risk_item["image_count"] >= 1 else None
                if expected_image_count is None:
                    mark_blocked("RISK_ITEM_IMAGE_SCHEMA", f"{platform} risk_items[{risk_index}].image_count", risk_item["image_count"], "integer >= 1, excluding bool")
                    continue
                for declared_index in declared_indices:
                    cursor = declared_index + 1
                    declared_images = 0
                    while cursor < len(context_blocks) and context_blocks[cursor].get("kind") == "image":
                        declared_images += 1
                        cursor += 1
                    if restricted:
                        next_entry = context_blocks[cursor] if cursor < len(context_blocks) else None
                        if (declared_images != expected_image_count
                                or isinstance(next_entry, dict) and next_entry.get("kind") == "url"):
                            fail("RISK_FACT_DECLARATION", f"{platform} risk_items[{risk_index}] expected_blocks[{declared_index}]",
                                 {"images": declared_images, "next": next_entry if next_entry is not None else "end"},
                                 f"{expected_image_count} safe images with no public URL for the verified restricted source")
                    elif (declared_images != expected_image_count or cursor >= len(context_blocks)
                            or context_blocks[cursor].get("kind") != "url"
                            or context_blocks[cursor].get("text") != risk_item["url"]):
                        fail("RISK_FACT_DECLARATION", f"{platform} risk_items[{risk_index}] expected_blocks[{declared_index}]",
                             {"images": declared_images, "next": context_blocks[cursor] if cursor < len(context_blocks) else "missing"},
                             f"{expected_image_count} images followed by the exact unlinked risk URL {risk_item['url']}")
                for occurrence_index, fact_index in enumerate(fact_indices, 1):
                    cursor = fact_index + 1
                    actual_image_count = 0
                    while cursor < len(nonblank) and nonblank[cursor].get("block_type") == 27:
                        actual_image_count += 1
                        cursor += 1
                    occurrence_location = f"{platform} risk_items[{risk_index}] occurrence {occurrence_index}"
                    if actual_image_count != expected_image_count:
                        fail("RISK_ITEM_IMAGES", occurrence_location, actual_image_count, str(expected_image_count))
                    if restricted:
                        if cursor < len(nonblank) and re.fullmatch(r"https?://\S+", text_of(nonblank[cursor])):
                            fail("RISK_RESTRICTED_URL_EXPOSED", occurrence_location, "URL follows restricted-source evidence",
                                 "no public URL block after the safe evidence image")
                    elif cursor >= len(nonblank) or nonblank[cursor].get("block_type") != 2 or text_of(nonblank[cursor]) != risk_item["url"]:
                        fail("RISK_ITEM_URL", occurrence_location, text_of(nonblank[cursor]) if cursor < len(nonblank) else "missing", str(risk_item["url"]))
                    elif any(run.get("text_element_style", {}).get("link") for run in runs(nonblank[cursor])):
                        fail("RISK_URL_STYLE", nonblank[cursor].get("block_id", ""), risk_item["url"], "unlinked plain text")

    banned = ("MM.DD-XXX", "举例1【】", "风险点同X", "风险点同B站", "TODO")
    for block in items:
        value = text_of(block)
        for token in banned:
            if token in value:
                fail("PLACEHOLDER", block.get("block_id", ""), value, f"remove template placeholder {token}")
        prose_only = URL_RE.sub(" ", value)
        for token in PROCESS_PROSE_TERMS:
            if token.casefold() in prose_only.casefold():
                fail("PROCESS_PROSE", block.get("block_id", ""), value, f"remove internal process wording {token}")
        ascii_match = PROCESS_ASCII_TERM_RE.search(prose_only)
        if ascii_match:
            fail("PROCESS_PROSE", block.get("block_id", ""), value, f"remove internal process wording {ascii_match.group(0)}")

    # Known deterministic defects remain FAIL even while another check is pending.
    verdict = "FAIL" if errors else ("BLOCKED" if blocked else "PASS")
    result = {
        "schema_version": 1,
        "script_version": SCRIPT_VERSION,
        "verdict": verdict,
        "document": {"title": title, "token": document_token, "revision_id": meta.get("revision_id")},
        "stats": {"blocks": len(items), "root_blocks": len(root), "platform_titles": len(platform_positions), "blocked": len(blocked), "errors": len(errors)},
        "visual": {
            "mode": visual_mode,
            "verdict": "BLOCKED" if any(str(item.get("code", "")).startswith(("VISUAL_", "INTERNAL_JUMP_")) for item in blocked) else "PASS",
            "layout_fingerprint": current_layout_fingerprint,
        },
        "disclaimer_review": {
            "verdict": "FAIL" if disclaimer_result["errors"] else ("BLOCKED" if disclaimer_result["blocked"] else "PASS"),
            "policy_version": DISCLAIMER_POLICY_VERSION,
            "text_sha256": disclaimer_result["text_sha256"],
        },
        "business_risk_review": {
            "verdict": business_risk_verdict,
            "record_sha256": business_review_sha256,
            "confirmed_hits": business_confirmed_hits_count,
        },
        "blocked": blocked,
        "errors": errors,
        "info": info,
        "audit_metadata": {
            "token": document_token,
            "revision_id": meta.get("revision_id"),
            "verdict": verdict,
            "script_version": SCRIPT_VERSION,
            "reviewer_id": reviewer_id,
            "layout_fingerprint": current_layout_fingerprint,
            "disclaimer_policy_version": DISCLAIMER_POLICY_VERSION,
            "text_sha256": disclaimer_result["text_sha256"],
            "business_risk_review_sha256": business_review_sha256,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
    }
    if verdict == "PASS":
        result["receipt"] = result.pop("audit_metadata")
    return result


def _text_block(block_id: str, content: str, block_type: int = 2, bold: bool = False, link_url: str | None = None) -> dict[str, Any]:
    key = {2: "text", 5: "heading3", 6: "heading4", 13: "ordered"}.get(block_type, "text")
    style: dict[str, Any] = {"bold": bold, "italic": False, "underline": False, "strikethrough": False, "inline_code": False}
    if link_url:
        style["link"] = {"url": link_url}
    return {"block_id": block_id, "block_type": block_type, key: {"elements": [{"text_run": {"content": content, "text_element_style": style}}], "style": {"align": 1}}}


def _selftest_fixture() -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    root_children: list[str] = []
    counter = 0

    def ident(prefix: str = "b") -> str:
        nonlocal counter
        counter += 1
        return f"{prefix}{counter}"

    def root_add(block: dict[str, Any]) -> dict[str, Any]:
        block["parent_id"] = "9.12-test"
        root_children.append(block["block_id"])
        items.append(block)
        return block

    page = _text_block("9.12-test", "9.12-测试", 2)
    page["block_type"] = 1
    page["page"] = page.pop("text")
    page["children"] = root_children
    page["parent_id"] = ""
    items.append(page)

    root_add(_text_block(ident(), "风险摘要", 5))
    risk = root_add({"block_id": ident(), "block_type": 19, "callout": {"emoji_id": "trophy", "background_color": 2, "border_color": 2}, "children": []})
    for value in ("风险摘要", "无"):
        child = _text_block(ident(), value)
        child["parent_id"] = risk["block_id"]
        risk["children"].append(child["block_id"])
        items.append(child)
    root_add({"block_id": ident(), "block_type": 22, "divider": {}})
    root_add(_text_block(ident(), "基本信息", 5))

    fields = [
        ("bust_in_silhouette", "背调对象：测试"),
        ("books", "类别：测试"),
        ("heart", "背调结果：低合作风险"),
        ("ledger", "简介：测试"),
    ]
    for pair in (fields[:2], fields[2:]):
        grid = root_add({"block_id": ident(), "block_type": 24, "grid": {"column_size": 2}, "children": []})
        for icon, value in pair:
            col = {"block_id": ident(), "block_type": 25, "grid_column": {"width_ratio": 50}, "children": [], "parent_id": grid["block_id"]}
            grid["children"].append(col["block_id"])
            items.append(col)
            callout = {"block_id": ident(), "block_type": 19, "callout": {"emoji_id": icon}, "children": [], "parent_id": col["block_id"]}
            col["children"].append(callout["block_id"])
            items.append(callout)
            field = _text_block(ident(), value, bold=True)
            if value.startswith("背调结果："):
                field["text"]["elements"] = [
                    {"text_run": {"content": "背调结果：", "text_element_style": {"bold": True}}},
                    {"text_run": {"content": "低合作风险", "text_element_style": {"bold": True}}},
                ]
            field["parent_id"] = callout["block_id"]
            callout["children"].append(field["block_id"])
            items.append(field)

    works = root_add({"block_id": ident(), "block_type": 19, "callout": {"emoji_id": "white_check_mark"}, "children": []})
    for value in ("代表作：", "《测试作品》"):
        child = _text_block(ident(), value)
        child["parent_id"] = works["block_id"]
        works["children"].append(child["block_id"])
        items.append(child)
    root_add({"block_id": ident(), "block_type": 22, "divider": {}})
    root_add(_text_block(ident(), "背调详情", 5))

    platform_lines = {
        "微博": ["（1）无个人主页；", "（2）关键词搜索：https://example.com/weibo 无相关内容", "（3）无超话/话题；"],
        "B站": ["（1）无个人主页；", "（2）关键词搜索：https://example.com/bili 无涉及的视频，专栏及其互动"],
        "抖音": ["（1）无个人主页；", "（2）关键词搜索：https://example.com/douyin 无相关内容"],
        "小红书": ["（1）无个人主页；", "（2）关键词搜索：https://example.com/xhs 无涉及的笔记及其互动"],
        "知乎": ["（1）无个人主页；", "（2）关键词搜索：https://example.com/zhihu 无相关内容"],
        "网易云音乐": ["（1）无个人主页；"],
        "贴吧": ["（1）无主题贴吧；", "（2）关键词搜索：https://example.com/tieba 无涉及内容及其互动"],
        "豆瓣": ["（1）无豆瓣人物主页；", "（2）关键词搜索：https://example.com/douban 无涉及的内容及其互动"],
        "境内其他内容": ["（1）百度关键词搜索：https://example.com/baidu 无相关内容", DOMESTIC_TAIL],
        "X": ["（1）无个人主页；", "（2）关键词搜索：https://example.com/x 无涉及内容及其互动"],
        "Facebook": ["（1）无个人主页；", "（2）关键词搜索：https://example.com/facebook 无相关内容"],
        "INS": ["（1）无个人主页；"],
        "油管": ["（1）无个人主页；", "（2）关键词搜索：https://example.com/youtube 无相关内容"],
        "境外其他网站": ["（1）谷歌关键词搜索：https://example.com/google 无相关内容", FOREIGN_TAIL],
    }

    for number, platform in enumerate(PLATFORMS, 1):
        title_block = _text_block(ident(), platform, 13)
        title_block["ordered"]["style"]["sequence"] = str(number)
        root_add(title_block)
        for value in platform_lines[platform]:
            match = URL_RE.search(value)
            if not match:
                root_add(_text_block(ident(), value))
                continue
            url = match.group(0)
            before, after = value[:match.start()], value[match.end():]
            block = _text_block(ident(), "")
            block["text"]["elements"] = [
                {"text_run": {"content": before, "text_element_style": {"bold": False}}},
                {"text_run": {"content": url, "text_element_style": {"bold": False, "link": {"url": url}}}},
                {"text_run": {"content": after, "text_element_style": {"bold": False}}},
            ]
            root_add(block)
        root_add(_text_block(ident(), ""))

    platform_context = {}
    for platform, values in platform_lines.items():
        numbered_values = [value for value in values if FULLWIDTH_NUMBER_RE.match(value)]
        def fixture_status(value: str) -> str:
            if "无个人主页" in value or "无豆瓣人物主页" in value or "无超话/话题" in value or "无主题贴吧" in value:
                return "no_result"
            if "关键词搜索：" in value:
                no_result_ending = NO_RESULT_SEARCH.get(platform)
                return "no_result" if no_result_ending and value.endswith(no_result_ending) else "checked_clean"
            return "checked_clean"
        def fixture_evidence(value: str, status: str) -> dict[str, Any]:
            evidence: dict[str, Any] = {
                "source_type": "independent_platform_check",
                "source_locator": "https://example.com/fixture-source",
                "checked_at": "2026-09-12T00:00:00Z",
                "summary": "Independent self-test fact fixture.",
            }
            if "关键词搜索：" in value:
                evidence["related_result_count"] = 0 if status == "no_result" else 1
                if platform == "B站":
                    evidence["checked_surfaces"] = ["video", "article"]
            if ("主页" in value or "音乐人页" in value) and "关键词搜索：" not in value:
                evidence["confirmed_homepage_count"] = 0 if status == "no_result" else 1
            if "超话/话题" in value or "主题贴吧" in value:
                evidence["related_topic_count"] = 0 if status == "no_result" else 1
            return evidence
        modules = []
        for value in numbered_values:
            status = fixture_status(value)
            modules.append({"text": value, "status": status, "fact_evidence": fixture_evidence(value, status)})
        platform_context[platform] = {
            "modules": modules,
            "risk_items": [],
            "expected_blocks": [{"kind": "text", "text": value} for value in values],
        }

    return {
        "document": {"title": "9.12-测试", "revision_id": 1},
        "block_list": {"has_more": False, "items": items},
        "raw_content": "\n".join(text_of(item) for item in items),
        "review_context": {
            "subject_type": "person",
            "before_revision": 1,
            "after_revision": 1,
            "writer_id": "delivery-agent",
            "reviewer_id": "independent-review-agent",
            "context_builder_id": "independent-review-agent",
            "risk_groups": [],
            "platforms": platform_context,
            "visual_check": {
                "mode": "fresh",
                "revision_id": 1,
                "token": "9.12-test",
                "method": "self-test fixture",
                "checked_at": "2026-09-12T00:00:00Z",
                "checks": {
                    "heading_levels": True,
                    "cards_and_grids": True,
                    "visible_platform_numbers": True,
                    "spacing": True,
                    "images": True,
                },
            },
        },
    }


def _selftest_search_count_cases() -> list[tuple[str, dict[str, Any], str, str | None]]:
    base = {
        "related_result_count": None,
        "related_result_count_verified_minimum": 1,
        "related_result_count_exact_total_unknown": True,
        "related_result_count_minimum_source_locator": "https://example.com/research-record",
        "source_locator": "https://example.com/research-record",
    }
    cases: list[tuple[str, dict[str, Any], str, str | None]] = []
    def add(name: str, patch: dict[str, Any] | None = None, *, remove: str | None = None,
            status: str = "checked_clean", expected: str | None = "SEARCH_RESULT_COUNT") -> None:
        evidence = copy.deepcopy(base)
        if patch:
            evidence.update(patch)
        if remove:
            evidence.pop(remove, None)
        cases.append((name, evidence, status, expected))
    add("minimum-one-clean", expected=None)
    add("minimum-fourteen-clean", {"related_result_count_verified_minimum": 14}, expected=None)
    add("minimum-one-risk", status="risk", expected=None)
    add("minimum-source-explicitly-declared", {
        "related_result_count_minimum_source_locator": "https://example.com/other-record",
        "source_locators": [{"locator": "https://example.com/other-record"}],
    }, expected=None)
    add("minimum-no-result", status="no_result", expected="EVIDENCE_STATUS_MISMATCH")
    add("minimum-zero", {"related_result_count_verified_minimum": 0})
    add("minimum-negative", {"related_result_count_verified_minimum": -1})
    add("minimum-bool", {"related_result_count_verified_minimum": True})
    add("minimum-float", {"related_result_count_verified_minimum": 1.0})
    add("minimum-string", {"related_result_count_verified_minimum": "1"})
    add("minimum-null", {"related_result_count_verified_minimum": None})
    add("minimum-missing", remove="related_result_count_verified_minimum")
    add("unknown-false", {"related_result_count_exact_total_unknown": False})
    add("unknown-integer", {"related_result_count_exact_total_unknown": 1})
    add("unknown-string", {"related_result_count_exact_total_unknown": "true"})
    add("unknown-missing", remove="related_result_count_exact_total_unknown")
    add("minimum-source-blank", {"related_result_count_minimum_source_locator": " "})
    add("minimum-source-null", {"related_result_count_minimum_source_locator": None})
    add("minimum-source-number", {"related_result_count_minimum_source_locator": 1})
    add("minimum-source-missing", remove="related_result_count_minimum_source_locator")
    add("minimum-source-undeclared", {"related_result_count_minimum_source_locator": "https://example.com/unlisted"})
    add("minimum-source-whitespace-mismatch", {"related_result_count_minimum_source_locator": " https://example.com/research-record "})
    add("mixed-exact-and-minimum", {"related_result_count": 14})
    add("mixed-zero-and-minimum", {"related_result_count": 0})
    add("explicit-null-key-missing", remove="related_result_count")
    cases.extend([
        ("exact-zero-no-result", {"related_result_count": 0}, "no_result", None),
        ("exact-one-clean", {"related_result_count": 1}, "checked_clean", None),
        ("exact-fourteen-risk", {"related_result_count": 14}, "risk", None),
        ("exact-zero-clean-mismatch", {"related_result_count": 0}, "checked_clean", "EVIDENCE_STATUS_MISMATCH"),
        ("exact-positive-no-result-mismatch", {"related_result_count": 1}, "no_result", "EVIDENCE_STATUS_MISMATCH"),
        ("exact-bool-true", {"related_result_count": True}, "checked_clean", "SEARCH_RESULT_COUNT"),
        ("exact-bool-false", {"related_result_count": False}, "no_result", "SEARCH_RESULT_COUNT"),
        ("exact-negative", {"related_result_count": -1}, "checked_clean", "SEARCH_RESULT_COUNT"),
        ("exact-float", {"related_result_count": 1.0}, "checked_clean", "SEARCH_RESULT_COUNT"),
        ("exact-string", {"related_result_count": "1"}, "checked_clean", "SEARCH_RESULT_COUNT"),
        ("exact-null-unexplained", {"related_result_count": None}, "checked_clean", "SEARCH_RESULT_COUNT"),
        ("exact-key-missing", {}, "checked_clean", "SEARCH_RESULT_COUNT"),
        ("legacy-fields-not-auto-migrated", {"related_result_count": None, "related_result_count_min": 1, "related_total_unknown": True}, "checked_clean", "SEARCH_RESULT_COUNT"),
        ("legacy-global-total-unknown-with-exact-sample", {"related_result_count": 1, "related_result_count_min": 1, "related_total_unknown": True}, "checked_clean", None),
    ])
    return cases


def self_test() -> int:
    def _fixture_audit(snapshot: dict[str, Any]) -> dict[str, Any]:
        # Synthetic fixtures explicitly model a completed semantic review. This
        # helper is test-only; production never generates a semantic PASS.
        doc, data, context = normalize_input(snapshot)
        groups = context.get("risk_groups") if isinstance(context.get("risk_groups"), list) else []
        fixture_items = data["items"]
        fixture_by_id = {str(item.get("block_id")): item for item in fixture_items if item.get("block_id")}
        result_block = next(item for item in fixture_items if text_of(item).startswith("背调结果："))
        result_level = text_of(result_block).split("：", 1)[1]
        fixture_hits = []
        for index, group in enumerate(groups, 1):
            if not isinstance(group, dict):
                continue
            summary_block = next(item for item in fixture_items if text_of(item) == f"{index}：{group.get('summary')}")
            platform_block = fixture_by_id[str(group.get("target_block_id"))]
            fixture_hits.append(
                {
                    "business_item": "LGBTQ/BL/GL（单独成轴）",
                    "verified_fact": text_of(platform_block),
                    "risk_group_index": index,
                    "summary_location": block_location(summary_block),
                    "platform_location": block_location(platform_block),
                    "result_level": result_level,
                    "result_location": block_location(result_block),
                }
            )
        context["business_risk_review"] = {
            "status": "PASS",
            "scope": "current_business_risk_policy_and_full_document",
            "token": review_document_token(doc, data["items"]),
            "revision_id": doc.get("revision_id"),
            "policy_sources": [policy_source()],
            "confirmed_hits": fixture_hits,
            "conflicts": [],
            "reviewer_id": context.get("reviewer_id"),
            "checked_at": "2026-10-14T00:00:00Z",
        }
        context["disclaimer_review"] = {
            "status": "PASS", "scope": "full_document",
            "policy_version": DISCLAIMER_POLICY_VERSION,
            "token": review_document_token(doc, data["items"]),
            "revision_id": doc.get("revision_id"),
            "text_sha256": review_text_fingerprint(doc, data["items"], snapshot.get("raw_content")),
            "reviewer_id": "self-test-fixture", "checked_at": "2026-10-12T00:00:00Z", "findings": [],
        }
        return audit(snapshot)

    # 计数的存在性门禁必须接受真实已核下限，但不能把未知或非法组合当精确数。
    for name, evidence, status, expected_code in _selftest_search_count_cases():
        before = copy.deepcopy(evidence)
        issue = _search_result_count_issue(evidence, status)
        actual_code = issue[0] if issue else None
        if actual_code != expected_code or evidence != before:
            print(json.dumps({"search_count_case": name, "expected": expected_code,
                              "actual": actual_code, "evidence_mutated": evidence != before}, ensure_ascii=False, indent=2))
            return 1

    # Registered public lists are evidence; ordinary and unknown space routes are not.
    public_list_source_cases = [
        ("https://space.bilibili.com/1000000128/bangumi", True),
        ("https://space.bilibili.com/1000000128/bangumi/", True),
        ("https://space.bilibili.com:443/1000000128/bangumi", True),
        ("https://space.bilibili.com/1000000128", False),
        ("https://space.bilibili.com/1000000128/upload/video", False),
        ("https://space.bilibili.com/1000000128/dynamic", False),
        ("https://space.bilibili.com/1000000128/bangumi/extra", False),
        ("https://space.bilibili.com/example/bangumi", False),
        ("https://space.bilibili.com/１２３/bangumi", False),
        ("https://example.com/1000000128/bangumi", False),
        ("http://space.bilibili.com/1000000128/bangumi", False),
        ("https://space.bilibili.com:8443/1000000128/bangumi", False),
        ("https://user@space.bilibili.com/1000000128/bangumi", False),
        ("https://space.bilibili.com/1000000128/bangumi#section", False),
        ("https://space.bilibili.com/1000000128/bangumi?q=other", False),
        ("https://space.bilibili.com/1000000128/%62angumi", False),
        ("https://www.bilibili.com/video/BV1000000007/", True),
        ("https://t.bilibili.com/1000000000000000130", True),
        ("https://space.bilibili.com/100000131/favlist", True),
        ("https://space.bilibili.com/100000131/favlist/", True),
        ("https://space.bilibili.com:443/100000131/favlist", True),
        ("HTTPS://SPACE.BILIBILI.COM/100000131/favlist", True),
        ("https://space.bilibili.com/100000131", False),
        ("https://space.bilibili.com/100000131/upload/video", False),
        ("https://space.bilibili.com/100000131/dynamic", False),
        ("https://space.bilibili.com/100000131/cinema", False),
        ("https://space.bilibili.com/100000131/unknown", False),
        ("https://space.bilibili.com/100000131/favlist/extra", False),
        ("https://space.bilibili.com/100000131/favlist//", False),
        ("https://space.bilibili.com/example/favlist", False),
        ("https://space.bilibili.com/１２３/favlist", False),
        ("https://example.com/100000131/favlist", False),
        ("https://space.bilibili.com.example.com/100000131/favlist", False),
        ("http://space.bilibili.com/100000131/favlist", False),
        ("https://space.bilibili.com:8443/100000131/favlist", False),
        ("https://user@space.bilibili.com/100000131/favlist", False),
        ("https://space.bilibili.com/100000131/favlist#section", False),
        ("https://space.bilibili.com/100000131/favlist?q=other", False),
        ("https://space.bilibili.com/100000131/%66avlist", False),
    ]
    for source_url, expected_direct in public_list_source_cases:
        actual_direct = _is_direct_content_url("B站", source_url)
        if actual_direct is not expected_direct or (expected_direct and _is_profile_or_home_url("B站", source_url)):
            print(json.dumps({"self_test": "bilibili_public_list_source", "url": source_url, "expected_direct": expected_direct, "actual_direct": actual_direct}, ensure_ascii=False))
            return 1

    valid = _selftest_fixture()
    result = _fixture_audit(valid)
    if result["verdict"] != "PASS":
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1

    missing_business_review = copy.deepcopy(valid)
    missing_business_review["review_context"].pop("business_risk_review")
    missing_business_result = audit(missing_business_review)
    if missing_business_result["verdict"] != "BLOCKED" or not any(
        item["code"] == "BUSINESS_RISK_REVIEW" for item in missing_business_result["blocked"]
    ):
        print(json.dumps(missing_business_result, ensure_ascii=False, indent=2))
        return 1

    explicit_business_conflict = copy.deepcopy(valid)
    explicit_business_conflict["review_context"]["business_risk_review"].update(
        {
            "status": "FAIL",
            "conflicts": [
                {
                    "business_item": "self-test mandatory risk",
                    "verified_fact": "self-test verified fact",
                    "missing_location": "risk summary",
                    "cause": "assistant moral judgment",
                }
            ],
        }
    )
    explicit_business_result = audit(explicit_business_conflict)
    if explicit_business_result["verdict"] != "FAIL" or not any(
        item["code"] == "BUSINESS_RISK_CONFLICT" for item in explicit_business_result["errors"]
    ):
        print(json.dumps(explicit_business_result, ensure_ascii=False, indent=2))
        return 1

    fake_policy_source = copy.deepcopy(valid)
    fake_policy_source["review_context"]["business_risk_review"]["policy_sources"] = [
        {"path": str(Path(policy_source()["path"]).with_name("不存在的风险表.md")), "sha256": "0" * 64}
    ]
    fake_policy_result = audit(fake_policy_source)
    if fake_policy_result["verdict"] != "FAIL" or not any(
        item["code"] == "BUSINESS_RISK_POLICY_SOURCE_INVALID" for item in fake_policy_result["errors"]
    ):
        print(json.dumps(fake_policy_result, ensure_ascii=False, indent=2))
        return 1

    extra_column_blank = copy.deepcopy(valid)
    column = next(item for item in extra_column_blank["block_list"]["items"] if item.get("block_type") == 25)
    padding = _text_block("selftest-extra-column-blank", "")
    padding["parent_id"] = column["block_id"]
    column["children"].append(padding["block_id"])
    extra_column_blank["block_list"]["items"].append(padding)
    column_result = _fixture_audit(extra_column_blank)
    if column_result["verdict"] != "FAIL" or not any(error["code"] == "COLUMN_STRUCTURE" for error in column_result["errors"]):
        print(json.dumps(column_result, ensure_ascii=False, indent=2))
        return 1

    def replace_fixture_line(payload: dict[str, Any], old_text: str, new_text: str, platform: str | None = None) -> None:
        fixture_items = payload["block_list"]["items"]
        candidate_ids: set[str] | None = None
        if platform is not None:
            fixture_by_id = {str(item.get("block_id")): item for item in fixture_items}
            page = next(item for item in fixture_items if item.get("block_type") == 1)
            children = [str(child_id) for child_id in page.get("children", [])]
            start = next(index for index, child_id in enumerate(children) if text_of(fixture_by_id[child_id]) == platform) + 1
            end = next(
                (index for index in range(start, len(children)) if text_of(fixture_by_id[children[index]]) in PLATFORMS),
                len(children),
            )
            candidate_ids = set(children[start:end])
        for item in fixture_items:
            if candidate_ids is not None and str(item.get("block_id")) not in candidate_ids:
                continue
            if text_of(item) != old_text:
                continue
            match = URL_RE.search(new_text)
            if match:
                url = match.group(0)
                item["text"]["elements"] = [
                    {"text_run": {"content": new_text[:match.start()], "text_element_style": {"bold": False}}},
                    {"text_run": {"content": url, "text_element_style": {"bold": False, "link": {"url": url}}}},
                    {"text_run": {"content": new_text[match.end():], "text_element_style": {"bold": False}}},
                ]
            else:
                item["text"]["elements"] = _text_block("unused", new_text)["text"]["elements"]
            return
        raise AssertionError(f"self-test fixture line not found: {old_text}")

    risk_fixture = copy.deepcopy(valid)
    risk_items = risk_fixture["block_list"]["items"]
    risk_page = next(item for item in risk_items if item.get("block_type") == 1)
    root_children = risk_page["children"]
    trophy = next(item for item in risk_items if item.get("block_type") == 19 and item.get("callout", {}).get("emoji_id") == "trophy")
    no_risk_text = next(item for item in risk_items if item.get("block_id") == trophy["children"][1])
    no_risk_text["text"] = _text_block("unused", "1：测试风险")["text"]
    risk_fact = "2026年9月3日，出现测试风险事实。"
    risk_url = "https://x.com/example/status/123456"
    risk_fixture["review_context"]["risk_groups"] = [{
        "title": "测试风险", "summary": "测试风险", "highlight_text": "查看对应风险事实", "target_block_id": "risk-platform-fact",
    }]
    top_h4 = _text_block("risk-top-h4", "举例1【测试风险】", 6)
    top_pin = {"block_id": "risk-top-pin", "block_type": 19, "callout": {"emoji_id": "round_pushpin", "background_color": 2, "border_color": 2}, "children": ["risk-top-pin-text"]}
    top_pin_text = _text_block("risk-top-pin-text", "查看对应风险事实")
    top_pin_text["parent_id"] = top_pin["block_id"]
    top_pin_text["text"]["elements"][0]["text_run"]["text_element_style"]["link"] = {"url": "https://my.feishu.cn/docx/9.12-test#risk-platform-fact"}
    top_fact = _text_block("risk-top-fact", risk_fact)
    top_image = {"block_id": "risk-top-image", "block_type": 27, "image": {"token": "risk-top-image-token"}}
    top_roots = [top_h4, top_pin, top_fact, top_image]
    risk_items.extend([*top_roots, top_pin_text])
    for block in top_roots:
        block["parent_id"] = risk_page["block_id"]
    top_position = root_children.index(trophy["block_id"]) + 1
    root_children[top_position:top_position] = [block["block_id"] for block in top_roots]

    old_search = "（2）关键词搜索：https://example.com/x 无涉及内容及其互动"
    new_search = "（2）关键词搜索：https://example.com/x"
    replace_fixture_line(risk_fixture, old_search, new_search, "X")
    x_context = risk_fixture["review_context"]["platforms"]["X"]
    x_context["modules"][1]["text"] = new_search
    x_context["modules"][1]["status"] = "risk"
    x_context["modules"][1]["fact_evidence"]["related_result_count"] = 1
    x_context["risk_items"] = [{"group_index": 1, "fact_text": risk_fact, "image_count": 1, "url": risk_url}]
    platform_risk = [
        _text_block("risk-platform-heading", "风险点1：测试风险"),
        _text_block("risk-platform-fact", risk_fact),
        {"block_id": "risk-platform-image", "block_type": 27, "image": {"token": "risk-platform-image-token"}},
        _text_block("risk-platform-url", risk_url),
    ]
    for block in platform_risk:
        block["parent_id"] = risk_page["block_id"]
    risk_items.extend(platform_risk)
    search_block = next(item for item in risk_items if text_of(item) == new_search)
    platform_position = root_children.index(search_block["block_id"]) + 1
    root_children[platform_position:platform_position] = [block["block_id"] for block in platform_risk]
    x_context["expected_blocks"] = [
        {"kind": "text", "text": "（1）无个人主页；"},
        {"kind": "text", "text": new_search},
        {"kind": "text", "text": "风险点1：测试风险"},
        {"kind": "text", "text": risk_fact},
        {"kind": "image"},
        {"kind": "url", "text": risk_url},
    ]
    risk_fixture["review_context"]["visual_check"]["jump_checks"] = [{
        "token": "9.12-test", "source_block_id": "risk-top-pin-text", "target_block_id": "risk-platform-fact",
        "method": "live_page", "target_visible": True, "checked_at": "2026-10-13T00:00:00Z",
        "jump_fingerprint": jump_fingerprint(risk_items, "9.12-test", "risk-top-pin-text", "risk-platform-fact"),
    }]
    risk_result = _fixture_audit(risk_fixture)
    if risk_result["verdict"] != "PASS":
        print(json.dumps(risk_result, ensure_ascii=False, indent=2))
        return 1

    # 用户明确停止的搜索可以没有虚构 URL；原话、来源与同批绑定均须真实。
    from tempfile import TemporaryDirectory
    with TemporaryDirectory(prefix="feishu-user-waived-search-") as waived_temp:
        waived_request = "RQ-selftest-user-waived-search"
        waived_quote = "这项搜索不查了，接受剩余误差。"
        waived_path = Path(waived_temp) / "user-instruction.json"
        waived_path.write_text(json.dumps({"requestId": waived_request, "instruction": waived_quote},
                                          ensure_ascii=False), encoding="utf-8")
        waived_fixture = copy.deepcopy(risk_fixture)
        waived_fixture["requestId"] = waived_request
        waived_module = waived_fixture["review_context"]["platforms"]["X"]["modules"][1]
        waived_old_text = waived_module["text"]
        waived_text = "（2）关键词搜索：未查。"
        replace_fixture_line(waived_fixture, waived_old_text, waived_text, "X")
        for entry in waived_fixture["review_context"]["platforms"]["X"]["expected_blocks"]:
            if entry.get("text") == waived_old_text:
                entry["text"] = waived_text
        waived_module.update({"text": waived_text, "status": "not_applicable",
                              "scope_waived": True, "actually_searched": False})
        waived_module["fact_evidence"].update({"source_type": "user_current_instruction",
                                               "source_locator": str(waived_path), "quote": waived_quote})
        # 与A183同形：已核风险来自主页，省略的是尚未做的名称搜索。
        waived_x_context = waived_fixture["review_context"]["platforms"]["X"]
        waived_home = waived_x_context["modules"][0]
        waived_home_old = waived_home["text"]
        waived_home_text = "（1）个人主页：https://x.com/example"
        replace_fixture_line(waived_fixture, waived_home_old, waived_home_text, "X")
        waived_home.update({"text": waived_home_text, "status": "risk"})
        waived_home["fact_evidence"].update({"confirmed_homepage_count": 1,
                                             "homepage_urls": ["https://x.com/example"]})
        for entry in waived_x_context["expected_blocks"]:
            if entry.get("text") == waived_home_old:
                entry["text"] = waived_home_text
        waived_search_entry = next(entry for entry in waived_x_context["expected_blocks"] if entry.get("text") == waived_text)
        waived_x_context["expected_blocks"].remove(waived_search_entry)
        waived_x_context["expected_blocks"].append(waived_search_entry)
        waived_items = waived_fixture["block_list"]["items"]
        waived_page = next(item for item in waived_items if item.get("block_type") == 1)
        waived_time_text = "背调时间：2026年9月—至今"
        waived_time_block = _text_block("selftest-waived-x-time", waived_time_text)
        waived_time_block["parent_id"] = waived_page["block_id"]
        waived_home_block = next(item for item in waived_items if text_of(item) == waived_home_text)
        waived_page["children"].insert(waived_page["children"].index(waived_home_block["block_id"]), waived_time_block["block_id"])
        waived_items.append(waived_time_block)
        waived_x_context["expected_blocks"].insert(0, {"kind": "text", "text": waived_time_text})
        waived_search_block = next(item for item in waived_items if text_of(item) == waived_text)
        waived_page["children"].remove(waived_search_block["block_id"])
        waived_page["children"].insert(waived_page["children"].index("risk-platform-url") + 1,
                                       waived_search_block["block_id"])
        waived_fixture["review_context"]["visual_check"]["jump_checks"][0]["jump_fingerprint"] = jump_fingerprint(
            waived_items, "9.12-test", "risk-top-pin-text", "risk-platform-fact")
        waived_result = _fixture_audit(waived_fixture)
        if waived_result["verdict"] != "PASS":
            print(json.dumps({"self_test": "verified-user-waived-search", "result": waived_result}, ensure_ascii=False))
            return 1
        invalid_waived_cases = []
        missing_quote = copy.deepcopy(waived_fixture)
        del missing_quote["review_context"]["platforms"]["X"]["modules"][1]["fact_evidence"]["quote"]
        invalid_waived_cases.append(("missing-quote", missing_quote))
        mismatched_quote = copy.deepcopy(waived_fixture)
        mismatched_quote["review_context"]["platforms"]["X"]["modules"][1]["fact_evidence"]["quote"] = "来源中没有的停止原话"
        invalid_waived_cases.append(("quote-not-in-source", mismatched_quote))
        wrong_source_type = copy.deepcopy(waived_fixture)
        wrong_source_type["review_context"]["platforms"]["X"]["modules"][1]["fact_evidence"]["source_type"] = "research_record"
        invalid_waived_cases.append(("wrong-source-type", wrong_source_type))
        missing_source = copy.deepcopy(waived_fixture)
        missing_source["review_context"]["platforms"]["X"]["modules"][1]["fact_evidence"]["source_locator"] = str(Path(waived_temp) / "missing.json")
        invalid_waived_cases.append(("missing-source-file", missing_source))
        wrong_request = copy.deepcopy(waived_fixture)
        wrong_request["requestId"] = "RQ-another-batch"
        invalid_waived_cases.append(("wrong-request-id", wrong_request))
        no_scope_waiver = copy.deepcopy(waived_fixture)
        no_scope_waiver["review_context"]["platforms"]["X"]["modules"][1]["scope_waived"] = False
        invalid_waived_cases.append(("scope-not-waived", no_scope_waiver))
        already_searched = copy.deepcopy(waived_fixture)
        already_searched["review_context"]["platforms"]["X"]["modules"][1]["actually_searched"] = True
        invalid_waived_cases.append(("actually-searched", already_searched))
        for waived_name, waived_invalid in invalid_waived_cases:
            waived_invalid_result = _fixture_audit(waived_invalid)
            if (waived_invalid_result["verdict"] != "FAIL"
                    or not any(error["code"] == "MODULE_URL_REQUIRED" for error in waived_invalid_result["errors"])):
                print(json.dumps({"self_test": waived_name, "result": waived_invalid_result}, ensure_ascii=False))
                return 1
        # 同样的 not_applicable/用户字段不能替私密主页省略真实 URL。
        private_fixture = copy.deepcopy(waived_fixture)
        private_text = "（2）BOOTH个人主页：店铺非公开。"
        private_block = _text_block("selftest-private-booth", private_text)
        private_items = private_fixture["block_list"]["items"]
        private_page = next(item for item in private_items if item.get("block_type") == 1)
        private_tail = next(item for item in private_items if text_of(item) == FOREIGN_TAIL)
        private_page["children"].insert(private_page["children"].index(private_tail["block_id"]), private_block["block_id"])
        private_items.append(private_block)
        private_context = private_fixture["review_context"]["platforms"]["境外其他网站"]
        private_module = copy.deepcopy(waived_module)
        private_module.update({"text": private_text, "module_kind": "homepage"})
        private_context["modules"].append(private_module)
        private_context["expected_blocks"].insert(-1, {"kind": "text", "text": private_text})
        private_result = _fixture_audit(private_fixture)
        if (private_result["verdict"] != "FAIL"
                or not any(error["code"] == "MODULE_URL_REQUIRED" for error in private_result["errors"])):
            print(json.dumps({"self_test": "private-homepage-still-requires-url", "result": private_result}, ensure_ascii=False))
            return 1
        private_url_text = "（2）BOOTH个人主页：https://example.booth.pm/ 店铺非公开。"
        replace_fixture_line(private_fixture, private_text, private_url_text, "境外其他网站")
        private_module["text"] = private_url_text
        private_context["expected_blocks"][-2]["text"] = private_url_text
        private_url_result = _fixture_audit(private_fixture)
        if private_url_result["verdict"] != "PASS":
            print(json.dumps({"self_test": "private-homepage-real-url-retained", "result": private_url_result}, ensure_ascii=False))
            return 1
        print("USER_WAIVED_SEARCH_TESTS: PASS (10 cases)")

    nonexistent_business_location = copy.deepcopy(risk_fixture)
    nonexistent_business_location["review_context"]["business_risk_review"]["confirmed_hits"][0]["platform_location"]["block_id"] = "missing-current-block"
    nonexistent_business_result = audit(nonexistent_business_location)
    if nonexistent_business_result["verdict"] != "FAIL" or not any(
        item["code"] == "BUSINESS_RISK_LOCATION_NOT_FOUND" for item in nonexistent_business_result["errors"]
    ):
        print(json.dumps(nonexistent_business_result, ensure_ascii=False, indent=2))
        return 1
    no_jump = copy.deepcopy(risk_fixture)
    no_jump["review_context"]["visual_check"].pop("jump_checks")
    no_jump_result = _fixture_audit(no_jump)
    if no_jump_result["verdict"] != "BLOCKED" or "receipt" in no_jump_result or not any(item["code"] == "INTERNAL_JUMP_REQUIRED" for item in no_jump_result["blocked"]):
        print(json.dumps(no_jump_result, ensure_ascii=False, indent=2))
        return 1
    clicked_only = copy.deepcopy(risk_fixture)
    clicked_only["review_context"]["visual_check"]["jump_checks"][0].pop("target_visible")
    clicked_only["review_context"]["visual_check"]["jump_checks"][0]["clicked"] = True
    clicked_result = _fixture_audit(clicked_only)
    if clicked_result["verdict"] != "BLOCKED" or not any(item["code"] == "INTERNAL_JUMP_VISIBLE" for item in clicked_result["blocked"]):
        print(json.dumps(clicked_result, ensure_ascii=False, indent=2))
        return 1
    incomplete_top = copy.deepcopy(risk_fixture)
    incomplete_top["block_list"]["items"] = [item for item in incomplete_top["block_list"]["items"] if item.get("block_id") != "risk-top-image"]
    next(item for item in incomplete_top["block_list"]["items"] if item.get("block_type") == 1)["children"].remove("risk-top-image")
    incomplete_result = _fixture_audit(incomplete_top)
    if incomplete_result["verdict"] != "FAIL" or not any(error["code"] == "RISK_IMAGES" for error in incomplete_result["errors"]):
        print(json.dumps(incomplete_result, ensure_ascii=False, indent=2))
        return 1
    second_evidence = copy.deepcopy(risk_fixture)
    second_fact = "2026年9月4日，出现第二条测试风险事实。"
    second_url = "https://x.com/example/status/789012"
    second_page = next(item for item in second_evidence["block_list"]["items"] if item.get("block_type") == 1)
    second_blocks = [
        _text_block("risk-platform-fact-2", second_fact),
        {"block_id": "risk-platform-image-2", "block_type": 27, "image": {"token": "risk-platform-image-token-2"}},
        _text_block("risk-platform-url-2", second_url),
    ]
    for block in second_blocks:
        block["parent_id"] = second_page["block_id"]
    second_evidence["block_list"]["items"].extend(second_blocks)
    second_position = second_page["children"].index("risk-platform-url") + 1
    second_page["children"][second_position:second_position] = [block["block_id"] for block in second_blocks]
    second_x = second_evidence["review_context"]["platforms"]["X"]
    second_x["risk_items"].append({"group_index": 1, "fact_text": second_fact, "image_count": 1, "url": second_url})
    second_x["expected_blocks"].extend([{"kind": "text", "text": second_fact}, {"kind": "image"}, {"kind": "url", "text": second_url}])
    missing_second = _fixture_audit(second_evidence)
    if missing_second["verdict"] != "FAIL" or not any(error["code"] == "RISK_FACT" for error in missing_second["errors"]):
        print(json.dumps(missing_second, ensure_ascii=False, indent=2))
        return 1
    top_second_blocks = [_text_block("risk-top-fact-2", second_fact), {"block_id": "risk-top-image-2", "block_type": 27, "image": {"token": "risk-top-image-token-2"}}]
    for block in top_second_blocks:
        block["parent_id"] = second_page["block_id"]
    second_evidence["block_list"]["items"].extend(top_second_blocks)
    top_second_position = second_page["children"].index("risk-top-image") + 1
    second_page["children"][top_second_position:top_second_position] = [block["block_id"] for block in top_second_blocks]
    # This positive fixture represents a fresh observation after target placement changed.
    second_evidence["review_context"]["visual_check"]["jump_checks"][0]["jump_fingerprint"] = jump_fingerprint(
        second_evidence["block_list"]["items"], "9.12-test", "risk-top-pin-text", "risk-platform-fact")
    complete_second = _fixture_audit(second_evidence)
    if complete_second["verdict"] != "PASS":
        print(json.dumps(complete_second, ensure_ascii=False, indent=2))
        return 1
    # The pin may carry the explanation itself; body evidence and semantic review still bind it.
    def highlight_fixture(source: dict[str, Any], explanation: str) -> dict[str, Any]:
        candidate = copy.deepcopy(source)
        candidate_items = candidate["block_list"]["items"]
        page = next(block for block in candidate_items if block.get("block_type") == 1)
        removed = {"risk-top-fact", "risk-top-fact-2"}
        candidate_items[:] = [block for block in candidate_items if block.get("block_id") not in removed]
        page["children"][:] = [bid for bid in page["children"] if bid not in removed]
        pin_text = next(block for block in candidate_items if block.get("block_id") == "risk-top-pin-text")
        pin_text["text"]["elements"][0]["text_run"]["content"] = explanation
        context = candidate["review_context"]
        context["risk_groups"][0]["highlight_text"] = explanation
        for item in context["platforms"]["X"]["risk_items"]:
            item.update({"top_fact_location": "highlight", "top_fact_text": explanation})
            if item["fact_text"] != explanation:
                item["top_fact_review"] = {
                    "status": "PASS", "token": "9.12-test", "revision_id": 1,
                    "fact_text": item["fact_text"], "top_fact_text": explanation,
                    "reviewer_id": "self-test-synthetic-review", "checked_at": "2026-10-30T00:00:00Z",
                }
        context["visual_check"]["jump_checks"][0]["jump_fingerprint"] = jump_fingerprint(
            candidate_items, "9.12-test", "risk-top-pin-text", "risk-platform-fact")
        return candidate

    shared_explanation = highlight_fixture(risk_fixture, risk_fact)
    combined_explanation = highlight_fixture(second_evidence, risk_fact + second_fact)
    for candidate in (shared_explanation, combined_explanation):
        checked = _fixture_audit(candidate)
        if checked["verdict"] != "PASS":
            raise AssertionError(json.dumps(checked, ensure_ascii=False))
    for mutation in ("missing_review", "stale_review", "wrong_location", "unmatched_pin", "missing_image", "missing_body"):
        invalid = copy.deepcopy(combined_explanation)
        item = invalid["review_context"]["platforms"]["X"]["risk_items"][1]
        if mutation == "missing_review":
            item.pop("top_fact_review")
        elif mutation == "stale_review":
            item["top_fact_review"]["revision_id"] = 0
        elif mutation == "wrong_location":
            item["top_fact_location"] = "skip"
        elif mutation == "unmatched_pin":
            item["top_fact_text"] = second_fact
            item["top_fact_review"]["top_fact_text"] = second_fact
        else:
            removed_id = "risk-top-image-2" if mutation == "missing_image" else "risk-platform-fact-2"
            invalid["block_list"]["items"][:] = [block for block in invalid["block_list"]["items"] if block.get("block_id") != removed_id]
            next(block for block in invalid["block_list"]["items"] if block.get("block_type") == 1)["children"].remove(removed_id)
        if _fixture_audit(invalid)["verdict"] == "PASS":
            raise AssertionError(f"invalid highlight explanation passed: {mutation}")

    # A legacy fact block can precede a fact carried by the shared pin.
    mixed_explanation = copy.deepcopy(combined_explanation)
    mixed_items = mixed_explanation["block_list"]["items"]
    mixed_page = next(block for block in mixed_items if block.get("block_type") == 1)
    legacy_fact = copy.deepcopy(next(block for block in second_evidence["block_list"]["items"]
                                    if block.get("block_id") == "risk-top-fact"))
    mixed_items.append(legacy_fact)
    mixed_page["children"].insert(mixed_page["children"].index("risk-top-image"), "risk-top-fact")
    mixed_first = mixed_explanation["review_context"]["platforms"]["X"]["risk_items"][0]
    for key in ("top_fact_location", "top_fact_text", "top_fact_review"):
        mixed_first.pop(key, None)
    mixed_explanation["review_context"]["visual_check"]["jump_checks"][0]["jump_fingerprint"] = jump_fingerprint(
        mixed_items, "9.12-test", "risk-top-pin-text", "risk-platform-fact")
    mixed_result = _fixture_audit(mixed_explanation)
    if mixed_result["verdict"] != "PASS":
        raise AssertionError(json.dumps(mixed_result, ensure_ascii=False))
    extra_image_fixture = copy.deepcopy(mixed_explanation)
    extra_items = extra_image_fixture["block_list"]["items"]
    extra_image = copy.deepcopy(next(block for block in extra_items if block.get("block_id") == "risk-top-image-2"))
    extra_image["block_id"] = "risk-top-image-extra"
    extra_items.append(extra_image)
    extra_page = next(block for block in extra_items if block.get("block_type") == 1)
    extra_page["children"].insert(extra_page["children"].index("risk-top-image-2") + 1, extra_image["block_id"])
    extra_image_fixture["review_context"]["visual_check"]["jump_checks"][0]["jump_fingerprint"] = jump_fingerprint(
        extra_items, "9.12-test", "risk-top-pin-text", "risk-platform-fact")
    extra_image_result = _fixture_audit(extra_image_fixture)
    if not any(error["code"] == "RISK_EXTRA_BLOCKS" for error in extra_image_result["errors"]):
        raise AssertionError("unmanifested image in mixed top layout was not rejected")

    wrong_first_target = copy.deepcopy(second_evidence)
    wrong_first_target["review_context"]["risk_groups"][0]["target_block_id"] = "risk-platform-fact-2"
    wrong_pin_text = next(item for item in wrong_first_target["block_list"]["items"] if item.get("block_id") == "risk-top-pin-text")
    wrong_pin_text["text"]["elements"][0]["text_run"]["text_element_style"]["link"]["url"] = "https://my.feishu.cn/docx/9.12-test#risk-platform-fact-2"
    wrong_target_result = _fixture_audit(wrong_first_target)
    if wrong_target_result["verdict"] != "FAIL" or not any(error["code"] == "RISK_FIRST_PLATFORM_TARGET" for error in wrong_target_result["errors"]):
        print(json.dumps(wrong_target_result, ensure_ascii=False, indent=2))
        return 1
    linked_h4 = copy.deepcopy(risk_fixture)
    h4_block = next(item for item in linked_h4["block_list"]["items"] if item.get("block_id") == "risk-top-h4")
    h4_block["heading4"]["elements"][0]["text_run"]["text_element_style"]["link"] = {"url": "https://my.feishu.cn/docx/9.12-test#risk-platform-fact"}
    linked_h4_result = _fixture_audit(linked_h4)
    if linked_h4_result["verdict"] != "FAIL" or not any(error["code"] == "RISK_H4_LINK" for error in linked_h4_result["errors"]):
        print(json.dumps(linked_h4_result, ensure_ascii=False, indent=2))
        return 1

    for platform, clean_ending in CHECKED_CLEAN_SEARCH.items():
        clean_search = copy.deepcopy(valid)
        modules = clean_search["review_context"]["platforms"][platform]["modules"]
        module_index = next(index for index, module in enumerate(modules) if "关键词搜索：" in module["text"])
        old_text = modules[module_index]["text"]
        match = URL_RE.search(old_text)
        if match is None:
            raise AssertionError(f"self-test search URL missing for {platform}")
        new_text = f"{old_text[:match.end()]} {clean_ending}"
        modules[module_index]["text"] = new_text
        modules[module_index]["status"] = "checked_clean"
        modules[module_index]["fact_evidence"]["related_result_count"] = 1
        clean_search["review_context"]["platforms"][platform]["expected_blocks"][module_index]["text"] = new_text
        replace_fixture_line(clean_search, old_text, new_text, platform)
        clean_search_result = _fixture_audit(clean_search)
        if clean_search_result["verdict"] != "PASS":
            print(json.dumps(clean_search_result, ensure_ascii=False, indent=2))
            return 1

    for platform, module_index, old_text, new_text in (
        ("微博", 2, "（3）无超话/话题；", "（3）超话/话题：https://example.com/weibo-topic 相关内容无问题"),
        ("贴吧", 0, "（1）无主题贴吧；", "（1）主题贴吧：https://example.com/tieba-topic 相关内容无问题"),
    ):
        clean_topic = copy.deepcopy(valid)
        module = clean_topic["review_context"]["platforms"][platform]["modules"][module_index]
        module["text"] = new_text
        module["status"] = "checked_clean"
        module["fact_evidence"]["related_topic_count"] = 1
        clean_topic["review_context"]["platforms"][platform]["expected_blocks"][module_index]["text"] = new_text
        replace_fixture_line(clean_topic, old_text, new_text, platform)
        clean_topic_result = _fixture_audit(clean_topic)
        if clean_topic_result["verdict"] != "PASS":
            print(json.dumps(clean_topic_result, ensure_ascii=False, indent=2))
            return 1

    # 已存在但热门/最新正常空内容的超话，不能写成“无超话”或伪装有帖已读。
    empty_topic = copy.deepcopy(valid)
    empty_text = "（3）超话/话题：https://example.com/weibo-topic 暂无帖子，无问题"
    empty_module = empty_topic["review_context"]["platforms"]["微博"]["modules"][2]
    empty_module.update({"text": empty_text, "status": "checked_clean"})
    empty_module["fact_evidence"].update({
        "related_topic_count": 1, "empty_existing_topic": True, "topic_content_count": 0,
        "topic_surface_states": {"hot": "empty", "latest": "empty"},
        "query_urls": ["https://example.com/weibo-topic"],
    })
    empty_topic["review_context"]["platforms"]["微博"]["expected_blocks"][2]["text"] = empty_text
    replace_fixture_line(empty_topic, "（3）无超话/话题；", empty_text, "微博")
    empty_result = _fixture_audit(empty_topic)
    if empty_result["verdict"] != "PASS":
        print(json.dumps({"self_test": "existing-empty-topic", "result": empty_result}, ensure_ascii=False))
        return 1
    for name, key, value, verdict, code in (
        ("missing-empty-flag", "empty_existing_topic", None, "FAIL", "CHECKED_CLEAN_CONCLUSION"),
        ("missing-content-count", "topic_content_count", None, "BLOCKED", "EMPTY_TOPIC_EVIDENCE"),
        ("positive-content", "topic_content_count", 1, "FAIL", "EMPTY_TOPIC_CONTENT_CONFLICT"),
        ("bool-content-count", "topic_content_count", False, "BLOCKED", "EMPTY_TOPIC_EVIDENCE"),
        ("unread-latest", "topic_surface_states", {"hot": "empty"}, "BLOCKED", "EMPTY_TOPIC_EVIDENCE"),
        ("different-topic-url", "query_urls", ["https://example.com/other-topic"], "BLOCKED", "EMPTY_TOPIC_EVIDENCE"),
    ):
        invalid_empty = copy.deepcopy(empty_topic)
        invalid_empty["review_context"]["platforms"]["微博"]["modules"][2]["fact_evidence"][key] = value
        invalid_result = _fixture_audit(invalid_empty)
        if invalid_result["verdict"] != verdict or not any(issue["code"] == code for issue in invalid_result["errors"] + invalid_result["blocked"]):
            print(json.dumps({"self_test": name, "result": invalid_result}, ensure_ascii=False))
            return 1
    misleading_empty = copy.deepcopy(empty_topic)
    misleading_text = empty_text.replace("暂无帖子，无问题", "相关内容无问题")
    misleading_empty["review_context"]["platforms"]["微博"]["modules"][2]["text"] = misleading_text
    misleading_empty["review_context"]["platforms"]["微博"]["expected_blocks"][2]["text"] = misleading_text
    replace_fixture_line(misleading_empty, empty_text, misleading_text, "微博")
    misleading_result = _fixture_audit(misleading_empty)
    if misleading_result["verdict"] != "FAIL" or not any(issue["code"] == "CHECKED_CLEAN_CONCLUSION" for issue in misleading_result["errors"]):
        print(json.dumps({"self_test": "empty-topic-misleading-clean-sentence", "result": misleading_result}, ensure_ascii=False))
        return 1
    unsupported_empty = copy.deepcopy(valid)
    unsupported_module = unsupported_empty["review_context"]["platforms"]["贴吧"]["modules"][0]
    unsupported_module["fact_evidence"]["empty_existing_topic"] = True
    unsupported_result = _fixture_audit(unsupported_empty)
    if unsupported_result["verdict"] != "FAIL" or not any(issue["code"] == "EMPTY_TOPIC_BRANCH" for issue in unsupported_result["errors"]):
        print(json.dumps({"self_test": "empty-topic-cannot-bypass-other-platform", "result": unsupported_result}, ensure_ascii=False))
        return 1

    # 豆瓣名称查询为零与其他路线已核唱片并存；不把唱片并入名称查询计数。
    mixed_douban = copy.deepcopy(valid)
    mixed_douban["review_context"]["platforms"]["豆瓣"]["additional_checked_content"] = [
        {"url": "https://music.douban.com/subject/3002559/", "status": "checked_clean", "source_locator": "https://example.com/independent-album-review"},
        {"url": "https://music.douban.com/subject/2282168/", "status": "checked_clean", "source_locator": "https://example.com/independent-album-review"},
    ]
    mixed_result = _fixture_audit(mixed_douban)
    if mixed_result["verdict"] != "PASS":
        print(json.dumps({"self_test": "douban-empty-name-query-with-checked-albums", "result": mixed_result}, ensure_ascii=False))
        return 1
    invented_hit = copy.deepcopy(mixed_douban)
    invented_module = invented_hit["review_context"]["platforms"]["豆瓣"]["modules"][1]
    invented_old = invented_module["text"]
    invented_new = invented_old.replace("无涉及的内容及其互动", "涉及的内容及其互动无问题")
    invented_module.update({"text": invented_new, "status": "checked_clean"})
    invented_hit["review_context"]["platforms"]["豆瓣"]["expected_blocks"][1]["text"] = invented_new
    replace_fixture_line(invented_hit, invented_old, invented_new, "豆瓣")
    invented_result = _fixture_audit(invented_hit)
    if invented_result["verdict"] != "BLOCKED" or not any(issue["code"] == "EVIDENCE_STATUS_MISMATCH" for issue in invented_result["blocked"]):
        print(json.dumps({"self_test": "douban-albums-cannot-invent-name-query-hit", "result": invented_result}, ensure_ascii=False))
        return 1

    for platform, old_text, new_text, clean_ending in (
        ("豆瓣", "（1）无豆瓣人物主页；", "（1）豆瓣人物主页：https://example.com/douban-home 相关内容无问题", "相关内容无问题"),
        ("油管", "（1）无个人主页；", "（1）个人主页：https://example.com/youtube-home 无问题", "无问题"),
    ):
        clean_home = copy.deepcopy(valid)
        module = clean_home["review_context"]["platforms"][platform]["modules"][0]
        module["text"] = new_text
        module["status"] = "checked_clean"
        module["fact_evidence"]["confirmed_homepage_count"] = 1
        clean_home["review_context"]["platforms"][platform]["expected_blocks"][0]["text"] = new_text
        replace_fixture_line(clean_home, old_text, new_text, platform)
        clean_home_result = _fixture_audit(clean_home)
        if clean_home_result["verdict"] != "PASS" or not new_text.endswith(clean_ending):
            print(json.dumps(clean_home_result, ensure_ascii=False, indent=2))
            return 1

    if not all(
        SUSPECTED_HOME_PREFIX_RE.match(f"（1）{label}：https://example.com/suspected-home 无问题")
        for label in ("疑似主页", "疑似官方主页", "疑似项目主页")
    ) or SUSPECTED_HOME_PREFIX_RE.match("（1）个人主页：https://example.com/confirmed-home 无问题"):
        print(json.dumps({"suspected_homepage_label_detection": "failed"}, ensure_ascii=False, indent=2))
        return 1

    def named_other_suspected_fixture(platform: str = "境外其他网站", name: str = "SoundCloud") -> dict[str, Any]:
        fixture = copy.deepcopy(valid)
        context = fixture["review_context"]["platforms"][platform]
        url = "https://www.ximalaya.com/example-candidate" if platform == "境内其他内容" else "https://soundcloud.com/example-candidate"
        value = f"（2）{name}疑似主页：{url} 无问题"
        module = {
            "text": value, "status": "checked_clean", "platform_name": name,
            "fact_evidence": {
                "source_type": "independent_platform_check", "source_locator": "https://example.com/fixture-source",
                "checked_at": "2026-10-16T00:00:00Z", "summary": "Synthetic named suspected-homepage fixture.",
                "confirmed_homepage_count": 0, "suspected_homepage_count": 1,
            },
        }
        context["modules"].append(module)
        context["expected_blocks"].insert(1, {"kind": "text", "text": value})
        block = _text_block("named-other-suspected", "")
        block["parent_id"] = "9.12-test"
        block["text"]["elements"] = [
            {"text_run": {"content": f"（2）{name}疑似主页："}},
            {"text_run": {"content": url, "text_element_style": {"link": {"url": url}}}},
            {"text_run": {"content": " 无问题"}},
        ]
        items = fixture["block_list"]["items"]
        tail = next(item for item in items if text_of(item) == (FOREIGN_TAIL if platform == "境外其他网站" else DOMESTIC_TAIL))
        page = next(item for item in items if item.get("block_type") == 1)
        page["children"].insert(page["children"].index(tail["block_id"]), block["block_id"])
        items.insert(items.index(tail), block)
        fixture["raw_content"] = "\n".join(text_of(item) for item in items)
        return fixture

    for platform, name in (("境外其他网站", "SoundCloud"), ("境内其他内容", "喜马拉雅")):
        named = named_other_suspected_fixture(platform, name)
        named_result = _fixture_audit(named)
        if named_result["verdict"] != "PASS":
            print(json.dumps({"self_test": "named-other-suspected-valid", "platform": platform, "result": named_result}, ensure_ascii=False))
            return 1

    for case, mutation, required_code in (
        ("missing-platform-name", lambda m: m.pop("platform_name"), "OTHER_SUSPECTED_HOME_LABEL"),
        ("missing-platform-name-with-confirmed-count", lambda m: (m.pop("platform_name"), m["fact_evidence"].update(confirmed_homepage_count=1)), "OTHER_SUSPECTED_HOME_LABEL"),
        ("mismatched-platform-name", lambda m: m.update(platform_name="Patreon"), "OTHER_SUSPECTED_HOME_LABEL"),
        ("missing-suspected-count", lambda m: m["fact_evidence"].pop("suspected_homepage_count"), "EVIDENCE_STATUS_MISMATCH"),
        ("confirmed-evidence-cannot-pass-suspected-label", lambda m: m["fact_evidence"].update(confirmed_homepage_count=1), "EVIDENCE_STATUS_MISMATCH"),
    ):
        named = named_other_suspected_fixture()
        mutation(named["review_context"]["platforms"]["境外其他网站"]["modules"][1])
        named_result = _fixture_audit(named)
        if named_result["verdict"] != "BLOCKED" or not any(issue["code"] == required_code for issue in named_result["blocked"]):
            print(json.dumps({"self_test": case, "result": named_result}, ensure_ascii=False))
            return 1

    confirmed_named = named_other_suspected_fixture()
    confirmed_module = confirmed_named["review_context"]["platforms"]["境外其他网站"]["modules"][1]
    old_named = confirmed_module["text"]
    confirmed_named_text = old_named.replace("疑似主页", "个人主页")
    confirmed_module["text"] = confirmed_named_text
    confirmed_named["review_context"]["platforms"]["境外其他网站"]["expected_blocks"][1]["text"] = confirmed_named_text
    replace_fixture_line(confirmed_named, old_named, confirmed_named_text, "境外其他网站")
    confirmed_named_result = _fixture_audit(confirmed_named)
    if confirmed_named_result["verdict"] != "BLOCKED" or not any(issue["code"] == "EVIDENCE_STATUS_MISMATCH" for issue in confirmed_named_result["blocked"]):
        print(json.dumps({"self_test": "named-confirmed-home-cannot-use-suspected-evidence", "result": confirmed_named_result}, ensure_ascii=False))
        return 1

    abused_fixed = copy.deepcopy(valid)
    fixed_module = abused_fixed["review_context"]["platforms"]["Facebook"]["modules"][0]
    fixed_old = fixed_module["text"]
    fixed_new = "（1）SoundCloud疑似主页：https://soundcloud.com/example-candidate 无问题"
    fixed_module.update(text=fixed_new, status="checked_clean", platform_name="SoundCloud")
    fixed_module["fact_evidence"].update(confirmed_homepage_count=0, suspected_homepage_count=1)
    abused_fixed["review_context"]["platforms"]["Facebook"]["expected_blocks"][0]["text"] = fixed_new
    replace_fixture_line(abused_fixed, fixed_old, fixed_new, "Facebook")
    abused_result = _fixture_audit(abused_fixed)
    if abused_result["verdict"] != "FAIL" or not any(issue["code"] == "MODULE_LABEL" for issue in abused_result["errors"]):
        print(json.dumps({"self_test": "named-other-label-cannot-relax-fixed-platform", "result": abused_result}, ensure_ascii=False))
        return 1

    for suspected_label in ("疑似主页",):
        suspected_home = copy.deepcopy(valid)
        old_text = "（1）无个人主页；"
        new_text = f"（1）{suspected_label}：https://example.com/suspected-home 无问题"
        module = suspected_home["review_context"]["platforms"]["Facebook"]["modules"][0]
        module["text"] = new_text
        module["status"] = "checked_clean"
        module["fact_evidence"]["confirmed_homepage_count"] = 0
        module["fact_evidence"]["suspected_homepage_count"] = 1
        suspected_home["review_context"]["platforms"]["Facebook"]["expected_blocks"][0]["text"] = new_text
        replace_fixture_line(suspected_home, old_text, new_text, "Facebook")
        suspected_home_result = _fixture_audit(suspected_home)
        if suspected_home_result["verdict"] != "PASS":
            print(json.dumps(suspected_home_result, ensure_ascii=False, indent=2))
            return 1

    confirmed_home_with_only_suspected_evidence = copy.deepcopy(valid)
    old_text = "（1）无个人主页；"
    confirmed_text = "（1）个人主页：https://example.com/confirmed-home 无问题"
    confirmed_module = confirmed_home_with_only_suspected_evidence["review_context"]["platforms"]["Facebook"]["modules"][0]
    confirmed_module["text"] = confirmed_text
    confirmed_module["status"] = "checked_clean"
    confirmed_module["fact_evidence"]["confirmed_homepage_count"] = 0
    confirmed_module["fact_evidence"]["suspected_homepage_count"] = 1
    confirmed_home_with_only_suspected_evidence["review_context"]["platforms"]["Facebook"]["expected_blocks"][0]["text"] = confirmed_text
    replace_fixture_line(confirmed_home_with_only_suspected_evidence, old_text, confirmed_text, "Facebook")
    confirmed_home_with_only_suspected_result = _fixture_audit(confirmed_home_with_only_suspected_evidence)
    if confirmed_home_with_only_suspected_result["verdict"] != "BLOCKED" or not any(
        item["code"] == "EVIDENCE_STATUS_MISMATCH" for item in confirmed_home_with_only_suspected_result["blocked"]
    ):
        print(json.dumps(confirmed_home_with_only_suspected_result, ensure_ascii=False, indent=2))
        return 1

    no_home_with_suspected_evidence = copy.deepcopy(valid)
    no_home_with_suspected_evidence["review_context"]["platforms"]["Facebook"]["modules"][0]["fact_evidence"]["suspected_homepage_count"] = 1
    no_home_with_suspected_result = _fixture_audit(no_home_with_suspected_evidence)
    if no_home_with_suspected_result["verdict"] != "BLOCKED" or not any(
        item["code"] == "EVIDENCE_STATUS_MISMATCH" for item in no_home_with_suspected_result["blocked"]
    ):
        print(json.dumps(no_home_with_suspected_result, ensure_ascii=False, indent=2))
        return 1

    suspected_home_without_count = copy.deepcopy(valid)
    suspected_text = "（1）疑似主页：https://example.com/suspected-home 无问题"
    suspected_module = suspected_home_without_count["review_context"]["platforms"]["Facebook"]["modules"][0]
    suspected_module["text"] = suspected_text
    suspected_module["status"] = "checked_clean"
    suspected_module["fact_evidence"]["confirmed_homepage_count"] = 0
    suspected_home_without_count["review_context"]["platforms"]["Facebook"]["expected_blocks"][0]["text"] = suspected_text
    replace_fixture_line(suspected_home_without_count, old_text, suspected_text, "Facebook")
    suspected_home_without_count_result = _fixture_audit(suspected_home_without_count)
    if suspected_home_without_count_result["verdict"] != "BLOCKED" or not any(
        item["code"] == "EVIDENCE_STATUS_MISMATCH" for item in suspected_home_without_count_result["blocked"]
    ):
        print(json.dumps(suspected_home_without_count_result, ensure_ascii=False, indent=2))
        return 1
    broken = copy.deepcopy(valid)
    for block in broken["block_list"]["items"]:
        if text_of(block) == DOMESTIC_TAIL:
            block["text"]["elements"][0]["text_run"]["content"] = ""
            break
    broken_result = _fixture_audit(broken)
    if broken_result["verdict"] != "FAIL" or not any(e["code"] == "DOMESTIC_TAIL" for e in broken_result["errors"]):
        print(json.dumps(broken_result, ensure_ascii=False, indent=2))
        return 1
    bad_target = copy.deepcopy(valid)
    for item in bad_target["block_list"]["items"]:
        if "example.com/weibo" in text_of(item):
            for run in runs(item):
                link = run.get("text_element_style", {}).get("link")
                if isinstance(link, dict):
                    link["url"] = "https://example.com%2Fweibo"
                    break
            break
    bad_target_result = _fixture_audit(bad_target)
    if bad_target_result["verdict"] != "FAIL" or not any(e["code"] == "LINK_TARGET" for e in bad_target_result["errors"]):
        print(json.dumps(bad_target_result, ensure_ascii=False, indent=2))
        return 1
    linked_label = copy.deepcopy(valid)
    for item in linked_label["block_list"]["items"]:
        if "example.com/bili" in text_of(item):
            item["text"]["elements"][0]["text_run"]["text_element_style"]["link"] = {"url": "https://example.com/bili"}
            break
    linked_label_result = _fixture_audit(linked_label)
    if linked_label_result["verdict"] != "FAIL" or not any(e["code"] == "LINK_SCOPE" for e in linked_label_result["errors"]):
        print(json.dumps(linked_label_result, ensure_ascii=False, indent=2))
        return 1
    process_prose = copy.deepcopy(valid)
    for item in process_prose["block_list"]["items"]:
        if text_of(item) == DOMESTIC_TAIL:
            item["text"]["elements"][0]["text_run"]["content"] = f"{DOMESTIC_TAIL} 调查过程"
            process_prose["review_context"]["platforms"]["境内其他内容"]["expected_blocks"][-1]["text"] = f"{DOMESTIC_TAIL} 调查过程"
            break
    process_result = _fixture_audit(process_prose)
    if process_result["verdict"] != "FAIL" or not any(e["code"] == "PROCESS_PROSE" for e in process_result["errors"]):
        print(json.dumps(process_result, ensure_ascii=False, indent=2))
        return 1
    for process_token in (
        "覆盖说明",
        "上滚",
        "下滚",
        "href",
        "shortcode",
        "permalink",
        "公开返回边界",
        "全量扫读",
        "未逐条完整播放",
        "以下链接为主页入口",
    ):
        process_case = copy.deepcopy(valid)
        replacement = f"{DOMESTIC_TAIL} {process_token}"
        for item in process_case["block_list"]["items"]:
            if text_of(item) == DOMESTIC_TAIL:
                item["text"]["elements"][0]["text_run"]["content"] = replacement
                process_case["review_context"]["platforms"]["境内其他内容"]["expected_blocks"][-1]["text"] = replacement
                break
        process_case_result = _fixture_audit(process_case)
        if process_case_result["verdict"] != "FAIL" or not any(e["code"] == "PROCESS_PROSE" for e in process_case_result["errors"]):
            print(json.dumps({"process_token": process_token, "result": process_case_result}, ensure_ascii=False, indent=2))
            return 1

    def make_confirmed_x_home(payload: dict[str, Any], time_value: str | None) -> None:
        old_text = "（1）无个人主页；"
        new_text = "（1）个人主页：https://x.com/example 无问题"
        module = payload["review_context"]["platforms"]["X"]["modules"][0]
        module["text"] = new_text
        module["status"] = "checked_clean"
        module["fact_evidence"]["confirmed_homepage_count"] = 1
        payload["review_context"]["platforms"]["X"]["expected_blocks"][0]["text"] = new_text
        replace_fixture_line(payload, old_text, new_text, "X")
        if time_value is None:
            return
        time_block = _text_block("x-time-self-test", time_value)
        time_block["parent_id"] = "9.12-test"
        payload["block_list"]["items"].append(time_block)
        fixture_by_id = {str(item.get("block_id")): item for item in payload["block_list"]["items"]}
        page = next(item for item in payload["block_list"]["items"] if item.get("block_type") == 1)
        x_title_index = next(index for index, child_id in enumerate(page["children"]) if text_of(fixture_by_id[str(child_id)]) == "X")
        page["children"].insert(x_title_index + 1, time_block["block_id"])
        payload["review_context"]["platforms"]["X"]["expected_blocks"].insert(0, {"kind": "text", "text": time_value})

    x_missing_time = copy.deepcopy(valid)
    make_confirmed_x_home(x_missing_time, None)
    x_missing_time_result = _fixture_audit(x_missing_time)
    if x_missing_time_result["verdict"] != "FAIL" or not any(e["code"] == "X_TIME_REQUIRED" for e in x_missing_time_result["errors"]):
        print(json.dumps(x_missing_time_result, ensure_ascii=False, indent=2))
        return 1
    x_valid_time = copy.deepcopy(valid)
    make_confirmed_x_home(x_valid_time, "背调时间：2020年6月—至今")
    x_valid_time_result = _fixture_audit(x_valid_time)
    if x_valid_time_result["verdict"] != "PASS":
        print(json.dumps(x_valid_time_result, ensure_ascii=False, indent=2))
        return 1
    x_placeholder_time = copy.deepcopy(valid)
    make_confirmed_x_home(x_placeholder_time, "背调时间：年 月—至今")
    x_placeholder_time_result = _fixture_audit(x_placeholder_time)
    if x_placeholder_time_result["verdict"] != "FAIL" or not any(e["code"] == "X_TIME_PLACEHOLDER" for e in x_placeholder_time_result["errors"]):
        print(json.dumps(x_placeholder_time_result, ensure_ascii=False, indent=2))
        return 1

    douyin_search_home = copy.deepcopy(valid)
    douyin_old_home = "（1）无个人主页；"
    douyin_bad_home = "（1）个人主页：https://www.douyin.com/search/example?type=user 无问题"
    douyin_module = douyin_search_home["review_context"]["platforms"]["抖音"]["modules"][0]
    douyin_module["text"] = douyin_bad_home
    douyin_module["status"] = "checked_clean"
    douyin_module["fact_evidence"]["confirmed_homepage_count"] = 1
    douyin_search_home["review_context"]["platforms"]["抖音"]["expected_blocks"][0]["text"] = douyin_bad_home
    replace_fixture_line(douyin_search_home, douyin_old_home, douyin_bad_home, "抖音")
    douyin_search_home_result = _fixture_audit(douyin_search_home)
    if douyin_search_home_result["verdict"] != "FAIL" or not any(e["code"] == "DOUYIN_HOME_SEARCH_ROUTE" for e in douyin_search_home_result["errors"]):
        print(json.dumps(douyin_search_home_result, ensure_ascii=False, indent=2))
        return 1

    invalid_risk_urls = (
        ("微博", "https://m.weibo.cn/u/5498473002"),
        ("B站", "https://space.bilibili.com/1000132"),
        ("抖音", "https://www.douyin.com/search/example?type=user"),
        ("X", "https://x.com/search?q=example"),
        ("Facebook", "https://www.facebook.com/synthetic_account_021/"),
        ("INS", "https://www.instagram.com/synthetic_account_022/"),
    )
    if any(_is_direct_content_url(platform, url) for platform, url in invalid_risk_urls):
        print(json.dumps({"invalid_risk_urls_accepted": invalid_risk_urls}, ensure_ascii=False, indent=2))
        return 1
    valid_risk_urls = (
        ("微博", "https://m.weibo.cn/detail/1234567890"),
        ("B站", "https://t.bilibili.com/100000000000000133"),
        ("抖音", "https://www.douyin.com/video/1234567890"),
        ("X", "https://x.com/synthetic_account_022/status/1267448231446839297"),
        ("Facebook", "https://www.facebook.com/synthetic_account_021/posts/1234567890"),
        ("INS", "https://www.instagram.com/synthetic_account_022/reel/CBkwLtMnHb_/"),
        ("境外其他网站", "https://example.com/news/example-article"),
    )
    if not all(_is_direct_content_url(platform, url) for platform, url in valid_risk_urls):
        print(json.dumps({"valid_risk_urls_rejected": [(platform, url) for platform, url in valid_risk_urls if not _is_direct_content_url(platform, url)]}, ensure_ascii=False, indent=2))
        return 1
    missing_visual = copy.deepcopy(valid)
    missing_visual["review_context"].pop("visual_check")
    missing_visual_result = _fixture_audit(missing_visual)
    if missing_visual_result["verdict"] != "BLOCKED" or not any(e["code"] == "VISUAL_CONTEXT" for e in missing_visual_result["blocked"]):
        print(json.dumps(missing_visual_result, ensure_ascii=False, indent=2))
        return 1
    missing_url = copy.deepcopy(valid)
    for item in missing_url["block_list"]["items"]:
        if text_of(item) == "（1）无个人主页；" and item.get("parent_id") == "9.12-test":
            item["text"]["elements"] = _text_block("unused", "（1）个人主页：无问题")["text"]["elements"]
            break
    missing_url["review_context"]["platforms"]["微博"]["modules"][0] = {
        "text": "（1）个人主页：无问题",
        "status": "checked_clean",
        "fact_evidence": {
            "source_type": "independent_platform_check",
            "source_locator": "https://example.com/fixture-source",
            "checked_at": "2026-09-12T00:00:00Z",
            "summary": "Confirmed homepage fixture.",
            "confirmed_homepage_count": 1,
        },
    }
    missing_url["review_context"]["platforms"]["微博"]["expected_blocks"][0] = {"kind": "text", "text": "（1）个人主页：无问题"}
    missing_url_result = _fixture_audit(missing_url)
    if missing_url_result["verdict"] != "FAIL" or not any(e["code"] == "MODULE_URL_REQUIRED" for e in missing_url_result["errors"]):
        print(json.dumps(missing_url_result, ensure_ascii=False, indent=2))
        return 1
    empty_context = copy.deepcopy(valid)
    for platform_context in empty_context["review_context"]["platforms"].values():
        platform_context["modules"] = []
        platform_context["expected_blocks"] = []
    empty_context_result = _fixture_audit(empty_context)
    if empty_context_result["verdict"] != "BLOCKED" or not any(e["code"] == "EXPECTED_BLOCKS_EMPTY" for e in empty_context_result["blocked"]):
        print(json.dumps(empty_context_result, ensure_ascii=False, indent=2))
        return 1
    status_mismatch = copy.deepcopy(valid)
    status_mismatch["review_context"]["platforms"]["微博"]["modules"][1]["status"] = "checked_clean"
    status_mismatch["review_context"]["platforms"]["微博"]["modules"][1]["fact_evidence"]["related_result_count"] = 1
    status_mismatch_result = _fixture_audit(status_mismatch)
    if status_mismatch_result["verdict"] != "FAIL" or not any(e["code"] == "CHECKED_CLEAN_CONCLUSION" for e in status_mismatch_result["errors"]):
        print(json.dumps(status_mismatch_result, ensure_ascii=False, indent=2))
        return 1
    same_agent_review = copy.deepcopy(valid)
    same_agent_review["review_context"]["reviewer_id"] = "delivery-agent"
    same_agent_review["review_context"]["context_builder_id"] = "delivery-agent"
    same_agent_result = _fixture_audit(same_agent_review)
    if same_agent_result["verdict"] != "PASS" or not any("SAME_AGENT_DETERMINISTIC_REVIEW" in value for value in same_agent_result["info"]):
        print(json.dumps(same_agent_result, ensure_ascii=False, indent=2))
        return 1
    self_certifying_bili = copy.deepcopy(valid)
    bili_search = self_certifying_bili["review_context"]["platforms"]["B站"]["modules"][1]
    bili_search["text"] = "（2）关键词搜索：https://example.com/bili 涉及的视频，专栏及其互动无问题"
    bili_search["status"] = "checked_clean"
    bili_search["fact_evidence"]["related_result_count"] = 0
    self_certifying_bili["review_context"]["platforms"]["B站"]["expected_blocks"][1]["text"] = bili_search["text"]
    for item in self_certifying_bili["block_list"]["items"]:
        if "example.com/bili" in text_of(item):
            item["text"]["elements"][-1]["text_run"]["content"] = " 涉及的视频，专栏及其互动无问题"
            break
    self_certifying_bili_result = _fixture_audit(self_certifying_bili)
    if self_certifying_bili_result["verdict"] != "BLOCKED" or not any(e["code"] == "EVIDENCE_STATUS_MISMATCH" for e in self_certifying_bili_result["blocked"]):
        print(json.dumps(self_certifying_bili_result, ensure_ascii=False, indent=2))
        return 1
    x_no_result = copy.deepcopy(valid)
    x_search = x_no_result["review_context"]["platforms"]["X"]["modules"][1]
    x_search["text"] = "（2）关键词搜索：https://example.com/x 涉及内容及其互动无问题"
    x_search["status"] = "checked_clean"
    x_search["fact_evidence"]["related_result_count"] = 1
    x_no_result["review_context"]["platforms"]["X"]["expected_blocks"][1]["text"] = x_search["text"]
    for item in x_no_result["block_list"]["items"]:
        if "https://example.com/x " in text_of(item):
            item["text"]["elements"][-1]["text_run"]["content"] = " 涉及内容及其互动无问题"
            break
    x_no_result_result = _fixture_audit(x_no_result)
    if x_no_result_result["verdict"] != "PASS":
        print(json.dumps(x_no_result_result, ensure_ascii=False, indent=2))
        return 1
    old_x_phrase = copy.deepcopy(valid)
    old_x_text = "（2）关键词搜索：https://example.com/x 无问题"
    old_x_phrase["review_context"]["platforms"]["X"]["modules"][1]["text"] = old_x_text
    old_x_phrase["review_context"]["platforms"]["X"]["expected_blocks"][1]["text"] = old_x_text
    for item in old_x_phrase["block_list"]["items"]:
        if "https://example.com/x " in text_of(item):
            item["text"]["elements"][-1]["text_run"]["content"] = " 无问题"
            break
    old_x_result = _fixture_audit(old_x_phrase)
    if old_x_result["verdict"] != "FAIL" or not any(e["code"] == "NO_RESULT_CONCLUSION" for e in old_x_result["errors"]):
        print(json.dumps(old_x_result, ensure_ascii=False, indent=2))
        return 1
    forbidden_netease_search = copy.deepcopy(valid)
    forbidden_netease_search["review_context"]["platforms"]["网易云音乐"]["modules"].append({
        "text": "（2）关键词搜索：https://example.com/netease 无相关内容",
        "status": "no_result",
        "fact_evidence": {
            "source_type": "independent_platform_check",
            "source_locator": "https://example.com/fixture-source",
            "checked_at": "2026-09-12T00:00:00Z",
            "summary": "Forbidden delivery module fixture.",
            "related_result_count": 0,
        },
    })
    forbidden_netease_result = _fixture_audit(forbidden_netease_search)
    if forbidden_netease_result["verdict"] != "FAIL" or not any(e["code"] == "MODULE_CONTEXT_COUNT" for e in forbidden_netease_result["blocked"]):
        print(json.dumps(forbidden_netease_result, ensure_ascii=False, indent=2))
        return 1
    forbidden_netease_actual = copy.deepcopy(valid)
    extra_netease = _text_block("forbidden-netease-search", "")
    extra_netease["parent_id"] = "9.12-test"
    extra_netease["text"]["elements"] = [
        {"text_run": {"content": "（2）关键词搜索：", "text_element_style": {"bold": False}}},
        {"text_run": {"content": "https://example.com/netease", "text_element_style": {"bold": False, "link": {"url": "https://example.com/netease"}}}},
        {"text_run": {"content": " 无相关内容", "text_element_style": {"bold": False}}},
    ]
    forbidden_netease_actual["block_list"]["items"].append(extra_netease)
    page = next(item for item in forbidden_netease_actual["block_list"]["items"] if item.get("block_type") == 1)
    fixture_by_id = {str(item.get("block_id")): item for item in forbidden_netease_actual["block_list"]["items"]}
    netease_title_index = next(index for index, child_id in enumerate(page["children"]) if text_of(fixture_by_id[str(child_id)]) == "网易云音乐")
    next_title_index = next(index for index in range(netease_title_index + 1, len(page["children"])) if text_of(fixture_by_id[str(page["children"][index])]) == "贴吧")
    page["children"].insert(next_title_index - 1, extra_netease["block_id"])
    forbidden_netease_actual_result = _fixture_audit(forbidden_netease_actual)
    if forbidden_netease_actual_result["verdict"] != "FAIL" or not any(e["code"] == "SEARCH_MODULE_FORBIDDEN" for e in forbidden_netease_actual_result["errors"]):
        print(json.dumps(forbidden_netease_actual_result, ensure_ascii=False, indent=2))
        return 1
    forbidden_tieba_home = copy.deepcopy(valid)
    forbidden_tieba_home["review_context"]["platforms"]["贴吧"]["modules"].insert(0, {
        "text": "（1）无个人主页；",
        "status": "no_result",
        "fact_evidence": {
            "source_type": "independent_platform_check",
            "source_locator": "https://example.com/fixture-source",
            "checked_at": "2026-09-12T00:00:00Z",
            "summary": "Forbidden delivery module fixture.",
            "confirmed_homepage_count": 0,
        },
    })
    forbidden_tieba_result = _fixture_audit(forbidden_tieba_home)
    if forbidden_tieba_result["verdict"] != "FAIL" or not any(e["code"] == "MODULE_CONTEXT_COUNT" for e in forbidden_tieba_result["blocked"]):
        print(json.dumps(forbidden_tieba_result, ensure_ascii=False, indent=2))
        return 1
    forbidden_ins_search = copy.deepcopy(valid)
    forbidden_ins_search["review_context"]["platforms"]["INS"]["modules"].append({
        "text": "（2）关键词搜索：https://example.com/ins 无相关内容",
        "status": "no_result",
        "fact_evidence": {
            "source_type": "independent_platform_check",
            "source_locator": "https://example.com/fixture-source",
            "checked_at": "2026-09-12T00:00:00Z",
            "summary": "Forbidden delivery module fixture.",
            "related_result_count": 0,
        },
    })
    forbidden_ins_result = _fixture_audit(forbidden_ins_search)
    if forbidden_ins_result["verdict"] != "FAIL" or not any(e["code"] == "MODULE_CONTEXT_COUNT" for e in forbidden_ins_result["blocked"]):
        print(json.dumps(forbidden_ins_result, ensure_ascii=False, indent=2))
        return 1
    risk_without_items = copy.deepcopy(valid)
    risk_without_items["review_context"]["platforms"]["微博"]["modules"][1]["status"] = "risk"
    risk_without_items_result = _fixture_audit(risk_without_items)
    if risk_without_items_result["verdict"] != "BLOCKED" or not any(e["code"] == "RISK_ITEMS_REQUIRED" for e in risk_without_items_result["blocked"]):
        print(json.dumps(risk_without_items_result, ensure_ascii=False, indent=2))
        return 1
    boolean_visual = copy.deepcopy(valid)
    boolean_visual["review_context"]["visual_check"]["checks"] = {"heading_levels": True}
    boolean_visual_result = _fixture_audit(boolean_visual)
    if boolean_visual_result["verdict"] != "BLOCKED" or "receipt" in boolean_visual_result:
        print(json.dumps(boolean_visual_result, ensure_ascii=False, indent=2))
        return 1
    reused_visual = copy.deepcopy(valid)
    reused_visual["document"]["revision_id"] = 2
    reused_visual["review_context"]["before_revision"] = 2
    reused_visual["review_context"]["after_revision"] = 2
    reused_visual["review_context"]["visual_check"] = {
        "mode": "reuse_layout",
        "revision_id": 2,
        "token": "9.12-test",
        "method": "reuse earlier live visual PASS after deterministic layout comparison",
        "checked_at": "2026-09-12T00:01:00Z",
        "baseline_revision": 1,
        "baseline_verdict": "PASS",
        "baseline_layout_fingerprint": layout_fingerprint(reused_visual["block_list"]["items"]),
    }
    reused_visual_result = _fixture_audit(reused_visual)
    if reused_visual_result["verdict"] != "PASS" or reused_visual_result["visual"]["mode"] != "reuse_layout":
        print(json.dumps(reused_visual_result, ensure_ascii=False, indent=2))
        return 1
    changed_layout = copy.deepcopy(reused_visual)
    changed_layout["block_list"]["items"][1]["block_type"] = 6
    changed_layout_result = _fixture_audit(changed_layout)
    if changed_layout_result["verdict"] != "FAIL" or not any(e["code"] == "VISUAL_LAYOUT_CHANGED" for e in changed_layout_result["blocked"]):
        print(json.dumps(changed_layout_result, ensure_ascii=False, indent=2))
        return 1
    print("SELF_TEST: PASS")
    return 0


def load_payload(source: str) -> dict[str, Any]:
    if source == "-":
        restore_console_mode: tuple[Any, int, int] | None = None
        if sys.platform == "win32":
            try:
                import ctypes

                kernel32 = ctypes.windll.kernel32
                stdin_handle = kernel32.GetStdHandle(-10)
                mode = ctypes.c_ulong()
                if kernel32.GetConsoleMode(stdin_handle, ctypes.byref(mode)):
                    # Disable ENABLE_ECHO_INPUT while a JSON snapshot is supplied
                    # through a PTY; restore it immediately after the single line.
                    kernel32.SetConsoleMode(stdin_handle, mode.value & ~0x0004)
                    restore_console_mode = (kernel32, stdin_handle, mode.value)
            except (AttributeError, OSError):
                restore_console_mode = None
        try:
            line = sys.stdin.readline()
        finally:
            if restore_console_mode:
                kernel32, stdin_handle, mode_value = restore_console_mode
                kernel32.SetConsoleMode(stdin_handle, mode_value)
        if not line:
            raise ValueError("stdin did not contain one JSON line")
        return json.loads(line)
    return json.loads(Path(source).read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", nargs="?", help="snapshot JSON path, or - for one JSON line on stdin")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.snapshot:
        parser.error("snapshot is required unless --self-test is used")
    try:
        payload = load_payload(args.snapshot)
        result = audit(payload)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = {"schema_version": 1, "script_version": SCRIPT_VERSION, "verdict": "BLOCKED", "blocked": [{"code": "INPUT", "location": args.snapshot, "actual": str(exc), "expected": "readable UTF-8 JSON snapshot"}], "errors": [], "info": []}
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0 if result["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
