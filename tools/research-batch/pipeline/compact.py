"""One reading checkpoint; source text stays in its original cache.

No source copies, text exports, per-post no-issue receipts, or event journal.
Legacy preparation directories remain the responsibility of prepare.py.
"""
from __future__ import annotations

from contextlib import nullcontext
import hashlib
import json
from pathlib import Path
import time

LAYOUT = "compact-reading-v1"


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def save(api, output, state):
    file = output / "state.json"
    if not file.exists() or api.read_json(file) != state:
        api.atomic_json(file, state)


def load(api, source):
    data = api.read_json(source)
    assessment = api.coverage.validate_batch(data, {})
    if not assessment["format_valid"]:
        raise api.PipelineError("source_format_invalid", "Original cache is preserved")
    if data.get("job", {}).get("state") in {"created", "starting", "running"}:
        raise api.PipelineError("collection_running", "Wait for the existing collector")
    if not data.get("job", {}).get("id") or not api.detail_context_bound(data):
        raise api.PipelineError("source_identity_missing", "Task and subject must be bound before reading")
    job = data["job"]
    binding = digest({"job": {k: job.get(k) for k in ("id", "recipe", "target_url")},
                      "context": api.execution_context(data), "scope": data.get("scope", {}),
                      "subject": data.get("subject"), "subject_id": data.get("subject_id")})
    return data, binding, assessment


def rows(data):
    # Source metadata is bound to reading, but never copied into a second archive.
    return [{"source_id": item["source_id"], "post_url": item.get("post_url"),
             "account": item.get("account"), "date": item.get("date"),
             "field": field, "text": item.get(field, "")}
            for item in data["items"] for field in ("title", "text", "quoted_text") if item.get(field)]


def prefix(all_rows, cursor):
    index, offset = cursor
    if not (0 <= index <= len(all_rows)) or offset < 0 or (index == len(all_rows) and offset):
        raise ValueError("Reading cursor exceeds source")
    if index < len(all_rows) and offset > len(all_rows[index]["text"]):
        raise ValueError("Reading cursor exceeds text")
    selected = all_rows[:index]
    if offset:
        selected = selected + [{**all_rows[index], "text": all_rows[index]["text"][:offset]}]
    return digest(selected)


def checked_rows(api, data, state, binding):
    if state.get("layout") != LAYOUT or state["binding"] != binding:
        raise api.PipelineError("checkpoint_identity_conflict", "Keep the original task checkpoint")
    current = rows(data)
    try:
        unchanged = prefix(current, state["cursor"]) == state["prefix_digest"]
    except ValueError:
        unchanged = False
    if not unchanged:
        raise api.PipelineError("reviewed_source_changed", "Reviewed text or attribution changed; checkpoint preserved for targeted reconciliation")
    return current


def batch(current, cursor, max_chars, binding):
    index, offset = cursor
    parts, sources, size = [], [], 0
    while index < len(current) and len(sources) < 32:
        row = current[index]
        header = f"\n[{index + 1} {row['field']} offset={offset}]\n"
        capacity = max_chars - size - len(header)
        if capacity <= 0:
            break
        end = min(len(row["text"]), offset + capacity)
        parts.extend((header, row["text"][offset:end]))
        sources.append({k: v for k, v in row.items() if k != "text"} | {"start": offset, "end": end})
        size += len(header) + end - offset
        if end == len(row["text"]):
            index, offset = index + 1, 0
        else:
            offset = end
            break
    content = "".join(parts)
    next_cursor = [index, offset]
    token = digest([binding, cursor, next_cursor, sources, content, max_chars])
    return {"batch_id": "text-" + token, "text": content, "sources": sources,
            "next_cursor": next_cursor, "text_end": index == len(current), "has_text": bool(content)}


def next_action(state, current):
    text_end = state["cursor"] == [len(current), 0]
    pending_media = sum(not b.get("reviewed", False) for b in state["media_batches"])
    return {"kind": "model_review_required", "text_read_complete": text_end,
            "pending_media_batches": pending_media,
            "media_not_prepared": state.get("media_not_prepared", 0),
            "collection_gaps": state["collection_gaps"],
            "source_lookup_required_for_findings": True,
            "automatic_review": False, "automatic_feishu_write": False}


