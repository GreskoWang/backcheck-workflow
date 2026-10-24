"""Focused checks for risk-summary links split across adjacent text runs."""

import copy
import unittest

from audit_feishu_snapshot import audit_internal_jump, jump_fingerprint, risk_highlight_links_match


TOKEN = "document-token"
FACT_IDS = {"x-cover", "sphere", "pixiv"}
TARGET = "pixiv"
TEXT = "本人 X 一般刊封面、转发的 Sphere 署名周边图与 Pixiv 插画的画面尺度"


def element(content: str, block_id: str | None, token: str = TOKEN) -> dict:
    style = {"link": {"url": f"https://my.feishu.cn/docx/{token}#{block_id}"}} if block_id else {}
    return {"text_run": {"content": content, "text_element_style": style}}


def linked_runs() -> list[dict]:
    return [
        element("本人 X 一般刊封面", "x-cover"),
        element("、转发的 Sphere 署名周边图", "sphere"),
        element("与 Pixiv 插画的画面尺度", "pixiv"),
    ]


class RiskHighlightLinksTest(unittest.TestCase):
    def check(self, entries: list[dict]) -> bool:
        return risk_highlight_links_match(entries, TEXT, TOKEN, TARGET, FACT_IDS)

    def test_distinct_destinations_rejected(self) -> None:
        self.assertFalse(self.check(linked_runs()))

    def test_split_runs_with_one_destination_accepted(self) -> None:
        self.assertTrue(self.check([element("本人 X 一般刊封面", TARGET),
                                    element("、转发的 Sphere 署名周边图", TARGET),
                                    element("与 Pixiv 插画的画面尺度", TARGET)]))

    def test_missing_link_rejected(self) -> None:
        entries = linked_runs()
        entries[1] = element("、转发的 Sphere 署名周边图", None)
        self.assertFalse(self.check(entries))

    def test_wrong_group_target_rejected(self) -> None:
        entries = linked_runs()
        entries[1] = element("、转发的 Sphere 署名周边图", "other-group-risk")
        self.assertFalse(self.check(entries))

    def test_wrong_document_rejected(self) -> None:
        entries = linked_runs()
        entries[1] = element("、转发的 Sphere 署名周边图", "sphere", token="other-document")
        self.assertFalse(self.check(entries))

    def test_configured_target_still_required(self) -> None:
        entries = linked_runs()
        entries[2] = element("与 Pixiv 插画的画面尺度", "sphere")
        self.assertFalse(self.check(entries))

    def test_single_run_still_requires_configured_target(self) -> None:
        self.assertTrue(self.check([element(TEXT, TARGET)]))
        self.assertFalse(self.check([element(TEXT, "sphere")]))


class ActualJumpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.items = [
            {"block_id": "root", "block_type": 1, "children": ["pin", "unrelated", TARGET]},
            {"block_id": "pin", "block_type": 19, "children": ["anchor"], "callout": {"emoji_id": "round_pushpin"}},
            {"block_id": "anchor", "block_type": 2, "text": {"elements": [element(TEXT, TARGET)]}},
            {"block_id": "unrelated", "block_type": 2, "text": {"elements": [element("普通文字", None)]}},
            {"block_id": TARGET, "block_type": 2, "text": {"elements": [element("风险事实", None)]}},
        ]
        self.record = {"token": TOKEN, "source_block_id": "anchor", "target_block_id": TARGET,
                       "method": "live_page", "target_visible": True, "checked_at": "2026-10-13T08:00:00+08:00",
                       "jump_fingerprint": jump_fingerprint(self.items, TOKEN, "anchor", TARGET)}

    def audit(self, records: list[dict] | None = None) -> list[dict]:
        return audit_internal_jump(self.items, TOKEN, "anchor", TARGET, records if records is not None else [self.record])

    def test_actual_live_and_user_confirmation_accepted(self) -> None:
        self.assertEqual(self.audit(), [])
        self.record["method"] = "user_confirmation"
        self.assertEqual(self.audit(), [])

    def test_missing_and_clicked_only_rejected(self) -> None:
        self.assertEqual(self.audit([])[0]["code"], "INTERNAL_JUMP_REQUIRED")
        self.record.pop("target_visible")
        self.record["clicked"] = True
        self.assertTrue(any(issue["code"] == "INTERNAL_JUMP_VISIBLE" for issue in self.audit()))

    def test_unrelated_text_revision_reuses_observation(self) -> None:
        self.items[3]["text"]["elements"] = [element("已修正普通文字", None)]
        self.assertEqual(self.audit(), [])

    def test_changed_anchor_or_target_placement_requires_new_check(self) -> None:
        original = copy.deepcopy(self.items)
        self.items[2]["text"]["elements"] = [element("另一句锚点", TARGET)]
        self.assertTrue(any(issue["code"] == "INTERNAL_JUMP_BINDING" for issue in self.audit()))
        self.items = original
        self.items[0]["children"] = ["pin", TARGET, "unrelated"]
        self.assertTrue(any(issue["code"] == "INTERNAL_JUMP_BINDING" for issue in self.audit()))

    def test_changed_href_or_relevant_style_requires_new_check(self) -> None:
        original = copy.deepcopy(self.items)
        self.items[2]["text"]["elements"] = [element(TEXT, "other")]
        self.assertTrue(any(issue["code"] == "INTERNAL_JUMP_BINDING" for issue in self.audit()))
        self.items = original
        self.items[2]["text"]["elements"][0]["text_run"]["text_element_style"]["bold"] = True
        self.assertTrue(any(issue["code"] == "INTERNAL_JUMP_BINDING" for issue in self.audit()))

    def test_wrong_token_target_or_time_rejected(self) -> None:
        for key, value in (("token", "other"), ("target_block_id", "other"), ("checked_at", "not a time")):
            record = {**self.record, key: value}
            self.assertTrue(self.audit([record]))


if __name__ == "__main__":
    unittest.main()
