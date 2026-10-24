from __future__ import annotations

import importlib.util
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from PIL import Image

SCRIPT = Path(__file__).resolve().parents[2] / "pipeline" / "prepare.py"
SPEC = importlib.util.spec_from_file_location("research_pipeline", SCRIPT)
pipeline = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(pipeline)


def fixture(count=1, media_count=0):
    items = [{"source_id": f"post-{i}", "post_url": f"https://example.org/post/{i}",
              "account": "确认账号", "date": "2026-10-15", "text": ("完整正文😀\n" * 30),
              "quoted_text": "引用原文", "text_truncated": False, "needs_expansion": False,
              "media": [{"media_id": f"image-{i}-{j}", "kind": "image", "url": f"https://images.example.org/{j}.png"}
                        for j in range(media_count)], "media_count": media_count} for i in range(count)]
    return {"schema_version": 1, "job": {"id": "job-1", "state": "collected", "iterations": 4,
            "recipe": "generic-posts", "target_url": "https://example.org/user/1", "reason": "visible_endpoint"},
            "items": items, "scope": {}, "conclusion": "incomplete",
            "coverage": {"collection_complete": True, "stop_reason": "visible_endpoint",
                         "visible_endpoint_verified": True, "observed_count": count, "unresolved": []}}


def detail_fixture():
    data = fixture()
    data.update(adapter="research-detail-v1", owner="owner-a", target="detail-target-a")
    data["job"].update(id="detail:weibo-detail:post-0", recipe="weibo-detail", state="needs_review", reason="scope_boundary")
    data["scope"] = {"kind": "single_post_detail", "whole_account_completion_inferred": False,
                     "boundary": {"verified": True, "reason": "single verified fixture post only"}}
    data["coverage"]["stop_reason"] = "scope_boundary"
    return data


def read(file):
    return json.loads(file.read_text(encoding="utf-8"))