def prepare_media(api, data, output, state, *, fetch_public=False, transport=None,
                  render_fn=None, concurrency=3, timeout=20, cancelled=None, retry_media=False, resume=False):
    manifest = api.export_manifest.export_result(data)
    seen = {key for entry in state["media_batches"] for key in entry["keys"]}
    unique = {}
    for item in manifest["items"]:
        key = digest(item)
        if key not in seen:
            unique.setdefault(key, item)
    state["media_not_prepared"] = len(unique)
    if not fetch_public:
        return
    entries = list(unique.items())
    for start in range(0, len(entries), 48):
        if cancelled and cancelled():
            raise api.Cancelled()
        group = entries[start:start + 48]
        number = len(state["media_batches"]) + 1
        name = f"media-{number:04d}"
        folder = output / name
        folder.mkdir(exist_ok=True)
        file = folder / "sources.json"
        api.ensure_immutable(file, api.encoded({"schema_version": 1, "items": [item for _, item in group]}))
        entry = {"batch_id": name, "keys": [key for key, _ in group], "reviewed": False,
                 "status": "preparing", "directory": str(folder)}
        state["media_batches"].append(entry)
        state["media_not_prepared"] -= len(group)
        save(api, output, state)
    for entry in state["media_batches"]:
        retry = retry_media and entry["status"] in {"partial", "error"}
        if not (entry["status"] == "preparing" or (resume and entry["status"] == "paused") or retry):
            continue
        if cancelled and cancelled():
            raise api.Cancelled()
        folder = Path(entry["directory"])
        file = folder / "sources.json"
        if retry:
            entry["attempt"] = entry.get("attempt", 1) + 1
        suffix = "" if entry.get("attempt", 1) == 1 else "-retry-" + str(entry["attempt"])
        entry["status"] = "preparing"
        save(api, output, state)
        try:
            assets, sheets = folder / ("assets" + suffix), folder / ("sheets" + suffix)
            downloader = api.CancelTransport(transport or api.fetch_assets.UrllibTransport(), cancelled or (lambda: False))
            download = api.read_json(assets / "summary.json") if assets.exists() else api.fetch_assets.download_batch(
                file, assets, concurrency=concurrency, timeout=timeout, transport=downloader, cache_directory=output / "image-cache")
            sheet = api.read_json(sheets / "summary.json") if sheets.exists() else (render_fn or api.media.create_batch)(
                assets / "local-manifest.json", sheets, api.sheet_arguments())
            entry.update(status="ready" if not sheet["failed_count"] and not download["failed_count"] else "partial",
                         sheets=str(sheets), page_count=sheet["page_count"], failed_count=sheet["failed_count"])
        except api.Cancelled:
            entry["status"] = "paused"
            save(api, output, state)
            raise
        except Exception as exc:
            entry.update(status="paused" if cancelled and cancelled() else "error", error_type=type(exc).__name__)
        save(api, output, state)


def prepare(api, source, output, *, max_chars=6000, fetch_public=False, resume=False,
            retry_media=False, concurrency=3, timeout=20, transport=None, render_fn=None,
            on_event=None, cancelled=None, _lock_held=False):
    source, output = Path(source).resolve(), Path(output).resolve()
    if type(max_chars) is not int or not 128 <= max_chars <= 45000:
        raise api.PipelineError("max_chars_invalid", "max-chars must be 128..45000")
    if not 1 <= concurrency <= 3 or not 0 < timeout <= 120:
        raise api.PipelineError("media_budget_invalid", "Invalid media budget")
    if retry_media and not fetch_public:
        raise api.PipelineError("retry_requires_fetch", "retry-media requires fetch-public")
    output.mkdir(parents=True, exist_ok=True)
    with nullcontext() if _lock_held else api.processor_lock(output):
        control = output / "control.json"
        if resume and control.exists():
            api.atomic_json(control, {"cancel": False})
        stopped = lambda: bool(cancelled and cancelled()) or (control.exists() and api.read_json(control).get("cancel") is True)
        if stopped():
            return {"status": "paused", "reason": "cancelled", "surface_completion": False}
        data, binding, assessment = load(api, source)
        file = output / "state.json"
        if file.exists():
            state = api.read_json(file)
            current = checked_rows(api, data, state, binding)
            if state.get("pending") and state["max_chars"] != max_chars:
                raise api.PipelineError("pending_read_exists", "Confirm the pending batch before changing its size")
        else:
            state = {"layout": LAYOUT, "source_file": str(source), "binding": binding,
                     "entry_url": data["job"].get("target_url"), "job_id": data["job"]["id"], "scope": data.get("scope", {}),
                     "cursor": [0, 0], "prefix_digest": digest([]), "media_batches": [],
                     "anchor": None, "review_status": "not_reviewed", "coverage_complete": False,
                     "surface_completion": False}
            current = rows(data)
        state.update(source_file=str(source), max_chars=max_chars, status="prepared")
        # Only collection defects belong here. Reading progress is kept once above.
        state["collection_gaps"] = sorted({i["code"] for i in assessment["issues"]
                                         if i["code"] not in {"unread_text", "unread_media", "unread_comments", "unsupported_no_issue"}})
        unresolved = data.get("coverage", {}).get("unresolved", [])
        # Anonymous observation IDs are not public post IDs. Ordinary reading
        # does not require finding a permalink for every harmless observation.
        # Risk attribution and actual content/endpoint defects remain separate.
        if (unresolved and all(isinstance(gap, dict) and gap.get("reason") == "unstable_source_identity" for gap in unresolved)
                and data["job"].get("state") == "collected"
                and data.get("coverage", {}).get("visible_endpoint_verified") is True
                and data.get("coverage", {}).get("stop_reason") in api.coverage.GOOD_STOPS):
            state["collection_gaps"] = [code for code in state["collection_gaps"]
                                        if code not in {"collection_unresolved", "collection_incomplete"}]
        try:
            prepare_media(api, data, output, state, fetch_public=fetch_public, transport=transport,
                          render_fn=render_fn, concurrency=concurrency, timeout=timeout, cancelled=stopped,
                          retry_media=retry_media, resume=resume)
        except api.Cancelled:
            state.update(status="paused", reason="cancelled")
        state["next_action"] = next_action(state, current)
        state["stages"] = {"text": {"status": "read_on_demand"}, "media": {"status":
            "pending_public_fetch" if state.get("media_not_prepared") else
            "needs_review" if any(b["status"] != "ready" for b in state["media_batches"]) else "ready"}}
        save(api, output, state)
        if on_event:
            on_event({"event": "text_ready", "mode": "read_on_demand", "state_file": str(file), "next_action": state["next_action"]})
        return state


