"""Traceable review/endpoint checks; these validate records, not human honesty.

No function creates an attestation for real evidence. JSON can prove consistent
hashes, scope and locators, but cannot prove that a person or agent actually read
the cited content or correctly interpreted it.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


CONTENT_FIELDS = (
    "platform_key", "item_id", "url",
    "item_kind", "content_type", "author", "published_at", "title", "text", "media_kinds",
    "video_metadata", "media", "attachments", "subject_interactions",
)
REVIEW_MODES = {"agent_context", "human_context", "user_manual"}
VIDEO_TRIAGE_RESULTS = {"clear", "suspected_risk", "risk_signal"}
VIDEO_TRIAGE_FIELDS = {
    "title_reviewed", "cover_reviewed", "description_reviewed", "result", "reason",
    "risk_terms_sha256", "detail_source_ref",
}
TARGETED_SELECTION_BASES = {
    "pinned", "latest", "popular_top10", "historical_sample", "user_risk_lead",
    "risk_hit", "suspected_signal", "subject_reply", "risk_interaction_chain",
    "hot_comment_top20", "search_scope",
}
TARGETED_VIDEO_REVIEW_FIELDS = {
    "mode", "title_reviewed", "cover_reviewed", "description_reviewed",
    "rapid_scrub_reviewed", "full_timeline_reviewed", "max_interval_seconds",
    "semantic_segment_reviewed", "full_audio_reviewed", "hit_timestamps_seconds",
}
TERMINAL_KINDS = {"content_end", "empty_surface", "absent_surface", "empty_query"}
RAW_CAPTURE_KINDS = {"api_response", "browser_snapshot", "authorized_export_manifest"}
END_MARKER_RE = re.compile(
    r"(?:没有更多内容了~去其他页面看看吧|没有更多(?:(?:相关)?(?:作品|内容|动态|视频|结果|数据))?(?:了)?|"
    r"暂无(?:相关|公开)?(?:作品|内容|动态|视频|结果)|没有(?:相关|公开)?(?:作品|内容|动态|视频|结果)|"
    r"到底了|已到底|no (?:more(?: (?:results|posts|content|videos|items|data))?|results|posts|content|videos)(?: (?:yet|found))?|"
    r"end of (?:results|posts|content|videos|list)|all caught up)[。.!！…\s]*", re.I,
)


def _targeted_url_implies_video(platform_key: Any, value: Any) -> bool:
    """Recognize URL shapes that are unambiguously video surfaces."""
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    key = str(platform_key or "")
    if key == "youtube":
        return (
            host.endswith("youtu.be") and bool(path.strip("/"))
        ) or path.startswith(("/shorts/", "/live/", "/embed/")) or (
            path == "/watch" and bool(parse_qs(parsed.query).get("v"))
        )
    if key == "bilibili":
        return host.endswith("b23.tv") or path.startswith("/video/")
    if key == "douyin":
        return path.startswith("/video/")
    if key == "weibo":
        return path.startswith("/tv/show/")
    if key == "netease_music":
        lowered = value.lower()
        return "/mv?" in lowered or "/video?" in lowered or "#/mv?" in lowered or "#/video?" in lowered
    if key == "facebook":
        return path.startswith(("/reel/", "/watch/")) or "/videos/" in path
    if key == "instagram":
        return path.startswith(("/reel/", "/tv/"))
    return False


def content_sha256(row: dict[str, Any]) -> str:
    """Hash content/identity fields, never a risk decision or a review flag."""
    content = {key: row[key] for key in CONTENT_FIELDS if key in row}
    return hashlib.sha256(json.dumps(
        content, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")).hexdigest()


def _time(value: Any, prefix: str, errors: list[str]) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("timezone missing")
        return parsed
    except (ValueError, TypeError):
        errors.append(f"{prefix}: must be a timezone-bearing timestamp")
        return None


def _pointer(data: Any, pointer: str) -> Any:
    if pointer == "":
        return data
    if not pointer.startswith("/"):
        raise ValueError("JSON pointer must start with /")
    for part in pointer.split("/")[1:]:
        key = part.replace("~1", "/").replace("~0", "~")
        data = data[int(key)] if isinstance(data, list) else data[key]
    return data


def _source(ref: Any, root: Path, prefix: str, errors: list[str]) -> tuple[Any, Any]:
    """Read an exact raw location. Return (located value, complete JSON object)."""
    if not isinstance(ref, dict) or set(ref) != {"path", "sha256", "locator"}:
        errors.append(f"{prefix}: requires exactly path, sha256 and locator")
        return None, None
    path = Path(str(ref.get("path", "")))
    try:
        if not path.is_absolute() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("source must remain under evidence root")
        if not path.is_file():
            raise ValueError("source file missing")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != ref.get("sha256"):
            raise ValueError("source sha256 does not match file")
        text = raw.decode("utf-8-sig")
        locator = ref.get("locator")
        if not isinstance(locator, str):
            raise ValueError("locator must be text")
        if locator.startswith("json:"):
            data = json.loads(text)
            return _pointer(data, locator[5:]), data
        if match := re.fullmatch(r"jsonl:([1-9][0-9]*)(/.*)?", locator):
            data = json.loads(text.splitlines()[int(match[1]) - 1])
            return _pointer(data, match[2] or ""), data
        if match := re.fullmatch(r"text:([1-9][0-9]*)(?:-([1-9][0-9]*))?", locator):
            start, end = int(match[1]), int(match[2] or match[1])
            lines = text.splitlines()
            if end < start or end > len(lines):
                raise ValueError("text locator outside source")
            return "\n".join(lines[start - 1:end]), None
        raise ValueError("locator must be json:/pointer, jsonl:line/pointer or text:start-end")
    except (OSError, ValueError, KeyError, IndexError, TypeError, UnicodeError) as exc:
        errors.append(f"{prefix}: {exc}")
        return None, None


def validate_item_review(
    row: dict[str, Any],
    *,
    root: Path,
    prefix: str,
    errors: list[str],
    require_video_triage: bool = False,
) -> None:
    proof = row.get("review_evidence")
    if not isinstance(proof, dict):
        errors.append(f"{prefix}.review_evidence: missing traceable item review; flags or keyword non-hits are not proof")
        return
    required = {
        "content_sha256", "decision", "context_reason", "reviewer", "review_mode", "reviewed_at",
        "evidence_refs",
    }
    if require_video_triage:
        required.add("video_triage")
    if set(proof) != required:
        errors.append(f"{prefix}.review_evidence: requires exactly {', '.join(sorted(required))}")
    if proof.get("content_sha256") != content_sha256(row):
        errors.append(f"{prefix}.review_evidence.content_sha256: differs from item content")
    if proof.get("decision") != row.get("risk_decision"):
        errors.append(f"{prefix}.review_evidence.decision: must match the item decision")
    for key in ("context_reason", "reviewer"):
        if not isinstance(proof.get(key), str) or not proof[key].strip():
            errors.append(f"{prefix}.review_evidence.{key}: must identify the review and item context")
    if proof.get("review_mode") not in REVIEW_MODES:
        errors.append(f"{prefix}.review_evidence.review_mode: requires agent_context, human_context or user_manual; automated screening is not review")
    _time(proof.get("reviewed_at"), f"{prefix}.review_evidence.reviewed_at", errors)
    refs = proof.get("evidence_refs")
    if not isinstance(refs, list) or not refs:
        errors.append(f"{prefix}.review_evidence.evidence_refs: must cite actual source locations")
        return
    triage = proof.get("video_triage")
    detail_ref: Any = None
    if require_video_triage:
        if not isinstance(triage, dict):
            errors.append(f"{prefix}.review_evidence.video_triage: video item requires an exact triage object")
        else:
            if set(triage) != VIDEO_TRIAGE_FIELDS:
                errors.append(
                    f"{prefix}.review_evidence.video_triage: requires exactly "
                    f"{', '.join(sorted(VIDEO_TRIAGE_FIELDS))}"
                )
            for field in ("title_reviewed", "cover_reviewed", "description_reviewed"):
                if triage.get(field) is not True:
                    errors.append(f"{prefix}.review_evidence.video_triage.{field}: must be true")
            if triage.get("result") not in VIDEO_TRIAGE_RESULTS:
                errors.append(
                    f"{prefix}.review_evidence.video_triage.result: must be clear, suspected_risk or risk_signal"
                )
            if not isinstance(triage.get("reason"), str) or not triage["reason"].strip():
                errors.append(f"{prefix}.review_evidence.video_triage.reason: must be item-specific non-empty text")
            risk_hash = triage.get("risk_terms_sha256")
            if not isinstance(risk_hash, str) or re.fullmatch(r"[0-9a-f]{64}", risk_hash) is None:
                errors.append(
                    f"{prefix}.review_evidence.video_triage.risk_terms_sha256: must be lowercase SHA-256"
                )
            detail_ref = triage.get("detail_source_ref")
            if not isinstance(detail_ref, dict) or set(detail_ref) != {"path", "sha256", "locator"}:
                errors.append(
                    f"{prefix}.review_evidence.video_triage.detail_source_ref: "
                    "requires exactly path, sha256 and locator"
                )
            elif detail_ref not in refs:
                errors.append(
                    f"{prefix}.review_evidence.video_triage.detail_source_ref: "
                    "must also appear in evidence_refs"
                )
    content_bound = False
    detail_bound = False
    for index, ref in enumerate(refs):
        located, _ = _source(ref, root, f"{prefix}.review_evidence.evidence_refs[{index}]", errors)
        if located is None or located == "" or located == {} or located == []:
            errors.append(f"{prefix}.review_evidence.evidence_refs[{index}]: cited review content is empty")
        if isinstance(located, dict):
            if "review_evidence" in located:
                errors.append(f"{prefix}.review_evidence.evidence_refs[{index}]: reviewed ledger cannot prove itself; cite the pre-review content capture")
            elif content_sha256(located) == content_sha256(row):
                content_bound = True
                if require_video_triage and ref == detail_ref:
                    metadata = located.get("video_metadata")
                    if (
                        located.get("url") == row.get("url")
                        and isinstance(metadata, dict)
                        and metadata.get("detail_url") == row.get("url")
                        and metadata.get("detail_capture_kind") == "video_detail_page"
                    ):
                        detail_bound = True
    if not content_bound:
        errors.append(f"{prefix}.review_evidence.evidence_refs: at least one locator must bind the same complete normalized item content, not an unrelated nonempty source")
    if require_video_triage and not detail_bound:
        errors.append(
            f"{prefix}.review_evidence.video_triage.detail_source_ref: must bind the same complete "
            "pre-review video-detail item and direct video URL"
        )


def validate_completion_proof(route: dict[str, Any], log: dict[str, Any], *, platform_key: str | None,
                              root: Path, prefix: str, errors: list[str]) -> None:
    if route.get("status") != "complete":
        return
    proof = log.get("completion_evidence")
    if not isinstance(proof, dict):
        errors.append(f"{prefix}.completion_evidence: missing raw endpoint proof; page arrival or an existing file is not completion")
        return
    required = {"kind", "platform_key", "surface", "url", "discovered_items", "observed_at",
                "source_ref", "scope_locator", "signal", "marker"}
    if set(proof) != required:
        errors.append(f"{prefix}.completion_evidence: requires exactly {', '.join(sorted(required))}")
    count = route.get("discovered_items")
    kind = proof.get("kind")
    if kind not in TERMINAL_KINDS or (count == 0) == (kind == "content_end"):
        errors.append(f"{prefix}.completion_evidence.kind: must describe a real endpoint matching the item count, not page_arrival or risk_sample")
    is_query = route.get("module_key") in {"keyword_search", "baidu_search", "google_search"} or route.get("surface") == "account_discovery"
    if count == 0 and ((is_query and kind != "empty_query") or (not is_query and kind == "empty_query")):
        errors.append(f"{prefix}.completion_evidence.kind: empty query and homepage surface evidence are not interchangeable")
    expected = {"platform_key": platform_key or proof.get("platform_key"), "surface": route.get("surface"),
                "url": route.get("resolved_url") or route.get("account_or_query_url")}
    for field, value in expected.items():
        if proof.get(field) != value:
            errors.append(f"{prefix}.completion_evidence.{field}: must match this route's scope")
    if proof.get("discovered_items") != count:
        errors.append(f"{prefix}.completion_evidence.discovered_items: must match the actual route ledger count")
    observed = _time(proof.get("observed_at"), f"{prefix}.completion_evidence.observed_at", errors)
    started = _time(route.get("started_at"), f"{prefix}.started_at", errors)
    completed = _time(route.get("completed_at"), f"{prefix}.completed_at", errors)
    if observed and started and completed and not started <= observed <= completed:
        errors.append(f"{prefix}.completion_evidence.observed_at: must fall inside this route's capture interval")
    ref = proof.get("source_ref")
    raw_entries = log.get("raw_evidence", [])
    registered = next((entry for entry in raw_entries if isinstance(entry, dict) and isinstance(ref, dict)
                       and entry.get("path") == ref.get("path") and entry.get("sha256") == ref.get("sha256")), None)
    if not registered or registered.get("kind") not in RAW_CAPTURE_KINDS:
        errors.append(f"{prefix}.completion_evidence.source_ref: must cite a registered raw API/browser/export capture, not a status summary or risk sample")
    located, source = _source(ref, root, f"{prefix}.completion_evidence.source_ref", errors)
    try:
        scope = _pointer(source, str(proof.get("scope_locator", "")))
        if not isinstance(scope, dict) or any(scope.get(key) != value for key, value in expected.items()):
            raise ValueError("captured scope must contain the same platform_key, surface and url")
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        errors.append(f"{prefix}.completion_evidence.scope_locator: {exc}")
    signal, marker = proof.get("signal"), proof.get("marker")
    terminal_field = str(ref.get("locator", "") if isinstance(ref, dict) else "").rsplit("/", 1)[-1]
    supported = (
        (signal == "empty_array" and terminal_field in {"items", "list", "results", "cards", "statuses", "videos", "archives"}
         and isinstance(located, list) and not located and kind != "absent_surface")
        or (signal == "has_more_false" and terminal_field in {"has_more", "hasMore", "has_next", "hasNext", "has_next_page", "hasNextPage"}
            and located is False and kind != "absent_surface")
        or (signal == "surface_absent" and terminal_field in {"surface_present", "surfacePresent", "surface_exists", "surfaceExists"}
            and located is False and kind == "absent_surface")
        or (signal == "explicit_end_marker" and isinstance(located, str) and isinstance(marker, str)
            and terminal_field in {"end_marker", "endMarker", "end_text", "endText", "terminal_text", "empty_state_text"}
            and bool(END_MARKER_RE.fullmatch(marker.strip())) and marker.strip() == located.strip() and kind != "absent_surface")
    )
    if not supported:
        errors.append(f"{prefix}.completion_evidence.signal: raw locator does not demonstrate the claimed endpoint")
    if signal != "explicit_end_marker" and marker is not None:
        errors.append(f"{prefix}.completion_evidence.marker: must be null except for an explicit visible end marker")


def validate_targeted_item_review(
    row: dict[str, Any],
    *,
    prefix: str,
    valid_group_ids: set[str],
    errors: list[str],
) -> None:
    """Validate one item intentionally selected into the three-hour review set.

    Unlike the exhaustive-audit proof, this check deliberately does not demand a
    raw-content locator or a per-item content hash.  The containing selected-item
    ledger is hash-bound at route level.  Unselected search/homepage results do not
    get synthetic rows merely to satisfy the validator.
    """
    required = {
        "platform_key", "item_id", "url", "content_type", "title", "text",
        "review_status", "risk_decision", "risk_group_id", "review_reason",
        "selection_basis", "attribution",
    }
    missing = sorted(required - set(row))
    if missing:
        errors.append(f"{prefix}: missing targeted review fields: {', '.join(missing)}")
    for field in ("platform_key", "item_id", "url", "content_type", "review_reason"):
        if not isinstance(row.get(field), str) or not row[field].strip():
            errors.append(f"{prefix}.{field}: must be non-empty text")
    for field in ("title", "text"):
        if not isinstance(row.get(field), str):
            errors.append(f"{prefix}.{field}: must be text")
    if row.get("review_status") != "reviewed":
        errors.append(f"{prefix}.review_status: selected item must equal reviewed")
    if row.get("attribution") not in {
        "subject_original", "subject_reply", "third_party_comment", "subject_interaction",
        "external_source", "uncertain_identity",
    }:
        errors.append(f"{prefix}.attribution: invalid controlled attribution")
    decision = row.get("risk_decision")
    if decision not in {"risk", "no_risk", "false_positive", "out_of_scope"}:
        errors.append(f"{prefix}.risk_decision: invalid targeted decision")
    group_id = row.get("risk_group_id")
    if decision == "risk":
        if group_id not in valid_group_ids:
            errors.append(f"{prefix}.risk_group_id: risk item must reference a real risk group")
    elif group_id not in {"", None}:
        errors.append(f"{prefix}.risk_group_id: non-risk item must be empty")
    bases = row.get("selection_basis")
    if not isinstance(bases, list) or not bases or any(base not in TARGETED_SELECTION_BASES for base in bases):
        errors.append(
            f"{prefix}.selection_basis: must be a non-empty unique list of controlled targeted reasons"
        )
        bases = []
    elif len(bases) != len(set(bases)):
        errors.append(f"{prefix}.selection_basis: values must be unique")

    media_kinds = row.get("media_kinds") if isinstance(row.get("media_kinds"), list) else []
    is_video = str(row.get("content_type", "")).lower() in {
        "video", "video_post", "short_video", "short", "clip", "reel", "live",
        "live_video", "live_stream", "livestream", "live_replay", "live_archive",
    } or "video" in media_kinds or _targeted_url_implies_video(
        row.get("platform_key"), row.get("url")
    )
    video_review = row.get("video_review")
    if not is_video:
        if video_review is not None:
            errors.append(f"{prefix}.video_review: allowed only for video items")
        return
    if not isinstance(video_review, dict):
        errors.append(f"{prefix}.video_review: selected video requires targeted video review")
        return
    if set(video_review) != TARGETED_VIDEO_REVIEW_FIELDS:
        errors.append(
            f"{prefix}.video_review: requires exactly {', '.join(sorted(TARGETED_VIDEO_REVIEW_FIELDS))}"
        )
    for field in ("title_reviewed", "cover_reviewed", "description_reviewed", "rapid_scrub_reviewed"):
        if video_review.get(field) is not True:
            errors.append(f"{prefix}.video_review.{field}: must be true")
    if not isinstance(video_review.get("full_audio_reviewed"), bool):
        errors.append(f"{prefix}.video_review.full_audio_reviewed: must be boolean")
    hit_times = video_review.get("hit_timestamps_seconds")
    if not isinstance(hit_times, list) or any(
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
        for value in hit_times
    ):
        errors.append(f"{prefix}.video_review.hit_timestamps_seconds: must be non-negative numbers")
        hit_times = []
    elif len(hit_times) != len(set(hit_times)):
        errors.append(f"{prefix}.video_review.hit_timestamps_seconds: values must be unique")

    signal_based = (
        decision in {"risk", "false_positive"}
        or "risk_hit" in bases
        or "suspected_signal" in bases
    )
    timeline_required = signal_based or "user_risk_lead" in bases
    if timeline_required:
        if video_review.get("mode") != "targeted_10s_timeline":
            errors.append(f"{prefix}.video_review.mode: risk/lead/suspected video requires targeted_10s_timeline")
        if video_review.get("full_timeline_reviewed") is not True:
            errors.append(f"{prefix}.video_review.full_timeline_reviewed: detailed video must be true")
        interval = video_review.get("max_interval_seconds")
        if (
            isinstance(interval, bool)
            or not isinstance(interval, (int, float))
            or not math.isfinite(interval)
            or not 0 < interval <= 10
        ):
            errors.append(f"{prefix}.video_review.max_interval_seconds: detailed video must be within 10 seconds")
        if signal_based:
            if video_review.get("semantic_segment_reviewed") is not True:
                errors.append(f"{prefix}.video_review.semantic_segment_reviewed: signal-bearing video must be true")
            if not hit_times:
                errors.append(f"{prefix}.video_review.hit_timestamps_seconds: signal-bearing video requires a hit timestamp")
        elif video_review.get("semantic_segment_reviewed") is not False or hit_times:
            errors.append(
                f"{prefix}.video_review: user-led video with no signal must not fabricate a hit or semantic segment"
            )
    else:
        if video_review.get("mode") != "metadata_and_rapid_scrub":
            errors.append(f"{prefix}.video_review.mode: ordinary selected video uses metadata_and_rapid_scrub")
        if video_review.get("full_timeline_reviewed") is not False:
            errors.append(f"{prefix}.video_review.full_timeline_reviewed: ordinary video must be false")
        if video_review.get("max_interval_seconds") is not None:
            errors.append(f"{prefix}.video_review.max_interval_seconds: ordinary video must be null")
        if video_review.get("semantic_segment_reviewed") is not False:
            errors.append(f"{prefix}.video_review.semantic_segment_reviewed: ordinary video must be false")
        if hit_times:
            errors.append(f"{prefix}.video_review.hit_timestamps_seconds: ordinary clear video must be empty")
