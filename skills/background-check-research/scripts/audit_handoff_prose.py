#!/usr/bin/env python3
"""Read-only lint for report prose; this does not validate research or rewrite facts.

API: audit_handoff_prose(data, input_kind="auto") -> JSON-serializable dict.
CLI: --input FILE [--kind auto|payload|report-plan|feishu-snapshot].
Exit codes: 0 = no blocking findings (warnings may remain), 1 = blocking prose
findings, 2 = invalid input. JSON is written only to stdout. Research evidence,
frequency dictionaries, screenshots.visible_text and ledgers are not audited.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any, Iterator

SCHEMA_VERSION = "handoff-prose-audit-1.0"
KINDS = ("auto", "payload", "report-plan", "feishu-snapshot")
ENGINEERING_RE = re.compile(
    r"\b(?:platform_record_count|distinct_content_group_count|matched_expression_count)\b|"
    r"频次记录\s*[：:][^\n]{0,350}\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\s*[:=]\s*\d+"
)
RAW_LABEL_RE = re.compile(r"(?:^|[\s；;])(?:主体文字|转发[／/]引用|抓取正文|原始正文)(?:[（(][^）)\n]{1,80}[）)])?\s*[：:]")
NAV_PATTERNS = tuple(re.compile(pattern) for pattern in (
    r"精选\s+推荐\s+AI抖音", r"关注\s+朋友\s+我的\s+直播",
    r"搜索\s+充钻石\s+客户端", r"通知\s+消息\s+投稿",
))
DEVICE_RE = re.compile(r"来自\s+(?:iPhone|Android|安卓|微博\s*weibo|[\w-]+手机)", re.I)
REACTION_TAIL_RE = re.compile(r"(?:转发\s+(?:评论\s+)?\d+(?:\s+\d+)*|转发\s+评论\s+赞)\s*$")
METHOD_RE = re.compile(
    r"仅记录.{0,100}(?:不据此评价|不作价值判断|不评价创作方式)|"
    r"(?:报告|各项)保留频次、语境.{0,50}价值判断"
)
DATE_TITLE_RE = re.compile(r"^.{2,70}20\d{6}\s*$")
TEXT_KEYS = {
    1: "page", 2: "text", 3: "heading1", 4: "heading2", 5: "heading3",
    6: "heading4", 7: "heading5", 8: "heading6", 9: "heading7",
    10: "heading8", 11: "heading9", 12: "bullet", 13: "ordered", 17: "todo",
}


def _field(value: Any, path: str, role: str, block_id: str | None = None) -> Iterator[dict]:
    if isinstance(value, str) and value.strip():
        yield {"text": value, "path": path, "role": role, "block_id": block_id}


def _groups(groups: Any, path: str, is_plan: bool) -> Iterator[dict]:
    if not isinstance(groups, list):
        return
    for index, group in enumerate(groups):
        if not isinstance(group, dict):
            continue
        group_path = f"{path}[{index}]"
        for key in ("title", "summary", "context_boundary" if is_plan else "explanation"):
            yield from _field(group.get(key), f"{group_path}.{key}", key)
        instances = group.get("instances", [])
        if not isinstance(instances, list):
            continue
        for item_index, instance in enumerate(instances):
            if isinstance(instance, dict):
                key = "fact" if is_plan else "finding"
                yield from _field(instance.get(key), f"{group_path}.instances[{item_index}].{key}", "fact")


def _resolve_kind(data: Any, input_kind: str) -> str:
    if input_kind not in KINDS:
        raise ValueError(f"unsupported input kind: {input_kind}")
    if not isinstance(data, dict):
        raise ValueError("input must be a JSON object")
    if input_kind != "auto":
        return input_kind
    if isinstance(data.get("block_list"), dict) and isinstance(data["block_list"].get("items"), list):
        return "feishu-snapshot"
    if isinstance(data.get("subjects"), list):
        return "report-plan"
    if isinstance(data.get("risk_groups"), list):
        return "payload"
    raise ValueError("cannot identify payload, report plan or Feishu snapshot")


def iter_prose_fields(data: dict, input_kind: str) -> Iterator[dict]:
    """Yield delivery-facing text only, not every string in a research package."""
    if input_kind == "payload":
        if not isinstance(data.get("risk_groups"), list):
            raise ValueError("payload requires risk_groups array")
        subject = data.get("subject", {})
        verdict = data.get("verdict", {})
        if isinstance(subject, dict):
            yield from _field(subject.get("basic_info"), "$.subject.basic_info", "basic_info")
        if isinstance(verdict, dict):
            yield from _field(verdict.get("overall_conclusion"), "$.verdict.overall_conclusion", "conclusion")
        yield from _groups(data["risk_groups"], "$.risk_groups", False)
    elif input_kind == "report-plan":
        if not isinstance(data.get("subjects"), list):
            raise ValueError("report plan requires subjects array")
        for index, subject in enumerate(data["subjects"]):
            if not isinstance(subject, dict):
                continue
            base = f"$.subjects[{index}]"
            for key in ("basic_info", "basic_info_candidate", "overall_conclusion_candidate"):
                yield from _field(subject.get(key), f"{base}.{key}", key)
            yield from _groups(subject.get("risk_groups"), f"{base}.risk_groups", True)
    elif input_kind == "feishu-snapshot":
        block_list = data.get("block_list")
        if not isinstance(block_list, dict) or not isinstance(block_list.get("items"), list):
            raise ValueError("Feishu snapshot requires block_list.items array")
        for index, block in enumerate(block_list["items"]):
            if not isinstance(block, dict):
                continue
            key = TEXT_KEYS.get(block.get("block_type"))
            if not key or not isinstance(block.get(key), dict):
                continue
            elements = block[key].get("elements", [])
            text = "".join(
                str(element["text_run"].get("content", ""))
                for element in elements if isinstance(element, dict) and isinstance(element.get("text_run"), dict)
            )
            role = "visible_text" if key in ("text", "bullet", "ordered", "todo") else "title"
            yield from _field(text, f"$.block_list.items[{index}].{key}.elements", role, block.get("block_id"))


def audit_text(text: str, path: str, role: str = "fact", block_id: str | None = None) -> list[dict]:
    """Return findings without changing text or deciding the underlying risk."""
    normalized = text.replace("\\_", "_").strip()
    findings: list[dict] = []

    def add(rule: str, severity: str, message: str) -> None:
        finding = {"path": path, "rule": rule, "severity": severity, "message": message,
                   "excerpt": normalized[:180], "text_length": len(normalized)}
        if block_id:
            finding["block_id"] = str(block_id)
        findings.append(finding)

    if ENGINEERING_RE.search(normalized):
        add("engineering-field-in-prose", "error", "交付正文含内部计数字段；需改为准确的自然中文频次。")
    if RAW_LABEL_RE.search(normalized):
        add("raw-capture-label", "error", "交付正文含原始抓取归属标签；需人工概括并保留原创／转发归属。")
    if sum(bool(pattern.search(normalized)) for pattern in NAV_PATTERNS) >= 2:
        add("web-navigation-pollution", "error", "交付正文混入多个网页导航区段。")
    if DEVICE_RE.search(normalized) and REACTION_TAIL_RE.search(normalized):
        add("web-metadata-pollution", "error", "正文同时含发布设备和页尾互动计数，疑为整页抓取文本。")
    if METHOD_RE.search(normalized):
        add("methodology-boilerplate", "warning", "方法论式说明可能应留在研究记录；人工检查是否有必须保留的归属限制。")
    if role != "title" and len(normalized) > 350:
        add("long-prose-review", "warning", "段落较长，需人工检查是否堆砌原文；字数本身不构成错误。")
    if role != "title" and len(normalized) >= 100 and normalized.count("#") >= 5:
        add("raw-post-review", "warning", "正文含多组话题标签，需人工检查是否仍在罗列原帖。")
    if role in ("fact", "visible_text") and (
        re.search(r"[_＿]哔哩哔哩(?:bilibili)?\s*$", normalized, re.I)
        or (DATE_TITLE_RE.match(normalized) and not re.search(r"[。；：！？]", normalized))
    ):
        add("title-as-fact-review", "warning", "该段形似视频标题，需检查是否缺少对所涉内容的事实概括。")
    return findings


def audit_handoff_prose(data: Any, input_kind: str = "auto") -> dict:
    kind = _resolve_kind(data, input_kind)
    fields = list(iter_prose_fields(data, kind))
    findings = [finding for field in fields for finding in audit_text(**field)]
    if not fields:
        findings.append({"path": "$", "rule": "no-prose-fields", "severity": "warning",
                         "message": "未提取到交付文字，不能据此认定文案通过。", "excerpt": "", "text_length": 0})
    errors = sum(item["severity"] == "error" for item in findings)
    warnings = sum(item["severity"] == "warning" for item in findings)
    return {
        "schema_version": SCHEMA_VERSION, "input_kind": kind,
        "status": "blocked" if errors else "manual_review" if warnings else "pass",
        "summary": {"fields_checked": len(fields), "errors": errors, "warnings": warnings},
        "findings": findings,
        "limitations": [
            "规则仅发现常见交付文案污染；零命中不代表已完成全文人工审稿。",
            "不验证事实真实性、账号归属、频次计算、证据充分性或调查覆盖率。",
            "告警必须由执行者结合原文复核；不自动删改事实、数字或引文。",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--kind", choices=KINDS, default="auto")
    args = parser.parse_args(argv)
    try:
        with open(args.input, encoding="utf-8-sig") as handle:
            data = json.load(handle)
        result = audit_handoff_prose(data, args.kind)
        result["input_path"] = args.input
        code = int(result["summary"]["errors"] > 0)
    except (OSError, ValueError, TypeError) as error:
        result = {"schema_version": SCHEMA_VERSION, "status": "invalid_input", "error": str(error)}
        code = 2
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
