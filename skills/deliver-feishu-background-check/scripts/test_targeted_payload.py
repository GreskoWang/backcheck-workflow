from __future__ import annotations

import base64
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote, quote_plus

sys.path.insert(0, str(Path(__file__).resolve().parent))

import validate_research_payload as validator
import validate_feishu_document as feishu_validator
import validate_targeted_payload as targeted_validator
from review_proofs import validate_targeted_item_review
from validate_targeted_payload import QA_FLAGS, TARGET_SCOPE


MAIN_QUERY = "测试对象"
MAIN_QUERY_URL = quote_plus(MAIN_QUERY)
MAIN_QUERY_PATH = quote(MAIN_QUERY, safe="")
COMBINED_QUERY = "测试对象 需评估 内容"
COMBINED_QUERY_URL = quote_plus(COMBINED_QUERY)

PLATFORM_URLS = {
    "weibo": (f"https://s.weibo.com/weibo?q={MAIN_QUERY_URL}", f"https://s.weibo.com/weibo?q={MAIN_QUERY_URL}"),
    "bilibili": (f"https://search.bilibili.com/all?keyword={MAIN_QUERY_URL}", f"https://search.bilibili.com/all?keyword={MAIN_QUERY_URL}"),
    "douyin": (f"https://www.douyin.com/search/{MAIN_QUERY_PATH}", f"https://www.douyin.com/search/{MAIN_QUERY_PATH}"),
    "xiaohongshu": (f"https://www.xiaohongshu.com/search_result?keyword={MAIN_QUERY_URL}", f"https://www.xiaohongshu.com/search_result?keyword={MAIN_QUERY_URL}"),
    "zhihu": (f"https://www.zhihu.com/search?q={MAIN_QUERY_URL}", f"https://www.zhihu.com/search?q={MAIN_QUERY_URL}"),
    "netease_music": (f"https://music.163.com/#/search/m/?s={MAIN_QUERY_URL}", f"https://music.163.com/#/search/m/?s={MAIN_QUERY_URL}"),
    "tieba": (f"https://tieba.baidu.com/f/search/res?ie=utf-8&qw={MAIN_QUERY_URL}", f"https://tieba.baidu.com/f/search/res?ie=utf-8&qw={MAIN_QUERY_URL}"),
    "douban": (f"https://www.douban.com/search?q={MAIN_QUERY_URL}", f"https://www.douban.com/search?q={MAIN_QUERY_URL}"),
    "domestic_other": (f"https://www.baidu.com/s?wd={MAIN_QUERY_URL}", f"https://www.baidu.com/s?wd={COMBINED_QUERY_URL}"),
    "x": (f"https://x.com/search?q={MAIN_QUERY_URL}", f"https://x.com/search?q={MAIN_QUERY_URL}"),
    "facebook": (f"https://www.facebook.com/search/top?q={MAIN_QUERY_URL}", f"https://www.facebook.com/search/top?q={MAIN_QUERY_URL}"),
    "instagram": (f"https://www.instagram.com/explore/search/keyword/?q={MAIN_QUERY_URL}", f"https://www.instagram.com/explore/search/keyword/?q={MAIN_QUERY_URL}"),
    "youtube": (f"https://www.youtube.com/results?search_query={MAIN_QUERY_URL}", f"https://www.youtube.com/results?search_query={MAIN_QUERY_URL}"),
    "overseas_other": (f"https://www.google.com/search?q={MAIN_QUERY_URL}", f"https://www.google.com/search?q={COMBINED_QUERY_URL}"),
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def empty_homepage(account: bool = True) -> dict:
    value = {"status": "not_found", "urls": [], "url_risk_group_ids": {}, "risk_group_ids": []}
    if account:
        value["url_identity_statuses"] = {}
    return value


def route(
    root: Path,
    platform_key: str,
    module_key: str,
    index: int,
    *,
    rule: str = "platform_first_3_pages_or_30_results",
    query_url: str | None = None,
    pages: int = 1,
    rows: list[dict] | None = None,
) -> dict:
    rows = rows or []
    path_value = None
    hash_value = None
    if rows:
        path = root / f"{platform_key}-{module_key}-{index}-flagged.jsonl"
        path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        path_value = str(path)
        hash_value = digest(path)
    stop_reason = {
        "main_name_first_10_pages": "page_limit" if pages == 10 else "results_exhausted_early",
        "combined_high_risk_first_3_pages": "page_limit" if pages == 3 else "results_exhausted_early",
        "homepage_pinned_all_latest20_popular10_historical1_applicable_tabs": "scope_sample_complete",
        "homepage_all_public_text_to_natural_end": "natural_end",
        "topic_related_first_30_items": "results_exhausted_early",
        "user_risk_lead_targeted": "target_resolved",
        "identity_resolution_targeted": "target_resolved",
        "risk_context_followup": "target_resolved",
    }.get(rule, "page_limit" if pages == 3 else "results_exhausted_early")
    if rule == "combined_high_risk_first_3_pages":
        query_kind, query_text, query_group, query_terms = "combined_high_risk", COMBINED_QUERY, "需评估内容", ["需评估", "内容"]
    elif rule in {"platform_first_3_pages_or_30_results", "main_name_first_10_pages"}:
        query_kind, query_text, query_group, query_terms = "main_name", "测试对象", "", []
    elif rule in {
        "homepage_pinned_all_latest20_popular10_historical1_applicable_tabs",
        "homepage_all_public_text_to_natural_end",
        "topic_related_first_30_items",
    }:
        query_kind, query_text, query_group, query_terms = "non_query", "", "", []
    else:
        query_kind, query_text, query_group, query_terms = (
            "targeted_followup", "", "", [],
        )
    page_suffix = hashlib.sha256(
        f"{platform_key}:{module_key}:{index}".encode("utf-8")
    ).hexdigest()[:12]
    return {
        "route_id": f"{platform_key}-{module_key}-{index}",
        "module_key": module_key,
        "surface": "targeted_review",
        "account_or_query_url": query_url or PLATFORM_URLS[platform_key][0],
        "resolved_url": query_url or PLATFORM_URLS[platform_key][0],
        "tool_kind": "browser_ui",
        "tool_name": "Microsoft Edge",
        "browser_family": "microsoft_edge",
        "executor_id": "self-test-reviewer",
        "edge_window_continuity_id": "00000000-0000-4000-8000-000000000001",
        "edge_page_continuity_id": f"00000000-0000-4000-8000-{page_suffix}",
        "status": "targeted_complete",
        "termination": "target_scope_complete",
        "selection_rule": rule,
        "pages_checked": pages,
        "items_selected": len(rows),
        "items_reviewed": len(rows),
        "flagged_items": len(rows),
        "scope_stop_reason": stop_reason,
        "minimum_scope_met": True,
        "query_kind": query_kind,
        "query_text": query_text,
        "query_risk_group": query_group,
        "query_terms": query_terms,
        "started_at": "2026-09-09T09:00:00+08:00",
        "completed_at": "2026-09-09T09:05:00+08:00",
        "flagged_item_ledger_path": path_value,
        "flagged_item_ledger_sha256": hash_value,
        "resolved_by_route_ids": [],
        "boundary": "",
    }


def fixture(root: Path) -> dict:
    risk_url = "https://www.youtube.com/watch?v=abc123xyz00"
    screenshot = root / "risk.png"
    screenshot.write_bytes(base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    ))
    flagged_video = {
        "platform_key": "youtube",
        "item_id": "abc123xyz00",
        "url": risk_url,
        "content_type": "video",
        "title": "需复核的视频",
        "text": "简介中出现了需核查的具体风险线索。",
        "media_kinds": ["video"],
        "review_status": "reviewed",
        "risk_decision": "risk",
        "risk_group_id": "risk-001",
        "review_reason": "逐十秒检查完整时间线，并回看命中位置附近语义段后确认。",
        "selection_basis": ["search_scope", "user_risk_lead", "risk_hit"],
        "attribution": "subject_original",
        "video_review": {
            "mode": "targeted_10s_timeline",
            "title_reviewed": True,
            "cover_reviewed": True,
            "description_reviewed": True,
            "rapid_scrub_reviewed": True,
            "full_timeline_reviewed": True,
            "max_interval_seconds": 10,
            "semantic_segment_reviewed": True,
            "full_audio_reviewed": False,
            "hit_timestamps_seconds": [20],
        },
    }
    platforms: dict[str, dict] = {}
    inventory = {"https://www.wikidata.org/wiki/Q42", risk_url}
    youtube_route_id = ""
    for key in validator.PLATFORMS:
        modules: dict[str, object] = {}
        routes: list[dict] = []
        for module_key in validator.DELIVERY_MODULES[key]:
            if module_key == "review_start_month":
                modules[module_key] = None
                continue
            if module_key in {"homepage", "subject_homepage"}:
                modules[module_key] = empty_homepage(True)
                continue
            elif module_key in {"topic", "topic_homepage"}:
                modules[module_key] = empty_homepage(False)
                continue
            else:
                module_url = PLATFORM_URLS[key][0]
                modules[module_key] = {
                    "url": module_url,
                    "result_status": "risk" if key == "youtube" else "no_related_content",
                    "risk_group_ids": ["risk-001"] if key == "youtube" else [],
                }
                inventory.add(module_url)
            if module_key in {"baidu_search", "google_search"}:
                first = route(root, key, module_key, len(routes), rule="main_name_first_10_pages", query_url=PLATFORM_URLS[key][0], pages=10)
                second = route(root, key, module_key, len(routes) + 1, rule="combined_high_risk_first_3_pages", query_url=PLATFORM_URLS[key][1], pages=3)
                routes.extend([first, second])
                inventory.update(PLATFORM_URLS[key])
            else:
                current = route(root, key, module_key, len(routes))
                routes.append(current)
                inventory.add(current["account_or_query_url"])
                if key == "youtube" and module_key == "keyword_search":
                    followup = route(
                        root,
                        key,
                        module_key,
                        len(routes),
                        rule="user_risk_lead_targeted",
                        query_url=risk_url,
                        rows=[flagged_video],
                    )
                    routes.append(followup)
                    inventory.add(followup["account_or_query_url"])
                    youtube_route_id = followup["route_id"]
        risk_ids = ["risk-001"] if key == "youtube" else []
        platform = {
            "display_name": validator.PLATFORM_DISPLAY[key],
            "discovery_status": "related_content_only" if key == "youtube" else "no_account_after_targeted_search",
            "risk_group_ids": risk_ids,
            "subplatforms": [],
            "delivery_modules": modules,
            "research_completion": {
                "status": "targeted_complete",
                "scope_conclusion": "risk_found" if risk_ids else "no_risk_in_targeted_scope",
                "route_results": routes,
                "completion_note": "已按三小时定向范围完成该平台检查。",
            },
        }
        if key == "domestic_other":
            platform["other_platform_tail"] = validator.OTHER_TAIL_STATEMENTS[key]
        if key == "overseas_other":
            platform["other_platform_tail"] = validator.OTHER_TAIL_STATEMENTS[key]
        platforms[key] = platform

    return {
        "schema_version": "1.11",
        "research_profile": "three_hour_targeted_v1",
        "subject": {
            "display_name": "测试对象",
            "subject_type": "person",
            "category": "视频创作者",
            "basic_info": "用于校验三小时定向模式的测试对象。",
            "basic_info_source_urls": ["https://www.wikidata.org/wiki/Q42"],
            "report_date": "2026-09-09",
            "aliases": ["testtarget"],
            "strongest_handle": "",
            "user_supplied_homepages": [],
            "scope": {"unit": "个人", "included": ["本人公开账号与公开内容"], "excluded": []},
        },
        "verdict": {"has_risk": True, "result_level": "建议评估", "overall_conclusion": "发现一项需评估的公开内容风险。"},
        "accounts": [],
        "representative_works": [],
        "risk_summary_order": ["risk-001"],
        "risk_groups": [{
            "id": "risk-001",
            "title": "公开发布需评估内容",
            "category": "内容调性",
            "summary": "曾发布一项需评估内容。",
            "explanation": "相关视频含有需进一步评估的明确内容。",
            "instances": [{
                "platform_key": "youtube",
                "subplatform": "",
                "module_targets": [{
                    "module_key": "keyword_search",
                    "module_url": PLATFORM_URLS["youtube"][0],
                }],
                "published_at": "2026-01-01",
                "finding": "视频中出现需评估的内容。",
                "source_url": risk_url,
                "source_type": "official_account_content",
                "screenshots": [{
                    "path": str(screenshot),
                    "caption": "油管视频风险位置",
                    "platform_label": "油管",
                    "visible_text": "需评估内容",
                    "sha256": digest(screenshot),
                }],
            }],
        }],
        "platforms": platforms,
        "coverage": {
            "started_at": "2026-09-09T08:55:00+08:00",
            "completed_at": "2026-09-09T11:45:00+08:00",
            "user_risk_leads": [{
                "lead_id": "lead-001",
                "platform_keys": ["youtube"],
                "keyword_groups": ["需评估内容"],
                "description": "用户要求核查该视频线索。",
                "resolution_status": "risk_found",
                "risk_group_ids": ["risk-001"],
                "resolved_route_ids": [youtube_route_id],
                "resolution_note": "已检查视频时间线与命中附近语境并确认风险。",
            }],
            "search_engines_checked": ["baidu", "google"],
            "source_inventory": sorted(inventory),
            "pending_cross_platform_leads": [],
            "target_scope": copy.deepcopy(TARGET_SCOPE),
        },
        "qa": {flag: True for flag in QA_FLAGS},
    }


