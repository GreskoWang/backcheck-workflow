"""One reading checkpoint; source text stays in its original cache.

No source copies, text exports, per-post no-issue receipts, or event journal.
Legacy preparation directories remain the responsibility of prepare.py.
"""
from __future__ import annotations

from contextlib import nullcontext
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import time

LAYOUT = "compact-reading-v1"
READING_SCHEMA = 2
BINDING_PREFIX = "compact-reading-v2:"
PLAN_SCHEMA = "compact-reconciliation-v1"


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def save(api, output, state):
    file = output / "state.json"
    if not file.exists() or api.read_json(file) != state:
        api.atomic_json(file, state)


def load(api, source):
    data = api.read_json(source)
    return validate_source(api, data)


def validate_source(api, data):
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


def source_snapshot(api, source):
    raw = source.read_bytes()
    return (*validate_source(api, json.loads(raw.decode("utf-8-sig"))),
            hashlib.sha256(raw).hexdigest())


def assert_snapshot(api, source, fingerprint):
    if hashlib.sha256(source.read_bytes()).hexdigest() != fingerprint:
        raise api.PipelineError("reconciliation_source_changed", "Source changed; make a new plan")


def rows(data):
    # Source metadata is bound to reading, but never copied into a second archive.
    return [{"source_id": item["source_id"], "post_url": item.get("post_url"),
             "account": item.get("account"), "account_id": item.get("account_id"), "date": item.get("date"),
             "field": field, "text": item.get(field, "")}
            for item in data["items"] for field in ("title", "text", "quoted_text") if item.get(field)]


def prefix(all_rows, cursor):
    if (not isinstance(cursor, list) or len(cursor) != 2
            or any(type(value) is not int for value in cursor)):
        raise ValueError("Invalid reading cursor")
    index, offset = cursor
    if not (0 <= index <= len(all_rows)) or offset < 0 or (index == len(all_rows) and offset):
        raise ValueError("Reading cursor exceeds source")
    if index < len(all_rows) and offset > len(all_rows[index]["text"]):
        raise ValueError("Reading cursor exceeds text")
    selected = all_rows[:index]
    if offset:
        selected = selected + [{**all_rows[index], "text": all_rows[index]["text"][:offset]}]
    return digest(selected)


def check_identity(api, state, binding):
    schema = state.get("reading_schema", 1)
    if type(schema) is not int or schema not in {1, READING_SCHEMA}:
        raise api.PipelineError("checkpoint_schema_unsupported", "Use the matching compact reader")
    expected = BINDING_PREFIX + binding if schema == READING_SCHEMA else binding
    if state.get("layout") != LAYOUT or state.get("binding") != expected:
        raise api.PipelineError("checkpoint_identity_conflict", "Keep the original task checkpoint")


def field_key(row):
    return digest([row["source_id"], row["field"]])


def field_checkpoint(row, confirmed=0):
    return {"source_id": row["source_id"], "field": row["field"],
            "fingerprint": digest(row), "length": len(row["text"]),
            "attribution": digest({k: v for k, v in row.items() if k not in {"field", "text"}}),
            "confirmed": confirmed}


def text_checkpoints(api, state):
    entries = state.get("text_checkpoints")
    if not isinstance(entries, dict):
        raise api.PipelineError("checkpoint_invalid", "Missing field fingerprints")
    for key, entry in entries.items():
        if (not isinstance(entry, dict) or not isinstance(entry.get("source_id"), str)
                or not entry["source_id"] or entry.get("field") not in {"title", "text", "quoted_text"}
                or key != field_key(entry)
                or any(not isinstance(entry.get(name), str) or len(entry[name]) != 64
                       or any(c not in "0123456789abcdef" for c in entry[name])
                       for name in ("fingerprint", "attribution"))
                or type(entry.get("length")) is not int or entry["length"] <= 0
                or type(entry.get("confirmed")) is not int
                or not 0 <= entry["confirmed"] <= entry["length"]):
            raise api.PipelineError("checkpoint_invalid", "Invalid field fingerprint or progress")
    return entries


