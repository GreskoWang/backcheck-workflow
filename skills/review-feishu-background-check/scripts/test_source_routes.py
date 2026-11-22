"""Offline regressions for native post URLs and source-bound exceptions."""
import base64
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import audit_feishu_snapshot as gate


class SourceRoutesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"BACKGROUND_CHECK_WORKSPACE": str(self.root)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_bluesky_native_post_is_not_a_profile(self):
        url = "https://bsky.app/profile/example.test/post/3abc123"
        self.assertFalse(gate._is_profile_or_home_url("境外其他网站", url))
        self.assertTrue(gate._is_direct_content_url("境外其他网站", url))
        for url in ("https://bsky.app/profile/example.test", "https://bsky.app/profile/example.test/post/",
                    "https://example.invalid/profile/example.test/post/3abc123"):
            self.assertTrue(gate._is_profile_or_home_url("境外其他网站", url), url)

    def link_page_fixture(self):
        screenshot = self.root / "synthetic.png"
        screenshot.write_bytes(base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII="))
        record = {"url": "https://linktr.ee/synthetic", "browser": "ego", "author": "Synthetic",
                  "text": "Synthetic\nExample link", "visible_labels": ["Example link"],
                  "checked_at": "2026-11-22T12:00:00Z", "report_summary": "Synthetic authored link page."}
        self.record = self.root / "link-page.json"
        self.record.write_text(json.dumps(record), encoding="utf-8")
        item = {"source_kind": "link_page_content", "url": record["url"], "fact_text": record["report_summary"],
                "link_page_evidence": {"record_path": str(self.record), "record_sha256": gate._file_sha256(self.record),
                    "screenshot_path": str(screenshot), "screenshot_sha256": gate._file_sha256(screenshot)}}
        return item, [{"fact_evidence": {"source_locator": str(self.record)}}]

    def test_link_page_requires_current_bytes_and_fact_binding(self):
        item, modules = self.link_page_fixture()
        self.assertTrue(gate._validated_link_page_content("境外其他网站", item, modules))
        self.assertFalse(gate._validated_link_page_content("Facebook", item, modules))
        self.assertFalse(gate._validated_link_page_content("境外其他网站", item, []))
        for key, value in (("url", "https://example.invalid/synthetic"), ("fact_text", "Unrelated claim")):
            changed = {**item, key: value}
            self.assertFalse(gate._validated_link_page_content("境外其他网站", changed, modules))
        self.record.write_text("{}", encoding="utf-8")
        self.assertFalse(gate._validated_link_page_content("境外其他网站", item, modules))

    def test_link_page_rejects_malformed_record_without_crashing(self):
        item, modules = self.link_page_fixture()
        for value in ([], None, {"url": item["url"], "browser": "ego", "report_summary": item["fact_text"],
                                 "author": "Synthetic", "text": "Synthetic", "checked_at": None}):
            self.record.write_text(json.dumps(value), encoding="utf-8")
            item["link_page_evidence"]["record_sha256"] = gate._file_sha256(self.record)
            self.assertFalse(gate._validated_link_page_content("境外其他网站", item, modules))

    def test_unavailable_closure_requires_same_request_and_exact_url(self):
        url = "https://example.invalid/missing"
        data = {"requestId": "synthetic-request", "waiver": {"answer": "保留不可用说明并结案", "urls": [url]},
                "observed": {"url": url, "browser": "ego", "available": False,
                    "terminal_message": "This Page Does Not Exist", "text": "This Page Does Not Exist",
                    "checked_at": "2026-11-22T12:00:00Z"}}
        path = self.root / "closure.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        module = {"status": "unavailable_closed", "text": f"（1）个人主页：{url} 公开页面不可用。",
                  "fact_evidence": {"source_type": "research_record", "source_locator": str(path) + "#/observed",
                                    "closure_instruction_locator": str(path) + "#/waiver"}}
        payload = {"requestId": data["requestId"]}
        self.assertTrue(gate._verified_user_closed_unavailable(module, payload))
        self.assertFalse(gate._verified_user_closed_unavailable(module, {"requestId": "other-request"}))
        for field, value in (("available", True), ("url", "https://example.invalid/other"),
                             ("terminal_message", "Loading"), ("checked_at", "2026-11-22")):
            changed = copy.deepcopy(data)
            changed["observed"][field] = value
            path.write_text(json.dumps(changed), encoding="utf-8")
            self.assertFalse(gate._verified_user_closed_unavailable(module, payload), field)


if __name__ == "__main__":
    unittest.main()
