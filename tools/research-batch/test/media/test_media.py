"""Behavior tests using generated local images; no network or credentials."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

SCRIPT = Path(__file__).resolve().parents[2] / "media" / "media.py"
spec = importlib.util.spec_from_file_location("research_media", SCRIPT)
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)


class MediaBehaviorTest(unittest.TestCase):
    def test_font_uses_windows_environment_and_respects_explicit_override(self):
        root = str(Path(tempfile.gettempdir()) / 'system-font-fixture')
        sentinel = object()
        with patch.dict(media.os.environ, {'SystemRoot': root}, clear=True), patch.object(media.ImageFont, 'truetype', return_value=sentinel) as loader:
            font, source = media.get_font(None, 18)
            self.assertIs(font, sentinel)
            self.assertEqual(source, str(Path(root) / 'Fonts' / 'msyh.ttc'))
            loader.assert_called_once_with(source, 18)
            loader.reset_mock()
            explicit = str(Path(root) / 'custom.ttf')
            self.assertEqual(media.get_font(explicit, 20), (sentinel, explicit))
            loader.assert_called_once_with(explicit, 20)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="背调媒体测试-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def image(self, name, size=(96, 64), color="red"):
        path = self.root / name
        Image.new("RGB", size, color).save(path)
        return name

    def item(self, identity, path=None, **extra):
        result = {"source_id": identity, "post_source_id": "post-" + identity,
                  "account": "示例账号", "post_url": "https://example.org/posts/" + identity,
                  "date": "2026-10-14", "label": "中文标签"}
        if path is not None:
            result["local_path"] = path
        return {**result, **extra}

    def manifest(self, items, name="manifest.json"):
        path = self.root / name
        path.write_text(json.dumps({"schema_version": 1, "items": items}, ensure_ascii=False), encoding="utf-8")
        return path

    def run_cli(self, command, manifest, output="output", *options):
        result = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPT), command, str(manifest),
                                 str(self.root / output), *options], capture_output=True, text=True, encoding="utf-8")
        if result.returncode in (0, 2):
            index = json.loads((self.root / output / "index.json").read_text(encoding="utf-8"))
            summary = json.loads(result.stdout)
            return result, index, summary
        return result, None, None

    def video(self, identity="vid", timestamps=None, paths=None, **changes):
        metadata = {"img_x_len": 2, "img_y_len": 2, "img_x_size": 64, "img_y_size": 48,
                    "index": [0, 1.5, 4, 7, 10, 14] if timestamps is None else timestamps,
                    "image": ["https://example.org/sprite/1", "https://example.org/sprite/2"]}
        metadata.update(changes)
        return self.item(identity, metadata=metadata, sprite_paths=paths or ["sprite1.png", "sprite2.png"])

    def sprites(self):
        for number in (1, 2):
            image = Image.new("RGB", (128, 96), "black")
            for cell in range(4):
                if number == 1 and cell == 0:
                    continue
                tile = Image.new("RGB", (64, 48), (number * 50, cell * 50, 120))
                image.paste(tile, ((cell % 2) * 64, (cell // 2) * 48))
            image.save(self.root / f"sprite{number}.png")

    def test_source_mapping_and_pagination_are_complete(self):
        items = [self.item(f"media-{i}", self.image(f"图{i}.png")) for i in range(5)]
        result, index, summary = self.run_cli("sheet", self.manifest(items), "output", "--cols", "2", "--rows", "2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(summary["page_count"], 2)
        self.assertEqual([(i["page"], i["cell"]) for i in index["items"]], [(1, 1), (1, 2), (1, 3), (1, 4), (2, 1)])
        for original, mapped in zip(items, index["items"]):
            for field in media.MAPPING_FIELDS:
                self.assertEqual(original[field], mapped[field])
        self.assertFalse(summary["coverage_complete"])
        self.assertEqual(summary["review_status"], "not_reviewed")
        self.assertEqual(index["items"][4]["sheet"], "sheet_0002.jpg")
        self.assertTrue((self.root / "output" / "index.csv").read_bytes().startswith(b"\xef\xbb\xbf"))

    def test_missing_and_corrupt_images_keep_failure_slots(self):
        (self.root / "bad.png").write_text("not an image", encoding="utf-8")
        items = [self.item("ok", self.image("good.png")), self.item("missing", "missing.png"), self.item("bad", "bad.png")]
        result, index, summary = self.run_cli("sheet", self.manifest(items))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(summary["mapped_item_count"], 3)
        self.assertEqual(summary["failed_count"], 2)
        self.assertEqual([i["cell"] for i in index["items"]], [1, 2, 3])
        self.assertEqual([i["status"] for i in index["items"]], ["prepared", "failed", "failed"])
        self.assertTrue(all(i["error"] for i in index["items"][1:]))

    def test_small_images_are_not_upscaled_and_large_images_keep_ratio(self):
        items = [self.item("small", self.image("small.png", (32, 16))),
                 self.item("large", self.image("large.png", (2000, 1000)))]
        result, index, _ = self.run_cli("sheet", self.manifest(items))
        self.assertEqual(result.returncode, 0, result.stderr)
        small, large = index["items"]
        self.assertEqual((small["display_width"], small["display_height"]), (32, 16))
        self.assertEqual(large["display_width"], 2 * large["display_height"])
        self.assertLessEqual(large["display_width"], 352)
        self.assertLess(large["thumbnail_scale"], 1)

    def test_portrait_not_stretched(self):
        result, index, _ = self.run_cli("sheet", self.manifest([self.item("portrait", self.image("portrait.png", (100, 1000)))]))
        self.assertEqual(result.returncode, 0, result.stderr)
        item = index["items"][0]
        self.assertLessEqual(abs(item["display_height"] / item["display_width"] - 10), 0.2)

    def test_output_not_overwritten(self):
        manifest = self.manifest([self.item("ok", self.image("ok.png"))])
        output = self.root / "output"
        output.mkdir()
        marker = output / "user-data.txt"
        marker.write_text("preserve", encoding="utf-8")
        result, _, _ = self.run_cli("sheet", manifest)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(marker.read_text(encoding="utf-8"), "preserve")
        self.assertFalse((output / "index.json").exists())

    def test_duplicate_ids_are_rejected_before_output(self):
        item = self.item("same", self.image("one.png"))
        result, _, _ = self.run_cli("sheet", self.manifest([item, item]))
        self.assertEqual(result.returncode, 1)
        self.assertIn("duplicate", result.stderr)
        self.assertFalse((self.root / "output").exists())

    def test_remote_image_input_is_not_downloaded(self):
        result, index, summary = self.run_cli("sheet", self.manifest([self.item("remote", "https://example.org/image.png")]))
        self.assertEqual(result.returncode, 2)
        self.assertIn("only local filesystem paths", index["items"][0]["error"])
        self.assertEqual(summary["prepared_count"], 0)

    def test_layout_limit_rejects_unreadable_huge_wall(self):
        result, _, _ = self.run_cli("sheet", self.manifest([self.item("ok", self.image("ok.png"))]),
                                    "output", "--cols", "6")
        self.assertEqual(result.returncode, 1)
        self.assertIn("2000x2400", result.stderr)
        self.assertFalse((self.root / "output").exists())

    def test_long_label_truncation_is_visible_and_full_mapping_retained(self):
        item = self.item("long-" + "甲" * 200, self.image("ok.png"), label="乙" * 200)
        result, index, _ = self.run_cli("sheet", self.manifest([item]))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(index["items"][0]["display_label_truncated"])
        self.assertEqual(index["items"][0]["source_id"], item["source_id"])
        self.assertEqual(index["items"][0]["label"], item["label"])

    def test_video_timestamps_cross_sprite_boundary_and_black_frame_kept(self):
        self.sprites()
        item = self.video()
        result, index, summary = self.run_cli("videoshot", self.manifest([item]), "output", "--cols", "2", "--rows", "2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(summary["mapped_item_count"], 6)
        self.assertEqual(summary["page_count"], 2)
        self.assertEqual([i["frame_timestamp"] for i in index["items"]], item["metadata"]["index"])
        self.assertEqual([i["metadata_index"] for i in index["items"]], list(range(6)))
        self.assertEqual([i["sprite_index"] for i in index["items"]], [0, 0, 0, 0, 1, 1])
        self.assertTrue(index["items"][0]["black_frame_kept"])
        self.assertEqual(index["items"][4]["crop_box"], [0, 0, 64, 48])
        self.assertEqual(index["items"][5]["frame_timestamp_unit"], "seconds")
        self.assertEqual(index["items"][5]["post_source_id"], item["post_source_id"])
        self.assertEqual(index["videos"][0]["unused_supplied_cell_count"], 2)
        self.assertFalse(index["videos"][0]["audio_reviewed"])
        frame = Image.open(self.root / "output" / index["items"][4]["prepared_file"])
        self.assertEqual(frame.getpixel((1, 1)), (100, 0, 120))
        frame.close()

    def test_video_missing_sprite_keeps_all_timestamp_slots(self):
        self.sprites()
        result, index, summary = self.run_cli("videoshot", self.manifest([self.video(paths=["sprite1.png"])]))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(summary["mapped_item_count"], 6)
        self.assertEqual(summary["failed_count"], 2)
        self.assertEqual([i["frame_timestamp"] for i in index["items"][-2:]], [10, 14])
        self.assertTrue(all(i["error_code"] == "sprite_unavailable" for i in index["items"][-2:]))

    def test_video_corrupt_sprite_is_reported_per_frame(self):
        self.sprites()
        (self.root / "sprite1.png").write_text("bad", encoding="utf-8")
        result, index, summary = self.run_cli("videoshot", self.manifest([self.video()]))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(summary["failed_count"], 4)
        self.assertEqual(index["items"][4]["status"], "prepared")

    def test_video_crop_bounds_are_checked_not_black_padded(self):
        self.image("short.png", (64, 48))
        result, index, summary = self.run_cli("videoshot", self.manifest([self.video(timestamps=[0, 1, 2, 3], paths=["short.png"])]))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(summary["failed_count"], 3)
        self.assertEqual(index["items"][1]["error_code"], "sprite_bounds_error")

    def test_video_without_timestamps_does_not_invent_intervals(self):
        self.sprites()
        item = self.video()
        del item["metadata"]["index"]
        result, index, summary = self.run_cli("videoshot", self.manifest([item]))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(summary["mapped_item_count"], 1)
        self.assertIsNone(index["items"][0]["frame_timestamp"])
        self.assertEqual(index["items"][0]["error_code"], "metadata_invalid")

    def test_video_nonmonotonic_timestamps_fail(self):
        self.sprites()
        result, index, _ = self.run_cli("videoshot", self.manifest([self.video(timestamps=[0, 5, 2])]))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(index["items"][0]["error_code"], "metadata_invalid")

    def test_metadata_file_envelope_and_unicode_paths(self):
        self.sprites()
        item = self.video()
        data = item.pop("metadata")
        metadata_path = self.root / "视频元数据.json"
        metadata_path.write_text(json.dumps({"code": 0, "data": data}), encoding="utf-8")
        item["metadata_path"] = metadata_path.name
        result, index, _ = self.run_cli("videoshot", self.manifest([item]))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(index["items"][1]["metadata_timestamp"], 1.5)

    def test_bad_video_does_not_block_other_video(self):
        self.sprites()
        good = self.video("good")
        bad = self.video("bad", timestamps=[])
        result, index, summary = self.run_cli("videoshot", self.manifest([bad, good]))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(summary["prepared_count"], 6)
        self.assertEqual(summary["failed_count"], 1)
        self.assertEqual(index["videos"][1]["status"], "prepared")

    def test_malformed_sprite_metadata_is_isolated(self):
        self.sprites()
        good = self.video("good")
        bad = self.video("bad", image=None)
        result, index, summary = self.run_cli("videoshot", self.manifest([bad, good]))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(summary["prepared_count"], 6)
        self.assertEqual(index["items"][0]["error_code"], "metadata_invalid")


if __name__ == "__main__":
    unittest.main(verbosity=2)
