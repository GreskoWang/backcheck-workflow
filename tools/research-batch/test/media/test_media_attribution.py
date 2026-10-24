"""Regression: detail candidates must not become attributed/reviewed during media prep."""
from io import BytesIO
import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

MEDIA_DIR = Path(__file__).resolve().parents[2] / "media"
sys.path.insert(0, str(MEDIA_DIR))
import export_manifest
import fetch_assets
import media


class AttributionPropagationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="候选媒体传播-")
        self.root = Path(self.temp.name)
        self.flags = {"candidate": True, "attribution_verified": False, "review_state": "not_reviewed",
                      "review_status": "not_reviewed", "reviewed": False, "visual_reviewed": False,
                      "audio_reviewed": False, "subtitles_reviewed": False, "motion_reviewed": False, "comments_reviewed": False}

    def tearDown(self):
        self.temp.cleanup()

    def source(self, entries):
        return {"schema_version": 1, "adapter": "research-detail-v1", "items": [{
            "source_id": "post-1", "post_url": "https://example.org/post/1", "account": "已确认文字作者",
            "date": "2026-10-15", "text": "正文", "text_truncated": False, "needs_expansion": False,
            "media": entries, "media_count": len(entries)}], "coverage": {"media_review_complete": False},
            "conclusion": "incomplete"}

    def pipeline(self, source):
        input_file = self.root / "detail-result.json"
        input_file.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
        export_file = self.root / "export.json"
        run = subprocess.run([sys.executable, "-B", "-X", "utf8", str(MEDIA_DIR / "export_manifest.py"), str(input_file), str(export_file)], capture_output=True, text=True, encoding="utf-8")
        self.assertIn(run.returncode, (0, 2), run.stderr)

        class Transport:
            def __init__(self):
                self.calls = []

            def fetch(self, url, **kwargs):
                self.calls.append(url)
                output = BytesIO()
                Image.new("RGB", (48, 48), "red").save(output, "PNG")
                return fetch_assets.TransportResponse(200, "image/png", output.getvalue(), url)

        transport = Transport()
        fetch_assets.download_batch(export_file, self.root / "downloaded", transport=transport)
        run = subprocess.run([sys.executable, "-B", "-X", "utf8", str(MEDIA_DIR / "media.py"), "sheet",
                              str(self.root / "downloaded" / "local-manifest.json"), str(self.root / "sheets")], capture_output=True, text=True, encoding="utf-8")
        self.assertIn(run.returncode, (0, 2), run.stderr)
        stages = [json.loads(path.read_text(encoding="utf-8"))["items"] for path in (
            export_file, self.root / "downloaded" / "download-index.json",
            self.root / "downloaded" / "local-manifest.json", self.root / "sheets" / "index.json")]
        return stages, transport

    def test_emoji_and_defaulticon_candidates_keep_all_flags_through_real_cli_chain(self):
        entries = [{"kind": "image", "url": f"https://images.example.org/{name}.png", "media_id": name, **self.flags}
                   for name in ("emoji", "defaulticon")]
        stages, transport = self.pipeline(self.source(entries))
        self.assertEqual(len(transport.calls), 2)
        for stage in stages:
            self.assertEqual(len(stage), 2)
            for item in stage:
                for key, value in self.flags.items():
                    self.assertEqual(item[key], value, (key, item))
                self.assertEqual(item["post_source_id"], "post-1")
        for item in stages[-1]:
            self.assertEqual(item["status"], "prepared")
            self.assertEqual(item["display_attribution"], "候选/归属待核")
        for path in (self.root / "downloaded" / "download-index.csv", self.root / "sheets" / "index.csv"):
            with path.open(encoding="utf-8-sig", newline="") as file:
                rows = list(csv.DictReader(file))
            self.assertEqual(rows[0]["candidate"], "True")
            self.assertEqual(rows[0]["attribution_verified"], "False")
            self.assertEqual(rows[0]["review_state"], "not_reviewed")

    def test_unknown_candidate_media_is_not_filtered_or_downloaded(self):
        entries = [{"kind": "unknown-embedded-media", "url": "https://images.example.org/unknown", "media_id": "unknown", **self.flags},
                   {"kind": "emoji", "url": "https://images.example.org/emoji.png", "media_id": "emoji", **self.flags}]
        stages, transport = self.pipeline(self.source(entries))
        self.assertEqual(transport.calls, [])
        for stage in stages:
            self.assertEqual(len(stage), 2)
            self.assertTrue(all(item["candidate"] and not item["attribution_verified"] for item in stage))
        self.assertTrue(all(item["status"] == "failed" for item in stages[-1]))

    def test_failed_image_still_keeps_candidate_and_review_flags(self):
        stages, transport = self.pipeline(self.source([{"kind": "image", "url": None, "media_id": "missing", **self.flags}]))
        self.assertEqual(transport.calls, [])
        for stage in stages:
            self.assertTrue(stage[0]["candidate"])
            self.assertFalse(stage[0]["attribution_verified"])
            self.assertFalse(stage[0]["reviewed"])
        self.assertEqual(stages[-1][0]["display_attribution"], "候选/归属待核")

    def test_preexisting_verified_source_state_is_preserved_not_reinvented(self):
        flags = {"candidate": False, "attribution_verified": True, "review_state": "reviewed",
                 "review_status": "reviewed", "reviewed": True, "visual_reviewed": True}
        stages, _ = self.pipeline(self.source([{"kind": "image", "url": "https://images.example.org/verified.png", "media_id": "verified", **flags}]))
        for stage in stages:
            for key, value in flags.items():
                self.assertEqual(stage[0][key], value)
        self.assertEqual(stages[-1][0]["display_attribution"], "来源归属已核")
        summary = json.loads((self.root / "sheets" / "summary.json").read_text(encoding="utf-8"))
        self.assertFalse(summary["coverage_complete"])
        self.assertEqual(summary["review_status"], "not_reviewed")

    def test_missing_or_string_boolean_flags_never_upgrade_attribution(self):
        for flags in ({}, {"candidate": "false", "attribution_verified": "true", "reviewed": "true"}):
            with self.subTest(flags=flags):
                state = media.media_state(flags)
                self.assertTrue(state["candidate"])
                self.assertFalse(state["attribution_verified"])
                self.assertEqual(state["review_state"], "not_reviewed")
                self.assertFalse(state.get("reviewed", False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
