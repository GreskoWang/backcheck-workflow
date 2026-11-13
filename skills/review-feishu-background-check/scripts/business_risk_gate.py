#!/usr/bin/env python3
"""Revision-bound business-risk review gate shared by Feishu validators."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


BUSINESS_RISK_SCOPE = "current_business_risk_policy_and_full_document"
CURRENT_BUSINESS_RISK_POLICY = (Path(os.environ["BACKGROUND_CHECK_WORKSPACE"]) / "背调风险提示.md")
RESULT_LEVELS = {"建议谨慎评估", "建议评估", "无合作风险"}
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
    "page",
)


def _finding(code: str, location: str, actual: Any, expected: str) -> dict[str, str]:
    return {"code": code, "location": location, "actual": str(actual), "expected": expected}


def _path_key(path: Path) -> str:
    return os.path.normcase(os.path.abspath(str(path)))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _block_text(block: dict[str, Any]) -> str:
    for key in TEXT_KEYS:
        value = block.get(key)
        if not isinstance(value, dict) or not isinstance(value.get("elements"), list):
            continue
        chunks: list[str] = []
        for element in value["elements"]:
            if not isinstance(element, dict):
                continue
            run = element.get("text_run")
            if isinstance(run, dict):
                chunks.append(str(run.get("content", "")))
            mention_doc = element.get("mention_doc")
            if isinstance(mention_doc, dict):
                chunks.append(str(mention_doc.get("title", "")))
            mention_user = element.get("mention_user")
            if isinstance(mention_user, dict):
                chunks.append(str(mention_user.get("user_id", "")))
        return "".join(chunks)
    return ""


def policy_source(path: Path = CURRENT_BUSINESS_RISK_POLICY) -> dict[str, str]:
    """Return a current content-bound policy source record."""

    resolved = path.resolve()
    return {"path": str(resolved), "sha256": _sha256(resolved)}


def block_location(block: dict[str, Any]) -> dict[str, str]:
    """Return the exact block binding required by a confirmed-hit record."""

    return {"block_id": str(block.get("block_id", "")), "text": _block_text(block)}


def audit_business_risk_review(
    *,
    review: Any,
    items: list[dict[str, Any]],
    document_token: str,
    revision_id: Any,
    reviewer_id: Any,
    expected_group_indices: Iterable[int] | None,
    allowed_scopes: Iterable[str] = (BUSINESS_RISK_SCOPE,),
    required_policy_path: Path = CURRENT_BUSINESS_RISK_POLICY,
    allowed_policy_paths: Iterable[Path] | None = None,
) -> dict[str, Any]:
    """Validate that a manual business-policy comparison is current and inspectable.

    The gate cannot invent the semantic comparison.  It fails closed unless the
    reviewer binds every claimed hit to the current policy bytes and to exact
    current document blocks for the summary, platform fact and result level.
    """

    errors: list[dict[str, str]] = []
    blocked: list[dict[str, str]] = []
    info: list[str] = []
    expected_group_indices = set(expected_group_indices) if expected_group_indices is not None else None
    if not isinstance(review, dict):
        blocked.append(
            _finding(
                "BUSINESS_RISK_REVIEW",
                "review_context.business_risk_review",
                type(review).__name__,
                "revision-bound PASS/FAIL/BLOCKED manual comparison against the current business risk policy",
            )
        )
        return {
            "verdict": "BLOCKED",
            "errors": errors,
            "blocked": blocked,
            "info": info,
            "record_sha256": None,
            "confirmed_hits": 0,
        }

    # The same discovery closure gate is used by chat and Feishu delivery.
    # Missing/broken dependencies must not let a document-format PASS hide it.
    consolidation = review.get("consolidation")
    if isinstance(consolidation, dict):
        consolidation_policy = consolidation.get("policy")
        policy_sources_for_consolidation = review.get("policy_sources")
        if (not isinstance(consolidation_policy, dict)
                or not isinstance(policy_sources_for_consolidation, list)
                or not any(isinstance(source, dict)
                    and source.get("path") == consolidation_policy.get("path")
                    and source.get("sha256") == consolidation_policy.get("sha256")
                    for source in policy_sources_for_consolidation)):
            errors.append(_finding("DISCOVERY_CONSOLIDATION_POLICY", "business_risk_review.consolidation.policy",
                consolidation_policy, "same actual current policy source as the business-risk review"))
    try:
        gate_path = Path(__file__).resolve().parents[2] / "background-check-research" / "scripts" / "discovery_gate.py"
        spec = importlib.util.spec_from_file_location("_backcheck_discovery_gate", gate_path)
        if spec is None or spec.loader is None:
            raise ImportError(str(gate_path))
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)
        hits_for_discovery = review.get("confirmed_hits")
        discovery = gate.audit_discovery_review(
            review.get("discovery_review"),
            reported_facts=[h.get("verified_fact") for h in hits_for_discovery if isinstance(h, dict)]
            if isinstance(hits_for_discovery, list) else None,
            consolidation=review.get("consolidation"),
        )
        errors.extend(discovery["errors"])
        blocked.extend(discovery["blocked"])
        info.extend(discovery["info"])
    except Exception as exc:
        blocked.append(_finding("DISCOVERY_GATE_UNAVAILABLE", "business_risk_review.discovery_review", str(exc), "working shared discovery gate"))

    record_sha256 = hashlib.sha256(
        json.dumps(review, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    status = review.get("status")
    conflicts = review.get("conflicts")
    if not isinstance(conflicts, list):
        blocked.append(
            _finding(
                "BUSINESS_RISK_CONFLICTS_SCHEMA",
                "review_context.business_risk_review.conflicts",
                type(conflicts).__name__,
                "array, empty only when the comparison found no conflict",
            )
        )
        conflicts = []
    if status == "FAIL" or conflicts:
        errors.append(
            _finding(
                "BUSINESS_RISK_CONFLICT",
                "review_context.business_risk_review",
                conflicts if conflicts else status,
                "no verified business-risk hit omitted, excluded, or downgraded by assistant moral or value judgment",
            )
        )
    elif status != "PASS":
        blocked.append(
            _finding(
                "BUSINESS_RISK_REVIEW_STATUS",
                "review_context.business_risk_review.status",
                status,
                "PASS after actual comparison, or FAIL with conflicts; pending or incomplete review cannot pass",
            )
        )

    allowed_scope_set = set(allowed_scopes)
    if status == "PASS" and review.get("scope") not in allowed_scope_set:
        blocked.append(
            _finding(
                "BUSINESS_RISK_SCOPE",
                "review_context.business_risk_review.scope",
                review.get("scope"),
                f"one of {sorted(allowed_scope_set)}",
            )
        )
    if status == "PASS" and review.get("token") != document_token:
        blocked.append(
            _finding(
                "BUSINESS_RISK_TOKEN",
                "review_context.business_risk_review.token",
                review.get("token"),
                f"exact target token {document_token}",
            )
        )
    if status == "PASS" and review.get("revision_id") != revision_id:
        blocked.append(
            _finding(
                "BUSINESS_RISK_REVISION",
                "review_context.business_risk_review.revision_id",
                review.get("revision_id"),
                f"exact latest revision {revision_id}",
            )
        )

    if status == "PASS" and review.get("reviewer_id") != reviewer_id:
        blocked.append(
            _finding(
                "BUSINESS_RISK_REVIEWER",
                "review_context.business_risk_review.reviewer_id",
                review.get("reviewer_id"),
                f"current reviewer_id {reviewer_id}",
            )
        )
    if status == "PASS":
        checked_at = review.get("checked_at")
        try:
            checked = datetime.fromisoformat(str(checked_at).replace("Z", "+00:00"))
            valid_checked_at = checked.tzinfo is not None
        except ValueError:
            valid_checked_at = False
        if not valid_checked_at:
            blocked.append(
                _finding(
                    "BUSINESS_RISK_TIME",
                    "review_context.business_risk_review.checked_at",
                    checked_at,
                    "ISO-8601 timestamp with timezone after the actual policy-to-document comparison",
                )
            )

    policy_texts: list[str] = []
    policy_sources = review.get("policy_sources")
    required_key = _path_key(required_policy_path)
    allowed_policy_keys = {
        _path_key(path)
        for path in (allowed_policy_paths if allowed_policy_paths is not None else (required_policy_path,))
    }
    allowed_policy_keys.add(required_key)
    seen_required_policy = False
    if status == "PASS":
        if not isinstance(policy_sources, list) or not policy_sources:
            blocked.append(
                _finding(
                    "BUSINESS_RISK_POLICY_SOURCES",
                    "review_context.business_risk_review.policy_sources",
                    policy_sources,
                    "non-empty array of {path, sha256} records including the current business risk table",
                )
            )
            policy_sources = []
        for index, source in enumerate(policy_sources):
            location = f"review_context.business_risk_review.policy_sources[{index}]"
            if not isinstance(source, dict) or not isinstance(source.get("path"), str) or not isinstance(source.get("sha256"), str):
                blocked.append(
                    _finding(
                        "BUSINESS_RISK_POLICY_SOURCE_SCHEMA",
                        location,
                        source,
                        "object with absolute path and current lowercase SHA-256",
                    )
                )
                continue
            source_path = Path(source["path"])
            if not source_path.is_absolute() or not source_path.is_file():
                errors.append(
                    _finding(
                        "BUSINESS_RISK_POLICY_SOURCE_INVALID",
                        location,
                        source["path"],
                        "an existing absolute policy file actually read for this review",
                    )
                )
                continue
            source_key = _path_key(source_path)
            if source_key not in allowed_policy_keys:
                errors.append(
                    _finding(
                        "BUSINESS_RISK_POLICY_SOURCE_UNEXPECTED",
                        location,
                        source["path"],
                        "an explicitly allowed current business-risk policy source",
                    )
                )
                continue
            current_hash = _sha256(source_path)
            if source["sha256"] != current_hash:
                blocked.append(
                    _finding(
                        "BUSINESS_RISK_POLICY_SOURCE_CHANGED",
                        location,
                        source["sha256"],
                        f"current SHA-256 {current_hash}; re-read the changed policy before review",
                    )
                )
                continue
            if source_key == required_key:
                seen_required_policy = True
            try:
                policy_text = source_path.read_text(encoding="utf-8")
            except (OSError, UnicodeError) as exc:
                blocked.append(
                    _finding(
                        "BUSINESS_RISK_POLICY_SOURCE_UNREADABLE",
                        location,
                        exc,
                        "UTF-8 policy text readable during the current review",
                    )
                )
                continue
            entries = source.get("entries")
            if entries is not None:
                if not isinstance(entries, list) or not entries or not all(isinstance(value, str) and value.strip() for value in entries):
                    blocked.append(
                        _finding(
                            "BUSINESS_RISK_POLICY_ENTRIES_SCHEMA",
                            f"{location}.entries",
                            entries,
                            "non-empty string array when entries is supplied",
                        )
                    )
                else:
                    for entry_index, entry in enumerate(entries):
                        if entry not in policy_text:
                            errors.append(
                                _finding(
                                    "BUSINESS_RISK_POLICY_ENTRY_MISSING",
                                    f"{location}.entries[{entry_index}]",
                                    entry,
                                    "literal entry present in the bound current policy file",
                                )
                            )
            policy_texts.append(policy_text)
        if not seen_required_policy:
            blocked.append(
                _finding(
                    "BUSINESS_RISK_CURRENT_POLICY_REQUIRED",
                    "review_context.business_risk_review.policy_sources",
                    policy_sources,
                    f"current content-bound source for {required_policy_path}",
                )
            )

    by_id = {
        str(block.get("block_id")): block
        for block in items
        if isinstance(block, dict) and block.get("block_id")
    }
    confirmed_hits = review.get("confirmed_hits")
    confirmed_group_indices: set[int] = set()
    confirmed_hits_count = 0
    required_hit_keys = {
        "business_item",
        "verified_fact",
        "risk_group_index",
        "summary_location",
        "platform_location",
        "result_level",
        "result_location",
    }
    if status == "PASS":
        if not isinstance(confirmed_hits, list):
            blocked.append(
                _finding(
                    "BUSINESS_RISK_HITS_SCHEMA",
                    "review_context.business_risk_review.confirmed_hits",
                    type(confirmed_hits).__name__,
                    "array of every verified business-risk hit, empty only when the current policy comparison found none",
                )
            )
            confirmed_hits = []
        confirmed_hits_count = len(confirmed_hits)

        def validate_location(value: Any, field_location: str) -> tuple[dict[str, Any] | None, str | None]:
            if not isinstance(value, dict) or set(value) != {"block_id", "text"}:
                blocked.append(
                    _finding(
                        "BUSINESS_RISK_LOCATION_SCHEMA",
                        field_location,
                        value,
                        "exact {block_id, text} binding to a current document block",
                    )
                )
                return None, None
            block_id = value.get("block_id")
            expected_text = value.get("text")
            if not isinstance(block_id, str) or not block_id or not isinstance(expected_text, str) or not expected_text:
                blocked.append(
                    _finding(
                        "BUSINESS_RISK_LOCATION_SCHEMA",
                        field_location,
                        value,
                        "non-empty block_id and exact non-empty text",
                    )
                )
                return None, None
            block = by_id.get(block_id)
            if block is None:
                errors.append(
                    _finding(
                        "BUSINESS_RISK_LOCATION_NOT_FOUND",
                        field_location,
                        block_id,
                        "block id present in the current complete document snapshot",
                    )
                )
                return None, None
            actual_text = _block_text(block)
            if actual_text != expected_text:
                errors.append(
                    _finding(
                        "BUSINESS_RISK_LOCATION_TEXT",
                        field_location,
                        actual_text,
                        f"exact current text {expected_text!r}",
                    )
                )
                return block, actual_text
            return block, actual_text

        all_policy_text = "\n".join(policy_texts)
        for index, hit in enumerate(confirmed_hits):
            hit_location = f"review_context.business_risk_review.confirmed_hits[{index}]"
            if not isinstance(hit, dict) or not required_hit_keys.issubset(hit):
                blocked.append(
                    _finding(
                        "BUSINESS_RISK_HIT_SCHEMA",
                        hit_location,
                        hit,
                        f"object with {sorted(required_hit_keys)}",
                    )
                )
                continue
            for key in ("business_item", "verified_fact", "result_level"):
                if not isinstance(hit.get(key), str) or not hit[key].strip():
                    blocked.append(
                        _finding(
                            "BUSINESS_RISK_HIT_SCHEMA",
                            f"{hit_location}.{key}",
                            hit.get(key),
                            "non-empty string",
                        )
                    )
            group_index = hit.get("risk_group_index")
            if not isinstance(group_index, int):
                blocked.append(
                    _finding(
                        "BUSINESS_RISK_GROUP_INDEX",
                        f"{hit_location}.risk_group_index",
                        group_index,
                        "integer pointing to the matching top risk group",
                    )
                )
            else:
                confirmed_group_indices.add(group_index)

            business_item = hit.get("business_item")
            # A changed/unreadable source is already BLOCKED; do not turn that
            # freshness problem into a false semantic FAIL merely because no
            # current policy text was available for the membership check.
            if policy_texts and isinstance(business_item, str) and business_item.strip() and business_item not in all_policy_text:
                errors.append(
                    _finding(
                        "BUSINESS_RISK_ITEM_NOT_IN_POLICY",
                        f"{hit_location}.business_item",
                        business_item,
                        "literal item present in a current content-bound policy source",
                    )
                )
            _, summary_text = validate_location(hit.get("summary_location"), f"{hit_location}.summary_location")
            _, platform_text = validate_location(hit.get("platform_location"), f"{hit_location}.platform_location")
            _, result_text = validate_location(hit.get("result_location"), f"{hit_location}.result_location")
            verified_fact = hit.get("verified_fact")
            if platform_text is not None and isinstance(verified_fact, str) and verified_fact != platform_text:
                errors.append(
                    _finding(
                        "BUSINESS_RISK_FACT_BINDING",
                        f"{hit_location}.verified_fact",
                        verified_fact,
                        f"exact current platform fact text {platform_text!r}",
                    )
                )
            result_level = hit.get("result_level")
            allowed_results = RESULT_LEVELS - {"无合作风险"} if expected_group_indices else RESULT_LEVELS
            if isinstance(result_level, str) and result_level not in allowed_results:
                errors.append(
                    _finding(
                        "BUSINESS_RISK_RESULT_LEVEL",
                        f"{hit_location}.result_level",
                        result_level,
                        f"one of {sorted(allowed_results)}",
                    )
                )
            if result_text is not None and isinstance(result_level, str):
                expected_result_text = f"背调结果：{result_level}"
                if result_text != expected_result_text:
                    errors.append(
                        _finding(
                            "BUSINESS_RISK_RESULT_BINDING",
                            f"{hit_location}.result_location",
                            result_text,
                            expected_result_text,
                        )
                    )
            if summary_text is not None and isinstance(business_item, str) and not summary_text.strip():
                blocked.append(
                    _finding(
                        "BUSINESS_RISK_SUMMARY_BINDING",
                        f"{hit_location}.summary_location",
                        summary_text,
                        f"non-empty current summary text for {business_item}",
                    )
                )

        expected_indices = set(expected_group_indices) if expected_group_indices is not None else None
        if expected_indices and not confirmed_hits:
            blocked.append(
                _finding(
                    "BUSINESS_RISK_HITS_REQUIRED",
                    "review_context.business_risk_review.confirmed_hits",
                    confirmed_hits,
                    "at least one current block-bound confirmed policy hit for every risk group",
                )
            )
        if confirmed_hits and expected_indices == set():
            errors.append(
                _finding(
                    "BUSINESS_RISK_SUMMARY_MISSING",
                    "review_context.risk_groups",
                    [],
                    "top risk groups covering every confirmed business-risk hit",
                )
            )
        if expected_indices is not None and confirmed_group_indices != expected_indices:
            blocked.append(
                _finding(
                    "BUSINESS_RISK_GROUP_COVERAGE",
                    "review_context.business_risk_review.confirmed_hits[*].risk_group_index",
                    sorted(confirmed_group_indices),
                    f"cover every top risk group within {sorted(expected_indices)}",
                )
            )

    verdict = "FAIL" if errors else ("BLOCKED" if blocked else "PASS")
    if verdict == "PASS":
        info.append("BUSINESS_RISK_REVIEW_PASS: current policy bytes and exact summary/platform/result blocks are bound")
    return {
        "verdict": verdict,
        "errors": errors,
        "blocked": blocked,
        "info": info,
        "record_sha256": record_sha256,
        "confirmed_hits": confirmed_hits_count,
    }

