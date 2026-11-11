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
    def test_unknown_meaning_requires_no_background_query(self):
        self.review.pop("subagent_review")
        for entity in self.review["entities"]:
            for field in ("identity", "background_refs", "relation", "alias_evidence"):
                entity.pop(field, None)
        self.review["entities"][1]["disposition"] = "pending"
        self.assertEqual(self.audit()["verdict"], "PASS")

    def test_access_status_does_not_erase_already_recorded_fact(self):
        self.review["entities"][0]["terminal_outcome"] = {"kind":"objective_unavailable"}
        self.assert_failure("DISCOVERY_REPORT_OMISSION", facts=[])

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

    def test_genuinely_nameless_material_can_have_empty_noun_table(self):
        self.review["entities"] = []
        self.review["reverse_pass"]["names"] = []
        for item in self.review["semantic_review"]["items"]:
            item.update(names=[], no_special_terms_reason="Only ordinary descriptions in this offline nameless-input test.")
        self.assertEqual(self.audit(facts=[])["verdict"], "PASS")

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







    def test_actual_source_access_denial_remains_blocked(self):
        original_read = Path.read_bytes
        source_path = Path(self.review["semantic_review"]["source_batches"][0]["path"])
        def read(path):
            if path == source_path:
                raise PermissionError("offline simulated source access denial")
            return original_read(path)
        with patch.object(Path, "read_bytes", read):
            result = self.audit()
        self.assertEqual(result["verdict"], "BLOCKED", result)
        self.assertEqual(result["repair_stage"], "source_collection")
        self.assertEqual(result["errors"], [])




    def test_verified_alias_maps_to_one_entity(self):
        self.review["semantic_review"]["items"][0]["names"] = ["兰灯舞台", "ORCHID  LANTERN STAGE"]
        self.review["reverse_pass"]["names"][0] = "兰灯舞台"
        self.mutate_receipt(lambda receipt: receipt["reviews"][0].update(name="兰灯舞台"))
        self.assertEqual(self.audit()["verdict"], "PASS")

    def test_source_aliases_do_not_require_separate_search_receipt(self):
        self.review["entities"][0].pop("alias_evidence")
        self.assertEqual(self.audit()["verdict"], "PASS")

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

    def test_real_reading_stage_cannot_be_declared_inapplicable(self):
        self.review["execution_review"]["applicable_steps"].remove("semantic_analysis")
        self.assert_failure("DISCOVERY_REQUIRED_STEP", "semantic_analysis")

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

    def test_actual_unread_media_still_blocks_completion(self):
        self.review["entities"][1]["disposition"] = "pending"
        self.review["entities"][1]["background_refs"] = []
        self.assertEqual(self.audit()["verdict"], "PASS")
        self.review["open_items"] = [{"source_ref":"offline#image", "next":"read actual image"}]
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
        for field in ("entities", "execution_review", "semantic_review", "open_items", "reverse_pass", "source_refs"):
            for bad in (None, False, 3, "PASS", [None], {}):
                review = copy.deepcopy(self.review)
                review[field] = bad
                cases.append(review)
        for review in cases:
            with self.subTest(review=review):
                self.assertEqual(self.audit(review)["verdict"], "FAIL")

    def test_retired_query_records_do_not_reintroduce_query_work(self):
        self.review["subagent_review"] = {"status":"incomplete", "receipt_path":"missing-retired-file.json"}
        self.review["execution_review"]["applicable_steps"].append("term_subagent_review")
        self.review["execution_review"]["skipped_steps"] = ["term_subagent_review"]
        self.assertEqual(self.audit()["verdict"], "PASS")

    def test_cli_missing_malformed_and_complete(self):
        path = self.root / "state.json"
        for state, code in (({}, 1), ([], 1), ({"discovery_review": self.review, "reported_facts": self.facts}, 0)):
            write_json(path, state)
            run = subprocess.run([sys.executable, str(Path(__file__).with_name("discovery_gate.py")), "--state", str(path)], capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(run.returncode, code, run.stderr + run.stdout)
            self.assertEqual(json.loads(run.stdout)["verdict"], "PASS" if code == 0 else "FAIL")


if __name__ == "__main__":
    unittest.main()
