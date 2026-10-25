#!/usr/bin/env python3
"""Download public image assets without browser credentials; prepare a local media manifest.

No cookies, browser storage, authentication handlers, automatic retry or proxy
override. Offline tests inject a transport and never access real sites.
"""
from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import csv
from dataclasses import dataclass, field
from io import BytesIO
import ipaddress
import json
from pathlib import Path
import tempfile
import time
import sys
import urllib.error
import urllib.parse
import urllib.request
import warnings
import hashlib
import os
import threading
from uuid import uuid4

from PIL import Image

import media

AUTH_QUERY_KEYS = frozenset({
    "token", "access_token", "refresh_token", "id_token", "auth", "authorization", "credential", "credentials",
    "password", "passwd", "secret", "api_key", "apikey", "key", "cookie", "session", "sessionid", "sid",
    "signature", "sig", "sign", "xsec_token", "x-amz-credential", "x-amz-signature", "x-goog-credential",
    "x-goog-signature", "x-oss-signature", "ossaccesskeyid", "awsaccesskeyid", "jwt", "stoken", "authkey", "auth_key",
})
MIMES = {"PNG": {"image/png"}, "JPEG": {"image/jpeg", "image/jpg"}, "GIF": {"image/gif"}, "WEBP": {"image/webp"}, "AVIF": {"image/avif"}}
EXTENSIONS = {"PNG": ".png", "JPEG": ".jpg", "GIF": ".gif", "WEBP": ".webp", "AVIF": ".avif"}
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) research-batch-media/1.0"


class AssetError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def sensitive_query_key(key: str) -> bool:
    key = key.casefold().replace("-", "_")
    normalized = {value.replace("-", "_") for value in AUTH_QUERY_KEYS}
    compact = key.replace("_", "")
    return key in normalized or compact in {value.replace("_", "") for value in normalized} or any(part in key for part in ("password", "secret", "credential", "authorization")) or key.endswith("_token")


def validated_url(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(char) < 32 for char in value):
        raise AssetError("url_invalid", "URL must be a non-empty HTTP(S) string without control characters")
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise AssetError("url_invalid", "URL has an invalid hostname or port") from exc
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        raise AssetError("url_invalid", "only HTTP(S) media URLs are accepted")
    if parsed.username is not None or parsed.password is not None:
        raise AssetError("url_credentials_rejected", "URL userinfo is not accepted")
    if parsed.fragment:
        raise AssetError("url_invalid", "URL fragments are not accepted; provide the public asset URL")
    host = parsed.hostname.casefold().rstrip(".")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise AssetError("url_not_public", "local hostnames are not accepted")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if "." not in host:
            raise AssetError("url_not_public", "single-label local hostnames are not accepted")
    else:
        if not address.is_global:
            raise AssetError("url_not_public", "non-public IP addresses are not accepted")
    if any(sensitive_query_key(key) for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)):
        raise AssetError("url_auth_query_rejected", "authentication or signature query parameters are not accepted")
    return urllib.parse.urlunsplit((parsed.scheme.lower(), parsed.netloc, parsed.path or "/", parsed.query, ""))


def host_for(url: str) -> str:
    return urllib.parse.urlsplit(url).hostname.casefold().rstrip(".")


def safe_record_url(value: object) -> str:
    if not isinstance(value, str):
        return "<missing URL>"
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
            return "<invalid URL>"
        host = parsed.hostname
        if ":" in host:
            host = "[" + host + "]"
        if parsed.port:
            host += ":" + str(parsed.port)
        query = urllib.parse.urlencode([(key, "<redacted>" if sensitive_query_key(key) else value)
                                       for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)])
        return urllib.parse.urlunsplit((parsed.scheme, host, parsed.path, query, ""))
    except ValueError:
        return "<invalid URL>"


@dataclass
class TransportResponse:
    status: int
    content_type: str
    body: bytes
    effective_url: str
    redirect_chain: list[str] = field(default_factory=list)
    request_count: int | None = None
    cache_path: str | None = None


