"""轻量批量采集/阅读覆盖校验；只检查记录的一致性，不代替语义审阅。

标准库，无网络、浏览器或飞书依赖。普通旧报告无需迁移；用于新 research-batch
路线。采集任务结束、采集完成、文本读完、媒体查完与风险结论是不同状态。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


CONCLUSIONS = {"no_related_results", "checked_no_issue", "risk_found", "incomplete"}
BAD_STOPS = {"error", "empty_response", "invalid_response", "http_error", "stall", "limit", "cancelled", "navigation", "timeout"}
GOOD_STOPS = {"visible_endpoint", "explicit_no_more", "public_boundary", "scope_boundary", "no_results"}
TEXT_FIELDS = ("title", "text", "quoted_text")


def text_snapshot_digest(items: list[dict[str, Any]]) -> str:
    """一个任务级正文指纹，防止缓存刷新后把旧阅读确认套在新正文上。"""
    # 无标题旧缓存保持原指纹；真实非空标题独立参与阅读确认，不能遗漏或混进简介。
    rows = [(i.get("source_id"), i.get("text", ""), i.get("quoted_text", ""), i["title"])
            if i.get("title") else
            (i.get("source_id"), i.get("text", ""), i.get("quoted_text", "")) for i in items]
    raw = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def make_text_batches(items: list[dict[str, Any]], max_chars: int = 45000) -> list[dict[str, Any]]:
    """自动分片和字符映射；阅读者只确认批次，无需为每帖手写区间。

    start/end 是 Python Unicode 字符下标、左闭右开。标题、正文与转发原文分别映射；
    大条目会跨批次延续，绝不按固定前 N 字截断。content 含来源/字段/区间头。
    """
    if not isinstance(max_chars, int) or max_chars < 128:
        raise ValueError("max_chars 必须为 >=128 的整数")
    result: list[dict[str, Any]] = []
    parts: list[str] = []
    segments: list[dict[str, Any]] = []
    size = 0

    def flush() -> None:
        nonlocal parts, segments, size
        if segments:
            result.append({"batch_id": f"text-{len(result) + 1:04d}", "reviewed": False,
                           "segments": segments, "content": "".join(parts)})
        parts, segments, size = [], [], 0

    for item in items:
        source_id = item.get("source_id")
        if not isinstance(source_id, str) or not source_id:
            raise ValueError("每个条目需要非空 source_id")
        for field in TEXT_FIELDS:
            value = item.get(field, "")
            if not isinstance(value, str):
                raise ValueError(f"{source_id}.{field} 必须是字符串")
            start = 0
            while start < len(value):
                reserve = len(f"\n[{source_id} {field} {start}:{len(value)}]\n")
                if reserve >= max_chars:
                    raise ValueError("source_id 过长，无法在批次上限内放置来源头")
                capacity = max_chars - size - reserve
                if capacity <= 0:
                    flush()
                    continue
                end = min(len(value), start + capacity)
                header = f"\n[{source_id} {field} {start}:{end}]\n"
                parts.extend((header, value[start:end]))
                segments.append({"source_id": source_id, "field": field, "start": start, "end": end})
                size += len(header) + end - start
                start = end
                if start < len(value):
                    flush()
    flush()
    return result


def create_text_review_manifest(items: list[dict[str, Any]], max_chars: int = 45000) -> dict[str, Any]:
    return {"text_snapshot_digest": text_snapshot_digest(items),
            "text_batches": make_text_batches(items, max_chars),
            "media_reviews": [], "comment_reviews": [], "unread_ranges": []}


def _covers(ranges: list[tuple[int, int]], length: int) -> bool:
    cursor = 0
    for start, end in sorted(ranges):
        if start > cursor:
            return False
        cursor = max(cursor, end)
    return cursor >= length


def validate_batch(data: dict[str, Any], review: dict[str, Any] | None = None) -> dict[str, Any]:
    """返回格式有效性、覆盖完成度和四态结论；不把 lint PASS 推导为完成。"""
    issues: list[dict[str, Any]] = []

    def issue(code: str, message: str, *, structural: bool = False, source_id: str | None = None) -> None:
        row: dict[str, Any] = {"code": code, "message": message, "structural": structural}
        if source_id is not None:
            row["source_id"] = source_id
        issues.append(row)

    if not isinstance(data, dict):
        return {"format_valid": False, "coverage_complete": False, "conclusion": "incomplete",
                "issues": [{"code": "invalid_input", "message": "输入必须是对象", "structural": True}]}
    if type(data.get("schema_version")) is not int or data.get("schema_version") != 1:
        issue("schema_version", "schema_version 必须为 1", structural=True)
    items = data.get("items")
    if not isinstance(items, list):
        issue("items_type", "items 必须是数组", structural=True)
        items = []
    coverage = data.get("coverage")
    if not isinstance(coverage, dict):
        issue("coverage_type", "coverage 必须是对象", structural=True)
        coverage = {}
    scope = data.get("scope", {})
    if not isinstance(scope, dict):
        issue("scope_type", "scope 必须是对象", structural=True)
        scope = {}
    raw_review = review if review is not None else data.get("review", {})
    if not isinstance(raw_review, dict):
        issue("review_type", "review 必须是对象", structural=True)
        raw_review = {}
    review = raw_review
    by_id: dict[str, dict[str, Any]] = {}
    for pos, item in enumerate(items):
        if not isinstance(item, dict):
            issue("item_type", f"items[{pos}] 必须是对象", structural=True)
            continue
        sid = item.get("source_id")
        if not isinstance(sid, str) or not sid:
            issue("source_id", f"items[{pos}] 缺少 source_id", structural=True)
            continue
        if sid in by_id:
            issue("duplicate_source_id", f"source_id 重复：{sid}", structural=True, source_id=sid)
        by_id[sid] = item
        for field in TEXT_FIELDS:
            if field == "text" and field not in item:
                issue("text_missing", "缺少 text（纯图片帖可为空字符串）", structural=True, source_id=sid)
            elif field in item and not isinstance(item[field], str):
                issue("text_type", f"{field} 必须是字符串", structural=True, source_id=sid)
        if not isinstance(item.get("text_truncated"), bool):
            issue("truncation_unknown", "必须明确 text_truncated，不能把未知当全文", structural=True, source_id=sid)
        if item.get("text_truncated") or item.get("needs_expansion"):
            issue("text_incomplete", "正文被截断或仍需展开", source_id=sid)
        if not isinstance(item.get("media", []), list):
            issue("media_type", "media 必须是数组", structural=True, source_id=sid)
        elif "media_count" in item and (type(item["media_count"]) is not int or item["media_count"] < 0):
            issue("media_count_type", "media_count 必须为非负整数", structural=True, source_id=sid)
        elif isinstance(item.get("media_count"), int) and item["media_count"] > len(item.get("media", [])):
            issue("missing_media", "页面媒体数大于取得的媒体数", source_id=sid)
        if item.get("media_extraction_complete") is False:
            issue("media_extraction_incomplete", "媒体提取尚未完成", source_id=sid)

    if coverage.get("collection_complete") is not True:
        issue("collection_incomplete", "采集尚未完成")
    if coverage.get("visible_endpoint_verified") is not True:
        issue("endpoint_unverified", "未验证范围内可见终点")
    stop_reason = coverage.get("stop_reason")
    if not isinstance(stop_reason, str) or stop_reason not in GOOD_STOPS:
        issue("invalid_endpoint", f"停止原因 {stop_reason!r} 不能证明采集完成")
    if (isinstance(stop_reason, str) and stop_reason in BAD_STOPS) or coverage.get("last_response_valid") is False:
        issue("response_not_endpoint", "错误或空响应不能作为终点")
    if coverage.get("unresolved"):
        issue("collection_unresolved", "仍有未解决的采集范围", source_id=None)
    if type(coverage.get("observed_count")) is not int or coverage.get("observed_count") != len(by_id):
        issue("observed_count_mismatch", "observed_count 与去重后条目数不一致", structural=True)
    displayed = coverage.get("displayed_count")
    if displayed is not None and (type(displayed) is not int or displayed < 0):
        issue("displayed_count_type", "displayed_count 必须为空或非负整数", structural=True)
    if isinstance(displayed, int) and not isinstance(displayed, bool) and displayed > len(by_id):
        boundary = scope.get("public_boundary", {})
        boundary_ok = (coverage.get("displayed_count_enumerable") is False and
                       isinstance(boundary, dict) and boundary.get("verified") is True and
                       isinstance(boundary.get("reason"), str) and bool(boundary["reason"].strip()) and
                       isinstance(stop_reason, str) and stop_reason in GOOD_STOPS and stop_reason != "no_results")
        if not boundary_ok:
            issue("displayed_count_gap", f"取得 {len(by_id)} 条，页面显示 {displayed} 条；差异尚无已验证公开边界说明")
    if stop_reason == "public_boundary":
        boundary = scope.get("public_boundary", {})
        if not isinstance(boundary, dict) or boundary.get("verified") is not True or not boundary.get("reason"):
            issue("public_boundary_unverified", "公开边界必须有核实依据和未取得范围说明")
    if stop_reason == "scope_boundary":
        boundary = scope.get("boundary", {})
        if not isinstance(boundary, dict) or boundary.get("verified") is not True or not boundary.get("reason"):
            issue("scope_boundary_unverified", "范围边界必须说明用户规定的日期或内容范围及到达依据")

    batches = review.get("text_batches", [])
    if not isinstance(batches, list):
        issue("text_batches_type", "text_batches 必须是数组", structural=True)
        batches = []
    read_ranges: dict[tuple[str, str], list[tuple[int, int]]] = {}
    reviewed_batches = 0
    batch_ids: set[str] = set()
    for batch in batches:
        if not isinstance(batch, dict):
            issue("text_batch_type", "阅读批次必须是对象", structural=True)
            continue
        bid = batch.get("batch_id")
        if not isinstance(bid, str) or not bid or bid in batch_ids:
            issue("text_batch_id", "batch_id 必须非空且唯一", structural=True)
        else:
            batch_ids.add(bid)
        segments = batch.get("segments")
        if not isinstance(segments, list):
            issue("segments_type", "segments 必须是数组", structural=True)
            continue
        accepted = batch.get("reviewed") is True
        if accepted:
            reviewer = batch.get("reviewer", review.get("reviewer"))
            if not isinstance(reviewer, str) or not reviewer.strip() or reviewer.strip().casefold() in {"collector", "automatic", "auto"}:
                issue("reviewer_missing", f"{bid} 缺少实际阅读者确认；采集器不能确认已读")
                accepted = False
            if batch.get("output_truncated") is True:
                issue("reading_output_truncated", f"{bid} 阅读输出被截断")
                accepted = False
        if accepted:
            reviewed_batches += 1
        for seg in segments:
            if not isinstance(seg, dict):
                issue("segment_type", "阅读区间必须是对象", structural=True)
                continue
            sid, field = seg.get("source_id"), seg.get("field")
            start, end = seg.get("start"), seg.get("end")
            value = by_id.get(sid, {}).get(field, "") if isinstance(sid, str) and isinstance(field, str) else ""
            valid = (isinstance(sid, str) and sid in by_id and field in TEXT_FIELDS and isinstance(value, str) and
                     type(start) is int and type(end) is int and 0 <= start < end <= len(value))
            if not valid:
                issue("invalid_read_range", f"{bid} 有越界或无来源的阅读区间", structural=True)
            elif accepted:
                read_ranges.setdefault((sid, field), []).append((start, end))
    clean_items = [i for i in items if isinstance(i, dict)]
    if reviewed_batches and review.get("text_snapshot_digest") != text_snapshot_digest(clean_items):
        issue("stale_reading_confirmation", "阅读确认不对应当前整批正文缓存")
    for sid, item in by_id.items():
        for field in TEXT_FIELDS:
            value = item.get(field, "")
            if isinstance(value, str) and value and not _covers(read_ranges.get((sid, field), []), len(value)):
                issue("unread_text", f"{field} 未被实际确认的完整阅读批次连续覆盖", source_id=sid)
    if review.get("unread_ranges"):
        issue("explicit_unread_ranges", "阅读者仍记录了明确未读范围")

    media_reviews = review.get("media_reviews", [])
    if not isinstance(media_reviews, list):
        issue("media_reviews_type", "media_reviews 必须是数组", structural=True)
        media_reviews = []
    selected = scope.get("selected_media", [])
    if not isinstance(selected, list):
        issue("selected_media_type", "selected_media 必须是数组", structural=True)
        selected = []
    requested: dict[tuple[str, str], set[str]] = {}
    media_keys: set[tuple[str, str]] = set()
    image_requirement = scope.get("images", "overview")
    if not isinstance(image_requirement, str) or image_requirement not in {"overview", "original", "none"}:
        issue("images_scope", "scope.images 必须为 overview/original/none", structural=True)
        image_requirement = "overview"
    for sid, item in by_id.items():
        for media in item.get("media", []) if isinstance(item.get("media", []), list) else []:
            if not isinstance(media, dict):
                issue("media_item_type", "媒体条目必须是对象", structural=True, source_id=sid)
                continue
            mid = media.get("media_id") or media.get("url")
            if not isinstance(mid, str) or not mid:
                issue("media_id", "媒体需要 media_id 或 url", structural=True, source_id=sid)
                continue
            key = (sid, mid)
            media_keys.add(key)
            if not isinstance(media.get("kind"), str) or not media.get("kind"):
                issue("media_kind", "媒体需要 kind，防止未知类型漏过核查", structural=True, source_id=sid)
            if isinstance(media.get("kind"), str) and media.get("kind") in {"image", "photo", "cover", "thumbnail", "video-poster"} and image_requirement != "none":
                requested[key] = {"original" if media.get("needs_original") else image_requirement}
    for req in selected:
        if not isinstance(req, dict):
            issue("selected_media_entry", "重点媒体要求必须是对象", structural=True)
            continue
        key = (req.get("post_source_id"), req.get("media_id") or req.get("url"))
        if not all(isinstance(v, str) and v for v in key):
            issue("selected_media_key", "重点媒体需要字符串 post_source_id 和 media_id/url", structural=True)
            continue
        if key not in media_keys:
            issue("selected_media_missing", "用户范围内的重点媒体尚未取得")
        required = req.get("required", ["visual"])
        if not isinstance(required, list) or not all(isinstance(c, str) and c for c in required):
            issue("media_required_type", "重点媒体 required 必须是能力名数组", structural=True)
        else:
            requested.setdefault(key, set()).update(required)
    seen: dict[tuple[str, str], set[str]] = {}
    for mr in media_reviews:
        if not isinstance(mr, dict):
            issue("media_review_entry", "媒体阅读记录必须是对象", structural=True)
            continue
        key = (mr.get("post_source_id"), mr.get("media_id") or mr.get("url"))
        if not all(isinstance(v, str) and v for v in key):
            issue("media_review_key", "媒体确认需要字符串 post_source_id 和 media_id/url", structural=True)
            continue
        if key not in media_keys:
            issue("media_review_source", "媒体确认没有对应已取得媒体", structural=True)
        reviewed = mr.get("reviewed") is True
        reviewer = mr.get("reviewer", review.get("reviewer"))
        capabilities = mr.get("capabilities", [])
        if not isinstance(capabilities, list) or not all(isinstance(c, str) for c in capabilities):
            issue("media_capabilities_type", "媒体 capabilities 必须是字符串数组", structural=True)
            continue
        if reviewed and isinstance(reviewer, str) and reviewer.strip() and reviewer.strip().casefold() not in {"collector", "automatic", "auto"}:
            caps = set(capabilities)
            if "original" in caps:
                caps.add("overview")
            seen.setdefault(key, set()).update(caps)
    for key, required in requested.items():
        missing = required - seen.get(key, set())
        if missing:
            issue("unread_media", "媒体尚未完成要求的核查：" + ",".join(sorted(missing)), source_id=key[0])
    comment_scope = scope.get("comments", [])
    comment_reviews = review.get("comment_reviews", [])
    if not isinstance(comment_scope, list) or not isinstance(comment_reviews, list):
        issue("comments_type", "comments/comment_reviews 必须是数组", structural=True)
    else:
        for required in comment_scope:
            scope_id = required.get("scope_id") if isinstance(required, dict) else None
            if not isinstance(scope_id, str) or not scope_id:
                issue("comment_scope_id", "评论范围需要 scope_id", structural=True)
                continue
            done = False
            for cr in comment_reviews:
                if not isinstance(cr, dict):
                    continue
                reviewer = cr.get("reviewer", review.get("reviewer"))
                if (cr.get("scope_id") == scope_id and cr.get("reviewed") is True and cr.get("complete") is True and
                    cr.get("boundary_verified") is True and not cr.get("unread_ranges") and
                    isinstance(reviewer, str) and reviewer.strip() and reviewer.strip().casefold() not in {"collector", "automatic", "auto"}):
                    done = True
                    break
            if not done:
                issue("unread_comments", f"指定评论范围 {scope_id} 尚未核查完成")

    conclusion = data.get("conclusion", "incomplete")
    if not isinstance(conclusion, str) or conclusion not in CONCLUSIONS:
        issue("conclusion_invalid", "结论必须保留四态之一", structural=True)
        conclusion = "incomplete"
    if conclusion == "no_related_results":
        no_results = scope.get("search", {})
        if items or stop_reason != "no_results" or not isinstance(no_results, dict) or no_results.get("no_results_verified") is not True or not no_results.get("query"):
            issue("unsupported_no_results", "无相关结果必须基于成功搜索的明确无结果界面，失败/猜测主页HTTP状态不成立")
    format_valid = not any(i["structural"] for i in issues)
    coverage_complete = format_valid and not issues
    if conclusion == "checked_no_issue" and not coverage_complete:
        issue("unsupported_no_issue", "尚未完成覆盖，不能标为已查无问题")
    return {"format_valid": format_valid, "coverage_complete": coverage_complete,
            "conclusion": conclusion, "item_count": len(by_id), "reviewed_text_batches": reviewed_batches,
            "issues": issues,
            "limits": "校验批次映射、状态和确认的一致性；不证明阅读者理解、风险判定正确或平台绝对穷尽。"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--review", type=Path, help="可选独立阅读确认JSON")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--require-complete", action="store_true", help="覆盖未完成也返回1；默认只对格式错误返回1")
    parser.add_argument("--export-text", type=Path, help="导出未确认的阅读批次与自动映射，不设已读")
    parser.add_argument("--max-chars", type=int, default=45000)
    args = parser.parse_args()
    try:
        data = json.loads(args.input.read_text(encoding="utf-8-sig"))
        review = json.loads(args.review.read_text(encoding="utf-8-sig")) if args.review else None
        if args.export_text:
            manifest = create_text_review_manifest(data["items"], args.max_chars)
            args.export_text.mkdir(parents=True, exist_ok=True)
            for batch in manifest["text_batches"]:
                (args.export_text / f"{batch['batch_id']}.txt").write_text(batch.pop("content"), encoding="utf-8")
            (args.export_text / "review.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        result = validate_batch(data, review)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(json.dumps({"format_valid": False, "coverage_complete": False, "error": str(exc)}, ensure_ascii=False))
        return 2
    output = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(output, encoding="utf-8")
    print(output)
    return 0 if result["format_valid"] and (result["coverage_complete"] or not args.require_complete) else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
