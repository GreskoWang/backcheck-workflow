"""Offline synthetic evidence tests; no live research or collaboration actions."""
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from client_challenge_gate import REJECTION, audit_client_challenge, discovery_sha256, document_sha256, _source_texts, _occurrence_texts


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def block(block_id, text):
    return {"block_id": block_id, "text": {"elements": [{"text_run": {"content": text}}]}}


def binding(block_row):
    return {"block_id": block_row["block_id"], "text": block_row["text"]["elements"][0]["text_run"]["content"]}


def fixture(root, attitudes=None, source_quote=None):
    """Return review, discovery, current blocks, policy for an entirely synthetic task."""
    root = Path(root)
    attitudes = attitudes if attitudes is not None else [["警惕", "放松", "放松"], ["放松", "放松", "放松"]]
    policy = root / "policy.md"
    policy.write_text("Synthetic public-mention policy. Preserve concerns, source context and unknowns.", encoding="utf-8")
    source_rows = [
        {"source_ref": "https://example.invalid/post/1", "text": "Synthetic subject mentioned Qevira Stage in an advertisement complaint."},
        {"source_ref": "https://example.invalid/post/2", "text": "Synthetic subject repeated the Qevira Stage mention."},
        {"source_ref": "https://example.invalid/post/3", "text": "Synthetic subject announced Orchid Festival."},
    ]
    if source_quote is not None:
        source_rows[0]["text"] = source_quote
    source = write_json(root / "acquired.json", {"items": source_rows})
    discovery = {"version": 2, "mode": "assistant_research", "task_id": "synthetic-task", "primary_agent_id": "main-child",
        "source_revision": "sources-1", "reviewed_revision": "sources-1",
        "subagent_review": {"agent_id": "discovery-child"},
        "entities": [
            {"name": "Qevira Stage", "aliases": ["奎维拉舞台"], "source_refs": [source_rows[0]["source_ref"], source_rows[1]["source_ref"]]},
            {"name": "Orchid Festival", "aliases": [], "source_refs": [source_rows[2]["source_ref"]]},
        ],
        "semantic_review": {"source_batches": [{"batch_id": "A", "items_key": "items", **source}],
            "items": [{"batch_id": "A", "item_index": 0, "names": ["Qevira Stage"]},
                      {"batch_id": "A", "item_index": 1, "names": ["奎维拉舞台"]},
                      {"batch_id": "A", "item_index": 2, "names": ["Orchid Festival"]}]}}
    nouns = [{"id": "n1", "name": "Qevira Stage"}, {"id": "n2", "name": "奎维拉舞台"}, {"id": "n3", "name": "Orchid Festival"}]
    items = [block("summary", "The original public mentions raised a client concern about Qevira Stage; its identity and relevance remain partly unknown."),
             block("p1", "The subject complained about repeated Qevira Stage advertisements. A mention does not establish affiliation."),
             block("u1", source_rows[0]["source_ref"]),
             block("p2", "A second public mention used the title 奎维拉舞台. Context remains the original complaint."),
             block("u2", source_rows[1]["source_ref"]),
             block("p3", "The original public post announced Orchid Festival. Any client concern remains a concern, not an established affiliation."),
             block("u3", source_rows[2]["source_ref"])]
    digest = document_sha256(items)
    discovery_binding = {"task_id": discovery["task_id"], "source_revision": discovery["source_revision"],
                         "discovery_sha256": discovery_sha256(discovery)}
    policy_digest = hashlib.sha256(policy.read_bytes()).hexdigest()
    risk_locations = [{"risk_group_index": 0 if i < 2 else 1, "summary_location": binding(items[0]),
                       "platform_location": binding(items[i * 2 + 1])} for i in range(3)]
    def final_audit(revision, timestamp):
        return {"verdict": "PASS", "document": {"token": "synthetic-doc", "revision_id": revision}, "errors": [], "blocked": [],
            "discovery_binding": discovery_binding, "policy_sha256": policy_digest, "risk_locations": risk_locations,
            "document_sha256": digest, "receipt": {"token": "synthetic-doc", "revision_id": revision,
                "discovery_binding": discovery_binding, "policy_sha256": policy_digest, "risk_locations": risk_locations,
                "verdict": "PASS", "generated_at": timestamp, "document_sha256": digest}}
    review = {"version": 1, "task_id": discovery["task_id"], "source_revision": "sources-1",
        "document_token": "synthetic-doc", "revision_id": 2,
        "policy": {"path": str(policy), "sha256": hashlib.sha256(policy.read_bytes()).hexdigest()},
        "nouns": write_json(root / "nouns.json", nouns), "first_input": write_json(root / "first-input.json", nouns),
        "initial_final_review": write_json(root / "initial-final.json", final_audit(1, "2026-11-11T00:00:00Z")),
        "current_final_review": write_json(root / "current-final.json", final_audit(2, "2026-11-11T01:00:00Z")),
        "child": {"agent_id": "challenge-child", "created_agent_ids": ["challenge-child"], "fork_turns": "none",
            "spawn_ref": "synthetic#collaboration-spawn", "spawned_at": "2026-11-11T00:01:00Z"},
        "rounds": [], "triggered_term_ids": [], "inclusion": []}
    common = {"task_id": review["task_id"], "source_revision": review["source_revision"], "agent_id": review["child"]["agent_id"]}
    review["child"]["proof"] = write_json(root / "spawn-proof.json", {**common,
        "fork_turns": "none", "spawn_ref": review["child"]["spawn_ref"], "spawned_at": review["child"]["spawned_at"],
        "first_input_sha256": review["first_input"]["sha256"], "policy_sha256": review["policy"]["sha256"]})
    ever_alert = set()
    final_doubts = set()
    known_answers = {}
    ledger_rounds = []
    prior_hash = review["first_input"]["sha256"]
    for index, labels in enumerate(attitudes, 1):
        response = [{"id": noun["id"], "拒绝": REJECTION} if label == "拒绝" else {"id": noun["id"], "态度": label} for noun, label in zip(nouns, labels)]
        nonrelaxed = [row["id"] for row in response if row.get("态度") != "放松"]
        ever_alert.update(row["id"] for row in response if row.get("态度") == "警惕")
        final_doubts = {row["id"] for row in response if row.get("态度") == "疑问"}
        answers = []
        for term_id in nonrelaxed:
            occurrence_indices = [0, 1] if term_id in ("n1", "n2") else [2]
            answer = copy.deepcopy(known_answers.get(term_id, {
                "被问词": next(noun["name"] for noun in nouns if noun["id"] == term_id),
                "出现链接": [source_rows[i]["source_ref"] for i in occurrence_indices],
                "出现原文": [source_rows[i]["text"] for i in occurrence_indices],
                "上下文": ["The original post includes a public event or production title." for i in occurrence_indices],
                "释义词所指代的对象": "A synthetic named public production or festival.",
                "实际含义": "A title used in the original source. Public description: https://example.invalid/background/" + term_id}))
            if any(row["id"] == term_id and "拒绝" in row for row in response):
                answer["实际含义"] = f"The source uses the title as an event name; factual revision {index}."
            answers.append(answer)
            known_answers[term_id] = answer
        round_row = {"index": index, "response": write_json(root / f"response-{index}.json", response),
            "result_ref": f"synthetic#child-result-{index}", "responded_at": f"2026-11-11T00:{index * 2:02d}:00Z",
            "answer": write_json(root / f"answer-{index}.json", answers), "answer_ref": f"synthetic#main-answer-{index}",
            "answered_at": f"2026-11-11T00:{index * 2 + 1:02d}:00Z"}
        round_row["proof"] = write_json(root / f"result-proof-{index}.json", {**common, "index": index,
            "result_ref": round_row["result_ref"], "responded_at": round_row["responded_at"],
            "response_sha256": round_row["response"]["sha256"], "input_sha256": prior_hash})
        review["rounds"].append(round_row)
        ledger_rounds.append({"index": index, "agent_id": common["agent_id"], "result_ref": round_row["result_ref"],
            "response_sha256": round_row["response"]["sha256"], "answer_sha256": round_row["answer"]["sha256"]})
        prior_hash = round_row["answer"]["sha256"]
    triggered = ever_alert | final_doubts
    review["triggered_term_ids"] = sorted(triggered)
    review["ever_alert_ids"] = sorted(ever_alert)
    review["task_ledger"] = write_json(root / "task-ledger.json", {"version": 1, "task_id": review["task_id"],
        "source_revision": review["source_revision"], "created_agent_ids": [common["agent_id"]],
        "rounds": ledger_rounds, "triggered_term_ids": sorted(triggered), "ever_alert_ids": sorted(ever_alert)})
    for term_id in sorted(triggered):
        occurrence_indices = [0, 1] if term_id in ("n1", "n2") else [2]
        review["inclusion"].append({"id": term_id, "summary": binding(items[0]), "occurrences": [
            {"batch_id": "A", "item_index": i, "source_url": source_rows[i]["source_ref"],
             "platform": binding(items[i * 2 + 1]), "link": binding(items[i * 2 + 2])} for i in occurrence_indices]})
    return review, discovery, items, policy


