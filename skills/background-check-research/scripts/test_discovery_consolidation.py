"""Consolidation changes publication mapping, never underlying discovery work."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from discovery_gate import audit_discovery_review
from test_discovery_gate import fixture, write_json


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode("utf-8")).hexdigest()


class DiscoveryConsolidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.review = fixture(self.root)
        self.old_fact = self.review["entities"][0]["record_fact"]
        self.fact = "The account criticized repeated advertising for the production."
        self.facts = [self.fact]
        self.policy = self.root / "policy.md"
        self.policy.write_text("Public mentions\nOther category", encoding="utf-8")
        self.archive_path = self.root / "classification.json"
        self.archive = {
            "categories": [{"id": "C1", "policy_category": "Public mentions",
                "selected_facts": [{"text": self.fact}]}],
            "facts": [{"original_text": self.old_fact, "source_urls": ["offline#post-1"],
                "category_ids": ["C1"], "disposition": "archive_same_category",
                "reason": "Same category covered by its selected representative."}]}
        write_json(self.archive_path, self.archive)
        self.context_path = self.root / "contexts.json"
        write_json(self.context_path, {"terms": [{"name": "Orchid Lantern Stage",
            "original_text": "Orchid Lantern Stage advertisements are repetitive.",
            "source_ref": "offline#post-1", "context": "The poster complains about adverts."}]})
        self.record = {
            "version": 1, "task_id": self.review["task_id"],
            "source_revision": self.review["source_revision"],
            "discovery_sha256": canonical_hash(self.review),
            "reported_facts_sha256": canonical_hash(sorted(set(self.facts))),
            "policy": self.ref(self.policy), "archive": self.ref(self.archive_path),
            "context_archives": [self.ref(self.context_path)],
            "entries": [{"entity_index": 0, "fact": self.old_fact,
                "source_refs": ["offline#post-1"], "archive_index": 0,
                "disposition": "archive_same_category", "categories": ["Public mentions"],
                "representative_facts": [self.fact],
                "reason": self.archive["facts"][0]["reason"]}]}

    def ref(self, path):
        return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def save_archive(self):
        write_json(self.archive_path, self.archive)
        self.record["archive"] = self.ref(self.archive_path)

    def audit(self):
        return audit_discovery_review(self.review, reported_facts=self.facts, consolidation=self.record)

    def assert_failure(self, code="DISCOVERY_CONSOLIDATION"):
        result = self.audit()
        self.assertNotEqual(result["verdict"], "PASS")
        self.assertIn(code, {i["code"] for i in result["errors"] + result["blocked"]})

    def test_source_bound_same_category_archive_passes(self):
        self.assertEqual(self.audit()["verdict"], "PASS")

    def test_legacy_omission_rule_is_unchanged_without_opt_in(self):
        result = audit_discovery_review(self.review, reported_facts=self.facts)
        self.assertIn("DISCOVERY_REPORT_OMISSION", {i["code"] for i in result["errors"]})
        self.assertEqual(audit_discovery_review(self.review, reported_facts=[self.old_fact])["verdict"], "PASS")

    def test_missing_and_duplicate_required_pairs_fail(self):
        original = copy.deepcopy(self.record["entries"])
        for entries in [[], original + original]:
            with self.subTest(entries=len(entries)):
                self.record["entries"] = entries
                self.assert_failure()

    def test_current_report_or_frozen_discovery_mismatch_fails(self):
        for key in ["reported_facts_sha256", "discovery_sha256"]:
            with self.subTest(key=key):
                old = self.record[key]
                self.record[key] = "0" * 64
                self.assert_failure()
                self.record[key] = old

    def test_changed_source_refs_or_original_text_fails(self):
        self.record["entries"][0]["source_refs"] = ["offline#other-post"]
        self.assert_failure()
        self.record["entries"][0]["source_refs"] = ["offline#post-1"]
        self.archive["facts"][0]["original_text"] = "Different original post"
        self.save_archive()
        self.assert_failure()

    def test_wrong_category_cannot_borrow_another_category_representative(self):
        other = "Unrelated category's representative."
        self.facts.append(other)
        self.record["reported_facts_sha256"] = canonical_hash(sorted(set(self.facts)))
        self.archive["categories"].append({"id": "C2", "policy_category": "Other category",
            "selected_facts": [{"text": other}]})
        self.save_archive()
        self.record["entries"][0]["categories"] = ["Other category"]
        self.record["entries"][0]["representative_facts"] = [other]
        self.assert_failure()
        self.record["entries"][0]["categories"] = ["Public mentions"]
        self.assert_failure()

    def test_unrepresented_category_and_empty_archive_fail(self):
        self.record["entries"][0]["representative_facts"] = []
        self.assert_failure()
        self.record["entries"][0]["representative_facts"] = [self.fact]
        write_json(self.context_path, {})
        self.record["context_archives"] = [self.ref(self.context_path)]
        self.assert_failure()

    def test_tampered_file_hash_fails(self):
        self.archive_path.write_text('{}', encoding='utf-8')
        self.assert_failure("DISCOVERY_SOURCE_HASH")

    def test_nonrisk_or_objective_closure_requires_matching_archive(self):
        for disposition in ["no_policy_hit", "objective_unavailable"]:
            with self.subTest(disposition=disposition):
                self.archive["facts"][0].update(disposition=disposition, category_ids=[])
                self.record["entries"][0].update(disposition=disposition, categories=[], representative_facts=[])
                self.save_archive()
                self.assertEqual(self.audit()["verdict"], "PASS")
        self.record["entries"][0]["disposition"] = "no_policy_hit"
        self.assert_failure()

    def test_pending_is_never_completed_by_archive(self):
        self.archive["facts"][0]["disposition"] = "pending"
        self.record["entries"][0]["disposition"] = "pending"
        self.save_archive()
        self.assert_failure()

    def test_retired_original_queries_are_not_required(self):
        path = Path(self.review["subagent_review"]["receipt_path"])
        receipt = json.loads(path.read_text("utf-8"))
        receipt["reviews"][0]["queries"] = []
        write_json(path, receipt)
        self.assertEqual(self.audit()["verdict"], "PASS")

    def test_all_original_contexts_must_still_be_semantically_reviewed(self):
        self.review["semantic_review"]["items"].pop()
        self.record["discovery_sha256"] = canonical_hash(self.review)
        self.assertNotEqual(self.audit()["verdict"], "PASS")


if __name__ == "__main__":
    unittest.main()