def migrate_text(api, state, current, binding, *, allow_changed=False):
    """Old prefixes did not bind account_id or individual fields. Never guess."""
    if state.get("reading_schema", 1) == READING_SCHEMA:
        return None
    try:
        # Preserve the exact legacy digest algorithm, including absent keys.
        legacy_rows = [{k: v for k, v in row.items() if k != "account_id"} for row in current]
        unchanged = prefix(legacy_rows, state["cursor"]) == state["prefix_digest"]
    except (ValueError, KeyError):
        unchanged = False
    if not unchanged and not allow_changed:
        raise api.PipelineError("reviewed_source_changed", "Reviewed text or attribution changed; checkpoint preserved for explicit reconciliation")
    index, offset = state["cursor"] if unchanged else (0, 0)
    entries = {field_key(row): field_checkpoint(row,
        len(row["text"]) if number < index else offset if number == index else 0)
        for number, row in enumerate(current)}
    unbound_identity = any(row.get("account_id") is not None for row in current)
    affected_confirmation = any(row.get("account_id") is not None and entries[field_key(row)]["confirmed"]
                                for row in current)
    if affected_confirmation and not allow_changed:
        raise api.PipelineError("legacy_reconciliation_required", "Old confirmations do not bind account_id; make an explicit reconciliation plan")
    state["text_checkpoints"] = entries
    state.update(reading_schema=READING_SCHEMA, binding=BINDING_PREFIX + binding)
    return ("legacy_fingerprints_missing" if not unchanged else
            "legacy_account_identity_unbound" if unbound_identity else "legacy_prefix_verified")


def refresh_progress(state, current):
    entries = state["text_checkpoints"]
    state["cursor"] = next(([index, entries[field_key(row)]["confirmed"]]
        for index, row in enumerate(current)
        if entries[field_key(row)]["confirmed"] < len(row["text"])), [len(current), 0])
    # Compatibility/display only. v2 authorizes reading using every field hash.
    state["prefix_digest"] = prefix(current, state["cursor"])


def checked_rows(api, data, state, binding):
    check_identity(api, state, binding)
    current = rows(data)
    migrate_text(api, state, current, binding)
    entries = text_checkpoints(api, state)
    actual = {field_key(row): field_checkpoint(row) for row in current}
    # Check ALL retained fields, including confirmed fields after the first gap.
    if any(key not in actual or entry["fingerprint"] != actual[key]["fingerprint"]
           for key, entry in entries.items()):
        raise api.PipelineError("reviewed_source_changed", "Source text or attribution changed; checkpoint preserved for explicit reconciliation")
    for key, entry in actual.items():
        entries.setdefault(key, entry)  # Appended fields start unread.
    refresh_progress(state, current)
    return current


def batch(current, cursor, max_chars, binding, checkpoints):
    index, offset = cursor
    parts, sources, size = [], [], 0
    while index < len(current) and len(sources) < 32:
        row = current[index]
        offset = max(offset, checkpoints[field_key(row)]["confirmed"])
        if offset == len(row["text"]):
            index, offset = index + 1, 0
            continue
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
    while index < len(current) and checkpoints[field_key(current[index])]["confirmed"] == len(current[index]["text"]):
        index, offset = index + 1, 0
    next_cursor = [index, offset]
    token = digest([binding, cursor, next_cursor, sources, content, max_chars,
                    [checkpoints[field_key(row)]["fingerprint"] for row in sources]])
    return {"batch_id": "text-" + token, "text": content, "sources": sources,
            "next_cursor": next_cursor, "text_end": index == len(current), "has_text": bool(content)}


def next_action(state, current):
    text_end = state["cursor"] == [len(current), 0]
    pending_media = sum(bool(b.get("active_keys", b["keys"])) and not b.get("reviewed", False)
                        for b in state["media_batches"])
    return {"kind": "model_review_required", "text_read_complete": text_end,
            "pending_media_batches": pending_media,
            "media_not_prepared": state.get("media_not_prepared", 0),
            "collection_gaps": state["collection_gaps"],
            "source_lookup_required_for_findings": True,
            "automatic_review": False, "automatic_feishu_write": False}


def media_key(item):
    # Reordering posts does not change a media item's source attribution.
    return digest({"account_id": item.get("account_id"),
                   **{k: v for k, v in item.items() if k != "input_post_index"}})