class PublicImageCache:
    """Task-local public assets, one blob per content, retaining each source map."""
    def __init__(self, directory, transport):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.transport = transport
        self.lock, self.key_locks = threading.Lock(), {}
        self.index_file = self.directory / "index.json"
        self.index = json.loads(self.index_file.read_text(encoding="utf-8")) if self.index_file.exists() else {}

    def fetch(self, url, *, headers, timeout, max_bytes):
        validated_url(url)
        key = hashlib.sha256(json.dumps([url, headers], sort_keys=True).encode()).hexdigest()
        with self.lock:
            guard = self.key_locks.setdefault(key, threading.Lock())
        with guard:
            entry = self.index.get(key)
            if entry:
                sha = entry["sha256"]
                if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
                    raise AssetError("cache_invalid", "Invalid public image cache")
                blob = self.directory / sha
                if not blob.is_file() or blob.stat().st_size > max_bytes:
                    raise AssetError("cache_invalid", "Cached image missing or over budget")
                body = blob.read_bytes()
                if hashlib.sha256(body).hexdigest() != sha:
                    raise AssetError("cache_invalid", "Cached image changed; preserve for inspection")
                return TransportResponse(200, entry["content_type"], body, entry["effective_url"],
                                         entry["redirect_chain"], 0, str(blob))
            response = self.transport.fetch(url, headers=headers, timeout=timeout, max_bytes=max_bytes)
            if response.status != 200:
                return response
            validated_url(response.effective_url)
            for redirect in response.redirect_chain:
                validated_url(redirect)
            checked_image(response.body, response.content_type, max_bytes, media.MAX_INPUT_PIXELS)
            sha = hashlib.sha256(response.body).hexdigest()
            blob = self.directory / sha
            with self.lock:
                if blob.exists():
                    if blob.read_bytes() != response.body:
                        raise AssetError("cache_invalid", "Cached content mismatch")
                else:
                    temporary = self.directory / (uuid4().hex + ".tmp")
                    temporary.write_bytes(response.body)
                    os.replace(temporary, blob)
                self.index[key] = {"sha256": sha, "content_type": response.content_type,
                                   "effective_url": response.effective_url, "redirect_chain": response.redirect_chain}
                temporary = self.directory / (uuid4().hex + ".tmp")
                temporary.write_text(json.dumps(self.index, ensure_ascii=False), encoding="utf-8")
                os.replace(temporary, self.index_file)
            response.cache_path = str(blob)
            return response


class RequestCounter(urllib.request.BaseHandler):
    def __init__(self):
        self.urls = []

    def http_request(self, request):
        self.urls.append(request.full_url)
        return request

    https_request = http_request


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def __init__(self):
        super().__init__()
        self.chain = []

    def redirect_request(self, request, response, code, message, headers, new_url):
        # Validate before following the redirect, including cross-host redirects.
        approved = validated_url(new_url)
        if urllib.parse.urlsplit(request.full_url).scheme == "https" and urllib.parse.urlsplit(approved).scheme == "http":
            raise AssetError("redirect_downgrade_rejected", "HTTPS to HTTP redirect is not accepted")
        self.chain.append(approved)
        return super().redirect_request(request, response, code, message, headers, approved)


class UrllibTransport:
    def fetch(self, url: str, *, headers: dict, timeout: float, max_bytes: int) -> TransportResponse:
        redirect = SafeRedirectHandler()
        counter = RequestCounter()
        try:
            return self._fetch(url, headers=headers, timeout=timeout, max_bytes=max_bytes, redirect=redirect, counter=counter)
        except AssetError as exc:
            exc.redirect_chain = counter.urls[1:]
            exc.request_count = len(counter.urls)
            raise
        except (OSError, TimeoutError, urllib.error.URLError) as exc:
            error = AssetError("request_failed", f"{type(exc).__name__}; no automatic retry")
            error.redirect_chain = counter.urls[1:]
            error.request_count = len(counter.urls)
            raise error from exc

    def _fetch(self, url: str, *, headers: dict, timeout: float, max_bytes: int,
               redirect: SafeRedirectHandler, counter: RequestCounter) -> TransportResponse:
        # Keep urllib's configured proxy behavior and default TLS validation.
        # Do not add cookie/auth handlers, read browser profiles or weaken proxy/TLS settings.
        opener = urllib.request.build_opener(redirect, counter)
        started = time.monotonic()
        request = urllib.request.Request(validated_url(url), headers=headers, method="GET")
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            return TransportResponse(exc.code, exc.headers.get("Content-Type", ""), b"", exc.geturl(), counter.urls[1:], len(counter.urls))
        with response:
            length = response.headers.get("Content-Length")
            if length and length.isdecimal() and int(length) > max_bytes:
                raise AssetError("asset_too_large", "Content-Length exceeds configured byte limit")
            content = bytearray()
            while True:
                if time.monotonic() - started > timeout:
                    raise AssetError("request_timeout", "request exceeded configured wall-clock timeout")
                chunk = response.read(min(65536, max_bytes - len(content) + 1))
                if not chunk:
                    break
                content.extend(chunk)
                if len(content) > max_bytes:
                    raise AssetError("asset_too_large", "response body exceeds configured byte limit")
            return TransportResponse(response.status, response.headers.get("Content-Type", ""), bytes(content),
                                     response.geturl(), counter.urls[1:], len(counter.urls))