def first_route(payload: dict, platform: str = "weibo") -> dict:
    return payload["platforms"][platform]["research_completion"]["route_results"][0]


class TargetedPayloadTests(unittest.TestCase):
    def setUp(self) -> None:
        validator.EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=validator.EVIDENCE_ROOT)
        self.root = Path(self.temp.name)
        self.payload = fixture(self.root)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def errors(self, payload: dict | None = None) -> list[str]:
        return validator.validate(payload or self.payload, check_files=True)

    def add_named_homepages(self, payload: dict, platform_key: str, urls: list[str]) -> list[dict]:
        module_key = "subject_homepage" if platform_key == "douban" else "homepage"
        module = payload["platforms"][platform_key]["delivery_modules"][module_key]
        module.update({
            "status": "confirmed",
            "urls": list(urls),
            "url_identity_statuses": {url: "confirmed" for url in urls},
            "url_risk_group_ids": {url: [] for url in urls},
            "risk_group_ids": [],
        })
        created_routes: list[dict] = []
        for index, url in enumerate(urls, 200):
            payload["accounts"].append({
                "platform_key": platform_key,
                "subplatform": "",
                "subplatform_entry_id": "",
                "url": url,
                "handle": "",
                "status": "confirmed",
                "identity_basis": "测试账号身份已确认。",
                "source_urls": [url],
            })
            payload["coverage"]["source_inventory"].append(url)
            media_route = route(
                self.root,
                platform_key,
                module_key,
                index * 2,
                rule="homepage_pinned_all_latest20_popular10_historical1_applicable_tabs",
                query_url=url,
            )
            text_route = route(
                self.root,
                platform_key,
                module_key,
                index * 2 + 1,
                rule="homepage_all_public_text_to_natural_end",
                query_url=url,
            )
            text_route["items_selected"] = 1
            text_route["items_reviewed"] = 1
            created_routes.extend([media_route, text_route])
        payload["platforms"][platform_key]["research_completion"]["route_results"].extend(created_routes)
        payload["platforms"][platform_key]["discovery_status"] = "confirmed_account"
        return created_routes

    @staticmethod
    def set_combined_plan(payload: dict, group: str, terms: list[str]) -> None:
        query_text = " ".join([MAIN_QUERY, *terms])
        query_url = quote_plus(query_text)
        for platform_key, base_url in (
            ("domestic_other", "https://www.baidu.com/s?wd="),
            ("overseas_other", "https://www.google.com/search?q="),
        ):
            combined = next(
                route_value
                for route_value in payload["platforms"][platform_key]["research_completion"]["route_results"]
                if route_value["selection_rule"] == "combined_high_risk_first_3_pages"
            )
            combined.update({
                "account_or_query_url": f"{base_url}{query_url}",
                "resolved_url": f"{base_url}{query_url}",
                "query_text": query_text,
                "query_risk_group": group,
                "query_terms": list(terms),
            })
            payload["coverage"]["source_inventory"].append(combined["account_or_query_url"])

    def test_valid_targeted_payload_and_clean_route_without_ledger(self) -> None:
        route_value = first_route(self.payload)
        route_value["items_selected"] = 10
        route_value["items_reviewed"] = 10
        self.assertEqual(route_value["flagged_items"], 0)
        self.assertIsNone(route_value["flagged_item_ledger_path"])
        self.assertEqual(self.errors(), [])

    def test_new_research_routes_use_browser_ui(self) -> None:
        route_values = [
            route_value
            for platform in self.payload["platforms"].values()
            for route_value in platform["research_completion"]["route_results"]
        ]
        self.assertTrue(route_values)
        self.assertTrue(all(route_value["tool_kind"] == "browser_ui" for route_value in route_values))
        self.assertTrue(all(route_value["tool_name"] == "Microsoft Edge" for route_value in route_values))
        self.assertTrue(all(route_value["browser_family"] == "microsoft_edge" for route_value in route_values))
        self.assertEqual(self.errors(), [])

    def test_confirmed_persistent_desktop_browser_product_names_are_allowed(self) -> None:
        cases = (
            ("Microsoft Edge", "microsoft_edge"),
            ("Microsoft Edge Stable", "microsoft_edge"),
            ("Google Chrome", "google_chrome"),
            ("Google Chrome Stable", "google_chrome"),
        )
        for tool_name, browser_family in cases:
            with self.subTest(tool_name=tool_name, browser_family=browser_family):
                alternate = copy.deepcopy(self.payload)
                route_value = first_route(alternate)
                route_value["tool_name"] = tool_name
                route_value["browser_family"] = browser_family
                self.assertEqual(self.errors(alternate), [])

    def test_browser_name_and_family_must_not_contradict(self) -> None:
        broken = copy.deepcopy(self.payload)
        first_route(broken)["browser_family"] = "google_chrome"
        self.assertTrue(any(
            "must identify the same desktop browser as tool_name" in item
            for item in self.errors(broken)
        ))

    def test_temporary_or_embedded_browser_identities_are_rejected(self) -> None:
        cases = (
            ("tool_name", "Codex built-in browser"),
            ("tool_name", "OpenAI embedded browser"),
            ("browser_family", "in_app"),
            ("tool_name", "in-app browser"),
            ("browser_family", "iab"),
            ("browser_family", "embedded_browser"),
            ("tool_name", "Built-in browser"),
            ("browser_family", "hosted_browser"),
            ("browser_family", "headless_chromium"),
            ("tool_name", "HeadlessChrome"),
            ("tool_name", "HeadlessFirefox"),
            ("browser_family", "HostedChrome"),
            ("browser_family", "IABBrowser"),
            ("tool_name", "TemporaryChrome"),
            ("tool_name", "Temporary Browser Session"),
            ("browser_family", "ephemeral_browser"),
        )
        for field, value in cases:
            with self.subTest(field=field, value=value):
                broken = copy.deepcopy(self.payload)
                first_route(broken)[field] = value
                self.assertTrue(any(
                    "must use a persistent desktop browser" in item
                    for item in self.errors(broken)
                ))

    def test_legacy_microsoft_edge_visible_alias_remains_valid(self) -> None:
        legacy = copy.deepcopy(self.payload)
        self.add_named_homepages(legacy, "facebook", ["https://www.facebook.com/testtarget"])
        for platform in legacy["platforms"].values():
            for route_value in platform["research_completion"]["route_results"]:
                if route_value["tool_kind"] == "browser_ui":
                    route_value["tool_kind"] = "microsoft_edge_visible"
                    route_value["tool_name"] = "Microsoft Edge"
                    route_value["browser_family"] = "microsoft_edge"
            for subplatform in platform["subplatforms"]:
                for route_value in subplatform["research_completion"]["route_results"]:
                    if route_value["tool_kind"] == "browser_ui":
                        route_value["tool_kind"] = "microsoft_edge_visible"
                        route_value["tool_name"] = "Microsoft Edge"
                        route_value["browser_family"] = "microsoft_edge"
        self.assertEqual(self.errors(legacy), [])

    def test_unknown_browser_tool_kind_is_rejected_with_generic_message(self) -> None:
        broken = copy.deepcopy(self.payload)
        first_route(broken)["tool_kind"] = "visible_browser"
        self.assertTrue(any(
            "only an interactive browser UI or a permitted API/export/script route is allowed" in item
            for item in self.errors(broken)
        ))

    def test_valid_all_clean_targeted_payload(self) -> None:
        clean = copy.deepcopy(self.payload)
        clean["risk_groups"] = []
        clean["risk_summary_order"] = []
        clean["verdict"] = {
            "has_risk": False,
            "result_level": "低合作风险",
            "overall_conclusion": "在约定的三小时定向范围内未发现合作风险。",
        }
        clean_lead = clean["coverage"]["user_risk_leads"][0]
        clean_lead["resolution_status"] = "no_risk_in_targeted_scope"
        clean_lead["risk_group_ids"] = []
        clean_lead["resolution_note"] = "专用交互式浏览器 UI 路线完成核查，在定向范围内未发现该风险。"
        youtube = clean["platforms"]["youtube"]
        youtube["risk_group_ids"] = []
        youtube["delivery_modules"]["keyword_search"].update({
            "result_status": "no_related_content", "risk_group_ids": [],
        })
        youtube["research_completion"]["scope_conclusion"] = "no_risk_in_targeted_scope"
        youtube["discovery_status"] = "no_account_after_targeted_search"
        risk_route = next(
            row for row in youtube["research_completion"]["route_results"]
            if row["flagged_items"]
        )
        risk_route.update({
            "flagged_items": 0,
            "flagged_item_ledger_path": None,
            "flagged_item_ledger_sha256": None,
        })
        self.assertEqual(self.errors(clean), [])

    def test_feishu_validator_uses_the_same_profile_dispatch(self) -> None:
        self.assertEqual(feishu_validator.validate_research_payload(self.payload, check_files=True), [])

    def test_feishu_document_validator_accepts_targeted_payload_fixture(self) -> None:
        snapshot = feishu_validator._fixture_snapshot(self.payload)
        report = feishu_validator.validate_document(snapshot, payload=self.payload)
        self.assertEqual(report.errors, [])

    def test_missing_one_of_fourteen_platforms_fails(self) -> None:
        broken = copy.deepcopy(self.payload)
        broken["platforms"].pop("instagram")
        self.assertTrue(any("missing mandatory platforms" in item for item in self.errors(broken)))

    def test_recorded_user_lead_must_be_closed_by_route(self) -> None:
        broken = copy.deepcopy(self.payload)
        broken["coverage"]["user_risk_leads"][0]["resolved_route_ids"] = []
        self.assertTrue(any("resolved_route_ids" in item for item in self.errors(broken)))

    def test_user_lead_cannot_be_closed_by_an_ordinary_completed_route(self) -> None:
        broken = copy.deepcopy(self.payload)
        ordinary_route = next(
            route_value
            for route_value in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route_value["selection_rule"] == "platform_first_3_pages_or_30_results"
        )
        broken["coverage"]["user_risk_leads"][0]["resolved_route_ids"] = [ordinary_route["route_id"]]
        self.assertTrue(any(
            "must use user_risk_lead_targeted" in item
            for item in self.errors(broken)
        ))

    def test_risk_found_user_lead_ledger_must_mark_user_selection(self) -> None:
        broken = copy.deepcopy(self.payload)
        risk_route = next(
            route_value
            for route_value in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if route_value["flagged_items"]
        )
        ledger = Path(risk_route["flagged_item_ledger_path"])
        row = json.loads(ledger.read_text(encoding="utf-8"))
        row["selection_basis"] = ["risk_hit"]
        ledger.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
        risk_route["flagged_item_ledger_sha256"] = digest(ledger)
        self.assertTrue(any(
            "must include a user_risk_lead selected row" in item
            for item in self.errors(broken)
        ))

    def test_selected_must_equal_reviewed(self) -> None:
        broken = copy.deepcopy(self.payload)
        first_route(broken)["items_reviewed"] = 1
        self.assertTrue(any("items_selected must equal items_reviewed" in item for item in self.errors(broken)))

    def test_found_risk_requires_screenshot_and_direct_url(self) -> None:
        broken = copy.deepcopy(self.payload)
        instance = broken["risk_groups"][0]["instances"][0]
        instance["screenshots"] = []
        instance["source_url"] = "not-a-url"
        errors = self.errors(broken)
        self.assertTrue(any("requires a screenshot" in item for item in errors))
        self.assertTrue(any("real direct URL" in item for item in errors))

    def test_risk_source_url_cannot_be_a_homepage_or_search_module_url(self) -> None:
        broken = copy.deepcopy(self.payload)
        broken["risk_groups"][0]["instances"][0]["source_url"] = PLATFORM_URLS["youtube"][0]
        self.assertTrue(any(
            "must not equal a homepage or search-module URL" in item
            for item in self.errors(broken)
        ))

    def test_risk_source_homepage_tracking_variant_is_still_forbidden(self) -> None:
        broken = copy.deepcopy(self.payload)
        homepage_url = "https://www.youtube.com/@testtarget"
        self.add_named_homepages(broken, "youtube", [homepage_url])
        tracking_variant = f"{homepage_url}/?utm_source=audit#about"
        broken["risk_groups"][0]["instances"][0]["source_url"] = tracking_variant
        broken["coverage"]["source_inventory"].append(tracking_variant)
        self.assertTrue(any(
            "must not equal a homepage or search-module URL" in item
            for item in self.errors(broken)
        ))

    def test_named_platform_search_variant_is_not_a_direct_risk_url(self) -> None:
        broken = copy.deepcopy(self.payload)
        search_variant = "https://www.youtube.com/results?search_query=another+query"
        broken["risk_groups"][0]["instances"][0]["source_url"] = search_variant
        broken["coverage"]["source_inventory"].append(search_variant)
        self.assertTrue(any(
            "must be a direct content URL" in item
            for item in self.errors(broken)
        ))

    def test_empty_content_paths_are_not_direct_risk_urls(self) -> None:
        cases = (
            ("bilibili", "https://www.bilibili.com/video/"),
            ("douyin", "https://www.douyin.com/video/"),
            ("xiaohongshu", "https://www.xiaohongshu.com/explore/"),
            ("zhihu", "https://www.zhihu.com/p/"),
            ("facebook", "https://www.facebook.com/reel/"),
            ("instagram", "https://www.instagram.com/reel/"),
            ("youtube", "https://www.youtube.com/shorts/"),
            ("youtube", "https://www.youtube.com/watch?v="),
        )
        for platform_key, value in cases:
            with self.subTest(platform_key=platform_key, value=value):
                self.assertFalse(targeted_validator._direct_content_url(platform_key, value))

    def test_weibo_hashtag_topic_search_is_a_topic_url_but_plain_search_is_not(self) -> None:
        hashtag = "https://s.weibo.com/weibo?q=%23%E6%B5%8B%E8%AF%95%E8%AF%9D%E9%A2%98%23"
        plain = f"https://s.weibo.com/weibo?q={MAIN_QUERY_URL}"
        self.assertTrue(targeted_validator._homepage_or_topic_url("weibo", "topic", hashtag))
        self.assertFalse(targeted_validator._homepage_or_topic_url("weibo", "topic", plain))

    def test_extra_platform_content_page_cannot_masquerade_as_homepage(self) -> None:
        self.assertFalse(targeted_validator._homepage_or_topic_url(
            "overseas_other", "subplatform:pixiv", "https://www.pixiv.net/artworks/123456"
        ))
        self.assertTrue(targeted_validator._homepage_or_topic_url(
            "overseas_other", "subplatform:pixiv", "https://www.pixiv.net/users/123456"
        ))

    def test_found_risk_requires_flagged_ledger_mapping(self) -> None:
        broken = copy.deepcopy(self.payload)
        risk_route = next(
            row for row in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if row["flagged_items"]
        )
        risk_route["flagged_items"] = 0
        risk_route["flagged_item_ledger_path"] = None
        risk_route["flagged_item_ledger_sha256"] = None
        errors = self.errors(broken)
        self.assertTrue(any("lacks a selected reviewed ledger row" in item for item in errors))

    def test_blocked_route_cannot_masquerade_as_clean(self) -> None:
        broken = copy.deepcopy(self.payload)
        route_value = first_route(broken)
        route_value.update({
            "status": "blocked",
            "termination": "login_required",
            "minimum_scope_met": False,
            "scope_stop_reason": "access_boundary",
            "boundary": "需要用户登录",
            "resolved_by_route_ids": [],
        })
        errors = self.errors(broken)
        self.assertTrue(any("must resolve every blocked/failed route" in item for item in errors))
        self.assertTrue(any("target scope not closed" in item for item in errors))

    def test_browser_ui_login_recovery_cannot_be_replaced_by_api(self) -> None:
        broken = copy.deepcopy(self.payload)
        blocked = first_route(broken)
        resolver = copy.deepcopy(blocked)
        resolver["route_id"] = "weibo-keyword-api-resolver"
        resolver["tool_kind"] = "official_api"
        resolver["edge_window_continuity_id"] = None
        resolver["edge_page_continuity_id"] = None
        blocked.update({
            "status": "blocked",
            "termination": "login_required",
            "minimum_scope_met": False,
            "scope_stop_reason": "access_boundary",
            "boundary": "需要用户登录",
            "resolved_by_route_ids": [resolver["route_id"]],
        })
        broken["platforms"]["weibo"]["research_completion"]["route_results"].append(resolver)
        self.assertTrue(any(
            "interactive-browser login recovery must remain an interactive browser UI route" in item
            for item in self.errors(broken)
        ))

    def test_browser_ui_login_recovery_resumes_same_page_after_boundary(self) -> None:
        resumed = copy.deepcopy(self.payload)
        blocked = first_route(resumed)
        resolver = copy.deepcopy(blocked)
        resolver["route_id"] = "weibo-keyword-edge-resolver"
        resolver["started_at"] = "2026-09-09T09:06:00+08:00"
        resolver["completed_at"] = "2026-09-09T09:10:00+08:00"
        blocked.update({
            "status": "blocked",
            "termination": "login_required",
            "minimum_scope_met": False,
            "scope_stop_reason": "access_boundary",
            "boundary": "需要用户登录",
            "resolved_by_route_ids": [resolver["route_id"]],
        })
        resumed["platforms"]["weibo"]["research_completion"]["route_results"].append(resolver)
        self.assertEqual(self.errors(resumed), [])

    def test_legacy_browser_alias_and_browser_ui_can_share_login_continuity(self) -> None:
        resumed = copy.deepcopy(self.payload)
        blocked = first_route(resumed)
        blocked["tool_kind"] = "microsoft_edge_visible"
        blocked["tool_name"] = "Microsoft Edge"
        blocked["browser_family"] = "microsoft_edge"
        resolver = copy.deepcopy(blocked)
        resolver.update({
            "route_id": "weibo-keyword-browser-ui-resolver",
            "tool_kind": "browser_ui",
            "started_at": "2026-09-09T09:06:00+08:00",
            "completed_at": "2026-09-09T09:10:00+08:00",
        })
        blocked.update({
            "status": "blocked",
            "termination": "login_required",
            "minimum_scope_met": False,
            "scope_stop_reason": "access_boundary",
            "boundary": "需要用户登录",
            "resolved_by_route_ids": [resolver["route_id"]],
        })
        resumed["platforms"]["weibo"]["research_completion"]["route_results"].append(resolver)
        self.assertEqual(self.errors(resumed), [])

    def test_browser_ui_login_recovery_allows_new_page_only_when_old_page_was_lost(self) -> None:
        resumed = copy.deepcopy(self.payload)
        blocked = first_route(resumed)
        resolver = copy.deepcopy(blocked)
        resolver["route_id"] = "weibo-keyword-new-page-resolver"
        resolver["edge_window_continuity_id"] = "11111111-1111-4111-8111-111111111111"
        resolver["edge_page_continuity_id"] = "22222222-2222-4222-8222-222222222222"
        resolver["started_at"] = "2026-09-09T09:06:00+08:00"
        resolver["completed_at"] = "2026-09-09T09:10:00+08:00"
        blocked.update({
            "status": "blocked",
            "termination": "login_required",
            "minimum_scope_met": False,
            "scope_stop_reason": "access_boundary",
            "boundary": "page_lost_new_continuity_required: 登录完成后原调查页已关闭",
            "resolved_by_route_ids": [resolver["route_id"]],
        })
        resumed["platforms"]["weibo"]["research_completion"]["route_results"].append(resolver)
        self.assertEqual(self.errors(resumed), [])

    def test_browser_ui_login_recovery_rejects_unexplained_new_page(self) -> None:
        broken = copy.deepcopy(self.payload)
        blocked = first_route(broken)
        resolver = copy.deepcopy(blocked)
        resolver["route_id"] = "weibo-keyword-unexplained-new-page"
        resolver["edge_window_continuity_id"] = "11111111-1111-4111-8111-111111111111"
        resolver["edge_page_continuity_id"] = "22222222-2222-4222-8222-222222222222"
        resolver["started_at"] = "2026-09-09T09:06:00+08:00"
        resolver["completed_at"] = "2026-09-09T09:10:00+08:00"
        blocked.update({
            "status": "blocked",
            "termination": "login_required",
            "minimum_scope_met": False,
            "scope_stop_reason": "access_boundary",
            "boundary": "需要用户登录",
            "resolved_by_route_ids": [resolver["route_id"]],
        })
        broken["platforms"]["weibo"]["research_completion"]["route_results"].append(resolver)
        self.assertTrue(any(
            "must resume on the same page id unless boundary begins" in item
            for item in self.errors(broken)
        ))

    def test_targeted_video_does_not_require_full_audio_or_exhaustive_top10_fields(self) -> None:
        # The valid fixture has no video_metadata, native Top-10 snapshot,
        # natural_end, full_cartesian query ledger, or full-audio timeline.
        self.assertFalse(next(
            row for row in self.payload["platforms"]["youtube"]["research_completion"]["route_results"]
            if row["flagged_items"]
        )["termination"] == "natural_end")
        self.assertEqual(self.errors(), [])

    def test_every_platform_requires_a_completed_interactive_browser_ui_visit(self) -> None:
        broken = copy.deepcopy(self.payload)
        for route_value in broken["platforms"]["weibo"]["research_completion"]["route_results"]:
            route_value["tool_kind"] = "official_api"
            route_value["edge_window_continuity_id"] = None
            route_value["edge_page_continuity_id"] = None
        self.assertTrue(any(
            "requires a completed interactive browser UI visit" in item
            for item in self.errors(broken)
        ))

    def test_native_main_name_query_cannot_be_replaced_by_api(self) -> None:
        broken = copy.deepcopy(self.payload)
        main_route = first_route(broken)
        main_route["tool_kind"] = "official_api"
        main_route["edge_window_continuity_id"] = None
        main_route["edge_page_continuity_id"] = None
        broken["platforms"]["weibo"]["research_completion"]["route_results"].append(route(
            self.root,
            "weibo",
            "keyword_search",
            101,
            rule="identity_resolution_targeted",
        ))
        errors = self.errors(broken)
        self.assertTrue(any("requires the exact main-name query" in item for item in errors))

    def test_baidu_combined_query_itself_must_be_interactive_browser_ui(self) -> None:
        broken = copy.deepcopy(self.payload)
        combined = next(
            route_value
            for route_value in broken["platforms"]["domestic_other"]["research_completion"]["route_results"]
            if route_value["selection_rule"] == "combined_high_risk_first_3_pages"
        )
        combined["tool_kind"] = "official_api"
        combined["edge_window_continuity_id"] = None
        combined["edge_page_continuity_id"] = None
        self.assertTrue(any(
            "requires main-name and combined-high-risk" in item
            for item in self.errors(broken)
        ))

    def test_each_named_homepage_url_requires_its_own_exact_browser_ui_route(self) -> None:
        broken = copy.deepcopy(self.payload)
        urls = [
            "https://www.facebook.com/testtarget-main",
            "https://www.facebook.com/testtarget-secondary",
        ]
        created = self.add_named_homepages(broken, "facebook", urls)
        broken["platforms"]["facebook"]["research_completion"]["route_results"].remove(created[2])
        self.assertTrue(any(
            urls[1] in item and "requires its own exact interactive browser UI route using homepage_pinned" in item
            for item in self.errors(broken)
        ))

    def test_homepage_requires_all_public_text_route_to_natural_endpoint(self) -> None:
        broken = copy.deepcopy(self.payload)
        homepage_url = "https://www.facebook.com/testtarget"
        created = self.add_named_homepages(broken, "facebook", [homepage_url])
        text_route = next(
            item for item in created
            if item["selection_rule"] == "homepage_all_public_text_to_natural_end"
        )
        broken["platforms"]["facebook"]["research_completion"]["route_results"].remove(text_route)
        self.assertTrue(any(
            homepage_url in item and "all-public-post-text route to a natural endpoint" in item
            for item in self.errors(broken)
        ))

    def test_homepage_media_and_all_public_text_routes_are_valid_together(self) -> None:
        complete = copy.deepcopy(self.payload)
        self.add_named_homepages(
            complete, "facebook", ["https://www.facebook.com/testtarget"]
        )
        self.assertEqual(self.errors(complete), [])

    def test_full_homepage_text_route_requires_a_natural_endpoint_reason(self) -> None:
        broken = copy.deepcopy(self.payload)
        created = self.add_named_homepages(
            broken, "facebook", ["https://www.facebook.com/testtarget"]
        )
        text_route = next(
            item for item in created
            if item["selection_rule"] == "homepage_all_public_text_to_natural_end"
        )
        text_route["scope_stop_reason"] = "scope_sample_complete"
        self.assertTrue(any(
            "full homepage text review requires natural_end" in item
            for item in self.errors(broken)
        ))

    def test_full_homepage_natural_end_cannot_claim_zero_reviewed_posts(self) -> None:
        broken = copy.deepcopy(self.payload)
        created = self.add_named_homepages(
            broken, "facebook", ["https://www.facebook.com/testtarget"]
        )
        text_route = next(
            item for item in created
            if item["selection_rule"] == "homepage_all_public_text_to_natural_end"
        )
        text_route["items_selected"] = 0
        text_route["items_reviewed"] = 0
        self.assertTrue(any(
            "natural_end/cursor_exhausted requires items_selected == items_reviewed >= 1" in item
            for item in self.errors(broken)
        ))

    def test_empty_homepage_timeline_requires_zero_selected_and_reviewed(self) -> None:
        broken = copy.deepcopy(self.payload)
        created = self.add_named_homepages(
            broken, "facebook", ["https://www.facebook.com/testtarget"]
        )
        text_route = next(
            item for item in created
            if item["selection_rule"] == "homepage_all_public_text_to_natural_end"
        )
        text_route["scope_stop_reason"] = "empty_timeline"
        self.assertTrue(any(
            "empty_timeline requires items_selected == items_reviewed == 0" in item
            for item in self.errors(broken)
        ))

    def test_empty_homepage_timeline_with_zero_counts_is_valid(self) -> None:
        complete = copy.deepcopy(self.payload)
        created = self.add_named_homepages(
            complete, "facebook", ["https://www.facebook.com/emptytesttarget"]
        )
        text_route = next(
            item for item in created
            if item["selection_rule"] == "homepage_all_public_text_to_natural_end"
        )
        text_route["scope_stop_reason"] = "empty_timeline"
        text_route["items_selected"] = 0
        text_route["items_reviewed"] = 0
        self.assertEqual(self.errors(complete), [])

    def test_local_script_cannot_satisfy_full_homepage_text_route(self) -> None:
        broken = copy.deepcopy(self.payload)
        created = self.add_named_homepages(
            broken, "facebook", ["https://www.facebook.com/testtarget"]
        )
        text_route = next(
            item for item in created
            if item["selection_rule"] == "homepage_all_public_text_to_natural_end"
        )
        text_route["tool_kind"] = "local_script"
        text_route["edge_window_continuity_id"] = None
        text_route["edge_page_continuity_id"] = None
        self.assertTrue(any(
            "full homepage text route allows only" in item
            for item in self.errors(broken)
        ))

    def test_topic_page_keeps_bounded_browser_ui_review_without_full_text_route(self) -> None:
        complete = copy.deepcopy(self.payload)
        topic_url = f"https://s.weibo.com/weibo?q={quote_plus('#测试对象#')}"
        complete["platforms"]["weibo"]["delivery_modules"]["topic"].update({
            "status": "confirmed",
            "urls": [topic_url],
            "url_risk_group_ids": {topic_url: []},
            "risk_group_ids": [],
        })
        complete["coverage"]["source_inventory"].append(topic_url)
        complete["platforms"]["weibo"]["research_completion"]["route_results"].append(route(
            self.root,
            "weibo",
            "topic",
            499,
            rule="topic_related_first_30_items",
            query_url=topic_url,
        ))
        self.assertEqual(self.errors(complete), [])

    def test_topic_page_cannot_be_declared_as_account_full_text_scope(self) -> None:
        broken = copy.deepcopy(self.payload)
        topic_url = f"https://s.weibo.com/weibo?q={quote_plus('#测试对象#')}"
        broken["platforms"]["weibo"]["delivery_modules"]["topic"].update({
            "status": "confirmed",
            "urls": [topic_url],
            "url_risk_group_ids": {topic_url: []},
            "risk_group_ids": [],
        })
        broken["coverage"]["source_inventory"].append(topic_url)
        routes = broken["platforms"]["weibo"]["research_completion"]["route_results"]
        routes.append(route(
            self.root,
            "weibo",
            "topic",
            500,
            rule="topic_related_first_30_items",
            query_url=topic_url,
        ))
        routes.append(route(
            self.root,
            "weibo",
            "topic",
            501,
            rule="homepage_all_public_text_to_natural_end",
            query_url=topic_url,
        ))
        self.assertTrue(any(
            "applies only to an account homepage, not a topic page" in item
            for item in self.errors(broken)
        ))

    def test_topic_page_cannot_use_account_media_sample_rule(self) -> None:
        broken = copy.deepcopy(self.payload)
        topic_url = f"https://s.weibo.com/weibo?q={quote_plus('#测试对象#')}"
        broken["platforms"]["weibo"]["delivery_modules"]["topic"].update({
            "status": "confirmed",
            "urls": [topic_url],
            "url_risk_group_ids": {topic_url: []},
            "risk_group_ids": [],
        })
        broken["coverage"]["source_inventory"].append(topic_url)
        broken["platforms"]["weibo"]["research_completion"]["route_results"].append(route(
            self.root,
            "weibo",
            "topic",
            502,
            rule="homepage_pinned_all_latest20_popular10_historical1_applicable_tabs",
            query_url=topic_url,
        ))
        self.assertTrue(any(
            "homepage media sample applies only to an account homepage" in item
            for item in self.errors(broken)
        ))

    def test_topic_review_cannot_exceed_thirty_related_items(self) -> None:
        broken = copy.deepcopy(self.payload)
        topic_url = f"https://s.weibo.com/weibo?q={quote_plus('#测试对象#')}"
        broken["platforms"]["weibo"]["delivery_modules"]["topic"].update({
            "status": "confirmed",
            "urls": [topic_url],
            "url_risk_group_ids": {topic_url: []},
            "risk_group_ids": [],
        })
        broken["coverage"]["source_inventory"].append(topic_url)
        topic_route = route(
            self.root, "weibo", "topic", 503,
            rule="topic_related_first_30_items", query_url=topic_url,
        )
        topic_route["items_selected"] = 31
        topic_route["items_reviewed"] = 31
        topic_route["scope_stop_reason"] = "item_limit"
        broken["platforms"]["weibo"]["research_completion"]["route_results"].append(topic_route)
        self.assertTrue(any(
            "bounded topic review permits at most 30 related items" in item
            for item in self.errors(broken)
        ))

    def test_topic_review_accepts_exactly_thirty_related_items(self) -> None:
        complete = copy.deepcopy(self.payload)
        topic_url = f"https://s.weibo.com/weibo?q={quote_plus('#测试对象#')}"
        complete["platforms"]["weibo"]["delivery_modules"]["topic"].update({
            "status": "confirmed",
            "urls": [topic_url],
            "url_risk_group_ids": {topic_url: []},
            "risk_group_ids": [],
        })
        complete["coverage"]["source_inventory"].append(topic_url)
        topic_route = route(
            self.root, "weibo", "topic", 504,
            rule="topic_related_first_30_items", query_url=topic_url,
        )
        topic_route["items_selected"] = 30
        topic_route["items_reviewed"] = 30
        topic_route["scope_stop_reason"] = "item_limit"
        complete["platforms"]["weibo"]["research_completion"]["route_results"].append(topic_route)
        self.assertEqual(self.errors(complete), [])

    def test_account_homepage_cannot_use_bounded_topic_rule(self) -> None:
        broken = copy.deepcopy(self.payload)
        created = self.add_named_homepages(
            broken, "facebook", ["https://www.facebook.com/testtarget"]
        )
        media_route = created[0]
        media_route["selection_rule"] = "topic_related_first_30_items"
        media_route["scope_stop_reason"] = "results_exhausted_early"
        self.assertTrue(any(
            "bounded topic review applies only to topic or topic_homepage" in item
            for item in self.errors(broken)
        ))

    def test_homepage_sample_itself_cannot_be_api(self) -> None:
        broken = copy.deepcopy(self.payload)
        homepage_route = self.add_named_homepages(
            broken, "facebook", ["https://www.facebook.com/testtarget"]
        )[0]
        homepage_route["tool_kind"] = "official_api"
        homepage_route["edge_window_continuity_id"] = None
        homepage_route["edge_page_continuity_id"] = None
        self.assertTrue(any(
            "requires its own exact interactive browser UI route using homepage_pinned" in item
            for item in self.errors(broken)
        ))

    def test_homepage_sample_resolved_url_cannot_drift_elsewhere(self) -> None:
        broken = copy.deepcopy(self.payload)
        homepage_route = self.add_named_homepages(
            broken, "facebook", ["https://www.facebook.com/testtarget"]
        )[0]
        homepage_route["resolved_url"] = PLATFORM_URLS["facebook"][0]
        self.assertTrue(any(
            "requires its own exact interactive browser UI route using homepage_pinned" in item
            for item in self.errors(broken)
        ))

    def test_youtube_search_page_cannot_masquerade_as_homepage(self) -> None:
        broken = copy.deepcopy(self.payload)
        self.add_named_homepages(broken, "youtube", [PLATFORM_URLS["youtube"][0]])
        self.assertTrue(any(
            "homepage/topic sample must be a real homepage/topic URL" in item
            for item in self.errors(broken)
        ))

    def test_profile_shaped_url_cannot_masquerade_as_youtube_search(self) -> None:
        broken = copy.deepcopy(self.payload)
        search_route = first_route(broken, "youtube")
        fake_search = f"https://www.youtube.com/@someone?search_query={MAIN_QUERY_URL}"
        search_route["account_or_query_url"] = fake_search
        search_route["resolved_url"] = fake_search
        broken["coverage"]["source_inventory"].append(fake_search)
        self.assertTrue(any(
            "required search route must expose its native query" in item
            for item in self.errors(broken)
        ))

    def test_baidu_and_google_query_parameters_on_wrong_paths_are_rejected(self) -> None:
        cases = (
            ("domestic_other", f"https://www.baidu.com/about/?wd={MAIN_QUERY_URL}"),
            ("overseas_other", f"https://www.google.com/about/?q={MAIN_QUERY_URL}"),
        )
        for platform_key, fake_search in cases:
            with self.subTest(platform_key=platform_key):
                broken = copy.deepcopy(self.payload)
                search_route = first_route(broken, platform_key)
                search_route["account_or_query_url"] = fake_search
                search_route["resolved_url"] = fake_search
                broken["coverage"]["source_inventory"].append(fake_search)
                self.assertTrue(any(
                    "required search route must expose its native query" in item
                    for item in self.errors(broken)
                ))

    def test_extra_homepage_cannot_be_completed_by_api_alone(self) -> None:
        broken = copy.deepcopy(self.payload)
        extra_url = "https://www.pixiv.net/users/123456"
        module_key = "subplatform:pixiv"
        route_value = route(
            self.root,
            "overseas_other",
            module_key,
            99,
            rule="homepage_pinned_all_latest20_popular10_historical1_applicable_tabs",
            query_url=extra_url,
        )
        route_value["tool_kind"] = "official_api"
        route_value["edge_window_continuity_id"] = None
        route_value["edge_page_continuity_id"] = None
        broken["accounts"].append({
            "platform_key": "overseas_other",
            "subplatform": "Pixiv",
            "subplatform_entry_id": "pixiv",
            "url": extra_url,
            "handle": "",
            "status": "confirmed",
            "identity_basis": "测试账号身份已确认。",
            "source_urls": [extra_url],
        })
        broken["coverage"]["source_inventory"].append(extra_url)
        overseas = broken["platforms"]["overseas_other"]
        overseas["discovery_status"] = "confirmed_account"
        overseas["subplatforms"].append({
            "entry_id": "pixiv",
            "name": "Pixiv",
            "homepage": {
                "status": "confirmed",
                "urls": [extra_url],
                "url_identity_statuses": {extra_url: "confirmed"},
                "url_risk_group_ids": {extra_url: []},
                "risk_group_ids": [],
            },
            "research_completion": {
                "status": "targeted_complete",
                "scope_conclusion": "no_risk_in_targeted_scope",
                "route_results": [route_value],
                "completion_note": "仅有 API 结果，未完成交互式浏览器 UI 主页访问。",
            },
        })
        errors = self.errors(broken)
        self.assertTrue(any("requires a completed interactive browser UI visit" in item for item in errors))

    def test_extra_subplatform_cannot_be_a_not_found_placeholder(self) -> None:
        broken = copy.deepcopy(self.payload)
        overseas = broken["platforms"]["overseas_other"]
        overseas["subplatforms"].append({
            "entry_id": "empty-placeholder",
            "name": "空占位",
            "homepage": empty_homepage(True),
            "research_completion": {
                "status": "targeted_complete",
                "scope_conclusion": "no_risk_in_targeted_scope",
                "route_results": [route(
                    self.root,
                    "overseas_other",
                    "subplatform:empty-placeholder",
                    100,
                    rule="homepage_pinned_all_latest20_popular10_historical1_applicable_tabs",
                )],
                "completion_note": "不应允许用空主页占位。",
            },
        })
        self.assertTrue(any(
            "requires exactly one delivered homepage URL" in item
            for item in self.errors(broken)
        ))

    def test_one_page_cannot_claim_page_limit(self) -> None:
        broken = copy.deepcopy(self.payload)
        route_value = first_route(broken)
        route_value["scope_stop_reason"] = "page_limit"
        self.assertTrue(any("platform search needs page_limit at 3 pages" in item for item in self.errors(broken)))

    def test_query_text_must_match_the_native_search_url(self) -> None:
        broken = copy.deepcopy(self.payload)
        first_route(broken)["query_text"] = "伪造的另一查询"
        self.assertTrue(any(
            "must equal the query decoded" in item
            for item in self.errors(broken)
        ))

    def test_completed_search_resolved_url_must_keep_the_same_query(self) -> None:
        broken = copy.deepcopy(self.payload)
        route_value = first_route(broken)
        route_value["resolved_url"] = "https://s.weibo.com/"
        broken["coverage"]["source_inventory"].append(route_value["resolved_url"])
        self.assertTrue(any(
            "completed search route must preserve the same decoded query" in item
            for item in self.errors(broken)
        ))

    def test_general_other_direct_source_rejects_roots_and_search_pages(self) -> None:
        self.assertFalse(targeted_validator._direct_content_url(
            "overseas_other", "https://www.reuters.com/"
        ))
        self.assertFalse(targeted_validator._direct_content_url(
            "overseas_other", "https://www.bing.com/search?q=test"
        ))
        self.assertTrue(targeted_validator._direct_content_url(
            "overseas_other", "https://www.reuters.com/world/sample-article-2026-09-09/"
        ))

    def test_browser_page_id_intervals_cannot_overlap(self) -> None:
        broken = copy.deepcopy(self.payload)
        first = first_route(broken, "weibo")
        second = first_route(broken, "bilibili")
        second["edge_page_continuity_id"] = first["edge_page_continuity_id"]
        self.assertTrue(any("overlaps route" in item for item in self.errors(broken)))

    def test_browser_page_id_cannot_drift_to_another_window(self) -> None:
        broken = copy.deepcopy(self.payload)
        first = first_route(broken, "weibo")
        second = first_route(broken, "bilibili")
        second["edge_page_continuity_id"] = first["edge_page_continuity_id"]
        second["edge_window_continuity_id"] = "00000000-0000-4000-8000-000000000099"
        second["started_at"] = "2026-09-09T09:06:00+08:00"
        second["completed_at"] = "2026-09-09T09:10:00+08:00"
        self.assertTrue(any("must remain in one window" in item for item in self.errors(broken)))

    def test_nonduplicate_strongest_handle_requires_its_own_native_query(self) -> None:
        broken = copy.deepcopy(self.payload)
        broken["subject"]["strongest_handle"] = "@testtarget"
        self.assertTrue(any("requires the exact strongest-handle query" in item for item in self.errors(broken)))

    def test_alias_search_requires_a_real_trigger(self) -> None:
        broken = copy.deepcopy(self.payload)
        broken["subject"]["aliases"].append("测试别名")
        primary = first_route(broken)
        primary["items_selected"] = 5
        primary["items_reviewed"] = 5
        alias_url = f"https://s.weibo.com/weibo?q={quote_plus('测试别名')}"
        alias_route = route(
            self.root, "weibo", "keyword_search", 103, query_url=alias_url
        )
        alias_route["query_kind"] = "alias"
        alias_route["query_text"] = "测试别名"
        broken["coverage"]["source_inventory"].append(alias_url)
        broken["platforms"]["weibo"]["research_completion"]["route_results"].append(alias_route)
        self.assertTrue(any(
            "alias search requires a prior empty primary search" in item
            for item in self.errors(broken)
        ))

    def test_alias_search_after_empty_primary_route_is_valid(self) -> None:
        extended = copy.deepcopy(self.payload)
        extended["subject"]["aliases"].append("测试别名")
        alias_url = f"https://s.weibo.com/weibo?q={quote_plus('测试别名')}"
        alias_route = route(
            self.root, "weibo", "keyword_search", 104, query_url=alias_url
        )
        alias_route["query_kind"] = "alias"
        alias_route["query_text"] = "测试别名"
        alias_route["started_at"] = "2026-09-09T09:06:00+08:00"
        alias_route["completed_at"] = "2026-09-09T09:10:00+08:00"
        extended["coverage"]["source_inventory"].append(alias_url)
        extended["platforms"]["weibo"]["research_completion"]["route_results"].append(alias_route)
        self.assertEqual(self.errors(extended), [])

    def test_alias_trigger_must_match_the_same_module_and_surface(self) -> None:
        broken = copy.deepcopy(self.payload)
        broken["subject"]["aliases"].append("测试别名")
        primary = first_route(broken)
        primary["items_selected"] = 5
        primary["items_reviewed"] = 5
        identity_url = "https://weibo.com/u/1234567890"
        identity_route = route(
            self.root,
            "weibo",
            "homepage",
            105,
            rule="identity_resolution_targeted",
            query_url=identity_url,
        )
        alias_url = f"https://s.weibo.com/weibo?q={quote_plus('测试别名')}"
        alias_route = route(
            self.root, "weibo", "keyword_search", 106, query_url=alias_url
        )
        alias_route["query_kind"] = "alias"
        alias_route["query_text"] = "测试别名"
        broken["coverage"]["source_inventory"].extend([identity_url, alias_url])
        broken["platforms"]["weibo"]["research_completion"]["route_results"].extend([
            identity_route, alias_route,
        ])
        self.assertTrue(any(
            "alias search requires a prior empty primary search" in item
            for item in self.errors(broken)
        ))

    def test_alias_trigger_must_finish_before_alias_starts(self) -> None:
        broken = copy.deepcopy(self.payload)
        broken["subject"]["aliases"].append("测试别名")
        primary = first_route(broken)
        primary["items_selected"] = 5
        primary["items_reviewed"] = 5
        identity_url = "https://weibo.com/u/1234567890"
        identity_route = route(
            self.root,
            "weibo",
            "keyword_search",
            107,
            rule="identity_resolution_targeted",
            query_url=identity_url,
        )
        alias_url = f"https://s.weibo.com/weibo?q={quote_plus('测试别名')}"
        alias_route = route(
            self.root, "weibo", "keyword_search", 108, query_url=alias_url
        )
        alias_route["query_kind"] = "alias"
        alias_route["query_text"] = "测试别名"
        alias_route["started_at"] = "2026-09-09T08:50:00+08:00"
        alias_route["completed_at"] = "2026-09-09T08:55:00+08:00"
        broken["coverage"]["source_inventory"].extend([identity_url, alias_url])
        broken["platforms"]["weibo"]["research_completion"]["route_results"].extend([
            identity_route, alias_route,
        ])
        self.assertTrue(any(
            "alias search requires a prior empty primary search" in item
            for item in self.errors(broken)
        ))

    def test_strongest_handle_api_route_does_not_satisfy_native_query(self) -> None:
        broken = copy.deepcopy(self.payload)
        broken["subject"]["strongest_handle"] = "@testtarget"
        handle_route = route(self.root, "weibo", "keyword_search", 102)
        handle_route["query_kind"] = "strongest_handle"
        handle_route["query_text"] = "@testtarget"
        handle_route["tool_kind"] = "official_api"
        handle_route["edge_window_continuity_id"] = None
        handle_route["edge_page_continuity_id"] = None
        broken["platforms"]["weibo"]["research_completion"]["route_results"].append(handle_route)
        self.assertTrue(any(
            "requires the exact strongest-handle query" in item
            for item in self.errors(broken)
        ))

    def test_combined_query_requires_two_to_four_preserved_terms(self) -> None:
        broken = copy.deepcopy(self.payload)
        route_value = next(
            route_value
            for route_value in broken["platforms"]["domestic_other"]["research_completion"]["route_results"]
            if route_value["selection_rule"] == "combined_high_risk_first_3_pages"
        )
        route_value["query_terms"] = ["风险"]
        self.assertTrue(any("requires 2 to 4 representative terms" in item for item in self.errors(broken)))

    def test_baidu_and_google_combined_query_plan_must_match(self) -> None:
        broken = copy.deepcopy(self.payload)
        google_combined = next(
            route_value
            for route_value in broken["platforms"]["overseas_other"]["research_completion"]["route_results"]
            if route_value["selection_rule"] == "combined_high_risk_first_3_pages"
        )
        google_combined["query_risk_group"] = "另一风险组"
        self.assertTrue(any("must use the same selected risk group" in item for item in self.errors(broken)))

    def test_combined_query_must_use_highest_priority_user_group(self) -> None:
        broken = copy.deepcopy(self.payload)
        for platform_key in ("domestic_other", "overseas_other"):
            combined = next(
                route_value
                for route_value in broken["platforms"][platform_key]["research_completion"]["route_results"]
                if route_value["selection_rule"] == "combined_high_risk_first_3_pages"
            )
            combined["query_risk_group"] = "任意低优先级组"
        self.assertTrue(any(
            "highest-priority user lead" in item
            for item in self.errors(broken)
        ))

    def test_user_led_combined_query_terms_must_be_traceable(self) -> None:
        broken = copy.deepcopy(self.payload)
        self.set_combined_plan(broken, "需评估内容", ["天气", "音乐"])
        self.assertTrue(any(
            "representative terms must come from the first user risk expression" in item
            for item in self.errors(broken)
        ))

    def test_without_user_leads_uses_current_standard_highest_priority_group(self) -> None:
        no_leads = copy.deepcopy(self.payload)
        no_leads["coverage"]["user_risk_leads"] = []
        self.set_combined_plan(no_leads, "涉毒（法律·最高优先）", ["涉毒", "大麻"])
        self.assertEqual(self.errors(no_leads), [])

    def test_without_user_leads_rejects_keyword_character_fragments(self) -> None:
        broken = copy.deepcopy(self.payload)
        broken["coverage"]["user_risk_leads"] = []
        self.set_combined_plan(broken, "涉毒（法律·最高优先）", ["吸", "毒"])
        self.assertTrue(any(
            "must be complete keyword tokens" in item
            for item in self.errors(broken)
        ))

    def test_without_user_leads_rejects_arbitrary_combined_group(self) -> None:
        broken = copy.deepcopy(self.payload)
        broken["coverage"]["user_risk_leads"] = []
        self.set_combined_plan(broken, "任意低优先级组", ["涉毒", "大麻"])
        self.assertTrue(any(
            "current risk standard's first highest-priority group" in item
            for item in self.errors(broken)
        ))

    @staticmethod
    def account_row(url: str, status: str) -> dict:
        return {
            "platform_key": "youtube",
            "subplatform": "",
            "subplatform_entry_id": "",
            "url": url,
            "handle": "",
            "status": status,
            "identity_basis": "测试身份依据。",
            "source_urls": [url],
        }

    def test_automatic_suspected_homepage_is_capped_at_one(self) -> None:
        urls = ["https://www.youtube.com/@suspectone", "https://www.youtube.com/@suspecttwo"]
        payload = {"accounts": [self.account_row(url, "suspected_homepage") for url in urls]}
        errors: list[str] = []
        targeted_validator._validate_accounts(payload, set(urls), set(), errors)
        self.assertTrue(any("at most one automatically selected" in item for item in errors))

    def test_user_supplied_suspect_forbids_automatic_suspect(self) -> None:
        supplied = "https://www.youtube.com/@usersupplied"
        automatic = "https://www.youtube.com/@automatic"
        payload = {"accounts": [
            self.account_row(supplied, "suspected_homepage"),
            self.account_row(automatic, "suspected_homepage"),
        ]}
        errors: list[str] = []
        targeted_validator._validate_accounts(payload, {supplied, automatic}, {supplied}, errors)
        self.assertTrue(any("forbids adding an automatic suspect" in item for item in errors))

    def test_confirmed_homepages_must_precede_suspected(self) -> None:
        suspected = "https://www.youtube.com/@suspected"
        confirmed = "https://www.youtube.com/@confirmed"
        module = {
            "status": "confirmed",
            "urls": [suspected, confirmed],
            "url_identity_statuses": {suspected: "suspected", confirmed: "confirmed"},
            "url_risk_group_ids": {suspected: [], confirmed: []},
            "risk_group_ids": [],
        }
        errors: list[str] = []
        targeted_validator._validate_module(module, "homepage", set(), "module", errors)
        self.assertTrue(any("confirmed homepages must precede suspected" in item for item in errors))

    def test_user_named_video_with_no_signal_does_not_fabricate_hit(self) -> None:
        row = {
            "platform_key": "youtube",
            "item_id": "clean-user-lead",
            "url": "https://www.youtube.com/watch?v=cleanlead00",
            "content_type": "video",
            "title": "用户点名但未命中",
            "text": "简介已检查。",
            "media_kinds": ["video"],
            "review_status": "reviewed",
            "risk_decision": "no_risk",
            "risk_group_id": "",
            "review_reason": "完成全时间线检查，未发现用户所述风险信号。",
            "selection_basis": ["user_risk_lead"],
            "attribution": "subject_original",
            "video_review": {
                "mode": "targeted_10s_timeline",
                "title_reviewed": True,
                "cover_reviewed": True,
                "description_reviewed": True,
                "rapid_scrub_reviewed": True,
                "full_timeline_reviewed": True,
                "max_interval_seconds": 10,
                "semantic_segment_reviewed": False,
                "full_audio_reviewed": False,
                "hit_timestamps_seconds": [],
            },
        }
        errors: list[str] = []
        validate_targeted_item_review(row, prefix="row", valid_group_ids={"risk-001"}, errors=errors)
        self.assertEqual(errors, [])

    def test_obvious_video_url_cannot_be_downgraded_to_plain_content(self) -> None:
        risk_route = next(
            row for row in self.payload["platforms"]["youtube"]["research_completion"]["route_results"]
            if row["flagged_items"]
        )
        row = json.loads(Path(risk_route["flagged_item_ledger_path"]).read_text(encoding="utf-8"))
        row["content_type"] = "post"
        row["media_kinds"] = []
        row["video_review"] = None
        errors: list[str] = []
        validate_targeted_item_review(row, prefix="row", valid_group_ids={"risk-001"}, errors=errors)
        self.assertTrue(any("selected video requires targeted video review" in item for item in errors))

    def test_video_time_values_must_be_finite(self) -> None:
        broken = copy.deepcopy(self.payload)
        risk_route = next(
            row for row in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if row["flagged_items"]
        )
        ledger = Path(risk_route["flagged_item_ledger_path"])
        row = json.loads(ledger.read_text(encoding="utf-8"))
        row["video_review"]["max_interval_seconds"] = float("inf")
        row["video_review"]["hit_timestamps_seconds"] = [float("nan")]
        ledger.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
        risk_route["flagged_item_ledger_sha256"] = digest(ledger)
        errors = self.errors(broken)
        self.assertTrue(any("must be within 10 seconds" in item for item in errors))
        self.assertTrue(any("must be non-negative numbers" in item for item in errors))

    def test_detailed_video_interval_must_be_ten_seconds_or_less(self) -> None:
        broken = copy.deepcopy(self.payload)
        risk_route = next(
            row for row in broken["platforms"]["youtube"]["research_completion"]["route_results"]
            if row["flagged_items"]
        )
        ledger = Path(risk_route["flagged_item_ledger_path"])
        row = json.loads(ledger.read_text(encoding="utf-8"))
        row["video_review"]["max_interval_seconds"] = 11
        ledger.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
        risk_route["flagged_item_ledger_sha256"] = digest(ledger)
        self.assertTrue(any("within 10 seconds" in item for item in self.errors(broken)))


if __name__ == "__main__":
    unittest.main()