def media_inventory(api, data):
    items = [{**item, "account_id": data["items"][item["input_post_index"]].get("account_id")}
             for item in api.export_manifest.export_result(data)["items"]]
    return {media_key(item): item for item in items}


def checked_media(api, output, state, inventory, *, reconcile=False):
    """Verify saved manifests, then retain only still-current media mappings."""
    retained, invalidated = 0, 0
    for entry in state["media_batches"]:
        directory = Path(entry["directory"]).resolve()
        if not directory.is_relative_to(output):
            raise api.PipelineError("media_checkpoint_invalid", "Media directory must belong to this checkpoint")
        manifest = api.read_json(directory / "sources.json")
        items = manifest.get("items")
        if not isinstance(items, list) or not items:
            raise api.PipelineError("media_checkpoint_invalid", "Media source manifest is missing")
        keys = [media_key(item) for item in items]
        version = entry.get("key_version", 1)
        expected = keys if version == 2 else [digest(item) for item in items]
        if (type(version) is not int or version not in {1, 2}
                or entry.get("keys") != expected or len(set(keys)) != len(keys)
                or type(entry.get("reviewed")) is not bool):
            raise api.PipelineError("media_checkpoint_invalid", "Media fingerprints do not match their saved manifest")
        active = entry.get("active_keys", expected)
        if (not isinstance(active, list) or len(set(active)) != len(active)
                or not set(active) <= set(expected)):
            raise api.PipelineError("media_checkpoint_invalid", "Invalid active media fingerprints")
        if version == 1:
            convert = dict(zip(expected, keys))
            active = [convert[key] for key in active]
        missing = [key for key in active if key not in inventory]
        if missing and not reconcile:
            raise api.PipelineError("reviewed_source_changed", "Media content or attribution changed; checkpoint preserved for explicit reconciliation")
        if missing and entry["status"] != "ready":
            # A partial/preparing sheet cannot prove that its surviving cells are
            # ready. Re-prepare current items, reusing the existing byte cache.
            missing = list(active)
        retained += sum(key in inventory for key in active) if entry["reviewed"] else 0
        invalidated += len(missing)
        entry.update(key_version=2, keys=keys, active_keys=[key for key in active if key not in missing])
        if not entry["active_keys"]:
            entry.update(status="superseded", reviewed=False)
            entry.pop("reviewer", None)
    active_keys = {key for entry in state["media_batches"] for key in entry["active_keys"]}
    state["media_not_prepared"] = len(set(inventory) - active_keys)
    return {"retained_confirmed_items": retained, "invalidated_items": invalidated,
            "unprepared_items": state["media_not_prepared"]}


def update_assessment(api, data, assessment, state):
    state["collection_gaps"] = sorted({i["code"] for i in assessment["issues"]
        if i["code"] not in {"unread_text", "unread_media", "unread_comments", "unsupported_no_issue"}})
    unresolved = data.get("coverage", {}).get("unresolved", [])
    if (unresolved and all(isinstance(gap, dict) and gap.get("reason") == "unstable_source_identity" for gap in unresolved)
            and data["job"].get("state") == "collected"
            and data.get("coverage", {}).get("visible_endpoint_verified") is True
            and data.get("coverage", {}).get("stop_reason") in api.coverage.GOOD_STOPS):
        state["collection_gaps"] = [code for code in state["collection_gaps"]
                                    if code not in {"collection_unresolved", "collection_incomplete"}]
    state.update(review_status="not_reviewed", coverage_complete=False, surface_completion=False)


def refresh_actions(state, current):
    state["next_action"] = next_action(state, current)
    state["stages"] = {"text": {"status": "read_on_demand"}, "media": {"status":
        "pending_public_fetch" if state.get("media_not_prepared") else
        "needs_review" if any(b["active_keys"] and b["status"] != "ready" for b in state["media_batches"])
        else "ready"}}


