"""Regression tests for the content- and block-bound business-risk gate."""

from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

import business_risk_gate as gate

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "background-check-research" / "scripts"))
from test_discovery_gate import fixture as discovery_fixture


def text_block(block_id: str, text: str) -> dict:
    return {
        "block_id": block_id,
        "block_type": 2,
        "text": {"elements": [{"text_run": {"content": text}}]},
    }


class BusinessRiskGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.items = [
            text_block("summary-1", "1：已核实内容尺度风险"),
            text_block("platform-1", "本人公开发布的内容含低俗视觉。"),
            text_block("result", "背调结果：建议评估"),
        ]
        self.review = {
            "status": "PASS",
            "scope": gate.BUSINESS_RISK_SCOPE,
            "token": "doc-test",
            "revision_id": 7,
            "policy_sources": [gate.policy_source()],
            "confirmed_hits": [
                {
                    "business_item": "低俗、色情",
                    "verified_fact": "本人公开发布的内容含低俗视觉。",
                    "risk_group_index": 1,
                    "summary_location": gate.block_location(self.items[0]),
                    "platform_location": gate.block_location(self.items[1]),
                    "result_level": "建议评估",
                    "result_location": gate.block_location(self.items[2]),
                }
            ],
            "conflicts": [],
            "discovery_review": {
                "version": 1, "mode": "user_supplied", "scope": "offline business-gate fixture",
                "instruction": "Offline fixture supplies the researched findings for formatting tests.",
                "source_ref": "test_business_risk_gate.py#setUp",
            },
            "reviewer_id": "reviewer",
            "checked_at": "2026-10-14T00:00:00+08:00",
        }

    _DEFAULT = object()

    def audit(self, review=_DEFAULT):
        return gate.audit_business_risk_review(
            review=self.review if review is self._DEFAULT else review,
            items=self.items,
            document_token="doc-test",
            revision_id=7,
            reviewer_id="reviewer",
            expected_group_indices={1},
        )

    def test_current_policy_and_exact_blocks_pass(self):
        self.assertEqual(self.audit()["verdict"], "PASS")

    def test_consolidation_cannot_substitute_a_different_policy_file(self):
        with tempfile.TemporaryDirectory() as directory:
            policy_copy = Path(directory) / "policy-copy.md"
            policy_copy.write_bytes(gate.CURRENT_BUSINESS_RISK_POLICY.read_bytes())
            self.review["consolidation"] = {"policy": gate.policy_source(policy_copy)}
            result = self.audit()
        self.assertIn("DISCOVERY_CONSOLIDATION_POLICY", {item["code"] for item in result["errors"]})

    def test_missing_discovery_blocks_shared_gate(self):
        self.review.pop("discovery_review")
        result = self.audit()
        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("DISCOVERY_REVIEW_REQUIRED", {x["code"] for x in result["errors"]})

    def test_known_discovery_fact_cannot_be_omitted(self):
        with tempfile.TemporaryDirectory() as directory:
            self.review["discovery_review"] = discovery_fixture(Path(directory))
            result = self.audit()
        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("DISCOVERY_REPORT_OMISSION", {x["code"] for x in result["errors"]})

    def test_complete_v2_discovery_passes_shared_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            discovery = discovery_fixture(Path(directory))
            discovery["entities"][0]["record_fact"] = self.review["confirmed_hits"][0]["verified_fact"]
            self.review["discovery_review"] = discovery
            result = self.audit()
        self.assertEqual(result["verdict"], "PASS", result)

    def test_skipped_item_propagates_fail_and_repair_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            discovery = discovery_fixture(Path(directory))
            discovery["entities"][0]["record_fact"] = self.review["confirmed_hits"][0]["verified_fact"]
            discovery["semantic_review"]["items"].pop()
            self.review["discovery_review"] = discovery
            result = self.audit()
        self.assertEqual(result["verdict"], "FAIL", result)
        coverage = [row for row in result["errors"] if row["code"] == "DISCOVERY_ITEM_COVERAGE"]
        self.assertTrue(coverage)
        self.assertEqual(coverage[0]["repair_stage"], "semantic_analysis")

    def test_missing_extracted_term_propagates_fail_from_source_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            discovery = discovery_fixture(Path(directory))
            discovery["entities"][0]["record_fact"] = self.review["confirmed_hits"][0]["verified_fact"]
            receipt_path = Path(discovery["subagent_review"]["receipt_path"])
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            receipt["reviews"].pop()
            receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
            discovery["entities"].pop()
            self.review["discovery_review"] = discovery
            result = self.audit()
        self.assertEqual(result["verdict"], "FAIL", result)
        self.assertIn("DISCOVERY_UNRESOLVED_NAME", {row["code"] for row in result["errors"]})

    def test_missing_review_is_blocked(self):
        result = self.audit(None)
        self.assertEqual(result["verdict"], "BLOCKED")
        self.assertIn("BUSINESS_RISK_REVIEW", {item["code"] for item in result["blocked"]})

    def test_nonexistent_policy_source_fails(self):
        review = copy.deepcopy(self.review)
        review["policy_sources"] = [{"path": str(gate.CURRENT_BUSINESS_RISK_POLICY.with_name("不存在的风险表.md")), "sha256": "0" * 64}]
        result = self.audit(review)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("BUSINESS_RISK_POLICY_SOURCE_INVALID", {item["code"] for item in result["errors"]})

    def test_existing_unapproved_policy_source_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            fake_policy = Path(directory) / "fake-policy.md"
            fake_policy.write_text("低俗、色情\n", encoding="utf-8")
            review = copy.deepcopy(self.review)
            review["policy_sources"] = [gate.policy_source(fake_policy)]
            result = self.audit(review)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("BUSINESS_RISK_POLICY_SOURCE_UNEXPECTED", {item["code"] for item in result["errors"]})

    def test_changed_policy_hash_is_blocked(self):
        review = copy.deepcopy(self.review)
        review["policy_sources"][0]["sha256"] = "0" * 64
        result = self.audit(review)
        self.assertEqual(result["verdict"], "BLOCKED")
        self.assertIn("BUSINESS_RISK_POLICY_SOURCE_CHANGED", {item["code"] for item in result["blocked"]})

    def test_nonexistent_document_block_fails(self):
        review = copy.deepcopy(self.review)
        review["confirmed_hits"][0]["platform_location"]["block_id"] = "missing-current-block"
        result = self.audit(review)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("BUSINESS_RISK_LOCATION_NOT_FOUND", {item["code"] for item in result["errors"]})

    def test_result_level_must_match_exact_result_block(self):
        review = copy.deepcopy(self.review)
        review["confirmed_hits"][0]["result_level"] = "低合作风险"
        result = self.audit(review)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("BUSINESS_RISK_RESULT_BINDING", {item["code"] for item in result["errors"]})

    def test_explicit_moral_judgment_conflict_fails(self):
        review = copy.deepcopy(self.review)
        review["status"] = "FAIL"
        review["conflicts"] = [{
            "business_item": "LGBTQ/BL/GL（单独成轴）",
            "verified_fact": "作品参与事实",
            "missing_location": "风险摘要",
            "cause": "assistant moral judgment",
        }]
        result = self.audit(review)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("BUSINESS_RISK_CONFLICT", {item["code"] for item in result["errors"]})


if __name__ == "__main__":
    unittest.main()
