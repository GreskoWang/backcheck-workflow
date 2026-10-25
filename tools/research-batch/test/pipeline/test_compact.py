import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from test_prepare import pipeline, fixture, FakeTransport


class CompactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="compact-reading-test-")
        self.root = Path(self.temp.name)
        self.source, self.out = self.root / "result.json", self.root / "reading"
        self.data = fixture(count=2)
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        self.source.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")

    def prepare(self, **kw):
        return pipeline.prepare_result(self.source, self.out, layout="auto", max_chars=200, **kw)

    def read(self):
        return pipeline.compact.read_next(pipeline.compact_api(), self.out)

    def confirm(self, batch):
        return pipeline.compact.confirm(pipeline.compact_api(), self.out, batch["batch_id"], "root")

    def state(self):
        return json.loads((self.out / "state.json").read_text(encoding="utf-8"))

    def test_prepare_is_idempotent_no_exports_or_review_claims(self):
        self.prepare()
        before = (self.out / "state.json").read_bytes()
        for _ in range(3):
            self.prepare()
        self.assertEqual(before, (self.out / "state.json").read_bytes())
        self.assertEqual({p.name for p in self.out.iterdir()}, {"state.json", "processor.lock"})
        self.assertFalse(self.state()["coverage_complete"])

    def test_full_text_read_with_bounded_batches_and_one_checkpoint(self):
        original = self.source.read_bytes()
        self.prepare()
        received = {}
        while True:
            result = self.read()
            if not result["has_text"]:
                break
            self.assertLessEqual(len(result["text"]), 200)
            self.assertEqual(self.read(), result)
            for source in result["sources"]:
                key = (source["source_id"], source["field"])
                received.setdefault(key, []).append((source["start"], source["end"]))
            self.confirm(result)
            self.confirm(result)  # Confirmation retries do not advance twice.
        for item in self.data["items"]:
            for field in ("text", "quoted_text"):
                intervals = received[(item["source_id"], field)]
                self.assertEqual(intervals[0][0], 0)
                self.assertEqual(intervals[-1][1], len(item[field]))
                self.assertTrue(all(a[1] == b[0] for a, b in zip(intervals, intervals[1:])))
        self.assertTrue(self.state()["next_action"]["text_read_complete"])
        self.assertFalse(self.state()["surface_completion"])
        self.assertEqual(original, self.source.read_bytes())
        self.assertFalse(list(self.out.rglob("*.txt")))

    def test_confirm_requires_display_and_human_reader(self):
        self.prepare()
        with self.assertRaises(pipeline.PipelineError):
            self.confirm({"batch_id": "invented"})
        batch = self.read()
        with self.assertRaises(pipeline.PipelineError):
            pipeline.compact.confirm(pipeline.compact_api(), self.out, batch["batch_id"], "collector")
        self.assertEqual(self.state()["cursor"], [0, 0])

    def test_append_keeps_reading_cursor(self):
        self.prepare()
        self.confirm(self.read())
        cursor = self.state()["cursor"]
        added = fixture()["items"][0]
        added["source_id"], added["post_url"] = "post-new", "https://example.org/post/new"
        self.data["items"].append(added)
        self.data["coverage"]["observed_count"] = len(self.data["items"])
        self.save()
        self.prepare()
        self.assertEqual(cursor, self.state()["cursor"])

    def test_reviewed_edit_and_other_task_preserve_checkpoint(self):
        self.prepare()
        self.confirm(self.read())
        before = (self.out / "state.json").read_bytes()
        self.data["items"][0]["text"] = "changed" + self.data["items"][0]["text"]
        self.save()
        with self.assertRaisesRegex(pipeline.PipelineError, "checkpoint preserved"):
            self.prepare()
        self.assertEqual(before, (self.out / "state.json").read_bytes())
        self.data["job"]["id"] = "another-task"
        self.save()
        with self.assertRaises(pipeline.PipelineError):
            self.read()
        self.assertEqual(before, (self.out / "state.json").read_bytes())

    def test_unconfirmed_changed_batch_is_not_confirmed(self):
        self.prepare()
        displayed = self.read()
        before = (self.out / "state.json").read_bytes()
        self.data["items"][0]["text"] = "new text"
        self.save()
        with self.assertRaises(pipeline.PipelineError):
            self.confirm(displayed)
        self.assertEqual(before, (self.out / "state.json").read_bytes())

    def test_legacy_auto_preserves_all_existing_files(self):
        old = pipeline.prepare_result(self.source, self.out, max_chars=200)
        files = {str(p.relative_to(self.out)): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in self.out.rglob("*") if p.is_file() and p.name not in {"state.json", "preparation-state.json"}}
        new = self.prepare()
        self.assertEqual(old["revision_directory"], new["revision_directory"])
        for name, expected in files.items():
            self.assertEqual(expected, hashlib.sha256((self.out / name).read_bytes()).hexdigest())
        with self.assertRaises(pipeline.PipelineError):
            pipeline.prepare_result(self.source, self.out, layout="compact")

    def test_media_generated_once_and_never_automatically_reviewed(self):
        self.data = fixture(count=1, media_count=1)
        self.save()
        transport = FakeTransport()
        self.prepare(fetch_public=True, transport=transport)
        count = len(transport.calls)
        files = {str(p.relative_to(self.out)): p.stat().st_size for p in self.out.rglob("*") if p.is_file()}
        self.prepare(fetch_public=True, transport=transport)
        self.assertEqual(count, len(transport.calls))
        self.assertEqual(files, {str(p.relative_to(self.out)): p.stat().st_size for p in self.out.rglob("*") if p.is_file()})
        self.assertFalse(self.state()["media_batches"][0]["reviewed"])
        pipeline.compact.confirm(pipeline.compact_api(), self.out, "media-0001", "root")
        self.assertTrue(self.state()["media_batches"][0]["reviewed"])

    def test_wait_timeout_does_not_replace_existing_reading_state(self):
        self.prepare()
        self.confirm(self.read())
        before = (self.out / "state.json").read_bytes()
        job = self.root / "job"
        job.mkdir()
        (job / "job.json").write_text(json.dumps({"id": "job-1", "state": "running"}))
        result = pipeline.watch_job(job, self.out, layout="auto", max_wait=0.1, poll_interval=0.05)
        self.assertEqual(result["reason"], "watch_timeout")
        self.assertEqual(before, (self.out / "state.json").read_bytes())
        self.assertFalse((self.out / "events.ndjson").exists())

    def test_cli_defaults_to_compact(self):
        result = subprocess.run([sys.executable, str(pipeline.HERE / "prepare.py"), "prepare", str(self.source),
                                 "--out", str(self.out)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(self.state()["layout"], "compact-reading-v1")

    def test_smaller_batch_after_truncated_output_preserves_confirmed_prefix(self):
        self.prepare()
        self.confirm(self.read())
        cursor = self.state()["cursor"]
        self.read()
        pipeline.compact.discard_pending(pipeline.compact_api(), self.out)
        pipeline.prepare_result(self.source, self.out, layout="auto", max_chars=128)
        self.assertEqual(cursor, self.state()["cursor"])
        self.assertLessEqual(len(self.read()["text"]), 128)

    def test_new_media_source_reuses_bytes_but_retains_attribution(self):
        self.data = fixture(count=1, media_count=1)
        self.save()
        transport = FakeTransport()
        self.prepare(fetch_public=True, transport=transport)
        other = fixture(count=2, media_count=1)["items"][1]
        other["post_url"] = self.data["items"][0]["post_url"]  # Same public image request context.
        self.data["items"].append(other)
        self.data["coverage"]["observed_count"] = 2
        self.save()
        self.prepare(fetch_public=True, transport=transport)
        self.assertEqual(len(transport.calls), 1)
        mappings = [json.loads(p.read_text(encoding="utf-8"))["items"][0]
                    for p in sorted(self.out.glob("media-*/assets/local-manifest.json"))]
        self.assertEqual(len(mappings), 2)
        self.assertNotEqual(mappings[0]["post_source_id"], mappings[1]["post_source_id"])
        self.assertEqual(mappings[0]["local_path"], mappings[1]["local_path"])
        self.assertEqual(len([p for p in (self.out / "image-cache").iterdir() if p.name != "index.json"]), 1)
        self.assertFalse(list(self.out.rglob("download-index.csv")))

    def test_failed_media_does_not_erase_text_or_get_auto_confirmed(self):
        self.data = fixture(count=1, media_count=1)
        self.save()
        bad = FakeTransport(bad={"https://images.example.org/0.png"})
        self.prepare(fetch_public=True, transport=bad)
        self.confirm(self.read())
        cursor = self.state()["cursor"]
        self.prepare(fetch_public=True, transport=bad)
        self.assertEqual(len(bad.calls), 1)
        self.assertEqual(cursor, self.state()["cursor"])
        with self.assertRaises(pipeline.PipelineError):
            pipeline.compact.confirm(pipeline.compact_api(), self.out, "media-0001", "root")

    def test_cached_blob_corruption_is_reported_without_network_retry(self):
        transport = FakeTransport()
        cache = pipeline.fetch_assets.PublicImageCache(self.root / "cache", transport)
        kwargs = dict(headers={}, timeout=2, max_bytes=1024*1024)
        response = cache.fetch("https://images.example.org/0.png", **kwargs)
        Path(response.cache_path).write_bytes(b"broken")
        with self.assertRaises(pipeline.fetch_assets.AssetError):
            cache.fetch("https://images.example.org/0.png", **kwargs)
        self.assertEqual(len(transport.calls), 1)

    def test_explicit_failed_media_retry_uses_successful_cached_images(self):
        self.data = fixture(count=1, media_count=2)
        self.save()
        first = FakeTransport(bad={"https://images.example.org/1.png"})
        self.prepare(fetch_public=True, transport=first)
        second = FakeTransport()
        self.prepare(fetch_public=True, retry_media=True, transport=second)
        self.assertEqual(second.calls, ["https://images.example.org/1.png"])
        self.assertEqual(len(self.state()["media_batches"]), 1)
        self.assertEqual(self.state()["media_batches"][0]["status"], "ready")
        self.assertFalse(self.state()["media_batches"][0]["reviewed"])

    def test_ordinary_reading_does_not_require_permalinks_for_all_clean_observations(self):
        self.data["coverage"].update(collection_complete=False, unresolved=[
            {"source_id": "post-0", "reason": "unstable_source_identity"}])
        self.data["items"][0]["post_url"] = None
        self.save()
        self.prepare()
        self.assertEqual(self.state()["collection_gaps"], [])
        self.assertTrue(self.state()["next_action"]["source_lookup_required_for_findings"])
        self.assertFalse(self.state()["surface_completion"])
        self.data["coverage"]["unresolved"].append({"source_id": "post-0", "reason": "media_placeholder"})
        self.save()
        self.prepare()
        self.assertIn("collection_unresolved", self.state()["collection_gaps"])


if __name__ == "__main__":
    unittest.main()
