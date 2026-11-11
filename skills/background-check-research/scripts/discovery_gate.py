#!/usr/bin/env python3
"""Validate discovery evidence consistency, not cognitive or linguistic completeness."""
from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
from pathlib import Path
from typing import Any, Iterable

MANDATORY_STAGES = ("source_collection", "semantic_analysis", "term_extraction", "reverse_review")


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _strings(value: Any, *, nonempty: bool = True) -> bool:
    return isinstance(value, list) and (bool(value) or not nonempty) and all(_text(v) for v in value)


def _name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _terminal_outcome(value: Any) -> bool:
    """Closure preserves observed access/uncertainty, not a claim of unseen reading."""
    return (isinstance(value, dict) and value.get("status") == "complete"
            and value.get("kind") in ("objective_unavailable", "bounded_inconclusive")
            and _text(value.get("reason")) and _strings(value.get("evidence_refs"))
            and value.get("conclusion") == ("无问题" if value.get("kind") == "objective_unavailable" else "未坐实"))


def _incomplete_content(value: Any) -> bool:
    """Honor declared acquisition defects without guessing semantics from keywords."""
    if isinstance(value, dict):
        if any(value.get(key) for key in ("unparsed", "truncated", "content_truncated")):
            return True
        if value.get("parsed") is False or value.get("parse_status") in ("unparsed", "failed", "partial"):
            return True
        return any(_incomplete_content(child) for child in value.values())
    return isinstance(value, list) and any(_incomplete_content(child) for child in value)


