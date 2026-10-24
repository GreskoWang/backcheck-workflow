"""Isolated regression fixtures for review proof gates; never migrate real ledgers."""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import review_proofs as proof
import validate_research_payload as validator


class ReviewProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=validator.EVIDENCE_ROOT)
        self.root = Path(self.temp.name)
        self.cover = self.root / "video-cover.png"
        self.cover.write_bytes(
            bytes.fromhex(
                "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c02"
                "0000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082"
            )
        )
        self.row = {
            "platform_key": "douyin", "surface": "works", "query_or_account_urls": ["https://www.douyin.com/user/test"],
            "item_id": "123456", "url": "https://www.douyin.com/video/123456", "item_kind": "content",
            "content_type": "video", "author": "测试账号", "published_at": "2026-09-06", "title": "试衣展示",
            "text": "展示游戏角色服装，说明袖口尺寸。", "media_kinds": ["video"],
            "video_metadata": {
                "detail_url": "https://www.douyin.com/video/123456",
                "detail_capture_kind": "video_detail_page",
                "title_state": "present", "cover_state": "present",
                "cover_path": str(self.cover),
                "cover_sha256": hashlib.sha256(self.cover.read_bytes()).hexdigest(),
                "description_state": "complete_expanded",
                "play_count_status": "observed", "play_count": 1234,
                "play_count_source_text": "1234次播放",
                "observed_at": "2026-09-06T10:00:20+08:00",
                "native_rank_evidence": None,
            },
            "media_review_status": "complete",
            "subject_interaction_review_status": "not_applicable", "review_status": "reviewed",
            "risk_decision": "no_risk", "risk_group_id": "",
        }
        self.scope = {"platform_key": "douyin", "surface": "works", "url": "https://www.douyin.com/user/test"}
        self.raw = self.root / "raw-response.json"
        self.raw.write_text(json.dumps({"scope": self.scope, "terminal": {"has_more": False, "items": [], "loading": False, "end_marker": "没有更多作品"},
                                        "items": [copy.deepcopy(self.row)], "text": "没有更多作品"}, ensure_ascii=False), encoding="utf-8")
        sha = hashlib.sha256(self.raw.read_bytes()).hexdigest()
        detail_ref = {"path": str(self.raw), "sha256": sha, "locator": "json:/items/0"}
        self.row["review_evidence"] = {
            "content_sha256": proof.content_sha256(self.row), "decision": "no_risk",
            "context_reason": "说明仅涉及游戏服装袖口尺寸，没有社会议题或价值表达。",
            "reviewer": "synthetic test reviewer", "review_mode": "agent_context",
            "reviewed_at": "2026-09-06T10:00:30+08:00",
            "evidence_refs": [detail_ref],
            "video_triage": {
                "title_reviewed": True, "cover_reviewed": True, "description_reviewed": True,
                "result": "clear", "reason": "标题、封面和完整简介仅说明游戏服装尺寸。",
                "risk_terms_sha256": "0" * 64, "detail_source_ref": detail_ref,
            },
        }
        self.route = {"status": "complete", "surface": "works", "module_key": "homepage",
                      "account_or_query_url": self.scope["url"], "resolved_url": self.scope["url"],
                      "discovered_items": 1, "started_at": "2026-09-06T10:00:00+08:00",
                      "completed_at": "2026-09-06T10:01:00+08:00"}
        self.log = {
            "raw_evidence": [{"path": str(self.raw), "sha256": sha, "kind": "api_response"}],
            "completion_evidence": {"kind": "content_end", **self.scope, "discovered_items": 1,
                                    "observed_at": "2026-09-06T10:00:45+08:00",
                                    "source_ref": {"path": str(self.raw), "sha256": sha, "locator": "json:/terminal/has_more"},
                                    "scope_locator": "/scope", "signal": "has_more_false", "marker": None},
        }

    def tearDown(self):
        self.temp.cleanup()

    def item_errors(self):
        errors = []
        proof.validate_item_review(
            self.row, root=self.root, prefix="item", errors=errors, require_video_triage=True,
        )
        return errors

    def end_errors(self):
        errors = []
        proof.validate_completion_proof(self.route, self.log, platform_key="douyin", root=self.root, prefix="route", errors=errors)
        return errors

    def test_valid_item(self): self.assertEqual(self.item_errors(), [])
    def test_valid_content_end(self): self.assertEqual(self.end_errors(), [])
    def test_missing_review_cannot_be_flags(self):
        del self.row["review_evidence"]
        self.assertTrue(any("missing traceable" in e for e in self.item_errors()))
    def test_automatic_keyword_review_rejected(self):
        self.row["review_evidence"]["review_mode"] = "keyword_only"
        self.assertTrue(self.item_errors())
    def test_default_no_risk_mode_rejected(self):
        self.row["review_evidence"]["review_mode"] = "automatic_default"
        self.assertTrue(self.item_errors())
    def test_item_content_change_invalidates_review(self):
        self.row["text"] = "替换后的内容"
        self.assertTrue(any("differs from item content" in e for e in self.item_errors()))
    def test_media_kind_change_invalidates_review(self):
        self.row["media_kinds"] = ["none"]
        self.assertTrue(any("differs from item content" in e for e in self.item_errors()))
    def test_video_metadata_change_invalidates_review(self):
        self.row["video_metadata"]["play_count"] = 9999
        self.assertTrue(any("differs from item content" in e for e in self.item_errors()))
    def test_missing_video_triage_rejected(self):
        del self.row["review_evidence"]["video_triage"]
        self.assertTrue(any("video_triage" in e for e in self.item_errors()))
    def test_video_triage_requires_exact_fields(self):
        self.row["review_evidence"]["video_triage"]["uncontrolled"] = True
        self.assertTrue(any("requires exactly" in e for e in self.item_errors()))
    def test_video_triage_all_three_surfaces_reviewed(self):
        self.row["review_evidence"]["video_triage"]["description_reviewed"] = False
        self.assertTrue(any("description_reviewed: must be true" in e for e in self.item_errors()))
    def test_video_triage_detail_source_must_be_review_source(self):
        self.row["review_evidence"]["video_triage"]["detail_source_ref"] = {
            "path": str(self.raw),
            "sha256": hashlib.sha256(self.raw.read_bytes()).hexdigest(),
            "locator": "json:/scope",
        }
        self.assertTrue(any("must also appear in evidence_refs" in e for e in self.item_errors()))
    def test_nonvideo_review_forbids_video_triage(self):
        errors = []
        proof.validate_item_review(
            self.row, root=self.root, prefix="item", errors=errors, require_video_triage=False,
        )
        self.assertTrue(any("requires exactly" in e for e in errors))
    def test_additional_discovery_url_reuses_unchanged_content_review(self):
        before = proof.content_sha256(self.row)
        self.row["query_or_account_urls"].append("https://www.douyin.com/search/test")
        self.row["surface"] = "native_search"
        self.assertEqual(proof.content_sha256(self.row), before)
        self.assertEqual(self.item_errors(), [])
    def test_decision_change_invalidates_review(self):
        self.row["risk_decision"] = "risk"
        self.assertTrue(any("must match the item decision" in e for e in self.item_errors()))
    def test_empty_context_rejected(self):
        self.row["review_evidence"]["context_reason"] = ""
        self.assertTrue(self.item_errors())
    def test_missing_reviewer_rejected(self):
        self.row["review_evidence"]["reviewer"] = ""
        self.assertTrue(self.item_errors())
    def test_unzoned_review_rejected(self):
        self.row["review_evidence"]["reviewed_at"] = "2026-09-06"
        self.assertTrue(self.item_errors())
    def test_missing_review_sources_rejected(self):
        self.row["review_evidence"]["evidence_refs"] = []
        self.assertTrue(self.item_errors())
    def test_wrong_raw_hash_rejected(self):
        self.row["review_evidence"]["evidence_refs"][0]["sha256"] = "0" * 64
        self.assertTrue(self.item_errors())
    def test_invalid_raw_locator_rejected(self):
        self.row["review_evidence"]["evidence_refs"][0]["locator"] = "json:/missing"
        self.assertTrue(self.item_errors())
    def test_empty_raw_location_is_not_review_content(self):
        self.row["review_evidence"]["evidence_refs"][0]["locator"] = "json:/terminal/items"
        self.assertTrue(self.item_errors())
    def test_missing_endpoint_rejected(self):
        del self.log["completion_evidence"]
        self.assertTrue(any("missing raw endpoint" in e for e in self.end_errors()))
    def test_page_arrival_rejected(self):
        self.log["completion_evidence"]["kind"] = "page_arrival"
        self.assertTrue(self.end_errors())
    def test_risk_sample_rejected(self):
        self.log["completion_evidence"]["kind"] = "risk_sample"
        self.assertTrue(self.end_errors())
    def test_summary_file_is_not_raw_endpoint(self):
        self.log["raw_evidence"][0]["kind"] = "manual_review_log"
        self.assertTrue(self.end_errors())
    def test_endpoint_source_must_be_registered(self):
        self.log["raw_evidence"] = []
        self.assertTrue(self.end_errors())
    def test_wrong_endpoint_count_rejected(self):
        self.log["completion_evidence"]["discovered_items"] = 0
        self.assertTrue(self.end_errors())
    def test_wrong_surface_rejected(self):
        self.log["completion_evidence"]["surface"] = "photo_posts"
        self.assertTrue(self.end_errors())
    def test_wrong_scope_locator_rejected(self):
        self.log["completion_evidence"]["scope_locator"] = "/items/0"
        self.assertTrue(self.end_errors())
    def test_wrong_observation_time_rejected(self):
        self.log["completion_evidence"]["observed_at"] = "2026-09-06T11:00:00+08:00"
        self.assertTrue(self.end_errors())
    def test_terminal_signal_must_resolve(self):
        self.log["completion_evidence"]["source_ref"]["locator"] = "json:/items"
        self.assertTrue(self.end_errors())
    def test_valid_zero_surface(self):
        self.route["discovered_items"] = 0
        self.log["completion_evidence"].update(kind="empty_surface", discovered_items=0)
        self.assertEqual(self.end_errors(), [])
    def test_zero_arrival_not_content_end(self):
        self.route["discovered_items"] = self.log["completion_evidence"]["discovered_items"] = 0
        self.assertTrue(self.end_errors())
    def test_empty_query_not_homepage(self):
        self.route["discovered_items"] = 0
        self.log["completion_evidence"].update(kind="empty_query", discovered_items=0)
        self.assertTrue(self.end_errors())
    def test_visible_endpoint_marker(self):
        self.log["completion_evidence"].update(signal="explicit_end_marker", marker="没有更多作品")
        self.log["completion_evidence"]["source_ref"]["locator"] = "json:/terminal/end_marker"
        self.assertEqual(self.end_errors(), [])
    def test_navigation_word_is_not_endpoint(self):
        self.log["completion_evidence"].update(signal="explicit_end_marker", marker="作品")
        self.log["completion_evidence"]["source_ref"]["locator"] = "json:/text"
        self.assertTrue(self.end_errors())
    def test_loading_false_is_not_pagination(self):
        self.log["completion_evidence"]["source_ref"]["locator"] = "json:/terminal/loading"
        self.assertTrue(self.end_errors())
    def test_post_quote_is_not_visible_endpoint(self):
        self.log["completion_evidence"].update(signal="explicit_end_marker", marker="没有更多作品")
        self.log["completion_evidence"]["source_ref"]["locator"] = "json:/text"
        self.assertTrue(self.end_errors())
    def test_registered_weibo_full_end_marker(self):
        marker = "没有更多内容了~去其他页面看看吧"
        raw = json.loads(self.raw.read_text(encoding="utf-8"))
        raw["terminal"]["end_marker"] = marker
        self.raw.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        sha = hashlib.sha256(self.raw.read_bytes()).hexdigest()
        self.log["raw_evidence"][0]["sha256"] = sha
        self.log["completion_evidence"].update(signal="explicit_end_marker", marker=marker)
        self.log["completion_evidence"]["source_ref"].update(sha256=sha, locator="json:/terminal/end_marker")
        self.assertEqual(self.end_errors(), [])
    def test_quote_wrapping_full_end_marker_rejected(self):
        marker = "他说：没有更多内容了~去其他页面看看吧"
        raw = json.loads(self.raw.read_text(encoding="utf-8"))
        raw["terminal"]["end_marker"] = marker
        self.raw.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        sha = hashlib.sha256(self.raw.read_bytes()).hexdigest()
        self.log["raw_evidence"][0]["sha256"] = sha
        self.log["completion_evidence"].update(signal="explicit_end_marker", marker=marker)
        self.log["completion_evidence"]["source_ref"].update(sha256=sha, locator="json:/terminal/end_marker")
        self.assertTrue(self.end_errors())
    def test_unrelated_nonempty_item_source_rejected(self):
        self.row["review_evidence"]["evidence_refs"][0]["locator"] = "json:/scope"
        self.assertTrue(any("same complete normalized item" in e for e in self.item_errors()))
    def test_source_content_drift_with_updated_file_hash_rejected(self):
        raw = json.loads(self.raw.read_text(encoding="utf-8"))
        raw["items"][0]["text"] = "已经改变的原始内容"
        self.raw.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        self.row["review_evidence"]["evidence_refs"][0]["sha256"] = hashlib.sha256(self.raw.read_bytes()).hexdigest()
        self.assertTrue(any("same complete normalized item" in e for e in self.item_errors()))
    def test_reviewed_ledger_cannot_prove_itself(self):
        raw = json.loads(self.raw.read_text(encoding="utf-8"))
        raw["items"][0] = copy.deepcopy(self.row)
        self.raw.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        self.row["review_evidence"]["evidence_refs"][0]["sha256"] = hashlib.sha256(self.raw.read_bytes()).hexdigest()
        self.assertTrue(any("cannot prove itself" in e for e in self.item_errors()))
    def test_structure_only_not_delivery_authorization(self):
        self.assertTrue(any("cannot authorize delivery" in e for e in validator.validate({}, check_files=False)))
    def test_json_consistency_does_not_prove_actual_reading(self):
        # A syntactically consistent attestation from this synthetic fixture
        # passes. Tests cannot prove a reviewer actually read/understood it.
        self.row["review_evidence"]["reviewer"] = "unverifiable reviewer claim"
        self.assertEqual(self.item_errors(), [])


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--historical", action="store_true")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--historical-payload", type=Path, action="append", default=[])
    args = parser.parse_args()
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ReviewProofTests))
    report = {"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
              "output": stream.getvalue(), "proof_limit": "Checks establish consistent source hashes, scope and locators; they cannot authenticate actual reading or semantic correctness.",
              "historical": [], "tested_files": {
                  str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in (Path(proof.__file__), Path(validator.__file__), Path(__file__))
              }}
    if args.historical:
        if not args.baseline:
            parser.error("--historical requires --baseline")
        spec = importlib.util.spec_from_file_location("proof_baseline", args.baseline)
        old = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(old)
        if not args.historical_payload:
            parser.error("--historical requires explicit --historical-payload files")
        for path in args.historical_payload:
            name = path.stem
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            old_errors = old.validate(data, check_files=True)
            new_errors = validator.validate(data, check_files=True)
            proof_errors = [error for error in new_errors if "review_evidence" in error or "completion_evidence" in error]
            report["historical"].append({"subject": name, "path": str(path), "baseline_errors": len(old_errors),
                                         "current_errors": len(new_errors), "proof_errors": len(proof_errors), "examples": proof_errors[:3]})
            if old_errors or not proof_errors:
                report["errors"] += 1
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "output"}, ensure_ascii=False, indent=2))
    if report["failures"] or report["errors"]:
        print(report["output"])
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
