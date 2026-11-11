#!/usr/bin/env python3
"""Validate a finished Feishu background-check document snapshot.

This validator intentionally stays separate from validate_research_payload.py:
the latter checks research completeness, while this script checks the final
cloud-document block tree, styles, wording, links, and evidence placement.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlparse

from validate_research_payload import (
    DELIVERY_MODULES,
    EVIDENCE_ROOT,
    OTHER_TAIL_STATEMENTS,
    PLATFORMS,
    PLATFORM_DISPLAY,
    RESULT_LEVELS,
    _self_test_payload,
    validate as validate_research_payload,
)


STYLE_PROFILE_VERSION = "accepted-cloud-v1"
SNAPSHOT_SCHEMA_VERSION = "1.0"
# Read the same approved template as the uploader; synthetic fixtures remain offline-only.
_LOCAL_CONFIG = Path(os.environ.get("BACKCHECK_CONFIG_PATH") or (
    Path(os.environ.get("BACKGROUND_CHECK_WORKSPACE", str(Path(__file__).resolve().parents[3])))
    / "config" / "backcheck-local.json"
))
# Explicit self-tests/help never require a real account or approved cloud template.
TEMPLATE_DOCUMENT_TOKEN = ("OFFLINE_TEMPLATE_FIXTURE" if any(arg in sys.argv for arg in ("--self-test", "--help"))
    else json.loads(_LOCAL_CONFIG.read_text(encoding="utf-8-sig"))["template_document_token"])
if not re.fullmatch(r"[A-Za-z0-9_-]{10,128}", TEMPLATE_DOCUMENT_TOKEN) or TEMPLATE_DOCUMENT_TOKEN.startswith("SYNTHETIC"):
    raise ValueError("Configure the approved Feishu template before validation")
DISCLAIMER_GATE_PATH = (
    Path(__file__).resolve().parents[2]
    / "review-feishu-background-check" / "scripts" / "disclaimer_gate.py"
)
BUSINESS_RISK_GATE_PATH = (
    Path(__file__).resolve().parents[2]
    / "review-feishu-background-check" / "scripts" / "business_risk_gate.py"
)
CLIENT_CHALLENGE_GATE_PATH = (
    Path(__file__).resolve().parents[2]
    / "client-challenge-background-check" / "scripts" / "client_challenge_gate.py"
)
CURRENT_BUSINESS_RISK_POLICY = (
    Path(os.environ.get("BACKGROUND_CHECK_WORKSPACE", str(Path(__file__).resolve().parents[3])))
    / "背调风险提示.md"
)
PLATFORM_ORDER = tuple(PLATFORM_DISPLAY[key] for key in PLATFORMS)
OTHER_TAILS = tuple(OTHER_TAIL_STATEMENTS.values())
VERDICT_COLORS = {"建议谨慎评估": 1, "建议评估": 2, "低合作风险": None}

TEXT_KEYS = {
    1: "page",
    2: "text",
    3: "heading1",
    4: "heading2",
    5: "heading3",
    6: "heading4",
    13: "ordered",
}
URL_RE = re.compile(r"https?://[^\s]+", re.IGNORECASE)
TITLE_RE = re.compile(r"^(?:[1-9]|1[0-2])\.(?:[1-9]|[12]\d|3[01])-.+$")
EXAMPLE_RE = re.compile(r"^举例(\d+)【.+】$")
RISK_POINT_RE = re.compile(r"^风险点(\d+)：【(.+)】$")
FULLWIDTH_PREFIX_RE = re.compile(r"^（(\d+)）")
ASCII_PREFIX_RE = re.compile(r"^\s*\d+[\.、\)]")
COUNT_LEDGER_RE = re.compile(
    r"(?:公开可见|页面可见|主页显示|已核查|已遍历|已扫描|已加载|人工复核|"
    r"逐条复核|可取得|已保存|去重).{0,30}\d+(?:\s*/\s*\d+)?(?:条|件|页|组|个)"
)
RATIO_RE = re.compile(r"\b\d+\s*/\s*\d+\b")

FORBIDDEN_LITERALS = (
    "公开页面可见记录为",
    "主页显示总数",
    "公开可见微博",
    "全部公开可见",
    "扫描数量",
    "采集数量",
    "覆盖数量",
    "检索台账",
    "身份闭环",
    "同名候选",
    "候选身份",
    "已排除",
    "未核实别名",
    "空简介同名频道",
    "未建立身份联系",
    "可归因",
    "法定姓名",
    "正式雇佣履历",
    "excluded_candidate",
    "unconfirmed_candidate",
    "suspected_homepage",
    "API",
    "MCP",
    "token",
    "cursor",
    "接口",
    "爬虫",
    "抓取",
    "遍历",
    "翻页",
    "分页",
    "去重",
    "命中",
    "覆盖",
    "召回",
    "置信度",
    "证据簇",
    "推理链",
    "schema",
    "数据流",
    "访问受限",
    "登录或验证限制",
    "未继续访问",
    "抽样未发现",
    "委托方已完成人工核查",
    "委托方人工核查未发现问题",
    "未提供新增需列示事项",
    "按委托方指令停止",
    "已按委托方要求完成一轮",
)

SEARCH_FIXED_SUFFIX = {
    "weibo": {"no_risk": "相关内容无问题", "no_related_content": "无相关内容"},
    "bilibili": {"no_risk": "涉及的视频，专栏及其互动无问题", "no_related_content": "无涉及的视频，专栏及其互动"},
    "douyin": {"no_risk": "相关内容无问题", "no_related_content": "无相关内容"},
    "xiaohongshu": {"no_risk": "涉及的笔记及其互动无问题", "no_related_content": "无涉及的笔记及其互动"},
    "zhihu": {"no_risk": "相关内容无问题", "no_related_content": "无相关内容"},
    "netease_music": {"no_risk": "相关内容无问题", "no_related_content": "无相关内容"},
    "tieba": {"no_risk": "涉及内容及其互动无问题", "no_related_content": "无涉及内容及其互动"},
    "douban": {"no_risk": "涉及的内容及其互动无问题", "no_related_content": "无涉及的内容及其互动"},
    "domestic_other": {"no_risk": "相关内容无问题", "no_related_content": "无相关内容"},
    "x": {"no_risk": "涉及内容及其互动无问题", "no_related_content": "无涉及内容及其互动"},
    "facebook": {"no_risk": "相关内容无问题", "no_related_content": "无相关内容"},
    "instagram": {"no_risk": "相关内容无问题", "no_related_content": "无相关内容"},
    "youtube": {"no_risk": "相关内容无问题", "no_related_content": "无相关内容"},
    "overseas_other": {"no_risk": "相关内容无问题", "no_related_content": "无相关内容"},
}

DOCUMENT_MODULES = dict(DELIVERY_MODULES)
DOCUMENT_MODULES.update({
    "netease_music": ("homepage",),
    "tieba": ("topic_homepage", "keyword_search"),
    "instagram": ("homepage",),
})


@dataclass(frozen=True)
class Diagnostic:
    level: str
    code: str
    message: str
    block_id: str = ""

    def line(self) -> str:
        block = f" block={self.block_id}" if self.block_id else ""
        return f"{self.level} {self.code}{block} {self.message}"


@dataclass(frozen=True)
class ModuleExpectation:
    text: str
    url: str | None
    module_key: str
    module_url: str | None
    number: int | None
    risk_group_ids: tuple[str, ...] = ()


class Report:
    def __init__(self) -> None:
        self.items: list[Diagnostic] = []

    def error(self, code: str, message: str, block_id: str = "") -> None:
        self.items.append(Diagnostic("ERROR", code, message, block_id))

    def warning(self, code: str, message: str, block_id: str = "") -> None:
        self.items.append(Diagnostic("WARNING", code, message, block_id))

    def block(self, code: str, message: str, block_id: str = "") -> None:
        self.items.append(Diagnostic("BLOCKED", code, message, block_id))

    @property
    def errors(self) -> list[Diagnostic]:
        return [item for item in self.items if item.level == "ERROR"]

    @property
    def warnings(self) -> list[Diagnostic]:
        return [item for item in self.items if item.level == "WARNING"]

    @property
    def blocked(self) -> list[Diagnostic]:
        return [item for item in self.items if item.level == "BLOCKED"]


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _decode_json_string(value: Any) -> Any:
    """Decode JSON strings without guessing among wrapper content entries."""
    current = value
    for _ in range(8):
        if not isinstance(current, str):
            break
        stripped = current.strip()
        if not stripped or stripped[0] not in "[{\"":
            break
        try:
            current = json.loads(stripped)
        except json.JSONDecodeError:
            break
    return current


def _looks_like_blocks(items: Any) -> bool:
    return isinstance(items, list) and bool(items) and all(
        isinstance(item, dict) and "block_id" in item and "block_type" in item
        for item in items
    )


def _direct_snapshot_container(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    block_list = value.get("block_list")
    if isinstance(block_list, dict) and _looks_like_blocks(block_list.get("items")):
        return block_list
    if _looks_like_blocks(value.get("items")):
        return value
    return None


def _has_standard_snapshot_metadata(value: dict[str, Any]) -> bool:
    if "snapshot_schema_version" not in value or "style_profile" not in value:
        return False
    document = value.get("document")
    if isinstance(document, dict) and isinstance(document.get("document"), dict):
        document = document["document"]
    if not isinstance(document, dict):
        return False
    return all(key in document for key in ("document_id", "title", "revision_before", "revision_after"))


def _walk_decoded_json(value: Any, depth: int = 0) -> Iterable[Any]:
    if depth > 10:
        return
    decoded = _decode_json_string(value)
    yield decoded
    if isinstance(decoded, dict):
        for child in decoded.values():
            yield from _walk_decoded_json(child, depth + 1)
    elif isinstance(decoded, list):
        for child in decoded:
            yield from _walk_decoded_json(child, depth + 1)


def _resolve_snapshot(value: Any) -> tuple[dict[str, Any] | None, Diagnostic | None]:
    """Resolve one full snapshot while rejecting bare or ambiguous wrapper data."""
    decoded = _decode_json_string(value)
    if _looks_like_blocks(decoded):
        return None, Diagnostic(
            "ERROR",
            "FSH-SNAPSHOT-008",
            "bare block items are not a final snapshot; include standard metadata, document identity/revisions, and has_more=false",
        )
    if isinstance(decoded, dict):
        direct = _direct_snapshot_container(decoded)
        if direct is not None:
            if "block_list" not in decoded and not _has_standard_snapshot_metadata(decoded):
                return None, Diagnostic(
                    "ERROR",
                    "FSH-SNAPSHOT-008",
                    "bare items container is not a final snapshot; include standard metadata, document identity/revisions, and has_more=false",
                )
            return decoded, None

    candidates: dict[str, dict[str, Any]] = {}
    for node in _walk_decoded_json(decoded):
        if not isinstance(node, dict) or node is decoded:
            continue
        container = _direct_snapshot_container(node)
        if container is None or "has_more" not in container or not _has_standard_snapshot_metadata(node):
            continue
        try:
            fingerprint = json.dumps(node, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError):
            continue
        candidates.setdefault(fingerprint, node)
    if not candidates:
        return None, Diagnostic(
            "ERROR",
            "FSH-SNAPSHOT-009",
            "wrapper contains no complete snapshot with standard metadata, document identity/revisions, has_more, and block_list/items",
        )
    if len(candidates) != 1:
        return None, Diagnostic(
            "ERROR",
            "FSH-SNAPSHOT-010",
            f"wrapper contains {len(candidates)} different complete snapshots; provide exactly one",
        )
    return next(iter(candidates.values())), None


def _metadata(raw: Any) -> dict[str, Any]:
    decoded = _decode_json_string(raw)
    if not isinstance(decoded, dict):
        return {}
    document = decoded.get("document")
    if isinstance(document, dict) and isinstance(document.get("document"), dict):
        document = document["document"]
    if not isinstance(document, dict):
        document = {}
    return {
        "snapshot_schema_version": decoded.get("snapshot_schema_version"),
        "style_profile": decoded.get("style_profile"),
        "document_id": document.get("document_id") or decoded.get("document_id"),
        "title": document.get("title") or decoded.get("title"),
        "revision_before": document.get("revision_before"),
        "revision_after": document.get("revision_after"),
    }


@lru_cache(maxsize=1)
def _disclaimer_gate() -> Any:
    """Load the one shared disclaimer gate; a missing dependency fails closed."""
    spec = importlib.util.spec_from_file_location("_feishu_shared_disclaimer_gate", DISCLAIMER_GATE_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {DISCLAIMER_GATE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def _business_risk_gate() -> Any:
    """Load the shared business-risk gate; a missing dependency fails closed."""
    spec = importlib.util.spec_from_file_location("_feishu_shared_business_risk_gate", BUSINESS_RISK_GATE_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {BUSINESS_RISK_GATE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def _client_challenge_gate() -> Any:
    """Load the release-only challenge gate without changing the initial audit."""
    spec = importlib.util.spec_from_file_location("_feishu_client_challenge_gate", CLIENT_CHALLENGE_GATE_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {CLIENT_CHALLENGE_GATE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _audit_client_challenge(
    decoded: dict[str, Any], items: list[dict[str, Any]], report: Report, *, base_dir: Path
) -> None:
    """Require a fresh challenge before releasing assistant-researched findings."""
    context = decoded.get("review_context")
    context = context if isinstance(context, dict) else {}
    business_review = context.get("business_risk_review")
    discovery_review = business_review.get("discovery_review") if isinstance(business_review, dict) else None
    research_mode = discovery_review.get("mode") if isinstance(discovery_review, dict) else None
    if research_mode != "assistant_research" and "client_challenge_review" not in context:
        # The business-risk gate separately verifies the explicit delivery-only
        # basis. Missing or malformed discovery records cannot create a pass.
        return
    review = context.get("client_challenge_review")
    if not isinstance(review, dict):
        diagnostic = Diagnostic(
            "ERROR", "CLIENT_CHALLENGE_REVIEW_REQUIRED",
            "a v3 independent client attitude loop followed by current final audit is required before release",
            "review_context.client_challenge_review",
        )
        if diagnostic not in report.items:
            report.items.append(diagnostic)
        return
    container = _direct_snapshot_container(decoded)
    if container is None or container.get("has_more") is not False:
        report.error("CLIENT_CHALLENGE_DOCUMENT_INCOMPLETE", "complete current block items with has_more=false are required")
        return
    meta = _metadata(decoded)
    try:
        result = _client_challenge_gate().audit_client_challenge(
            review,
            discovery_review=discovery_review,
            items=items,
            document_token=str(meta.get("document_id") or ""),
            revision_id=meta.get("revision_after"),
            required_policy_path=CURRENT_BUSINESS_RISK_POLICY,
            base_dir=base_dir,
        )
        if not isinstance(result, dict):
            raise ValueError("client challenge gate did not return an object")
        diagnostics: list[Diagnostic] = []
        for bucket, level in (("errors", "ERROR"), ("blocked", "BLOCKED")):
            findings = result.get(bucket)
            if not isinstance(findings, list):
                raise ValueError(f"client challenge gate returned malformed {bucket}")
            for finding in findings:
                if not isinstance(finding, dict) or not all(key in finding for key in ("code", "location", "actual", "expected")):
                    raise ValueError(f"client challenge gate returned a malformed {bucket} finding")
                diagnostics.append(Diagnostic(
                    level, str(finding["code"] or "CLIENT_CHALLENGE_GATE"),
                    f"{finding['actual']!r}; expected {finding['expected']!r}",
                    str(finding["location"] or "review_context.client_challenge_review"),
                ))
        expected_verdict = "FAIL" if result["errors"] else "BLOCKED" if result["blocked"] else "PASS"
        if result.get("verdict") != expected_verdict:
            raise ValueError("client challenge gate returned a missing or inconsistent verdict")
        notes = result.get("info", [])
        if not isinstance(notes, list) or not all(isinstance(note, str) for note in notes):
            raise ValueError("client challenge gate returned malformed info")
        diagnostics.extend(Diagnostic("INFO", "CLIENT_CHALLENGE_REVIEW_INFO", note) for note in notes)
        for diagnostic in diagnostics:
            if diagnostic not in report.items:
                report.items.append(diagnostic)
    except Exception as exc:
        diagnostic = Diagnostic(
            "BLOCKED", "CLIENT_CHALLENGE_GATE_UNAVAILABLE", str(exc), "review_context.client_challenge_review"
        )
        if diagnostic not in report.items:
            report.items.append(diagnostic)


def _disclaimer_document(meta: dict[str, Any]) -> dict[str, Any]:
    return {
        "document_id": meta.get("document_id"),
        "title": meta.get("title"),
        "revision_id": meta.get("revision_after"),
    }


def _audit_disclaimers(decoded: dict[str, Any], items: list[dict[str, Any]], report: Report) -> None:
    """Keep semantic-review absence separate from a confirmed disclaimer failure."""
    context = decoded.get("review_context")
    review = context.get("disclaimer_review") if isinstance(context, dict) else None
    try:
        result = _disclaimer_gate().audit_disclaimer_review(
            _disclaimer_document(_metadata(decoded)), items, decoded.get("raw_content"), review
        )
        if not isinstance(result, dict):
            raise ValueError("shared disclaimer gate did not return an object")
        for bucket, level in (("errors", "ERROR"), ("blocked", "BLOCKED")):
            findings = result.get(bucket)
            if not isinstance(findings, list):
                raise ValueError(f"shared disclaimer gate returned malformed {bucket}")
            for finding in findings:
                if not isinstance(finding, dict):
                    raise ValueError(f"shared disclaimer gate returned a malformed {bucket} finding")
                diagnostic = Diagnostic(
                    level,
                    str(finding.get("code") or "DISCLAIMER_GATE"),
                    f"{finding.get('actual')!r}; expected {finding.get('expected')!r}",
                    str(finding.get("location") or "disclaimer_review"),
                )
                if diagnostic not in report.items:
                    report.items.append(diagnostic)
        for note in result.get("info", []):
            diagnostic = Diagnostic("INFO", "DISCLAIMER_REVIEW_INFO", str(note))
            if diagnostic not in report.items:
                report.items.append(diagnostic)
    except Exception as exc:
        diagnostic = Diagnostic("BLOCKED", "DISCLAIMER_GATE_UNAVAILABLE", str(exc), "disclaimer_review")
        if diagnostic not in report.items:
            report.items.append(diagnostic)


def _audit_business_risk(
    decoded: dict[str, Any], items: list[dict[str, Any]], report: Report, *, risk_count: int
) -> None:
    """Require a current policy- and block-bound business-risk comparison."""
    context = decoded.get("review_context")
    review = context.get("business_risk_review") if isinstance(context, dict) else None
    reviewer_id = context.get("reviewer_id") if isinstance(context, dict) else None
    meta = _metadata(decoded)
    try:
        result = _business_risk_gate().audit_business_risk_review(
            review=review,
            items=items,
            document_token=str(meta.get("document_id") or ""),
            revision_id=meta.get("revision_after"),
            reviewer_id=reviewer_id,
            expected_group_indices=range(1, risk_count + 1),
        )
        if not isinstance(result, dict):
            raise ValueError("shared business-risk gate did not return an object")
        for bucket, level in (("errors", "ERROR"), ("blocked", "BLOCKED")):
            findings = result.get(bucket)
            if not isinstance(findings, list):
                raise ValueError(f"shared business-risk gate returned malformed {bucket}")
            for finding in findings:
                if not isinstance(finding, dict):
                    raise ValueError(f"shared business-risk gate returned a malformed {bucket} finding")
                diagnostic = Diagnostic(
                    level,
                    str(finding.get("code") or "BUSINESS_RISK_GATE"),
                    f"{finding.get('actual')!r}; expected {finding.get('expected')!r}",
                    str(finding.get("location") or "business_risk_review"),
                )
                if diagnostic not in report.items:
                    report.items.append(diagnostic)
        for note in result.get("info", []):
            diagnostic = Diagnostic("INFO", "BUSINESS_RISK_REVIEW_INFO", str(note))
            if diagnostic not in report.items:
                report.items.append(diagnostic)
    except Exception as exc:
        diagnostic = Diagnostic("BLOCKED", "BUSINESS_RISK_GATE_UNAVAILABLE", str(exc), "business_risk_review")
        if diagnostic not in report.items:
            report.items.append(diagnostic)


def _runs(block: dict[str, Any]) -> list[dict[str, Any]]:
    key = TEXT_KEYS.get(block.get("block_type"))
    container = block.get(key, {}) if key else {}
    elements = container.get("elements", []) if isinstance(container, dict) else []
    return [item["text_run"] for item in elements if isinstance(item, dict) and isinstance(item.get("text_run"), dict)]


def _text(block: dict[str, Any]) -> str:
    return "".join(str(run.get("content", "")) for run in _runs(block))


def _run_link(run: dict[str, Any]) -> str:
    style = run.get("text_element_style")
    if not isinstance(style, dict):
        return ""
    link = style.get("link")
    if isinstance(link, dict):
        return str(link.get("url", ""))
    return ""


def _links(block: dict[str, Any]) -> list[str]:
    return [link for link in (_run_link(run) for run in _runs(block)) if link]


def _visible_link_matches(block: dict[str, Any], url: str) -> bool:
    return any(str(run.get("content", "")).strip() == url for run in _runs(block) if _run_link(run) == url)


def _is_empty_text(block: dict[str, Any]) -> bool:
    return block.get("block_type") == 2 and not _text(block).strip()


def _is_plain_full_url(block: dict[str, Any]) -> bool:
    value = _text(block).strip()
    return block.get("block_type") == 2 and bool(URL_RE.fullmatch(value)) and not _links(block)


def _is_internal_link(url: str) -> bool:
    parsed = urlparse(url)
    return url.startswith("#") or bool(parsed.fragment and "/docx/" in parsed.path)


def _fragment(url: str) -> str:
    if url.startswith("#"):
        return unquote(url[1:])
    return unquote(urlparse(url).fragment)


def _conclusion_like(value: str) -> bool:
    text = value.strip()
    if not text or FULLWIDTH_PREFIX_RE.match(text) or URL_RE.search(text):
        return False
    return (
        text in {"无问题", "其余无问题", "相关内容无问题"}
        or "未发现异常" in text
        or "无问题" in text
        or "暂未发现" in text
        or "访问受限" in text
        or "登录或验证限制" in text
        or "未继续访问" in text
    )


def _descendants(start: str, blocks: dict[str, dict[str, Any]]) -> list[str]:
    result: list[str] = []
    stack = list(reversed(blocks.get(start, {}).get("children", []) or []))
    seen: set[str] = set()
    while stack:
        block_id = stack.pop()
        if block_id in seen or block_id not in blocks:
            continue
        seen.add(block_id)
        result.append(block_id)
        stack.extend(reversed(blocks[block_id].get("children", []) or []))
    return result


def _links_in_tree(start: str, blocks: dict[str, dict[str, Any]]) -> list[str]:
    ids = [start, *_descendants(start, blocks)]
    return [url for block_id in ids for url in _links(blocks[block_id])]


def _text_in_tree(start: str, blocks: dict[str, dict[str, Any]]) -> list[str]:
    ids = [start, *_descendants(start, blocks)]
    return [_text(blocks[block_id]).strip() for block_id in ids if _text(blocks[block_id]).strip()]


def _evidence_image_ids(start: str, blocks: dict[str, dict[str, Any]]) -> list[str]:
    """Return screenshot ids represented by one root evidence block."""
    block = blocks[start]
    if block.get("block_type") == 27:
        return [start]
    if block.get("block_type") != 24:
        return []
    return [
        block_id
        for block_id in _descendants(start, blocks)
        if blocks[block_id].get("block_type") == 27
    ]


def _normalize_subject_type(value: str) -> str:
    lowered = value.strip().lower()
    return "person" if lowered == "person" else "organization"


def _homepage_wording(subject_type: str, scope_unit: str) -> tuple[str, str]:
    lowered = subject_type.strip().lower()
    if lowered == "project":
        return "项目主页", "无项目主页；"
    if _normalize_subject_type(subject_type) == "organization":
        return "官方主页", "无官方主页；"
    return "个人主页", "无个人主页；"


def _suspected_homepage_wording(subject_type: str) -> str:
    lowered = subject_type.strip().lower()
    if lowered == "project":
        return "疑似项目主页"
    if _normalize_subject_type(subject_type) == "organization":
        return "疑似官方主页"
    return "疑似主页"


def _additional_homepage_label(module_name: str, url_index: int) -> str:
    """Return the unnumbered Chapter 4 label for a non-primary URL."""
    if module_name == "topic_homepage":
        return f"主题贴吧{url_index + 1}"
    if module_name == "topic":
        return f"超话/话题{url_index + 1}"
    return f"小号{url_index}"


def _module_line_expectations(
    *,
    platform_key: str,
    module_name: str,
    index: int,
    module: dict[str, Any],
    subject_type: str,
    scope_unit: str,
) -> list[ModuleExpectation]:
    """Return every visible line for one Chapter 4 module, primary first."""
    prefix = f"（{index}）"
    homepage_label, no_homepage = _homepage_wording(subject_type, scope_unit)
    suspected_homepage_label = _suspected_homepage_wording(subject_type)
    if module_name in {"homepage", "topic", "topic_homepage", "subject_homepage"}:
        if module_name == "topic":
            label, not_found = "超话/话题", "无超话/话题；"
        elif module_name == "topic_homepage":
            label, not_found = "主题贴吧", "无主题贴吧；"
        elif module_name == "subject_homepage":
            if _normalize_subject_type(subject_type) == "person":
                label, not_found = "豆瓣人物主页", "无豆瓣人物主页；"
            else:
                label, not_found = f"豆瓣{homepage_label}", f"无豆瓣{homepage_label}；"
        else:
            label, not_found = homepage_label, no_homepage
        if module.get("status") == "not_found":
            return [ModuleExpectation(f"{prefix}{not_found}", None, module_name, None, index)]
        urls = module.get("urls") if isinstance(module.get("urls"), list) else []
        identity_statuses = (
            module.get("url_identity_statuses")
            if isinstance(module.get("url_identity_statuses"), dict)
            else {}
        )
        suspected_urls = [
            str(raw_url) for raw_url in urls
            if identity_statuses.get(str(raw_url)) == "suspected"
        ]
        suspected_ordinals = {url: ordinal for ordinal, url in enumerate(suspected_urls, 1)}
        per_url = module.get("url_risk_group_ids") if isinstance(module.get("url_risk_group_ids"), dict) else {}
        result: list[ModuleExpectation] = []
        for url_index, raw_url in enumerate(urls):
            url = str(raw_url)
            suffix = ""
            if not per_url.get(url):
                suffix = "相关内容无问题" if module_name in {"topic", "topic_homepage", "subject_homepage"} else "无问题"
            is_suspected = (
                module_name in {"homepage", "subject_homepage"}
                and identity_statuses.get(url) == "suspected"
            )
            rendered_suspected_label = (
                f"{suspected_homepage_label}{suspected_ordinals[url]}"
                if is_suspected and len(suspected_urls) > 1
                else suspected_homepage_label
            )
            if url_index == 0:
                visible_label = f"{prefix}{rendered_suspected_label if is_suspected else label}"
            elif is_suspected:
                visible_label = rendered_suspected_label
            else:
                visible_label = _additional_homepage_label(module_name, url_index)
            result.append(
                ModuleExpectation(
                    f"{visible_label}：{url}{(' ' + suffix) if suffix else ''}",
                    url or None,
                    module_name,
                    url or None,
                    index if url_index == 0 else None,
                    tuple(str(group_id) for group_id in per_url.get(url, []) if isinstance(group_id, str)),
                )
            )
        return result
    if module_name in {"keyword_search", "baidu_search", "google_search"}:
        label = {
            "keyword_search": "关键词搜索",
            "baidu_search": "百度关键词搜索",
            "google_search": "谷歌关键词搜索",
        }[module_name]
        url = str(module.get("url", ""))
        suffix = "" if module.get("result_status") == "risk" else SEARCH_FIXED_SUFFIX[platform_key][module.get("result_status")]
        return [
            ModuleExpectation(
                f"{prefix}{label}：{url}{(' ' + suffix) if suffix else ''}",
                url or None,
                module_name,
                url or None,
                index,
                tuple(
                    str(group_id)
                    for group_id in module.get("risk_group_ids", [])
                    if isinstance(group_id, str)
                ),
            )
        ]
    raise ValueError(f"unsupported module {platform_key}.{module_name}")


def _subplatform_line_expectation(index: int, entry: dict[str, Any]) -> ModuleExpectation:
    name = str(entry.get("name", ""))
    homepage = entry.get("homepage") if isinstance(entry.get("homepage"), dict) else {}
    urls = homepage.get("urls") if isinstance(homepage.get("urls"), list) else []
    url = str(urls[0]) if urls else ""
    identity_statuses = homepage.get("url_identity_statuses") if isinstance(homepage.get("url_identity_statuses"), dict) else {}
    visible_name = f"{name}疑似主页" if identity_statuses.get(url) == "suspected" else name
    per_url = homepage.get("url_risk_group_ids") if isinstance(homepage.get("url_risk_group_ids"), dict) else {}
    suffix = "" if per_url.get(url) else "相关内容无问题"
    entry_id = str(entry.get("entry_id", ""))
    return ModuleExpectation(
        f"（{index}）{visible_name}：{url}{(' ' + suffix) if suffix else ''}",
        url or None,
        f"subplatform:{entry_id}",
        url or None,
        index,
        tuple(str(group_id) for group_id in per_url.get(url, []) if isinstance(group_id, str)),
    )


def _ordered_risk_groups(payload: dict[str, Any]) -> list[dict[str, Any]]:
    groups = payload.get("risk_groups") if isinstance(payload.get("risk_groups"), list) else []
    by_id = {
        str(group.get("id")): group
        for group in groups
        if isinstance(group, dict) and isinstance(group.get("id"), str)
    }
    order = payload.get("risk_summary_order") if isinstance(payload.get("risk_summary_order"), list) else []
    ordered = [by_id[group_id] for group_id in order if isinstance(group_id, str) and group_id in by_id]
    seen = {str(group.get("id")) for group in ordered}
    ordered.extend(group for group in groups if isinstance(group, dict) and str(group.get("id")) not in seen)
    return ordered


def _expected_report_title(subject: dict[str, Any]) -> str | None:
    report_date = subject.get("report_date")
    display_name = subject.get("display_name")
    if not isinstance(report_date, str) or not isinstance(display_name, str) or not display_name:
        return None
    match = re.fullmatch(r"\d{4}-(\d{2})-(\d{2})", report_date)
    if not match:
        return None
    month, day = (int(value) for value in match.groups())
    return f"{month}.{day}-{display_name}"


def validate_document(
    snapshot: Any,
    *,
    payload: dict[str, Any] | None = None,
    risk_count: int | None = None,
    subject_type: str | None = None,
) -> Report:
    report = Report()
    decoded, resolution_error = _resolve_snapshot(snapshot)
    if resolution_error is not None:
        report.items.append(resolution_error)
        return report
    if decoded is None:
        report.error("FSH-SNAPSHOT-001", "could not resolve a final Feishu snapshot")
        return report
    container = _direct_snapshot_container(decoded)
    if container is None:
        report.error("FSH-SNAPSHOT-001", "could not find a complete Feishu block list")
        return report
    items = container.get("items")
    if not _looks_like_blocks(items):
        report.error("FSH-SNAPSHOT-002", "block list is empty or malformed")
        return report
    _audit_disclaimers(decoded, items, report)
    if container.get("has_more") is not False:
        report.error(
            "FSH-SNAPSHOT-003",
            f"has_more must be present and false after saving every block-list page; found {container.get('has_more')!r}",
        )

    meta = _metadata(decoded)
    schema = meta.get("snapshot_schema_version")
    if schema != SNAPSHOT_SCHEMA_VERSION:
        report.error(
            "FSH-SNAPSHOT-004",
            f"snapshot_schema_version must be present and equal {SNAPSHOT_SCHEMA_VERSION!r}; found {schema!r}",
        )
    profile = meta.get("style_profile")
    if profile != STYLE_PROFILE_VERSION:
        report.error(
            "FSH-SNAPSHOT-007",
            f"style_profile must be present and equal {STYLE_PROFILE_VERSION!r}; found {profile!r}",
        )
    before, after = meta.get("revision_before"), meta.get("revision_after")
    if before is not None or after is not None:
        if before is None or after is None or before != after:
            report.error("FSH-SNAPSHOT-005", f"revision mismatch: before={before!r}, after={after!r}")
    else:
        report.error("FSH-SNAPSHOT-006", "revision_before/revision_after are required for a consistent final snapshot")

    if payload is not None:
        for error in validate_research_payload(payload, check_files=True):
            report.error("FSH-PAYLOAD-001", error)
        payload_risk_count = len(payload.get("risk_groups", [])) if isinstance(payload.get("risk_groups"), list) else 0
        if risk_count is not None and risk_count != payload_risk_count:
            report.error("FSH-PAYLOAD-002", f"--risk-count={risk_count} disagrees with payload count {payload_risk_count}")
        risk_count = payload_risk_count
        payload_type = str(payload.get("subject", {}).get("subject_type", ""))
        if subject_type is not None and subject_type != payload_type:
            report.error("FSH-PAYLOAD-003", f"subject_type={subject_type!r} disagrees with payload subject_type {payload_type!r}")
        subject_type = payload_type
    if risk_count is None:
        risk_count = sum(1 for item in items if item.get("block_type") == 6)
    if risk_count < 0:
        report.error("FSH-INPUT-001", "risk count cannot be negative")
        risk_count = 0
    _audit_business_risk(decoded, items, report, risk_count=risk_count)
    raw_subject_type = subject_type or "person"
    normalized_subject_type = _normalize_subject_type(raw_subject_type)
    scope_unit = ""
    ordered_risk_groups: list[dict[str, Any]] = []
    risk_groups_by_id: dict[str, dict[str, Any]] = {}
    if payload is not None:
        scope_unit = str(payload.get("subject", {}).get("scope", {}).get("unit", ""))
        ordered_risk_groups = _ordered_risk_groups(payload)
        risk_groups_by_id = {
            str(group.get("id")): group
            for group in ordered_risk_groups
            if isinstance(group.get("id"), str)
        }

    blocks: dict[str, dict[str, Any]] = {}
    for block in items:
        block_id = str(block.get("block_id", ""))
        if not block_id:
            report.error("FSH-GRAPH-001", "block without block_id")
            continue
        if block_id in blocks:
            report.error("FSH-GRAPH-002", "duplicate block_id", block_id)
        blocks[block_id] = block

    roots = [block for block in blocks.values() if block.get("block_type") == 1]
    if len(roots) != 1:
        report.error("FSH-GRAPH-003", f"expected exactly one Page block, found {len(roots)}")
        return report
    root = roots[0]
    root_id = str(root["block_id"])
    document_id = str(meta.get("document_id") or root_id)
    if root_id != document_id:
        report.error("FSH-GRAPH-004", f"Page id {root_id!r} differs from document_id {document_id!r}", root_id)
    if document_id in (TEMPLATE_DOCUMENT_TOKEN, "SYNTHETICDOC0000000000000001"):
        report.error("FSH-GUARD-001", "template token was supplied as the finished document", root_id)

    referenced_children: list[str] = []
    for block_id, block in blocks.items():
        children = block.get("children", []) or []
        if not isinstance(children, list):
            report.error("FSH-GRAPH-005", "children must be a list", block_id)
            continue
        if len(children) != len(set(children)):
            report.error("FSH-GRAPH-006", "duplicate child reference", block_id)
        for child_id in children:
            referenced_children.append(child_id)
            child = blocks.get(child_id)
            if child is None:
                report.error("FSH-GRAPH-007", f"missing child block {child_id!r}", block_id)
            elif child.get("parent_id") != block_id:
                report.error("FSH-GRAPH-008", f"child {child_id!r} has parent_id={child.get('parent_id')!r}", block_id)
    for block_id, block in blocks.items():
        parent_id = block.get("parent_id")
        if block_id == root_id:
            continue
        if not parent_id or parent_id not in blocks:
            report.error("FSH-GRAPH-009", f"orphan block; parent_id={parent_id!r}", block_id)
        elif block_id not in (blocks[parent_id].get("children", []) or []):
            report.error("FSH-GRAPH-010", "parent does not reference this child", block_id)
    if len(referenced_children) != len(set(referenced_children)):
        report.error("FSH-GRAPH-011", "a child block is referenced by more than one parent")
    reachable = {root_id, *_descendants(root_id, blocks)}
    for orphan in sorted(set(blocks) - reachable):
        report.error("FSH-GRAPH-012", "block is not reachable from Page", orphan)

    root_children = list(root.get("children", []) or [])
    root_blocks = [blocks[block_id] for block_id in root_children if block_id in blocks]
    page_title = _text(root).strip()
    metadata_title = str(meta.get("title") or "").strip()
    if not metadata_title:
        report.error("FSH-TITLE-001", "snapshot document title metadata is required", root_id)
    elif page_title != metadata_title:
        report.error("FSH-TITLE-001", f"Page title {page_title!r} differs from metadata title {metadata_title!r}", root_id)
    if not TITLE_RE.match(page_title):
        report.error("FSH-TITLE-002", "title must use M.D-对象名 with no leading zero", root_id)
    if payload is not None:
        subject_payload = payload.get("subject") if isinstance(payload.get("subject"), dict) else {}
        expected_title = _expected_report_title(subject_payload)
        if expected_title is None:
            report.error("FSH-TITLE-003", "payload subject.report_date/display_name cannot derive the required final title", root_id)
        elif page_title != expected_title or metadata_title != expected_title:
            report.error(
                "FSH-TITLE-003",
                f"title must be derived exactly from subject.report_date/display_name; expected={expected_title!r}, "
                f"page={page_title!r}, metadata={metadata_title!r}",
                root_id,
            )

    if any(block.get("block_type") in {3, 4} for block in blocks.values()):
        report.error("FSH-STRUCT-001", "single-person accepted-cloud-v1 must not contain H1/H2 blocks")
    h3 = [block for block in root_blocks if block.get("block_type") == 5]
    all_h3 = [block for block in blocks.values() if block.get("block_type") == 5]
    h3_texts = [_text(block).strip() for block in h3]
    allowed_h3_sequences = [["风险摘要", "基本信息", "背调详情"]]
    if h3_texts not in allowed_h3_sequences:
        report.error(
            "FSH-STRUCT-002",
            "H3 sequence must contain only 风险摘要/基本信息/背调详情, "
            f"found {h3_texts!r}",
        )
    h4 = [block for block in root_blocks if block.get("block_type") == 6]
    all_h4 = [block for block in blocks.values() if block.get("block_type") == 6]
    if len(all_h3) != len(h3) or len(all_h4) != len(h4):
        report.error("FSH-STRUCT-006", "all H3/H4 blocks must be root-level Chapter 4 headings")
    example_numbers: list[int] = []
    for block in h4:
        match = EXAMPLE_RE.match(_text(block).strip())
        if not match:
            report.error("FSH-STRUCT-003", "example heading must be H4 举例N【风险标题】", str(block.get("block_id", "")))
        else:
            example_numbers.append(int(match.group(1)))
    if example_numbers != list(range(1, risk_count + 1)):
        report.error("FSH-STRUCT-004", f"example sequence {example_numbers!r} must equal 1..{risk_count}")
    if payload is not None:
        expected_example_headings = [
            f"举例{index}【{group.get('title', '')}】"
            for index, group in enumerate(ordered_risk_groups, 1)
        ]
        actual_example_headings = [_text(block).strip() for block in h4]
        if actual_example_headings != expected_example_headings:
            report.error(
                "FSH-RISKMAP-002",
                f"example headings must exactly match ordered risk_groups; "
                f"expected={expected_example_headings!r}, actual={actual_example_headings!r}",
            )
    dividers = [block for block in root_blocks if block.get("block_type") == 22]
    if len(dividers) != 2:
        report.error("FSH-STRUCT-005", f"expected exactly two root dividers, found {len(dividers)}")

    callouts = [block for block in blocks.values() if block.get("block_type") == 19]
    by_emoji: dict[str, list[dict[str, Any]]] = {}
    for block in callouts:
        emoji = str(block.get("callout", {}).get("emoji_id", ""))
        by_emoji.setdefault(emoji, []).append(block)
    if len(by_emoji.get("trophy", [])) != 1:
        report.error("FSH-CARD-001", "expected exactly one trophy risk-summary callout")
    if len(by_emoji.get("round_pushpin", [])) != risk_count:
        report.error("FSH-CARD-002", f"expected {risk_count} round_pushpin example callout(s)")
    for emoji in ("bust_in_silhouette", "books", "heart", "ledger", "white_check_mark"):
        if len(by_emoji.get(emoji, [])) != 1:
            report.error("FSH-CARD-003", f"expected exactly one {emoji} callout")

    summary_links: list[str] = []
    if by_emoji.get("trophy"):
        summary = by_emoji["trophy"][0]
        summary_links = _links_in_tree(str(summary["block_id"]), blocks)
        if summary_links:
            report.error("FSH-LINK-001", "top risk summary must contain zero links", str(summary["block_id"]))
        summary_texts = _text_in_tree(str(summary["block_id"]), blocks)
        summary_entries = [text for text in summary_texts if re.match(r"^\d+[：:]", text)]
        if risk_count == 0:
            if "无" not in summary_texts:
                report.error("FSH-CARD-004", "no-risk summary must contain standalone 无", str(summary["block_id"]))
        elif len(summary_entries) != risk_count:
            report.error("FSH-CARD-005", f"summary has {len(summary_entries)} numbered risk entries; expected {risk_count}", str(summary["block_id"]))
        if payload is not None:
            expected_summary_entries = [
                f"{index}：{group.get('summary', '')}"
                for index, group in enumerate(ordered_risk_groups, 1)
            ]
            expected_summary_texts = ["风险摘要", *(expected_summary_entries or ["无"])]
            if summary_entries != expected_summary_entries or summary_texts != expected_summary_texts:
                report.error(
                    "FSH-RISKMAP-001",
                    f"risk summary must exactly match ordered risk_groups; "
                    f"expected={expected_summary_texts!r}, actual={summary_texts!r}",
                    str(summary["block_id"]),
                )

    all_links: list[tuple[str, str]] = []
    for block_id, block in blocks.items():
        all_links.extend((block_id, url) for url in _links(block))
    external_links = [(block_id, url) for block_id, url in all_links if not _is_internal_link(url)]
    for block_id, url in external_links:
        if not _visible_link_matches(blocks[block_id], url):
            report.error("FSH-LINK-002", f"external link text must be the complete target URL: {url}", block_id)
    internal_links = [(block_id, url) for block_id, url in all_links if _is_internal_link(url)]
    if len(internal_links) != risk_count:
        report.error("FSH-LINK-003", f"expected {risk_count} internal example link(s), found {len(internal_links)}")
    for block_id, url in internal_links:
        fragment = _fragment(url)
        if fragment not in blocks:
            report.error("FSH-LINK-004", f"internal destination {fragment!r} does not exist", block_id)
        if not url.startswith("#") and f"/docx/{document_id}#" not in url:
            report.error("FSH-LINK-005", "internal link points to a different document", block_id)

    example_link_targets: dict[str, str] = {}
    for example_index, example in enumerate(h4):
        start = root_children.index(str(example["block_id"]))
        end = len(root_children)
        for later in root_children[start + 1 :]:
            later_block = blocks[later]
            if later_block.get("block_type") in {5, 6, 22}:
                end = root_children.index(later)
                break
        example_ids = root_children[start:end]
        visible_urls = [URL_RE.search(_text(blocks[block_id])) for block_id in example_ids]
        if any(visible_urls):
            report.error("FSH-LINK-006", "example section contains a visible external URL", str(example["block_id"]))
        example_links = [url for block_id in example_ids for url in _links_in_tree(block_id, blocks)]
        if len(example_links) != 1 or not _is_internal_link(example_links[0]):
            report.error("FSH-LINK-007", "each example must contain exactly one internal link", str(example["block_id"]))
        callout_texts = [
            text
            for block_id in example_ids
            if blocks[block_id].get("block_type") == 19
            for text in _text_in_tree(block_id, blocks)
        ]
        if any(re.match(r"^(?:微博|B站|抖音|小红书|知乎|网易云音乐|贴吧|豆瓣|X|Facebook|INS|油管)：", text) for text in callout_texts):
            report.error("FSH-WORD-001", "example highlight must not begin with a platform prefix", str(example["block_id"]))
        if payload is not None and example_index < len(ordered_risk_groups):
            group = ordered_risk_groups[example_index]
            group_id = str(group.get("id", ""))
            expected_highlight = str(group.get("summary", ""))
            if callout_texts != [expected_highlight]:
                report.error(
                    "FSH-RISKMAP-003",
                    f"example highlight must exactly equal risk_groups[{group_id}].summary; "
                    f"expected={[expected_highlight]!r}, actual={callout_texts!r}",
                    str(example["block_id"]),
                )
            root_fact_texts = [
                _text(blocks[block_id]).strip()
                for block_id in example_ids[1:]
                if blocks[block_id].get("block_type") == 2 and _text(blocks[block_id]).strip()
            ]
            expected_fact = str(group.get("explanation", ""))
            if root_fact_texts != [expected_fact]:
                report.error(
                    "FSH-RISKMAP-004",
                    f"example fact paragraph must exactly equal risk_groups[{group_id}].explanation; "
                    f"expected={[expected_fact]!r}, actual={root_fact_texts!r}",
                    str(example["block_id"]),
                )
            if len(example_links) == 1 and _is_internal_link(example_links[0]):
                example_link_targets[group_id] = _fragment(example_links[0])

    for prefix in ("背调对象：", "类别：", "简介："):
        matches = [block for block in blocks.values() if _text(block).strip().startswith(prefix)]
        if len(matches) != 1:
            report.error("FSH-BASIC-001", f"expected exactly one {prefix} card, found {len(matches)}")
            continue
        block = matches[0]
        runs = [run for run in _runs(block) if str(run.get("content", ""))]
        if not runs or any(run.get("text_element_style", {}).get("bold") is not True for run in runs):
            report.error("FSH-BASIC-002", f"the complete {prefix} card must be bold", str(block["block_id"]))
        if prefix == "类别：" and len(_text(block).strip()) > 24:
            report.warning("FSH-LANG-001", "category card is unusually long", str(block["block_id"]))
        if prefix == "简介：" and len(_text(block).strip()) > 240:
            report.warning("FSH-LANG-002", "biography is unusually long; match the accepted concise baseline", str(block["block_id"]))
        if payload is not None:
            subject_payload = payload.get("subject") if isinstance(payload.get("subject"), dict) else {}
            expected_value = {
                "背调对象：": subject_payload.get("display_name"),
                "类别：": subject_payload.get("category"),
                "简介：": subject_payload.get("basic_info"),
            }[prefix]
            expected_text = f"{prefix}{expected_value}" if isinstance(expected_value, str) else None
            if expected_text is None or _text(block).strip() != expected_text:
                report.error(
                    "FSH-BASIC-008",
                    f"{prefix} must exactly match payload subject field; "
                    f"expected={expected_text!r}, actual={_text(block).strip()!r}",
                    str(block["block_id"]),
                )

    verdict_blocks = [block for block in blocks.values() if _text(block).strip().startswith("背调结果：")]
    if len(verdict_blocks) != 1:
        report.error("FSH-BASIC-003", f"expected exactly one 背调结果 block, found {len(verdict_blocks)}")
    else:
        block = verdict_blocks[0]
        runs = [run for run in _runs(block) if str(run.get("content", ""))]
        verdict_text = _text(block).strip().removeprefix("背调结果：").strip()
        if verdict_text not in RESULT_LEVELS:
            report.error("FSH-BASIC-004", f"unsupported verdict {verdict_text!r}", str(block["block_id"]))
        if any(run.get("text_element_style", {}).get("bold") is not True for run in runs):
            report.error("FSH-BASIC-005", "verdict label and value must both be bold", str(block["block_id"]))
        verdict_run = next((run for run in runs if str(run.get("content", "")).strip() == verdict_text), None)
        actual_color = verdict_run.get("text_element_style", {}).get("text_color") if verdict_run else None
        expected_color = VERDICT_COLORS.get(verdict_text)
        if actual_color != expected_color:
            report.error("FSH-BASIC-006", f"verdict color must be {expected_color!r}, found {actual_color!r}", str(block["block_id"]))
        if payload is not None:
            expected_verdict = payload.get("verdict", {}).get("result_level")
            if verdict_text != expected_verdict:
                report.error("FSH-BASIC-007", f"verdict {verdict_text!r} differs from payload {expected_verdict!r}", str(block["block_id"]))

    basic_tree_ids: set[str] = set()
    basic_heading = next((block for block in h3 if _text(block).strip() == "基本信息"), None)
    detail_heading = next((block for block in h3 if _text(block).strip() == "背调详情"), None)
    if basic_heading is not None and detail_heading is not None:
        basic_start = root_children.index(str(basic_heading["block_id"])) + 1
        basic_end = root_children.index(str(detail_heading["block_id"]))
        for block_id in root_children[basic_start:basic_end]:
            basic_tree_ids.add(block_id)
            basic_tree_ids.update(_descendants(block_id, blocks))
    grids = [blocks[block_id] for block_id in basic_tree_ids if blocks[block_id].get("block_type") == 24]
    columns = [blocks[block_id] for block_id in basic_tree_ids if blocks[block_id].get("block_type") == 25]
    if len(grids) != 2 or any(block.get("grid", {}).get("column_size") != 2 for block in grids):
        report.error("FSH-GRID-001", "the 基本信息 region must contain two 2-column grids")
    if len(columns) != 4 or any(block.get("grid_column", {}).get("width_ratio") != 50 for block in columns):
        report.error("FSH-GRID-002", "the 基本信息 region must contain four 50/50 grid columns")
    for column in columns:
        child_ids = [str(child) for child in (column.get("children") or [])]
        if len(child_ids) != 1 or child_ids[0] not in blocks or blocks[child_ids[0]].get("block_type") != 19:
            report.error("FSH-GRID-003", "each basic-information column must contain exactly one Callout and no padding blank", str(column["block_id"]))

    work_callouts = by_emoji.get("white_check_mark", [])
    if work_callouts:
        work = work_callouts[0]
        children = work.get("children", []) or []
        work_text_blocks = [blocks[child] for child in children if child in blocks and blocks[child].get("block_type") == 2]
        if not work_text_blocks or _text(work_text_blocks[0]).strip() != "代表作：":
            report.error("FSH-WORK-001", "works callout must start with 代表作：", str(work["block_id"]))
        for block in work_text_blocks[1:]:
            if "\n" in _text(block) or _links(block):
                report.error("FSH-WORK-002", "each work must be one unlinked plain text block", str(block["block_id"]))
        if payload is not None:
            expected_works = [item.get("title") for item in payload.get("representative_works", []) if isinstance(item, dict)]
            actual_works = [_text(block).strip() for block in work_text_blocks[1:]]
            if actual_works != expected_works:
                report.error("FSH-WORK-003", f"works differ from payload: expected={expected_works!r}, actual={actual_works!r}", str(work["block_id"]))

    platform_headings = [block for block in root_blocks if block.get("block_type") == 13]
    platform_texts = [_text(block).strip() for block in platform_headings]
    if platform_texts != list(PLATFORM_ORDER):
        report.error("FSH-PLATFORM-001", f"platform order mismatch: {platform_texts!r}")
    heading_ids = [str(block["block_id"]) for block in platform_headings]
    heading_positions = [root_children.index(block_id) for block_id in heading_ids if block_id in root_children]
    module_anchor_by_position: dict[int, tuple[str, str, str]] = {}
    expected_group_ids_by_target: dict[tuple[str, str, str], tuple[str, ...]] = {}
    platform_ranges: dict[str, tuple[int, int]] = {}
    platform_body_ids: set[str] = set()
    module_line_ids: set[str] = set()
    fixed_platform_line_ids: set[str] = set()
    if len(heading_positions) == 14:
        sequences = [block.get("ordered", {}).get("style", {}).get("sequence") for block in platform_headings]
        if sequences[0] != "1" or any(value != "auto" for value in sequences[1:]):
            report.error("FSH-PLATFORM-002", f"ordered heading sequences must be ['1','auto'...], found {sequences!r}")
        for index, platform in enumerate(PLATFORM_ORDER):
            start = heading_positions[index] + 1
            end = heading_positions[index + 1] if index + 1 < len(heading_positions) else len(root_children)
            module_ids = root_children[start:end]
            platform_ranges[PLATFORMS[index]] = (start, end)
            platform_body_ids.update(module_ids)
            module = [blocks[block_id] for block_id in module_ids]
            if not module or not _is_empty_text(module[-1]):
                report.error("FSH-SPACER-003", "platform module must end with one empty text spacer", heading_ids[index])
            direct_blanks = [block for block in module if _is_empty_text(block)]
            if len(direct_blanks) != 1:
                report.error("FSH-SPACER-004", f"platform module must contain exactly one root spacer, found {len(direct_blanks)}", heading_ids[index])
            texts = [(str(block["block_id"]), _text(block).strip()) for block in module if block.get("block_type") == 2 and _text(block).strip()]
            numbered = [(block_id, int(match.group(1))) for block_id, text in texts if (match := FULLWIDTH_PREFIX_RE.match(text))]
            numbers = [number for _, number in numbered]
            if not numbers or numbers != list(range(1, len(numbers) + 1)):
                report.error("FSH-NUMBER-001", f"body prefixes must be full-width continuous 1..N, found {numbers!r}", heading_ids[index])
            for block_id, text in texts:
                if ASCII_PREFIX_RE.match(text):
                    report.error("FSH-NUMBER-002", "ASCII body numbering is forbidden; use （N）", block_id)
                if len(re.findall(r"（\d+）", text)) > 1 or "\n" in text:
                    report.error("FSH-NUMBER-003", "one numbered item or conclusion per text block", block_id)
                urls = [match.group(0).rstrip("；。") for match in URL_RE.finditer(text)]
                if urls and not URL_RE.fullmatch(text):
                    for url in urls:
                        if not _visible_link_matches(blocks[block_id], url):
                            report.error(
                                "FSH-LINK-008",
                                f"module URL must be a complete visible clickable run whose target is identical: {url}",
                                block_id,
                            )

            if payload is not None:
                platform_key = PLATFORMS[index]
                platform_payload = payload.get("platforms", {}).get(platform_key, {})
                modules_payload = platform_payload.get("delivery_modules", {})
                numbered_blocks = {
                    int(match.group(1)): (block_id, text)
                    for block_id, text in texts
                    if (match := FULLWIDTH_PREFIX_RE.match(text))
                }
                expectations: list[ModuleExpectation] = []
                module_number = 1
                for module_name in DOCUMENT_MODULES[platform_key]:
                    if module_name == "review_start_month":
                        continue
                    module_payload = modules_payload.get(module_name)
                    if isinstance(module_payload, dict):
                        expectations.extend(
                            _module_line_expectations(
                                platform_key=platform_key,
                                module_name=module_name,
                                index=module_number,
                                module=module_payload,
                                subject_type=raw_subject_type,
                                scope_unit=scope_unit,
                            )
                        )
                        module_number += 1
                for entry in platform_payload.get("subplatforms", []):
                    if isinstance(entry, dict):
                        expectations.append(_subplatform_line_expectation(module_number, entry))
                        module_number += 1
                numbered_expectations = [item for item in expectations if item.number is not None]
                if len(numbered_blocks) != len(numbered_expectations):
                    report.error(
                        "FSH-PLATFORM-008",
                        f"Chapter 4 requires exactly {len(numbered_expectations)} numbered module line(s), found {len(numbered_blocks)}",
                        heading_ids[index],
                    )
                matched_module_blocks: set[str] = set()
                for expectation in expectations:
                    if expectation.number is not None:
                        actual = numbered_blocks.get(expectation.number)
                    else:
                        matches = [(block_id, text) for block_id, text in texts if text == expectation.text]
                        actual = matches[0] if len(matches) == 1 else None
                        if len(matches) > 1:
                            report.error(
                                "FSH-PLATFORM-013",
                                f"additional homepage line must occur once: {expectation.text}",
                                heading_ids[index],
                            )
                    if actual is None:
                        report.error("FSH-PLATFORM-009", f"missing exact module line: {expectation.text}", heading_ids[index])
                        continue
                    block_id, actual_text = actual
                    matched_module_blocks.add(block_id)
                    module_line_ids.add(block_id)
                    if actual_text != expectation.text:
                        report.error(
                            "FSH-PLATFORM-010",
                            f"module text must exactly follow Chapter 4; expected={expectation.text!r}, actual={actual_text!r}",
                            block_id,
                        )
                    if expectation.url and not _visible_link_matches(blocks[block_id], expectation.url):
                        report.error("FSH-LINK-009", f"expected module URL is not correctly linked: {expectation.url}", block_id)
                    if expectation.module_url:
                        target_key = (
                            platform_key,
                            expectation.module_key,
                            expectation.module_url,
                        )
                        module_anchor_by_position[root_children.index(block_id)] = target_key
                        expected_group_ids_by_target[target_key] = expectation.risk_group_ids
                homepage_like = re.compile(r"^(?:小号\d+|疑似(?:主页|官方主页|项目主页)\d*|主题贴吧\d+|超话/话题\d+)：")
                unexpected_module_lines = [
                    block_id
                    for block_id, text in texts
                    if URL_RE.search(text)
                    and (FULLWIDTH_PREFIX_RE.match(text) or homepage_like.match(text))
                    and block_id not in matched_module_blocks
                ]
                for block_id in unexpected_module_lines:
                    report.error(
                        "FSH-PLATFORM-014",
                        "unexpected, duplicated, or mislabeled Chapter 4 homepage/module URL line",
                        block_id,
                    )
                if platform_key == "x":
                    homepage_payload = modules_payload.get("homepage")
                    has_homepage = (
                        isinstance(homepage_payload, dict)
                        and isinstance(homepage_payload.get("urls"), list)
                        and bool(homepage_payload.get("urls"))
                    )
                    start_month = modules_payload.get("review_start_month")
                    time_lines = [
                        (block_id, text) for block_id, text in texts if text.startswith("背调时间：")
                    ]
                    if not has_homepage:
                        for block_id, _text_value in time_lines:
                            report.error(
                                "FSH-PLATFORM-011",
                                "X chapter must delete the review-time line when no homepage was found",
                                block_id,
                            )
                    elif isinstance(start_month, str) and re.fullmatch(r"\d{4}-\d{2}", start_month):
                        year, month = start_month.split("-")
                        expected_time = f"背调时间：{year}年{int(month)}月—至今"
                        time_matches = [block_id for block_id, text in time_lines if text == expected_time]
                        if len(time_matches) != 1 or len(time_lines) != 1:
                            report.error(
                                "FSH-PLATFORM-011",
                                f"X review time must occur once and equal {expected_time!r}",
                                heading_ids[index],
                            )
                        else:
                            fixed_platform_line_ids.add(time_matches[0])
                    else:
                        report.error(
                            "FSH-PLATFORM-011",
                            "X homepage requires a valid review_start_month and one exact review-time line",
                            heading_ids[index],
                        )
            platform_tail = OTHER_TAILS[0] if platform == "境内其他内容" else (
                OTHER_TAILS[1] if platform == "境外其他网站" else None
            )
            for block_id, text in texts:
                if _conclusion_like(text) and text != platform_tail:
                    report.error(
                        "FSH-PLATFORM-012",
                        "free-standing platform conclusion/access-boundary prose is forbidden; use only Chapter 4 module lines",
                        block_id,
                    )
            douban_homepage_label = "豆瓣人物主页" if normalized_subject_type == "person" else f"豆瓣{_homepage_wording(raw_subject_type, scope_unit)[0]}"
            required_labels = {
                "微博": ("主页", "关键词搜索", "超话/话题"),
                "B站": ("主页", "关键词搜索"),
                "抖音": ("主页", "关键词搜索"),
                "小红书": ("主页", "关键词搜索"),
                "知乎": ("主页", "关键词搜索"),
                "网易云音乐": ("主页",),
                "贴吧": ("主题贴吧", "关键词搜索"),
                "豆瓣": (douban_homepage_label, "关键词搜索"),
                "X": ("主页", "关键词搜索"),
                "Facebook": ("主页", "关键词搜索"),
                "INS": ("主页",),
                "油管": ("主页", "关键词搜索"),
            }
            if platform in required_labels:
                for label in required_labels[platform]:
                    label_present = any(label in text for _, text in texts)
                    # A suspected Douban subject homepage is intentionally
                    # rendered with the user-facing ``疑似主页`` prefix.  It
                    # still fulfils the subject-homepage module requirement.
                    if platform == "豆瓣" and label == douban_homepage_label:
                        label_present = label_present or any("疑似主页" in text for _, text in texts)
                    if not label_present:
                        report.error("FSH-PLATFORM-004", f"required Chapter 4 module is missing: {label}", heading_ids[index])
            else:
                tail = OTHER_TAILS[0] if platform == "境内其他内容" else OTHER_TAILS[1]
                occurrences = [(block_id, text) for block_id, text in texts if text == tail]
                if len(occurrences) != 1:
                    report.error("FSH-TAIL-001", f"required tail must occur exactly once: {tail}", heading_ids[index])
                else:
                    fixed_platform_line_ids.add(occurrences[0][0])
                nonblank = [block for block in module if not _is_empty_text(block)]
                if not nonblank or _text(nonblank[-1]).strip() != tail:
                    report.error("FSH-TAIL-002", "tail must be the final nonblank block", heading_ids[index])
                if FULLWIDTH_PREFIX_RE.match(tail) or ASCII_PREFIX_RE.match(tail):
                    report.error("FSH-TAIL-003", "tail must be unnumbered", occurrences[0][0] if occurrences else heading_ids[index])

    risk_group_id_by_title_position: dict[int, str] = {}
    risk_title_block_ids: set[str] = set()
    if payload is not None and len(heading_positions) == 14:
        covered_risk_title_positions: set[int] = set()
        for anchor_position, target_key in sorted(module_anchor_by_position.items()):
            platform_key, module_key, module_url = target_key
            _section_start, section_end = platform_ranges.get(platform_key, (anchor_position + 1, len(root_children)))
            later_anchor_positions = [
                position
                for position, anchor in module_anchor_by_position.items()
                if anchor[0] == platform_key and position > anchor_position
            ]
            target_end = min(later_anchor_positions) if later_anchor_positions else section_end
            risk_title_blocks: list[tuple[int, str, str]] = []
            for position in range(anchor_position + 1, target_end):
                block_id = root_children[position]
                block = blocks[block_id]
                text = _text(block).strip()
                if block.get("block_type") == 2 and text.startswith("风险点"):
                    risk_title_blocks.append((position, block_id, text))
                    risk_title_block_ids.add(block_id)
                    covered_risk_title_positions.add(position)
            expected_group_ids = list(expected_group_ids_by_target.get(target_key, ()))
            expected_titles = [
                f"风险点{number}：【{risk_groups_by_id.get(group_id, {}).get('title', '')}】"
                for number, group_id in enumerate(expected_group_ids, 1)
            ]
            actual_titles = [text for _position, _block_id, text in risk_title_blocks]
            if actual_titles != expected_titles:
                report.error(
                    "FSH-RISKMAP-005",
                    f"platform risk-point headings must exactly match the target module's ordered risk groups at "
                    f"{platform_key}.{module_key}[{module_url}]; expected={expected_titles!r}, actual={actual_titles!r}",
                    risk_title_blocks[0][1] if risk_title_blocks else root_children[anchor_position],
                )
            for item_index, (position, _block_id, text) in enumerate(risk_title_blocks):
                if item_index < len(expected_group_ids) and text == expected_titles[item_index]:
                    risk_group_id_by_title_position[position] = expected_group_ids[item_index]

        for platform_key, (section_start, section_end) in platform_ranges.items():
            for position in range(section_start, section_end):
                block = blocks[root_children[position]]
                if (
                    block.get("block_type") == 2
                    and _text(block).strip().startswith("风险点")
                    and position not in covered_risk_title_positions
                ):
                    report.error(
                        "FSH-RISKMAP-006",
                        f"risk-point heading is outside any exact Chapter 4 module URL target on {platform_key}",
                        str(block["block_id"]),
                    )
    root_blanks = [block for block in root_blocks if _is_empty_text(block)]
    if len(root_blanks) != 14:
        report.error("FSH-SPACER-005", f"expected fourteen root platform spacers, found {len(root_blanks)}")

    all_text_blocks = [block for block in blocks.values() if block.get("block_type") in TEXT_KEYS]
    for block in all_text_blocks:
        value = _text(block).strip()
        if not value or URL_RE.fullmatch(value):
            continue
        for literal in FORBIDDEN_LITERALS:
            if literal in value:
                report.error("FSH-WORD-002", f"forbidden final-facing research/process phrase: {literal}", str(block["block_id"]))
        if COUNT_LEDGER_RE.search(value):
            report.error("FSH-WORD-003", "collection/coverage count belongs only in the research package", str(block["block_id"]))
        if RATIO_RE.search(value):
            report.error("FSH-WORD-004", "visible/total or coverage ratio is forbidden in the finished document", str(block["block_id"]))
        if "：、" in value:
            report.error("FSH-LANG-003", "malformed punctuation ：、", str(block["block_id"]))
        if len(value) > 320:
            report.warning("FSH-LANG-004", "paragraph exceeds 320 characters; verify against the concise baseline", str(block["block_id"]))

    images = [block for block in blocks.values() if block.get("block_type") == 27]
    for block in images:
        if not str(block.get("image", {}).get("token", "")).strip():
            report.error("FSH-IMAGE-001", "image token is empty", str(block["block_id"]))

    expected_risk_url_counts: Counter[str] = Counter()
    expected_risk_locations: Counter[tuple[str, str, str, str, str]] = Counter()
    expected_screenshot_counts: dict[tuple[str, str, str, str, str], list[int]] = {}
    expected_findings: dict[tuple[str, str, str, str, str], list[str]] = {}
    if payload is not None:
        for group in payload.get("risk_groups", []):
            if not isinstance(group, dict):
                continue
            group_id = str(group.get("id", ""))
            for instance in group.get("instances", []):
                if not isinstance(instance, dict):
                    continue
                url = instance.get("source_url")
                if isinstance(url, str) and url:
                    targets = instance.get("module_targets") if isinstance(instance.get("module_targets"), list) else []
                    screenshot_count = len(instance.get("screenshots", [])) if isinstance(instance.get("screenshots"), list) else 0
                    expected_risk_url_counts[url] += len(targets)
                    for target in targets:
                        if not isinstance(target, dict):
                            continue
                        key = (
                            str(instance.get("platform_key", "")),
                            str(target.get("module_key", "")),
                            str(target.get("module_url", "")),
                            group_id,
                            url,
                        )
                        expected_risk_locations[key] += 1
                        expected_screenshot_counts.setdefault(key, []).append(screenshot_count)
                        expected_findings.setdefault(key, []).append(str(instance.get("finding", "")))
        for account in payload.get("accounts", []):
            if isinstance(account, dict) and account.get("status") in {"confirmed", "suspected_homepage"}:
                url = account.get("url")
                if isinstance(url, str) and url and not any(url in _text(block) for block in all_text_blocks):
                    report.error("FSH-ACCOUNT-001", f"delivered homepage URL missing from document: {url}")
    else:
        expected_risk_url_counts.update(_text(block).strip() for block in root_blocks if _is_plain_full_url(block))

    risk_fact_ids: set[str] = set()
    risk_url_block_ids: set[str] = set()
    risk_fact_context_by_id: dict[str, tuple[str, str, str, str, str, str]] = {}
    actual_risk_locations: Counter[tuple[str, str, str, str, str]] = Counter()
    actual_screenshot_counts: dict[tuple[str, str, str, str, str], list[int]] = {}
    actual_findings: dict[tuple[str, str, str, str, str], list[str]] = {}
    for url, expected_count in expected_risk_url_counts.items():
        matches = [block for block in root_blocks if _text(block).strip() == url]
        if len(matches) != expected_count:
            report.error(
                "FSH-EVIDENCE-001",
                f"risk URL must occur once in each linked Chapter 4 module; expected={expected_count}, actual={len(matches)}: {url}",
            )
        if not matches:
            continue
        for url_block in matches:
            url_id = str(url_block["block_id"])
            risk_url_block_ids.add(url_id)
            position = root_children.index(url_id)
            if not _is_plain_full_url(url_block):
                report.error("FSH-EVIDENCE-002", "risk URL must be a standalone complete plain-text URL without rich-link style", url_id)
            cursor = position - 1
            image_ids: list[str] = []
            while cursor >= 0:
                group_images = _evidence_image_ids(root_children[cursor], blocks)
                if not group_images:
                    break
                image_ids[0:0] = group_images
                cursor -= 1
            if not image_ids:
                report.error(
                    "FSH-EVIDENCE-003",
                    "risk URL must follow one or more screenshots, supplied as root image blocks or adaptive screenshot grids",
                    url_id,
                )
                continue
            if cursor < 0:
                report.error("FSH-EVIDENCE-004", "risk screenshots must immediately follow one factual text block", url_id)
                continue
            fact = blocks[root_children[cursor]]
            fact_text = _text(fact).strip()
            if fact.get("block_type") != 2 or not fact_text or URL_RE.fullmatch(fact_text) or "\n" in fact_text:
                report.error("FSH-EVIDENCE-004", "risk screenshots must immediately follow one factual text block", url_id)
                continue
            risk_fact_ids.add(str(fact["block_id"]))
            if payload is not None and len(heading_positions) == 14:
                platform_index = next(
                    (
                        idx
                        for idx, heading_position in enumerate(heading_positions)
                        if heading_position < position < (
                            heading_positions[idx + 1] if idx + 1 < len(heading_positions) else len(root_children)
                        )
                    ),
                    None,
                )
                if platform_index is not None:
                    platform_key = PLATFORMS[platform_index]
                    section_start = heading_positions[platform_index] + 1
                    anchors = [
                        (anchor_position, anchor)
                        for anchor_position, anchor in module_anchor_by_position.items()
                        if section_start <= anchor_position < position and anchor[0] == platform_key
                    ]
                    if anchors:
                        anchor_position, (_key, module_key, module_url) = max(anchors, key=lambda item: item[0])
                        preceding_risk_titles = [
                            (title_position, group_id)
                            for title_position, group_id in risk_group_id_by_title_position.items()
                            if anchor_position < title_position <= cursor
                        ]
                        group_id = max(preceding_risk_titles, key=lambda item: item[0])[1] if preceding_risk_titles else ""
                        location = (platform_key, module_key, module_url, group_id, url)
                        actual_risk_locations[location] += 1
                        actual_screenshot_counts.setdefault(location, []).append(len(image_ids))
                        actual_findings.setdefault(location, []).append(fact_text)
                        risk_fact_context_by_id[str(fact["block_id"])] = (
                            platform_key,
                            module_key,
                            module_url,
                            group_id,
                            url,
                            fact_text,
                        )
    if payload is not None and actual_risk_locations != expected_risk_locations:
        missing = expected_risk_locations - actual_risk_locations
        extra = actual_risk_locations - expected_risk_locations
        report.error(
            "FSH-EVIDENCE-006",
            f"risk evidence is not placed under its exact Chapter 4 module URL target(s); missing={dict(missing)}, extra={dict(extra)}",
        )
    if payload is not None:
        for location in sorted(set(expected_screenshot_counts) | set(actual_screenshot_counts)):
            expected_counts = sorted(expected_screenshot_counts.get(location, []))
            actual_counts = sorted(actual_screenshot_counts.get(location, []))
            if expected_counts != actual_counts:
                report.error(
                    "FSH-EVIDENCE-007",
                    f"risk screenshot count differs from payload at {location}: expected={expected_counts}, actual={actual_counts}",
                )
        for location in sorted(set(expected_findings) | set(actual_findings)):
            expected_values = Counter(expected_findings.get(location, []))
            actual_values = Counter(actual_findings.get(location, []))
            if expected_values != actual_values:
                report.error(
                    "FSH-RISKMAP-007",
                    f"platform risk finding differs from payload at {location}: "
                    f"expected={dict(expected_values)}, actual={dict(actual_values)}",
                )
    for block_id, url in internal_links:
        target = _fragment(url)
        if risk_fact_ids and target not in risk_fact_ids:
            report.error("FSH-EVIDENCE-005", "example jump does not target a platform risk fact block", block_id)

    if payload is not None:
        for group in ordered_risk_groups:
            group_id = str(group.get("id", ""))
            target_block_id = example_link_targets.get(group_id, "")
            actual_context = risk_fact_context_by_id.get(target_block_id)
            instances = group.get("instances") if isinstance(group.get("instances"), list) else []
            first_instance = instances[0] if instances and isinstance(instances[0], dict) else {}
            first_targets = first_instance.get("module_targets") if isinstance(first_instance.get("module_targets"), list) else []
            legal_contexts = {
                (
                    str(first_instance.get("platform_key", "")),
                    str(target.get("module_key", "")),
                    str(target.get("module_url", "")),
                    group_id,
                    str(first_instance.get("source_url", "")),
                    str(first_instance.get("finding", "")),
                )
                for target in first_targets
                if isinstance(target, dict)
            }
            if actual_context not in legal_contexts:
                report.error(
                    "FSH-RISKMAP-008",
                    f"example internal jump for {group_id} must target that group's instances[0] platform fact; "
                    f"actual={actual_context!r}, legal={sorted(legal_contexts)!r}",
                    target_block_id,
                )

    if payload is not None:
        expected_works = [item.get("title") for item in payload.get("representative_works", []) if isinstance(item, dict)]
        if len(expected_works) != len(set(expected_works)):
            report.error("FSH-WORK-004", "payload contains duplicate representative-work titles")
        for tail in OTHER_TAILS:
            if sum(1 for block in all_text_blocks if _text(block).strip() == tail) != 1:
                report.error("FSH-TAIL-004", f"tail count must equal one: {tail}")

        allowed_platform_text_ids = (
            module_line_ids
            | fixed_platform_line_ids
            | risk_title_block_ids
            | risk_fact_ids
            | risk_url_block_ids
        )
        for block_id in sorted(platform_body_ids):
            block = blocks[block_id]
            if block.get("block_type") != 2 or not _text(block).strip() or block_id in allowed_platform_text_ids:
                continue
            report.error(
                "FSH-PLATFORM-015",
                "platform chapters may contain only exact Chapter 4 module lines, risk-point headings, mapped findings, screenshots, risk URLs, and fixed time/tail lines",
                block_id,
            )

    if normalized_subject_type == "organization":
        for block_id in sorted(platform_body_ids):
            block = blocks[block_id]
            value = _text(block).strip()
            if (
                block_id in risk_fact_ids
                or not value
                or _is_plain_full_url(block)
                or RISK_POINT_RE.fullmatch(value)
            ):
                continue
            for forbidden in ("个人主页", "人物主页", "此人", "本人"):
                if forbidden in value:
                    report.error(
                        "FSH-SCOPE-001",
                        f"organization/company/brand/project module wording must not use personal term {forbidden!r}",
                        block_id,
                    )

    return report


def _fixture_snapshot(payload: dict[str, Any], *, evidence_in_grid: bool = False) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    lookup: dict[str, dict[str, Any]] = {}

    def add(block_id: str, block_type: int, parent: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        block: dict[str, Any] = {"block_id": block_id, "block_type": block_type, "parent_id": parent}
        if payload:
            block.update(payload)
        items.append(block)
        lookup[block_id] = block
        if parent:
            lookup[parent].setdefault("children", []).append(block_id)
        return block

    def text_payload(key: str, value: str, *, bold: bool = False, link: str = "", color: int | None = None, sequence: str | None = None) -> dict[str, Any]:
        style: dict[str, Any] = {"bold": bold, "italic": False, "underline": False, "strikethrough": False, "inline_code": False}
        if link:
            style["link"] = {"url": link}
        if color is not None:
            style["text_color"] = color
        container: dict[str, Any] = {"elements": [{"text_run": {"content": value, "text_element_style": style}}], "style": {"align": 1, "folded": False}}
        if sequence is not None:
            container["style"]["sequence"] = sequence
        return {key: container}

    def module_payload(value: str, url: str) -> dict[str, Any]:
        plain = {"bold": False, "italic": False, "underline": False, "strikethrough": False, "inline_code": False}
        linked = dict(plain)
        linked["link"] = {"url": url}
        before, marker, after = value.partition(url)
        elements: list[dict[str, Any]] = []
        if before:
            elements.append({"text_run": {"content": before, "text_element_style": dict(plain)}})
        if marker:
            elements.append({"text_run": {"content": url, "text_element_style": linked}})
        if after:
            elements.append({"text_run": {"content": after, "text_element_style": dict(plain)}})
        return {"text": {"elements": elements, "style": {"align": 1, "folded": False}}}

    def evidence_base(group_index: int, instance_index: int, target_index: int) -> str:
        return f"risk-{group_index + 1}-{instance_index + 1}-{target_index + 1}"

    raw_risk_groups = payload.get("risk_groups", []) if isinstance(payload.get("risk_groups"), list) else []
    risk_groups = _ordered_risk_groups(payload)
    raw_group_index_by_id = {
        str(group.get("id")): index
        for index, group in enumerate(raw_risk_groups)
        if isinstance(group, dict) and isinstance(group.get("id"), str)
    }
    risk_groups_by_id = {
        str(group.get("id")): group
        for group in risk_groups
        if isinstance(group.get("id"), str)
    }
    target_instances: dict[tuple[str, str, str], list[tuple[int, int, int, dict[str, Any]]]] = {}
    for group_index, group in enumerate(raw_risk_groups):
        if not isinstance(group, dict):
            continue
        for instance_index, instance in enumerate(group.get("instances", [])):
            if not isinstance(instance, dict):
                continue
            for target_index, target in enumerate(instance.get("module_targets", [])):
                if not isinstance(target, dict):
                    continue
                key = (
                    str(instance.get("platform_key", "")),
                    str(target.get("module_key", "")),
                    str(target.get("module_url", "")),
                )
                target_instances.setdefault(key, []).append(
                    (group_index, instance_index, target_index, instance)
                )

    subject_payload = payload.get("subject") if isinstance(payload.get("subject"), dict) else {}
    report_title = _expected_report_title(subject_payload) or "8.11-test"
    add("doc-test", 1, "", text_payload("page", report_title))
    add("h-risk", 5, "doc-test", text_payload("heading3", "风险摘要"))
    add("summary", 19, "doc-test", {"callout": {"emoji_id": "trophy"}})
    add("summary-label", 2, "summary", text_payload("text", "风险摘要"))
    if not risk_groups:
        add("summary-none", 2, "summary", text_payload("text", "无"))
    for group_index, group in enumerate(risk_groups):
        add(
            f"summary-entry-{group_index + 1}",
            2,
            "summary",
            text_payload("text", f"{group_index + 1}：{group.get('summary', '')}"),
        )
        add(
            f"h-example-{group_index + 1}",
            6,
            "doc-test",
            text_payload("heading4", f"举例{group_index + 1}【{group.get('title', '')}】"),
        )
        example = add(
            f"example-{group_index + 1}",
            19,
            "doc-test",
            {"callout": {"emoji_id": "round_pushpin"}},
        )
        instances = group.get("instances", []) if isinstance(group.get("instances"), list) else []
        canonical_target = ""
        if instances and isinstance(instances[0], dict):
            targets = instances[0].get("module_targets", [])
            if isinstance(targets, list) and targets:
                raw_group_index = raw_group_index_by_id.get(str(group.get("id", "")), group_index)
                canonical_target = evidence_base(raw_group_index, 0, 0) + "-fact"
        add(
            f"example-link-{group_index + 1}",
            2,
            str(example["block_id"]),
            text_payload(
                "text",
                str(group.get("summary", "")),
                link=f"https://my.feishu.cn/docx/doc-test#{canonical_target}",
            ),
        )
        add(
            f"example-fact-{group_index + 1}",
            2,
            "doc-test",
            text_payload("text", str(group.get("explanation", ""))),
        )
        shot_serial = 0
        for instance in instances:
            if not isinstance(instance, dict):
                continue
            for _shot in instance.get("screenshots", []):
                shot_serial += 1
                add(
                    f"example-image-{group_index + 1}-{shot_serial}",
                    27,
                    "doc-test",
                    {"image": {"token": f"image-example-{group_index + 1}-{shot_serial}", "width": 100, "height": 100}},
                )
    add("divider-1", 22, "doc-test", {"divider": {}})
    add("h-basic", 5, "doc-test", text_payload("heading3", "基本信息"))
    add("grid-1", 24, "doc-test", {"grid": {"column_size": 2}})
    add("col-1", 25, "grid-1", {"grid_column": {"width_ratio": 50}})
    add("card-subject", 19, "col-1", {"callout": {"emoji_id": "bust_in_silhouette"}})
    add("subject", 2, "card-subject", text_payload("text", f"背调对象：{payload.get('subject', {}).get('display_name', '')}", bold=True))
    add("col-2", 25, "grid-1", {"grid_column": {"width_ratio": 50}})
    add("card-category", 19, "col-2", {"callout": {"emoji_id": "books"}})
    add("category", 2, "card-category", text_payload("text", f"类别：{subject_payload.get('category', '')}", bold=True))
    add("grid-2", 24, "doc-test", {"grid": {"column_size": 2}})
    add("col-3", 25, "grid-2", {"grid_column": {"width_ratio": 50}})
    add("card-result", 19, "col-3", {"callout": {"emoji_id": "heart"}})
    result = add("result", 2, "card-result", text_payload("text", "背调结果：", bold=True))
    verdict = str(payload.get("verdict", {}).get("result_level", ""))
    verdict_style: dict[str, Any] = {"bold": True}
    if VERDICT_COLORS.get(verdict) is not None:
        verdict_style["text_color"] = VERDICT_COLORS[verdict]
    result["text"]["elements"].append({"text_run": {"content": verdict, "text_element_style": verdict_style}})
    add("col-4", 25, "grid-2", {"grid_column": {"width_ratio": 50}})
    add("card-bio", 19, "col-4", {"callout": {"emoji_id": "ledger"}})
    add("bio", 2, "card-bio", text_payload("text", f"简介：{payload.get('subject', {}).get('basic_info', '')}", bold=True))
    add("works", 19, "doc-test", {"callout": {"emoji_id": "white_check_mark"}})
    add("works-label", 2, "works", text_payload("text", "代表作：", bold=True))
    for work_index, work in enumerate(payload.get("representative_works", [])):
        if isinstance(work, dict):
            add(f"work-{work_index + 1}", 2, "works", text_payload("text", str(work.get("title", ""))))
    add("divider-2", 22, "doc-test", {"divider": {}})
    add("h-detail", 5, "doc-test", text_payload("heading3", "背调详情"))

    raw_subject_type = str(payload.get("subject", {}).get("subject_type", "person"))
    scope_unit = str(payload.get("subject", {}).get("scope", {}).get("unit", ""))

    risk_title_serial = 0

    def add_risk_evidence(
        platform_key: str,
        module_key: str,
        module_url: str,
        target_group_ids: tuple[str, ...],
    ) -> None:
        nonlocal risk_title_serial
        entries = target_instances.get((platform_key, module_key, module_url), [])
        for target_group_number, group_id in enumerate(target_group_ids, 1):
            risk_title_serial += 1
            group = risk_groups_by_id.get(group_id, {})
            add(
                f"risk-title-{risk_title_serial}",
                2,
                "doc-test",
                text_payload("text", f"风险点{target_group_number}：【{group.get('title', '')}】"),
            )
            for group_index, instance_index, target_index, instance in entries:
                raw_group = raw_risk_groups[group_index] if group_index < len(raw_risk_groups) else {}
                if not isinstance(raw_group, dict) or str(raw_group.get("id", "")) != group_id:
                    continue
                base = evidence_base(group_index, instance_index, target_index)
                add(base + "-fact", 2, "doc-test", text_payload("text", str(instance.get("finding", ""))))
                screenshots = instance.get("screenshots", []) if isinstance(instance.get("screenshots"), list) else []
                if evidence_in_grid:
                    grid_id = base + "-grid"
                    column_size = max(1, len(screenshots))
                    add(grid_id, 24, "doc-test", {"grid": {"column_size": column_size}})
                    for shot_index, _shot in enumerate(screenshots):
                        column_id = f"{base}-grid-column-{shot_index + 1}"
                        add(column_id, 25, grid_id, {"grid_column": {"width_ratio": 100 // column_size}})
                        add(
                            f"{base}-image-{shot_index + 1}",
                            27,
                            column_id,
                            {"image": {"token": f"image-{base}-{shot_index + 1}", "width": 100, "height": 100}},
                        )
                else:
                    for shot_index, _shot in enumerate(screenshots):
                        add(
                            f"{base}-image-{shot_index + 1}",
                            27,
                            "doc-test",
                            {"image": {"token": f"image-{base}-{shot_index + 1}", "width": 100, "height": 100}},
                        )
                add(base + "-url", 2, "doc-test", text_payload("text", str(instance.get("source_url", ""))))

    for index, platform in enumerate(PLATFORM_ORDER):
        slug = f"p{index + 1}"
        platform_key = PLATFORMS[index]
        platform_payload = payload.get("platforms", {}).get(platform_key, {})
        modules_payload = platform_payload.get("delivery_modules", {})
        add(f"{slug}-heading", 13, "doc-test", text_payload("ordered", platform, sequence="1" if index == 0 else "auto"))
        x_homepage = modules_payload.get("homepage")
        if (
            platform_key == "x"
            and isinstance(x_homepage, dict)
            and isinstance(x_homepage.get("urls"), list)
            and bool(x_homepage.get("urls"))
        ):
            start_month = modules_payload.get("review_start_month")
            if isinstance(start_month, str) and re.fullmatch(r"\d{4}-\d{2}", start_month):
                year, month = start_month.split("-")
                value = f"背调时间：{year}年{int(month)}月—至今"
            else:
                value = "背调时间：年 月—至今"
            add(f"{slug}-time", 2, "doc-test", text_payload("text", value))
        module_number = 1
        line_serial = 0
        for module_name in DOCUMENT_MODULES[platform_key]:
            if module_name == "review_start_month":
                continue
            module = modules_payload.get(module_name)
            if not isinstance(module, dict):
                continue
            for expectation in _module_line_expectations(
                platform_key=platform_key,
                module_name=module_name,
                index=module_number,
                module=module,
                subject_type=raw_subject_type,
                scope_unit=scope_unit,
            ):
                line_serial += 1
                block_id = f"{slug}-module-{line_serial}"
                line_payload = module_payload(expectation.text, expectation.url) if expectation.url else text_payload("text", expectation.text)
                add(block_id, 2, "doc-test", line_payload)
                if expectation.module_url:
                    add_risk_evidence(
                        platform_key,
                        expectation.module_key,
                        expectation.module_url,
                        expectation.risk_group_ids,
                    )
            module_number += 1
        for entry in platform_payload.get("subplatforms", []):
            if not isinstance(entry, dict):
                continue
            expectation = _subplatform_line_expectation(module_number, entry)
            line_serial += 1
            block_id = f"{slug}-module-{line_serial}"
            line_payload = module_payload(expectation.text, expectation.url) if expectation.url else text_payload("text", expectation.text)
            add(block_id, 2, "doc-test", line_payload)
            if expectation.module_url:
                add_risk_evidence(
                    platform_key,
                    expectation.module_key,
                    expectation.module_url,
                    expectation.risk_group_ids,
                )
            module_number += 1
        if platform_key in OTHER_TAIL_STATEMENTS:
            add(f"{slug}-tail", 2, "doc-test", text_payload("text", OTHER_TAIL_STATEMENTS[platform_key]))
        add(f"{slug}-blank", 2, "doc-test", text_payload("text", ""))

    snapshot = {
        "snapshot_schema_version": SNAPSHOT_SCHEMA_VERSION,
        "style_profile": STYLE_PROFILE_VERSION,
        "document": {"document_id": "doc-test", "title": report_title, "revision_before": 1, "revision_after": 1},
        "raw_content": {"content": "fixture"},
        "block_list": {"has_more": False, "items": items},
    }
    return _fixture_disclaimer_review(snapshot)


def _fixture_disclaimer_review(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Bind manual-gate proof for synthetic tests only; never repair production input."""
    gate = _disclaimer_gate()
    document = _disclaimer_document(_metadata(snapshot))
    items = snapshot["block_list"]["items"]
    context = snapshot.setdefault("review_context", {})
    reviewer_id = "strict-validator-synthetic-fixture"
    context["reviewer_id"] = reviewer_id
    context["disclaimer_review"] = {
        "status": "PASS",
        "policy_version": gate.DISCLAIMER_POLICY_VERSION,
        "scope": "full_document",
        "token": gate.review_document_token(document, items),
        "revision_id": _metadata(snapshot).get("revision_after"),
        "text_sha256": gate.review_text_fingerprint(document, items, snapshot.get("raw_content")),
        "reviewer_id": reviewer_id,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "findings": [],
    }
    business_gate = _business_risk_gate()
    blocks = {str(item.get("block_id")): item for item in items if item.get("block_id")}
    risk_count = sum(1 for item in items if item.get("block_type") == 6)
    result_block = next(item for item in items if _text(item).startswith("背调结果："))
    result_level = _text(result_block).split("：", 1)[1]
    confirmed_hits = []
    for index in range(1, risk_count + 1):
        summary_block = blocks[f"summary-entry-{index}"]
        link_block = blocks[f"example-link-{index}"]
        internal_urls = [url for url in _links(link_block) if _is_internal_link(url)]
        target_block_id = urlparse(internal_urls[0]).fragment
        platform_block = blocks[target_block_id]
        confirmed_hits.append(
            {
                "business_item": "LGBTQ/BL/GL（单独成轴）",
                "verified_fact": _text(platform_block),
                "risk_group_index": index,
                "summary_location": business_gate.block_location(summary_block),
                "platform_location": business_gate.block_location(platform_block),
                "result_level": result_level,
                "result_location": business_gate.block_location(result_block),
            }
        )
    context["business_risk_review"] = {
        "discovery_review": {
            "version": 1, "mode": "user_supplied", "scope": "offline delivery fixture",
            "instruction": "Offline fixture supplies researched conclusions for document tests.",
            "source_ref": "validate_feishu_document.py#_fixture_snapshot",
        },
        "status": "PASS",
        "scope": business_gate.BUSINESS_RISK_SCOPE,
        "token": str(_metadata(snapshot).get("document_id") or ""),
        "revision_id": _metadata(snapshot).get("revision_after"),
        "policy_sources": [business_gate.policy_source()],
        "confirmed_hits": confirmed_hits,
        "conflicts": [],
        "reviewer_id": reviewer_id,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
    return snapshot


def run_self_test() -> int:
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=EVIDENCE_ROOT) as temp_dir:
        payload = _self_test_payload(Path(temp_dir))
        fixture = _fixture_snapshot(payload)
        if any(item.get("block_id") == "p10-time" for item in fixture["block_list"]["items"]):
            print("SELF-TEST X chapter must omit the review-time line when no homepage exists")
            return 1
        report = validate_document(fixture, payload=payload)
        if report.errors or report.blocked:
            print("SELF-TEST valid payload-backed fixture unexpectedly failed")
            for item in report.items:
                print(item.line())
            return 1

        suspected_payload = copy.deepcopy(payload)
        suspected_payload["accounts"][0]["status"] = "suspected_homepage"
        suspected_module = suspected_payload["platforms"]["youtube"]["delivery_modules"]["homepage"]
        suspected_module["status"] = "suspected"
        suspected_module["url_identity_statuses"]["https://www.youtube.com/@fixturevalid"] = "suspected"
        suspected_payload["platforms"]["youtube"]["discovery_status"] = "suspected_account"
        suspected_payload["risk_groups"][0]["instances"][0]["finding"] = "该疑似主页账号发布的视频包含一项需评估内容。"
        suspected_payload["risk_groups"][0]["summary"] = "疑似主页账号公开内容存在一项需评估事项。"
        suspected_payload["risk_groups"][0]["explanation"] = "该事项来自疑似主页，账号归属尚未确认。"
        suspected_payload["verdict"]["overall_conclusion"] = "疑似主页出现一项需评估内容，账号归属尚未确认。"
        suspected_fixture = _fixture_snapshot(suspected_payload)
        suspected_report = validate_document(suspected_fixture, payload=suspected_payload)
        if suspected_report.errors or suspected_report.blocked:
            print("SELF-TEST suspected-homepage payload-backed fixture unexpectedly failed")
            for item in suspected_report.items:
                print(item.line())
            return 1

        grid_fixture = _fixture_snapshot(payload, evidence_in_grid=True)
        grid_report = validate_document(grid_fixture, payload=payload)
        if grid_report.errors or grid_report.blocked:
            print("SELF-TEST adaptive evidence-grid fixture unexpectedly failed")
            for item in grid_report.items:
                print(item.line())
            return 1

        organization_payload = copy.deepcopy(payload)
        organization_payload["subject"]["subject_type"] = "organization"
        organization_payload["subject"]["scope"]["unit"] = "组织"
        organization_payload["subject"]["scope"]["included"] = ["该组织公开账号与公开内容"]
        organization_fixture = _fixture_snapshot(organization_payload)
        organization_report = validate_document(organization_fixture, payload=organization_payload)
        if organization_report.errors or organization_report.blocked:
            print("SELF-TEST organization wording fixture unexpectedly failed")
            for item in organization_report.items:
                print(item.line())
            return 1
        organization_douban = next(
            item for item in organization_fixture["block_list"]["items"] if item["block_id"] == "p8-module-1"
        )
        if _text(organization_douban).strip() != "（1）无豆瓣官方主页；":
            print("SELF-TEST organization Douban module must use 豆瓣官方主页 rather than 豆瓣人物主页")
            return 1

        multi_homepage = {
            "status": "confirmed",
            "urls": ["https://social.example.test/main", "https://social.example.test/alt"],
            "url_identity_statuses": {
                "https://social.example.test/main": "confirmed",
                "https://social.example.test/alt": "confirmed",
            },
            "url_risk_group_ids": {
                "https://social.example.test/main": ["risk-001"],
                "https://social.example.test/alt": [],
            },
            "risk_group_ids": ["risk-001"],
        }
        multi_lines = _module_line_expectations(
            platform_key="facebook", module_name="homepage", index=1,
            module=multi_homepage, subject_type="person", scope_unit="个人",
        )
        expected_multi = [
            "（1）个人主页：https://social.example.test/main",
            "小号1：https://social.example.test/alt 无问题",
        ]
        if [item.text for item in multi_lines] != expected_multi or [item.number for item in multi_lines] != [1, None]:
            print("SELF-TEST multiple-homepage rendering did not preserve primary/小号 labels and per-URL verdicts")
            return 1
        mixed_homepage = copy.deepcopy(multi_homepage)
        mixed_homepage["url_identity_statuses"]["https://social.example.test/alt"] = "suspected"
        mixed_lines = _module_line_expectations(
            platform_key="facebook", module_name="homepage", index=1,
            module=mixed_homepage, subject_type="person", scope_unit="个人",
        )
        expected_mixed = [
            "（1）个人主页：https://social.example.test/main",
            "疑似主页：https://social.example.test/alt 无问题",
        ]
        if [item.text for item in mixed_lines] != expected_mixed or [item.number for item in mixed_lines] != [1, None]:
            print("SELF-TEST suspected-homepage rendering did not preserve the 疑似主页 label")
            return 1
        suspected_only = copy.deepcopy(multi_homepage)
        suspected_only["status"] = "suspected"
        suspected_only["urls"] = ["https://social.example.test/alt"]
        suspected_only["url_identity_statuses"] = {"https://social.example.test/alt": "suspected"}
        suspected_only["url_risk_group_ids"] = {"https://social.example.test/alt": []}
        suspected_only["risk_group_ids"] = []
        suspected_only_line = _module_line_expectations(
            platform_key="facebook", module_name="homepage", index=1,
            module=suspected_only, subject_type="person", scope_unit="个人",
        )[0]
        if suspected_only_line.text != "（1）疑似主页：https://social.example.test/alt 无问题":
            print("SELF-TEST suspected-only homepage must render as 疑似主页")
            return 1
        multiple_suspected = copy.deepcopy(suspected_only)
        multiple_suspected["urls"] = [
            "https://social.example.test/supplied-a",
            "https://social.example.test/supplied-b",
        ]
        multiple_suspected["url_identity_statuses"] = {
            "https://social.example.test/supplied-a": "suspected",
            "https://social.example.test/supplied-b": "suspected",
        }
        multiple_suspected["url_risk_group_ids"] = {
            "https://social.example.test/supplied-a": [],
            "https://social.example.test/supplied-b": [],
        }
        multiple_suspected_lines = _module_line_expectations(
            platform_key="facebook", module_name="homepage", index=1,
            module=multiple_suspected, subject_type="person", scope_unit="个人",
        )
        if [item.text for item in multiple_suspected_lines] != [
            "（1）疑似主页1：https://social.example.test/supplied-a 无问题",
            "疑似主页2：https://social.example.test/supplied-b 无问题",
        ]:
            print("SELF-TEST multiple supplied suspects must retain order and numbered 疑似主页 labels")
            return 1
        tieba_lines = _module_line_expectations(
            platform_key="tieba", module_name="topic_homepage", index=1,
            module=multi_homepage, subject_type="person", scope_unit="个人",
        )
        if not tieba_lines[1].text.startswith("主题贴吧2："):
            print("SELF-TEST second Tieba homepage must use 主题贴吧2")
            return 1
        subplatform_line = _subplatform_line_expectation(
            2,
            {
                "entry_id": "pixiv-main",
                "name": "Pixiv",
                "homepage": {
                    "status": "confirmed",
                    "urls": ["https://www.pixiv.net/users/fixturevalid"],
                    "url_identity_statuses": {"https://www.pixiv.net/users/fixturevalid": "confirmed"},
                    "url_risk_group_ids": {"https://www.pixiv.net/users/fixturevalid": []},
                    "risk_group_ids": [],
                },
            },
        )
        if subplatform_line.module_key != "subplatform:pixiv-main":
            print("SELF-TEST extra-platform module key must derive from stable entry_id rather than display name")
            return 1

        no_risk = copy.deepcopy(fixture)
        removed = {
            str(item["block_id"])
            for item in no_risk["block_list"]["items"]
            if str(item["block_id"]).startswith(("h-example-", "example-", "risk-"))
        }
        no_risk_items = no_risk["block_list"]["items"]
        no_risk["block_list"]["items"] = [item for item in no_risk_items if item["block_id"] not in removed]
        for item in no_risk["block_list"]["items"]:
            if isinstance(item.get("children"), list):
                item["children"] = [child for child in item["children"] if child not in removed]
        summary_entry = next(item for item in no_risk["block_list"]["items"] if item["block_id"] == "summary-entry-1")
        summary_entry["text"]["elements"][0]["text_run"]["content"] = "无"
        no_risk_report = validate_document(_fixture_disclaimer_review(no_risk), risk_count=0, subject_type="person")
        if no_risk_report.errors or no_risk_report.blocked:
            print("SELF-TEST no-risk document-only fixture unexpectedly failed")
            for item in no_risk_report.items:
                print(item.line())
            return 1

        cases: list[tuple[str, Any, str, dict[str, Any] | None]] = []

        direct_finding = copy.deepcopy(fixture)
        direct_finding["raw_content"] = {"content": "未找到版权联系人。"}
        direct_report = validate_document(_fixture_disclaimer_review(direct_finding), payload=payload)
        if direct_report.errors or direct_report.blocked:
            print("SELF-TEST direct negative finding was rejected as a disclaimer")
            for item in direct_report.items:
                print(item.line())
            return 1

        missing_review = copy.deepcopy(fixture)
        missing_review.pop("review_context")
        cases.append(("missing whole-document semantic review", missing_review, "DISCLAIMER_REVIEW_REQUIRED", payload))

        missing_raw = copy.deepcopy(fixture)
        missing_raw["raw_content"] = {"content": ""}
        _fixture_disclaimer_review(missing_raw)
        cases.append(("empty raw content cannot support full review", missing_raw, "DISCLAIMER_RAW_CONTENT", payload))

        incomplete_review = copy.deepcopy(fixture)
        incomplete_review["review_context"]["disclaimer_review"]["status"] = "BLOCKED"
        cases.append(("unfinished semantic review", incomplete_review, "DISCLAIMER_REVIEW_STATUS", payload))

        for field, value, code in (
            ("policy_version", "obsolete", "DISCLAIMER_REVIEW_BINDING"),
            ("scope", "sampled_blocks", "DISCLAIMER_REVIEW_BINDING"),
            ("token", "other-document", "DISCLAIMER_REVIEW_BINDING"),
            ("revision_id", 0, "DISCLAIMER_REVIEW_BINDING"),
            ("text_sha256", "0" * 64, "DISCLAIMER_REVIEW_BINDING"),
            ("reviewer_id", "", "DISCLAIMER_REVIEW_REVIEWER"),
            ("checked_at", "invalid", "DISCLAIMER_REVIEW_TIME"),
            ("findings", None, "DISCLAIMER_REVIEW_FINDINGS"),
        ):
            invalid_review = copy.deepcopy(fixture)
            invalid_review["review_context"]["disclaimer_review"][field] = value
            cases.append((f"invalid semantic review {field}", invalid_review, code, payload))

        raw_disclaimer = copy.deepcopy(fixture)
        raw_disclaimer["raw_content"] = {"content": [{"type": "text", "text": json.dumps({"data": {"content": "本报告仅供参考。"}}, ensure_ascii=False)}]}
        _fixture_disclaimer_review(raw_disclaimer)
        cases.append(("disclaimer inside wrapped raw content", raw_disclaimer, "DISCLAIMER_TEXT", payload))

        caption_disclaimer = copy.deepcopy(fixture)
        image = next(item for item in caption_disclaimer["block_list"]["items"] if item.get("block_type") == 27)
        image["image"]["caption"] = "展示不代表已获授权。"
        _fixture_disclaimer_review(caption_disclaimer)
        cases.append(("disclaimer inside image caption", caption_disclaimer, "DISCLAIMER_TEXT", payload))

        split_disclaimer = copy.deepcopy(fixture)
        split_block = next(item for item in split_disclaimer["block_list"]["items"] if item.get("block_type") == 2)
        split_block["text"]["elements"].extend([
            {"text_run": {"content": "仅供"}}, {"text_run": {"content": "参考。"}},
        ])
        _fixture_disclaimer_review(split_disclaimer)
        cases.append(("disclaimer split across rich-text runs", split_disclaimer, "DISCLAIMER_TEXT", payload))

        semantic_disclaimer = copy.deepcopy(fixture)
        unknown_variant = "我们把页面当成地图的一角，余下的路请读者自行判断。"
        semantic_disclaimer["raw_content"] = {"content": unknown_variant}
        _fixture_disclaimer_review(semantic_disclaimer)
        if _disclaimer_gate().scan_disclaimers(unknown_variant):
            print("SELF-TEST unknown-variant fixture must exercise the semantic gate")
            return 1
        semantic_disclaimer["review_context"]["disclaimer_review"].update({
            "status": "FAIL",
            "findings": [{"location": "raw_content", "excerpt": unknown_variant, "reason": "语义审阅发现将判断责任转移给读者"}],
        })
        cases.append(("unknown disclaimer found by semantic review", semantic_disclaimer, "DISCLAIMER_TEXT", payload))

        failed_review = copy.deepcopy(fixture)
        failed_review["review_context"]["disclaimer_review"]["status"] = "FAIL"
        cases.append(("semantic FAIL without extracted findings", failed_review, "DISCLAIMER_TEXT", payload))

        legacy_browser_payload = copy.deepcopy(payload)
        legacy_browser_route = legacy_browser_payload["platforms"]["facebook"]["research_completion"]["route_results"][0]
        legacy_browser_route["tool_kind"] = "manual_visible_browser"
        cases.append((
            "legacy browser research payload propagates into final validation",
            copy.deepcopy(fixture), "FSH-PAYLOAD-001", legacy_browser_payload,
        ))

        switched_edge_window_payload = copy.deepcopy(payload)
        switched_edge_window_route = next(
            route
            for route in switched_edge_window_payload["platforms"]["facebook"]["research_completion"]["route_results"]
            if route["tool_kind"] in {"browser_ui", "microsoft_edge_visible"}
        )
        switched_edge_window_route["edge_window_continuity_id"] = "contains-account-or-session-data"
        cases.append((
            "invalid Edge window continuity evidence propagates into final validation",
            copy.deepcopy(fixture), "FSH-PAYLOAD-001", switched_edge_window_payload,
        ))

        invalid_edge_page_peak_payload = copy.deepcopy(payload)
        invalid_edge_page_peak_route = next(
            route
            for route in invalid_edge_page_peak_payload["platforms"]["facebook"]["research_completion"]["route_results"]
            if route["tool_kind"] in {"browser_ui", "microsoft_edge_visible"}
        )
        invalid_edge_page_peak_route["max_task_open_edge_pages"] = 0
        cases.append((
            "invalid Edge-page peak in research payload propagates into final validation",
            copy.deepcopy(fixture), "FSH-PAYLOAD-001", invalid_edge_page_peak_payload,
        ))

        cases.append(("bare block items", copy.deepcopy(fixture["block_list"]["items"]), "FSH-SNAPSHOT-008", None))
        cases.append(("bare items container", copy.deepcopy(fixture["block_list"]), "FSH-SNAPSHOT-008", None))

        second_snapshot = copy.deepcopy(fixture)
        second_snapshot["document"]["title"] = "1.1-另一个快照"
        ambiguous_wrapper = {
            "content": [
                {"type": "text", "text": json.dumps(fixture, ensure_ascii=False)},
                {"type": "text", "text": json.dumps(second_snapshot, ensure_ascii=False)},
            ]
        }
        cases.append(("ambiguous wrapper snapshots", ambiguous_wrapper, "FSH-SNAPSHOT-010", None))

        wrong_heading = copy.deepcopy(fixture)
        block = next(item for item in wrong_heading["block_list"]["items"] if item["block_id"] == "h-risk")
        block["block_type"] = 4
        block["heading2"] = block.pop("heading3")
        cases.append(("wrong heading level", wrong_heading, "FSH-STRUCT-001", None))

        extra_h3 = copy.deepcopy(fixture)
        items = extra_h3["block_list"]["items"]
        root = next(item for item in items if item["block_id"] == "doc-test")
        extra = copy.deepcopy(next(item for item in items if item["block_id"] == "h-detail"))
        extra["block_id"] = "h-extra-forbidden"
        extra["heading3"]["elements"][0]["text_run"]["content"] = "联动品牌和口碑"
        items.append(extra)
        root["children"].insert(root["children"].index("h-detail"), extra["block_id"])
        cases.append(("extra Chapter-4 H3", extra_h3, "FSH-STRUCT-002", None))

        banned_count = copy.deepcopy(fixture)
        block = next(item for item in banned_count["block_list"]["items"] if item["block_id"] == "p1-module-1")
        block["text"]["elements"][0]["text_run"]["content"] = "公开页面可见记录为195条，主页显示总数297条。"
        cases.append(("forbidden visible-total count", banned_count, "FSH-WORD-002", None))

        missing_spacer = copy.deepcopy(fixture)
        items = missing_spacer["block_list"]["items"]
        root = next(item for item in items if item["block_id"] == "doc-test")
        root["children"].remove("p1-blank")
        items[:] = [item for item in items if item["block_id"] != "p1-blank"]
        cases.append(("missing platform spacer", missing_spacer, "FSH-SPACER-003", None))

        wrong_evidence_order = copy.deepcopy(fixture)
        root = next(item for item in wrong_evidence_order["block_list"]["items"] if item["block_id"] == "doc-test")
        url_index = root["children"].index("risk-1-1-1-url")
        image_index = root["children"].index("risk-1-1-1-image-1")
        root["children"][url_index], root["children"][image_index] = root["children"][image_index], root["children"][url_index]
        cases.append(("wrong fact-image-url order", wrong_evidence_order, "FSH-EVIDENCE-003", None))

        unbold_card = copy.deepcopy(fixture)
        block = next(item for item in unbold_card["block_list"]["items"] if item["block_id"] == "category")
        block["text"]["elements"][0]["text_run"]["text_element_style"]["bold"] = False
        cases.append(("basic card value not bold", unbold_card, "FSH-BASIC-002", None))

        wrong_title_payload = copy.deepcopy(fixture)
        root = next(item for item in wrong_title_payload["block_list"]["items"] if item["block_id"] == "doc-test")
        root["page"]["elements"][0]["text_run"]["content"] = "1.1-错误对象"
        wrong_title_payload["document"]["title"] = "1.1-错误对象"
        cases.append(("title differs from report_date", wrong_title_payload, "FSH-TITLE-003", payload))

        wrong_basic_subject = copy.deepcopy(fixture)
        block = next(item for item in wrong_basic_subject["block_list"]["items"] if item["block_id"] == "subject")
        block["text"]["elements"][0]["text_run"]["content"] = "背调对象：另一个对象"
        cases.append(("basic subject differs from payload", wrong_basic_subject, "FSH-BASIC-008", payload))

        wrong_summary = copy.deepcopy(fixture)
        block = next(item for item in wrong_summary["block_list"]["items"] if item["block_id"] == "summary-entry-1")
        block["text"]["elements"][0]["text_run"]["content"] = "1：自由改写的风险摘要"
        cases.append(("risk summary differs from payload", wrong_summary, "FSH-RISKMAP-001", payload))

        wrong_example_heading = copy.deepcopy(fixture)
        block = next(item for item in wrong_example_heading["block_list"]["items"] if item["block_id"] == "h-example-1")
        block["heading4"]["elements"][0]["text_run"]["content"] = "举例1【自由改写标题】"
        cases.append(("example heading differs from payload", wrong_example_heading, "FSH-RISKMAP-002", payload))

        wrong_example_highlight = copy.deepcopy(fixture)
        block = next(item for item in wrong_example_highlight["block_list"]["items"] if item["block_id"] == "example-link-1")
        block["text"]["elements"][0]["text_run"]["content"] = "自由改写高亮"
        cases.append(("example highlight differs from payload", wrong_example_highlight, "FSH-RISKMAP-003", payload))

        wrong_example_fact = copy.deepcopy(fixture)
        block = next(item for item in wrong_example_fact["block_list"]["items"] if item["block_id"] == "example-fact-1")
        block["text"]["elements"][0]["text_run"]["content"] = "自由改写事实段"
        cases.append(("example fact differs from payload", wrong_example_fact, "FSH-RISKMAP-004", payload))

        wrong_risk_title = copy.deepcopy(fixture)
        block = next(item for item in wrong_risk_title["block_list"]["items"] if item["block_id"] == "risk-title-1")
        block["text"]["elements"][0]["text_run"]["content"] = "风险点1：【自由改写标题】"
        cases.append(("platform risk title differs from payload", wrong_risk_title, "FSH-RISKMAP-005", payload))

        wrong_finding = copy.deepcopy(fixture)
        block = next(item for item in wrong_finding["block_list"]["items"] if item["block_id"] == "risk-1-1-1-fact")
        block["text"]["elements"][0]["text_run"]["content"] = "自由改写风险事实。"
        cases.append(("platform finding differs from payload", wrong_finding, "FSH-RISKMAP-007", payload))

        organization_person_term = copy.deepcopy(organization_fixture)
        block = next(item for item in organization_person_term["block_list"]["items"] if item["block_id"] == "p13-module-1")
        block["text"]["elements"][0]["text_run"]["content"] = block["text"]["elements"][0]["text_run"]["content"].replace("官方主页", "个人主页")
        cases.append(("organization module uses personal wording", organization_person_term, "FSH-SCOPE-001", organization_payload))

        ascii_numbering = copy.deepcopy(fixture)
        block = next(item for item in ascii_numbering["block_list"]["items"] if item["block_id"] == "p1-module-1")
        block["text"]["elements"][0]["text_run"]["content"] = "1. 无个人主页；"
        cases.append(("ASCII platform-body numbering", ascii_numbering, "FSH-NUMBER-002", None))

        missing_tail = copy.deepcopy(fixture)
        block = next(item for item in missing_tail["block_list"]["items"] if item["block_id"] == "p9-tail")
        block["text"]["elements"][0]["text_run"]["content"] = "尾句缺失"
        cases.append(("missing domestic tail", missing_tail, "FSH-TAIL-001", None))

        linked_summary = copy.deepcopy(fixture)
        block = next(item for item in linked_summary["block_list"]["items"] if item["block_id"] == "summary-entry-1")
        block["text"]["elements"][0]["text_run"]["text_element_style"]["link"] = {"url": "#risk-1-1-1-fact"}
        cases.append(("top summary contains a link", linked_summary, "FSH-LINK-001", None))

        wrong_jump = copy.deepcopy(fixture)
        block = next(item for item in wrong_jump["block_list"]["items"] if item["block_id"] == "example-link-1")
        block["text"]["elements"][0]["text_run"]["text_element_style"]["link"]["url"] = "https://my.feishu.cn/docx/doc-test#example-fact-1"
        cases.append(("internal jump targets the wrong fact", wrong_jump, "FSH-EVIDENCE-005", None))

        revision_mismatch = copy.deepcopy(fixture)
        revision_mismatch["document"]["revision_after"] = 2
        cases.append(("mixed-revision snapshot", revision_mismatch, "FSH-SNAPSHOT-005", None))

        missing_schema = copy.deepcopy(fixture)
        missing_schema.pop("snapshot_schema_version")
        cases.append(("missing snapshot schema metadata", missing_schema, "FSH-SNAPSHOT-004", None))

        missing_style = copy.deepcopy(fixture)
        missing_style.pop("style_profile")
        cases.append(("missing style metadata", missing_style, "FSH-SNAPSHOT-007", None))

        missing_revision = copy.deepcopy(fixture)
        missing_revision["document"].pop("revision_before")
        missing_revision["document"].pop("revision_after")
        cases.append(("missing revision metadata", missing_revision, "FSH-SNAPSHOT-006", None))

        incomplete_pages = copy.deepcopy(fixture)
        incomplete_pages["block_list"]["has_more"] = True
        cases.append(("incomplete block pagination", incomplete_pages, "FSH-SNAPSHOT-003", None))

        missing_pagination_state = copy.deepcopy(fixture)
        missing_pagination_state["block_list"].pop("has_more")
        cases.append(("missing block pagination state", missing_pagination_state, "FSH-SNAPSHOT-003", None))

        wrong_verdict_color = copy.deepcopy(fixture)
        block = next(item for item in wrong_verdict_color["block_list"]["items"] if item["block_id"] == "result")
        block["text"]["elements"][1]["text_run"]["text_element_style"]["text_color"] = 1
        cases.append(("wrong verdict color", wrong_verdict_color, "FSH-BASIC-006", None))

        identity_debugging = copy.deepcopy(fixture)
        block = next(item for item in identity_debugging["block_list"]["items"] if item["block_id"] == "p1-module-1")
        block["text"]["elements"][0]["text_run"]["content"] = "同名候选已排除，无问题。"
        cases.append(("identity-debugging prose", identity_debugging, "FSH-WORD-002", None))

        unclickable_url = copy.deepcopy(fixture)
        block = next(item for item in unclickable_url["block_list"]["items"] if item["block_id"] == "p13-module-1")
        linked_run = next(run["text_run"] for run in block["text"]["elements"] if "link" in run["text_run"].get("text_element_style", {}))
        linked_run["text_element_style"].pop("link")
        cases.append(("non-clickable homepage URL", unclickable_url, "FSH-LINK-008", payload))

        free_conclusion = copy.deepcopy(fixture)
        block = next(item for item in free_conclusion["block_list"]["items"] if item["block_id"] == "p1-blank")
        block["text"]["elements"][0]["text_run"]["content"] = "其余无问题"
        cases.append(("free-standing platform conclusion", free_conclusion, "FSH-PLATFORM-012", payload))

        unexpected_x_time = copy.deepcopy(fixture)
        items = unexpected_x_time["block_list"]["items"]
        root = next(item for item in items if item["block_id"] == "doc-test")
        source = copy.deepcopy(next(item for item in items if item["block_id"] == "p10-blank"))
        source["block_id"] = "p10-time-unexpected"
        source["text"]["elements"][0]["text_run"]["content"] = "背调时间：年 月—至今"
        items.append(source)
        root["children"].insert(root["children"].index("p10-heading") + 1, source["block_id"])
        cases.append(("X time line retained without a homepage", unexpected_x_time, "FSH-PLATFORM-011", payload))

        unexpected_homepage = copy.deepcopy(fixture)
        items = unexpected_homepage["block_list"]["items"]
        root = next(item for item in items if item["block_id"] == "doc-test")
        source = copy.deepcopy(next(item for item in items if item["block_id"] == "p13-module-1"))
        source["block_id"] = "p13-unexpected-homepage"
        source["text"]["elements"][0]["text_run"]["content"] = "小号2："
        items.append(source)
        root["children"].insert(root["children"].index("p13-blank"), source["block_id"])
        cases.append(("unexpected/mislabeled additional homepage", unexpected_homepage, "FSH-PLATFORM-014", payload))

        wrong_module_target = copy.deepcopy(fixture)
        root = next(item for item in wrong_module_target["block_list"]["items"] if item["block_id"] == "doc-test")
        evidence_ids = ["risk-1-1-1-fact", "risk-1-1-1-image-1", "risk-1-1-1-url"]
        for block_id in evidence_ids:
            root["children"].remove(block_id)
        insert_at = root["children"].index("p13-module-2") + 1
        root["children"][insert_at:insert_at] = evidence_ids
        cases.append(("risk evidence under wrong module target", wrong_module_target, "FSH-EVIDENCE-006", payload))

        bad_grid_count = copy.deepcopy(grid_fixture)
        items = bad_grid_count["block_list"]["items"]
        grid = next(item for item in items if item["block_id"] == "risk-1-1-1-grid")
        grid["grid"]["column_size"] = 2
        column = {
            "block_id": "risk-1-1-1-grid-column-extra", "block_type": 25,
            "parent_id": grid["block_id"], "children": ["risk-1-1-1-image-extra"],
            "grid_column": {"width_ratio": 50},
        }
        image = {
            "block_id": "risk-1-1-1-image-extra", "block_type": 27,
            "parent_id": column["block_id"], "image": {"token": "image-extra", "width": 100, "height": 100},
        }
        grid.setdefault("children", []).append(column["block_id"])
        items.extend([column, image])
        cases.append(("evidence grid screenshot-count mismatch", bad_grid_count, "FSH-EVIDENCE-007", payload))

        wrapper = {"content": [{"type": "text", "text": json.dumps(fixture, ensure_ascii=False)}]}
        wrapper_report = validate_document(wrapper, payload=payload)
        if wrapper_report.errors or wrapper_report.blocked:
            print("SELF-TEST MCP wrapper normalization failed")
            for item in wrapper_report.items:
                print(item.line())
            return 1

        for name, mutated, expected_code, case_payload in cases:
            mutated_report = validate_document(
                mutated,
                payload=case_payload,
                risk_count=None if case_payload is not None else 1,
                subject_type=None if case_payload is not None else "person",
            )
            codes = {item.code for item in [*mutated_report.errors, *mutated_report.blocked]}
            if expected_code not in codes:
                print(f"SELF-TEST {name!r} did not emit {expected_code}; got {sorted(codes)}")
                for item in mutated_report.items:
                    print(item.line())
                return 1

        print(f"SELF-TEST PASS profile={STYLE_PROFILE_VERSION} cases={len(cases) + 10}")
        return 0


