#!/usr/bin/env python3
"""Whole-document disclaimer gate shared by ordinary and strict Feishu review.

Patterns reject known forms. A current, complete semantic review is separately
required: a pattern miss is never evidence that the prose is acceptable.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import datetime
from typing import Any

DISCLAIMER_POLICY_VERSION = "1.0.0"

# Match explanatory disclaimers, not bare negative findings such as 未找到版权方.
# There is deliberately no whole-block whitelist for legitimate findings.
_PATTERNS = (
    ("reference_only", r"仅供(?:参考|内部参考)|不构成.{0,16}(?:意见|建议|保证)|非法律意见|(?:自行|另行)(?:核实|承担风险)|(?:读者|使用方).{0,8}独立判断|不(?:作|做)(?:担保|保证)|不承担.{0,20}(?:责任|后果)|概不负责|(?:最终|一切).{0,8}以.{1,30}为准"),
    ("proof_boundary", r"(?:不|不能|无法|不足以|尚不足以|未必能)(?:据此|单独|独立|直接|自动)?(?:证明|确证)|(?:不能|无法|不足以|尚不足以)(?:据此|单独|独立|直接)(?:确认|认定|确定)|(?:不能|无法)(?:据此)?作为.{0,18}(?:确证|证明|授权依据)"),
    ("source_boundary", r"(?:标注|标记|水印|页面|网页|目录|原创|出版身份|家属称谓|上传账号|上传者|卖家|原作|公开可见|下载文件|公开资料|上述资料|展示).{0,85}(?:不代表|不等于|不等同于|不意味着|不足以认定|不宜认定|不能替代|不是.{0,16}(?:证明|授权)|不自动授予)"),
    ("conclusion_boundary", r"(?:尚未确权|未能确权).{0,16}不等于|不视为.{0,16}(?:确证|确认)|这只是.{0,12}(?:计算|推算)|仅能提供.{0,18}线索|(?:本报告|本次调查|调查结果).{0,25}(?:不保证|不能保证|无法保证|不应视为)|不能支持.{0,20}(?:自由商用|无风险).{0,8}结论"),
    ("english_disclaimer", r"for\s+(?:reference|informational\s+purposes)\s+only|not\s+(?:legal|professional)\s+advice|does\s+not\s+(?:prove|constitute|guarantee)|no\s+(?:guarantee|liability)|at\s+your\s+own\s+risk"),
)
_COMPILED = [(name, re.compile(pattern, re.IGNORECASE)) for name, pattern in _PATTERNS]
_URL = re.compile(r"https?://[^\s<>\"，。；]+", re.IGNORECASE)


def _normalized(text: str) -> str:
    value = unicodedata.normalize("NFKC", text)
    value = "".join(char for char in value if unicodedata.category(char) != "Cf")
    value = _URL.sub(" ", value)
    # Chinese words can be split across rich-text runs, spaces or line breaks.
    value = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", value)
    return re.sub(r"\s+", " ", value).strip()


def scan_disclaimers(text: str) -> list[dict[str, str]]:
    value = _normalized(text)
    found = []
    for name, pattern in _COMPILED:
        match = pattern.search(value)
        if match:
            found.append({"code": "DISCLAIMER_TEXT", "excerpt": value[max(0, match.start() - 35):match.end() + 70], "reason": name})
    return found


def _visible_text(value: Any, parent: str = "") -> list[str]:
    """Read all display fields, including nested cells, rich runs and captions."""
    if isinstance(value, list):
        return [part for item in value for part in _visible_text(item, parent)]
    if not isinstance(value, dict):
        return []
    parts: list[str] = []
    for key, item in value.items():
        if key == "text_run" and isinstance(item, dict):
            parts.append(str(item.get("content", "")))
        elif isinstance(item, str) and (key in {"caption", "alt", "alt_text", "description", "title", "text"} or (key == "content" and parent in {"equation", "text", "caption"})):
            parts.append(item)
        elif isinstance(item, (dict, list)) and key not in {"text_element_style", "style", "link"}:
            parts.extend(_visible_text(item, key))
    return parts


def _raw_text(value: Any) -> str:
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (ValueError, TypeError):
            return value
        return _raw_text(decoded) if isinstance(decoded, (dict, list)) else value
    if isinstance(value, list):
        return "\n".join(_raw_text(item) for item in value)
    if isinstance(value, dict):
        if value.get("structuredContent"):
            return _raw_text(value["structuredContent"])
        if isinstance(value.get("data"), dict):
            return _raw_text(value["data"])
        if "content" in value:
            return _raw_text(value["content"])
        if isinstance(value.get("text"), str):
            return _raw_text(value["text"])
    return ""


def review_text_records(document: dict, items: list[dict], raw_content: Any) -> list[dict[str, str]]:
    records = [{"location": "document.title", "text": str(document.get("title", ""))}]
    for index, block in enumerate(items):
        text = "".join(_visible_text(block))
        if text:
            records.append({"location": str(block.get("block_id") or f"block_list.items[{index}]"), "text": text})
    raw = _raw_text(raw_content)
    if raw:
        records.append({"location": "raw_content", "text": raw})
    return records


def review_text_fingerprint(document: dict, items: list[dict], raw_content: Any) -> str:
    data = json.dumps(review_text_records(document, items, raw_content), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def review_document_token(document: dict, items: list[dict]) -> str:
    return str(document.get("token") or document.get("document_id") or next((item.get("block_id") for item in items if item.get("block_type") == 1), ""))


def audit_disclaimer_review(document: dict, items: list[dict], raw_content: Any, review: Any) -> dict:
    errors: list[dict] = []
    blocked: list[dict] = []
    info: list[str] = []
    fingerprint = review_text_fingerprint(document, items, raw_content)
    records = review_text_records(document, items, raw_content)
    seen: set[tuple[str, str]] = set()

    def error(location: str, actual: Any, reason: str) -> None:
        key = (location, str(actual))
        if key not in seen:
            seen.add(key)
            errors.append({"code": "DISCLAIMER_TEXT", "location": location, "actual": str(actual), "expected": f"删除免责表述，按来源保留直接事实或调查结论；{reason}"})

    def block(code: str, actual: Any, expected: str) -> None:
        blocked.append({"code": code, "location": "review_context.disclaimer_review", "actual": str(actual), "expected": expected})

    for record in records:
        for finding in scan_disclaimers(record["text"]):
            error(record["location"], finding["excerpt"], finding["reason"])
    # Split sentences in adjacent blocks cannot evade the deterministic check.
    block_records = [record for record in records if record["location"] not in {"document.title", "raw_content"}]
    joined = "\n".join(record["text"] for record in block_records)
    for finding in scan_disclaimers(joined):
        if not any(finding["reason"] in item["expected"] for item in errors):
            error("document.full_text", finding["excerpt"], finding["reason"])

    if not _raw_text(raw_content).strip():
        block("DISCLAIMER_RAW_CONTENT", "missing or empty", "完整 raw content 与全量区块一起参与全文审阅")

    if not isinstance(review, dict):
        block("DISCLAIMER_REVIEW_REQUIRED", "missing", "实际完成当前全文语义审阅并记录 disclaimer_review；关键词未命中不能自动 PASS")
    else:
        findings = review.get("findings")
        if isinstance(findings, list):
            for finding in findings:
                if isinstance(finding, dict):
                    error(str(finding.get("location") or "document"), finding.get("excerpt", finding), str(finding.get("reason") or "semantic disclaimer"))
                else:
                    error("document", finding, "semantic disclaimer")
        else:
            block("DISCLAIMER_REVIEW_FINDINGS", findings, "findings 数组；发现任何形式免责即 FAIL")
        if review.get("status") == "FAIL" and not findings:
            error("document", "semantic review FAIL", "全文语义审阅发现免责")
        elif review.get("status") not in {"PASS", "FAIL"}:
            block("DISCLAIMER_REVIEW_STATUS", review.get("status"), "完成全文语义审阅后的 PASS 或 FAIL")
        required = {
            "policy_version": DISCLAIMER_POLICY_VERSION,
            "scope": "full_document",
            "token": review_document_token(document, items),
            "revision_id": document.get("revision_id"),
            "text_sha256": fingerprint,
        }
        for key, expected in required.items():
            if expected is None or expected == "" or review.get(key) != expected:
                block("DISCLAIMER_REVIEW_BINDING", {key: review.get(key)}, f"{key}={expected!r} for the current complete document")
        if not isinstance(review.get("reviewer_id"), str) or not review["reviewer_id"].strip():
            block("DISCLAIMER_REVIEW_REVIEWER", review.get("reviewer_id"), "non-empty reviewer_id")
        try:
            timestamp = datetime.fromisoformat(str(review.get("checked_at", "")).replace("Z", "+00:00"))
            if timestamp.utcoffset() is None:
                raise ValueError("timezone required")
        except ValueError:
            block("DISCLAIMER_REVIEW_TIME", review.get("checked_at"), "ISO-8601 checked_at with timezone")
    if not errors and not blocked:
        info.append("DISCLAIMER_REVIEW_PASS: known-form scan and current whole-document semantic review passed")
    return {"errors": errors, "blocked": blocked, "info": info, "text_sha256": fingerprint, "policy_version": DISCLAIMER_POLICY_VERSION}


def self_test() -> int:
    bad = [
        "公众号“原创”标记也不证明发布者是家属、继承人或作品版权方。",
        "即便标注原创，也不足以认定运营者为亲属或权利人。",
        "卖家持有或出售原作，不等于持有或授出作品著作权。",
        "图片来源：孔网；展示不代表已获授权。",
        "本报告仅供参考，不承担任何责任。",
        "未找到版权方，不能据此认为没有版权风险，使用前请自行核实。",
        "This report is for reference only and does not constitute legal advice.",
        "公众号原创标记不\u200b证\u200b明版权归属。",
    ]
    clean = ["未找到版权方。", "账号归属尚未确认。", "页面未展示作者或继承人许可。", "许可证禁止商业使用。", "出版社确认2018年出版该书。"]
    # 图注的泛化变体由语义审阅兜底，不宣称词表穷尽所有形式。
    for sentence in bad:
        if not scan_disclaimers(sentence):
            raise AssertionError(f"missed known disclaimer: {sentence}")
    for sentence in clean:
        if scan_disclaimers(sentence):
            raise AssertionError(f"rejected direct finding: {sentence}")
    print(f"DISCLAIMER_GATE_SELF_TEST: PASS cases={len(bad) + len(clean)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