def read_next(api, output):
    output = Path(output).resolve()
    with api.processor_lock(output):
        state = api.read_json(output / "state.json")
        data, binding, _ = load(api, Path(state["source_file"]))
        current = checked_rows(api, data, state, binding)
        result = batch(current, state["cursor"], state["max_chars"], binding)
        if state.get("pending") and state["pending"] != result["batch_id"]:
            raise api.PipelineError("pending_source_changed", "Displayed batch changed; no reading confirmation was applied")
        if result["has_text"]:
            state["pending"] = result["batch_id"]
            save(api, output, state)
        return result


def confirm(api, output, batch_id, reviewer):
    if not reviewer.strip() or reviewer.strip().casefold() in {"auto", "automatic", "collector"}:
        raise api.PipelineError("reader_required", "Only the actual reader may confirm")
    output = Path(output).resolve()
    with api.processor_lock(output):
        state = api.read_json(output / "state.json")
        data, binding, _ = load(api, Path(state["source_file"]))
        current = checked_rows(api, data, state, binding)
        if batch_id.startswith("media-"):
            entries = [b for b in state["media_batches"] if b["batch_id"] == batch_id]
            if len(entries) != 1 or entries[0]["status"] != "ready":
                raise api.PipelineError("media_batch_unavailable", "Missing or failed images cannot be confirmed")
            entries[0].update(reviewed=True, reviewer=reviewer)
        elif state.get("last_confirmed_batch") != batch_id:
            result = batch(current, state["cursor"], state["max_chars"], binding)
            if not result["has_text"] or state.get("pending") != batch_id or result["batch_id"] != batch_id:
                raise api.PipelineError("batch_not_displayed_or_changed", "Read the exact current batch before confirming")
            state["cursor"] = result["next_cursor"]
            state["prefix_digest"] = prefix(current, state["cursor"])
            state["last_confirmed_batch"] = batch_id
            state["reviewer"] = reviewer
            state["anchor"] = result["sources"][-1]
            state.pop("pending", None)
        state["next_action"] = next_action(state, current)
        save(api, output, state)
        return {"status": "confirmed", "next_action": state["next_action"], "surface_completion": False}


def discard_pending(api, output):
    output = Path(output).resolve()
    with api.processor_lock(output):
        state = api.read_json(output / "state.json")
        if state.get("layout") != LAYOUT:
            raise api.PipelineError("legacy_checkpoint_preserved", "Use the existing legacy reading workflow")
        state.pop("pending", None)
        save(api, output, state)
        return {"status": "pending_discarded", "cursor": state["cursor"], "surface_completion": False}


def watch(api, job_directory, output, *, max_wait=1800, poll_interval=0.5, on_event=None, cancelled=None, **options):
    if not 0 < max_wait <= 14400 or not 0.05 <= poll_interval <= 5:
        raise api.PipelineError("watch_budget_invalid", "Invalid local watch budget")
    job_directory, output = Path(job_directory).resolve(), Path(output).resolve()
    if not job_directory.is_dir():
        raise api.PipelineError("job_directory_missing", "Collection directory missing")
    output.mkdir(parents=True, exist_ok=True)
    with api.processor_lock(output):
        deadline, bound = time.monotonic() + max_wait, None
        control = output / "control.json"
        if options.get("resume") and control.exists():
            api.atomic_json(control, {"cancel": False})
        if on_event:
            on_event({"event": "waiting_for_collection"})
        while time.monotonic() < deadline:
            if (cancelled and cancelled()) or (control.exists() and api.read_json(control).get("cancel") is True):
                return {"status": "paused", "reason": "cancelled", "surface_completion": False}
            try:
                job = api.read_json(job_directory / "job.json")
                if bound and bound != job["id"]:
                    raise api.PipelineError("job_identity_changed", "Do not rebind a watch to another task")
                bound = job["id"]
                if job.get("state") in {"collected", "needs_review", "paused", "failed"}:
                    result = api.read_json(job_directory / "result.json")
                    if all(result.get("job", {}).get(k) == job.get(k) for k in ("id", "state", "iterations")):
                        return prepare(api, job_directory / "result.json", output, on_event=on_event,
                                       cancelled=cancelled, _lock_held=True, **options)
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))
        return {"status": "error", "reason": "watch_timeout", "surface_completion": False}