def validation_result(
    report: Report, *, audit_only: bool, snapshot_path: Path, payload_path: Path | None
) -> dict[str, Any]:
    """记录标准检查结果；不接受外部 passed 标志或诊断豁免列表。"""
    def file_hash(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    snapshot, resolution_error = _resolve_snapshot(_load_json(snapshot_path))
    if resolution_error is not None and resolution_error not in report.items:
        report.items.append(resolution_error)
    if snapshot is not None:
        container = _direct_snapshot_container(snapshot)
        if container is not None and _looks_like_blocks(container.get("items")):
            # A supplied Report or a changed input file cannot waive any
            # current revision-bound review gate.
            _audit_disclaimers(snapshot, container["items"], report)
            if payload_path is not None:
                try:
                    payload_value = _load_json(payload_path)
                    current_risk_count = len(payload_value.get("risk_groups", [])) if isinstance(payload_value, dict) and isinstance(payload_value.get("risk_groups"), list) else 0
                except (OSError, ValueError, json.JSONDecodeError):
                    current_risk_count = sum(1 for item in container["items"] if item.get("block_type") == 6)
            else:
                current_risk_count = sum(1 for item in container["items"] if item.get("block_type") == 6)
            _audit_business_risk(snapshot, container["items"], report, risk_count=current_risk_count)
            if not audit_only:
                _audit_client_challenge(snapshot, container["items"], report, base_dir=snapshot_path.resolve().parent)
        else:
            report.block("DISCLAIMER_DOCUMENT_UNREADABLE", "complete block items are required for whole-document review")
            report.block("BUSINESS_RISK_DOCUMENT_UNREADABLE", "complete block items are required for business-risk review")
    elif resolution_error is None:
        report.block("DISCLAIMER_DOCUMENT_UNREADABLE", "could not resolve a document for whole-document review")
        report.block("BUSINESS_RISK_DOCUMENT_UNREADABLE", "could not resolve a document for business-risk review")
    skill_root = Path(__file__).resolve().parent.parent
    sources = [skill_root / "SKILL.md", *sorted((skill_root / "scripts").glob("*.py")),
               *sorted((skill_root / "references").glob("*.md"))]
    standard_sources = {str(p.relative_to(skill_root)): file_hash(p) for p in sources}
    if DISCLAIMER_GATE_PATH.is_file():
        standard_sources["../review-feishu-background-check/scripts/disclaimer_gate.py"] = file_hash(DISCLAIMER_GATE_PATH)
    if BUSINESS_RISK_GATE_PATH.is_file():
        standard_sources["../review-feishu-background-check/scripts/business_risk_gate.py"] = file_hash(BUSINESS_RISK_GATE_PATH)
    discovery_gate_path = skill_root.parent / "background-check-research" / "scripts" / "discovery_gate.py"
    if discovery_gate_path.is_file():
        standard_sources["../background-check-research/scripts/discovery_gate.py"] = file_hash(discovery_gate_path)
    if CLIENT_CHALLENGE_GATE_PATH.is_file():
        standard_sources["../client-challenge-background-check/scripts/client_challenge_gate.py"] = file_hash(CLIENT_CHALLENGE_GATE_PATH)
        current_challenge_path = CLIENT_CHALLENGE_GATE_PATH.with_name("client_challenge_v3.py")
        if current_challenge_path.is_file():
            standard_sources["../client-challenge-background-check/scripts/client_challenge_v3.py"] = file_hash(current_challenge_path)
    challenge_skill_root = CLIENT_CHALLENGE_GATE_PATH.parent.parent
    for relative in ("SKILL.md", "references/review-contract.md", "scripts/contextual_followup.py"):
        source = challenge_skill_root / relative
        if source.is_file():
            standard_sources[f"../client-challenge-background-check/{relative}"] = file_hash(source)
    consolidation_rule = skill_root.parent / "background-check-research" / "references" / "risk-consolidation.md"
    if consolidation_rule.is_file():
        standard_sources["../background-check-research/references/risk-consolidation.md"] = file_hash(consolidation_rule)
    clean = not report.errors and not report.blocked and not report.warnings
    return {
        "report_schema_version": "feishu-standard-validation-1.0",
        "mode": "audit_only" if audit_only else "delivery_validation",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "delivery_validation_passed": not audit_only and payload_path is not None and clean,
        "audit_passed": not report.errors and not report.blocked,
        "verdict": "FAIL" if report.errors else "BLOCKED" if report.blocked or report.warnings else "PASS",
        "document": snapshot.get("document") if isinstance(snapshot, dict) else None,
        "inputs": {
            "snapshot": {"path": str(snapshot_path.resolve()), "sha256": file_hash(snapshot_path)},
            "payload": ({"path": str(payload_path.resolve()), "sha256": file_hash(payload_path)}
                        if payload_path is not None else None),
        },
        "standard_sources": standard_sources,
        "diagnostics": [asdict(item) for item in report.items],
        "checks_not_performed": ["live_revision_refresh", "visual_review", "browser_link_activation"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot_pos", nargs="?", type=Path, help="snapshot JSON (positional compatibility form)")
    parser.add_argument("--snapshot", type=Path, help="snapshot JSON")
    parser.add_argument("--payload", type=Path, help="validated research_payload.json for cross-checking")
    parser.add_argument("--audit-only", action="store_true", help="structure-only audit without a research payload; not a delivery pass")
    parser.add_argument("--risk-count", type=int, help="expected risk-group count for --audit-only")
    parser.add_argument(
        "--subject-type",
        choices=("person", "organization", "company", "brand", "project", "other_entity"),
        help="scope wording profile for --audit-only",
    )
    parser.add_argument("--strict-warnings", action="store_true", help="make warnings block delivery")
    parser.add_argument("--report-json", type=Path, help="write the unfiltered standard result with input hashes and document revision")
    parser.add_argument("--self-test", action="store_true", help="run built-in positive and negative tests")
    args = parser.parse_args()

    if args.self_test:
        return run_self_test()
    snapshot_path = args.snapshot or args.snapshot_pos
    if snapshot_path is None:
        parser.error("provide --snapshot PATH or a positional snapshot path")
    if args.snapshot and args.snapshot_pos:
        parser.error("provide the snapshot once, not both positionally and via --snapshot")
    if not args.audit_only and args.payload is None:
        parser.error("finished-delivery validation requires --payload PATH; use --audit-only only for a non-delivery structural audit")
    if args.audit_only and args.payload is not None:
        parser.error("--audit-only cannot be combined with --payload")
    if args.audit_only and (args.risk_count is None or args.subject_type is None):
        parser.error("--audit-only requires both --risk-count and --subject-type")

    try:
        snapshot = _load_json(snapshot_path)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR FSH-INPUT-002 cannot read snapshot: {exc}", file=sys.stderr)
        return 2
    payload = None
    if args.payload:
        try:
            loaded = _load_json(args.payload)
            if not isinstance(loaded, dict):
                raise ValueError("payload must be a JSON object")
            payload = loaded
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(f"ERROR FSH-INPUT-003 cannot read payload: {exc}", file=sys.stderr)
            return 2

    report = validate_document(
        snapshot,
        payload=payload,
        risk_count=args.risk_count,
        subject_type=args.subject_type,
    )
    print(f"STYLE_PROFILE {STYLE_PROFILE_VERSION}")
    result = validation_result(report, audit_only=args.audit_only, snapshot_path=snapshot_path, payload_path=args.payload)
    for item in report.items:
        print(item.line())
    if args.report_json:
        # 不允许输出覆盖输入、共享校验器或 Skill。
        destination = args.report_json.resolve()
        skill_root = Path(__file__).resolve().parent.parent
        protected = {snapshot_path.resolve(), *( [args.payload.resolve()] if args.payload else [])}
        if destination in protected or destination.is_relative_to(skill_root):
            parser.error("--report-json must not overwrite an input or a shared Skill file")
        try:
            destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"ERROR FSH-REPORT-001 cannot write standard result: {exc}", file=sys.stderr)
            return 2
    blocked = bool(report.errors or report.blocked or (args.strict_warnings and report.warnings))
    if blocked:
        print(f"INVALID verdict={result['verdict']} errors={len(report.errors)} blocked={len(report.blocked)} warnings={len(report.warnings)}")
        return 1
    if args.audit_only:
        print(f"AUDIT_ONLY_PASS delivery_validation_passed=false errors=0 warnings={len(report.warnings)}")
    elif report.warnings:
        print(f"REVIEW_REQUIRED delivery_validation_passed=false errors=0 warnings={len(report.warnings)}")
    else:
        print("DELIVERY_VALIDATION_PASS delivery_validation_passed=true errors=0 warnings=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
