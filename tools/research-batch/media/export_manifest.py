#!/usr/bin/env python3
"""Offline export of research-batch result.items[].media into a source-mapped manifest."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

import fetch_assets
import media

IMAGE_KINDS = {"image", "photo", "cover", "thumbnail", "video-poster"}
NON_MEDIA_KINDS = {"avatar", "emoji", "emoticon", "icon", "link"}
GAP_WARNINGS = {"media_placeholder", "unexpanded_gallery"}


def safe_reference(value):
    """Only URL-shaped source references need checking; unsafe URLs become stable IDs."""
    if isinstance(value, str) and "://" in value:
        try:
            fetch_assets.validated_url(value)
        except fetch_assets.AssetError:
            return "restricted-url-sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest(), True
    return value, False


def export_result(result: dict) -> dict:
    if not isinstance(result, dict) or result.get("schema_version") != 1 or not isinstance(result.get("items"), list):
        raise media.ManifestError("result must have schema_version:1 and items array")
    output, filtered, source_gaps = [], [], []
    post_ids = set()
    observed_count = 0
    for post_number, post in enumerate(result["items"], 1):
        if not isinstance(post, dict) or not isinstance(post.get("source_id"), str) or not post["source_id"].strip():
            raise media.ManifestError(f"post {post_number}: non-empty source_id required")
        if post["source_id"] in post_ids:
            raise media.ManifestError(f"post {post_number}: duplicate source_id")
        post_ids.add(post["source_id"])
        safe_post_id, restricted_id = safe_reference(post["source_id"])
        source_metadata = {}
        missing_fields = []
        restricted_fields = []
        display = {}
        for name, unknown in (("account", "未取得账号"), ("post_url", "未取得原帖链接"), ("date", "未取得日期")):
            original = post.get(name)
            checked, restricted = safe_reference(original)
            if restricted:
                source_metadata[name] = None
                source_metadata[name + "_reference"] = checked
                restricted_fields.append(name)
                display[name] = unknown
            elif not isinstance(original, str) or not original.strip():
                source_metadata[name] = None
                missing_fields.append(name)
                display[name] = unknown
            else:
                source_metadata[name] = original
                display[name] = original
        if restricted_id:
            restricted_fields.append("source_id")
        if missing_fields or restricted_fields:
            source_gaps.append({"post_source_id": safe_post_id, "input_post_index": post_number - 1,
                                "missing_fields": missing_fields, "restricted_url_fields": restricted_fields})
        entries = post.get("media", [])
        malformed_media = not isinstance(entries, list)
        entries = entries if isinstance(entries, list) else []
        observed_count += len(entries)
        base = {"post_source_id": safe_post_id, **display, "source_metadata": source_metadata,
                "input_post_index": post_number - 1, "review_status": "not_reviewed"}
        try:
            referer = fetch_assets.validated_url(display["post_url"])
        except fetch_assets.AssetError:
            referer = None

        def append_item(ordinal: int, kind: str, media_id=None, url=None, code=None, label="", state=None):
            if len(output) >= media.MAX_ITEMS:
                raise media.ManifestError(f"export exceeds {media.MAX_ITEMS} items; split source results without dropping media")
            safe_media_id, restricted_media_id = safe_reference(media_id if isinstance(media_id, str) else None)
            entry = {**base, "source_id": f"{safe_post_id}::media:{ordinal:06d}", "source_media_id": safe_media_id,
                     "source_media_id_restricted": restricted_media_id, "input_media_index": ordinal,
                     "media_kind": kind, "url": url, "referer": referer, "label": label,
                     "export_status": "unavailable" if code else "ready", **media.media_state(state or {})}
            if code:
                entry["export_error_code"] = code
            output.append(entry)

        for ordinal, asset in enumerate(entries):
            if not isinstance(asset, dict):
                append_item(ordinal, "missing", code="media_entry_invalid", label="媒体条目格式错误")
                continue
            kind = asset.get("kind")
            if kind == "placeholder":
                append_item(ordinal, "missing", asset.get("media_id"), code="media_placeholder", label="媒体占位尚未加载", state=asset)
                continue
            if not isinstance(kind, str) or kind not in IMAGE_KINDS and kind != "video":
                safe_media_id, _ = safe_reference(asset.get("media_id") if isinstance(asset.get("media_id"), str) else None)
                safe_kind, _ = safe_reference(kind if isinstance(kind, str) else None)
                if isinstance(kind, str) and kind in NON_MEDIA_KINDS and asset.get("candidate") is not True and asset.get("attribution_verified") is not False:
                    filtered.append({"post_source_id": safe_post_id, "input_media_index": ordinal,
                                     "source_media_id": safe_media_id, "kind": safe_kind, "reason": "explicit_non_media_kind"})
                else:
                    append_item(ordinal, safe_kind or "unknown", asset.get("media_id"), code="media_kind_unverified",
                                label="未知媒体候选/待核", state={**asset, "candidate": True, "attribution_verified": False})
                continue
            code, url = None, asset.get("url")
            if kind == "video":
                code, url = "video_requires_playback", None
            elif restricted_fields:
                code, url = "source_url_not_exported", None
            else:
                try:
                    fetch_assets.validated_url(url)
                    if re.search(r"(?:placeholder|transparent|loading|blank)(?:[._/-]|$)", fetch_assets.urllib.parse.urlsplit(url).path, re.I):
                        code, url = "media_url_placeholder", None
                except fetch_assets.AssetError as exc:
                    code, url = ("media_url_missing" if not url else exc.code), None
            label = asset.get("alt") if isinstance(asset.get("alt"), str) else ""
            label, restricted_label = safe_reference(label)
            append_item(ordinal, kind, asset.get("media_id"), url, code,
                        "视频需原播放路线" if kind == "video" else ("媒体待恢复" if code else ("媒体标签已隐藏" if restricted_label else label)), state=asset)
        declared = post.get("media_count")
        missing_count = max(0, declared - len(entries)) if type(declared) is int and declared >= 0 else 0
        known_gap = post.get("media_extraction_complete") is False or malformed_media
        warnings = post.get("warnings", [])
        if isinstance(warnings, list):
            known_gap = known_gap or any(warning in GAP_WARNINGS for warning in warnings if isinstance(warning, str))
        # Runtime warnings can identify a gap without preserving its exact count.
        # One explicitly count-unknown slot represents that unresolved gap, not one invented image.
        if known_gap and not missing_count:
            missing_count = 1
            gap_code = "media_gap_count_unknown"
        else:
            gap_code = "media_missing_from_declared_count"
        for gap in range(missing_count):
            append_item(len(entries) + gap, "missing", code=gap_code,
                        label="媒体缺口（数量未知）" if gap_code == "media_gap_count_unknown" else "页面声明媒体尚未取得")
    failed = sum(item["export_status"] == "unavailable" for item in output)
    report = {"input_post_count": len(result["items"]), "observed_media_entry_count": observed_count,
              "exported_item_count": len(output), "ready_image_count": len(output) - failed,
              "failed_placeholder_count": failed, "video_placeholder_count": sum(item["media_kind"] == "video" for item in output),
              "candidate_count": sum(item["candidate"] for item in output),
              "unverified_attribution_count": sum(not item["attribution_verified"] for item in output),
              "filtered_count": len(filtered), "filtered": filtered, "source_metadata_gaps": source_gaps,
              "empty_media_manifest": not output,
              "preparation_action": "skip_fetch_and_sheet" if not output else ("fetch_and_sheet" if len(output) > failed else "preserve_failure_slots"),
              "signature_urls_rewritten": False}
    return {"schema_version": 1, "items": output, "export_report": report, **media.UNREVIEWED}


def export_file(source: Path, destination: Path) -> dict:
    source = media.local_path(str(source), Path.cwd())
    destination = media.local_path(str(destination), Path.cwd())
    if destination.exists():
        raise media.ManifestError("output manifest already exists; nothing is overwritten")
    if not destination.parent.is_dir():
        raise media.ManifestError("output parent directory must already exist")
    try:
        result = json.loads(source.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise media.ManifestError("cannot read UTF-8 result JSON") from exc
    manifest = export_result(result)
    # Exclusive create preserves both the source cache and any existing destination.
    with destination.open("x", encoding="utf-8") as file:
        json.dump(manifest, file, ensure_ascii=False, indent=2, allow_nan=False)
        file.write("\n")
    return manifest["export_report"]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args(argv)
    try:
        report = export_file(args.result, args.manifest)
    except (media.ManifestError, OSError, ValueError) as exc:
        # Errors contain safe indexes/codes, never an input URL or the original JSON.
        print(json.dumps({"status": "invalid", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({key: value for key, value in report.items() if key not in ("filtered", "source_metadata_gaps")}, ensure_ascii=False))
    return 2 if report["failed_placeholder_count"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
