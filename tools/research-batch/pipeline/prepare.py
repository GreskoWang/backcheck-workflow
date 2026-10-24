#!/usr/bin/env python3
"""Versioned local continuation after research collection; preparation is never review."""
from __future__ import annotations

import argparse
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Callable
from uuid import uuid4

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "media"))
import export_manifest
import fetch_assets
import media

_spec = importlib.util.spec_from_file_location("research_batch_coverage", ROOT / "coverage" / "validate.py")
coverage = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(coverage)


class PipelineError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class Cancelled(Exception):
    pass


def stamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def encoded(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def read_json(file: Path):
    return json.loads(file.read_text(encoding="utf-8-sig"))


def safe_reason(value) -> str:
    known = coverage.GOOD_STOPS | coverage.BAD_STOPS | {"verification_required", "login_required",
            "target_changed", "cache_limit", "worker_initialization_error"}
    return value if isinstance(value, str) and value in known else "unrecognized_stop_reason"


def atomic_json(file: Path, value: object) -> None:
    temporary = file.with_name(f".{file.name}.{os.getpid()}.{uuid4().hex}.tmp")
    # The temporary name is longer than the final artifact. On Windows it may
    # cross MAX_PATH even when the destination directory and final file work.
    def io_path(value: Path) -> str:
        absolute = str(value.absolute())
        if os.name != "nt" or absolute.startswith("\\\\?\\"):
            return absolute
        return "\\\\?\\UNC\\" + absolute[2:] if absolute.startswith("\\\\") else "\\\\?\\" + absolute
    with open(io_path(temporary), "xb") as handle:
        handle.write(encoded(value))
        handle.flush()
        os.fsync(handle.fileno())
    for attempt in range(8):
        try:
            os.replace(io_path(temporary), io_path(file))
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(0.02 * (attempt + 1))


def ensure_immutable(file: Path, content: bytes) -> None:
    if file.exists():
        if not file.is_file() or file.read_bytes() != content:
            raise PipelineError("artifact_conflict", "Existing preparation output differs; preserve it and use a fresh output directory")
        return
    with file.open("xb") as handle:
        handle.write(content)


@contextmanager
def processor_lock(directory: Path):
    """An OS lock releases on crash; never delete a PID-based stale lock."""
    file = directory / "processor.lock"
    handle = file.open("a+b")
    locked = False
    try:
        if file.stat().st_size == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError as exc:
            raise PipelineError("processor_busy", "Another processor owns this preparation directory") from exc
        yield
    finally:
        if locked:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


class Events:
    def __init__(self, directory: Path, callback=None):
        self.file = directory / "events.ndjson"
        self.ids = set()
        self.callback = callback
        if self.file.exists():
            for line in self.file.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                    self.ids.add(row["event_id"])
                except (ValueError, KeyError, TypeError) as exc:
                    raise PipelineError("events_journal_invalid", "Event journal is incomplete or invalid; preserve it for recovery") from exc

    def emit(self, revision: str, kind: str, *, key=None, **details) -> None:
        event_id = f"{revision}:{key or kind}"
        if event_id in self.ids:
            return
        row = {"schema_version": 1, "event_id": event_id, "revision": revision,
               "event": kind, "at": stamp(), "review_status": "not_reviewed",
               "surface_completion": False, **details}
        with self.file.open("ab") as handle:
            handle.write(json.dumps(row, ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        self.ids.add(event_id)
        if self.callback:
            self.callback(row)


EXECUTION_KEYS = ("owner", "thread", "thread_id", "threadId", "task_id", "taskId", "requestId", "request_id")


def detail_result(data: dict) -> bool:
    return (data.get("adapter") == "research-detail-v1" or data.get("scope", {}).get("kind") == "single_post_detail" or
            str(data.get("job", {}).get("id", "")).startswith("detail:"))


def execution_context(data: dict) -> dict:
    job = data.get("job", {})
    keys = EXECUTION_KEYS + (("target",) if detail_result(data) else ())
    return {"top": {key: data.get(key) for key in keys}, "job": {key: job.get(key) for key in keys}}


def detail_context_bound(data: dict) -> bool:
    if not detail_result(data):
        return True  # A normal batch's UUID job.id is already unique.
    context = execution_context(data)
    valid = lambda value: isinstance(value, str) and bool(value.strip())
    owner = any(valid(part.get("owner")) for part in context.values())
    target = any(valid(part.get("target")) for part in context.values())
    explicit = any(valid(part.get(key)) for part in context.values() for key in ("task_id", "taskId", "requestId", "request_id"))
    return (owner and target) or explicit


def source_fingerprint(data: dict, max_chars: int) -> str:
    # One task-level revision, no per-post evidence hashes. Volatile timestamps
    # and previously attached review declarations do not create new revisions.
    job = data.get("job", {})
    identity = {key: job.get(key) for key in ("id", "recipe", "target_url", "state", "reason", "requestId", "request_id")}
    subject = data.get("subject", {})
    request_identity = {key: data.get(key) for key in ("requestId", "request_id", "subject_id")}
    request_identity["expected_subject"] = subject.get("expected") if isinstance(subject, dict) else None
    selected = {"schema_version": data.get("schema_version"), "job": identity,
                "items": data.get("items"), "scope": data.get("scope", {}),
                "coverage": data.get("coverage", {}), "conclusion": data.get("conclusion", "incomplete"),
                "max_chars": max_chars, "preparation_contract": 3, "request_identity": request_identity,
                "execution_context": execution_context(data)}
    return hashlib.sha256(json.dumps(selected, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def revision_for(directory: Path, data: dict, source: Path, max_chars: int) -> tuple[Path, dict]:
    fingerprint = source_fingerprint(data, max_chars)
    revisions = directory / "revisions"
    revisions.mkdir(exist_ok=True)
    folders = sorted(p for p in revisions.iterdir() if p.is_dir())
    for folder in folders:
        meta_file = folder / "meta.json"
        if meta_file.exists():
            meta = read_json(meta_file)
            bound_meta = (not detail_result(data) or
                          (meta.get("preparation_contract", 0) >= 3 and
                           meta.get("execution_context") == execution_context(data) and meta.get("cache_reuse_allowed") is True))
            if meta.get("source_fingerprint") == fingerprint and detail_context_bound(data) and bound_meta:
                return folder, meta
    number = max([int(p.name.split("-", 2)[1]) for p in folders if p.name.startswith("rev-") and p.name.split("-", 2)[1].isdigit()] or [0]) + 1
    folder = revisions / f"rev-{number:04d}-{fingerprint[:12]}"
    folder.mkdir()
    meta = {"schema_version": 1, "revision": folder.name, "source_fingerprint": fingerprint,
            "source_file": str(source), "created_at": stamp(), "max_chars": max_chars,
            "review_status": "not_reviewed", "surface_completion": False,
            "preparation_contract": 3, "execution_context": execution_context(data),
            "cache_reuse_allowed": detail_context_bound(data)}
    ensure_immutable(folder / "source-result.json", encoded(data))
    ensure_immutable(folder / "meta.json", encoded(meta))
    return folder, meta


def same_task(previous: dict, current: dict) -> bool:
    old_job, new_job = previous.get("job", {}), current.get("job", {})
    if not isinstance(old_job.get("id"), str) or not old_job["id"]:
        return False
    keys = ("id", "recipe", "target_url", "requestId", "request_id")
    old_subject, new_subject = previous.get("subject", {}), current.get("subject", {})
    expected_old = old_subject.get("expected") if isinstance(old_subject, dict) else None
    expected_new = new_subject.get("expected") if isinstance(new_subject, dict) else None
    return (all(old_job.get(key) == new_job.get(key) for key in keys) and
            all(previous.get(key) == current.get(key) for key in ("requestId", "request_id", "subject_id")) and
            expected_old == expected_new and
            detail_context_bound(previous) and detail_context_bound(current) and
            execution_context(previous) == execution_context(current) and
            previous.get("scope", {}) == current.get("scope", {}))


def spans_cover(ranges: list[tuple[int, int]], length: int) -> bool:
    cursor = 0
    for start, end in sorted(ranges):
        if start > cursor:
            return False
        cursor = max(cursor, end)
    return cursor >= length


def confirmed_unchanged_fields(folder: Path, data: dict) -> dict:
    """Reuse declarations backed by complete old ranges, never infer new reading."""
    current = {item["source_id"]: item for item in data["items"]}
    fields = tuple(coverage.TEXT_FIELDS)
    needed = sum(isinstance(item.get(field), str) and bool(item[field]) for item in data["items"] for field in fields)
    confirmed = {}
    for baseline in sorted(folder.parent.iterdir(), reverse=True):
        if baseline == folder or not baseline.is_dir():
            continue
        source_file, review_file = baseline / "source-result.json", baseline / "text" / "review.json"
        if not source_file.is_file() or not review_file.is_file():
            continue
        try:
            old, review = read_json(source_file), read_json(review_file)
            if not same_task(old, data):
                continue
            if review.get("unread_ranges"):
                # A newer explicit unread declaration blocks fallback to older
                # positives. Only fields actually re-confirmed in still newer
                # applicable revisions may survive this barrier.
                return confirmed
            if review.get("text_snapshot_digest") != coverage.text_snapshot_digest(old["items"]):
                continue
            if detail_result(old):
                old_meta = read_json(baseline / "meta.json")
                if old_meta.get("preparation_contract", 0) < 3 or old_meta.get("execution_context") != execution_context(old):
                    continue  # Historical detail caches were not guaranteed to bind owner/thread/target.
            old_items = {item["source_id"]: item for item in old["items"]}
            ranges, provenance = {}, {}
            for batch in review.get("text_batches", []):
                reviewer = batch.get("reviewer", review.get("reviewer"))
                if (batch.get("reviewed") is not True or batch.get("output_truncated") is True or
                    not isinstance(reviewer, str) or not reviewer.strip() or reviewer.strip().casefold() in {"collector", "auto", "automatic"}):
                    continue
                if not isinstance(batch.get("batch_id"), str) or not re.fullmatch(r"(?:text|reused)-[0-9]{4,}", batch["batch_id"]):
                    continue
                segments = batch.get("segments")
                if not isinstance(segments, list):
                    continue
                valid = True
                for seg in segments:
                    sid, field = seg.get("source_id"), seg.get("field")
                    value = old_items.get(sid, {}).get(field, "") if isinstance(sid, str) and isinstance(field, str) else ""
                    start, end = seg.get("start"), seg.get("end")
                    if not (sid in old_items and field in fields and isinstance(value, str) and
                            type(start) is int and type(end) is int and 0 <= start < end <= len(value)):
                        valid = False
                        break
                if not valid:
                    continue
                # A normal exported file must still agree with its source mapping.
                # Already-reused declarations have provenance rather than a new file.
                batch_file = baseline / "text" / f"{batch.get('batch_id', '')}.txt"
                if not batch.get("reused_from"):
                    if not batch_file.is_file() or batch_file.read_text(encoding="utf-8") != render_segments(segments, old_items):
                        continue
                for seg in segments:
                    key = (seg["source_id"], seg["field"])
                    ranges.setdefault(key, []).append((seg["start"], seg["end"]))
                    provenance.setdefault(key, []).append({"batch_id": batch.get("batch_id"), "reviewer": reviewer,
                                                           "start": seg["start"], "end": seg["end"]})
            for sid, old_item in old_items.items():
                new_item = current.get(sid)
                if not new_item or any(old_item.get(key) != new_item.get(key) for key in ("source_id", "post_url", "account", "account_id")):
                    continue
                for field in fields:
                    key = (sid, field)
                    value = old_item.get(field, "")
                    if (key not in confirmed and isinstance(value, str) and value and value == new_item.get(field, "") and
                            spans_cover(ranges.get(key, []), len(value))):
                        confirmed[key] = {"revision": baseline.name, "source_digest": review["text_snapshot_digest"],
                                          "ranges": provenance[key]}
            if len(confirmed) >= needed:
                break
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue  # Invalid or incomplete old declarations never become new confirmations.
    return confirmed


def render_segments(segments: list[dict], items: dict) -> str:
    parts = []
    for seg in segments:
        sid, field, start, end = seg["source_id"], seg["field"], seg["start"], seg["end"]
        value = items[sid].get(field, "")
        if field not in coverage.TEXT_FIELDS or type(start) is not int or type(end) is not int or not 0 <= start < end <= len(value):
            raise PipelineError("text_mapping_invalid", "Existing text mapping is invalid")
        parts.append(f"\n[{sid} {field} {start}:{end}]\n" + value[start:end])
    return "".join(parts)


def reading_plan(folder: Path, data: dict, max_chars: int) -> dict:
    reused = confirmed_unchanged_fields(folder, data)
    unread_items = [{**item, **{field: "" for field in coverage.TEXT_FIELDS if (item["source_id"], field) in reused}}
                    for item in data["items"]]
    batches = coverage.make_text_batches(unread_items, max_chars)
    for batch in batches:
        batch.pop("content")
    count = len(batches)
    current = {item["source_id"]: item for item in data["items"]}
    for index, ((sid, field), source) in enumerate(reused.items(), 1):
        reviewers = sorted({entry["reviewer"] for entry in source["ranges"]})
        batches.append({"batch_id": f"reused-{index:04d}", "reviewed": True, "reviewer": "; ".join(reviewers),
                        "segments": [{"source_id": sid, "field": field, "start": 0, "end": len(current[sid][field])}],
                        "reused_from": source})
    return {"text_snapshot_digest": coverage.text_snapshot_digest(data["items"]), "text_batches": batches,
            "media_reviews": [], "comment_reviews": [], "unread_ranges": [],
            "exported_batch_ids": [batch["batch_id"] for batch in batches[:count]],
            "reused_field_count": len(reused)}


def export_text(folder: Path, data: dict, max_chars: int, check: Callable) -> dict:
    final = folder / "text"
    if final.exists():
        if not (final / "prepared.json").is_file() or not (final / "review.json").is_file():
            raise PipelineError("text_output_incomplete", "Existing text output is incomplete; it is preserved")
        report = read_json(final / "prepared.json")
        expected_file = final / "plan.json"
        if expected_file.exists():
            plan = read_json(expected_file)
            expected = [batch for batch in plan["text_batches"] if batch["batch_id"] in plan["exported_batch_ids"]]
        else:
            expected = coverage.make_text_batches(data["items"], max_chars)
        if (report.get("text_snapshot_digest") != coverage.text_snapshot_digest(data["items"]) or
                report.get("max_chars") != max_chars or report.get("text_batch_count") != len(expected)):
            raise PipelineError("text_snapshot_conflict", "Existing text metadata does not match this revision")
        for batch in expected:
            check()
            file = final / f"{batch['batch_id']}.txt"
            body = batch.get("content")
            body = body if body is not None else render_segments(batch["segments"], {i["source_id"]: i for i in data["items"]})
            if not file.is_file() or file.read_bytes() != body.encode("utf-8"):
                raise PipelineError("text_artifact_conflict", "An existing text batch changed or disappeared; preserve its review confirmations")
        # review.json may already contain real reader confirmations; never rewrite it.
        return report
    pending = folder / "text.pending"
    pending.mkdir(exist_ok=True)
    plan_file = pending / "plan.json"
    manifest = read_json(plan_file) if plan_file.exists() else reading_plan(folder, data, max_chars)
    ensure_immutable(plan_file, encoded(manifest))
    count = len(manifest["exported_batch_ids"])
    by_id = {item["source_id"]: item for item in data["items"]}
    for batch in manifest["text_batches"]:
        if batch["batch_id"] not in manifest["exported_batch_ids"]:
            continue
        check()
        ensure_immutable(pending / f"{batch['batch_id']}.txt", render_segments(batch["segments"], by_id).encode("utf-8"))
    ensure_immutable(pending / "review.json", encoded(manifest))
    report = {"text_batch_count": count, "max_chars": max_chars, "review_status": "not_reviewed",
              "surface_completion": False, "text_snapshot_digest": manifest["text_snapshot_digest"],
              "reused_field_count": manifest["reused_field_count"]}
    ensure_immutable(pending / "prepared.json", encoded(report))
    check()
    if final.exists():
        raise PipelineError("text_output_conflict", "Text destination already exists; nothing is overwritten")
    pending.rename(final)
    return report


class CancelTransport:
    def __init__(self, underlying, cancelled):
        self.underlying = underlying
        self.cancelled = cancelled

    def fetch(self, url, **kwargs):
        if self.cancelled():
            error = fetch_assets.AssetError("pipeline_cancelled", "Preparation cancelled before starting this request")
            error.redirect_chain = []
            error.request_count = 0
            raise error
        return self.underlying.fetch(url, **kwargs)


def sheet_arguments() -> argparse.Namespace:
    return argparse.Namespace(command="sheet", cols=4, rows=4, cell_width=360,
                              cell_height=260, font_size=16, font=None)


def prepare_result(source: Path, output: Path, *, max_chars: int = 6000, fetch_public: bool = False,
                   resume: bool = False, retry_media: bool = False, concurrency: int = 3,
                   timeout: float = 20, transport=None, render_fn=None, on_event=None,
                   cancelled: Callable[[], bool] | None = None, _lock_held: bool = False) -> dict:
    source = media.local_path(str(source), Path.cwd())
    output = media.local_path(str(output), Path.cwd())
    if type(max_chars) is not int or not 128 <= max_chars <= 45000:
        raise PipelineError("max_chars_invalid", "max-chars must be an integer in 128..45000")
    if retry_media and not fetch_public:
        raise PipelineError("retry_requires_fetch", "retry-media requires explicit fetch-public")
    if not 1 <= concurrency <= 3 or not 0 < timeout <= 120:
        raise PipelineError("media_budget_invalid", "concurrency must be 1..3 and timeout must be 0..120 seconds")
    output.mkdir(parents=True, exist_ok=True)
    with (nullcontext() if _lock_held else processor_lock(output)):
        events = Events(output, on_event)
        control = output / "control.json"
        if resume:
            atomic_json(control, {"cancel": False, "at": stamp()})
        def is_cancelled():
            return (bool(cancelled and cancelled()) or
                    (control.exists() and read_json(control).get("cancel") is True))
        def check():
            if is_cancelled():
                raise Cancelled()
        current_phase = "source"
        state = {"schema_version": 1, "status": "preparing", "source_file": str(source),
                 "review_status": "not_reviewed", "coverage_complete": False,
                 "surface_completion": False, "started_at": stamp(), "stages": {}}
        revision = "source-error"
        folder = None
        def save():
            state["updated_at"] = stamp()
            atomic_json(output / "state.json", state)
            if folder:
                atomic_json(folder / "preparation-state.json", state)
        try:
            check()
            data = read_json(source)
            if not isinstance(data, dict):
                raise PipelineError("source_invalid", "Source must be a research result object")
            assessment = coverage.validate_batch(data, {})
            if not assessment["format_valid"]:
                raise PipelineError("source_format_invalid", "Source schema is invalid; original cache is preserved")
            if data.get("job", {}).get("state") in {"created", "starting", "running"}:
                raise PipelineError("collection_running", "Collection is still running; consume its terminal result instead")
            folder, meta = revision_for(output, data, source, max_chars)
            revision = folder.name
            previous = folder / "preparation-state.json"
            if previous.exists():
                state = read_json(previous)
                state.pop("error", None)
                state.pop("reason", None)
                state.pop("phase", None)
                state["status"] = "preparing"
            state.update(revision=revision, revision_directory=str(folder), max_chars=max_chars)
            save()
            reading_only = {"unread_text", "unread_media", "unread_comments", "unsupported_no_issue"}
            collected = (data.get("coverage", {}).get("collection_complete") is True and
                         not any(issue["code"] not in reading_only for issue in assessment["issues"]))
            events.emit(revision, "collected" if collected else "needs_review", key="source_received",
                        phase="collection", collection_complete=collected,
                        item_count=len(data["items"]), reason=safe_reason(data.get("coverage", {}).get("stop_reason")))
            check()
            current_phase = "text"
            text_report = export_text(folder, data, max_chars, check)
            state["stages"]["text"] = {"status": "ready", "directory": str(folder / "text"), **text_report}
            save()
            events.emit(revision, "text_ready", phase="text", batch_count=text_report["text_batch_count"],
                        directory=str(folder / "text"))
            check()
            current_phase = "media_manifest"
            manifest_file = folder / "media-manifest.json"
            try:
                if manifest_file.exists():
                    manifest = read_json(manifest_file)
                else:
                    manifest = export_manifest.export_result(data)
                    ensure_immutable(manifest_file, encoded(manifest))
                report = manifest["export_report"]
                state["stages"]["media_manifest"] = {"status": "ready", "file": str(manifest_file), **report}
                save()
                events.emit(revision, "media_manifest_ready", phase="media_manifest",
                            item_count=report["exported_item_count"], failure_slots=report["failed_placeholder_count"])
            except (media.ManifestError, OSError, ValueError, KeyError) as exc:
                state["stages"]["media_manifest"] = {"status": "error", "error_type": type(exc).__name__}
                events.emit(revision, "error", key="media_manifest_error", phase=current_phase,
                            code="media_manifest_failed", error_type=type(exc).__name__)
                manifest = None
            check()
            current_phase = "media"
            if manifest is None:
                state["stages"]["media"] = {"status": "error", "reason": "media_manifest_failed"}
            elif not manifest["items"]:
                filtered = manifest["export_report"].get("filtered_count", 0)
                state["stages"]["media"] = {"status": "needs_review" if filtered else "not_applicable",
                                            "reason": "unsupported_media_filtered" if filtered else "no_media_items",
                                            "filtered_count": filtered}
                events.emit(revision, "needs_review" if filtered else "media_ready", key="media_empty",
                            phase="media", status=state["stages"]["media"]["status"], item_count=0,
                            filtered_count=filtered)
            elif not fetch_public and manifest["export_report"].get("ready_image_count") == 0:
                state["stages"]["media"] = {"status": "needs_review", "reason": "no_downloadable_public_images",
                                            "failure_slots": len(manifest["items"])}
                events.emit(revision, "needs_review", key="media_sources_unavailable", phase="media",
                            reason="no_downloadable_public_images", failure_slots=len(manifest["items"]))
            elif fetch_public:
                attempts = state.setdefault("media_attempts", [])
                prior = attempts[-1] if attempts else None
                requested_retry = bool(retry_media and prior and prior.get("status") in {"error", "partial"})
                if prior and prior.get("finished") and not requested_retry:
                    state["stages"]["media"] = prior
                else:
                    if not prior or prior.get("finished"):
                        attempt = {"attempt": len(attempts) + 1, "status": "preparing", "finished": False}
                        if prior and prior.get("failed_stage") == "sheet" and Path(prior["assets"]).is_dir():
                            attempt["reuse_assets"] = prior["assets"]
                        attempts.append(attempt)
                    else:
                        attempt = prior
                    number = attempt["attempt"]
                    assets = Path(attempt["reuse_assets"]) if attempt.get("reuse_assets") else folder / f"assets-{number:04d}"
                    sheets = folder / f"sheets-{number:04d}"
                    attempt.update(assets=str(assets), sheets=str(sheets))
                    save()
                    media_phase = "download"
                    try:
                        if assets.exists():
                            download_report = read_json(assets / "summary.json")
                        else:
                            download_report = fetch_assets.download_batch(manifest_file, assets,
                                concurrency=concurrency, timeout=timeout,
                                transport=CancelTransport(transport or fetch_assets.UrllibTransport(), is_cancelled))
                        attempt["download"] = download_report
                        save()
                        check()
                        media_phase = "sheet"
                        if sheets.exists():
                            sheet_report = read_json(sheets / "summary.json")
                        else:
                            sheet_report = (render_fn or media.create_batch)(assets / "local-manifest.json", sheets, sheet_arguments())
                        attempt.update(sheet=sheet_report, status="ready" if sheet_report["failed_count"] == 0 else "partial", finished=True)
                        state["stages"]["media"] = attempt
                        save()
                        events.emit(revision, "media_ready", key=f"media_ready:{number}", phase="media",
                                    status=attempt["status"], sheets=str(sheets), page_count=sheet_report["page_count"],
                                    failed_count=sheet_report["failed_count"])
                    except Cancelled:
                        raise
                    except Exception as exc:
                        attempt.update(status="error", finished=True, error_type=type(exc).__name__, failed_stage=media_phase)
                        state["stages"]["media"] = attempt
                        events.emit(revision, "error", key=f"media_error:{number}", phase=current_phase,
                                    code="media_preparation_failed", error_type=type(exc).__name__)
            elif state["stages"].get("media", {}).get("status") not in {"ready", "partial", "error"}:
                state["stages"]["media"] = {"status": "pending_public_fetch", "item_count": len(manifest["items"])}
                events.emit(revision, "media_pending", phase="media", reason="public_fetch_not_requested",
                            item_count=len(manifest["items"]))
            check()
            current_phase = "coverage"
            ensure_immutable(folder / "initial-coverage.json", encoded(assessment))
            state["stages"]["coverage"] = {"status": "needs_review", "file": str(folder / "initial-coverage.json"),
                                           "issue_count": len(assessment["issues"])}
            state["status"] = "prepared"
            state["review_status"] = "not_reviewed"
            state["coverage_complete"] = False
            state["surface_completion"] = False
            state["next_action"] = {"kind": "model_review_required", "text_directory": str(folder / "text"),
                "review_file": str(folder / "text" / "review.json"),
                "media_status": state["stages"]["media"]["status"],
                "unread_text_batch_count": text_report["text_batch_count"],
                "reused_text_field_count": text_report.get("reused_field_count", 0),
                "requirements": (["read_unread_text_batches"] if text_report["text_batch_count"] else []) +
                                ["review_in_scope_media", "verify_risk_sources"] +
                                ([] if collected else ["resolve_collection_gaps"]),
                "automatic_review": False, "automatic_feishu_write": False}
            save()
            events.emit(revision, "needs_review", key="review_ready", phase="review",
                        text_directory=str(folder / "text"), media_status=state["stages"]["media"]["status"],
                        collection_complete=collected, issue_count=len(assessment["issues"]),
                        next_action=state["next_action"])
            return state
        except Cancelled:
            state.update(status="paused", reason="cancelled", phase=current_phase)
            save()
            events.emit(revision, "cancelled", key=f"cancelled:{state['updated_at']}", phase=current_phase)
            return state
        except Exception as exc:
            code = exc.code if isinstance(exc, PipelineError) else "preparation_failed"
            state.update(status="error", phase=current_phase, error={"code": code, "type": type(exc).__name__})
            save()
            events.emit(revision, "error", key=f"error:{state['updated_at']}", phase=current_phase,
                        code=code, error_type=type(exc).__name__)
            return state


def watch_job(job_directory: Path, output: Path, *, max_wait: float = 1800, poll_interval: float = 0.5,
              on_event=None, cancelled=None, **prepare_options) -> dict:
    """Watch local files only; emit once on new stages, never poll the browser."""
    if not 0 < max_wait <= 14400 or not 0.05 <= poll_interval <= 5:
        raise PipelineError("watch_budget_invalid", "max-wait must be 0..14400 seconds and poll-interval 0.05..5")
    job_directory = media.local_path(str(job_directory), Path.cwd())
    output = media.local_path(str(output), Path.cwd())
    if not job_directory.is_dir():
        raise PipelineError("job_directory_missing", "Collection job directory does not exist")
    output.mkdir(parents=True, exist_ok=True)
    with processor_lock(output):
        events = Events(output, on_event)
        if prepare_options.pop("resume", False):
            atomic_json(output / "control.json", {"cancel": False, "at": stamp()})
        started = time.monotonic()
        deadline = started + max_wait
        watch_id = "watch-" + uuid4().hex
        waiting = {"schema_version": 1, "status": "waiting", "job_directory": str(job_directory),
                   "max_wait": max_wait, "review_status": "not_reviewed", "coverage_complete": False,
                   "surface_completion": False, "next_action": {"kind": "wait_for_local_collection"}, "started_at": stamp()}
        atomic_json(output / "state.json", waiting)
        events.emit(watch_id, "waiting_for_collection", phase="watch", max_wait=max_wait)
        terminal_since = None
        terminal_key = None
        bound_job_id = None
        while True:
            control = output / "control.json"
            try:
                stopped = bool(cancelled and cancelled()) or (control.exists() and read_json(control).get("cancel") is True)
            except (OSError, ValueError, AttributeError):
                waiting.update(status="error", reason="control_invalid", updated_at=stamp())
                atomic_json(output / "state.json", waiting)
                events.emit(watch_id, "error", phase="watch", code="control_invalid")
                return waiting
            if stopped or time.monotonic() >= deadline:
                waiting.update(status="paused" if stopped else "error", reason="cancelled" if stopped else "watch_timeout",
                               next_action={"kind": "resume_local_watch_or_inspect_collection"}, updated_at=stamp())
                atomic_json(output / "state.json", waiting)
                events.emit(watch_id, "cancelled" if stopped else "error", phase="watch", code=waiting["reason"])
                return waiting
            job_file, result_file = job_directory / "job.json", job_directory / "result.json"
            try:
                job = read_json(job_file) if job_file.exists() else None
            except (OSError, ValueError):
                job = None  # A concurrent atomic checkpoint is retried within the bounded watch.
            if isinstance(job, dict) and isinstance(job.get("id"), str) and job["id"]:
                if bound_job_id is None:
                    bound_job_id = job["id"]
                elif bound_job_id != job["id"]:
                    waiting.update(status="error", reason="job_identity_changed", updated_at=stamp(),
                                   next_action={"kind": "inspect_collection_checkpoint"})
                    atomic_json(output / "state.json", waiting)
                    events.emit(watch_id, "error", phase="watch", code="job_identity_changed")
                    return waiting
            if isinstance(job, dict) and job.get("state") in {"collected", "needs_review", "paused", "failed"}:
                current_key = (job.get("id"), job.get("state"), job.get("iterations"))
                if current_key != terminal_key:
                    terminal_key, terminal_since = current_key, time.monotonic()
                try:
                    result = read_json(result_file) if result_file.exists() else None
                except (OSError, ValueError):
                    result = None
                identity = result.get("job", {}) if isinstance(result, dict) else {}
                identity = identity if isinstance(identity, dict) else {}
                same_checkpoint = (bound_job_id is not None and identity.get("id") == job.get("id") and identity.get("state") == job.get("state") and
                                   identity.get("iterations") == job.get("iterations"))
                if same_checkpoint and isinstance(result, dict) and isinstance(result.get("items"), list):
                    events.emit(watch_id, "collection_terminal", phase="watch", state=job["state"],
                                reason=safe_reason(job.get("stop_reason")))
                    return prepare_result(result_file, output, on_event=on_event, cancelled=cancelled,
                                          _lock_held=True, **prepare_options)
                if time.monotonic() - terminal_since >= min(3, max_wait):
                    waiting.update(status="error", reason="terminal_result_missing_or_stale",
                                   next_action={"kind": "inspect_collection_checkpoint"}, updated_at=stamp())
                    atomic_json(output / "state.json", waiting)
                    events.emit(watch_id, "error", phase="watch", code=waiting["reason"])
                    return waiting
            time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))


def cancel(output: Path) -> dict:
    output = media.local_path(str(output), Path.cwd())
    if not output.is_dir():
        raise PipelineError("output_missing", "Preparation directory does not exist")
    control = {"cancel": True, "at": stamp()}
    atomic_json(output / "control.json", control)
    return {"status": "cancel_requested", "surface_completion": False}


def exit_code(state: dict) -> int:
    if state["status"] == "error":
        return 1
    if state["status"] == "paused":
        return 3
    stage = state.get("stages", {}).get("media", {})
    return 2 if stage.get("status") in {"error", "partial", "pending_public_fetch", "needs_review"} else 0


def receipt(state: dict) -> dict:
    return {key: state[key] for key in ("status", "revision", "revision_directory", "review_status",
            "coverage_complete", "surface_completion", "next_action", "reason", "error") if key in state} | {
            "stages": {key: value.get("status") for key, value in state.get("stages", {}).items()}}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "watch"):
        prepare = sub.add_parser(name)
        prepare.add_argument("result" if name == "prepare" else "job_directory", type=Path)
        prepare.add_argument("--out", type=Path, required=True)
        prepare.add_argument("--max-chars", type=int, default=6000)
        prepare.add_argument("--fetch-public", action="store_true")
        prepare.add_argument("--resume", action="store_true")
        prepare.add_argument("--retry-media", action="store_true")
        prepare.add_argument("--concurrency", type=int, default=3)
        prepare.add_argument("--timeout", type=float, default=20)
        if name == "watch":
            prepare.add_argument("--max-wait", type=float, default=1800)
            prepare.add_argument("--poll-interval", type=float, default=0.5)
    for command in ("status", "cancel"):
        child = sub.add_parser(command)
        child.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "cancel":
            result = cancel(args.out)
        elif args.command == "status":
            result = read_json(media.local_path(str(args.out), Path.cwd()) / "state.json")
        else:
            kwargs = dict(max_chars=args.max_chars, fetch_public=args.fetch_public, resume=args.resume,
                          retry_media=args.retry_media, concurrency=args.concurrency, timeout=args.timeout)
            if args.command == "watch":
                result = watch_job(args.job_directory, args.out, max_wait=args.max_wait, poll_interval=args.poll_interval,
                    on_event=lambda event: print(json.dumps(event, ensure_ascii=False), flush=True), **kwargs)
            else:
                result = prepare_result(args.result, args.out, **kwargs)
    except (PipelineError, media.ManifestError, OSError, ValueError) as exc:
        print(json.dumps({"status": "error", "code": getattr(exc, "code", "preparation_unavailable"),
                          "error_type": type(exc).__name__, "surface_completion": False}, ensure_ascii=False))
        return 1
    print(json.dumps(receipt(result) if args.command in {"prepare", "watch"} else result,
                     ensure_ascii=False, allow_nan=False), flush=True)
    return exit_code(result) if args.command in {"prepare", "watch"} else 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