def image_signature(body: bytes) -> str:
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if body.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if body.startswith((b"GIF87a", b"GIF89a")):
        return "GIF"
    if len(body) >= 12 and body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "WEBP"
    if len(body) >= 16 and body[4:8] == b"ftyp":
        box_size = int.from_bytes(body[:4], "big")
        if 16 <= box_size <= len(body) and (box_size - 16) % 4 == 0:
            # Only the major and complete compatible-brand fields identify AVIF;
            # arbitrary payload bytes and the minor-version field do not.
            if body[8:12] in (b"avif", b"avis") or any(
                body[offset:offset + 4] in (b"avif", b"avis") for offset in range(16, box_size, 4)
            ):
                return "AVIF"
    raise AssetError("image_signature_invalid", "response has no supported PNG/JPEG/GIF/WebP/AVIF signature")


def checked_image(body: bytes, content_type: str, max_bytes: int, max_pixels: int) -> dict:
    if len(body) > max_bytes:
        raise AssetError("asset_too_large", "response body exceeds configured byte limit")
    signature = image_signature(body)
    mime = content_type.split(";", 1)[0].strip().lower()
    if mime not in MIMES[signature]:
        raise AssetError("image_type_mismatch", "Content-Type does not match the supported image signature")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(body)) as image:
                if image.format != signature:
                    raise AssetError("image_type_mismatch", "decoded image format does not match its signature")
                if image.width * image.height > max_pixels:
                    raise AssetError("image_too_many_pixels", "image exceeds configured pixel limit")
                image.load()
                return {"format": signature, "width": image.width, "height": image.height,
                        "animated_frames": getattr(image, "n_frames", 1), "bytes": len(body)}
    except AssetError:
        raise
    except (SyntaxError, *media.IMAGE_ERRORS) as exc:
        raise AssetError("image_decode_failed", "response is not a decodable complete image") from exc


def download_one(index: int, item: dict, stage: Path, transport, *, timeout: float, max_bytes: int, max_pixels: int) -> dict:
    record = {**media.mapped_item(item), "sequence": index + 1, "url": safe_record_url(item.get("url")),
              "attempted": False, "request_count": 0, "local_path": None, "status": "failed"}
    if item.get("export_status") == "unavailable":
        code = item.get("export_error_code")
        code = code if isinstance(code, str) and len(code) <= 64 and all(char.islower() or char.isdigit() or char == "_" for char in code) else "media_unavailable"
        record.update(error_code=code, error="upstream declared unavailable; no request attempted")
        return record
    try:
        url = validated_url(item.get("url"))
        headers = {"User-Agent": USER_AGENT, "Accept": "image/png,image/jpeg,image/webp,image/gif,image/avif"}
        if item.get("referer") is not None:
            headers["Referer"] = validated_url(item["referer"])
        record.update(attempted=True, request_count=1)
        response = transport.fetch(url, headers=headers, timeout=timeout, max_bytes=max_bytes)
        chain = [validated_url(value) for value in response.redirect_chain]
        effective = validated_url(response.effective_url)
        record.update(http_status=response.status, effective_url=safe_record_url(effective),
                      redirect_chain=[safe_record_url(value) for value in chain], redirect_count=len(chain),
                      request_count=response.request_count if response.request_count is not None else 1 + len(chain),
                      content_type=response.content_type)
        if response.status == 429:
            record["rate_limited_hosts"] = sorted({host_for(url), host_for(effective)})
            raise AssetError("host_rate_limited", "HTTP 429; stop new requests to this host for this batch")
        if response.status != 200:
            raise AssetError("http_error", f"HTTP {response.status}; no automatic retry or authentication fallback")
        details = checked_image(response.body, response.content_type, max_bytes, max_pixels)
        local_file = response.cache_path or f"assets/item_{index + 1:06d}{EXTENSIONS[details['format']]}"
        if not response.cache_path:
            (stage / local_file).write_bytes(response.body)
        record.update(details, local_path=local_file, status="downloaded")
    except AssetError as exc:
        if record["attempted"] and hasattr(exc, "redirect_chain"):
            record.update(redirect_chain=[safe_record_url(value) for value in exc.redirect_chain],
                          redirect_count=len(exc.redirect_chain), request_count=getattr(exc, "request_count", 1 + len(exc.redirect_chain)))
        record.update(error_code=exc.code, error=str(exc))
    except (OSError, TimeoutError, urllib.error.URLError) as exc:
        record.update(error_code="request_failed", error=f"{type(exc).__name__}; no automatic retry")
    return record