def prepare_media(api, data, output, state, *, fetch_public=False, transport=None,
                  render_fn=None, concurrency=3, timeout=20, cancelled=None, retry_media=False, resume=False):
    inventory = media_inventory(api, data)
    checked_media(api, output, state, inventory)
    seen = {key for entry in state["media_batches"] for key in entry["active_keys"]}
    unique = {key: item for key, item in inventory.items() if key not in seen}
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
        entry = {"batch_id": name, "keys": [key for key, _ in group], "key_version": 2,
                 "active_keys": [key for key, _ in group], "reviewed": False,
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
            if Path(state["source_file"]).resolve() != source:
                raise api.PipelineError("checkpoint_identity_conflict", "Do not rebind a checkpoint to a different source file")
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
            migrate_text(api, state, current, binding)
        state.update(source_file=str(source), max_chars=max_chars, status="prepared")
        # Only collection defects belong here. Reading progress is kept once above.
        update_assessment(api, data, assessment, state)
        try:
            prepare_media(api, data, output, state, fetch_public=fetch_public, transport=transport,
                          render_fn=render_fn, concurrency=concurrency, timeout=timeout, cancelled=stopped,
                          retry_media=retry_media, resume=resume)
        except api.Cancelled:
            state.update(status="paused", reason="cancelled")
        refresh_progress(state, current)
        refresh_actions(state, current)
        save(api, output, state)
        if on_event:
            on_event({"event": "text_ready", "mode": "read_on_demand", "state_file": str(file), "next_action": state["next_action"]})
        return state


def read_next(api, output):
    output = Path(output).resolve()
    with api.processor_lock(output):
        state = api.read_json(output / "state.json")
        data, binding, assessment = load(api, Path(state["source_file"]))
        current = checked_rows(api, data, state, binding)
        checked_media(api, output, state, media_inventory(api, data))
        update_assessment(api, data, assessment, state)
        result = batch(current, state["cursor"], state["max_chars"], binding, state["text_checkpoints"])
        if state.get("pending") and state["pending"] != result["batch_id"]:
            raise api.PipelineError("pending_source_changed", "Displayed batch changed; no reading confirmation was applied")
        if result["has_text"]:
            state["pending"] = result["batch_id"]
        refresh_actions(state, current)
        save(api, output, state)
        return result


def confirm(api, output, batch_id, reviewer):
    if not reviewer.strip() or reviewer.strip().casefold() in {"auto", "automatic", "collector"}:
        raise api.PipelineError("reader_required", "Only the actual reader may confirm")
    output = Path(output).resolve()
    with api.processor_lock(output):
        state = api.read_json(output / "state.json")
        data, binding, assessment = load(api, Path(state["source_file"]))
        current = checked_rows(api, data, state, binding)
        checked_media(api, output, state, media_inventory(api, data))
        update_assessment(api, data, assessment, state)
        if batch_id.startswith("media-"):
            entries = [b for b in state["media_batches"] if b["batch_id"] == batch_id]
            if len(entries) != 1 or entries[0]["status"] != "ready" or not entries[0]["active_keys"]:
                raise api.PipelineError("media_batch_unavailable", "Missing or failed images cannot be confirmed")
            entries[0].update(reviewed=True, reviewer=reviewer)
        elif state.get("last_confirmed_batch") != batch_id:
            result = batch(current, state["cursor"], state["max_chars"], binding, state["text_checkpoints"])
            if not result["has_text"] or state.get("pending") != batch_id or result["batch_id"] != batch_id:
                raise api.PipelineError("batch_not_displayed_or_changed", "Read the exact current batch before confirming")
            for segment in result["sources"]:
                state["text_checkpoints"][field_key(segment)]["confirmed"] = segment["end"]
            refresh_progress(state, current)
            state["last_confirmed_batch"] = batch_id
            state["reviewer"] = reviewer
            state["anchor"] = result["sources"][-1]
            state.pop("pending", None)
        refresh_actions(state, current)
        save(api, output, state)
        return {"status": "confirmed", "next_action": state["next_action"], "surface_completion": False}


def status(api, output):
    output = Path(output).resolve()
    with api.processor_lock(output):
        state = api.read_json(output / "state.json")
        data, binding, assessment = load(api, Path(state["source_file"]))
        current = checked_rows(api, data, state, binding)
        checked_media(api, output, state, media_inventory(api, data))
        update_assessment(api, data, assessment, state)
        refresh_actions(state, current)
        return state  # Inspection never persists an implicit migration.


def discard_pending(api, output):
    output = Path(output).resolve()
    with api.processor_lock(output):
        state = api.read_json(output / "state.json")
        if state.get("layout") != LAYOUT:
            raise api.PipelineError("legacy_checkpoint_preserved", "Use the existing legacy reading workflow")
        state.pop("pending", None)
        save(api, output, state)
        return {"status": "pending_discarded", "cursor": state["cursor"], "surface_completion": False}


def reconciliation(api, output, source, state, data, binding, assessment, source_hash, checkpoint_hash):
    check_identity(api, state, binding)
    updated = deepcopy(state)
    current = rows(data)
    migration = migrate_text(api, updated, current, binding, allow_changed=True)
    previous = text_checkpoints(api, updated)
    changes, selected = [], {}
    retained_fields = retained_characters = 0
    for row in current:
        key = field_key(row)
        entry = field_checkpoint(row)
        old = previous.get(key)
        if migration == "legacy_fingerprints_missing":
            reason = migration
        elif migration == "legacy_account_identity_unbound" and row.get("account_id") is not None:
            reason = migration
        elif old is None:
            reason = "new_field"
        elif old["fingerprint"] != entry["fingerprint"]:
            reason = "attribution_changed" if old["attribution"] != entry["attribution"] else "text_changed"
        else:
            reason = None
            entry["confirmed"] = old["confirmed"]
            retained_fields += int(old["confirmed"] > 0)
            retained_characters += old["confirmed"]
        if reason:
            changes.append({"source_id": row["source_id"], "field": row["field"], "reason": reason,
                            "previous_confirmed": None if migration == "legacy_fingerprints_missing"
                            else old["confirmed"] if old else 0, "current_length": entry["length"]})
        selected[key] = entry
    for key, old in previous.items():
        if key not in selected:
            changes.append({"source_id": old["source_id"], "field": old["field"], "reason": "field_removed",
                            "previous_confirmed": old["confirmed"], "current_length": 0})
    updated["text_checkpoints"] = selected
    media_summary = checked_media(api, output, updated, media_inventory(api, data), reconcile=True)
    update_assessment(api, data, assessment, updated)
    refresh_progress(updated, current)
    refresh_actions(updated, current)
    discarded_pending = bool(updated.pop("pending", None))
    for name in ("last_confirmed_batch", "reviewer"):
        updated.pop(name, None)
    updated.update(status="prepared", anchor=None)
    plan = {"schema": PLAN_SCHEMA, "source_file": str(source), "output_directory": str(output),
            "binding": binding, "source_fingerprint": source_hash, "checkpoint_fingerprint": checkpoint_hash,
            "migration": migration, "text_changes": changes,
            "summary": {"retained_confirmed_fields": retained_fields,
                        "retained_confirmed_characters": retained_characters,
                        "unread_fields": sum(e["confirmed"] < e["length"] for e in selected.values()),
                        "unread_characters": sum(e["length"] - e["confirmed"] for e in selected.values()),
                        "text_changes": len(changes), "discard_pending": discarded_pending,
                        "media": media_summary},
            "surface_completion": False, "automatic_review": False}
    plan["plan_id"] = digest(plan)
    return plan, updated


def reconcile_plan(api, output, plan_file):
    output, plan_file = Path(output).resolve(), Path(plan_file).resolve()
    with api.processor_lock(output):
        raw = (output / "state.json").read_bytes()
        state = json.loads(raw.decode("utf-8-sig"))
        source = Path(state["source_file"]).resolve()
        data, binding, assessment, source_hash = source_snapshot(api, source)
        plan, _ = reconciliation(api, output, source, state, data, binding, assessment,
                                  source_hash, hashlib.sha256(raw).hexdigest())
        assert_snapshot(api, source, source_hash)
        # A plan cannot overwrite a checkpoint, cache, or a previously different plan.
        api.ensure_immutable(plan_file, api.encoded(plan))
        return {"status": "reconciliation_planned", "plan_file": str(plan_file),
                "plan_id": plan["plan_id"], "migration": plan["migration"],
                "summary": plan["summary"], "surface_completion": False}


def reconcile_apply(api, output, plan_file):
    output = Path(output).resolve()
    with api.processor_lock(output):
        plan = api.read_json(Path(plan_file).resolve())
        if (not isinstance(plan, dict) or plan.get("schema") != PLAN_SCHEMA
                or plan.get("plan_id") != digest({k: v for k, v in plan.items() if k != "plan_id"})):
            raise api.PipelineError("reconciliation_plan_invalid", "Use an unchanged generated plan")
        file = output / "state.json"
        raw = file.read_bytes()
        state = json.loads(raw.decode("utf-8-sig"))
        source = Path(state["source_file"]).resolve()
        data, binding, assessment, source_hash = source_snapshot(api, source)
        check_identity(api, state, binding)
        if (plan.get("binding") != binding or plan.get("source_file") != str(source)
                or plan.get("output_directory") != str(output)):
            raise api.PipelineError("checkpoint_identity_conflict", "A reconciliation plan belongs to one task and source")
        if plan.get("source_fingerprint") != source_hash:
            raise api.PipelineError("reconciliation_source_changed", "Source changed; make a new plan")
        if state.get("last_reconciliation", {}).get("plan_id") == plan["plan_id"]:
            current = checked_rows(api, data, state, binding)
            checked_media(api, output, state, media_inventory(api, data))
            update_assessment(api, data, assessment, state)
            refresh_actions(state, current)
            return {"status": "reconciliation_already_applied", "plan_id": plan["plan_id"],
                    "next_action": state["next_action"], "surface_completion": False}
        checkpoint_hash = hashlib.sha256(raw).hexdigest()
        if plan.get("checkpoint_fingerprint") != checkpoint_hash:
            raise api.PipelineError("reconciliation_checkpoint_changed", "Reading progressed; make a new plan")
        expected, updated = reconciliation(api, output, source, state, data, binding, assessment,
                                           source_hash, checkpoint_hash)
        if plan != expected:
            raise api.PipelineError("reconciliation_plan_changed", "Plan actions differ from the current computed change")
        updated["last_reconciliation"] = {"plan_id": plan["plan_id"], "source_fingerprint": source_hash}
        assert_snapshot(api, source, source_hash)
        # One checkpoint replacement; no source mutation, side journal or auto-confirmation.
        api.atomic_json(file, updated)
        return {"status": "reconciliation_applied", "plan_id": plan["plan_id"],
                "next_action": updated["next_action"], "surface_completion": False}


def watch(api, job_directory, output, *, max_wait=1800, poll_interval=0.5, on_event=None, cancelled=None, **options):
    if not 0 < max_wait <= 14400 or not 0.05 <= poll_interval <= 5:
        raise api.PipelineError("watch_budget_invalid", "Invalid local watch budget")
    job_directory, output = Path(job_directory).resolve(), Path(output).resolve()
    if not job_directory.is_dir():
        raise api.PipelineError("job_directory_missing", "Collection directory missing")
    output.mkdir(parents=True, exist_ok=True)
    with api.processor_lock(output):
        deadline, bound = time.monotonic() + max_wait, None
        terminal_since, terminal_key = None, None
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
                    if job.get("stop_reason") == "worker_initialization_error":
                        error = job.get("error")
                        code = error.get("code") if isinstance(error, dict) else None
                        return {"status": "error", "reason": "worker_initialization_error",
                                "job_id": bound,
                                "collection_error_code": code if isinstance(code, str) and len(code) <= 100 else None,
                                "surface_completion": False}
                    key = (job["id"], job.get("state"), job.get("iterations"))
                    if key != terminal_key:
                        terminal_key, terminal_since = key, time.monotonic()
                    try:
                        result = api.read_json(job_directory / "result.json")
                    except (FileNotFoundError, json.JSONDecodeError):
                        result = {}
                    if all(result.get("job", {}).get(k) == job.get(k) for k in ("id", "state", "iterations")):
                        return prepare(api, job_directory / "result.json", output, on_event=on_event,
                                       cancelled=cancelled, _lock_held=True, **options)
                    if time.monotonic() - terminal_since >= min(3, max_wait):
                        return {"status": "error", "reason": "terminal_result_missing_or_stale",
                                "job_id": bound, "surface_completion": False}
                else:
                    terminal_since, terminal_key = None, None
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))
        return {"status": "error", "reason": "watch_timeout", "surface_completion": False}