class ClientChallengeTests(unittest.TestCase):
    def test_visual_observation_uses_full_same_post_capture_not_neighbour_or_quote(self):
        visual = {"url": "https://x.com/example/status/123/photo/2", "image_ref": "offline.png", "text": "Observer's visual description"}
        rows = {("A", 0): {"url": "https://x.com/example/status/123", "text": "Complete original post text."},
                ("A", 1): {"url": "https://x.com/example/status/124", "text": "Different post", "links": [visual["url"]]},
                ("A", 2): {"url": "https://evil.invalid/example/status/123", "text": "Unrelated website"}}
        texts = _occurrence_texts(visual, rows)
        self.assertIn("Complete original post text.", texts)
        for invalid in ("original post", "Different post", "Unrelated website"):
            self.assertNotIn(invalid, texts)
        self.assertEqual(_occurrence_texts({"url": visual["url"], "text": "Plain post"}, rows), {"Plain post"})

    def test_browser_transcript_preserves_complete_ordered_original(self):
        raw = {"url": "https://example.test/video", "title": "Example video",
               "description": "Original channel description", "segments": ["0:00\nFirst line", "0:07\nSecond line"]}
        texts = _source_texts(raw)
        self.assertIn("0:00\nFirst line\n0:07\nSecond line", texts)
        self.assertIn(raw["description"], texts)
        self.assertNotIn("First line", texts)
        self.assertNotIn("0:07\nSecond line\n0:00\nFirst line", texts)

    def test_visual_reference_requires_exact_link_in_referenced_capture(self):
        media = {"url": "https://x.com/artist/status/123/photo/1", "image_ref": "offline.png", "source_ref": "A.json#items[0]", "text": "Picture observation"}
        parent = {"url": "https://x.com/subject/status/456", "text": "Full subject comment and quoted artist post", "links": [{"url": media["url"]}]}
        rows = {("A", 0): parent}
        self.assertIn(parent["text"], _occurrence_texts(media, rows))
        parent["links"] = []
        self.assertNotIn(parent["text"], _occurrence_texts(media, rows))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.review, self.discovery, self.items, self.policy = fixture(self.root)

    def audit(self, review=None):
        return audit_client_challenge(self.review if review is None else review, discovery_review=self.discovery,
            items=self.items, document_token="synthetic-doc", revision_id=2, required_policy_path=self.policy, historical_v1=True)

    def assert_failure(self, code, review=None):
        result = self.audit(review)
        self.assertEqual(result["verdict"], "FAIL", result)
        self.assertIn("CHALLENGE_" + code, {row["code"] for row in result["errors"]}, result)
        return result

    def mutate(self, ref, change):
        path = Path(ref["path"])
        value = json.loads(path.read_text(encoding="utf-8"))
        change(value)
        ref.update(write_json(path, value))

    def test_warning_then_relaxation_preserves_inclusion_and_passes(self):
        result = self.audit()
        self.assertEqual(result["verdict"], "PASS", result)
        self.assertEqual(result["triggered_term_ids"], ["n1"])
        self.assertTrue(any("cannot authenticate" in message for message in result["info"]))

    def prepare_metadata_correction(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root, [["疑问", "放松", "疑问"]] * 3)
        previous = copy.deepcopy(self.discovery)
        previous["semantic_review"]["items"][1]["names"] = ["Orchid Festival"]
        previous["entities"][0]["identity"] = "Prior ambiguous interpretation"
        original_ref = write_json(self.root / "original-discovery.json", previous)
        old_binding = {"task_id": previous["task_id"], "source_revision": previous["source_revision"], "discovery_sha256": discovery_sha256(previous)}
        def rebind_initial(value):
            value["discovery_binding"] = old_binding
            value["receipt"]["discovery_binding"] = old_binding
        self.mutate(self.review["initial_final_review"], rebind_initial)
        # Preserve what was actually sent for the old occurrence mapping.
        def old_answer(value):
            first, last = value
            for key in ("出现链接", "出现原文", "上下文"):
                last[key].insert(0, first[key].pop(1))
        self.mutate(self.review["rounds"][0]["answer"], old_answer)
        old_answer_hash = self.review["rounds"][0]["answer"]["sha256"]
        self.mutate(self.review["rounds"][1]["proof"], lambda v: v.update(input_sha256=old_answer_hash))
        self.mutate(self.review["task_ledger"], lambda v: v["rounds"][0].update(answer_sha256=old_answer_hash))
        revalidated = json.loads(Path(self.review["current_final_review"]["path"]).read_text(encoding="utf-8"))
        revalidated["receipt"]["generated_at"] = "2026-11-11T00:04:30Z"
        self.review["discovery_correction"] = {"previous_discovery": original_ref,
            "revalidated_review": write_json(self.root / "corrected-review.json", revalidated),
            "applies_from_answer": 2, "reason": "Correct one existing occurrence's entity attribution.",
            "evidence_refs": ["synthetic#independent-disambiguation"]}

    def test_metadata_correction_keeps_historical_answers_and_requires_reassessment(self):
        self.prepare_metadata_correction()
        self.assertEqual(self.audit()["verdict"], "PASS", self.audit())

    def test_metadata_correction_cannot_change_acquired_sources(self):
        self.prepare_metadata_correction()
        self.mutate(self.review["discovery_correction"]["previous_discovery"], lambda v: v["semantic_review"]["source_batches"][0].update(sha256="0" * 64))
        self.assert_failure("DISCOVERY_CORRECTION_SCOPE")

    def test_metadata_correction_cannot_rewrite_original_vocabulary(self):
        self.prepare_metadata_correction()
        self.mutate(self.review["discovery_correction"]["previous_discovery"], lambda v: v["entities"][0].update(name="Different entity"))
        self.assert_failure("DISCOVERY_CORRECTION_SCOPE")

    def test_metadata_correction_requires_full_revalidation_before_answer(self):
        self.prepare_metadata_correction()
        self.mutate(self.review["discovery_correction"]["revalidated_review"], lambda v: v["receipt"].update(generated_at="2026-11-11T00:05:30Z"))
        self.assert_failure("DISCOVERY_CORRECTION_ORDER")

    def test_metadata_correction_cannot_end_without_next_child_round(self):
        self.prepare_metadata_correction()
        self.review["discovery_correction"]["applies_from_answer"] = 3
        self.assert_failure("DISCOVERY_CORRECTION_ORDER")

    def test_valid_all_relaxed_first_batch_passes(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root, [["放松"] * 3])
        result = self.audit()
        self.assertEqual(result["verdict"], "PASS", result)
        self.assertEqual(result["triggered_term_ids"], [])

    def test_doubt_then_relaxation_may_omit_risk(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root, [["疑问", "放松", "放松"], ["放松"] * 3])
        result = self.audit()
        self.assertEqual(result["verdict"], "PASS", result)
        self.assertEqual(result["triggered_term_ids"], [])
        self.assertEqual(result["ever_alert_ids"], [])
        self.assertEqual(self.review["inclusion"], [])

    def test_doubt_then_warning_is_mandatory_even_after_relaxation(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root,
            [["疑问", "放松", "放松"], ["警惕", "放松", "放松"], ["放松"] * 3])
        result = self.audit()
        self.assertEqual(result["verdict"], "PASS", result)
        self.assertEqual(result["triggered_term_ids"], ["n1"])
        self.assertEqual(result["ever_alert_ids"], ["n1"])

    def test_persistent_doubt_after_fact_answer_requires_inclusion(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root, [["疑问", "放松", "放松"]] * 2)
        result = self.audit()
        self.assertEqual(result["verdict"], "PASS", result)
        self.assertEqual(result["triggered_term_ids"], ["n1"])
        self.assertEqual(result["ever_alert_ids"], [])
        self.review["inclusion"] = []
        self.assert_failure("INCLUSION")

    def test_first_doubt_or_warning_cannot_close_with_unseen_answer(self):
        for label in ("疑问", "警惕"):
            with self.subTest(label=label):
                self.review, self.discovery, self.items, self.policy = fixture(self.root, [[label, "放松", "放松"]])
                self.assert_failure("UNACCEPTED_TERMINAL_ANSWER")

    def test_terminal_answer_cannot_introduce_new_unreviewed_wording(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root, [["警惕", "放松", "放松"]] * 2)
        self.mutate(self.review["rounds"][1]["answer"], lambda rows: rows[0].update(实际含义="New wording never submitted to child."))
        self.assert_failure("UNACCEPTED_TERMINAL_ANSWER")

    def test_final_rejection_fails_even_with_rewritten_answer(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root,
            [["警惕", "放松", "放松"], ["拒绝", "放松", "放松"]])
        result = self.assert_failure("FINAL_REJECTION")
        self.assertEqual(result["ever_alert_ids"], ["n1"])

    def test_rejected_answer_rewritten_then_accepted_can_close(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root,
            [["警惕", "放松", "放松"], ["拒绝", "放松", "放松"], ["警惕", "放松", "放松"]])
        result = self.audit()
        self.assertEqual(result["verdict"], "PASS", result)
        self.assertEqual(result["ever_alert_ids"], ["n1"])

    def test_rejected_doubt_then_relaxation_has_no_warning_to_preserve(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root,
            [["疑问", "放松", "放松"], ["拒绝", "放松", "放松"], ["放松"] * 3])
        result = self.audit()
        self.assertEqual(result["verdict"], "PASS", result)
        self.assertEqual(result["triggered_term_ids"], [])

    def test_fifth_batch_rejection_cannot_close_or_reset_budget(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root,
            [["警惕", "放松", "放松"]] * 4 + [["拒绝", "放松", "放松"]])
        self.assert_failure("FINAL_REJECTION")

    def test_first_round_cannot_reject_noun_list(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root, [["拒绝", "放松", "放松"], ["放松"] * 3])
        self.assert_failure("REJECTION_INPUT")

    def test_refusal_is_not_a_fourth_attitude(self):
        self.mutate(self.review["rounds"][0]["response"], lambda rows: rows[0].update(态度=REJECTION))
        self.assert_failure("RESPONSE_SHAPE")

    def test_refusal_cannot_coexist_with_attitude(self):
        self.mutate(self.review["rounds"][1]["response"], lambda rows: rows[0].update(拒绝=REJECTION))
        self.assert_failure("RESPONSE_SHAPE")

    def test_rejected_answer_cannot_be_reused_unchanged(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root,
            [["疑问", "放松", "放松"], ["拒绝", "放松", "放松"], ["放松"] * 3])
        original = json.loads(Path(self.review["rounds"][0]["answer"]["path"]).read_text(encoding="utf-8"))
        self.mutate(self.review["rounds"][1]["answer"], lambda rows: rows[0].update(original[0]))
        self.assert_failure("REJECTION_NOT_REWRITTEN")

    def test_child_input_is_only_six_fields_without_internal_ids(self):
        self.mutate(self.review["rounds"][0]["answer"], lambda rows: rows[0].update(id="n1"))
        self.assert_failure("ANSWER_SHAPE")

    def test_original_source_evaluations_remain_accepted_verbatim(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root,
            source_quote='The original author wrote: "just joking, not supporting it; no risk."')
        result = self.audit()
        self.assertEqual(result["verdict"], "PASS", result)

    def test_original_source_text_cannot_be_rephrased(self):
        self.mutate(self.review["rounds"][0]["answer"], lambda rows: rows[0]["出现原文"].__setitem__(0, "Short paraphrase."))
        self.assert_failure("ORIGINAL_TEXT")

    def test_fifth_batch_may_remain_nonrelaxed_with_final_answer(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root, [["警惕", "疑问", "放松"]] * 5)
        result = self.audit()
        self.assertEqual(result["verdict"], "PASS", result)
        self.assertEqual(result["triggered_term_ids"], ["n1", "n2"])

    def test_relaxation_cannot_erase_inclusion(self):
        self.review["inclusion"] = []
        self.assert_failure("INCLUSION")

    def test_relaxation_cannot_erase_cumulative_set(self):
        self.review["triggered_term_ids"] = []
        self.assert_failure("TRIGGER_SET")

    def test_missing_review_fails(self):
        result = audit_client_challenge(None, discovery_review=self.discovery, items=self.items,
            document_token="synthetic-doc", revision_id=2, required_policy_path=self.policy)
        self.assertEqual(result["verdict"], "FAIL", result)

    def test_partial_response_fails(self):
        self.mutate(self.review["rounds"][0]["response"], lambda rows: rows.pop())
        self.assert_failure("RESPONSE_COVERAGE")

    def test_duplicate_response_id_fails(self):
        self.mutate(self.review["rounds"][0]["response"], lambda rows: rows[2].update(id="n1"))
        self.assert_failure("RESPONSE_COVERAGE")

    def test_complete_response_table_in_wrong_order_fails_with_valid_hashes(self):
        round_row = self.review["rounds"][0]
        self.mutate(round_row["response"], lambda rows: rows.reverse())
        self.mutate(round_row["proof"], lambda proof: proof.update(response_sha256=round_row["response"]["sha256"]))
        self.mutate(self.review["task_ledger"], lambda ledger: ledger["rounds"][0].update(response_sha256=round_row["response"]["sha256"]))
        result = self.assert_failure("RESPONSE_ORDER")
        self.assertEqual({row["code"] for row in result["errors"]}, {"CHALLENGE_RESPONSE_ORDER"})

    def test_later_rejection_revokes_previous_acceptance_of_same_wording(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root,
            [["警惕", "放松", "放松"], ["警惕", "放松", "放松"], ["拒绝", "放松", "放松"], ["警惕", "放松", "放松"]])
        original = json.loads(Path(self.review["rounds"][0]["answer"]["path"]).read_text(encoding="utf-8"))
        final_round = self.review["rounds"][-1]
        self.mutate(final_round["answer"], lambda rows: rows[0].update(original[0]))
        self.mutate(self.review["task_ledger"], lambda ledger: ledger["rounds"][-1].update(answer_sha256=final_round["answer"]["sha256"]))
        result = self.assert_failure("UNACCEPTED_TERMINAL_ANSWER")
        self.assertEqual({row["code"] for row in result["errors"]}, {"CHALLENGE_UNACCEPTED_TERMINAL_ANSWER"})

    def test_child_output_extra_fields_or_invalid_labels_fail(self):
        for bad in ({"note": "ignored"}, {"态度": "clear"}, {"态度": []}):
            with self.subTest(bad=bad):
                self.review, self.discovery, self.items, self.policy = fixture(self.root)
                self.mutate(self.review["rounds"][0]["response"], lambda rows: rows[0].update(bad))
                self.assert_failure("RESPONSE_SHAPE")

    def test_json_duplicate_keys_and_markdown_wrappers_fail(self):
        for content in ('[{"id":"n1","态度":"疑问","态度":"放松"}]', '```json\n[]\n```', '[NaN]'):
            with self.subTest(content=content):
                ref = self.review["rounds"][0]["response"]
                Path(ref["path"]).write_text(content, encoding="utf-8")
                ref["sha256"] = hashlib.sha256(Path(ref["path"]).read_bytes()).hexdigest()
                self.assert_failure("ARTIFACT_JSON")

    def test_first_payload_cannot_contain_prior_report(self):
        self.mutate(self.review["first_input"], lambda rows: rows[0].update(conclusion="clear"))
        self.assert_failure("FIRST_INPUT")

    def test_wrong_or_reused_child_or_forked_context_fails(self):
        for child_update in ({"agent_id": "main-child"}, {"agent_id": "discovery-child"},
                {"created_agent_ids": ["challenge-child", "replacement-child"]}, {"fork_turns": "all"}):
            with self.subTest(change=child_update):
                review = copy.deepcopy(self.review)
                review["child"].update(child_update)
                self.assert_failure("CHILD_IDENTITY", review)

    def test_six_batches_cannot_reset_budget(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root, [["放松"] * 3] * 6)
        self.assert_failure("ROUND_COUNT")

    def test_ledger_prevents_omitting_existing_batch(self):
        self.review["rounds"].pop()
        self.assert_failure("LEDGER")

    def test_ledger_cannot_record_replacement_agent(self):
        self.mutate(self.review["task_ledger"], lambda ledger: ledger["created_agent_ids"].append("replacement"))
        self.assert_failure("LEDGER")

    def test_result_proof_wrong_child_or_input_fails(self):
        for change in ({"agent_id": "different-child"}, {"input_sha256": "0" * 64}, {"result_ref": "made-up-reference"}):
            with self.subTest(change=change):
                self.review, self.discovery, self.items, self.policy = fixture(self.root)
                self.mutate(self.review["rounds"][1]["proof"], lambda proof: proof.update(change))
                self.assert_failure("PROOF")

    def test_missing_real_references_fails(self):
        self.review["child"]["spawn_ref"] = ""
        self.review["rounds"][0]["result_ref"] = ""
        self.review["rounds"][0]["answer_ref"] = ""
        self.assert_failure("SPAWN_REF")
        self.assert_failure("RESULT_REF")
        self.assert_failure("ANSWER_REF")

    def test_no_final_main_answer_fails(self):
        self.review, self.discovery, self.items, self.policy = fixture(self.root, [["疑问", "放松", "放松"]])
        self.mutate(self.review["rounds"][0]["answer"], lambda answers: answers.clear())
        self.assert_failure("ANSWER_COVERAGE")

    def test_main_answer_extra_relaxed_term_fails(self):
        self.mutate(self.review["rounds"][0]["answer"], lambda answers: answers.append({**copy.deepcopy(answers[0]), "被问词": "Orchid Festival"}))
        self.assert_failure("ANSWER_COVERAGE")

    def test_main_answer_requires_definition_explanation_and_links(self):
        for change in ({"释义词所指代的对象": ""}, {"实际含义": ""}, {"出现链接": []}):
            with self.subTest(change=change):
                self.review, self.discovery, self.items, self.policy = fixture(self.root)
                self.mutate(self.review["rounds"][0]["answer"], lambda answers: answers[0].update(change))
                self.assert_failure("OCCURRENCE_COVERAGE" if "出现链接" in change else "ANSWER_DETAIL")

    def test_answer_must_cover_all_original_occurrences(self):
        self.mutate(self.review["rounds"][0]["answer"], lambda answers: answers[0]["出现原文"].pop())
        self.assert_failure("OCCURRENCE_COVERAGE")

    def test_final_inclusion_must_cover_every_occurrence(self):
        self.review["inclusion"][0]["occurrences"].pop()
        self.assert_failure("OCCURRENCE_COVERAGE")

    def test_links_must_match_real_acquired_sources(self):
        self.review["inclusion"][0]["occurrences"][0]["source_url"] = "https://example.invalid/unrelated"
        self.assert_failure("SOURCE_LINK")

    def test_document_link_requires_visible_url_or_real_hyperlink(self):
        occurrence = self.review["inclusion"][0]["occurrences"][0]
        occurrence["link"] = binding(self.items[1])
        self.assert_failure("DOCUMENT_LINK")

    def test_link_hyperlink_target_is_accepted(self):
        url = self.items[2]["text"]["elements"][0]["text_run"]["content"]
        self.items[2]["text"]["elements"][0]["text_run"] = {"content": "Source post", "text_element_style": {"link": {"url": url}}}
        self.review["inclusion"][0]["occurrences"][0]["link"] = binding(self.items[2])
        digest = document_sha256(self.items)
        self.mutate(self.review["current_final_review"], lambda audit: (audit.update(document_sha256=digest), audit["receipt"].update(document_sha256=digest)))
        self.assertEqual(self.audit()["verdict"], "PASS")

    def test_stale_or_nonexistent_block_fails(self):
        for change in ({"block_id": "absent"}, {"text": "old summary"}):
            with self.subTest(change=change):
                review = copy.deepcopy(self.review)
                review["inclusion"][0]["summary"].update(change)
                self.assert_failure("BLOCK_BINDING", review)

    def configure_cross_topic_occurrence(self):
        second_summary = block("second-summary", "A second public topic involving Qevira Stage.")
        self.items.append(second_summary)
        def update(audit):
            digest = document_sha256(self.items)
            audit["document_sha256"] = digest
            audit["receipt"]["document_sha256"] = digest
            audit["risk_locations"][1]["summary_location"] = binding(second_summary)
            audit["risk_locations"][1]["risk_group_index"] = 2
            audit["receipt"]["risk_locations"] = copy.deepcopy(audit["risk_locations"])
        self.mutate(self.review["current_final_review"], update)
        occurrence = self.review["inclusion"][0]["occurrences"][1]
        occurrence["summary"] = binding(second_summary)
        return occurrence

    def test_cross_topic_occurrence_uses_its_actual_audited_summary(self):
        self.configure_cross_topic_occurrence()
        self.assertEqual(self.audit()["verdict"], "PASS")

    def test_cross_topic_summary_cannot_point_to_unrelated_audited_pair(self):
        occurrence = self.configure_cross_topic_occurrence()
        occurrence["summary"] = binding(self.items[0])
        self.assert_failure("RISK_LOCATION_PAIR")

    def test_cross_topic_summary_stale_binding_fails(self):
        occurrence = self.configure_cross_topic_occurrence()
        occurrence["summary"]["text"] = "Old summary text"
        self.assert_failure("BLOCK_BINDING")

    def test_cross_topic_override_does_not_allow_missing_occurrence(self):
        self.configure_cross_topic_occurrence()
        self.review["inclusion"][0]["occurrences"].pop(0)
        self.assert_failure("OCCURRENCE_COVERAGE")

    def test_url_only_blocks_cannot_stand_in_for_risk_text(self):
        self.review["inclusion"][0]["summary"] = binding(self.items[2])
        for occurrence in self.review["inclusion"][0]["occurrences"]:
            occurrence["platform"] = copy.deepcopy(occurrence["link"])
        self.assert_failure("RISK_LOCATION_PAIR")
        self.assert_failure("RISK_TEXT")

    def test_existing_unrelated_platform_block_cannot_pass_risk_mapping(self):
        self.review["inclusion"][0]["occurrences"][0]["platform"] = binding(self.items[5])
        self.assert_failure("RISK_TEXT")

    def test_current_risk_locations_missing_or_receipt_mismatched_fail(self):
        self.mutate(self.review["current_final_review"], lambda audit: audit.pop("risk_locations"))
        self.assert_failure("FINAL_REVIEW_RISK_LOCATIONS")

    def test_initial_or_current_audit_from_another_shared_doc_subject_fails(self):
        for field in ("initial_final_review", "current_final_review"):
            with self.subTest(field=field):
                self.review, self.discovery, self.items, self.policy = fixture(self.root)
                def change(audit):
                    audit["discovery_binding"]["task_id"] = "another-subject-task"
                    audit["receipt"]["discovery_binding"]["task_id"] = "another-subject-task"
                self.mutate(self.review[field], change)
                self.assert_failure("FINAL_REVIEW_SCOPE")

    def test_same_declared_task_and_revision_with_different_discovery_content_fails(self):
        self.discovery["entities"][0]["identity"] = "Changed subject identity under reused task label."
        self.assert_failure("FINAL_REVIEW_SCOPE")

    def test_initial_or_current_audit_must_use_current_policy_bytes(self):
        for field in ("initial_final_review", "current_final_review"):
            with self.subTest(field=field):
                self.review, self.discovery, self.items, self.policy = fixture(self.root)
                self.mutate(self.review[field], lambda audit: (audit.update(policy_sha256="0" * 64), audit["receipt"].update(policy_sha256="0" * 64)))
                self.assert_failure("FINAL_REVIEW_POLICY")

    def test_changed_noun_alias_requires_reopening_upstream(self):
        self.discovery["entities"][0]["aliases"].append("Newly Found Alias")
        self.assert_failure("NOUN_EXPORT")

    def test_changed_raw_source_or_policy_bytes_fail(self):
        self.policy.write_text("Changed current policy", encoding="utf-8")
        self.assert_failure("ARTIFACT_HASH")

    def test_wrong_policy_path_with_same_bytes_fails(self):
        alternate = self.root / "other-policy.md"
        alternate.write_bytes(self.policy.read_bytes())
        self.review["policy"]["path"] = str(alternate)
        self.assert_failure("POLICY_PATH")

    def test_stale_task_source_or_document_fails(self):
        for field, value, code in (("task_id", "other", "SOURCE_BINDING"), ("source_revision", "old", "SOURCE_BINDING"),
                                  ("document_token", "other", "DOCUMENT_BINDING"), ("revision_id", 1, "DOCUMENT_BINDING")):
            with self.subTest(field=field):
                review = copy.deepcopy(self.review)
                review[field] = value
                self.assert_failure(code, review)

    def test_initial_pass_must_precede_new_child(self):
        self.mutate(self.review["initial_final_review"], lambda audit: audit["receipt"].update(generated_at="2026-11-11T00:02:00Z"))
        self.assert_failure("ORDER")

    def test_current_receipt_binds_complete_block_snapshot(self):
        self.items.append(block("new", "New content after audit."))
        self.assert_failure("FINAL_REVIEW_STALE")

    def test_current_receipt_must_be_pass_after_final_answer(self):
        self.mutate(self.review["current_final_review"], lambda audit: audit["receipt"].update(generated_at="2026-11-11T00:02:00Z"))
        self.assert_failure("ORDER")

    def test_failed_or_thin_audit_receipt_fails(self):
        self.mutate(self.review["initial_final_review"], lambda audit: audit.update(verdict="FAIL"))
        self.assert_failure("FINAL_REVIEW")

    def test_malformed_common_input_types_fail_without_crashing(self):
        for field, bad in (("child", []), ("rounds", "five"), ("inclusion", 4), ("policy", None), ("nouns", []),
                           ("triggered_term_ids", [{}]), ("rounds", [None, {"response": [], "index": True}])):
            with self.subTest(field=field, bad=bad):
                review = copy.deepcopy(self.review)
                review[field] = bad
                self.assertEqual(self.audit(review)["verdict"], "FAIL")

    def test_cli_rejects_old_per_noun_inclusion_for_current_release(self):
        state = {"client_challenge_review": self.review, "discovery_review": self.discovery, "items": self.items,
            "document_token": "synthetic-doc", "revision_id": 2, "required_policy_path": str(self.policy)}
        path = self.root / "state.json"
        write_json(path, state)
        completed = subprocess.run([sys.executable, str(Path(__file__).with_name("client_challenge_gate.py")), "--state", str(path)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(completed.returncode, 1)
        result = json.loads(completed.stdout)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("CHALLENGE_VERSION", {e["code"] for e in result["errors"]})

    def test_current_policy_permission_failure_is_reported(self):
        original = Path.read_bytes
        def read(path):
            if path == self.policy:
                raise PermissionError("synthetic unreadable policy")
            return original(path)
        with patch.object(Path, "read_bytes", read):
            result = self.audit()
        self.assertEqual(result["verdict"], "BLOCKED", result)
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["blocked"])

    def test_unreadable_evidence_remains_blocked_without_synthetic_missing_errors(self):
        original = Path.read_bytes
        for ref in (self.review["nouns"], self.review["initial_final_review"], self.review["child"]["proof"],
                    self.review["rounds"][0]["response"], self.review["task_ledger"]):
            target = Path(ref["path"])
            with self.subTest(path=target.name):
                def read(path):
                    if path == target:
                        raise PermissionError("synthetic inaccessible evidence")
                    return original(path)
                with patch.object(Path, "read_bytes", read):
                    result = self.audit()
                self.assertEqual(result["verdict"], "BLOCKED", result)
                self.assertEqual(result["errors"], [])

    def test_ledger_boolean_batch_number_is_not_an_integer(self):
        self.mutate(self.review["task_ledger"], lambda ledger: ledger["rounds"][0].update(index=True))
        self.assert_failure("LEDGER")


if __name__ == "__main__":
    unittest.main()
