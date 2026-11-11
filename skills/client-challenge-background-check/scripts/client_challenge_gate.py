#!/usr/bin/env python3
"""Audit client-challenge v2: full noun review, contextual follow-up archives,
policy categories and sampled reporting. See references/review-contract.md.
All prior round, source, identity and final-revision checks remain in force.
The optional historical_v1 API flag only replays old archived receipts; normal
release and the CLI require v2 and cannot use per-noun inclusion as a substitute.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

LABELS = {"疑问", "警惕", "放松"}
REJECTION = "包含不合规的表述，拒绝接受"
ANSWER_FIELDS = {"被问词", "出现链接", "出现原文", "上下文", "释义词所指代的对象", "实际含义"}
TEXT_KEYS = ("text", "heading1", "heading2", "heading3", "heading4", "heading5",
             "heading6", "heading7", "heading8", "heading9", "bullet", "ordered", "page")


def document_sha256(items: list[dict[str, Any]]) -> str:
    """Hash the complete current block array, preserving its order."""
    return hashlib.sha256(json.dumps(items, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def discovery_sha256(discovery_review: dict[str, Any]) -> str:
    """Bind the whole validated discovery review, not only its declared IDs."""
    return hashlib.sha256(json.dumps(discovery_review, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _hash(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _url(value: Any) -> bool:
    if not _text(value):
        return False
    try:
        parsed = urlparse(value)
        return parsed.scheme in ("https", "http") and bool(parsed.netloc) and not any(c.isspace() for c in value)
    except ValueError:
        return False


def _block_text(block: dict[str, Any]) -> str:
    for key in TEXT_KEYS:
        value = block.get(key)
        if isinstance(value, dict) and isinstance(value.get("elements"), list):
            chunks = []
            for element in value["elements"]:
                if not isinstance(element, dict):
                    continue
                for kind, field in (("text_run", "content"), ("mention_doc", "title"), ("mention_user", "user_id")):
                    if isinstance(element.get(kind), dict):
                        chunks.append(str(element[kind].get(field, "")))
            return "".join(chunks)
    return ""


def _source_urls(value: Any) -> set[str]:
    """Read source locator fields, excluding arbitrary image/media URLs."""
    result: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ("source_ref", "source_refs", "source_url", "url", "permalink", "canonical_url", "post_url", "web_url"):
                for candidate in child if isinstance(child, list) else [child]:
                    if _url(candidate):
                        result.add(candidate)
            if isinstance(child, (dict, list)):
                result.update(_source_urls(child))
    elif isinstance(value, list):
        for child in value:
            result.update(_source_urls(child))
    return result


def _source_texts(value: Any) -> set[str]:
    """Full acquired text values only; quoted evaluations remain original text."""
    if isinstance(value, str):
        return {value} if _text(value) else set()
    result: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ("full_text", "text", "content", "body", "title", "description", "transcript") and _text(child):
                result.add(child)
            elif key == "segments" and isinstance(child, list) and child and all(_text(segment) for segment in child):
                # Browser-captured video transcripts preserve each timestamped
                # segment verbatim. Accept their complete ordered transcription,
                # not a clipped or reordered excerpt.
                result.add("\n".join(child))
            elif isinstance(child, (dict, list)):
                result.update(_source_texts(child))
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, (dict, list)):
                result.update(_source_texts(child))
    return result


class _ArtifactUnavailable(Exception):
    def __init__(self, report: dict[str, Any]):
        self.report = report


def _primary_post(value: Any) -> tuple[str, str] | None:
    """Identify a primary X post, never a quoted/link-list target."""
    if not isinstance(value, dict):
        return None
    raw = next((value.get(key) for key in ("url", "source_url", "source_ref")
                if _url(value.get(key))), None)
    if raw is None:
        return None
    parsed = urlparse(raw)
    parts = parsed.path.strip("/").split("/")
    if (parsed.hostname not in ("x.com", "www.x.com", "twitter.com", "www.twitter.com")
            or len(parts) not in (3, 5) or parts[1] != "status" or not parts[2].isdigit()
            or (len(parts) == 5 and (parts[3] not in ("photo", "video") or not parts[4].isdigit()))):
        return None
    return parts[0].casefold(), parts[2]


def _occurrence_texts(value: Any, source_rows: dict) -> set[str]:
    """Media observations may quote a full capture of the identical parent post.

    The original batch stays immutable. No excerpt, neighbouring post, quoted
    target, or invented transcription is added to the accepted text set.
    """
    result = _source_texts(value)
    if not isinstance(value, dict) or not any(value.get(k) for k in ("image_ref", "images")):
        return result
    post = _primary_post(value)
    if post is not None:
        for candidate in source_rows.values():
            if _primary_post(candidate) == post:
                result.update(_source_texts(candidate))
    # A media recovery may explicitly point back to a captured quote-post that
    # contains the exact image URL. Preserve the whole quote and author boundary.
    ref = value.get("source_ref", "")
    match = re.fullmatch(r"(.+?)(?:\.json#items\[(\d+)\]|:(\d+))", ref) if isinstance(ref, str) else None
    if match:
        candidate = source_rows.get((match[1], int(match[2] or match[3])))
        if value.get("url") in _source_urls(candidate):
            result.update(_source_texts(candidate))
    return result


def audit_client_challenge(review: Any, *, discovery_review: Any, items: Any,
                           document_token: Any, revision_id: Any, required_policy_path: Path,
                           base_dir: Path | None = None, historical_v1: bool = False) -> dict[str, Any]:
    """Fail closed on inconsistent evidence; retain genuine file access failures."""
    try:
        return _audit_client_challenge(review, discovery_review=discovery_review, items=items,
            document_token=document_token, revision_id=revision_id,
            required_policy_path=required_policy_path, base_dir=base_dir, historical_v1=historical_v1)
    except _ArtifactUnavailable as exc:
        return exc.report


def _audit_client_challenge(review: Any, *, discovery_review: Any, items: Any,
                            document_token: Any, revision_id: Any, required_policy_path: Path,
                            base_dir: Path | None = None, historical_v1: bool = False) -> dict[str, Any]:
    errors: list[dict[str, str]] = []
    blocked: list[dict[str, str]] = []
    info = ["Evidence consistency only: file hashes cannot authenticate collaboration actions, "
            "prove no omitted real rounds, or certify semantic attribution/private-sensitive inference safety."]
    triggered: set[str] = set()
    ever_alert: set[str] = set()
    base = Path(base_dir) if base_dir is not None else Path.cwd()

    def issue(code: str, location: str, actual: Any, expected: str, *, inaccessible: bool = False) -> None:
        (blocked if inaccessible else errors).append({"code": "CHALLENGE_" + code,
            "location": "client_challenge_review" + location, "actual": str(actual), "expected": expected})

    def result() -> dict[str, Any]:
        return {"verdict": "FAIL" if errors else "BLOCKED" if blocked else "PASS",
                "errors": errors, "blocked": blocked, "info": info,
                "triggered_term_ids": sorted(triggered), "ever_alert_ids": sorted(ever_alert)}

    def read_bytes(ref: Any, location: str, *, required_path: Path | None = None) -> bytes | None:
        if not isinstance(ref, dict) or set(ref) != {"path", "sha256"} or not _text(ref.get("path")) or not _hash(ref.get("sha256")):
            issue("ARTIFACT_REF", location, ref, "exact {path,sha256} with actual byte hash")
            return None
        try:
            path = Path(ref["path"])
            path = (path if path.is_absolute() else base / path).resolve()
            if required_path is not None and path != Path(required_path).resolve():
                issue("POLICY_PATH", location, path, f"current required policy {required_path}")
            raw = path.read_bytes()
        except FileNotFoundError:
            issue("ARTIFACT_MISSING", location, ref["path"], "existing evidence artifact")
            return None
        except (ValueError, TypeError) as exc:
            issue("ARTIFACT_PATH", location, exc, "valid artifact path")
            return None
        except OSError as exc:
            issue("ARTIFACT_INACCESSIBLE", location, exc, "readable evidence artifact", inaccessible=True)
            raise _ArtifactUnavailable(result()) from exc
        if hashlib.sha256(raw).hexdigest() != ref["sha256"]:
            issue("ARTIFACT_HASH", location, ref["sha256"], "SHA-256 of actual current bytes")
        return raw

    def no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, child in pairs:
            if key in value:
                raise ValueError("duplicate JSON key: " + key)
            value[key] = child
        return value

    def artifact(ref: Any, location: str) -> Any:
        raw = read_bytes(ref, location)
        if raw is None:
            return None
        try:
            return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=no_duplicate_keys,
                              parse_constant=lambda x: (_ for _ in ()).throw(ValueError("invalid JSON constant " + x)))
        except (UnicodeError, ValueError, TypeError, RecursionError) as exc:
            issue("ARTIFACT_JSON", location, exc, "complete JSON without duplicate keys or nonstandard constants")
            return None

    def stamp(value: Any, location: str) -> datetime | None:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if _text(value) else None
            if parsed is None or parsed.tzinfo is None or parsed.utcoffset() is None:
                raise ValueError("timezone required")
            return parsed
        except (ValueError, TypeError, OverflowError) as exc:
            issue("TIMESTAMP", location, value, "actual ISO timestamp with timezone: " + str(exc))
            return None

    def exact(value: Any, expected: dict[str, Any], location: str, code: str = "PROOF") -> None:
        if not isinstance(value, dict) or json.dumps(value, ensure_ascii=False, sort_keys=True) != json.dumps(expected, ensure_ascii=False, sort_keys=True):
            issue(code, location, value, "exact evidence binding " + json.dumps(expected, ensure_ascii=False))

    def ids(value: Any, location: str, expected: set[str]) -> None:
        if not isinstance(value, list) or not all(_text(v) for v in value) or len(value) != len(set(v for v in value if _text(v))) or set(v for v in value if _text(v)) != expected:
            issue("TRIGGER_SET", location, value, "exact required IDs " + str(sorted(expected)))

    if not isinstance(review, dict):
        issue("REVIEW_REQUIRED", "", type(review).__name__, "version 2 standalone post-final-review evidence")
        return result()
    if type(review.get("version")) is not int or review.get("version") not in ({1, 2} if historical_v1 else {2}):
        issue("VERSION", ".version", review.get("version"), "2 for current release; v1 only with explicit historical replay API")
        return result()
    if not isinstance(discovery_review, dict) or discovery_review.get("mode") != "assistant_research":
        issue("DISCOVERY", ".discovery_review", discovery_review, "current assistant_research discovery; caller exempts delivery-only scope")
        return result()
    discovery = discovery_review
    for key in ("task_id", "source_revision"):
        if not _text(review.get(key)) or review.get(key) != discovery.get(key):
            issue("SOURCE_BINDING", "." + key, review.get(key), "current discovery " + key)
    if discovery.get("source_revision") != discovery.get("reviewed_revision"):
        issue("SOURCE_BINDING", ".discovery_review.reviewed_revision", discovery.get("reviewed_revision"), "current discovery source_revision")
    for key, expected in (("document_token", document_token), ("revision_id", revision_id)):
        if review.get(key) != expected or type(review.get(key)) is not type(expected) or expected is None or (key == "document_token" and not _text(expected)):
            issue("DOCUMENT_BINDING", "." + key, review.get(key), "current document " + str(expected))
    policy_raw = read_bytes(review.get("policy"), ".policy", required_path=required_policy_path)
    expected_policy_sha = hashlib.sha256(policy_raw).hexdigest() if policy_raw is not None else None
    nouns = artifact(review.get("nouns"), ".nouns")
    first_input = artifact(review.get("first_input"), ".first_input")
    entities = discovery.get("entities")
    if not isinstance(entities, list) or not entities:
        issue("NOUN_EXPORT", ".discovery_review.entities", entities, "current nonempty discovery entities")
        entities = []
    expected_names: set[str] = set()
    name_entities: dict[str, int] = {}
    for index, entity in enumerate(entities):
        if not isinstance(entity, dict) or not _text(entity.get("name")) or not isinstance(entity.get("aliases", []), list) or not all(_text(a) for a in entity.get("aliases", [])):
            issue("NOUN_EXPORT", f".discovery_review.entities[{index}]", entity, "named entity with raw canonical name and aliases")
            continue
        for name in [entity["name"]] + entity.get("aliases", []):
            expected_names.add(name)
            normalized = _name(name)
            if normalized in name_entities and name_entities[normalized] != index:
                issue("NOUN_AMBIGUITY", ".discovery_review.entities", name, "one resolved entity per name/alias")
            name_entities[normalized] = index
    term_entities: dict[str, int] = {}
    names_seen: set[str] = set()
    if not isinstance(nouns, list) or not nouns:
        issue("NOUN_EXPORT", ".nouns", nouns, "full nonempty exact {id,name} list")
        nouns = []
    for index, row in enumerate(nouns):
        if not isinstance(row, dict) or set(row) != {"id", "name"} or not _text(row.get("id")) or not _text(row.get("name")):
            issue("NOUN_EXPORT", f".nouns[{index}]", row, "exact {id,name}")
            continue
        if row["id"] in term_entities or row["name"] in names_seen or row["name"] not in expected_names:
            issue("NOUN_EXPORT", f".nouns[{index}]", row, "unique ID and exact current raw name")
        names_seen.add(row["name"])
        if _name(row["name"]) in name_entities:
            term_entities[row["id"]] = name_entities[_name(row["name"])]
    if names_seen != expected_names:
        issue("NOUN_EXPORT", ".nouns", sorted(names_seen), "all current canonical names and aliases; reopen discovery on changed list")
    if first_input != nouns:
        issue("FIRST_INPUT", ".first_input", first_input, "only full exported {id,name} rows; no report, conclusions or research cache")
    term_ids = set(term_entities)
    term_order = [row["id"] for row in nouns if isinstance(row, dict) and _text(row.get("id"))]
    term_names = {row["id"]: row["name"] for row in nouns if isinstance(row, dict) and _text(row.get("id")) and _text(row.get("name"))}
    names_to_ids = {name: term_id for term_id, name in term_names.items()}

    semantic = discovery.get("semantic_review")
    semantic = semantic if isinstance(semantic, dict) else {}
    batches = semantic.get("source_batches")
    source_rows: dict[tuple[str, int], Any] = {}
    for index, batch in enumerate(batches if isinstance(batches, list) else []):
        if not isinstance(batch, dict) or not _text(batch.get("batch_id")) or not _text(batch.get("items_key")):
            issue("SOURCE_ROWS", f".source_batches[{index}]", batch, "current source batch binding")
            continue
        source = artifact({"path": batch.get("path"), "sha256": batch.get("sha256")}, f".source_batches[{index}]")
        rows = source.get(batch["items_key"]) if isinstance(source, dict) else None
        if not isinstance(rows, list):
            issue("SOURCE_ROWS", f".source_batches[{index}]", rows, "actual full source rows")
            continue
        for item_index, raw in enumerate(rows):
            pair = (batch["batch_id"], item_index)
            if pair in source_rows:
                issue("SOURCE_ROWS", ".source_batches", pair, "each source pair once")
            source_rows[pair] = raw
    occurrences: dict[int, set[tuple[str, int]]] = {index: set() for index in range(len(entities))}
    semantic_rows = semantic.get("items")
    semantic_seen: set[tuple[str, int]] = set()
    for row in semantic_rows if isinstance(semantic_rows, list) else []:
        if not isinstance(row, dict) or not _text(row.get("batch_id")) or type(row.get("item_index")) is not int or row["item_index"] < 0 or not isinstance(row.get("names"), list) or not all(_text(n) for n in row["names"]):
            issue("OCCURRENCES", ".discovery_review.semantic_review.items", row, "current semantic row with batch_id/item_index/names")
            continue
        pair = (row["batch_id"], row["item_index"])
        if pair in semantic_seen or pair not in source_rows:
            issue("OCCURRENCES", ".discovery_review.semantic_review.items", pair, "each actual source pair once")
        semantic_seen.add(pair)
        for name in row["names"]:
            entity_index = name_entities.get(_name(name))
            if entity_index is None:
                issue("NOUN_EXPORT", ".discovery_review.semantic_review.items.names", name, "resolved noun export; reopen upstream")
            else:
                occurrences[entity_index].add(pair)
    if semantic_seen != set(source_rows) or not source_rows:
        issue("OCCURRENCES", ".discovery_review.semantic_review.items", sorted(semantic_seen), "semantic rows for all current sources")
    for term_id, entity_index in term_entities.items():
        if not occurrences.get(entity_index):
            issue("OCCURRENCES", ".nouns." + term_id, [], "at least one source occurrence of the resolved entity")

    current_risk_locations: list[dict[str, Any]] = []
    expected_discovery_binding = {"task_id": discovery.get("task_id"), "source_revision": discovery.get("source_revision"),
                                  "discovery_sha256": discovery_sha256(discovery)}
    # A checked disambiguation can change metadata while the acquired material,
    # exported vocabulary and one child conversation remain the same. Preserve
    # old answers against their actual input rather than rewriting history.
    correction = review.get("discovery_correction")
    previous_discovery = discovery
    previous_occurrences = occurrences
    correction_from = None
    if correction is not None:
        if not isinstance(correction, dict) or set(correction) != {"previous_discovery", "revalidated_review", "applies_from_answer", "reason", "evidence_refs"}:
            issue("DISCOVERY_CORRECTION", ".discovery_correction", correction, "versioned metadata correction with original discovery, full revalidation, answer boundary, reason and evidence")
            correction = {}
        candidate = artifact(correction.get("previous_discovery"), ".discovery_correction.previous_discovery")
        correction_from = correction.get("applies_from_answer")
        if type(correction_from) is not int or not 2 <= correction_from <= 4:
            issue("DISCOVERY_CORRECTION", ".discovery_correction.applies_from_answer", correction_from, "answer 2..4, followed by another real child round within five")
            correction_from = None
        if not _text(correction.get("reason")) or not isinstance(correction.get("evidence_refs"), list) or not correction.get("evidence_refs") or not all(_text(x) for x in correction.get("evidence_refs", [])):
            issue("DISCOVERY_CORRECTION", ".discovery_correction", correction, "specific corrected fact and actual verification references")
        if isinstance(candidate, dict):
            old_semantic = candidate.get("semantic_review", {})
            old_entities = candidate.get("entities", [])
            old_names = [(e.get("name"), e.get("aliases", [])) for e in old_entities if isinstance(e, dict)]
            new_names = [(e.get("name"), e.get("aliases", [])) for e in entities]
            if any(candidate.get(k) != discovery.get(k) for k in ("version", "mode", "task_id", "source_revision", "reviewed_revision", "primary_agent_id")) or old_names != new_names or old_semantic.get("source_batches") != semantic.get("source_batches"):
                issue("DISCOVERY_CORRECTION_SCOPE", ".discovery_correction.previous_discovery", None, "unchanged task, source version, acquired batches and ordered names/aliases; metadata-only correction")
            old_rows = old_semantic.get("items", [])
            old_pairs = [(r.get("batch_id"), r.get("item_index")) for r in old_rows if isinstance(r, dict)]
            if len(old_pairs) != len(set(old_pairs)) or set(old_pairs) != set(source_rows):
                issue("DISCOVERY_CORRECTION_SCOPE", ".discovery_correction.previous_discovery", None, "same complete source-pair coverage")
            previous_discovery = candidate
            previous_occurrences = {i: set() for i in range(len(entities))}
            for row in old_rows:
                if not isinstance(row, dict) or not isinstance(row.get("names"), list):
                    issue("DISCOVERY_CORRECTION_SCOPE", ".discovery_correction.previous_discovery", row, "valid original semantic names")
                    continue
                for name in row["names"]:
                    entity_index = name_entities.get(_name(name)) if isinstance(name, str) else None
                    if entity_index is None:
                        issue("DISCOVERY_CORRECTION_SCOPE", ".discovery_correction.previous_discovery", name, "original name in unchanged exported vocabulary")
                    else:
                        previous_occurrences[entity_index].add((row.get("batch_id"), row.get("item_index")))
        else:
            issue("DISCOVERY_CORRECTION", ".discovery_correction.previous_discovery", candidate, "actual frozen discovery JSON")
    initial_discovery_binding = {"task_id": previous_discovery.get("task_id"), "source_revision": previous_discovery.get("source_revision"), "discovery_sha256": discovery_sha256(previous_discovery)}

    def audit_receipt(ref: Any, location: str, *, current: bool, initial: bool = False) -> datetime | None:
        receipt_artifact = artifact(ref, location)
        if not isinstance(receipt_artifact, dict):
            issue("FINAL_REVIEW", location, receipt_artifact, "actual successful full final audit artifact")
            return None
        doc = receipt_artifact.get("document")
        receipt = receipt_artifact.get("receipt")
        doc = doc if isinstance(doc, dict) else {}
        receipt = receipt if isinstance(receipt, dict) else {}
        expected_revision = revision_id if current else doc.get("revision_id")
        if (receipt_artifact.get("verdict") != "PASS" or receipt_artifact.get("errors") != [] or receipt_artifact.get("blocked") != []
                or doc.get("token") != document_token or not (type(expected_revision) is int and expected_revision >= 0 or _text(expected_revision))
                or doc.get("revision_id") != expected_revision or type(doc.get("revision_id")) is not type(expected_revision) or receipt.get("verdict") != "PASS"
                or receipt.get("token") != document_token or receipt.get("revision_id") != expected_revision or type(receipt.get("revision_id")) is not type(expected_revision)
                or not _hash(receipt_artifact.get("document_sha256"))
                or receipt.get("document_sha256") != receipt_artifact.get("document_sha256")):
            issue("FINAL_REVIEW", location, receipt_artifact, "full PASS artifact with empty errors/blocked and matching document/receipt/hash")
        if current and isinstance(items, list) and receipt_artifact.get("document_sha256") != document_sha256(items):
            issue("FINAL_REVIEW_STALE", location, receipt_artifact.get("document_sha256"), "hash of complete current document items")
        for holder, suffix in ((receipt_artifact, ""), (receipt, ".receipt")):
            exact(holder.get("discovery_binding"), initial_discovery_binding if initial else expected_discovery_binding, location + suffix + ".discovery_binding", "FINAL_REVIEW_SCOPE")
            if holder.get("policy_sha256") != expected_policy_sha or not _hash(holder.get("policy_sha256")):
                issue("FINAL_REVIEW_POLICY", location + suffix + ".policy_sha256", holder.get("policy_sha256"), "actual current policy hash " + str(expected_policy_sha))
        risk_locations = receipt_artifact.get("risk_locations")
        if not isinstance(risk_locations, list) or json.dumps(risk_locations, ensure_ascii=False, sort_keys=True) != json.dumps(receipt.get("risk_locations"), ensure_ascii=False, sort_keys=True):
            issue("FINAL_REVIEW_RISK_LOCATIONS", location, risk_locations, "identical risk_locations arrays in full audit root and receipt")
            risk_locations = []
        for index, risk in enumerate(risk_locations):
            valid = (isinstance(risk, dict) and set(risk) == {"risk_group_index", "summary_location", "platform_location"}
                     and type(risk.get("risk_group_index")) is int and risk["risk_group_index"] >= 0)
            if valid:
                for key in ("summary_location", "platform_location"):
                    value = risk.get(key)
                    valid = valid and isinstance(value, dict) and set(value) == {"block_id", "text"} and _text(value.get("block_id")) and _text(value.get("text"))
            if not valid:
                issue("FINAL_REVIEW_RISK_LOCATIONS", location + f".risk_locations[{index}]", risk, "audited risk group with exact summary/platform block bindings")
            elif current:
                current_risk_locations.append(risk)
        return stamp(receipt.get("generated_at"), location + ".receipt.generated_at")

    initial_time = audit_receipt(review.get("initial_final_review"), ".initial_final_review", current=False, initial=True)
    current_time = audit_receipt(review.get("current_final_review"), ".current_final_review", current=True)
    correction_time = audit_receipt(correction.get("revalidated_review"), ".discovery_correction.revalidated_review", current=False) if correction is not None else None
    child = review.get("child")
    child = child if isinstance(child, dict) else {}
    child_id = child.get("agent_id")
    discovery_child = discovery.get("subagent_review")
    discovery_child = discovery_child if isinstance(discovery_child, dict) else {}
    reserved = [discovery.get("primary_agent_id"), discovery_child.get("agent_id")]
    if (not _text(child_id) or child_id in reserved or child.get("created_agent_ids") != [child_id]
            or child.get("fork_turns") != "none" or not all(_text(a) for a in reserved)):
        issue("CHILD_IDENTITY", ".child", child, "exactly one new fork_turns=none child distinct from main and discovery child")
    if not _text(child.get("spawn_ref")):
        issue("SPAWN_REF", ".child.spawn_ref", child.get("spawn_ref"), "actual collaboration spawn message reference")
    spawned = stamp(child.get("spawned_at"), ".child.spawned_at")
    if initial_time and spawned and initial_time >= spawned:
        issue("ORDER", ".child.spawned_at", child.get("spawned_at"), "strictly after initial final-review PASS")
    policy = review.get("policy") if isinstance(review.get("policy"), dict) else {}
    first = review.get("first_input") if isinstance(review.get("first_input"), dict) else {}
    common = {"task_id": review.get("task_id"), "source_revision": review.get("source_revision"), "agent_id": child_id}
    exact(artifact(child.get("proof"), ".child.proof"), {**common, "fork_turns": "none", "spawn_ref": child.get("spawn_ref"),
          "spawned_at": child.get("spawned_at"), "first_input_sha256": first.get("sha256"), "policy_sha256": policy.get("sha256")}, ".child.proof")

    def check_occurrences(rows: Any, term_id: str, location: str, *, inclusion: bool = False) -> None:
        expected = occurrences.get(term_entities.get(term_id, -1), set())
        covered: set[tuple[str, int]] = set()
        if not isinstance(rows, list) or not rows:
            issue("OCCURRENCE_COVERAGE", location, rows, "all source occurrence pairs with actual links")
            return
        for index, occurrence in enumerate(rows):
            loc = location + f"[{index}]"
            keys = {"batch_id", "item_index", "source_url", "platform", "link"} if inclusion else {"batch_id", "item_index", "source_url", "context"}
            allowed_keys = (keys, keys | {"summary"}) if inclusion else (keys,)
            if not isinstance(occurrence, dict) or set(occurrence) not in allowed_keys or not _text(occurrence.get("batch_id")) or type(occurrence.get("item_index")) is not int:
                issue("OCCURRENCE", loc, occurrence, "exact occurrence fields with batch_id and integer item_index")
                continue
            pair = (occurrence["batch_id"], occurrence["item_index"])
            if pair in covered or pair not in expected:
                issue("OCCURRENCE_COVERAGE", loc, pair, "each applicable semantic occurrence once")
            covered.add(pair)
            url = occurrence.get("source_url")
            if not _url(url) or url not in _source_urls(source_rows.get(pair)):
                issue("SOURCE_LINK", loc + ".source_url", url, "actual http(s) source locator in the acquired row")
            if inclusion:
                if "summary" in occurrence:
                    summary_block = binding(occurrence["summary"], loc + ".summary")
                    if summary_block is not None and _url(_block_text(summary_block).strip()):
                        issue("RISK_TEXT", loc + ".summary", _block_text(summary_block), "actual audited risk summary text, not a URL-only block")
                binding(occurrence.get("platform"), loc + ".platform")
                link_block = binding(occurrence.get("link"), loc + ".link")
                if link_block is not None and _url(url) and url not in _block_text(link_block) and url not in _source_urls(link_block):
                    issue("DOCUMENT_LINK", loc + ".link", url, "source URL in current block text or hyperlink target")
            elif not _text(occurrence.get("context")):
                issue("ANSWER_DETAIL", loc + ".context", occurrence.get("context"), "source occurrence context with honest attribution and unknowns")
        if covered != expected:
            issue("OCCURRENCE_COVERAGE", location, sorted(covered), "all semantic occurrence pairs " + str(sorted(expected)))

    rounds = review.get("rounds")
    if not isinstance(rounds, list) or not 1 <= len(rounds) <= 5:
        issue("ROUND_COUNT", ".rounds", len(rounds) if isinstance(rounds, list) else rounds, "1..5 total batches across the task, without reset")
        rounds = rounds if isinstance(rounds, list) else []
    ledger_rounds = []
    prior_answer_hash = first.get("sha256")
    prior_time = spawned
    prior_answers: dict[str, dict[str, Any]] = {}
    accepted_answers: dict[str, list[dict[str, Any]]] = {}
    final_doubts: set[str] = set()
    result_refs: set[str] = set()
    latest_occurrences = occurrences
    for index, round_row in enumerate(rounds, 1):
        occurrences = previous_occurrences if correction_from is not None and index < correction_from else latest_occurrences
        loc = f".rounds[{index - 1}]"
        if not isinstance(round_row, dict):
            issue("ROUND", loc, round_row, "round evidence object")
            continue
        if type(round_row.get("index")) is not int or round_row.get("index") != index:
            issue("ROUND_ORDER", loc, round_row.get("index"), "contiguous task-wide batch index " + str(index))
        result_ref = round_row.get("result_ref")
        if not _text(result_ref) or result_ref in result_refs:
            issue("RESULT_REF", loc + ".result_ref", result_ref, "distinct actual child result message reference")
        elif _text(result_ref):
            result_refs.add(result_ref)
        response_time = stamp(round_row.get("responded_at"), loc + ".responded_at")
        answer_time = stamp(round_row.get("answered_at"), loc + ".answered_at")
        if correction_from == index and (correction_time is None or response_time is None or answer_time is None or not response_time <= correction_time <= answer_time):
            issue("DISCOVERY_CORRECTION_ORDER", loc, correction_time, "actual corrected discovery full revalidation after this response and before the corrected answer")
        if response_time and prior_time and response_time <= prior_time or answer_time and response_time and answer_time < response_time:
            issue("ORDER", loc, round_row.get("responded_at"), "response after prior input and main answer after response")
        prior_time = answer_time
        response_ref = round_row.get("response") if isinstance(round_row.get("response"), dict) else {}
        answer_ref = round_row.get("answer") if isinstance(round_row.get("answer"), dict) else {}
        exact(artifact(round_row.get("proof"), loc + ".proof"), {**common, "index": index,
              "result_ref": result_ref, "responded_at": round_row.get("responded_at"),
              "response_sha256": response_ref.get("sha256"), "input_sha256": prior_answer_hash}, loc + ".proof")
        response = artifact(round_row.get("response"), loc + ".response")
        actual_order = [row.get("id") if isinstance(row, dict) else None for row in response] if isinstance(response, list) else None
        if actual_order != term_order:
            issue("RESPONSE_ORDER", loc + ".response", actual_order, "complete ID sequence in original noun order " + str(term_order))
        seen: set[str] = set()
        required_answers: set[str] = set()
        rejected: set[str] = set()
        current_doubts: set[str] = set()
        for row in response if isinstance(response, list) else []:
            is_attitude = isinstance(row, dict) and set(row) == {"id", "态度"} and isinstance(row.get("态度"), str) and row["态度"] in LABELS
            is_rejection = isinstance(row, dict) and set(row) == {"id", "拒绝"} and row.get("拒绝") == REJECTION
            if not (is_attitude or is_rejection) or not _text(row.get("id")):
                issue("RESPONSE_SHAPE", loc + ".response", row, "only exact {id,态度} with three labels or exact {id,拒绝} with fixed refusal text")
                continue
            term_id = row["id"]
            if term_id in seen or term_id not in term_ids:
                issue("RESPONSE_COVERAGE", loc + ".response", term_id, "every exported term exactly once")
            seen.add(term_id)
            if is_rejection:
                rejected.add(term_id)
                required_answers.add(term_id)
                if term_id in prior_answers:
                    accepted_answers[term_id] = [accepted for accepted in accepted_answers.get(term_id, [])
                                                 if accepted != prior_answers[term_id]]
                if index == 1 or term_id not in prior_answers:
                    issue("REJECTION_INPUT", loc + ".response", term_id, "only a corresponding main answer can be rejected; first input contains names alone")
            else:
                if term_id in prior_answers:
                    accepted_answers.setdefault(term_id, []).append(prior_answers[term_id])
                if row["态度"] != "放松":
                    required_answers.add(term_id)
                if row["态度"] == "警惕":
                    ever_alert.add(term_id)
                elif row["态度"] == "疑问":
                    current_doubts.add(term_id)
        final_doubts = current_doubts
        triggered.clear()
        triggered.update(ever_alert | final_doubts)
        if index == len(rounds) and rejected:
            issue("FINAL_REJECTION", loc + ".response", sorted(rejected), "clean rewritten answer accepted in a remaining child batch; total never exceeds five")
        if not isinstance(response, list) or seen != term_ids:
            issue("RESPONSE_COVERAGE", loc + ".response", sorted(seen), "every exported ID once " + str(sorted(term_ids)))
        answers = artifact(round_row.get("answer"), loc + ".answer")
        answered: set[str] = set()
        current_answers: dict[str, dict[str, Any]] = {}
        if not isinstance(answers, list):
            issue("ANSWER_COVERAGE", loc + ".answer", answers, "array answering every and only this batch's non-relaxed or rejected terms")
        for answer in answers if isinstance(answers, list) else []:
            if not isinstance(answer, dict) or set(answer) != ANSWER_FIELDS or not _text(answer.get("被问词")):
                issue("ANSWER_SHAPE", loc + ".answer", answer, "ONLY 被问词/出现链接/出现原文/上下文/释义词所指代的对象/实际含义; no IDs or evaluative extra fields")
                continue
            term_id = names_to_ids.get(answer["被问词"])
            if term_id is None:
                issue("ANSWER_COVERAGE", loc + ".answer", answer["被问词"], "exact name of a required exported term")
                continue
            if term_id in answered or term_id not in required_answers:
                issue("ANSWER_COVERAGE", loc + ".answer", term_id, "each and only this batch's non-relaxed or rejected term")
            answered.add(term_id)
            current_answers[term_id] = answer
            if term_id in rejected and answer == prior_answers.get(term_id):
                issue("REJECTION_NOT_REWRITTEN", loc + ".answer", term_id, "rewrite rejected main-owned wording before another child response")
            for field in ("释义词所指代的对象", "实际含义"):
                if not _text(answer.get(field)):
                    issue("ANSWER_DETAIL", loc + ".answer." + field, answer.get(field), "factual object/meaning without defense, risk downgrading or assistant judgments")
            pairs = sorted(occurrences.get(term_entities.get(term_id, -1), set()))
            arrays_valid = True
            for field in ("出现链接", "出现原文", "上下文"):
                array = answer.get(field)
                if not isinstance(array, list) or not array or len(array) != len(pairs) or not all(_text(v) for v in array):
                    issue("OCCURRENCE_COVERAGE", loc + ".answer." + field, array, "one nonempty string per sorted semantic occurrence " + str(pairs))
                    arrays_valid = False
            if arrays_valid:
                for occurrence_index, pair in enumerate(pairs):
                    if answer["出现链接"][occurrence_index] not in _source_urls(source_rows.get(pair)):
                        issue("SOURCE_LINK", loc + ".answer.出现链接", answer["出现链接"][occurrence_index], "actual acquired source URL for " + str(pair))
                    if answer["出现原文"][occurrence_index] not in _occurrence_texts(source_rows.get(pair), source_rows):
                        issue("ORIGINAL_TEXT", loc + ".answer.出现原文", answer["出现原文"][occurrence_index], "unaltered complete acquired source text for " + str(pair))
            if index == len(rounds) and answer not in accepted_answers.get(term_id, []):
                issue("UNACCEPTED_TERMINAL_ANSWER", loc + ".answer", term_id, "exact factual answer previously submitted and followed by a non-rejection attitude; no new terminal wording")
        if answered != required_answers:
            issue("ANSWER_COVERAGE", loc + ".answer", sorted(answered), "exact non-relaxed/rejected IDs " + str(sorted(required_answers)))
        if not _text(round_row.get("answer_ref")):
            issue("ANSWER_REF", loc + ".answer_ref", round_row.get("answer_ref"), "actual main-agent answer message reference, including last batch")
        ledger_rounds.append({"index": index, "agent_id": child_id, "result_ref": result_ref,
                              "response_sha256": response_ref.get("sha256"), "answer_sha256": answer_ref.get("sha256")})
        prior_answer_hash = answer_ref.get("sha256")
        prior_answers = current_answers
    occurrences = latest_occurrences
    if correction_from is not None and len(rounds) <= correction_from:
        issue("DISCOVERY_CORRECTION_ORDER", ".rounds", len(rounds), "another real child response after corrected facts, within the original five rounds")
    if current_time and prior_time and current_time < prior_time:
        issue("ORDER", ".current_final_review", current_time, "current full final audit after every required main answer")
    triggered.update(ever_alert | final_doubts)
    ids(review.get("triggered_term_ids"), ".triggered_term_ids", triggered)
    ids(review.get("ever_alert_ids"), ".ever_alert_ids", ever_alert)
    ledger = artifact(review.get("task_ledger"), ".task_ledger")
    exact(ledger, {"version": review["version"], "task_id": review.get("task_id"), "source_revision": review.get("source_revision"),
          "created_agent_ids": [child_id], "rounds": ledger_rounds, "triggered_term_ids": sorted(triggered),
          "ever_alert_ids": sorted(ever_alert)}, ".task_ledger", "LEDGER")

    by_id: dict[str, dict[str, Any]] = {}
    if not isinstance(items, list):
        issue("DOCUMENT_ITEMS", ".items", items, "complete current document block array")
        items = []
    for block in items:
        if not isinstance(block, dict) or not _text(block.get("block_id")) or block["block_id"] in by_id:
            issue("DOCUMENT_ITEMS", ".items", block, "current blocks with unique actual block IDs")
            continue
        by_id[block["block_id"]] = block

    def binding(value: Any, location: str) -> dict[str, Any] | None:
        if not isinstance(value, dict) or set(value) != {"block_id", "text"} or not _text(value.get("block_id")) or not _text(value.get("text")):
            issue("BLOCK_BINDING", location, value, "exact nonempty {block_id,text}")
            return None
        block = by_id.get(value["block_id"])
        if block is None or _block_text(block) != value["text"]:
            issue("BLOCK_BINDING", location, value, "exact text of a current real document block")
            return None
        return block

    for index, risk in enumerate(current_risk_locations):
        binding(risk["summary_location"], f".current_final_review.risk_locations[{index}].summary_location")
        binding(risk["platform_location"], f".current_final_review.risk_locations[{index}].platform_location")

    if review["version"] == 2:
        # Load by file path: upstream release auditors may import this module
        # with spec_from_file_location without adding its directory to sys.path.
        import importlib.util
        spec = importlib.util.spec_from_file_location("backcheck_contextual_followup", Path(__file__).with_name("contextual_followup.py"))
        followup_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(followup_module)
        try:
            policy_text = policy_raw.decode("utf-8-sig") if policy_raw is not None else ""
        except UnicodeError:
            issue("POLICY_ENCODING", ".policy", "invalid encoding", "UTF-8 current policy")
            policy_text = ""
        followup_module.audit_followup(artifact(review.get("followup"), ".followup"),
            triggered=triggered, term_entities=term_entities, occurrences=occurrences, source_rows=source_rows,
            current_risk_locations=current_risk_locations, policy_text=policy_text, current_time=current_time,
            artifact=artifact, binding=binding, stamp=stamp, issue=issue,
            source_urls=_source_urls, block_text=_block_text, is_text=_text, is_url=_url)
    else:
        inclusion = review.get("inclusion")
        included: set[str] = set()
        if not isinstance(inclusion, list):
            issue("INCLUSION", ".inclusion", inclusion, "final inclusion rows for every ever-warning or final-doubt ID")
        for index, row in enumerate(inclusion if isinstance(inclusion, list) else []):
            loc = f".inclusion[{index}]"
            if not isinstance(row, dict) or set(row) != {"id", "summary", "occurrences"} or not _text(row.get("id")):
                issue("INCLUSION", loc, row, "exact {id,summary,occurrences}")
                continue
            term_id = row["id"]
            if term_id in included or term_id not in triggered:
                issue("INCLUSION", loc, term_id, "each required ID once")
            included.add(term_id)
            summary_block = binding(row.get("summary"), loc + ".summary")
            if summary_block is not None and _url(_block_text(summary_block).strip()):
                issue("RISK_TEXT", loc + ".summary", _block_text(summary_block), "actual risk summary text, not a URL-only block")
            check_occurrences(row.get("occurrences"), term_id, loc + ".occurrences", inclusion=True)
            entity = entities[term_entities[term_id]] if term_id in term_entities else {}
            visible_names = [entity.get("name")] + entity.get("aliases", []) if isinstance(entity, dict) else []
            for occurrence_index, occurrence in enumerate(row.get("occurrences") if isinstance(row.get("occurrences"), list) else []):
                if not isinstance(occurrence, dict):
                    continue
                occurrence_loc = loc + f".occurrences[{occurrence_index}]"
                occurrence_summary = occurrence.get("summary", row.get("summary"))
                if not any(risk["summary_location"] == occurrence_summary and risk["platform_location"] == occurrence.get("platform")
                           for risk in current_risk_locations):
                    issue("RISK_LOCATION_PAIR", occurrence_loc, {"summary": occurrence_summary, "platform": occurrence.get("platform")},
                          "same summary/platform pair exported from one current audited risk group")
                platform_binding = occurrence.get("platform")
                platform_text = platform_binding.get("text") if isinstance(platform_binding, dict) else None
                if _text(platform_text) and (_url(platform_text.strip()) or not any(_text(name) and _name(name) in _name(platform_text) for name in visible_names)):
                    issue("RISK_TEXT", occurrence_loc + ".platform", platform_text, "actual platform fact visibly naming the exported term or resolved entity alias")
        if included != triggered:
            issue("INCLUSION", ".inclusion", sorted(included), "all-ever warning plus final-doubt IDs " + str(sorted(triggered)) + "; later relaxation cannot erase a warning")
    if not errors and not blocked:
        info.append("All recorded batches, answers, source occurrences and current document bindings reconcile. Closure does not require all-relaxed labels.")
    return result()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True,
                        help="JSON with client_challenge_review, discovery_review, items, document_token, revision_id, required_policy_path")
    args = parser.parse_args()
    try:
        state = json.loads(args.state.read_text(encoding="utf-8-sig"))
        if not isinstance(state, dict):
            raise ValueError("state must be an object")
        policy = state.get("required_policy_path")
        if not _text(policy):
            raise ValueError("required_policy_path must name the current policy file")
        policy_path = Path(policy)
        if not policy_path.is_absolute():
            policy_path = args.state.parent / policy_path
        output = audit_client_challenge(state.get("client_challenge_review"), discovery_review=state.get("discovery_review"),
                    items=state.get("items"), document_token=state.get("document_token"), revision_id=state.get("revision_id"),
                    required_policy_path=policy_path, base_dir=args.state.parent)
    except (OSError, ValueError, TypeError, UnicodeError) as exc:
        output = {"verdict": "FAIL", "errors": [{"code": "CHALLENGE_STATE", "location": str(args.state),
                   "actual": str(exc), "expected": "readable valid state JSON"}], "blocked": [], "info": [], "triggered_term_ids": [], "ever_alert_ids": []}
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if output["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
