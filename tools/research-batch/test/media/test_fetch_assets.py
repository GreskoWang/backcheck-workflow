"""Fake-transport tests only: no real HTTP, site access, credentials or installs."""
from __future__ import annotations

import importlib.util
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request

from PIL import Image

MEDIA_DIR = Path(__file__).resolve().parents[2] / "media"
sys.path.insert(0, str(MEDIA_DIR))
import fetch_assets as fetch


def image_body(format="PNG", size=(30, 20)):
    buffer = BytesIO()
    Image.new("RGB", size, "red").save(buffer, format=format)
    return buffer.getvalue()


class FakeTransport:
    def __init__(self, mapping=None, delay=0):
        self.mapping = mapping or {}
        self.delay = delay
        self.calls = []
        self.active = self.maximum_active = 0
        self.lock = threading.Lock()

    def fetch(self, url, *, headers, timeout, max_bytes):
        with self.lock:
            self.calls.append((url, headers))
            self.active += 1
            self.maximum_active = max(self.maximum_active, self.active)
        try:
            time.sleep(self.delay)
            result = self.mapping.get(url, fetch.TransportResponse(200, "image/png", image_body(), url))
            if isinstance(result, BaseException):
                raise result
            return result
        finally:
            with self.lock:
                self.active -= 1


class FetchAssetsBehaviorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="媒体下载离线测试-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def item(self, index=1, url=None, **extra):
        return {"source_id": f"image-{index}", "post_source_id": f"post-{index}", "account": "示例账号",
                "post_url": f"https://example.org/posts/{index}", "date": "2026-10-14",
                "url": url or f"https://images.example.org/{index}.png", **extra}

    def run_batch(self, items, transport=None, **options):
        path = self.root / "manifest.json"
        path.write_text(json.dumps({"schema_version": 1, "items": items}, ensure_ascii=False), encoding="utf-8")
        summary = fetch.download_batch(path, self.root / "output", transport=transport or FakeTransport(), **options)
        index = json.loads((self.root / "output" / "download-index.json").read_text(encoding="utf-8"))
        manifest = json.loads((self.root / "output" / "local-manifest.json").read_text(encoding="utf-8"))
        return summary, index["items"], manifest

    def test_success_preserves_source_and_feeds_sheet_directly(self):
        original = self.item(label="封面")
        summary, records, manifest = self.run_batch([original])
        self.assertEqual(summary["downloaded_count"], 1)
        for key in fetch.media.MAPPING_FIELDS:
            self.assertEqual(records[0][key], original[key])
            self.assertEqual(manifest["items"][0][key], original[key])
        self.assertEqual(summary["request_count"], 1)
        self.assertFalse(summary["coverage_complete"])
        self.assertEqual(summary["review_status"], "not_reviewed")
        response = subprocess.run([sys.executable, "-X", "utf8", str(MEDIA_DIR / "media.py"), "sheet",
                                   str(self.root / "output" / "local-manifest.json"), str(self.root / "sheets")],
                                  capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(response.returncode, 0, response.stderr)

    def test_supported_signatures_match_real_decoder(self):
        for format, mime in (("PNG", "image/png"), ("JPEG", "image/jpeg"), ("GIF", "image/gif"), ("WEBP", "image/webp"), ("AVIF", "image/avif")):
            with self.subTest(format=format):
                details = fetch.checked_image(image_body(format), mime, 100000, 10000)
                self.assertEqual(details["format"], format)
                self.assertEqual((details["width"], details["height"]), (30, 20))

    def test_avif_ftyp_accepts_only_complete_brand_fields(self):
        def ftyp(major, compatible=b"", minor=b"\0\0\0\0"):
            payload = major + minor + compatible
            return (8 + len(payload)).to_bytes(4, "big") + b"ftyp" + payload

        for body in (ftyp(b"avif"), ftyp(b"avis"), ftyp(b"mif1", b"avif")):
            with self.subTest(body=body):
                self.assertEqual(fetch.image_signature(body), "AVIF")
        invalid = [
            ftyp(b"mp42", b"isommp42"),
            ftyp(b"heic", b"mif1heic"),
            ftyp(b"mp42", minor=b"avif"),
            ftyp(b"mp42") + b"avif",  # Bytes outside ftyp are not brands.
            b"\0\0\0\x20ftypavif\0\0\0\0",  # Declared box is truncated.
            b"\0\0\0\x11ftypavif\0\0\0\0x",  # Partial brand field.
            b"\0\0\0\x08ftyp",  # No major brand or minor version.
            b"\0\0\0\x01ftypavif\0\0\0\0",  # Unsupported extended-size encoding.
        ]
        for body in invalid:
            with self.subTest(body=body), self.assertRaises(fetch.AssetError) as raised:
                fetch.image_signature(body)
            self.assertEqual(raised.exception.code, "image_signature_invalid")

    def test_avif_still_requires_mime_complete_decode_and_limits(self):
        body = image_body("AVIF")
        cases = [(body, "image/png", 100000, 10000, "image_type_mismatch"),
                 (body[:-20], "image/avif", 100000, 10000, "image_decode_failed"),
                 (body, "image/avif", 4, 10000, "asset_too_large"),
                 (body, "image/avif", 100000, 10, "image_too_many_pixels")]
        for data, mime, byte_limit, pixel_limit, expected in cases:
            with self.subTest(expected=expected):
                with self.assertRaises(fetch.AssetError) as raised:
                    fetch.checked_image(data, mime, byte_limit, pixel_limit)
                self.assertEqual(raised.exception.code, expected)

    def test_avif_download_preserves_original_url_and_feeds_sheet(self):
        original = self.item(url="https://images.example.org/picture.png@264w_264h_1e_1c.avif")
        transport = FakeTransport({original["url"]: fetch.TransportResponse(200, "image/avif", image_body("AVIF"), original["url"])})
        summary, records, manifest = self.run_batch([original], transport)
        self.assertEqual([call[0] for call in transport.calls], [original["url"]])
        self.assertEqual(summary["request_count"], 1)
        self.assertIn("image/avif", transport.calls[0][1]["Accept"])
        self.assertEqual(records[0]["format"], "AVIF")
        self.assertTrue(manifest["items"][0]["local_path"].endswith(".avif"))
        response = subprocess.run([sys.executable, "-X", "utf8", str(MEDIA_DIR / "media.py"), "sheet",
                                   str(self.root / "output" / "local-manifest.json"), str(self.root / "avif-sheets")],
                                  capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(response.returncode, 0, response.stderr)

    def test_type_signature_mismatch_is_explicit(self):
        item = self.item()
        transport = FakeTransport({item["url"]: fetch.TransportResponse(200, "text/html", image_body(), item["url"])})
        summary, records, manifest = self.run_batch([item], transport)
        self.assertEqual(summary["failed_count"], 1)
        self.assertEqual(records[0]["error_code"], "image_type_mismatch")
        self.assertIsNone(manifest["items"][0]["local_path"])

    def test_non_image_body_not_saved_as_image(self):
        item = self.item()
        transport = FakeTransport({item["url"]: fetch.TransportResponse(200, "image/png", b'{"error":1}', item["url"])})
        _, records, _ = self.run_batch([item], transport)
        self.assertEqual(records[0]["error_code"], "image_signature_invalid")
        self.assertEqual(list((self.root / "output" / "assets").iterdir()), [])

    def test_truncated_image_is_rejected_after_signature(self):
        with self.assertRaises(fetch.AssetError) as raised:
            fetch.checked_image(image_body()[:20], "image/png", 100000, 10000)
        self.assertEqual(raised.exception.code, "image_decode_failed")

    def test_byte_and_pixel_limits(self):
        with self.assertRaises(fetch.AssetError) as raised:
            fetch.checked_image(image_body(), "image/png", 4, 10000)
        self.assertEqual(raised.exception.code, "asset_too_large")
        with self.assertRaises(fetch.AssetError) as raised:
            fetch.checked_image(image_body(), "image/png", 100000, 10)
        self.assertEqual(raised.exception.code, "image_too_many_pixels")

    def test_credentials_and_auth_queries_never_reach_transport(self):
        values = ["https://username:password@example.org/a.png", "https://example.org/a.png?accessToken=private-value",
                  "https://example.org/a.png?x-amz-signature=private-value", "https://example.org/a.png?session=private-value"]
        transport = FakeTransport()
        summary, records, _ = self.run_batch([self.item(i, url) for i, url in enumerate(values)], transport)
        self.assertEqual(transport.calls, [])
        self.assertEqual(summary["attempted_item_count"], 0)
        self.assertEqual(len(records), 4)
        serialized = json.dumps(records)
        self.assertNotIn("private-value", serialized)
        self.assertNotIn("username", serialized)
        self.assertNotIn("password@", serialized)

    def test_local_and_non_http_urls_are_rejected(self):
        for url in ("file:///C:/file.png", "https://127.0.0.1/a.png", "http://localhost/a.png", "http://192.168.1.1/a.png", "ftp://example.org/a"):
            with self.subTest(url=url), self.assertRaises(fetch.AssetError):
                fetch.validated_url(url)

    def test_first_429_stops_host_and_other_host_continues(self):
        first = self.item(1)
        items = [first, self.item(2), self.item(3, "https://other.example.org/3.png"), self.item(4)]
        transport = FakeTransport({first["url"]: fetch.TransportResponse(429, "text/html", b"", first["url"])})
        summary, records, _ = self.run_batch(items, transport, concurrency=1)
        self.assertEqual([call[0] for call in transport.calls], [items[0]["url"], items[2]["url"]])
        self.assertEqual([record["status"] for record in records], ["failed", "not_downloaded", "downloaded", "not_downloaded"])
        self.assertEqual(summary["not_downloaded_count"], 2)
        self.assertEqual(summary["request_count"], 2)
        self.assertEqual(records[1]["request_count"], 0)

    def test_default_concurrency_is_bounded_at_three(self):
        transport = FakeTransport(delay=0.03)
        summary, _, _ = self.run_batch([self.item(i) for i in range(9)], transport)
        self.assertEqual(summary["concurrency"], 3)
        self.assertEqual(transport.maximum_active, 3)
        self.assertEqual(len(transport.calls), 9)

    def test_no_retry_on_403_or_transport_failure(self):
        items = [self.item(1), self.item(2)]
        transport = FakeTransport({items[0]["url"]: fetch.TransportResponse(403, "text/html", b"", items[0]["url"]),
                                   items[1]["url"]: TimeoutError("timeout")})
        summary, records, _ = self.run_batch(items, transport)
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(summary["request_count"], 2)
        self.assertEqual([record["error_code"] for record in records], ["http_error", "request_failed"])

    def test_redirect_validation_happens_before_follow(self):
        handler = fetch.SafeRedirectHandler()
        request = urllib.request.Request("https://images.example.org/a.png")
        for url in ("https://example.org/a.png?token=private-value", "https://127.0.0.1/a.png", "http://example.org/a.png"):
            with self.subTest(url=url), self.assertRaises(fetch.AssetError):
                handler.redirect_request(request, None, 302, "redirect", {}, url)
        self.assertEqual(handler.chain, [])

    def test_redirect_hops_are_counted_and_reported(self):
        item = self.item()
        target = "https://cdn.example.org/image.png"
        transport = FakeTransport({item["url"]: fetch.TransportResponse(200, "image/png", image_body(), target, [target])})
        summary, records, _ = self.run_batch([item], transport)
        self.assertEqual(summary["request_count"], 2)
        self.assertEqual(records[0]["redirect_count"], 1)
        self.assertEqual(records[0]["effective_url"], target)

    def test_output_directory_is_never_overwritten(self):
        output = self.root / "output"
        output.mkdir()
        marker = output / "user.txt"
        marker.write_text("preserve", encoding="utf-8")
        with self.assertRaises(fetch.media.ManifestError):
            self.run_batch([self.item()])
        self.assertEqual(marker.read_text(encoding="utf-8"), "preserve")

    def test_partial_local_manifest_retains_failed_slot_for_sheet(self):
        items = [self.item(1), self.item(2)]
        transport = FakeTransport({items[1]["url"]: fetch.TransportResponse(404, "text/html", b"", items[1]["url"])})
        summary, _, manifest = self.run_batch(items, transport)
        self.assertEqual(summary["failed_count"], 1)
        self.assertEqual(len(manifest["items"]), 2)
        response = subprocess.run([sys.executable, "-X", "utf8", str(MEDIA_DIR / "media.py"), "sheet",
                                   str(self.root / "output" / "local-manifest.json"), str(self.root / "sheets")],
                                  capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(response.returncode, 2, response.stderr)
        index = json.loads((self.root / "sheets" / "index.json").read_text(encoding="utf-8"))
        self.assertEqual([item["source_id"] for item in index["items"]], ["image-1", "image-2"])

    def test_referer_is_public_only_and_no_credential_headers(self):
        transport = FakeTransport()
        self.run_batch([self.item(referer="https://example.org/post/1")], transport)
        headers = transport.calls[0][1]
        self.assertEqual(headers["Referer"], "https://example.org/post/1")
        self.assertFalse(any(key.lower() in ("authorization", "cookie", "proxy-authorization") for key in headers))

    def test_default_transport_stream_limit_and_request_count_without_network(self):
        class Response(BytesIO):
            status = 200
            headers = {"Content-Type": "image/png"}

            def geturl(self):
                return "https://images.example.org/1.png"

        def build_mock_opener(*handlers):
            counter = next(handler for handler in handlers if isinstance(handler, fetch.RequestCounter))

            class Opener:
                def open(self, request, timeout):
                    counter.http_request(request)
                    return Response(image_body())

            return Opener()

        with patch.object(fetch.urllib.request, "build_opener", side_effect=build_mock_opener):
            with self.assertRaises(fetch.AssetError) as raised:
                fetch.UrllibTransport().fetch("https://images.example.org/1.png", headers={}, timeout=5, max_bytes=4)
        self.assertEqual(raised.exception.code, "asset_too_large")
        self.assertEqual(raised.exception.request_count, 1)
        self.assertEqual(raised.exception.redirect_chain, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