def download_batch(manifest_path: Path, output: Path, *, concurrency: int = 3, timeout: float = 20,
                   max_bytes: int = 10 * 1024 * 1024, max_pixels: int = media.MAX_INPUT_PIXELS,
                   transport=None, cache_directory=None) -> dict:
    if not 1 <= concurrency <= 3 or not 0 < timeout <= 120 or not 0 < max_bytes <= 50 * 1024 * 1024 or not 0 < max_pixels <= media.MAX_INPUT_PIXELS:
        raise media.ManifestError("concurrency must be 1..3, timeout 0..120 seconds, bytes <=50MiB, pixels <=40000000")
    manifest_path = media.local_path(str(manifest_path), Path.cwd())
    output = media.local_path(str(output), Path.cwd())
    if output.exists():
        raise media.ManifestError("output directory already exists; nothing is overwritten")
    if not output.parent.is_dir():
        raise media.ManifestError("output parent directory must already exist")
    manifest = media.load_manifest(manifest_path)
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.pending-", dir=output.parent))
    (stage / "assets").mkdir()
    transport = transport if transport is not None else UrllibTransport()
    if cache_directory is not None:
        transport = PublicImageCache(cache_directory, transport)
    records = [None] * len(manifest["items"])
    blocked_hosts, pending = set(), list(enumerate(manifest["items"]))
    try:
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            active = {}
            while pending or active:
                while pending and len(active) < concurrency:
                    index, item = pending.pop(0)
                    try:
                        host = host_for(validated_url(item.get("url")))
                    except AssetError:
                        host = None
                    if host in blocked_hosts:
                        records[index] = {**media.mapped_item(item), "sequence": index + 1,
                                          "url": safe_record_url(item.get("url")), "attempted": False,
                                          "request_count": 0, "local_path": None, "status": "not_downloaded",
                                          "error_code": "host_rate_limited", "error": "not started because this host returned HTTP 429"}
                        continue
                    future = executor.submit(download_one, index, item, stage, transport, timeout=timeout,
                                             max_bytes=max_bytes, max_pixels=max_pixels)
                    active[future] = index
                if not active:
                    continue
                done, _ = wait(active, return_when=FIRST_COMPLETED)
                # Process every completion, including all 429s, before submitting more work.
                for future in done:
                    index = active.pop(future)
                    record = future.result()
                    records[index] = record
                    blocked_hosts.update(record.get("rate_limited_hosts", []))
        local_items = [{**media.mapped_item(item),
                        "local_path": record["local_path"], "download_status": record["status"],
                        "download_error_code": record.get("error_code")}
                       for item, record in zip(manifest["items"], records)]
        successful = sum(record["status"] == "downloaded" for record in records)
        summary = {"schema_version": 1, "input_item_count": len(records), "downloaded_count": successful,
                   "failed_count": sum(record["status"] == "failed" for record in records),
                   "not_downloaded_count": sum(record["status"] == "not_downloaded" for record in records),
                   "attempted_item_count": sum(record["attempted"] for record in records),
                   "candidate_count": sum(record["candidate"] for record in records),
                   "unverified_attribution_count": sum(not record["attribution_verified"] for record in records),
                   "request_count": sum(record["request_count"] for record in records),
                   "request_count_basis": "transport GET attempts including redirect requests; no automatic retries",
                   "concurrency": concurrency, "blocked_hosts": sorted(blocked_hosts),
                   "preparation_status": "ready" if successful == len(records) else "partial", **media.UNREVIEWED}
        media.write_json(stage / "local-manifest.json", {"schema_version": 1, "items": local_items})
        media.write_json(stage / "download-index.json", {"schema_version": 1, **media.UNREVIEWED, "items": records})
        media.write_json(stage / "summary.json", summary)
        fields = ["sequence", *media.MAPPING_FIELDS, *media.MEDIA_STATE_FIELDS, "url", "effective_url", "status", "attempted", "request_count",
                  "http_status", "content_type", "format", "bytes", "width", "height", "local_path", "error_code", "error"]
        if cache_directory is None:  # Legacy exports remain byte/format compatible.
            with (stage / "download-index.csv").open("w", encoding="utf-8-sig", newline="") as file:
                writer = csv.DictWriter(file, fieldnames=fields, extrasaction="ignore")
                writer.writeheader()
                writer.writerows(records)
        stage.rename(output)
        return summary
    except Exception as exc:
        raise media.ManifestError(f"{type(exc).__name__}; diagnostic staging retained at {stage}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--max-bytes", type=int, default=10 * 1024 * 1024)
    args = parser.parse_args(argv)
    try:
        summary = download_batch(args.manifest, args.output, concurrency=args.concurrency,
                                 timeout=args.timeout, max_bytes=args.max_bytes)
    except (media.ManifestError, OSError) as exc:
        print(json.dumps({"status": "invalid", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, allow_nan=False))
    return 0 if summary["preparation_status"] == "ready" else 2


if __name__ == "__main__":
    raise SystemExit(main())