def audit_discovery_review(review: Any, *, reported_facts: Iterable[str] | None = None,
                           base_dir: Path | None = None, consolidation: Any = None) -> dict[str, Any]:
    errors: list[dict[str, str]] = []
    blocked: list[dict[str, str]] = []
    info: list[str] = []
    research_assessed = False
    stage_order = list(MANDATORY_STAGES) + ["final_report"]
    base = Path(base_dir) if base_dir is not None else Path.cwd()

    def issue(code: str, location: str, actual: Any, expected: str, *,
              stage: str = "source_collection", inaccessible: bool = False) -> None:
        (blocked if inaccessible else errors).append({"code": code, "location": "discovery_review" + location,
            "actual": str(actual), "expected": expected, "repair_stage": stage})

    def result() -> dict[str, Any]:
        first = min(errors + blocked, key=lambda row: stage_order.index(row["repair_stage"])
                    if row["repair_stage"] in stage_order else len(stage_order), default=None)
        return {"verdict": "FAIL" if errors else "BLOCKED" if blocked else "PASS",
                "research_assessed": research_assessed, "repair_stage": first["repair_stage"] if first else None,
                "errors": errors, "blocked": blocked, "info": info}

    def read_artifact(path_value: Any, location: str, stage: str, expected_sha: Any = None) -> Any:
        if not _text(path_value):
            issue("DISCOVERY_ARTIFACT_PATH", location, path_value, "actual JSON artifact path", stage=stage)
            return None
        path = Path(path_value)
        if not path.is_absolute():
            path = base / path
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            issue("DISCOVERY_ARTIFACT_MISSING", location, path_value, "existing evidence file", stage=stage)
            return None
        except ValueError as exc:
            issue("DISCOVERY_ARTIFACT_PATH", location, exc, "valid JSON artifact path", stage=stage)
            return None
        except OSError as exc:
            issue("DISCOVERY_ARTIFACT_INACCESSIBLE", location, exc, "readable evidence file", stage=stage, inaccessible=True)
            return None
        if expected_sha is not None and (not _text(expected_sha) or hashlib.sha256(raw).hexdigest() != expected_sha):
            issue("DISCOVERY_SOURCE_HASH", location, expected_sha, "SHA-256 of actual source bytes", stage=stage)
        try:
            return json.loads(raw.decode("utf-8-sig"))
        except (UnicodeError, ValueError, TypeError) as exc:
            issue("DISCOVERY_ARTIFACT_JSON", location, exc, "complete parseable JSON evidence", stage=stage)
            return None

    if not isinstance(review, dict):
        issue("DISCOVERY_REVIEW_REQUIRED", "", type(review).__name__, "version 2 research evidence or explicit delivery-only basis")
        return result()
    if not _text(review.get("scope")):
        issue("DISCOVERY_SCOPE", ".scope", review.get("scope"), "actual task scope")
    mode = review.get("mode")
    if mode in ("user_supplied", "existing_report_only"):
        if type(review.get("version")) is not int or review["version"] not in (1, 2):
            issue("DISCOVERY_VERSION", ".version", review.get("version"), "1 or 2 for isolated delivery-only scope")
        for field in ("instruction", "source_ref"):
            if not _text(review.get(field)):
                issue("DISCOVERY_USER_BASIS", "." + field, review.get(field), "explicit formatting-only user instruction and its source")
        active_fields = ("entities", "open_items", "reverse_pass", "execution_review", "semantic_review", "subagent_review", "acquisition_manifest",
                         "source_revision", "reviewed_revision", "source_refs", "task_id", "primary_agent_id")
        if any(field in review for field in active_fields):
            issue("DISCOVERY_MODE_CONFLICT", ".mode", mode, "assistant_research for any active investigation data")
        info.append("DISCOVERY_NOT_ASSESSED: delivery-only scope; no research completion certification")
        return result()
    if mode != "assistant_research":
        issue("DISCOVERY_MODE", ".mode", mode, "assistant_research, user_supplied or existing_report_only")
        return result()
    research_assessed = True
    if type(review.get("version")) is not int or review["version"] != 2:
        issue("DISCOVERY_VERSION", ".version", review.get("version"), "2; legacy research records require actual re-review, never auto-upgrade")
    for field in ("task_id", "primary_agent_id", "source_revision", "reviewed_revision"):
        if not _text(review.get(field)):
            issue("DISCOVERY_SOURCE_VERSION", "." + field, review.get(field), "actual task, agent and material identity")
    revision = review.get("source_revision")
    if revision != review.get("reviewed_revision"):
        issue("DISCOVERY_STALE_REVIEW", ".reviewed_revision", review.get("reviewed_revision"), "match current source_revision", stage="semantic_analysis")
    if not _strings(review.get("source_refs")):
        issue("DISCOVERY_SOURCE_REFS", ".source_refs", review.get("source_refs"), "non-empty actual source/batch locators")
    if not isinstance(review.get("open_items"), list) or review["open_items"]:
        issue("DISCOVERY_OPEN_ITEMS", ".open_items", review.get("open_items"), "empty after closure or explicit user scope change", stage="semantic_analysis")

    execution = review.get("execution_review")
    execution = execution if isinstance(execution, dict) else {}
    if execution.get("status") != "complete" or execution.get("source_revision") != revision:
        issue("DISCOVERY_EXECUTION_REVIEW", ".execution_review", execution, "current complete execution review")
    applicable = execution.get("applicable_steps")
    if not _strings(applicable) or len(set(applicable)) != len(applicable):
        issue("DISCOVERY_APPLICABLE_STEPS", ".execution_review.applicable_steps", applicable, "unique mandatory and task-applicable step IDs")
        applicable = list(MANDATORY_STAGES)
    for required in MANDATORY_STAGES:
        if required not in applicable:
            issue("DISCOVERY_REQUIRED_STEP", ".execution_review.applicable_steps", required, "include every mandatory discovery stage", stage=required)
    applicable = [step for step in applicable if step != "term_subagent_review"]
    stage_order = applicable + [s for s in MANDATORY_STAGES if s not in applicable] + ["final_report"]
    skipped = execution.get("skipped_steps")
    if not _strings(skipped, nonempty=False):
        issue("DISCOVERY_SKIPPED_STEPS", ".execution_review.skipped_steps", skipped, "empty list after repairing every skipped applicable step")
    elif skipped:
        for step_id in skipped:
            if step_id == "term_subagent_review":
                continue
            issue("DISCOVERY_SKIPPED_STEPS", ".execution_review.skipped_steps", step_id, "repair this skipped applicable step", stage=step_id if step_id in applicable else "source_collection")
    steps = execution.get("steps")
    if not isinstance(steps, list):
        steps = []
        issue("DISCOVERY_EXECUTION_STEPS", ".execution_review.steps", execution.get("steps"), "evidence for every applicable step")
    seen_steps: set[str] = set()
    for index, step in enumerate(steps):
        location = f".execution_review.steps[{index}]"
        if not isinstance(step, dict) or not _text(step.get("step_id")):
            issue("DISCOVERY_EXECUTION_STEP", location, step, "step object with step_id")
            continue
        step_id = step["step_id"]
        if step_id == "term_subagent_review":
            continue
        if step_id in seen_steps or step_id not in applicable:
            issue("DISCOVERY_EXECUTION_STEP", location, step_id, "exactly one declared applicable step", stage=step_id)
        seen_steps.add(step_id)
        if step.get("status") != "complete" or not _strings(step.get("evidence_refs")):
            issue("DISCOVERY_INCOMPLETE_STEP", location, step, "actually complete step with evidence_refs", stage=step_id)
    for missing in (set(applicable) | set(MANDATORY_STAGES)) - seen_steps:
        issue("DISCOVERY_MISSING_STEP", ".execution_review.steps", missing, "completed applicable step with evidence_refs", stage=missing)

    semantic = review.get("semantic_review")
    semantic = semantic if isinstance(semantic, dict) else {}
    if semantic.get("status") != "complete" or semantic.get("source_revision") != revision:
        issue("DISCOVERY_SEMANTIC_REVIEW", ".semantic_review", semantic, "complete item-level review bound to current sources", stage="semantic_analysis")
    batches = semantic.get("source_batches")
    if not isinstance(batches, list) or not batches:
        batches = []
        issue("DISCOVERY_SOURCE_BATCHES", ".semantic_review.source_batches", semantic.get("source_batches"), "actual acquired JSON batches")
    manifest_ref = review.get("acquisition_manifest")
    manifest_ref = manifest_ref if isinstance(manifest_ref, dict) else {}
    manifest_hash = manifest_ref.get("sha256")
    if not _text(manifest_hash):
        issue("DISCOVERY_ACQUISITION_HASH", ".acquisition_manifest.sha256", manifest_hash, "SHA-256 of acquisition-produced inventory bytes")
    blocked_before = len(blocked)
    manifest = read_artifact(manifest_ref.get("path"), ".acquisition_manifest.path", "source_collection", manifest_hash)
    if len(blocked) != blocked_before:
        return result()
    manifest = manifest if isinstance(manifest, dict) else {}
    for field, expected in (("task_id", review.get("task_id")), ("source_revision", revision)):
        if not _text(manifest.get(field)) or manifest[field] != expected:
            issue("DISCOVERY_ACQUISITION_BINDING", ".acquisition_manifest." + field, manifest.get(field), f"match {expected}")
    inventory = manifest.get("source_batches")
    if not isinstance(inventory, list) or not inventory:
        inventory = []
        issue("DISCOVERY_ACQUISITION_INVENTORY", ".acquisition_manifest.source_batches", manifest.get("source_batches"), "complete acquisition-produced batch inventory")
    fields = ("batch_id", "path", "items_key", "sha256")
    def batch_keys(records: list[Any]) -> list[str]:
        return sorted(json.dumps({field: row.get(field) for field in fields}, sort_keys=True, ensure_ascii=False)
                      if isinstance(row, dict) else json.dumps(row, sort_keys=True, ensure_ascii=False) for row in records)
    if batch_keys(inventory) != batch_keys(batches):
        issue("DISCOVERY_ACQUISITION_COVERAGE", ".semantic_review.source_batches", batches, "every acquisition inventory batch exactly once, including current source hashes")
    expected_items: set[tuple[str, int]] = set()
    batch_ids: set[str] = set()
    batch_paths: set[Path] = set()
    for index, batch in enumerate(batches):
        location = f".semantic_review.source_batches[{index}]"
        if not isinstance(batch, dict) or not _text(batch.get("batch_id")):
            issue("DISCOVERY_SOURCE_BATCH", location, batch, "batch object with unique batch_id")
            continue
        batch_id = batch["batch_id"]
        if batch_id in batch_ids:
            issue("DISCOVERY_DUPLICATE_BATCH", location, batch_id, "each acquired batch exactly once")
        batch_ids.add(batch_id)
        path_value = batch.get("path")
        if _text(path_value):
            path = Path(path_value)
            path = path if path.is_absolute() else base / path
            try:
                path = path.resolve()
            except (OSError, ValueError) as exc:
                issue("DISCOVERY_ARTIFACT_PATH", location + ".path", exc, "valid resolvable JSON artifact path")
            if path in batch_paths:
                issue("DISCOVERY_DUPLICATE_BATCH", location, path_value, "distinct actual batch files")
            batch_paths.add(path)
        if not _text(batch.get("sha256")):
            issue("DISCOVERY_SOURCE_HASH", location + ".sha256", batch.get("sha256"), "actual source byte SHA-256")
        blocked_before = len(blocked)
        source = read_artifact(path_value, location + ".path", "source_collection", batch.get("sha256"))
        if len(blocked) != blocked_before:
            return result()
        key = batch.get("items_key")
        if not _text(key) or not isinstance(source, dict) or not isinstance(source.get(key), list):
            issue("DISCOVERY_SOURCE_ITEMS", location, key, "items_key resolving to the full source JSON item array")
            continue
        if _incomplete_content(source):
            issue("DISCOVERY_INCOMPLETE_SOURCE", location, batch_id, "fully parsed, untruncated acquired content")
        for item_index, raw_item in enumerate(source[key]):
            expected_items.add((batch_id, item_index))
            if not isinstance(raw_item, (str, dict)) or not raw_item or (isinstance(raw_item, str) and not raw_item.strip()):
                issue("DISCOVERY_RAW_ITEM", location + f".{key}[{item_index}]", raw_item, "nonempty actual acquired item")
    if not expected_items:
        issue("DISCOVERY_EMPTY_SOURCES", ".semantic_review.source_batches", 0, "at least one acquired item for research certification")
    semantic_items = semantic.get("items")
    if not isinstance(semantic_items, list):
        semantic_items = []
        issue("DISCOVERY_SEMANTIC_ITEMS", ".semantic_review.items", semantic.get("items"), "one semantic analysis per acquired item", stage="semantic_analysis")
    covered: set[tuple[str, int]] = set()
    extracted_names: set[str] = set()
    for index, item in enumerate(semantic_items):
        location = f".semantic_review.items[{index}]"
        if not isinstance(item, dict) or not _text(item.get("batch_id")) or type(item.get("item_index")) is not int or item["item_index"] < 0:
            issue("DISCOVERY_SEMANTIC_ITEM", location, item, "batch_id and zero-based integer item_index", stage="semantic_analysis")
            continue
        identity = (item["batch_id"], item["item_index"])
        if identity in covered or identity not in expected_items:
            issue("DISCOVERY_ITEM_COVERAGE", location, identity, "exactly one review of a real acquired item", stage="semantic_analysis")
        covered.add(identity)
        if item.get("status") != "complete" or not _text(item.get("summary")):
            issue("DISCOVERY_ITEM_ANALYSIS", location, item, "complete individual semantic summary, not a cache count", stage="semantic_analysis")
        names = item.get("names")
        if not _strings(names, nonempty=False):
            issue("DISCOVERY_ITEM_EXTRACTION", location + ".names", names, "all special nouns extracted from this item", stage="term_extraction")
        elif names:
            extracted_names.update(_name(name) for name in names)
        elif not _text(item.get("no_special_terms_reason")):
            issue("DISCOVERY_ITEM_EXTRACTION", location, item, "specific semantic reason when this item has no special nouns", stage="term_extraction")
    for identity in sorted(expected_items - covered):
        issue("DISCOVERY_ITEM_COVERAGE", ".semantic_review.items", identity, "individual semantic review of every acquired item", stage="semantic_analysis")
    entities = review.get("entities")
    if not isinstance(entities, list):
        issue("DISCOVERY_ENTITIES", ".entities", entities, "deduplicated source-grounded noun list", stage="term_extraction")
        entities = []
    known_names: dict[str, int] = {}
    if reported_facts is not None and (not isinstance(reported_facts, (list, tuple, set)) or not all(_text(f) for f in reported_facts)):
        issue("DISCOVERY_REPORTED_FACTS", ".reported_facts", type(reported_facts).__name__, "list of final facts", stage="final_report")
        reported_facts = None
    facts = set(reported_facts or [])
    # A later report may sample policy categories without changing the frozen
    # discovery. This explicit, source-bound archive is not a completion waiver.
    archived_pairs: set[tuple[int, str]] = set()
    if consolidation is not None:
        def consolidation_issue(actual: Any, expected: str, suffix: str = "") -> None:
            issue("DISCOVERY_CONSOLIDATION", ".consolidation" + suffix, actual, expected, stage="final_report")
        def canonical_hash(value: Any) -> str:
            return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        def consolidation_artifact(ref: Any, suffix: str) -> Any:
            if not isinstance(ref, dict) or set(ref) != {"path", "sha256"} or not _text(ref.get("sha256")):
                consolidation_issue(ref, "actual {path,sha256} archive reference", suffix)
                return None
            return read_artifact(ref.get("path"), ".consolidation" + suffix, "final_report", ref["sha256"])
        expected_pairs = set()
        for i, entity in enumerate(entities):
            if isinstance(entity, dict) and entity.get("disposition") == "record":
                required_facts = entity.get("record_facts", [entity.get("record_fact")])
                if isinstance(required_facts, list):
                    expected_pairs.update((i, fact) for fact in required_facts if _text(fact))
        required_keys = {"version", "task_id", "source_revision", "discovery_sha256", "reported_facts_sha256", "policy", "archive", "context_archives", "entries"}
        if not isinstance(consolidation, dict) or set(consolidation) != required_keys:
            consolidation_issue(consolidation, "complete versioned category-consolidation record")
        else:
            valid_binding = (type(consolidation["version"]) is int and consolidation["version"] == 1
                and consolidation["task_id"] == review.get("task_id") and consolidation["source_revision"] == revision
                and consolidation["discovery_sha256"] == canonical_hash(review)
                and reported_facts is not None and consolidation["reported_facts_sha256"] == canonical_hash(sorted(facts)))
            if not valid_binding:
                consolidation_issue(consolidation, "exact task, frozen discovery and current final fact-set hashes")
            policy_ref = consolidation["policy"]
            policy_text = ""
            if not isinstance(policy_ref, dict) or set(policy_ref) != {"path", "sha256"} or not all(_text(policy_ref.get(k)) for k in ("path", "sha256")):
                consolidation_issue(policy_ref, "current policy {path,sha256}", ".policy")
            else:
                try:
                    policy_path = Path(policy_ref["path"])
                    policy_path = policy_path if policy_path.is_absolute() else base / policy_path
                    raw_policy = policy_path.read_bytes()
                    policy_text = raw_policy.decode("utf-8-sig")
                    if hashlib.sha256(raw_policy).hexdigest() != policy_ref["sha256"]:
                        consolidation_issue(policy_ref, "current policy file hash", ".policy")
                except (OSError, UnicodeError, ValueError) as exc:
                    consolidation_issue(str(exc), "readable current policy file", ".policy")
            archive = consolidation_artifact(consolidation["archive"], ".archive")
            archives = consolidation["context_archives"]
            if not isinstance(archives, list) or not archives:
                consolidation_issue(archives, "nonempty actual original-context archive references", ".context_archives")
            else:
                for ai, ref in enumerate(archives):
                    context_archive = consolidation_artifact(ref, f".context_archives[{ai}]")
                    if not isinstance(context_archive, (dict, list)) or not context_archive:
                        consolidation_issue(ref, "nonempty actual original-context archive", f".context_archives[{ai}]")
            archive_rows = archive.get("facts") if isinstance(archive, dict) else None
            if not isinstance(archive_rows, list):
                consolidation_issue(archive, "classification archive containing exact original facts", ".archive")
                archive_rows = []
            archive_categories = archive.get("categories") if isinstance(archive, dict) else None
            categories_by_id = {}
            if not isinstance(archive_categories, list):
                consolidation_issue(archive_categories, "actual category-to-representative mapping", ".archive.categories")
            else:
                for category in archive_categories:
                    if not isinstance(category, dict) or not _text(category.get("id")) or category["id"] in categories_by_id:
                        consolidation_issue(category, "unique classified policy category", ".archive.categories")
                        continue
                    selected = category.get("selected_facts")
                    if (not _text(category.get("policy_category")) or category["policy_category"] not in policy_text
                            or not isinstance(selected, list) or not 1 <= len(selected) <= 4
                            or not all(isinstance(s, dict) and _text(s.get("text")) for s in selected)):
                        consolidation_issue(category, "current policy category with one to four representative facts", ".archive.categories")
                        continue
                    categories_by_id[category["id"]] = category
            entries = consolidation["entries"]
            if not isinstance(entries, list):
                consolidation_issue(entries, "all previously required entity/fact pairs", ".entries")
                entries = []
            for ei, entry in enumerate(entries):
                loc = f".entries[{ei}]"
                keys = {"entity_index", "fact", "source_refs", "archive_index", "disposition", "categories", "representative_facts", "reason"}
                if not isinstance(entry, dict) or set(entry) != keys or type(entry.get("entity_index")) is not int or not _text(entry.get("fact")):
                    consolidation_issue(entry, "exact per-entity original-fact disposition", loc)
                    continue
                pair = (entry["entity_index"], entry["fact"])
                if pair not in expected_pairs or pair in archived_pairs:
                    consolidation_issue(pair, "each original required entity/fact pair exactly once", loc)
                    continue
                entity = entities[pair[0]]
                if entry["source_refs"] != entity.get("source_refs"):
                    consolidation_issue(entry["source_refs"], "unchanged actual entity source references", loc)
                ai = entry["archive_index"]
                row = archive_rows[ai] if type(ai) is int and 0 <= ai < len(archive_rows) else None
                if (not isinstance(row, dict) or row.get("original_text") != pair[1]
                        or row.get("reason") != entry["reason"] or not _text(entry["reason"])
                        or not _strings(row.get("source_urls"))):
                    consolidation_issue(entry, "exact archived original text, source URLs and actual disposition reason", loc)
                    continue
                disposition = entry["disposition"]
                categories, representatives = entry["categories"], entry["representative_facts"]
                if disposition in ("selected", "selected_partial", "archive_same_category"):
                    if row.get("disposition") != disposition or not _strings(categories) or not _strings(representatives):
                        consolidation_issue(entry, "same classified risk disposition with represented categories", loc)
                        continue
                    category_ids = row.get("category_ids")
                    if not _strings(category_ids) or not all(cid in categories_by_id for cid in category_ids):
                        consolidation_issue(entry, "original fact mapped to actual archive categories", loc)
                        continue
                    mapped_categories = [categories_by_id[cid] for cid in category_ids]
                    mapped_names = [c["policy_category"] for c in mapped_categories]
                    mapped_facts = {s["text"] for c in mapped_categories for s in c["selected_facts"]}
                    if (categories != mapped_names or not set(representatives) <= facts
                            or not set(representatives) <= mapped_facts
                            or not all(any(s["text"] in representatives for s in c["selected_facts"]) for c in mapped_categories)):
                        consolidation_issue(entry, "same archived categories each mapped to exact currently reported representative facts", loc)
                        continue
                    # At most four distinct examples per category/platform are
                    # independently checked by the client v2 release gate.
                elif disposition in ("no_policy_hit", "objective_unavailable"):
                    if row.get("disposition") != disposition or row.get("category_ids") != [] or categories != [] or representatives != []:
                        consolidation_issue(entry, "same contextual non-risk/access closure with no invented category", loc)
                        continue
                else:
                    consolidation_issue(disposition, "completed classification, never pending or omitted", loc)
                    continue
                if valid_binding:
                    archived_pairs.add(pair)
            if archived_pairs != expected_pairs:
                consolidation_issue(sorted(expected_pairs - archived_pairs), "complete classification/archive coverage of every prior required entity/fact pair", ".entries")
    for index, entity in enumerate(entities):
        location = f".entities[{index}]"
        if not isinstance(entity, dict):
            issue("DISCOVERY_ENTITY", location, entity, "entity object", stage="term_extraction")
            continue
        name = entity.get("name")
        aliases = entity.get("aliases", [])
        if not _text(name):
            issue("DISCOVERY_NAME", location + ".name", name, "source name", stage="term_extraction")
        if not _strings(aliases, nonempty=False):
            issue("DISCOVERY_ALIASES", location + ".aliases", aliases, "verified aliases as strings", stage="term_extraction")
            aliases = []
        for label in ([name] if _text(name) else []) + aliases:
            normalized = _name(label)
            if normalized in known_names and known_names[normalized] != index:
                issue("DISCOVERY_AMBIGUOUS_NAME", location, label, "one uniquely resolved entity per name/verified alias", stage="term_extraction")
            known_names[normalized] = index
        if not _strings(entity.get("source_refs")):
            issue("DISCOVERY_ENTITY_SOURCE", location + ".source_refs", entity.get("source_refs"), "actual mention locator", stage="term_extraction")
        disposition = entity.get("disposition")
        # Unknown meaning is an input to client questioning, not incomplete research.
        # Existing verified risk facts still reconcile with the final report below.
        if disposition == "record":
            entity_facts = entity.get("record_facts", [entity.get("record_fact")])
            if not _strings(entity_facts) or reported_facts is None:
                issue("DISCOVERY_RECORD_REQUIRED", location + ".record_facts", entity_facts, "nonempty verified facts and final reported_facts for reconciliation", stage="final_report")
            else:
                if "record_fact" in entity and (not _text(entity["record_fact"]) or entity["record_fact"] not in entity_facts):
                    issue("DISCOVERY_RECORD_CONFLICT", location + ".record_fact", entity["record_fact"], "legacy record_fact must agree with record_facts", stage="final_report")
                for fact in entity_facts:
                    if fact not in facts and (index, fact) not in archived_pairs:
                        issue("DISCOVERY_REPORT_OMISSION", location + ".record_facts", fact, "same fact in final conclusions", stage="final_report")
    for name in sorted(extracted_names - set(known_names)):
        issue("DISCOVERY_UNRESOLVED_NAME", ".semantic_review.items.names", name, "resolved entity entry or verified alias", stage="term_extraction")

    reverse = review.get("reverse_pass")
    reverse = reverse if isinstance(reverse, dict) else {}
    if reverse.get("status") != "complete" or not _strings(reverse.get("names"), nonempty=False):
        issue("DISCOVERY_REVERSE_REVIEW", ".reverse_pass", reverse, "completed source-first reverse review with actual names", stage="reverse_review")
    reverse_names = {_name(name) for name in reverse.get("names", []) if _text(name)} if isinstance(reverse.get("names"), list) else set()
    for name in sorted(reverse_names - set(known_names)):
        issue("DISCOVERY_UNRESOLVED_NAME", ".reverse_pass.names", name, "resolved entity entry or verified alias", stage="term_extraction")
    extracted_entities = {known_names[name] for name in extracted_names if name in known_names}
    reversed_entities = {known_names[name] for name in reverse_names if name in known_names}
    if extracted_entities != set(range(len(entities))):
        issue("DISCOVERY_EXTRACTION_COVERAGE", ".semantic_review.items.names", sorted(extracted_entities), "every entity grounded in item-level extraction", stage="term_extraction")
    if reversed_entities != extracted_entities:
        issue("DISCOVERY_REVERSE_COVERAGE", ".reverse_pass.names", sorted(reversed_entities), "reverse-review every extracted entity", stage="reverse_review")
    if not errors and not blocked:
        info.append("DISCOVERY_STATE_PASS: source bytes, item coverage and noun/source mapping are consistent; no all-term queries or query child required; cognition, all-term recall and tool-message authenticity require actual review")
    return result()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, type=Path)
    args = parser.parse_args()
    try:
        state = json.loads(args.state.read_text(encoding="utf-8-sig"))
        if not isinstance(state, dict):
            raise ValueError("state must be an object")
        output = audit_discovery_review(state.get("discovery_review"), reported_facts=state.get("reported_facts"), base_dir=args.state.parent, consolidation=state.get("consolidation"))
    except (OSError, ValueError, TypeError) as exc:
        output = {"verdict": "FAIL", "research_assessed": False, "repair_stage": "source_collection",
                  "errors": [{"code": "DISCOVERY_INPUT", "actual": str(exc), "repair_stage": "source_collection"}], "blocked": [], "info": []}
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if output["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
