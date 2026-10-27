#!/usr/bin/env python3
"""Positive, offline compact reconciliation acceptance through the real CLI.

Usage: python test_compact_reconciliation.py --repo PATH [--output JSON]
Exit 0 means all assertions passed; exit 1 means a failure/setup error. Unlike
the historical gap probe, these are repair acceptance tests. All inputs are
synthetic, all state lives in a temporary directory, and no accounts, browser,
network sockets or external messages are used. Media CLI cases inject a fake
public-image transport while exercising the real parser, renderer and reader.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.util
from io import BytesIO
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import unittest

REPO = None
SCRIPT = None
API = None
CLI_CALLS = 0


def sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def fixture(count=3, media=False):
    return {"schema_version": 1, "requestId": "synthetic-request",
        "job": {"id": "synthetic-job", "state": "collected", "iterations": 1,
                "recipe": "generic-posts", "target_url": "https://example.org/fixture",
                "reason": "visible_endpoint"},
        "items": [{"source_id": f"post-{i}", "post_url": f"https://example.org/post/{i}",
            "account": "fixture-only account", "account_id": f"synthetic-account-{i}", "date": "2026-10-27",
            "title": f"fixture title {i}", "text": f"fixture body {i} 😀", "quoted_text": f"fixture quote {i}",
            "text_truncated": False, "needs_expansion": False,
            "media": [{"media_id": f"image-{i}", "kind": "image",
                       "url": f"https://images.example.org/{i}.png"}] if media else [],
            "media_count": int(media)} for i in range(count)],
        "scope": {}, "conclusion": "incomplete", "coverage": {"collection_complete": True,
            "stop_reason": "visible_endpoint", "visible_endpoint_verified": True,
            "observed_count": count, "unresolved": []}}


def import_api(repo):
    spec = importlib.util.spec_from_file_location("compact_reconciliation_acceptance", repo / "tools/research-batch/pipeline/prepare.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_media_cli(repo, arguments):
    from PIL import Image
    api = import_api(repo)
    buffer = BytesIO()
    Image.new("RGB", (300, 200), "#447799").save(buffer, format="PNG")
    class SyntheticTransport:
        def fetch(self, url, **kwargs):
            if not url.startswith("https://images.example.org/"):
                raise AssertionError("Only synthetic media URLs are permitted")
            if "missing" in url:
                return api.fetch_assets.TransportResponse(503, "text/plain", b"fixture missing", url)
            return api.fetch_assets.TransportResponse(200, "image/png", buffer.getvalue(), url, request_count=1)
    api.fetch_assets.UrllibTransport = SyntheticTransport
    return api.main(arguments[1:] if arguments[:1] == ["--"] else arguments)


class ReconciliationCLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="compact-reconcile-acceptance-")
        self.root = Path(self.temp.name)
        self.source, self.out = self.root / "result.json", self.root / "reading"
        self.data = fixture()
        self.plan_number = 0
        self.write_source()

    def tearDown(self):
        self.temp.cleanup()

    def write_source(self):
        self.source.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")

    def state(self):
        return json.loads((self.out / "state.json").read_text(encoding="utf-8"))

    def state_bytes(self):
        return (self.out / "state.json").read_bytes()

    def invoke(self, *arguments, expect=(0,), fake_media=False):
        global CLI_CALLS
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
        command = ([sys.executable, str(Path(__file__).resolve()), "--repo", str(REPO), "--fixture-media-cli"]
                   if fake_media else [sys.executable, str(SCRIPT)])
        proc = subprocess.run(command + list(map(str, arguments)), capture_output=True, text=True,
                              encoding="utf-8", env=env, timeout=30)
        CLI_CALLS += 1
        self.assertIn(proc.returncode, expect, proc.stdout + proc.stderr)
        try:
            result = json.loads(proc.stdout)
        except ValueError:
            self.fail("CLI did not return JSON: " + proc.stdout + proc.stderr)
        self.assertFalse(result.get("surface_completion", False))
        return result

    def prepare(self, max_chars=6000, fake_media=False):
        parts = ["prepare", self.source, "--out", self.out, "--max-chars", max_chars]
        if fake_media:
            parts.append("--fetch-public")
        return self.invoke(*parts, fake_media=fake_media, expect=(0, 2))

    def read(self):
        return self.invoke("read", "--out", self.out)

    def confirm(self, shown):
        return self.invoke("confirm", "--out", self.out, "--batch", shown["batch_id"], "--reviewer", "synthetic-reader")

    def read_all(self):
        received = []
        for _ in range(100):
            shown = self.read()
            if not shown["has_text"]:
                return received
            received.extend((segment["source_id"], segment["field"]) for segment in shown["sources"])
            self.confirm(shown)
        self.fail("Synthetic fixture exceeded its bounded reading loop")

    def plan(self):
        self.plan_number += 1
        file = self.root / f"plan-{self.plan_number}.json"
        self.invoke("reconcile-plan", "--out", self.out, "--plan", file)
        return file, json.loads(file.read_text(encoding="utf-8"))

    def apply(self, file):
        return self.invoke("reconcile-apply", "--out", self.out, "--plan", file)

    def reconcile(self):
        file, plan = self.plan()
        self.apply(file)
        return file, plan

    def confirmed(self, source_id, field):
        return self.state()["text_checkpoints"][sha([source_id, field])]["confirmed"]

    def test_changed_field_reopens_only_that_field(self):
        self.prepare()
        self.read_all()
        self.data["items"][0]["text"] += " NEW CONTENT"
        self.write_source()
        before = self.state_bytes()
        self.assertEqual(self.invoke("read", "--out", self.out, expect=(1,))["code"], "reviewed_source_changed")
        self.assertEqual(before, self.state_bytes())
        _, plan = self.reconcile()
        self.assertEqual(plan["summary"]["retained_confirmed_fields"], 8)
        self.assertEqual(self.read_all(), [("post-0", "text")])
        self.assertTrue(self.invoke("status", "--out", self.out)["next_action"]["text_read_complete"])

    def test_unread_suffix_change_resets_entire_partial_field(self):
        self.data = fixture(1)
        self.data["items"][0].update(title="", quoted_text="", text="abcdefgh" * 100)
        self.write_source()
        self.prepare(max_chars=128)
        self.confirm(self.read())
        self.assertGreater(self.confirmed("post-0", "text"), 0)
        self.data["items"][0]["text"] += "new unread suffix"
        self.write_source()
        self.reconcile()
        self.assertEqual(self.confirmed("post-0", "text"), 0)
        self.assertEqual(self.read()["sources"][0]["start"], 0)

    def test_pending_is_discarded_and_requires_fresh_display(self):
        self.prepare()
        old = self.read()
        self.data["items"][0]["text"] += " new"
        self.write_source()
        _, plan = self.reconcile()
        self.assertTrue(plan["summary"]["discard_pending"])
        failed = self.invoke("confirm", "--out", self.out, "--batch", old["batch_id"],
                             "--reviewer", "synthetic-reader", expect=(1,))
        self.assertEqual(failed["code"], "batch_not_displayed_or_changed")
        fresh = self.read()
        self.assertNotEqual(old["batch_id"], fresh["batch_id"])
        self.confirm(fresh)

    def test_append_without_prepare_starts_unread_and_preserves_old_fields(self):
        self.data = fixture(1)
        self.write_source()
        self.prepare()
        self.read_all()
        self.data["items"].append(fixture(2)["items"][1])
        self.data["coverage"]["observed_count"] = 2
        self.write_source()
        self.assertFalse(self.invoke("status", "--out", self.out)["next_action"]["text_read_complete"])
        self.assertEqual(set(self.read_all()), {("post-1", "title"), ("post-1", "text"), ("post-1", "quoted_text")})

    def test_field_deletion_and_post_reordering_keep_unchanged_confirmation(self):
        self.prepare()
        self.read_all()
        self.data["items"][0]["quoted_text"] = ""
        self.data["items"].reverse()
        self.write_source()
        _, plan = self.reconcile()
        self.assertEqual(plan["summary"]["retained_confirmed_fields"], 8)
        self.assertEqual(plan["text_changes"][0]["reason"], "field_removed")
        self.assertFalse(self.read()["has_text"])

    def test_all_noncontiguous_retained_confirmations_are_revalidated(self):
        self.prepare()
        self.read_all()
        self.data["items"][0]["text"] += " first edit"
        self.write_source()
        self.reconcile()
        self.assertGreater(self.confirmed("post-2", "text"), 0)
        displayed = self.read()
        self.data["items"][2]["text"] += " later edit beyond cursor"
        self.write_source()
        before = self.state_bytes()
        for command in (("read",), ("status",), ("confirm", "--batch", displayed["batch_id"], "--reviewer", "synthetic-reader")):
            self.assertEqual(self.invoke(*command, "--out", self.out, expect=(1,))["code"], "reviewed_source_changed")
        self.assertEqual(before, self.state_bytes())
        self.reconcile()
        self.assertEqual(set(self.read_all()), {("post-0", "text"), ("post-2", "text")})

    def test_attribution_change_including_account_id_invalidates_whole_item(self):
        for attribute in ("account", "account_id", "post_url", "date"):
            with self.subTest(attribute=attribute):
                self.out = self.root / attribute
                self.data = fixture(2)
                self.write_source()
                self.prepare()
                self.read_all()
                self.data["items"][0][attribute] += "-changed"
                self.write_source()
                _, plan = self.reconcile()
                self.assertEqual(plan["summary"]["retained_confirmed_fields"], 3)
                self.assertTrue(all(change["reason"] == "attribution_changed" for change in plan["text_changes"]))
                self.assertEqual(set(self.read_all()), {("post-0", "title"), ("post-0", "text"), ("post-0", "quoted_text")})

    def test_task_source_scope_identity_changes_are_rejected(self):
        self.prepare()
        self.read_all()
        original = deepcopy(self.data)
        for target, key, value in (("job", "id", "another-job"), ("job", "target_url", "https://example.org/other"),
                ("top", "requestId", "another-request"), ("top", "scope", {"image_requirement": "none"})):
            self.data = deepcopy(original)
            (self.data if target == "top" else self.data[target])[key] = value
            self.write_source()
            before = self.state_bytes()
            result = self.invoke("reconcile-plan", "--out", self.out, "--plan", self.root / "forbidden.json", expect=(1,))
            self.assertEqual(result["code"], "checkpoint_identity_conflict")
            self.assertEqual(before, self.state_bytes())
        self.data = original
        self.write_source()
        copy = self.root / "different-source-file.json"
        copy.write_bytes(self.source.read_bytes())
        self.assertEqual(self.invoke("prepare", copy, "--out", self.out, expect=(1,))["code"], "checkpoint_identity_conflict")

    def test_duplicate_and_missing_source_ids_are_rejected(self):
        self.prepare()
        original = deepcopy(self.data)
        for mode in ("duplicate", "missing"):
            self.data = deepcopy(original)
            if mode == "duplicate":
                self.data["items"][1]["source_id"] = self.data["items"][0]["source_id"]
            else:
                self.data["items"][0].pop("source_id")
            self.write_source()
            before = self.state_bytes()
            result = self.invoke("reconcile-plan", "--out", self.out, "--plan", self.root / "invalid.json", expect=(1,))
            self.assertEqual(result["code"], "source_format_invalid")
            self.assertEqual(before, self.state_bytes())

    def test_plan_binds_source_and_checkpoint_and_is_not_an_instruction_file(self):
        self.prepare()
        pending = self.read()
        file, plan = self.plan()
        before = self.state_bytes()
        tampered = deepcopy(plan)
        tampered["summary"]["unread_fields"] = 0
        tampered["plan_id"] = sha({k: v for k, v in tampered.items() if k != "plan_id"})
        altered = self.root / "tampered.json"
        altered.write_text(json.dumps(tampered), encoding="utf-8")
        self.assertEqual(self.invoke("reconcile-apply", "--out", self.out, "--plan", altered, expect=(1,))["code"], "reconciliation_plan_changed")
        self.assertEqual(before, self.state_bytes())
        self.confirm(pending)
        before = self.state_bytes()
        self.assertEqual(self.invoke("reconcile-apply", "--out", self.out, "--plan", file, expect=(1,))["code"], "reconciliation_checkpoint_changed")
        self.assertEqual(before, self.state_bytes())
        file, _ = self.plan()
        self.data["items"][0]["text"] += " source changes after plan"
        self.write_source()
        self.assertEqual(self.invoke("reconcile-apply", "--out", self.out, "--plan", file, expect=(1,))["code"], "reconciliation_source_changed")
        self.assertEqual(before, self.state_bytes())

    def test_idempotent_apply_preserves_later_reading_and_checks_identity(self):
        self.prepare(max_chars=128)
        file, _ = self.reconcile()
        self.confirm(self.read())
        before = self.state_bytes()
        self.assertEqual(self.apply(file)["status"], "reconciliation_already_applied")
        self.assertEqual(before, self.state_bytes())
        self.data["items"][0]["text"] += " changed after applied plan"
        self.write_source()
        self.assertEqual(self.invoke("reconcile-apply", "--out", self.out, "--plan", file, expect=(1,))["code"], "reconciliation_source_changed")
        self.assertEqual(before, self.state_bytes())
        self.data["job"]["id"] = "different-job"
        self.write_source()
        self.assertEqual(self.invoke("reconcile-apply", "--out", self.out, "--plan", file, expect=(1,))["code"], "checkpoint_identity_conflict")
        self.assertEqual(before, self.state_bytes())

    def test_plan_only_writes_explicit_plan_and_respects_os_lock(self):
        self.prepare()
        before, source = self.state_bytes(), self.source.read_bytes()
        file, _ = self.plan()
        self.assertEqual(before, self.state_bytes())
        self.assertEqual(source, self.source.read_bytes())
        self.assertEqual({p.name for p in self.out.iterdir()}, {"state.json", "processor.lock"})
        with API.processor_lock(self.out):
            for command, path in (("reconcile-plan", self.root / "busy.json"), ("reconcile-apply", file)):
                result = self.invoke(command, "--out", self.out, "--plan", path, expect=(1,))
                self.assertEqual(result["code"], "processor_busy")
        self.assertEqual(before, self.state_bytes())

    def test_apply_is_atomic_on_failed_replacement_and_source_race(self):
        from unittest.mock import patch
        self.prepare()
        file, _ = self.plan()
        before = self.state_bytes()
        with patch.object(API.os, "replace", side_effect=OSError("synthetic replace failure")):
            with self.assertRaises(OSError):
                API.compact.reconcile_apply(API.compact_api(), self.out, file)
        self.assertEqual(before, self.state_bytes())
        original = API.compact.reconciliation
        def race(*args, **kwargs):
            result = original(*args, **kwargs)
            self.data["items"][0]["text"] += " raced"
            self.write_source()
            return result
        with patch.object(API.compact, "reconciliation", side_effect=race):
            with self.assertRaises(API.PipelineError) as caught:
                API.compact.reconcile_apply(API.compact_api(), self.out, file)
            self.assertEqual(caught.exception.code, "reconciliation_source_changed")
        self.assertEqual(before, self.state_bytes())

    def legacy_checkpoint(self):
        # Construct the historical v1 shape, without inventing any field hash.
        state = self.state()
        state.pop("reading_schema")
        state.pop("text_checkpoints")
        state["binding"] = state["binding"].split(":", 1)[1]
        old_rows = [{"source_id": item["source_id"], "post_url": item.get("post_url"),
            "account": item.get("account"), "date": item.get("date"), "field": field, "text": item[field]}
            for item in self.data["items"] for field in ("title", "text", "quoted_text") if item.get(field)]
        index, offset = state["cursor"]
        selected = old_rows[:index]
        if offset:
            selected += [{**old_rows[index], "text": old_rows[index]["text"][:offset]}]
        state["prefix_digest"] = sha(selected)
        (self.out / "state.json").write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")

    def test_legacy_changed_prefix_resets_unknown_fields_explicitly(self):
        self.prepare()
        self.read_all()
        self.legacy_checkpoint()
        self.data["items"][0]["text"] += " legacy edit"
        self.write_source()
        before = self.state_bytes()
        self.assertEqual(self.invoke("read", "--out", self.out, expect=(1,))["code"], "reviewed_source_changed")
        self.assertEqual(before, self.state_bytes())
        _, plan = self.reconcile()
        self.assertEqual(plan["migration"], "legacy_fingerprints_missing")
        self.assertEqual(plan["summary"]["retained_confirmed_fields"], 0)
        self.assertEqual(len(self.read_all()), 9)

    def test_legacy_matching_prefix_still_cannot_prove_stable_account_identity(self):
        for item in self.data["items"][1:]:
            item.pop("account_id")
        self.write_source()
        self.prepare()
        self.read_all()
        self.legacy_checkpoint()
        self.data["items"][0]["account_id"] = "different-stable-id"
        self.write_source()
        before = self.state_bytes()
        self.assertEqual(self.invoke("read", "--out", self.out, expect=(1,))["code"], "legacy_reconciliation_required")
        self.assertEqual(before, self.state_bytes())
        _, plan = self.reconcile()
        self.assertEqual(plan["migration"], "legacy_account_identity_unbound")
        self.assertEqual(plan["summary"]["retained_confirmed_fields"], 6)
        self.assertEqual(set(self.read_all()), {("post-0", "title"), ("post-0", "text"), ("post-0", "quoted_text")})

    def test_legacy_matching_prefix_without_new_identity_preserves_confirmations(self):
        for item in self.data["items"]:
            item.pop("account_id")
        self.write_source()
        self.prepare(max_chars=128)
        self.confirm(self.read())
        self.legacy_checkpoint()
        old_cursor = self.state()["cursor"]
        shown = self.read()
        self.assertEqual(self.state()["cursor"], old_cursor)
        self.assertTrue(shown["has_text"])
        self.assertEqual(self.state()["reading_schema"], 2)

    def test_legacy_unread_checkpoint_can_upgrade_without_claiming_review(self):
        self.prepare()
        self.legacy_checkpoint()
        shown = self.read()
        self.assertTrue(shown["has_text"])
        self.assertEqual(self.state()["reading_schema"], 2)
        self.assertTrue(all(entry["confirmed"] == 0 for entry in self.state()["text_checkpoints"].values()))

    def test_derived_cursor_and_prefix_cannot_override_field_progress(self):
        self.prepare()
        state = self.state()
        state["cursor"] = [9, 0]
        state["prefix_digest"] = "f" * 64
        (self.out / "state.json").write_text(json.dumps(state), encoding="utf-8")
        shown = self.read()
        self.assertTrue(shown["has_text"])
        self.assertEqual(shown["sources"][0]["start"], 0)
        self.assertTrue(all(entry["confirmed"] == 0 for entry in self.state()["text_checkpoints"].values()))

    def test_media_changed_attribution_retains_only_unaffected_confirmations(self):
        self.data = fixture(2, media=True)
        self.write_source()
        self.prepare(fake_media=True)
        self.read_all()
        self.confirm({"batch_id": "media-0001"})
        self.data["items"][0]["account_id"] += "-changed"
        self.write_source()
        self.assertEqual(self.invoke("confirm", "--out", self.out, "--batch", "media-0001", "--reviewer", "synthetic-reader", expect=(1,))["code"], "reviewed_source_changed")
        _, plan = self.reconcile()
        self.assertEqual(plan["summary"]["media"]["retained_confirmed_items"], 1)
        self.assertEqual(plan["summary"]["media"]["unprepared_items"], 1)
        entry = self.state()["media_batches"][0]
        self.assertEqual(len(entry["active_keys"]), 1)
        self.assertTrue(entry["reviewed"])
        self.prepare(fake_media=True)
        self.assertFalse(self.state()["media_batches"][1]["reviewed"])
        self.read_all()
        self.confirm({"batch_id": "media-0002"})
        self.assertEqual(self.invoke("status", "--out", self.out)["next_action"]["pending_media_batches"], 0)

    def test_media_only_changes_append_and_reorder_are_guarded(self):
        self.data = fixture(2, media=True)
        self.write_source()
        self.prepare(fake_media=True)
        self.confirm({"batch_id": "media-0001"})
        self.data["items"].reverse()
        self.write_source()
        _, plan = self.reconcile()
        self.assertEqual(plan["summary"]["media"]["retained_confirmed_items"], 2)
        self.data["items"][0]["media"][0]["url"] = "https://images.example.org/changed.png"
        self.write_source()
        self.assertEqual(self.invoke("status", "--out", self.out, expect=(1,))["code"], "reviewed_source_changed")
        self.reconcile()
        self.assertEqual(self.state()["media_not_prepared"], 1)
        self.prepare(fake_media=True)
        self.assertFalse(self.state()["media_batches"][-1]["reviewed"])
        self.data["items"][0]["media"].append({"kind": "image", "media_id": "appended", "url": "https://images.example.org/new.png"})
        self.data["items"][0]["media_count"] = 2
        self.write_source()
        self.assertEqual(self.invoke("status", "--out", self.out)["next_action"]["media_not_prepared"], 1)

    def test_legacy_media_manifest_preserves_proven_unaffected_confirmation(self):
        self.data = fixture(2, media=True)
        for item in self.data["items"]:
            item.pop("account_id")
        self.write_source()
        self.prepare(fake_media=True)
        self.read_all()
        self.confirm({"batch_id": "media-0001"})
        self.legacy_checkpoint()
        state = self.state()
        for entry in state["media_batches"]:
            file = Path(entry["directory"]) / "sources.json"
            manifest = json.loads(file.read_text(encoding="utf-8"))
            for item in manifest["items"]:
                item.pop("account_id", None)
            file.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            entry["keys"] = [sha(item) for item in manifest["items"]]
            entry.pop("active_keys")
            entry.pop("key_version")
        (self.out / "state.json").write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        self.data["items"][0]["account_id"] = "new-stable-identity"
        self.write_source()
        _, plan = self.reconcile()
        self.assertEqual(plan["migration"], "legacy_account_identity_unbound")
        self.assertEqual(plan["summary"]["retained_confirmed_fields"], 3)
        self.assertEqual(plan["summary"]["media"]["retained_confirmed_items"], 1)
        self.assertTrue(self.state()["media_batches"][0]["reviewed"])
        self.assertEqual(len(self.state()["media_batches"][0]["active_keys"]), 1)

    def test_changed_partial_media_batch_can_be_prepared_without_obsolete_retry(self):
        self.data = fixture(2, media=True)
        self.data["items"][1]["media"][0]["url"] = "https://images.example.org/missing.png"
        self.write_source()
        self.prepare(fake_media=True)
        self.assertEqual(self.state()["media_batches"][0]["status"], "partial")
        self.data["items"][1]["media"] = []
        self.data["items"][1]["media_count"] = 0
        self.write_source()
        self.reconcile()
        self.assertEqual(self.state()["media_batches"][0]["status"], "superseded")
        self.assertEqual(self.invoke("confirm", "--out", self.out, "--batch", "media-0001", "--reviewer", "synthetic-reader", expect=(1,))["code"], "media_batch_unavailable")
        self.prepare(fake_media=True)
        self.assertEqual(self.state()["media_batches"][1]["status"], "ready")
        self.confirm({"batch_id": "media-0002"})
        self.assertEqual(self.invoke("status", "--out", self.out)["next_action"]["pending_media_batches"], 0)


class RecordingResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.records = []
    def addSuccess(self, test):
        super().addSuccess(test)
        self.records.append({"name": test.id().split(".")[-1], "passed": True})
    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.records.append({"name": test.id().split(".")[-1], "passed": False, "error": self._exc_info_to_string(err, test)})
    def addError(self, test, err):
        super().addError(test, err)
        self.records.append({"name": test.id().split(".")[-1], "passed": False, "error": self._exc_info_to_string(err, test)})


def main():
    global REPO, SCRIPT, API
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--fixture-media-cli", nargs=argparse.REMAINDER, help=argparse.SUPPRESS)
    args = parser.parse_args()
    REPO = args.repo.resolve()
    SCRIPT = REPO / "tools/research-batch/pipeline/prepare.py"
    if args.fixture_media_cli is not None:
        return fake_media_cli(REPO, args.fixture_media_cli)
    API = import_api(REPO)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ReconciliationCLI)
    result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2, resultclass=RecordingResult).run(suite)
    report = {"suite": "compact-reconciliation-positive-acceptance", "tested_at": datetime.now(timezone.utc).isoformat(),
        "repo": str(REPO), "python": sys.version, "platform": platform.platform(), "passed": result.wasSuccessful(),
        "tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors), "cli_calls": CLI_CALLS,
        "external_network_requests": 0, "real_accounts": 0, "real_threads": 0, "external_messages": 0,
        "scope": "synthetic CLI acceptance; not Windows/live deployment evidence unless the platform field says so",
        "source_sha256": {str(file.relative_to(REPO)): hashlib.sha256(file.read_bytes()).hexdigest()
                           for file in (SCRIPT, SCRIPT.with_name("compact.py"))}, "results": result.records}
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
