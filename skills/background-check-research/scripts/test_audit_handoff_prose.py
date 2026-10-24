"""Regression fixtures: delivery pollution versus legitimate Chinese findings."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from audit_handoff_prose import audit_handoff_prose, audit_text, main


class HandoffProseTests(unittest.TestCase):
    def rules(self, text, role="fact"):
        return {item["rule"]: item["severity"] for item in audit_text(text, "$.fact", role)}

    def test_engineering_fields(self):
        self.assertEqual(self.rules("两个平台。频次记录：platform_record_count=2，distinct_content_group_count=1。")["engineering-field-in-prose"], "error")
        self.assertIn("engineering-field-in-prose", self.rules(r"platform\_record\_count=2"))
        self.assertIn("engineering-field-in-prose", self.rules("频次记录：weibo_posts_with_reportable_language=8，bilibili_reportable_asr_segments_approx=55。"))

    def test_raw_subject_labels(self):
        self.assertIn("raw-capture-label", self.rules("主体文字：尼玛怎么8月下才开音律 转发／引用：周边预告"))
        self.assertIn("raw-capture-label", self.rules("转发／引用（明日方舟朝陇山）：周边预告"))

    def test_actual_navigation(self):
        text = "精选 推荐 AI抖音 关注 朋友 我的 直播 放映厅 短剧 小游戏 搜索 充钻石 客户端 壁纸 通知 消息 投稿 凉夏夏ovo 深海队正片注明非AI。"
        self.assertEqual(self.rules(text)["web-navigation-pollution"], "error")

    def test_device_and_reaction_metadata(self):
        text = "就叫橘子蓝也行咯 7-24 12:27 来自 iPhone 16 Pro Max 反对虐待动物。 转发 评论 14"
        self.assertIn("web-metadata-pollution", self.rules(text))

    def test_short_accurate_summaries_not_flagged(self):
        for text in (
            "同一组深海队作品在森空岛和抖音均注明“非AI”；两个平台各出现1次，计1组内容。",
            "转发《明日方舟》周边预告时使用“尼玛”，表达对开售时间和优惠安排的不满。",
            "发布反对虐待动物的文字，微博出现1次。",
            "微博有18条内容使用粗口或强烈口语，共20处。",
            "B站共检查4条视频和1916帧；多人录屏涉及多名参与者，约55处为自动转写估算，不逐句归为主体本人。",
            "评论iPhone 16 Pro Max的拍摄体验，并讨论AI生成内容与创作真实性。",
            "讨论抖音的推荐机制，以及创作者如何通知朋友观看直播。",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.rules(text), {})

    def test_legitimate_quote_about_device_not_metadata(self):
        self.assertEqual(self.rules("原帖写道‘来自 iPhone 16 Pro Max’，用于说明拍摄设备。"), {})

    def test_internal_evidence_is_not_report_prose(self):
        data = {"risk_groups": [{"summary": "两个平台各出现1次。", "frequency": {"platform_record_count": 2},
                                "instances": [{"finding": "发布非AI创作声明。", "screenshots": [{"visible_text": "主体文字：原帖内容"}]}]}],
                "raw_text": "platform_record_count=2", "coverage": {"note": "主体文字：内部资料"}}
        self.assertEqual(audit_handoff_prose(data)["summary"]["errors"], 0)

    def test_snapshot_ignores_duplicate_raw_content_and_keeps_block_id(self):
        data = {"raw_content": {"content": "platform_record_count=2"}, "block_list": {"items": [
            {"block_id": "b1", "block_type": 2, "text": {"elements": [{"text_run": {"content": "主体文字：原文"}}]}}
        ]}}
        result = audit_handoff_prose(data)
        self.assertEqual(result["summary"]["fields_checked"], 1)
        self.assertEqual(result["findings"][0]["block_id"], "b1")
        self.assertEqual(result["findings"][0]["path"], "$.block_list.items[0].text.elements")

    def test_report_plan_prose_and_internal_frequency(self):
        data = {"subjects": [{"risk_groups": [{"summary": "2个平台出现。", "context_boundary": "platform_record_count=2", "frequency": {"platform_record_count": 2}, "instances": [{"fact": "标题20240625"}]}]}]}
        result = audit_handoff_prose(data)
        self.assertEqual(result["summary"]["errors"], 1)
        self.assertEqual(result["summary"]["warnings"], 1)

    def test_long_text_only_warns(self):
        self.assertEqual(self.rules("详细描述相关创作与合作经历。" * 30)["long-prose-review"], "warning")

    def test_video_title_warns_not_blocks(self):
        for text in ("秃霸花发芽中20240625", "秃霸花首次聚合！20240622_哔哩哔哩bilibili"):
            self.assertEqual(self.rules(text)["title-as-fact-review"], "warning")

    def test_real_title_field_not_mistaken_for_fact(self):
        self.assertNotIn("title-as-fact-review", self.rules("秃霸花发芽中20240625", role="title"))

    def test_boilerplate_warns(self):
        self.assertEqual(self.rules("仅记录AI生成内容／创作真实性议题出现及跨平台频次，不据此评价创作方式。")["methodology-boilerplate"], "warning")

    def test_unknown_input_is_not_silent_pass(self):
        with self.assertRaises(ValueError):
            audit_handoff_prose({"arbitrary": "text"})

    def test_empty_recognized_input_needs_review(self):
        self.assertEqual(audit_handoff_prose({"risk_groups": []})["status"], "manual_review")

    def test_cli_read_only_json_and_exit_code(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "payload.json"
            original = json.dumps({"risk_groups": [{"summary": "platform_record_count=2"}]}).encode()
            file.write_bytes(original)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = main(["--input", str(file)])
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(output.getvalue())["status"], "blocked")
            self.assertEqual(file.read_bytes(), original)
            self.assertEqual(list(Path(temp).iterdir()), [file])


if __name__ == "__main__":
    unittest.main()
