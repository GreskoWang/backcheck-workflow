"""离线反例基于交接包已披露的实际缺口；不执行附件代码。"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MODULE = Path(__file__).resolve().parents[2] / "coverage" / "validate.py"
SPEC = importlib.util.spec_from_file_location("batch_coverage", MODULE)
coverage = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(coverage)


def base(count=1):
    items = [{"source_id": f"post-{i}", "post_url": f"https://example.com/post/{i}",
              "text": "完整正文😀" * 20, "text_truncated": False,
              "needs_expansion": False, "media": []} for i in range(count)]
    data = {"schema_version": 1, "items": items, "scope": {}, "conclusion": "checked_no_issue",
            "coverage": {"collection_complete": True, "visible_endpoint_verified": True,
                         "stop_reason": "visible_endpoint", "observed_count": count,
                         "unresolved": []}}
    review = coverage.create_text_review_manifest(items, 256)
    review["reviewer"] = "codex-reader"
    for batch in review["text_batches"]:
        batch["reviewed"] = True
    data["review"] = review
    return data


def codes(result):
    return {issue["code"] for issue in result["issues"]}


class CoverageTests(unittest.TestCase):
    def test_legacy_no_title_digest_stays_exactly_compatible(self):
        data = base()
        rows = [(i.get("source_id"), i.get("text", ""), i.get("quoted_text", "")) for i in data["items"]]
        old = hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        self.assertEqual(coverage.text_snapshot_digest(data["items"]), old)
        data["items"][0]["title"] = ""
        self.assertEqual(coverage.text_snapshot_digest(data["items"]), old)
        self.assertTrue(coverage.validate_batch(data)["coverage_complete"])

    def test_video_title_must_be_read_separately_from_description(self):
        data = base()
        data["items"][0].update(title="标题含需要审阅的新信息😀", text="-")
        review = coverage.create_text_review_manifest(data["items"], 256)
        self.assertIn("title", [s["field"] for b in review["text_batches"] for s in b["segments"]])
        self.assertFalse(coverage.validate_batch(data, review)["coverage_complete"])
        review["reviewer"] = "codex-reader"
        for b in review["text_batches"]:
            b["reviewed"] = True
        self.assertTrue(coverage.validate_batch(data, review)["coverage_complete"])
        review["text_batches"][0]["segments"] = [s for s in review["text_batches"][0]["segments"] if s["field"] != "title"]
        self.assertIn("unread_text", codes(coverage.validate_batch(data, review)))

    def test_changed_title_invalidates_old_reading_confirmation(self):
        data = base()
        data["items"][0]["title"] = "原标题"
        review = coverage.create_text_review_manifest(data["items"], 256)
        review["reviewer"] = "codex-reader"
        for b in review["text_batches"]:
            b["reviewed"] = True
        data["items"][0]["title"] = "已改变"
        self.assertIn("stale_reading_confirmation", codes(coverage.validate_batch(data, review)))

    def test_complete_text_passes(self):
        result = coverage.validate_batch(base())
        self.assertTrue(result["format_valid"])
        self.assertTrue(result["coverage_complete"])

    def test_acquired_is_not_read(self):
        data = base()
        data.pop("review")
        result = coverage.validate_batch(data)
        self.assertTrue(result["format_valid"])
        self.assertFalse(result["coverage_complete"])
        self.assertIn("unread_text", codes(result))

    def test_handoff_54_of_77_and_55_of_103_cannot_claim_complete(self):
        for observed, displayed in ((54, 77), (55, 103)):
            with self.subTest(observed=observed):
                data = base(observed)
                data["coverage"].update(displayed_count=displayed, stop_reason="stall")
                result = coverage.validate_batch(data)
                self.assertIn("displayed_count_gap", codes(result))
                self.assertIn("invalid_endpoint", codes(result))
                self.assertFalse(result["coverage_complete"])

    def test_unknown_cumulative_count_does_not_require_impossible_equality(self):
        data = base(2)
        data["coverage"].update(displayed_count=3406, displayed_count_enumerable=False,
                                stop_reason="public_boundary")
        data["scope"]["public_boundary"] = {"verified": True, "reason": "登录态主页与成功接口均仅显示2条公开帖；累计计数含非公开历史。"}
        self.assertTrue(coverage.validate_batch(data)["coverage_complete"])

    def test_unverified_count_exception_is_not_enough(self):
        data = base(2)
        data["coverage"].update(displayed_count=3406, displayed_count_enumerable=False,
                                stop_reason="public_boundary")
        data["scope"]["public_boundary"] = {"verified": False, "reason": "猜测可能是私密帖"}
        self.assertIn("displayed_count_gap", codes(coverage.validate_batch(data)))

    def test_first_95_characters_is_not_full_read(self):
        data = base()
        data["items"][0]["text_truncated"] = True
        for batch in data["review"]["text_batches"]:
            for seg in batch["segments"]:
                seg["end"] = min(seg["end"], 95)
        result = coverage.validate_batch(data)
        self.assertIn("text_incomplete", codes(result))
        self.assertIn("unread_text", codes(result))

    def test_missing_one_character_at_batch_boundary_is_not_complete(self):
        data = base()
        data["review"]["text_batches"][0]["segments"][0]["end"] -= 1
        self.assertIn("unread_text", codes(coverage.validate_batch(data)))

    def test_export_preserves_large_multilingual_body_and_quoted_text(self):
        data = base()
        item = data["items"][0]
        item["text"] = ("中文😀e\u0301\n" * 3000) + "终点不能漏"
        item["quoted_text"] = "转发原文" * 500
        manifest = coverage.create_text_review_manifest(data["items"], 300)
        self.assertGreater(len(manifest["text_batches"]), 10)
        for batch in manifest["text_batches"]:
            self.assertLessEqual(len(batch["content"]), 300)
            self.assertFalse(batch["reviewed"])
        for field in ("text", "quoted_text"):
            pieces = [item[field][s["start"]:s["end"]]
                      for b in manifest["text_batches"] for s in b["segments"] if s["field"] == field]
            self.assertEqual("".join(pieces), item[field])
        manifest["reviewer"] = "codex-reader"
        for batch in manifest["text_batches"]:
            batch["reviewed"] = True
        self.assertTrue(coverage.validate_batch(data, manifest)["coverage_complete"])

    def test_output_truncation_does_not_inherit_manifest_completion(self):
        data = base()
        data["review"]["text_batches"][0]["output_truncated"] = True
        self.assertIn("reading_output_truncated", codes(coverage.validate_batch(data)))

    def test_cache_changes_invalidate_old_confirmation(self):
        data = base()
        data["items"][0]["text"] = data["items"][0]["text"].replace("完整", "改动")
        self.assertIn("stale_reading_confirmation", codes(coverage.validate_batch(data)))

    def test_ig_failed_search_is_not_no_homepage_or_no_results(self):
        data = base(0)
        data["conclusion"] = "no_related_results"
        data["coverage"].update(collection_complete=False, visible_endpoint_verified=False,
                               stop_reason="http_error", last_response_valid=False)
        data["scope"]["search"] = {"query": "handle", "no_results_verified": False}
        result = coverage.validate_batch(data)
        self.assertTrue(result["format_valid"])
        self.assertIn("unsupported_no_results", codes(result))
        self.assertFalse(result["coverage_complete"])

    def test_successful_explicit_no_results_is_a_distinct_state(self):
        data = base(0)
        data["conclusion"] = "no_related_results"
        data["coverage"]["stop_reason"] = "no_results"
        data["scope"]["search"] = {"query": "派单原名", "no_results_verified": True}
        result = coverage.validate_batch(data)
        self.assertTrue(result["coverage_complete"])
        self.assertEqual(result["conclusion"], "no_related_results")

    def test_empty_or_error_response_is_not_endpoint(self):
        for reason in ("empty_response", "error", "invalid_response", "limit", "cancelled"):
            data = base()
            data["coverage"]["stop_reason"] = reason
            self.assertFalse(coverage.validate_batch(data)["coverage_complete"])

    def test_no_risk_keyword_hit_does_not_mark_read(self):
        data = base()
        data["review"] = {"keyword_scan_done": True, "keyword_hits": []}
        self.assertIn("unread_text", codes(coverage.validate_batch(data)))

    def test_collector_cannot_confirm_reading(self):
        data = base()
        data["review"]["reviewer"] = "collector"
        self.assertIn("reviewer_missing", codes(coverage.validate_batch(data)))

    def test_whitespace_and_case_cannot_turn_automatic_reader_into_actual_reader(self):
        for reviewer in (" collector ", " AuTo ", "\tautomatic\n"):
            with self.subTest(reviewer=reviewer):
                data = base()
                data["review"]["reviewer"] = reviewer
                self.assertIn("reviewer_missing", codes(coverage.validate_batch(data)))
                data["review"]["reviewer"] = "codex-reader"
                data["items"][0]["media"] = [{"media_id": "image-1", "kind": "image"}]
                data["review"]["media_reviews"] = [{"post_source_id": "post-0", "media_id": "image-1", "reviewed": True, "capabilities": ["overview"], "reviewer": reviewer}]
                self.assertIn("unread_media", codes(coverage.validate_batch(data)))
                data["items"][0]["media"] = []
                data["review"]["media_reviews"] = []
                data["scope"]["comments"] = [{"scope_id": "selected-comments"}]
                data["review"]["comment_reviews"] = [{"scope_id": "selected-comments", "reviewed": True, "complete": True, "boundary_verified": True, "reviewer": reviewer}]
                self.assertIn("unread_comments", codes(coverage.validate_batch(data)))

    def test_quoted_text_needs_its_own_automatic_range(self):
        data = base()
        data["items"][0]["quoted_text"] = "尚未读取的转发原文"
        data["review"]["text_snapshot_digest"] = coverage.text_snapshot_digest(data["items"])
        self.assertIn("unread_text", codes(coverage.validate_batch(data)))

    def test_missing_media_is_not_complete(self):
        data = base()
        data["items"][0]["media_count"] = 3
        data["items"][0]["media"] = [{"url": "https://example.com/img/1.jpg", "kind": "image"}]
        result = coverage.validate_batch(data)
        self.assertIn("missing_media", codes(result))
        self.assertIn("unread_media", codes(result))

    def test_image_overview_is_enough_unless_original_requested(self):
        data = base()
        data["items"][0]["media"] = [{"media_id": "im-1", "kind": "image"}]
        data["review"]["media_reviews"] = [{"post_source_id": "post-0", "media_id": "im-1",
                                            "reviewed": True, "capabilities": ["overview"]}]
        self.assertTrue(coverage.validate_batch(data)["coverage_complete"])
        data["items"][0]["media"][0]["needs_original"] = True
        self.assertIn("unread_media", codes(coverage.validate_batch(data)))
        data["review"]["media_reviews"][0]["capabilities"] = ["original"]
        self.assertTrue(coverage.validate_batch(data)["coverage_complete"])

    def test_video_poster_inherits_image_overview_requirement(self):
        data = base()
        data["items"][0]["media"] = [{"media_id": "poster-1", "kind": "video-poster"}]
        self.assertIn("unread_media", codes(coverage.validate_batch(data)))
        data["review"]["media_reviews"] = [{"post_source_id": "post-0", "media_id": "poster-1", "reviewed": True, "capabilities": ["overview"]}]
        self.assertTrue(coverage.validate_batch(data)["coverage_complete"])

    def test_only_selected_video_capabilities_are_required(self):
        data = base()
        data["items"][0]["media"] = [{"media_id": "vid-1", "kind": "video"}, {"media_id": "vid-2", "kind": "video"}]
        data["scope"]["selected_media"] = [{"post_source_id": "post-0", "media_id": "vid-1",
                                           "required": ["visual", "audio"]}]
        data["review"]["media_reviews"] = [{"post_source_id": "post-0", "media_id": "vid-1",
                                            "reviewed": True, "capabilities": ["visual"]}]
        self.assertIn("unread_media", codes(coverage.validate_batch(data)))
        data["review"]["media_reviews"][0]["capabilities"].append("audio")
        self.assertTrue(coverage.validate_batch(data)["coverage_complete"])

    def test_comments_only_required_when_in_scope(self):
        data = base()
        self.assertTrue(coverage.validate_batch(data)["coverage_complete"])
        data["scope"]["comments"] = [{"scope_id": "author-comments-on-risk-video"}]
        self.assertIn("unread_comments", codes(coverage.validate_batch(data)))
        data["review"]["comment_reviews"] = [{"scope_id": "author-comments-on-risk-video", "reviewed": True,
                                              "complete": True, "boundary_verified": True, "unread_ranges": []}]
        self.assertTrue(coverage.validate_batch(data)["coverage_complete"])

    def test_risk_found_is_preserved_when_other_routes_are_incomplete(self):
        data = base()
        data["conclusion"] = "risk_found"
        data["coverage"]["collection_complete"] = False
        result = coverage.validate_batch(data)
        self.assertFalse(result["coverage_complete"])
        self.assertEqual(result["conclusion"], "risk_found")

    def test_incomplete_record_can_be_format_valid(self):
        data = base()
        data["conclusion"] = "incomplete"
        data["coverage"]["unresolved"] = ["older posts not loaded"]
        result = coverage.validate_batch(data)
        self.assertTrue(result["format_valid"])
        self.assertFalse(result["coverage_complete"])

    def test_duplicate_ids_and_out_of_range_are_structural_errors(self):
        data = base()
        data["items"].append(copy.deepcopy(data["items"][0]))
        data["review"]["text_batches"][0]["segments"][0]["end"] = 100000
        result = coverage.validate_batch(data)
        self.assertFalse(result["format_valid"])
        self.assertIn("duplicate_source_id", codes(result))
        self.assertIn("invalid_read_range", codes(result))

    def test_malformed_external_types_report_errors_instead_of_crashing(self):
        data = base()
        data["coverage"]["stop_reason"] = []
        data["coverage"]["displayed_count"] = True
        data["scope"]["images"] = []
        data["conclusion"] = []
        data["review"]["text_batches"][0]["segments"][0]["source_id"] = []
        data["scope"]["selected_media"] = [{"post_source_id": [], "media_id": []}]
        data["review"]["media_reviews"] = [{"post_source_id": [], "media_id": []}]
        result = coverage.validate_batch(data)
        self.assertFalse(result["format_valid"])
        self.assertFalse(result["coverage_complete"])

    def test_scope_boundary_requires_explicit_scope_evidence(self):
        data = base()
        data["coverage"]["stop_reason"] = "scope_boundary"
        self.assertIn("scope_boundary_unverified", codes(coverage.validate_batch(data)))
        data["scope"]["boundary"] = {"verified": True, "reason": "用户仅要求最近一年，已读至2025-10-13前的连续条目。"}
        self.assertTrue(coverage.validate_batch(data)["coverage_complete"])

    def test_cli_exports_unreviewed_and_reports_separate_statuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = base()
            data.pop("review")
            (root / "input.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            result = subprocess.run([sys.executable, "-X", "utf8", str(MODULE), str(root / "input.json"),
                                     "--export-text", str(root / "read"), "--max-chars", "256"],
                                    capture_output=True, text=True, encoding="utf-8", check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            self.assertTrue(output["format_valid"])
            self.assertFalse(output["coverage_complete"])
            manifest = json.loads((root / "read" / "review.json").read_text(encoding="utf-8"))
            self.assertTrue(all(not b["reviewed"] for b in manifest["text_batches"]))
            self.assertTrue((root / "read" / "text-0001.txt").exists())
            result2 = subprocess.run([sys.executable, "-X", "utf8", str(MODULE), str(root / "input.json"), "--require-complete"],
                                     capture_output=True, text=True, encoding="utf-8", check=False)
            self.assertEqual(result2.returncode, 1)


if __name__ == "__main__":
    unittest.main()
