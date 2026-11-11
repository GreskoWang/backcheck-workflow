"""Evidence-backed regression tests for discovery v2; no linguistic dictionary."""
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from discovery_gate import MANDATORY_STAGES, audit_discovery_review


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fixture(root):
    """Create real offline evidence files; references are deliberately synthetic."""
    root = Path(root)
    batch_path = root / "acquired.json"
    receipt_path = root / "child-receipt.json"
    source_hash = write_json(batch_path, {"items": [
        {"source_ref": "offline#post-1", "text": "Orchid Lantern Stage advertisements are repetitive."},
        {"source_ref": "offline#post-2", "text": "Qevira-17 Festival opens today."},
        {"source_ref": "offline#post-3", "text": "It rained all morning."},
    ]})
    review = {
        "version": 2, "mode": "assistant_research", "scope": "offline X fixture",
        "task_id": "offline-task-1", "primary_agent_id": "root-agent",
        "source_revision": "batch-3", "reviewed_revision": "batch-3",
        "source_refs": [str(batch_path)], "open_items": [],
        "execution_review": {"status": "complete", "source_revision": "batch-3",
            "applicable_steps": list(MANDATORY_STAGES), "skipped_steps": [],
            "steps": [{"step_id": stage, "status": "complete", "evidence_refs": [f"offline#{stage}"]} for stage in MANDATORY_STAGES]},
        "semantic_review": {"status": "complete", "source_revision": "batch-3",
            "source_batches": [{"batch_id": "batch-A", "path": str(batch_path), "items_key": "items", "sha256": source_hash}],
            "items": [
                {"batch_id": "batch-A", "item_index": 0, "status": "complete", "summary": "The poster complains about repeated adverts for the production.", "names": ["Orchid Lantern Stage"]},
                {"batch_id": "batch-A", "item_index": 1, "status": "complete", "summary": "The poster announces the festival opening date.", "names": ["Qevira-17 Festival"]},
                {"batch_id": "batch-A", "item_index": 2, "status": "complete", "summary": "Personal comment on the morning weather.", "names": [], "no_special_terms_reason": "Only ordinary weather and time descriptions appear."},
            ]},
        "entities": [
            {"name": "Orchid Lantern Stage", "aliases": ["兰灯舞台"],
             "alias_evidence": [{"alias": "兰灯舞台", "source_refs": ["offline#bilingual-production-title"]}],
             "source_refs": ["offline#post-1"], "identity": "fictional touring production",
             "background_refs": ["offline#production-about"], "relation": "poster complains about repetitive adverts",
             "disposition": "record", "reason": "test policy requires this public mention with exact attribution",
             "record_fact": "The poster complained about Orchid Lantern Stage advertisements."},
            {"name": "Qevira-17 Festival", "aliases": [], "source_refs": ["offline#post-2"],
             "identity": "fictional local festival", "background_refs": ["offline#festival-about"],
             "relation": "poster announces opening", "disposition": "clear", "reason": "fixture policy does not flag the verified context"},
        ],
        "reverse_pass": {"status": "complete", "names": ["Orchid Lantern Stage", "Qevira-17 Festival"]},
        "subagent_review": {"agent_id": "term-child-1", "created_agent_ids": ["term-child-1"], "task_id": "offline-task-1",
            "source_revision": "batch-3", "status": "complete", "spawn_ref": "offline#spawn-1", "result_ref": "offline#result-1", "receipt_path": str(receipt_path)},
    }
    manifest_path = root / "acquisition-manifest.json"
    manifest_hash = write_json(manifest_path, {"task_id": review["task_id"], "source_revision": review["source_revision"],
        "source_batches": copy.deepcopy(review["semantic_review"]["source_batches"])})
    review["acquisition_manifest"] = {"path": str(manifest_path), "sha256": manifest_hash}
    write_json(receipt_path, {"version": 2, **{key: review["subagent_review"][key] for key in
        ("agent_id", "task_id", "source_revision", "status", "spawn_ref", "result_ref")}, "acquisition_sha256": manifest_hash,
        "reviews": [{"name": entity["name"], "status": "complete", "conclusion": entity["reason"],
            "queries": [{"query": entity["name"] + " background", "source_refs": entity["background_refs"]}]} for entity in review["entities"]]})
    return review


