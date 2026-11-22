"""Regression coverage for factual source quotations in document review."""
import unittest

from disclaimer_gate import (
    DISCLAIMER_POLICY_VERSION,
    audit_disclaimer_review,
    review_text_fingerprint,
    scan_disclaimer_context,
    scan_disclaimers,
)


class SourceQuoteTests(unittest.TestCase):
    def test_explicit_source_quotes_are_review_notes(self):
        examples = [
            "对象原帖写道：该页面不代表我的立场。",
            "原帖内容：“本页面仅供参考。”",
            "第三方评论：“该页面不代表我的立场。”",
            "原帖称：“本页面仅供参考，不承担任何责任。”",
            "作者回复：「本页面仅供参考。」",
            "截图文字显示：本页仅供参考。",
            'The original poster wrote: "For reference only. No liability."',
            "原帖写道：“我提到的‘仅供参考’是页面上的文字。”",
        ]
        for text in examples:
            with self.subTest(text=text):
                findings, notes = scan_disclaimer_context(text)
                self.assertEqual([], findings)
                self.assertTrue(notes)
                self.assertTrue(all(note["code"] == "SOURCE_QUOTE" for note in notes))

    def test_following_assistant_prose_is_still_scanned(self):
        examples = [
            "原帖称：“该页面不代表我的立场。”本报告仅供参考。",
            "对象原帖写道：该页面不代表我的立场。仅供参考。",
            "对象原帖写道：该页面不代表我的立场\n仅供参考。",
            "对象原帖写道：该页面不代表我的立场，本报告仅供参考。",
            "原帖称：“仅供参考。”本报告仅供参考，不承担任何责任。",
        ]
        for text in examples:
            with self.subTest(text=text):
                findings, notes = scan_disclaimer_context(text)
                self.assertTrue(notes)
                self.assertTrue(any(f["reason"] == "reference_only" for f in findings))

    def test_quote_marks_alone_do_not_hide_assistant_prose(self):
        for text in [
            "公众号“原创”标记也不证明发布者是版权方。",
            "本报告作者写道：“仅供参考。”",
            'This report author wrote: "For reference only."',
            "原帖写道：“内容尚未引完\n本报告仅供参考。",
        ]:
            with self.subTest(text=text):
                self.assertTrue(scan_disclaimers(text))

    def test_one_quote_does_not_hide_later_same_pattern(self):
        findings = scan_disclaimers("原帖称：“仅供参考。”说明一仅供参考。说明二仅供参考。")
        self.assertEqual(2, sum(f["reason"] == "reference_only" for f in findings))

    def test_source_extraction_preserves_cross_block_scan(self):
        self.assertTrue(scan_disclaimers("本报告仅供\n参考。"))
        self.assertTrue(scan_disclaimers("原帖写道：内容\n本报告仅供\n参考。"))


class SourceReviewTests(unittest.TestCase):
    def setUp(self):
        self.text = "对象原帖写道：该页面不代表我的立场。"
        self.document = {"token": "offline-source-quote", "title": "来源记录", "revision_id": 4}
        self.items = [{"block_id": "b1", "block_type": 2, "text": {"elements": [{"text_run": {"content": self.text}}]}}]
        self.review = {
            "status": "PASS", "scope": "full_document", "policy_version": DISCLAIMER_POLICY_VERSION,
            "token": self.document["token"], "revision_id": 4,
            "text_sha256": review_text_fingerprint(self.document, self.items, self.text),
            "reviewer_id": "offline-test", "checked_at": "2026-11-01T12:00:00+08:00", "findings": [],
        }

    def audit(self, review):
        return audit_disclaimer_review(self.document, self.items, self.text, review)

    def test_current_semantic_review_accepts_source_quote(self):
        result = self.audit(self.review)
        self.assertEqual([], result["errors"])
        self.assertEqual([], result["blocked"])
        self.assertTrue(any(note.startswith("SOURCE_QUOTE:") for note in result["info"]))

    def test_quote_still_requires_semantic_review(self):
        result = self.audit(None)
        self.assertEqual([], result["errors"])
        self.assertTrue(any(b["code"] == "DISCLAIMER_REVIEW_REQUIRED" for b in result["blocked"]))

    def test_stale_review_bindings_are_not_reused(self):
        for key, old in [("policy_version", "1.0.0"), ("revision_id", 3), ("text_sha256", "old")]:
            with self.subTest(key=key):
                result = self.audit({**self.review, key: old})
                self.assertTrue(any(b["code"] == "DISCLAIMER_REVIEW_BINDING" for b in result["blocked"]))

    def test_semantic_source_problem_remains_actionable(self):
        review = {**self.review, "status": "FAIL", "findings": [{"location": "b1", "excerpt": self.text, "reason": "引文归属与原帖不一致"}]}
        self.assertTrue(self.audit(review)["errors"])


if __name__ == "__main__":
    unittest.main()
