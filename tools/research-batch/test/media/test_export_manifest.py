"""Offline result -> export -> fake fetch -> real sheet counterexamples."""
from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

MEDIA_DIR = Path(__file__).resolve().parents[2] / "media"
sys.path.insert(0, str(MEDIA_DIR))
import export_manifest as export
import fetch_assets


class ExportManifestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="媒体导出测试-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def post(self, source_id="post-1", entries=None, **fields):
        return {"source_id": source_id, "post_url": f"https://example.org/post/{source_id}",
                "account": "示例账号", "date": "2026-10-14", "text": "正文", "text_truncated": False,
                "media": [{"kind": "image", "url": "https://images.example.org/1.png", "media_id": "img-1"}] if entries is None else entries,
                **fields}

    def result(self, posts):
        return {"schema_version": 1, "items": posts, "conclusion": "incomplete"}

    def test_mapping_and_supported_image_kinds(self):
        kinds = ["image", "photo", "cover", "thumbnail", "video-poster"]
        result = export.export_result(self.result([self.post(entries=[{"kind": kind, "url": f"https://images.example.org/{i}.png", "media_id": str(i)} for i, kind in enumerate(kinds)])]))
        self.assertEqual(len(result["items"]), 5)
        self.assertEqual(len({item["source_id"] for item in result["items"]}), 5)
        for item in result["items"]:
            self.assertEqual(item["post_source_id"], "post-1")
            self.assertEqual(item["account"], "示例账号")
            self.assertEqual(item["date"], "2026-10-14")
            self.assertEqual(item["post_url"], "https://example.org/post/post-1")
            self.assertEqual(item["referer"], item["post_url"])
        self.assertFalse(result["coverage_complete"])
        self.assertEqual(result["review_status"], "not_reviewed")

    def test_same_url_in_two_posts_keeps_both_attributions(self):
        result = export.export_result(self.result([self.post("one"), self.post("two")]))
        first, second = result["items"]
        self.assertEqual(first["url"], second["url"])
        self.assertNotEqual(first["source_id"], second["source_id"])
        self.assertEqual([first["post_source_id"], second["post_source_id"]], ["one", "two"])

    def test_non_media_types_are_filtered_with_reason(self):
        entries = [{"kind": kind, "url": "https://example.org/x"} for kind in ("avatar", "emoji", "link")]
        entries.append({"url": "https://example.org/unknown"})
        result = export.export_result(self.result([self.post(entries=entries)]))
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["export_error_code"], "media_kind_unverified")
        self.assertTrue(result["items"][0]["candidate"])
        self.assertEqual(result["export_report"]["filtered_count"], 3)
        self.assertTrue(all(item["reason"] == "explicit_non_media_kind" for item in result["export_report"]["filtered"]))

    def test_declared_missing_media_keep_failure_slots(self):
        result = export.export_result(self.result([self.post(media_count=3)]))
        self.assertEqual(len(result["items"]), 3)
        self.assertEqual([item["export_status"] for item in result["items"]], ["ready", "unavailable", "unavailable"])
        self.assertEqual(result["items"][1]["export_error_code"], "media_missing_from_declared_count")

    def test_unknown_gallery_gap_does_not_invent_exact_image_count(self):
        result = export.export_result(self.result([self.post(warnings=["unexpanded_gallery"], media_count=1)]))
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(result["items"][1]["export_error_code"], "media_gap_count_unknown")

    def test_video_keeps_playback_placeholder_without_image_download_url(self):
        result = export.export_result(self.result([self.post(entries=[{"kind": "video", "url": "https://videos.example.org/1.mp4", "media_id": "vid-1"}])]))
        item = result["items"][0]
        self.assertEqual(item["source_media_id"], "vid-1")
        self.assertIsNone(item["url"])
        self.assertEqual(item["export_error_code"], "video_requires_playback")

    def test_auth_url_and_url_media_id_do_not_leak_or_get_rewritten(self):
        value = "https://images.example.org/a.png?x-amz-signature=private-secret-value"
        result = export.export_result(self.result([self.post(entries=[{"kind": "image", "url": value, "media_id": value}])]))
        self.assertNotIn("private-secret-value", json.dumps(result))
        item = result["items"][0]
        self.assertIsNone(item["url"])
        self.assertTrue(item["source_media_id_restricted"])
        self.assertTrue(item["source_media_id"].startswith("restricted-url-sha256:"))
        self.assertEqual(item["export_error_code"], "url_auth_query_rejected")

    def test_source_urls_cannot_bypass_redaction_through_metadata_or_report(self):
        value = "https://example.org/post/1?token=source-secret"
        result = export.export_result(self.result([self.post(value, post_url=value, account=value, date=value)]))
        serialized = json.dumps(result)
        self.assertNotIn("source-secret", serialized)
        self.assertTrue(result["items"][0]["post_source_id"].startswith("restricted-url-sha256:"))
        self.assertEqual(result["items"][0]["source_metadata"]["post_url"], None)
        self.assertIsNone(result["items"][0]["url"])

    def test_null_source_metadata_is_explicit_not_invented(self):
        result = export.export_result(self.result([self.post(account=None, date=None, post_url=None)]))
        item = result["items"][0]
        self.assertEqual(item["account"], "未取得账号")
        self.assertEqual(item["date"], "未取得日期")
        self.assertEqual(item["post_url"], "未取得原帖链接")
        self.assertEqual(item["source_metadata"], {"account": None, "post_url": None, "date": None})

    def test_explicit_and_url_placeholders_do_not_get_downloaded(self):
        result = export.export_result(self.result([self.post(entries=[{"kind": "placeholder", "url": "https://images.example.org/fake.png"},
                                                                   {"kind": "image", "url": "https://images.example.org/placeholder.png"}])]))
        self.assertEqual([item["export_status"] for item in result["items"]], ["unavailable", "unavailable"])
        self.assertTrue(all(item["url"] is None for item in result["items"]))

    def test_duplicate_post_id_is_format_error_without_echoing_url(self):
        value = "https://example.org/?token=do-not-print"
        with self.assertRaises(export.media.ManifestError) as raised:
            export.export_result(self.result([self.post(value), self.post(value)]))
        self.assertNotIn("do-not-print", str(raised.exception))

    def test_malformed_media_entry_keeps_failure_instead_of_aborting_batch(self):
        result = export.export_result(self.result([self.post(entries=[None, {"kind": {"invalid": "kind"}}]), self.post("good")]))
        self.assertEqual(len(result["items"]), 3)
        self.assertEqual(result["items"][0]["export_error_code"], "media_entry_invalid")
        self.assertEqual(result["items"][1]["export_error_code"], "media_kind_unverified")
        self.assertEqual(result["items"][2]["export_status"], "ready")

    def test_cli_and_fetch_and_sheet_chain_preserves_failed_slots(self):
        result_path = self.root / "result.json"
        result = self.result([self.post(media_count=2), self.post("video", entries=[{"kind": "video", "url": "https://videos.example.org/1.mp4", "media_id": "vid"}])])
        result_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        before = result_path.read_bytes()
        exported = self.root / "媒体manifest.json"
        run = subprocess.run([sys.executable, "-B", "-X", "utf8", str(MEDIA_DIR / "export_manifest.py"), str(result_path), str(exported)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(run.returncode, 2, run.stderr)
        self.assertEqual(result_path.read_bytes(), before)

        class Transport:
            def __init__(self):
                self.calls = []

            def fetch(self, url, **kwargs):
                self.calls.append(url)
                buffer = BytesIO()
                Image.new("RGB", (40, 30), "red").save(buffer, "PNG")
                return fetch_assets.TransportResponse(200, "image/png", buffer.getvalue(), url)

        transport = Transport()
        fetch_assets.download_batch(exported, self.root / "downloaded", transport=transport)
        self.assertEqual(len(transport.calls), 1)
        download_index = json.loads((self.root / "downloaded" / "download-index.json").read_text(encoding="utf-8"))
        self.assertEqual([item.get("error_code") for item in download_index["items"]], [None, "media_missing_from_declared_count", "video_requires_playback"])
        run = subprocess.run([sys.executable, "-B", "-X", "utf8", str(MEDIA_DIR / "media.py"), "sheet", str(self.root / "downloaded" / "local-manifest.json"), str(self.root / "sheets")], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(run.returncode, 2, run.stderr)
        index = json.loads((self.root / "sheets" / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(len(index["items"]), 3)
        self.assertEqual([item["cell"] for item in index["items"]], [1, 2, 3])

    def test_file_output_does_not_overwrite(self):
        source = self.root / "result.json"
        source.write_text(json.dumps(self.result([self.post()])), encoding="utf-8")
        target = self.root / "manifest.json"
        target.write_text("user data", encoding="utf-8")
        with self.assertRaises(export.media.ManifestError):
            export.export_file(source, target)
        self.assertEqual(target.read_text(encoding="utf-8"), "user data")

    def test_zero_media_is_reported_without_fake_placeholder(self):
        result = export.export_result(self.result([self.post(entries=[], media_count=0)]))
        self.assertEqual(result["items"], [])
        self.assertTrue(result["export_report"]["empty_media_manifest"])
        self.assertEqual(result["export_report"]["preparation_action"], "skip_fetch_and_sheet")

    def test_signed_media_placeholder_goes_through_fetch_without_any_request(self):
        secret = "https://images.example.org/a.png?signature=never-export-this"
        source = self.root / "result.json"
        source.write_text(json.dumps(self.result([self.post(entries=[{"kind": "image", "url": secret, "media_id": secret}])])), encoding="utf-8")
        manifest = self.root / "manifest.json"
        export.export_file(source, manifest)

        class NeverTransport:
            def fetch(self, *args, **kwargs):
                raise AssertionError("a failed signed asset must not make a request")

        summary = fetch_assets.download_batch(manifest, self.root / "downloaded", transport=NeverTransport())
        self.assertEqual(summary["attempted_item_count"], 0)
        self.assertEqual(summary["request_count"], 0)
        self.assertEqual(summary["failed_count"], 1)
        index = (self.root / "downloaded" / "download-index.json").read_text(encoding="utf-8")
        self.assertNotIn("never-export-this", index)
        self.assertEqual(json.loads(index)["items"][0]["error_code"], "url_auth_query_rejected")


if __name__ == "__main__":
    unittest.main(verbosity=2)