class DiscoveryGateTests(unittest.TestCase):
    def test_bounded_unknown_is_completed_but_unqueried_is_not(self):
        entity = self.review["entities"][1]
        entity["disposition"] = "pending"
        entity["terminal_outcome"] = {"status": "complete", "kind": "bounded_inconclusive",
            "conclusion": "未坐实", "reason": "Two reviewed sources do not resolve the identity",
            "evidence_refs": ["offline#festival-about", "offline#backup-search"]}
        self.assertEqual(self.audit()["verdict"], "PASS")
        receipt_path = Path(self.review["subagent_review"]["receipt_path"])
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["reviews"][1]["queries"] = []
        write_json(receipt_path, receipt)
        self.assert_failure("DISCOVERY_SUBAGENT_QUERIES")

    def test_objective_unavailable_requires_evidence_and_does_not_erase_known_risk(self):
        entity = self.review["entities"][1]
        entity["terminal_outcome"] = {"status": "complete", "kind": "objective_unavailable",
            "conclusion": "无问题", "reason": "Owner restricted this post",
            "evidence_refs": ["offline#actual-access-message"]}
        self.assertEqual(self.audit()["verdict"], "PASS")
        self.assert_failure("DISCOVERY_REPORT_OMISSION", facts=[])
        entity["terminal_outcome"]["evidence_refs"] = []
        self.assert_failure("DISCOVERY_TERMINAL_EVIDENCE")

    def test_unavailable_term_uses_actual_access_receipt_without_inventing_query_results(self):
        url = "https://example.invalid/festival"
        path = self.root / "term-access.json"
        digest = write_json(path, {"source_ref": url, "checked_at": "2026-11-11T00:00:00Z",
            "access_outcome": "objective_unavailable", "access_reason": "deleted",
            "access_message": "This page has been deleted.", "content_obtained": False, "result_count": None})
        terminal = {"status": "complete", "kind": "objective_unavailable", "conclusion": "无问题",
            "reason": "The referenced page is deleted.", "evidence_refs": [url],
            "evidence": {"path": str(path), "sha256": digest}}
        self.review["entities"][1].update(background_refs=[url], terminal_outcome=terminal)
        self.mutate_receipt(lambda receipt: receipt["reviews"][1].update(queries=[], terminal_outcome=terminal))
        self.assertEqual(self.audit()["verdict"], "PASS", self.audit())
        self.assert_failure("DISCOVERY_REPORT_OMISSION", facts=[])
        self.review["entities"][1]["background_refs"] = ["https://example.invalid/unrelated-page"]
        self.assert_failure("DISCOVERY_SUBAGENT_QUERIES")
        self.review["entities"][1]["background_refs"] = [url]
        self.mutate_receipt(lambda receipt: receipt["reviews"][1].pop("terminal_outcome"))
        self.assert_failure("DISCOVERY_SUBAGENT_QUERIES")
        self.mutate_receipt(lambda receipt: receipt["reviews"][1].update(terminal_outcome=terminal))
        path.write_text("{}", encoding="utf-8")
        self.assert_failure("DISCOVERY_SUBAGENT_QUERIES")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.review = fixture(self.root)
        self.facts = [self.review["entities"][0]["record_fact"]]

    def audit(self, review=None, facts=None):
        return audit_discovery_review(self.review if review is None else review,
                                      reported_facts=self.facts if facts is None else facts)

    def assert_failure(self, code, stage=None, review=None, facts=None):
        result = self.audit(review, facts)
        self.assertEqual(result["verdict"], "FAIL", result)
        self.assertIn(code, {row["code"] for row in result["errors"]}, result)
        if stage:
            self.assertEqual(result["repair_stage"], stage, result)
        return result

    def mutate_receipt(self, change):
        path = Path(self.review["subagent_review"]["receipt_path"])
        value = json.loads(path.read_text(encoding="utf-8"))
        change(value)
        write_json(path, value)

    def test_full_evidence_and_final_fact_pass(self):
        result = self.audit()
        self.assertEqual(result["verdict"], "PASS", result)
        self.assertTrue(result["research_assessed"])
        self.assertIsNone(result["repair_stage"])

    def test_missing_review_is_fail(self):
        result = audit_discovery_review(None)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertEqual(result["repair_stage"], "source_collection")

    def test_v1_research_is_not_auto_upgraded(self):
        self.review["version"] = 1
        self.assert_failure("DISCOVERY_VERSION", "source_collection")

    def test_self_declared_empty_without_independent_source_review_fails(self):
        self.review["entities"] = []
        self.review["reverse_pass"]["names"] = []
        for item in self.review["semantic_review"]["items"]:
            item.update(names=[], no_special_terms_reason="self-declared empty")
        self.assert_failure("DISCOVERY_EMPTY_TERM_REVIEW", "term_subagent_review", facts=[])

    def test_missing_extraction_field_fails(self):
        self.review["semantic_review"]["items"][0].pop("names")
        self.assert_failure("DISCOVERY_ITEM_EXTRACTION", "term_extraction")

    def test_one_raw_item_missing_from_semantic_review_fails(self):
        self.review["semantic_review"]["items"].pop()
        self.assert_failure("DISCOVERY_ITEM_COVERAGE", "semantic_analysis")

    def test_duplicate_or_phantom_item_cannot_fill_missing_item(self):
        for bad in (0, 40, True, -1):
            with self.subTest(index=bad):
                review = copy.deepcopy(self.review)
                review["semantic_review"]["items"][2]["item_index"] = bad
                self.assertEqual(self.audit(review)["verdict"], "FAIL")

    def test_cache_count_is_not_semantic_review(self):
        self.review["semantic_review"]["items"] = 3
        self.assert_failure("DISCOVERY_SEMANTIC_ITEMS", "semantic_analysis")

    def test_empty_summary_fails(self):
        self.review["semantic_review"]["items"][0]["summary"] = ""
        self.assert_failure("DISCOVERY_ITEM_ANALYSIS", "semantic_analysis")

    def test_no_name_item_needs_actual_reason(self):
        self.review["semantic_review"]["items"][2].pop("no_special_terms_reason")
        self.assert_failure("DISCOVERY_ITEM_EXTRACTION", "term_extraction")

    def test_unknown_term_is_unresolved_without_any_dictionary(self):
        self.review["semantic_review"]["items"][0]["names"].append("Nebulous Uncatalogued Work")
        self.assert_failure("DISCOVERY_UNRESOLVED_NAME", "term_extraction")

    def test_one_term_skipped_by_child_fails(self):
        self.mutate_receipt(lambda receipt: receipt["reviews"].pop())
        self.assert_failure("DISCOVERY_SUBAGENT_COVERAGE", "term_subagent_review")

    def test_child_partial_or_no_query_fails(self):
        self.mutate_receipt(lambda receipt: receipt["reviews"][1].update(status="partial", queries=[]))
        self.assert_failure("DISCOVERY_SUBAGENT_INCOMPLETE", "term_subagent_review")

    def test_query_must_have_inspected_sources(self):
        self.mutate_receipt(lambda receipt: receipt["reviews"][0]["queries"][0].update(source_refs=[]))
        self.assert_failure("DISCOVERY_SUBAGENT_QUERIES", "term_subagent_review")

    def test_same_agent_cannot_self_certify(self):
        self.review["subagent_review"].update(agent_id="root-agent", created_agent_ids=["root-agent"])
        self.assert_failure("DISCOVERY_DISTINCT_SUBAGENT", "term_subagent_review")

    def test_exactly_one_created_child_required(self):
        for children in ([], ["term-child-1", "another-child"], ["term-child-1", "term-child-1"]):
            review = copy.deepcopy(self.review)
            review["subagent_review"]["created_agent_ids"] = children
            self.assert_failure("DISCOVERY_DISTINCT_SUBAGENT", review=review)

    def test_missing_receipt_cannot_pass_on_declared_complete(self):
        Path(self.review["subagent_review"]["receipt_path"]).unlink()
        self.assert_failure("DISCOVERY_ARTIFACT_MISSING", "term_subagent_review")

    def test_actual_artifact_access_denial_remains_blocked(self):
        original_read = Path.read_bytes
        receipt_path = Path(self.review["subagent_review"]["receipt_path"])
        def read(path):
            if path == receipt_path:
                raise PermissionError("offline simulated artifact access denial")
            return original_read(path)
        with patch.object(Path, "read_bytes", read):
            result = self.audit()
        self.assertEqual(result["verdict"], "BLOCKED", result)
        self.assertEqual(result["repair_stage"], "term_subagent_review")
        self.assertEqual(result["errors"], [])

    def test_stale_receipt_revision_and_task_fail(self):
        self.mutate_receipt(lambda receipt: receipt.update(task_id="other-task", source_revision="batch-2"))
        self.assert_failure("DISCOVERY_RECEIPT_BINDING", "term_subagent_review")

    def test_unresolved_extra_child_review_fails(self):
        self.mutate_receipt(lambda receipt: receipt["reviews"].append({"name": "Unknown", "status": "complete", "conclusion": "clear", "queries": []}))
        self.assert_failure("DISCOVERY_SUBAGENT_COVERAGE", "term_subagent_review")

    def test_duplicate_alias_review_cannot_count_as_another_term(self):
        self.mutate_receipt(lambda receipt: receipt["reviews"][1].update(name="兰灯舞台"))
        self.assert_failure("DISCOVERY_SUBAGENT_COVERAGE", "term_subagent_review")

    def test_verified_alias_maps_to_one_entity(self):
        self.review["semantic_review"]["items"][0]["names"] = ["兰灯舞台", "ORCHID  LANTERN STAGE"]
        self.review["reverse_pass"]["names"][0] = "兰灯舞台"
        self.mutate_receipt(lambda receipt: receipt["reviews"][0].update(name="兰灯舞台"))
        self.assertEqual(self.audit()["verdict"], "PASS")

    def test_aliases_require_reviewed_identity_evidence(self):
        self.review["entities"][0].pop("alias_evidence")
        self.assert_failure("DISCOVERY_ALIAS_EVIDENCE", "term_subagent_review")

    def test_duplicate_entity_identity_cannot_hold_another_fact(self):
        self.review["entities"][1]["name"] = "Orchid Lantern Stage"
        self.assert_failure("DISCOVERY_AMBIGUOUS_NAME", "term_extraction")

    def test_changed_actual_source_hash_fails(self):
        path = Path(self.review["semantic_review"]["source_batches"][0]["path"])
        source = json.loads(path.read_text(encoding="utf-8"))
        source["items"].append({"text": "Newly acquired item"})
        write_json(path, source)
        self.assert_failure("DISCOVERY_SOURCE_HASH", "source_collection")

    def test_entire_acquired_batch_omission_fails(self):
        source = self.root / "second-batch.json"
        sha = write_json(source, {"items": [{"text": "A whole acquired batch."}]})
        path = Path(self.review["acquisition_manifest"]["path"])
        manifest = json.loads(path.read_text(encoding="utf-8"))
        manifest["source_batches"].append({"batch_id": "batch-B", "path": str(source), "items_key": "items", "sha256": sha})
        self.review["acquisition_manifest"]["sha256"] = write_json(path, manifest)
        self.assert_failure("DISCOVERY_ACQUISITION_COVERAGE", "source_collection")

    def test_stale_receipt_after_inventory_change_fails_even_same_revision(self):
        source = Path(self.review["semantic_review"]["source_batches"][0]["path"])
        contents = json.loads(source.read_text(encoding="utf-8"))
        contents["items"][2]["text"] = "It rained all afternoon."
        self.review["semantic_review"]["source_batches"][0]["sha256"] = write_json(source, contents)
        manifest_path = Path(self.review["acquisition_manifest"]["path"])
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["source_batches"] = self.review["semantic_review"]["source_batches"]
        self.review["acquisition_manifest"]["sha256"] = write_json(manifest_path, manifest)
        self.assert_failure("DISCOVERY_RECEIPT_BINDING", "term_subagent_review")

    def test_duplicate_source_batch_cannot_hide_coverage(self):
        self.review["semantic_review"]["source_batches"].append(copy.deepcopy(self.review["semantic_review"]["source_batches"][0]))
        self.assert_failure("DISCOVERY_DUPLICATE_BATCH", "source_collection")

    def test_unparsed_or_truncated_source_fails_even_with_updated_hash(self):
        for marker in ({"truncated": True}, {"parsed": False}, {"parse_status": "partial"}):
            review = copy.deepcopy(self.review)
            batch = review["semantic_review"]["source_batches"][0]
            source = json.loads(Path(batch["path"]).read_text(encoding="utf-8"))
            source.update(marker)
            batch["sha256"] = write_json(Path(batch["path"]), source)
            self.assert_failure("DISCOVERY_INCOMPLETE_SOURCE", "source_collection", review=review)

    def test_stale_semantic_revision_fails(self):
        self.review["semantic_review"]["source_revision"] = "old"
        self.assert_failure("DISCOVERY_SEMANTIC_REVIEW", "semantic_analysis")

    def test_skipped_applicable_step_fails_and_returns_rule(self):
        self.review["execution_review"]["applicable_steps"].append("profile_keyword_check")
        self.assert_failure("DISCOVERY_MISSING_STEP", "profile_keyword_check")
        self.review["execution_review"]["steps"].append({"step_id": "profile_keyword_check", "status": "complete", "evidence_refs": ["offline#keywords"]})
        self.assertEqual(self.audit()["verdict"], "PASS")
        self.review["execution_review"]["skipped_steps"] = ["profile_keyword_check"]
        self.assert_failure("DISCOVERY_SKIPPED_STEPS", "profile_keyword_check")

    def test_repair_stage_uses_actual_applicable_execution_order(self):
        execution = self.review["execution_review"]
        execution["applicable_steps"].insert(0, "account_confirmation")
        execution["skipped_steps"] = ["term_extraction", "account_confirmation"]
        self.assert_failure("DISCOVERY_SKIPPED_STEPS", "account_confirmation")

    def test_mandatory_stage_cannot_be_declared_inapplicable(self):
        self.review["execution_review"]["applicable_steps"].remove("term_subagent_review")
        self.review["execution_review"]["steps"] = [step for step in self.review["execution_review"]["steps"] if step["step_id"] != "term_subagent_review"]
        self.assert_failure("DISCOVERY_REQUIRED_STEP", "term_subagent_review")

    def test_recorded_fact_missing_or_changed_from_report_fails(self):
        self.assert_failure("DISCOVERY_REPORT_OMISSION", "final_report", facts=[])
        self.assert_failure("DISCOVERY_REPORT_OMISSION", facts=["The poster supports the production."])

    def test_known_shen_yun_omission_and_attribution_regression(self):
        # Retain the historical regression while using real offline source bytes.
        fact = "提及神韵，语境为吐槽广告反复出现。"
        entity = self.review["entities"][0]
        entity.update(name="Shen Yun", aliases=["神韵"], alias_evidence=[{"alias": "神韵", "source_refs": ["offline#official-title"]}],
                      identity="神韵艺术团及其演出", relation="原帖吐槽广告，没有陈述已观演或支持", record_fact=fact)
        self.review["semantic_review"]["items"][0].update(names=["Shen Yun"], summary="原帖用假设句吐槽广告反复出现。")
        self.review["reverse_pass"]["names"][0] = "神韵"
        batch = self.review["semantic_review"]["source_batches"][0]
        source = json.loads(Path(batch["path"]).read_text(encoding="utf-8"))
        source["items"][0]["text"] = "Another Shen Yun advertisement again."
        batch["sha256"] = write_json(Path(batch["path"]), source)
        manifest_path = Path(self.review["acquisition_manifest"]["path"])
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["source_batches"] = self.review["semantic_review"]["source_batches"]
        manifest_hash = write_json(manifest_path, manifest)
        self.review["acquisition_manifest"]["sha256"] = manifest_hash
        def update_receipt(receipt):
            receipt["acquisition_sha256"] = manifest_hash
            receipt["reviews"][0].update(name="Shen Yun", conclusion="记录具体公开提及，保留抱怨广告的原文归因。", queries=[{"query": "Shen Yun background", "source_refs": ["offline#official-title"]}])
        self.mutate_receipt(update_receipt)
        self.assertEqual(self.audit(facts=[fact])["verdict"], "PASS")
        self.assert_failure("DISCOVERY_REPORT_OMISSION", "final_report", facts=["她支持神韵。"])
        self.review["entities"].pop(0)
        self.assert_failure("DISCOVERY_UNRESOLVED_NAME", "term_extraction", facts=[])

    def test_multiple_facts_per_entity_all_reconciled(self):
        self.review["entities"][0]["record_facts"] = self.facts + ["Second verified business fact."]
        self.assert_failure("DISCOVERY_REPORT_OMISSION", "final_report")
        self.assertEqual(self.audit(facts=self.facts + ["Second verified business fact."])["verdict"], "PASS")
        self.review["entities"][0]["record_fact"] = "conflicting legacy fact"
        self.assert_failure("DISCOVERY_RECORD_CONFLICT", "final_report")

    def test_pending_background_and_media_do_not_pass(self):
        for field, value, code in (("disposition", "pending", "DISCOVERY_PENDING_ENTITY"), ("background_refs", [], "DISCOVERY_BACKGROUND")):
            review = copy.deepcopy(self.review)
            review["entities"][0][field] = value
            self.assert_failure(code, review=review)
        self.review["open_items"] = [{"source_ref": "offline#image", "next": "read text"}]
        self.assert_failure("DISCOVERY_OPEN_ITEMS", "semantic_analysis")

    def test_reverse_pass_covers_every_extracted_entity(self):
        self.review["reverse_pass"]["names"].pop()
        self.assert_failure("DISCOVERY_REVERSE_COVERAGE", "reverse_review")

    def test_isolated_delivery_only_is_not_research_certification(self):
        for mode in ("user_supplied", "existing_report_only"):
            review = {"version": 1, "mode": mode, "scope": "format supplied conclusion", "instruction": "Only format my findings", "source_ref": "user-message-1"}
            result = self.audit(review)
            self.assertEqual(result["verdict"], "PASS")
            self.assertFalse(result["research_assessed"])
            review["entities"] = []
            self.assert_failure("DISCOVERY_MODE_CONFLICT", review=review)

    def test_bad_shapes_fail_closed_without_exception(self):
        cases = [[], "PASS", {"version": True, "mode": "assistant_research"}]
        for field in ("entities", "execution_review", "semantic_review", "subagent_review", "open_items", "reverse_pass", "source_refs"):
            for bad in (None, False, 3, "PASS", [None], {}):
                review = copy.deepcopy(self.review)
                review[field] = bad
                cases.append(review)
        for review in cases:
            with self.subTest(review=review):
                self.assertEqual(self.audit(review)["verdict"], "FAIL")

    def test_bad_receipt_shapes_fail_closed(self):
        for bad in (None, [], "PASS", {"reviews": [None]}, {"reviews": [{"name": []}]}):
            write_json(Path(self.review["subagent_review"]["receipt_path"]), bad)
            self.assertEqual(self.audit()["verdict"], "FAIL")

    def test_cli_missing_malformed_and_complete(self):
        path = self.root / "state.json"
        for state, code in (({}, 1), ([], 1), ({"discovery_review": self.review, "reported_facts": self.facts}, 0)):
            write_json(path, state)
            run = subprocess.run([sys.executable, str(Path(__file__).with_name("discovery_gate.py")), "--state", str(path)], capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(run.returncode, code, run.stderr + run.stdout)
            self.assertEqual(json.loads(run.stdout)["verdict"], "PASS" if code == 0 else "FAIL")


def empty_terms_fixture(root, rows=None, terminal_kind=None):
    """Real source bytes and two source-bound empty-term review records."""
    root = Path(root)
    review = fixture(root)
    rows = [{"source_ref": "https://example.invalid/post/weather", "text": "It rained all morning."}] if rows is None else rows
    review["entities"] = []
    review["semantic_review"]["items"] = [
        {"batch_id": "batch-A", "item_index": i, "status": "complete", "summary": "An ordinary weather observation.",
         "names": [], "no_special_terms_reason": "Only ordinary weather and time words occur."} for i in range(len(rows))]
    review["reverse_pass"] = {"status": "complete", "names": [],
        "no_special_terms_reason": "The acquired material and access records contain no special nouns.",
        "source_refs": review["source_refs"][:]}
    source = {"items": rows}
    if terminal_kind:
        evidence = {"source_ref": "https://example.invalid/account", "checked_at": "2026-11-11T00:00:00Z",
                    "access_outcome": terminal_kind, "result_count": None if terminal_kind == "objective_unavailable" else 0}
        source["source_ref"] = evidence["source_ref"]
        if terminal_kind == "objective_unavailable":
            evidence.update(access_reason="private", access_message="Only approved followers can view this account.", content_obtained=False)
        else:
            evidence.update(collection_complete=True, observed_text="No matching posts in this requested time range.")
        evidence_path = root / "access.json"
        evidence_hash = write_json(evidence_path, evidence)
        source["terminal_outcome"] = {"status": "complete", "kind": terminal_kind,
            "conclusion": "无问题" if terminal_kind == "objective_unavailable" else "无相关结果",
            "reason": "Observed private account restriction." if terminal_kind == "objective_unavailable" else "Completed query returned no posts.",
            "evidence_refs": [evidence["source_ref"]], "evidence": {"path": str(evidence_path), "sha256": evidence_hash}}
    batch = review["semantic_review"]["source_batches"][0]
    batch["sha256"] = write_json(Path(batch["path"]), source)
    manifest_path = Path(review["acquisition_manifest"]["path"])
    manifest = {"task_id": review["task_id"], "source_revision": review["source_revision"],
                "source_batches": review["semantic_review"]["source_batches"]}
    review["acquisition_manifest"]["sha256"] = write_json(manifest_path, manifest)
    receipt_path = Path(review["subagent_review"]["receipt_path"])
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    receipt.update(reviews=[], acquisition_sha256=review["acquisition_manifest"]["sha256"],
                   no_special_terms_reason="Independently reviewed the exact source material; no special nouns are present.",
                   source_refs=review["source_refs"][:])
    write_json(receipt_path, receipt)
    return review


class DiscoveryEmptyAndAccessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def audit(self, review):
        return audit_discovery_review(review, reported_facts=[])

    def rewrite_source(self, review, change):
        batch = review["semantic_review"]["source_batches"][0]
        source = json.loads(Path(batch["path"]).read_text(encoding="utf-8"))
        change(source)
        batch["sha256"] = write_json(Path(batch["path"]), source)
        manifest_path = Path(review["acquisition_manifest"]["path"])
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["source_batches"] = review["semantic_review"]["source_batches"]
        review["acquisition_manifest"]["sha256"] = write_json(manifest_path, manifest)
        receipt_path = Path(review["subagent_review"]["receipt_path"])
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["acquisition_sha256"] = review["acquisition_manifest"]["sha256"]
        write_json(receipt_path, receipt)

    def test_complete_real_sources_without_special_terms_pass(self):
        result = self.audit(empty_terms_fixture(self.root))
        self.assertEqual(result["verdict"], "PASS", result)

    def test_real_empty_query_and_objective_unavailable_unknown_count_pass(self):
        for kind in ("no_results", "objective_unavailable"):
            with self.subTest(kind=kind):
                review = empty_terms_fixture(self.root, [], kind)
                result = self.audit(review)
                self.assertEqual(result["verdict"], "PASS", result)

    def test_empty_source_without_evidenced_completion_fails(self):
        result = self.audit(empty_terms_fixture(self.root, []))
        self.assertEqual(result["verdict"], "FAIL", result)

    def test_empty_source_cannot_borrow_another_accounts_access_proof(self):
        review = empty_terms_fixture(self.root, [], "objective_unavailable")
        self.rewrite_source(review, lambda s: s.update(source_ref="https://example.invalid/another-account"))
        self.assertEqual(self.audit(review)["verdict"], "FAIL")
        self.rewrite_source(review, lambda s: s.pop("source_ref"))
        self.assertEqual(self.audit(review)["verdict"], "FAIL")
        self.rewrite_source(review, lambda s: s.update(job={"target_url": "https://example.invalid/account"}))
        self.assertEqual(self.audit(review)["verdict"], "PASS")

    def test_empty_terms_do_not_excuse_skipped_reading_or_independent_review(self):
        for target in ("semantic", "receipt", "reverse"):
            review = empty_terms_fixture(self.root)
            if target == "semantic": review["semantic_review"]["items"] = []
            elif target == "receipt":
                path = Path(review["subagent_review"]["receipt_path"])
                receipt = json.loads(path.read_text(encoding="utf-8"))
                receipt.pop("no_special_terms_reason")
                write_json(path, receipt)
            else: review["reverse_pass"].pop("no_special_terms_reason")
            self.assertEqual(self.audit(review)["verdict"], "FAIL", target)

    def test_omitted_terms_cannot_hide_behind_empty_entities(self):
        review = empty_terms_fixture(self.root)
        review["semantic_review"]["items"][0]["names"] = ["Real Extracted Name"]
        self.assertEqual(self.audit(review)["verdict"], "FAIL")

    def test_unavailable_requires_real_hash_and_objective_access_observation(self):
        for mutation in ("missing", "stale_hash", "timeout", "loading", "tool_error", "invented_zero", "no_message", "pretend_read"):
            review = empty_terms_fixture(self.root, [], "objective_unavailable")
            path = self.root / "access.json"
            evidence = json.loads(path.read_text(encoding="utf-8"))
            if mutation == "missing": path.unlink()
            elif mutation == "stale_hash": path.write_text("{}", encoding="utf-8")
            else:
                if mutation in ("timeout", "loading", "tool_error"):
                    evidence.update(access_reason=mutation, access_message="No completed page access observation")
                elif mutation == "invented_zero": evidence["result_count"] = 0
                elif mutation == "no_message": evidence["access_message"] = ""
                else: evidence["content_obtained"] = True
                digest = write_json(path, evidence)
                self.rewrite_source(review, lambda s: s["terminal_outcome"]["evidence"].update(sha256=digest))
            self.assertEqual(self.audit(review)["verdict"], "FAIL", mutation)

    def test_zero_result_requires_actual_completed_search_and_known_zero(self):
        for mutation in ({"collection_complete": False}, {"result_count": None}, {"result_count": 1},
                         {"result_count": False}, {"observed_text": ""}, {"needs_expansion": True}):
            review = empty_terms_fixture(self.root, [], "no_results")
            path = self.root / "access.json"
            evidence = json.loads(path.read_text(encoding="utf-8"))
            evidence.update(mutation)
            digest = write_json(path, evidence)
            self.rewrite_source(review, lambda s: s["terminal_outcome"]["evidence"].update(sha256=digest))
            self.assertEqual(self.audit(review)["verdict"], "FAIL", mutation)

    def test_runtime_incomplete_flags_fail_until_full_source_is_obtained(self):
        for key in ("text_truncated", "needs_expansion", "truncated"):
            review = empty_terms_fixture(self.root)
            self.rewrite_source(review, lambda s: s["items"][0].update({key: True}))
            result = self.audit(review)
            self.assertIn("DISCOVERY_INCOMPLETE_SOURCE", {r["code"] for r in result["errors"]}, result)
            self.rewrite_source(review, lambda s: s["items"][0].update({key: False, "text": "It rained all morning and cleared by noon."}))
            self.assertEqual(self.audit(review)["verdict"], "PASS")


if __name__ == "__main__":
    unittest.main()