class FakeTransport:
    def __init__(self, bad=None, cancel=None):
        self.calls = []
        self.bad = bad or set()
        self.cancel = cancel
        buffer = BytesIO()
        image = Image.new("RGB", (300, 200), "#5588aa")
        image.save(buffer, format="PNG")
        self.body = buffer.getvalue()

    def fetch(self, url, **kwargs):
        self.calls.append(url)
        if self.cancel:
            self.cancel()
        if url in self.bad:
            return pipeline.fetch_assets.TransportResponse(503, "text/html", b"unavailable", url)
        return pipeline.fetch_assets.TransportResponse(200, "image/png", self.body, url, request_count=1)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="research-pipeline-offline-")
        self.root = Path(self.temp.name)
        self.source = self.root / "result.json"
        self.out = self.root / "prepare"
        self.network = patch.object(pipeline.fetch_assets.UrllibTransport, "fetch",
                                    side_effect=AssertionError("real network forbidden in offline tests"))
        self.network.start()

    def tearDown(self):
        self.network.stop()
        self.temp.cleanup()

    def save(self, data=None):
        self.source.write_text(json.dumps(data or fixture(), ensure_ascii=False), encoding="utf-8")

    def run_prepare(self, data=None, **kwargs):
        if data is not None or not self.source.exists():
            self.save(data)
        return pipeline.prepare_result(self.source, self.out, **kwargs)

    def revision(self, result):
        return Path(result["revision_directory"])

    def events(self):
        return [json.loads(line) for line in (self.out / "events.ndjson").read_text(encoding="utf-8").splitlines()]

    def confirm_text(self, result):
        file = self.revision(result) / "text" / "review.json"
        review = read(file)
        review["reviewer"] = "actual-reader"
        for batch in review["text_batches"]:
            batch["reviewed"] = True
        file.write_text(json.dumps(review, ensure_ascii=False), encoding="utf-8")
        return file

    def test_hundred_long_posts_export_all_text_with_six_thousand_char_batches(self):
        data = fixture(100)
        for item in data["items"]:
            item["text"] = "长正文😀" * 1500
        result = self.run_prepare(data)
        self.assertEqual(result["status"], "prepared")
        directory = self.revision(result) / "text"
        review = read(directory / "review.json")
        self.assertGreater(len(review["text_batches"]), 100)
        expected = pipeline.coverage.make_text_batches(data["items"], 6000)
        for batch in expected:
            actual = (directory / f"{batch['batch_id']}.txt").read_text(encoding="utf-8")
            self.assertEqual(actual, batch["content"])
            self.assertLessEqual(len(actual), 6000)
        self.assertTrue(all(not b["reviewed"] for b in review["text_batches"]))

    def test_prepared_and_events_never_claim_read_or_feishu_written(self):
        result = self.run_prepare()
        self.assertFalse(result["coverage_complete"])
        self.assertFalse(result["surface_completion"])
        self.assertEqual(result["next_action"]["kind"], "model_review_required")
        self.assertFalse(result["next_action"]["automatic_feishu_write"])
        self.assertTrue(all(e["review_status"] == "not_reviewed" and not e["surface_completion"] for e in self.events()))
        initial = read(self.revision(result) / "initial-coverage.json")
        self.assertFalse(initial["coverage_complete"])
        self.assertIn("unread_text", {i["code"] for i in initial["issues"]})

    def test_default_offline_exports_media_without_download(self):
        result = self.run_prepare(fixture(media_count=3))
        self.assertEqual(result["stages"]["media"]["status"], "pending_public_fetch")
        self.assertEqual(read(self.revision(result) / "media-manifest.json")["export_report"]["exported_item_count"], 3)
        self.assertFalse(list(self.revision(result).glob("assets-*")))

    def test_explicit_fake_fetch_and_real_sheet_continue_automatically(self):
        transport = FakeTransport()
        result = self.run_prepare(fixture(media_count=2), fetch_public=True, transport=transport)
        self.assertEqual(result["stages"]["media"]["status"], "ready")
        self.assertEqual(len(transport.calls), 2)
        sheets = Path(result["stages"]["media"]["sheets"])
        self.assertTrue((sheets / "sheet_0001.jpg").exists())
        self.assertEqual(read(sheets / "summary.json")["review_status"], "not_reviewed")
        self.assertFalse(result["surface_completion"])

    def test_failed_image_keeps_text_and_failure_slot(self):
        transport = FakeTransport(bad={"https://images.example.org/1.png"})
        result = self.run_prepare(fixture(media_count=2), fetch_public=True, transport=transport)
        self.assertEqual(result["status"], "prepared")
        self.assertEqual(result["stages"]["text"]["status"], "ready")
        self.assertEqual(result["stages"]["media"]["status"], "partial")
        index = read(Path(result["stages"]["media"]["sheets"]) / "index.json")
        self.assertEqual(len(index["items"]), 2)
        self.assertEqual(sum(i["status"] == "failed" for i in index["items"]), 1)
        self.assertEqual(pipeline.exit_code(result), 2)

    def test_nine_image_post_with_three_loaded_keeps_six_missing_slots(self):
        data = fixture(media_count=3)
        data["items"][0]["media_count"] = 9
        result = self.run_prepare(data)
        manifest = read(self.revision(result) / "media-manifest.json")
        self.assertEqual(len(manifest["items"]), 9)
        self.assertEqual(manifest["export_report"]["failed_placeholder_count"], 6)
        self.assertFalse(read(self.revision(result) / "initial-coverage.json")["coverage_complete"])

    def test_identical_retry_preserves_manual_confirmation_and_deduplicates_events(self):
        first = self.run_prepare()
        review_file = self.revision(first) / "text" / "review.json"
        review = read(review_file)
        review["reviewer"] = "actual-reader"
        review["text_batches"][0]["reviewed"] = True
        review_file.write_text(json.dumps(review, ensure_ascii=False), encoding="utf-8")
        before, event_count = review_file.read_bytes(), len(self.events())
        second = self.run_prepare()
        self.assertEqual(first["revision"], second["revision"])
        self.assertEqual(before, review_file.read_bytes())
        self.assertEqual(event_count, len(self.events()))

    def test_timestamp_change_reuses_revision_but_text_change_starts_new_unread_revision(self):
        data = fixture()
        first = self.run_prepare(data)
        previous_review = self.revision(first) / "text" / "review.json"
        previous_bytes = previous_review.read_bytes()
        data["job"]["updated_at"] = "later"
        same = self.run_prepare(data)
        self.assertEqual(first["revision"], same["revision"])
        data["items"][0]["text"] += "新增内容"
        changed = self.run_prepare(data)
        self.assertNotEqual(first["revision"], changed["revision"])
        self.assertEqual(previous_bytes, previous_review.read_bytes())
        self.assertTrue(all(not b["reviewed"] for b in read(self.revision(changed) / "text" / "review.json")["text_batches"]))

    def test_new_slice_limit_creates_revision_without_overwriting_old_batches(self):
        first = self.run_prepare()
        second = self.run_prepare(max_chars=128)
        self.assertNotEqual(first["revision"], second["revision"])
        self.assertTrue((self.revision(first) / "text" / "review.json").exists())

    def test_cancel_after_text_preserves_it_and_requires_explicit_resume(self):
        def stop_after_text(event):
            if event["event"] == "text_ready":
                pipeline.cancel(self.out)
        paused = self.run_prepare(fixture(media_count=1), on_event=stop_after_text)
        self.assertEqual(paused["status"], "paused")
        review_file = self.revision(paused) / "text" / "review.json"
        original = review_file.read_bytes()
        self.assertEqual(self.run_prepare()["status"], "paused")
        resumed = self.run_prepare(resume=True)
        self.assertEqual(resumed["status"], "prepared")
        self.assertNotIn("reason", resumed)
        self.assertEqual(original, review_file.read_bytes())

    def test_cancel_mid_export_resumes_pending_chunks_without_overwrite(self):
        data = fixture()
        data["items"][0]["text"] = "长文" * 10000
        calls = 0
        def cancelled():
            nonlocal calls
            calls += 1
            return calls >= 4
        paused = self.run_prepare(data, cancelled=cancelled)
        self.assertEqual(paused["status"], "paused")
        pending = self.revision(paused) / "text.pending"
        self.assertTrue(list(pending.glob("*.txt")))
        saved = {p.name: p.read_bytes() for p in pending.glob("*.txt")}
        resumed = self.run_prepare(resume=True)
        self.assertEqual(resumed["status"], "prepared")
        for name, value in saved.items():
            self.assertEqual(value, (self.revision(resumed) / "text" / name).read_bytes())

    def test_corrupted_existing_text_is_preserved_and_reported(self):
        first = self.run_prepare()
        batch = self.revision(first) / "text" / "text-0001.txt"
        batch.write_text("人工改过，不得覆盖", encoding="utf-8")
        result = self.run_prepare()
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "text_artifact_conflict")
        self.assertEqual(batch.read_text(encoding="utf-8"), "人工改过，不得覆盖")

    def test_malformed_source_records_safe_error_without_echoing_content(self):
        secret = "simulated-secret-never-echo"
        self.save({"schema_version": 2, "items": [], "private": secret})
        result = self.run_prepare()
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "source_format_invalid")
        self.assertNotIn(secret, (self.out / "events.ndjson").read_text(encoding="utf-8"))

    def test_stopped_incomplete_collection_still_prepares_readable_text(self):
        data = fixture()
        data["job"]["state"] = "needs_review"
        data["coverage"].update(collection_complete=False, stop_reason="stall", visible_endpoint_verified=False)
        result = self.run_prepare(data)
        self.assertEqual(result["status"], "prepared")
        self.assertIn("resolve_collection_gaps", result["next_action"]["requirements"])
        self.assertFalse(any(event["event"] == "collected" for event in self.events()))

    def test_running_collection_is_not_consumed_as_terminal(self):
        data = fixture()
        data["job"]["state"] = "running"
        result = self.run_prepare(data)
        self.assertEqual(result["error"]["code"], "collection_running")

    def test_fatal_sheet_error_preserves_text_and_no_implicit_download_retry(self):
        transport = FakeTransport()
        def broken(*args):
            raise RuntimeError("simulated renderer failure")
        first = self.run_prepare(fixture(media_count=1), fetch_public=True, transport=transport, render_fn=broken)
        self.assertEqual(first["stages"]["text"]["status"], "ready")
        self.assertEqual(first["stages"]["media"]["status"], "error")
        second = self.run_prepare(fetch_public=True, transport=transport)
        self.assertEqual(second["stages"]["media"]["status"], "error")
        self.assertEqual(len(transport.calls), 1)
        retried = self.run_prepare(fetch_public=True, retry_media=True, transport=transport)
        self.assertEqual(retried["stages"]["media"]["status"], "ready")
        self.assertEqual(len(transport.calls), 1, "Retrying a failed sheet should reuse downloaded assets")

    def test_successful_media_is_not_fetched_again_even_with_retry_flag(self):
        transport = FakeTransport()
        self.run_prepare(fixture(media_count=1), fetch_public=True, transport=transport)
        result = self.run_prepare(fetch_public=True, retry_media=True, transport=transport)
        self.assertEqual(result["stages"]["media"]["status"], "ready")
        self.assertEqual(len(transport.calls), 1)

    def test_unrecognized_upstream_stop_reason_is_not_echoed_in_events(self):
        data = fixture()
        data["job"]["state"] = "needs_review"
        data["coverage"].update(collection_complete=False, stop_reason="simulated-secret-in-stop", visible_endpoint_verified=False)
        self.run_prepare(data)
        self.assertNotIn("simulated-secret-in-stop", (self.out / "events.ndjson").read_text(encoding="utf-8"))

    def test_unsupported_media_does_not_become_no_media_success(self):
        data = fixture(media_count=1)
        data["items"][0]["media"][0]["kind"] = "unsupported-audio"
        result = self.run_prepare(data)
        self.assertEqual(result["stages"]["media"]["status"], "needs_review")

    def test_cancellation_during_download_stops_new_requests_and_keeps_completed_asset(self):
        transport = FakeTransport(cancel=lambda: pipeline.cancel(self.out))
        first = self.run_prepare(fixture(media_count=3), fetch_public=True, transport=transport, concurrency=1)
        self.assertEqual(first["status"], "paused")
        self.assertEqual(len(transport.calls), 1)
        assets = self.revision(first) / "assets-0001"
        self.assertEqual(read(assets / "summary.json")["request_count"], 1)
        self.assertTrue(list((assets / "assets").glob("*.png")))
        resumed = self.run_prepare(resume=True, fetch_public=True, transport=transport, concurrency=1)
        self.assertEqual(resumed["stages"]["media"]["status"], "partial")
        self.assertEqual(len(transport.calls), 1)

    def test_processor_lock_rejects_second_process_and_releases_after_exit(self):
        self.out.mkdir()
        code = ("import importlib.util,pathlib,sys,time;"
                "s=importlib.util.spec_from_file_location('p',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                "\nwith m.processor_lock(pathlib.Path(sys.argv[2])):\n print('locked',flush=True)\n time.sleep(30)\n")
        child = subprocess.Popen([sys.executable, "-X", "utf8", "-c", code, str(SCRIPT), str(self.out)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        try:
            self.assertEqual(child.stdout.readline().strip(), "locked")
            self.save()
            with self.assertRaises(pipeline.PipelineError) as caught:
                self.run_prepare()
            self.assertEqual(caught.exception.code, "processor_busy")
        finally:
            child.terminate()
            child.communicate(timeout=5)
        self.assertEqual(self.run_prepare()["status"], "prepared")

    def make_job(self, state="running"):
        directory = self.root / "job"
        directory.mkdir(exist_ok=True)
        data = fixture()
        data["job"]["state"] = state
        pipeline.atomic_json(directory / "job.json", {"id": "job-1", "state": state, "iterations": 4, "stop_reason": "visible_endpoint"})
        return directory, data

    def test_watch_silent_while_unchanged_then_prepares_once_at_matching_checkpoint(self):
        directory, data = self.make_job()
        seen = []
        def complete():
            time.sleep(0.2)
            data["job"]["state"] = "collected"
            pipeline.atomic_json(directory / "job.json", {"id": "job-1", "state": "collected", "iterations": 4})
            time.sleep(0.1)  # job terminal checkpoint legitimately precedes result commit.
            pipeline.atomic_json(directory / "result.json", data)
        writer = threading.Thread(target=complete)
        writer.start()
        result = pipeline.watch_job(directory, self.out, max_wait=2, poll_interval=0.05, on_event=seen.append)
        writer.join()
        self.assertEqual(result["status"], "prepared")
        self.assertEqual(sum(event["event"] == "waiting_for_collection" for event in seen), 1)
        self.assertEqual(sum(event["event"] == "collection_terminal" for event in seen), 1)
        self.assertEqual(sum(event["event"] == "text_ready" for event in seen), 1)

    def test_watch_cancels_without_consuming_or_modifying_collection(self):
        directory, _ = self.make_job()
        original = (directory / "job.json").read_bytes()
        result = pipeline.watch_job(directory, self.out, max_wait=1, poll_interval=0.05,
                                    on_event=lambda event: pipeline.cancel(self.out) if event["event"] == "waiting_for_collection" else None)
        self.assertEqual(result["status"], "paused")
        self.assertEqual((directory / "job.json").read_bytes(), original)
        self.assertFalse((self.out / "revisions").exists())

    def test_watch_has_maximum_duration_and_no_repeated_status_events(self):
        directory, _ = self.make_job()
        result = pipeline.watch_job(directory, self.out, max_wait=0.15, poll_interval=0.05)
        self.assertEqual(result["reason"], "watch_timeout")
        self.assertEqual([e["event"] for e in self.events()], ["waiting_for_collection", "error"])

    def test_watch_does_not_consume_stale_result_from_previous_attempt(self):
        directory, data = self.make_job("collected")
        data["job"]["iterations"] = 3
        pipeline.atomic_json(directory / "result.json", data)
        result = pipeline.watch_job(directory, self.out, max_wait=0.15, poll_interval=0.05)
        self.assertEqual(result["status"], "error")
        self.assertFalse((self.out / "revisions").exists())

    def test_watch_detects_task_identity_replacement(self):
        directory, _ = self.make_job()
        def replace():
            time.sleep(0.1)
            pipeline.atomic_json(directory / "job.json", {"id": "different-job", "state": "running", "iterations": 4})
        writer = threading.Thread(target=replace)
        writer.start()
        result = pipeline.watch_job(directory, self.out, max_wait=1, poll_interval=0.05)
        writer.join()
        self.assertEqual(result["reason"], "job_identity_changed")

    def test_cli_watch_streams_stage_events_and_final_next_action(self):
        directory, data = self.make_job("collected")
        pipeline.atomic_json(directory / "result.json", data)
        result = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPT), "watch", str(directory),
                                 "--out", str(self.out), "--max-wait", "1"],
                                capture_output=True, text=True, encoding="utf-8", timeout=5, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lines = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertTrue(any(line.get("event") == "text_ready" for line in lines))
        self.assertEqual(lines[-1]["next_action"]["kind"], "model_review_required")
        self.assertFalse(lines[-1]["surface_completion"])

    def test_media_or_coverage_change_reuses_only_actual_unchanged_text_confirmation(self):
        data = fixture()
        first = self.run_prepare(data)
        old_file = self.confirm_text(first)
        old_bytes = old_file.read_bytes()
        data["items"][0]["media"] = [{"media_id": "new-media", "kind": "image", "url": "https://images.example.org/new.png"}]
        data["items"][0]["media_count"] = 1
        data["coverage"]["unresolved"] = [{"reason": "new_media_pending"}]
        changed = self.run_prepare(data)
        review = read(self.revision(changed) / "text" / "review.json")
        self.assertNotEqual(first["revision"], changed["revision"])
        self.assertEqual(changed["next_action"]["unread_text_batch_count"], 0)
        self.assertEqual(changed["next_action"]["reused_text_field_count"], 2)
        self.assertTrue(all(batch["reviewed"] and batch.get("reused_from") for batch in review["text_batches"]))
        self.assertEqual(review["text_snapshot_digest"], pipeline.coverage.text_snapshot_digest(data["items"]))
        self.assertEqual(old_bytes, old_file.read_bytes())
        self.assertFalse(changed["coverage_complete"])
        self.assertFalse(any(issue["code"] == "unread_text" for issue in pipeline.coverage.validate_batch(data, review)["issues"]))

    def test_changed_body_does_not_reuse_body_but_can_reuse_unchanged_quote(self):
        data = fixture()
        self.confirm_text(self.run_prepare(data))
        data["items"][0]["text"] += "实际新增正文"
        changed = self.run_prepare(data)
        batches = read(self.revision(changed) / "text" / "review.json")["text_batches"]
        self.assertTrue(any(not b["reviewed"] and any(s["field"] == "text" for s in b["segments"]) for b in batches))
        self.assertTrue(any(b["reviewed"] and any(s["field"] == "quoted_text" for s in b["segments"]) for b in batches))

    def test_changed_quote_does_not_reuse_quote_but_can_reuse_unchanged_body(self):
        data = fixture()
        self.confirm_text(self.run_prepare(data))
        data["items"][0]["quoted_text"] += "新的引用内容"
        changed = self.run_prepare(data)
        batches = read(self.revision(changed) / "text" / "review.json")["text_batches"]
        self.assertTrue(any(not b["reviewed"] and any(s["field"] == "quoted_text" for s in b["segments"]) for b in batches))
        self.assertTrue(any(b["reviewed"] and any(s["field"] == "text" for s in b["segments"]) for b in batches))

    def test_cross_task_request_subject_scope_or_source_mapping_never_reuses(self):
        first = self.run_prepare(fixture())
        self.confirm_text(first)
        changes = [lambda d: d["job"].update(id="different-job"),
                   lambda d: d.update(requestId="different-request"),
                   lambda d: d.update(subject={"expected": "different-subject"}),
                   lambda d: d["job"].update(target_url="https://example.org/user/other"),
                   lambda d: d.update(scope={"kind": "different-scope"}),
                   lambda d: d["items"][0].update(post_url="https://example.org/post/other"),
                   lambda d: d["items"][0].update(account="另一个账号"),
                   lambda d: d["items"][0].update(account_id="different-account-id")]
        for index, mutate in enumerate(changes):
            with self.subTest(case=index):
                data = fixture()
                mutate(data)
                changed = self.run_prepare(data)
                self.assertEqual(changed["next_action"]["reused_text_field_count"], 0)
                self.assertGreater(changed["next_action"]["unread_text_batch_count"], 0)

    def test_new_title_is_unread_while_legacy_titleless_confirmations_stay_valid(self):
        data = fixture()
        self.confirm_text(self.run_prepare(data))
        data["items"][0]["title"] = "新取得的标题"
        changed = self.run_prepare(data)
        review = read(self.revision(changed) / "text" / "review.json")
        self.assertEqual(changed["next_action"]["reused_text_field_count"], 2)
        self.assertTrue(any(not b["reviewed"] and any(s["field"] == "title" for s in b["segments"]) for b in review["text_batches"]))

    def test_changed_title_requires_reading_only_changed_title(self):
        data = fixture()
        data["items"][0]["title"] = "旧标题"
        self.confirm_text(self.run_prepare(data))
        data["items"][0]["title"] = "新标题"
        changed = self.run_prepare(data)
        batches = read(self.revision(changed) / "text" / "review.json")["text_batches"]
        self.assertEqual(changed["next_action"]["reused_text_field_count"], 2)
        self.assertTrue(all(s["field"] == "title" for b in batches if not b["reviewed"] for s in b["segments"]))

    def test_stale_or_invalid_old_confirmation_is_not_reused(self):
        for mode in ("digest", "reviewer", "spaced-reviewer", "batch-path", "truncated", "range", "file"):
            with self.subTest(mode=mode):
                nested = self.root / mode
                nested.mkdir()
                source, out = nested / "result.json", nested / "prepared"
                data = fixture()
                source.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
                first = pipeline.prepare_result(source, out)
                review_file = Path(first["revision_directory"]) / "text" / "review.json"
                review = read(review_file)
                review["reviewer"] = "actual-reader"
                for batch in review["text_batches"]:
                    batch["reviewed"] = True
                if mode == "digest":
                    review["text_snapshot_digest"] = "stale"
                elif mode == "reviewer":
                    review["reviewer"] = "collector"
                elif mode == "spaced-reviewer":
                    review["reviewer"] = " collector "
                elif mode == "batch-path":
                    review["text_batches"][0]["batch_id"] = "../../outside"
                elif mode == "truncated":
                    review["text_batches"][0]["output_truncated"] = True
                elif mode == "range":
                    review["text_batches"][0]["segments"][0]["end"] = 10000000
                elif mode == "file":
                    (review_file.parent / "text-0001.txt").write_text("正文文件被改动", encoding="utf-8")
                review_file.write_text(json.dumps(review, ensure_ascii=False), encoding="utf-8")
                data["coverage"]["unresolved"] = ["changed collection metadata"]
                source.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
                changed = pipeline.prepare_result(source, out)
                self.assertEqual(changed["next_action"]["reused_text_field_count"], 0)

    def test_partial_old_read_ranges_do_not_claim_the_entire_field_read(self):
        data = fixture()
        data["items"][0]["text"] = "长正文" * 5000
        first = self.run_prepare(data)
        file = self.revision(first) / "text" / "review.json"
        review = read(file)
        review["reviewer"] = "actual-reader"
        review["text_batches"][0]["reviewed"] = True
        file.write_text(json.dumps(review, ensure_ascii=False), encoding="utf-8")
        data["coverage"]["unresolved"] = ["new metadata"]
        changed = self.run_prepare(data)
        self.assertEqual(changed["next_action"]["reused_text_field_count"], 0)

    def test_reuse_can_continue_across_revisions_without_new_automatic_pass(self):
        data = fixture()
        self.confirm_text(self.run_prepare(data))
        data["coverage"]["unresolved"] = ["first media gap"]
        second = self.run_prepare(data)
        data["coverage"]["unresolved"] = ["second media gap"]
        third = self.run_prepare(data)
        self.assertEqual(second["next_action"]["unread_text_batch_count"], 0)
        self.assertEqual(third["next_action"]["unread_text_batch_count"], 0)
        self.assertEqual(third["review_status"], "not_reviewed")
        self.assertFalse(third["surface_completion"])

    def test_detail_owner_thread_request_and_target_change_split_fingerprint_and_real_prepare_cache(self):
        variants = [("top", key) for key in ("owner", "thread", "thread_id", "threadId", "task_id", "taskId", "requestId", "request_id", "target")]
        variants += [("job", key) for key in ("owner", "thread", "thread_id", "threadId", "task_id", "taskId", "requestId", "request_id", "target")]
        for index, (level, key) in enumerate(variants):
            with self.subTest(level=level, key=key):
                directory = self.root / f"context-{index}"
                directory.mkdir()
                source, out = directory / "result.json", directory / "prepared"
                data = detail_fixture()
                source.write_text(json.dumps(data), encoding="utf-8")
                first = pipeline.prepare_result(source, out)
                review_file = Path(first["revision_directory"]) / "text" / "review.json"
                review = read(review_file)
                review["reviewer"] = "actual-reader"
                for batch in review["text_batches"]:
                    batch["reviewed"] = True
                review_file.write_text(json.dumps(review), encoding="utf-8")
                before = pipeline.source_fingerprint(data, 6000)
                (data if level == "top" else data["job"])[key] = "different-context-value"
                self.assertNotEqual(before, pipeline.source_fingerprint(data, 6000))
                source.write_text(json.dumps(data), encoding="utf-8")
                changed = pipeline.prepare_result(source, out)
                self.assertNotEqual(first["revision"], changed["revision"])
                self.assertEqual(changed["next_action"]["reused_text_field_count"], 0)
                self.assertGreater(changed["next_action"]["unread_text_batch_count"], 0)

    def test_detail_missing_owner_or_target_and_no_explicit_task_does_not_cache_old_confirmation(self):
        for missing in (("owner",), ("target",), ("owner", "target")):
            with self.subTest(missing=missing):
                directory = self.root / ("missing-" + "-".join(missing))
                directory.mkdir()
                source, out = directory / "result.json", directory / "prepared"
                data = detail_fixture()
                for key in missing:
                    data.pop(key)
                source.write_text(json.dumps(data), encoding="utf-8")
                first = pipeline.prepare_result(source, out)
                review_file = Path(first["revision_directory"]) / "text" / "review.json"
                review = read(review_file)
                review["reviewer"] = "actual-reader"
                for batch in review["text_batches"]:
                    batch["reviewed"] = True
                review_file.write_text(json.dumps(review), encoding="utf-8")
                repeated = pipeline.prepare_result(source, out)
                self.assertNotEqual(first["revision"], repeated["revision"])
                self.assertEqual(repeated["next_action"]["reused_text_field_count"], 0)
                self.assertGreater(repeated["next_action"]["unread_text_batch_count"], 0)

    def test_detail_explicit_request_can_bind_context_missing_owner_and_target(self):
        data = detail_fixture()
        data.pop("owner")
        data.pop("target")
        data["requestId"] = "explicit-unique-request"
        first = self.run_prepare(data)
        self.confirm_text(first)
        repeated = self.run_prepare(data)
        self.assertEqual(first["revision"], repeated["revision"])
        data["coverage"]["unresolved"] = ["media changed"]
        changed = self.run_prepare(data)
        self.assertEqual(changed["next_action"]["reused_text_field_count"], 2)

    def test_old_detail_cache_without_bound_context_metadata_is_not_borrowed(self):
        data = detail_fixture()
        first = self.run_prepare(data)
        self.confirm_text(first)
        meta_file = self.revision(first) / "meta.json"
        meta = read(meta_file)
        meta["preparation_contract"] = 2
        meta.pop("execution_context")
        meta_file.write_text(json.dumps(meta), encoding="utf-8")
        data["coverage"]["unresolved"] = ["media changed"]
        changed = self.run_prepare(data)
        self.assertEqual(changed["next_action"]["reused_text_field_count"], 0)

    def test_explicit_old_unread_ranges_prevent_borrowing_even_if_reviewed_true(self):
        data = fixture()
        first = self.run_prepare(data)
        file = self.confirm_text(first)
        old = read(file)
        old["unread_ranges"] = [{"source_id": "post-0", "field": "text", "reason": "explicitly not read"}]
        file.write_text(json.dumps(old), encoding="utf-8")
        original = file.read_bytes()
        data["coverage"]["unresolved"] = ["media changed"]
        changed = self.run_prepare(data)
        review = read(self.revision(changed) / "text" / "review.json")
        self.assertEqual(changed["next_action"]["reused_text_field_count"], 0)
        self.assertTrue(all(not batch["reviewed"] for batch in review["text_batches"]))
        self.assertEqual(original, file.read_bytes())
        self.assertTrue(any(issue["code"] == "unread_text" for issue in pipeline.coverage.validate_batch(data, review)["issues"]))

    def test_newer_unread_declaration_blocks_three_revision_fallback_to_old_read_confirmation(self):
        data = fixture()
        first = self.run_prepare(data)
        self.confirm_text(first)
        data["coverage"]["unresolved"] = ["first media change"]
        second = self.run_prepare(data)
        second_file = self.revision(second) / "text" / "review.json"
        second_review = read(second_file)
        self.assertTrue(all(batch["reviewed"] for batch in second_review["text_batches"]))
        second_review["unread_ranges"] = ["recheck the text; previous reviewed markers are not sufficient"]
        second_file.write_text(json.dumps(second_review), encoding="utf-8")
        data["coverage"]["unresolved"] = ["second media change"]
        third = self.run_prepare(data)
        self.assertEqual(third["next_action"]["reused_text_field_count"], 0)
        third_review = read(self.revision(third) / "text" / "review.json")
        self.assertTrue(all(not batch["reviewed"] for batch in third_review["text_batches"]))
        # A subsequent actual re-read may supersede that negative declaration.
        self.confirm_text(third)
        data["coverage"]["unresolved"] = ["third media change"]
        fourth = self.run_prepare(data)
        self.assertEqual(fourth["next_action"]["reused_text_field_count"], 2)


if __name__ == "__main__":
    unittest.main()
