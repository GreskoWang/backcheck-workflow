#!/usr/bin/env python3
"""Offline, source-mapped contact sheets and metadata-indexed videoshot frames.

Adapted from the handoff's image_sheet.py, cover_wall.py, avatar_compare.py and
videoshot_grid.py: keep grid batching and aspect-preserving thumbnails; replace
downloads, silent skips, stretched images and brightness filtering with a local
manifest, bounded pages, explicit errors and metadata timestamp mapping.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
import sys
import tempfile
import warnings

from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError

SCHEMA_VERSION = 1
MAX_INPUT_PIXELS = 40_000_000
MAX_ITEMS = 10_000
IMAGE_ERRORS = (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombWarning, Image.DecompressionBombError)
MAPPING_FIELDS = ("source_id", "post_source_id", "account", "post_url", "date")
MEDIA_STATE_FIELDS = ("candidate", "attribution_verified", "review_state", "review_status", "reviewed",
                      "visual_reviewed", "audio_reviewed", "subtitles_reviewed", "motion_reviewed", "comments_reviewed")
REVIEW_STATES = {"not_reviewed", "unreviewed", "pending", "needs_review", "reviewed", "partially_reviewed", "incomplete"}
UNREVIEWED = {
    "review_status": "not_reviewed",
    "coverage_complete": False,
    "scope": "local_media_preparation_only",
    "limitations": [
        "Contact sheets prepare batch reading; successful generation does not record human or model review.",
        "Thumbnails can hide small text and details; inspect originals where needed.",
        "Video frames are metadata-indexed samples and do not replace motion, audio, subtitles or comments.",
    ],
}


class ManifestError(ValueError):
    pass


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def local_path(value: object, base: Path) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError("local path must be a non-empty string")
    if "://" in value or value.startswith(("\\\\", "//")):
        raise ManifestError("only local filesystem paths are accepted; no URLs or UNC paths")
    path = Path(value).expanduser()
    path = path if path.is_absolute() else base / path
    resolved = path.resolve()
    if str(resolved).startswith(("\\\\", "//")):
        raise ManifestError("network filesystem paths are not accepted")
    return resolved


def load_manifest(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ManifestError(f"cannot read UTF-8 JSON manifest: {exc}") from exc
    if not isinstance(data, dict) or data.get("schema_version") != SCHEMA_VERSION:
        raise ManifestError("manifest must be an object with schema_version: 1")
    items = data.get("items")
    if not isinstance(items, list) or not items:
        raise ManifestError("items must be a non-empty array")
    if len(items) > MAX_ITEMS:
        raise ManifestError(f"items exceeds {MAX_ITEMS}; split the manifest without dropping items")
    ids = set()
    for index, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise ManifestError(f"item {index} must be an object")
        for name in ("source_id", "account", "post_url", "date"):
            if not isinstance(item.get(name), str) or not item[name].strip():
                raise ManifestError(f"item {index}: {name} must be a non-empty string")
        if "post_source_id" in item and (not isinstance(item["post_source_id"], str) or not item["post_source_id"].strip()):
            raise ManifestError(f"item {index}: post_source_id must be a non-empty string")
        if item["source_id"] in ids:
            raise ManifestError(f"duplicate media source_id: {item['source_id']}")
        ids.add(item["source_id"])
        for name in ("label", "media_kind"):
            if name in item and not isinstance(item[name], str):
                raise ManifestError(f"item {index}: {name} must be a string")
    return data


def media_state(item: dict) -> dict:
    """Carry source status without upgrading missing/invalid attribution or review flags."""
    verified = item.get("attribution_verified") is True
    candidate = item.get("candidate") if type(item.get("candidate")) is bool else not verified
    state = {"candidate": candidate, "attribution_verified": verified}
    for key in ("review_state", "review_status"):
        value = item.get(key)
        state[key] = value if isinstance(value, str) and value in REVIEW_STATES else "not_reviewed"
    for key in MEDIA_STATE_FIELDS[4:]:
        if key in item:
            state[key] = item[key] is True
    return state


def mapped_item(item: dict) -> dict:
    return {**{name: item.get(name) for name in MAPPING_FIELDS}, "label": item.get("label", ""),
            "media_kind": item.get("media_kind", "image"), **media_state(item)}


def readable_image(path: Path, *, transpose: bool = True) -> tuple[Image.Image, dict]:
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(path) as opened:
            if opened.width * opened.height > MAX_INPUT_PIXELS:
                raise ValueError(f"input exceeds {MAX_INPUT_PIXELS} pixels; provide a reviewed smaller copy")
            opened.load()
            details = {"original_width": opened.width, "original_height": opened.height,
                       "animated_frames": getattr(opened, "n_frames", 1), "input_format": opened.format}
            image = ImageOps.exif_transpose(opened) if transpose else opened.copy()
            # Alpha is composited over white rather than appearing black after RGB conversion.
            if image.mode in ("RGBA", "LA") or "transparency" in image.info:
                rgba = image.convert("RGBA")
                converted = Image.new("RGBA", rgba.size, "white")
                converted.alpha_composite(rgba)
                image = converted.convert("RGB")
            else:
                image = image.convert("RGB")
            return image, details


def failure(entry: dict, code: str, exc: object) -> dict:
    entry.update(status="failed", error_code=code, error=str(exc), prepared_file=None)
    return entry


def prepare_images(items: list[dict], base: Path) -> list[dict]:
    entries = []
    for sequence, item in enumerate(items, 1):
        entry = {**mapped_item(item), "sequence": sequence, "input_path": item.get("local_path")}
        try:
            path = local_path(item.get("local_path"), base)
            image, details = readable_image(path)
            image.close()
            entry.update(details, status="prepared", prepared_file=None, resolved_input_path=str(path))
        except IMAGE_ERRORS as exc:
            failure(entry, "image_unavailable", exc)
        entries.append(entry)
    return entries


def metadata_for(item: dict, base: Path) -> dict:
    if ("metadata" in item) == ("metadata_path" in item):
        raise ManifestError("provide exactly one of metadata or metadata_path")
    data = item.get("metadata")
    if "metadata_path" in item:
        data = json.loads(local_path(item["metadata_path"], base).read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ManifestError("metadata must be an object")
    if "data" in data:
        if data.get("code", 0) != 0:
            raise ManifestError(f"videoshot response error code: {data.get('code')}")
        data = data["data"]
    if not isinstance(data, dict):
        raise ManifestError("videoshot data must be an object")
    if "image" in data and (not isinstance(data["image"], list) or not all(isinstance(value, str) for value in data["image"])):
        raise ManifestError("metadata.image must be an array of sprite URL strings; URLs are retained as metadata only")
    for key in ("img_x_len", "img_y_len", "img_x_size", "img_y_size"):
        value = data.get(key)
        if type(value) is not int or not 1 <= value <= 8192:
            raise ManifestError(f"invalid positive integer {key}")
    timestamps = data.get("index")
    if not isinstance(timestamps, list) or not timestamps or len(timestamps) > MAX_ITEMS:
        raise ManifestError(f"metadata.index must have 1..{MAX_ITEMS} explicit timestamps")
    previous = -1
    for timestamp in timestamps:
        if type(timestamp) not in (int, float) or not math.isfinite(timestamp) or timestamp < 0 or timestamp < previous:
            raise ManifestError("metadata.index timestamps must be finite, non-negative and non-decreasing seconds")
        previous = timestamp
    return data


def prepare_videoshots(items: list[dict], base: Path, output: Path) -> tuple[list[dict], list[dict]]:
    frames = output / "frames"
    frames.mkdir()
    entries, videos = [], []
    for item_number, item in enumerate(items, 1):
        video = {**mapped_item(item), "media_kind": "video_sample", "sampling": "metadata.index_seconds"}
        for key in ("audio_reviewed", "subtitles_reviewed", "motion_reviewed"):
            video.setdefault(key, False)
        try:
            data = metadata_for(item, base)
            paths = item.get("sprite_paths")
            if not isinstance(paths, list) or not paths:
                raise ManifestError("sprite_paths must be a non-empty array in metadata.image order")
            cols, rows = data["img_x_len"], data["img_y_len"]
            width, height = data["img_x_size"], data["img_y_size"]
            capacity = cols * rows
            video.update(expected_frame_count=len(data["index"]), supplied_sprite_count=len(paths),
                         metadata_sprite_count=len(data.get("image", [])),
                         unused_supplied_cell_count=max(0, len(paths) * capacity - len(data["index"])))
        except (OSError, ValueError, UnicodeError, json.JSONDecodeError) as exc:
            video.update(status="failed", error_code="metadata_invalid", error=str(exc))
            videos.append(video)
            entries.append(failure({**mapped_item(item), "sequence": len(entries) + 1,
                                    "video_source_id": item["source_id"], "frame_timestamp": None,
                                    "frame_timestamp_unit": "seconds", "metadata_index": None}, "metadata_invalid", exc))
            continue
        if len(entries) + len(data["index"]) > MAX_ITEMS:
            raise ManifestError(f"expanded frames exceeds {MAX_ITEMS}; split manifests without dropping frames")
        prior_sprite_index, sprite, sprite_error, sprite_path = None, None, None, None
        prepared = 0
        for frame_index, timestamp in enumerate(data["index"]):
            sprite_index, cell = divmod(frame_index, capacity)
            row, col = divmod(cell, cols)
            entry = {**mapped_item(item), "source_id": f"{item['source_id']}::frame:{frame_index:06d}",
                     "video_source_id": item["source_id"], "sequence": len(entries) + 1,
                     "media_kind": "video_sample", "metadata_index": frame_index,
                     "metadata_timestamp": timestamp, "frame_timestamp": timestamp,
                     "frame_timestamp_unit": "seconds", "sprite_index": sprite_index,
                     "sprite_row": row, "sprite_column": col,
                     "crop_box": [col * width, row * height, (col + 1) * width, (row + 1) * height]}
            if prior_sprite_index != sprite_index:
                if sprite is not None:
                    sprite.close()
                sprite, sprite_error, sprite_path = None, None, None
                try:
                    if sprite_index >= len(paths):
                        raise ManifestError(f"missing sprite at index {sprite_index}")
                    sprite_path = local_path(paths[sprite_index], base)
                    sprite, _ = readable_image(sprite_path, transpose=False)
                except IMAGE_ERRORS as exc:
                    sprite_error = str(exc)
                prior_sprite_index = sprite_index
            entry["input_path"] = str(sprite_path) if sprite_path else None
            if sprite_error:
                failure(entry, "sprite_unavailable", sprite_error)
            elif entry["crop_box"][2] > sprite.width or entry["crop_box"][3] > sprite.height:
                failure(entry, "sprite_bounds_error", f"crop exceeds sprite {sprite.width}x{sprite.height}")
            else:
                file = f"frames/video_{item_number:04d}_frame_{frame_index:06d}.png"
                frame = sprite.crop(tuple(entry["crop_box"]))
                # Dark frames can be meaningful; preserve every timestamped frame.
                entry.update(status="prepared", prepared_file=file, original_width=frame.width,
                             original_height=frame.height, black_frame_kept=max(frame.convert("L").getextrema()) <= 30)
                frame.save(output / file)
                frame.close()
                prepared += 1
            entries.append(entry)
        if sprite is not None:
            sprite.close()
        video.update(status="prepared" if prepared == len(data["index"]) else "partial",
                     prepared_frame_count=prepared, failed_frame_count=len(data["index"]) - prepared)
        videos.append(video)
    return entries, videos


def get_font(requested: str | None, size: int) -> tuple[ImageFont.ImageFont, str]:
    candidates = [requested] if requested else ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf", "DejaVuSans.ttf"]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size), str(candidate)
        except (OSError, ValueError):
            pass
    if requested:
        raise ManifestError(f"cannot load requested font: {requested}")
    return ImageFont.load_default(size=size), "Pillow default (CJK glyphs may be unavailable)"


def clipped_lines(text: str, font: ImageFont.ImageFont, width: int, max_lines: int) -> tuple[list[str], bool]:
    text = text.replace("\r", " ").replace("\n", " ")
    lines, line = [], ""
    for char_index, char in enumerate(text):
        if font.getlength(line + char) <= width or not line:
            line += char
        else:
            lines.append(line)
            line = char
            if len(lines) == max_lines:
                final = lines[-1]
                while final and font.getlength(final + "…") > width:
                    final = final[:-1]
                lines[-1] = final + "…"
                return lines, True
    if line:
        lines.append(line)
    return lines, False


def render_sheets(entries: list[dict], output: Path, args: argparse.Namespace) -> dict:
    font, font_name = get_font(args.font, args.font_size)
    per_page = args.cols * args.rows
    caption_height = args.font_size * 4 + 12
    pages = []
    for offset in range(0, len(entries), per_page):
        batch = entries[offset:offset + per_page]
        page_number = offset // per_page + 1
        actual_rows = math.ceil(len(batch) / args.cols)
        sheet = Image.new("RGB", (args.cols * args.cell_width, actual_rows * (args.cell_height + caption_height)), "white")
        draw = ImageDraw.Draw(sheet)
        for cell, entry in enumerate(batch):
            x = (cell % args.cols) * args.cell_width
            y = (cell // args.cols) * (args.cell_height + caption_height)
            draw.rectangle((x, y, x + args.cell_width - 1, y + args.cell_height - 1), fill="#f0f0f0", outline="#aaaaaa")
            entry.update(sheet=f"sheet_{page_number:04d}.jpg", page=page_number, cell=cell + 1,
                         cell_row=cell // args.cols, cell_column=cell % args.cols,
                         image_box=[x, y, x + args.cell_width, y + args.cell_height])
            if entry["status"] == "prepared":
                try:
                    path = output / entry["prepared_file"] if entry["prepared_file"] else Path(entry["resolved_input_path"])
                    image, _ = readable_image(path)
                    image.thumbnail((args.cell_width - 8, args.cell_height - 8), Image.Resampling.LANCZOS)
                    left = x + (args.cell_width - image.width) // 2
                    top = y + (args.cell_height - image.height) // 2
                    sheet.paste(image, (left, top))
                    entry.update(display_width=image.width, display_height=image.height,
                                 thumbnail_scale=min(1, (args.cell_width - 8) / entry["original_width"],
                                                     (args.cell_height - 8) / entry["original_height"]))
                    image.close()
                except IMAGE_ERRORS as exc:
                    failure(entry, "image_changed_before_render", exc)
            if entry["status"] == "failed":
                draw.text((x + 8, y + 8), f"FAILED #{entry['sequence']}\n{entry['error_code']}", fill="#bb0000", font=font)
            timestamp = entry.get("frame_timestamp")
            identity = entry.get("video_source_id", entry["source_id"])
            attribution = "候选/归属待核" if entry.get("candidate") or not entry.get("attribution_verified") else "来源归属已核"
            entry["display_attribution"] = attribution
            captions = [f"#{entry['sequence']} {attribution}", identity, f"{entry['account']} | {entry['date']}",
                        f"t={timestamp}s | index={entry.get('metadata_index')}" if timestamp is not None else entry.get("label", "")]
            lines, truncated = clipped_lines(" | ".join(filter(None, captions)), font, args.cell_width - 8, 4)
            entry["display_label_truncated"] = truncated
            for line_index, line in enumerate(lines):
                draw.text((x + 4, y + args.cell_height + 3 + line_index * args.font_size), line, fill="black", font=font)
        file = f"sheet_{page_number:04d}.jpg"
        sheet.save(output / file, quality=94, subsampling=0)
        pages.append({"file": file, "page": page_number, "width": sheet.width, "height": sheet.height,
                      "item_count": len(batch)})
        sheet.close()
    return {"pages": pages, "font": font_name}


def validate_layout(args: argparse.Namespace) -> None:
    for key in ("cols", "rows", "cell_width", "cell_height", "font_size"):
        if getattr(args, key) <= 0:
            raise ManifestError(f"{key} must be positive")
    if args.cell_width < 192 or args.cell_height < 120 or not 12 <= args.font_size <= 28:
        raise ManifestError("cell minimum is 192x120; font size must be 12..28 for readable labels")
    if args.cols * args.cell_width > 2000 or args.rows * (args.cell_height + args.font_size * 4 + 12) > 2400:
        raise ManifestError("page exceeds 2000x2400; reduce rows/columns or cell size instead of shrinking all media")


def create_batch(manifest_path: Path, output: Path, args: argparse.Namespace) -> dict:
    validate_layout(args)
    manifest_path = local_path(str(manifest_path), Path.cwd())
    output = local_path(str(output), Path.cwd())
    if output.exists():
        raise ManifestError("output directory already exists; choose a new directory (nothing is overwritten)")
    manifest = load_manifest(manifest_path)
    if args.font:
        args.font = str(local_path(args.font, Path.cwd()))
    if not output.parent.is_dir():
        raise ManifestError("output parent directory must already exist")
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.pending-", dir=output.parent))
    # Keep incomplete staging output on fatal errors for diagnosis; no user data is deleted.
    try:
        videos = []
        if args.command == "sheet":
            entries = prepare_images(manifest["items"], manifest_path.parent)
        else:
            entries, videos = prepare_videoshots(manifest["items"], manifest_path.parent, staging)
        if len(entries) > MAX_ITEMS:
            raise ManifestError(f"expanded frames exceeds {MAX_ITEMS}; split video manifests")
        layout = render_sheets(entries, staging, args)
        prepared = sum(entry["status"] == "prepared" for entry in entries)
        summary = {"schema_version": SCHEMA_VERSION, "command": args.command, "manifest": str(manifest_path),
                   "input_item_count": len(manifest["items"]), "mapped_item_count": len(entries),
                   "prepared_count": prepared, "failed_count": len(entries) - prepared,
                   "candidate_count": sum(entry["candidate"] for entry in entries),
                   "unverified_attribution_count": sum(not entry["attribution_verified"] for entry in entries),
                   "preparation_status": "ready" if prepared == len(entries) else "partial",
                   "page_count": len(layout["pages"]), **UNREVIEWED}
        index = {"schema_version": SCHEMA_VERSION, **UNREVIEWED, **layout, "items": entries, "videos": videos}
        write_json(staging / "index.json", index)
        write_json(staging / "summary.json", summary)
        fields = ["sequence", *MAPPING_FIELDS, *MEDIA_STATE_FIELDS, "video_source_id", "media_kind", "status", "page", "cell", "sheet",
                  "input_path", "prepared_file", "frame_timestamp", "frame_timestamp_unit", "metadata_index",
                  "metadata_timestamp", "sprite_index", "sprite_row", "sprite_column", "error_code", "error"]
        with (staging / "index.csv").open("w", encoding="utf-8-sig", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(entries)
        # rename fails if another process has claimed the destination; never replace it.
        staging.rename(output)
        return summary
    except Exception as exc:
        raise ManifestError(f"{exc}; diagnostic staging retained at {staging}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("sheet", "videoshot"))
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--cols", type=int, default=4)
    parser.add_argument("--rows", type=int, default=4)
    parser.add_argument("--cell-width", type=int, default=360)
    parser.add_argument("--cell-height", type=int, default=260)
    parser.add_argument("--font-size", type=int, default=16)
    parser.add_argument("--font")
    args = parser.parse_args(argv)
    try:
        summary = create_batch(args.manifest, args.output, args)
    except (ManifestError, OSError) as exc:
        print(json.dumps({"status": "invalid", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, allow_nan=False))
    return 0 if summary["failed_count"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
