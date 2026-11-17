# Research Handoff Contract

> 2026-11-17 工具规则更新：浏览器执行以 [当前访问规则](../../background-check-research/references/access-policy.md) 为准，仅使用 Ego；TaskSpace 关闭或消失可直接新建 Agent 自有空间。下文 Edge 及 edge_* 名称仅供旧包兼容读取，不再授权选择、启动或切换到 Edge、web-access/CDP。

路径示例中的 `<WORKSPACE>` 表示安装后解析出的工作区，不是可直接提交给工具的字面值。实际运行时从 `BACKGROUND_CHECK_WORKSPACE` 取得根目录，使用路径拼接生成绝对路径；这些本机运行记录留在被 Git 忽略的任务目录中。

> **版本路由：本文件是旧 `schema 1.10` 的 `exhaustive_audit` 严格契约。默认三小时定向模式使用 `schema 1.11 + research_profile: three_hour_targeted_v1`，必须改读 [三小时定向交接契约](handoff-targeted-contract.md)。两套完成语义不得混用。**

> 以下调查通道规则只描述旧 `exhaustive_audit`：网页使用带持久用户配置与登录态的真实、可见、可交互桌面浏览器 UI；十四个平台桶均须至少有一条完成的真实桌面浏览器 UI 必访路线。默认由执行者自主启动或选择 Microsoft Edge、创建任务页并导航，不要求用户预开 Edge、指定页签或提供 endpoint／target；用户明确指定或已确认另一系统桌面浏览器具备所需持久配置／登录态时可以使用，Chrome 不按名称禁用。Codex 内置／in-app／`iab`／临时 hosted／headless 浏览器不能承担这些路线。新研究包优先写 `tool_kind: browser_ui`；旧值 `microsoft_edge_visible` 继续兼容。公开 API／获授权导出可独立完成其许可范围内具体 surface 的穷尽证据，不要求用浏览器重复同一 surface 的逐项遍历，但不能替代平台桶的桌面浏览器 UI 必访。下文保留的 `edge_*` 字段、`max_task_open_edge_pages`、`edge-route-evidence-1.2` 和 `network-preflight-1.4` 名称均为 schema 1.10 兼容字段名，语义适用于实际使用的合格持久桌面浏览器；API／导出使用各自的来源、分页终点及逐项复核证据。定向模式的详细范围与登录后续跑规则见新契约。

The research skill writes one UTF-8 JSON file, normally:

`$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\<对象名>\process\delivery\research_payload.json`

Evidence files remain in the same target folder as internal working material. The payload is the complete factual source for the delivery skill; it is not final report prose, a user-facing attachment, or an additional deliverable. The default final deliverable is only the verified Feishu cloud document.

## Required Top-Level Fields

```json
{
  "schema_version": "1.10",
  "subject": {},
  "verdict": {},
  "accounts": [],
  "representative_works": [],
  "risk_summary_order": [],
  "risk_groups": [],
  "platforms": {},
  "coverage": {},
  "qa": {}
}
```

Version `1.10` uses fail-closed, route-isolated visible persistent-desktop-browser traversal, adaptive identity-first native search, authoritative user-risk-lead routing, two-layer evidence-bound video review, selected suspected-homepage state, an authoritative user-supplied homepage list, and reproducible candidate and account-video Top-10 ranking from hashed reconciliation ledgers. Every required surface must have a completed permitted route, and every one of the fourteen platform buckets must contain at least one completed `browser_ui` or legacy `microsoft_edge_visible` route proving the platform was actually visited. Webpage operations use a real visible persistent desktop browser UI; sufficiently covering public API/export routes may independently complete a specific surface without duplicating that surface's exhaustive traversal in the browser, but they never replace the separate per-platform browser visit. The executor defaults to independently starting or selecting Microsoft Edge and navigating a task page without requiring the user to pre-open Edge, choose a tab, or provide an endpoint/target. A user-specified or already verified persistent system desktop browser may be used instead; Chrome is not banned by product name. Codex built-in/in-app/`iab`, temporary hosted, headless, or other plainly non-persistent browser identities are invalid. Independent platforms or surfaces may be investigated concurrently by different agents in multiple visible browser tabs or windows. Each browser route is bound to exactly one physical page through its window/page continuity ids, and two routes may not operate the same page during overlapping intervals; a route never jumps to another page mid-review. `max_task_open_edge_pages` is a compatibility field whose generic meaning is the positive task-wide observed maximum number of task-owned interactive-browser pages, not an Edge-only restriction or fixed limit. A newly opened tab or site-forced popup does not inherit the active route: close an accidental popup without using it, or assign a deliberate independent review its own route, page id and `surface_start` evidence. The fourteen platform buckets may run in any order and overlap. Official APIs, authorized exports and approved research products can establish complete coverage for their permitted surfaces and run concurrently when their authorization and evidence requirements are met. Static snippets remain discovery evidence only. A login wall is resolved only after the user personally completes login on that route's same physical browser page；the legacy-compatible resolver may restart from `surface_start` or continue from the recorded checkpoint with `checkpoint_resume`, and unrelated platform routes may continue meanwhile. Credentials, cookies, tokens, private endpoints and login-bypass techniques remain prohibited.

Schema `1.9` is explicitly rejected. Upgrade any older package to `1.10` only from genuine query, item, detail-page, ranking, frame, and audio evidence: add the task's real `coverage.native_search_sentinel_groups` and `coverage.user_risk_leads`, retain full risk-term hashes, classify each completed search route from its actual `keyword_groups_covered`, add each item's observed `media_kinds`, add every real video's exact `video_metadata` and `review_evidence.video_triage`, and provide the hashed frame-manifest and continuous audio-timeline JSONL files for every item that actually triggers detailed review under the two-layer rule. `user_risk_leads` may be `[]` only after the original user request has been checked and found to contain no concrete lead. Never invent or backfill metadata, triage, play counts, native ranks, native-order evidence, sentinel coverage, or user leads; never convert a bounded sample into a natural endpoint, relabel a video or mixed-media post as generic content, or infer media kinds, frame/audio review, interactive-browser use, route continuity, login completion, supplied-page coverage, or suspected-homepage status. Every older version requires rerun or evidence-based migration; no compatibility shim may silently fabricate these fields, proofs, ranks, or manifests.

### `subject`

Required and exact: `display_name`, `subject_type`, `category`, `basic_info`, `basic_info_source_urls`, `report_date`, `aliases`, `user_supplied_homepages`, and `scope`. `subject_type` is one of `person`, `organization`, `company`, `brand`, `project`, or `other_entity`; `category` is copied exactly into the “类别” card; `basic_info` is copied into “简介”; `basic_info_source_urls` is a non-empty, unique list of the exact source URLs supporting that introduction and must be contained in `coverage.source_inventory`; `report_date` is a real zero-padded ISO `YYYY-MM-DD` date and deterministically produces the title `M.D-display_name` without leading zeroes. Scope is mandatory so delivery cannot silently broaden a person, band, project, brand, or company request:

```json
{
  "display_name": "音速行星",
  "subject_type": "project",
  "category": "音乐项目",
  "basic_info": "公开活动以电子音乐创作为主。",
  "basic_info_source_urls": ["https://example.com/official-profile"],
  "report_date": "2026-09-02",
  "aliases": ["Sonic Planet"],
  "user_supplied_homepages": [
    {
      "platform_key": "domestic_other",
      "subplatform": "示例平台",
      "input_url": "https://profile.example.cn/u/123",
      "canonical_url": "https://profile.example.cn/u/123",
      "canonicalization_route_id": ""
    }
  ],
  "scope": {
    "unit": "乐队／音乐项目整体",
    "included": ["项目官方账号与项目公开内容"],
    "excluded": ["成员个人身份、账号、发言及风险"]
  }
}
```

`user_supplied_homepages` is a required list and may be empty only when the user supplied no page. Each distinct `input_url` appears exactly once; multiple supplied inputs may legitimately resolve to the same `canonical_url` and account. Each row preserves the original input and the delivered canonical URL. When they are identical, `canonicalization_route_id` is empty. When they differ, that id must reference exactly one completed interactive-browser `linear_pass_index: 0` `account_discovery` route in the same platform bucket whose `account_or_query_url` and `evidence_origin` are the exact input URL and whose `resolved_url` equals the canonical URL; its compatibility-named `edge-route-evidence-1.2.final_visible_url` and validated full-window screenshot provide the auditable redirect/canonicalization evidence. A named-platform `input_url` must itself use that platform's native host or a controlled short-link host such as `b23.tv` or `youtu.be`; an extra-platform input and canonical URL must normalize to the same PSL/alias service slot. An unrelated cross-platform URL, an unproved replacement, or a route from another bucket is invalid. Each row must resolve through `canonical_url` to one `confirmed` or `suspected_homepage` account. Both URLs occur in `coverage.source_inventory` and in that account's `source_urls`. Existing account-to-module and completed-positive-wave route gates then prove that the resolved page was fully traversed while the discovery route proves the supplied entry was actually opened. `scope.unit` is non-empty text. `scope.included` is a non-empty list of explicit inclusion statements. `scope.excluded` is a list of explicit exclusion statements and may be empty only when there is genuinely no exclusion. Facts used in `basic_info` must be supported by `basic_info_source_urls`; there is no parallel free-form `facts` object. Delivery must honor `scope.excluded`; excluded people or entities may not appear as subject accounts, risk instances, or representative works unless the user expands scope.

### `verdict`

Required: `has_risk`, `result_level`, and `overall_conclusion`. `has_risk` must equal whether `risk_groups` is non-empty. `result_level` is the exact basic-information verdict and must be one of `建议谨慎评估`, `建议评估`, or `无合作风险`. Delivery copies this value exactly and does not infer a tier from risk count or prose.

Use the three tiers consistently:

- `无合作风险`: no credible risk group remains only after all fourteen platform completion gates pass (`has_risk=false`). Any unresolved access boundary blocks this verdict and the final document.
- `建议评估`: one or more credible contextual, content-fit, reputational, or moderate cooperation concerns remain and should be reviewed before cooperation, without verified severe/disqualifying evidence.
- `建议谨慎评估`: verified high-impact or repeated concerns under the maintained risk standard could materially affect cooperation, compliance, reputation, safety, or commercial trust and call for heightened caution.

`has_risk=false` must pair with `无合作风险`; `has_risk=true` must pair with `建议评估` or `建议谨慎评估`. Risk count alone never decides between the latter two.

A finding from a selected suspected homepage remains in the risk package and may affect the cooperation verdict, but it is not rewritten as a verified act of the subject. Its instance fact begins with `该疑似主页账号`; that risk group's `summary` and `explanation`, and `verdict.overall_conclusion`, each contain `疑似主页` so the top summary and conclusion preserve the identity uncertainty.

### `accounts`

Each confirmed or candidate subject account records exactly: `platform_key`, `subplatform`, `subplatform_entry_id`, `url`, `handle`, `status`, `identity_basis`, and `source_urls`. `status` is one of `confirmed`, `suspected_homepage`, `unconfirmed_candidate`, or `excluded_candidate`. Named-platform accounts leave both extra-platform fields empty. Every extra-platform record stores the visible service name in `subplatform`; a `confirmed` or `suspected_homepage` extra-platform account also stores the matching stable homepage-entry id in `subplatform_entry_id`, while an unconfirmed/excluded candidate leaves that id empty because it has no Chapter 4 homepage module. Every delivered extra account must match one existing `subplatforms` entry by bucket, id, visible name, exact URL, and per-URL identity status; orphan ids are invalid. Duplicate account URLs are invalid.

Identity classification and scope are deterministic:

- User-supplied homepages and publicly cross-linked associated accounts are included. Exact visible name plus at least one valid non-name anchor—field, content theme, work/history, language style, avatar/visual cue, associated person, location, or equivalent—supports `confirmed`. A public “all platforms use this name” statement is a weak supporting signal only and does not remove the suspected label by itself.
- Exact name with empty, unrelated, or insufficient content and no explicit identity conflict may be selected as `suspected_homepage`. Content differences alone are not exclusion evidence. Every actual platform permits at most one automatically selected suspect, and only when that slot has no user-supplied suspected page. User-supplied pages are all retained and may therefore yield several labeled suspected pages on one platform. For extra platforms, the automatic cap is calculated across both `domestic_other` and `overseas_other` from the bundled libpsl executable's built-in Public Suffix List plus controlled hosted-service and cross-domain aliases, never from the editable visible `subplatform` name. Missing PSL support blocks validation.
- Only the highest-similarity unresolved account is selected. Other hits remain `unconfirmed_candidate` internal leads and have no Chapter 4 homepage module. If a common name produces many exact-name accounts with no differentiating anchor or clear highest-similarity candidate, select none and use `no_account_after_multiroute_search`, meaning no credibly attributable account. That absence is itself an adaptive-search upgrade trigger, so every completed native-search route for that platform must cover the full keyword-group set.
- Use `excluded_candidate` only when public evidence explicitly identifies another subject or contains a material identity conflict. An `out_of_scope` member/staff/related-person lead is not a subject account and stays only in internal coverage notes; it may not appear in risk instances, works, or delivered prose.

Automatic candidate choice is not a free-text assertion. Every non-user-supplied account URL must appear with controlled `item_kind: account_candidate` and matching `content_type: account_candidate` in at least one completed final reconciliation-wave item ledger. Every non-empty `account_discovery` row, every row typed as an account/profile/channel, and every recognizable account-homepage URL returned by a platform or general search must use that candidate form; this includes named-platform account paths and high-confidence paths or tenant roots on controlled extra-platform services, such as Spotify `/artist/`, Pixiv `/users/`, LinkedIn `/in/`, Skland `/profile?id=`, and a Bandcamp creator subdomain root. Content paths such as Spotify `/track/`, Pixiv `/artworks/`, and Bandcamp `/track/` remain ordinary content. In a general-search ledger, a recognizable named-platform homepage uses that URL-attributable named `candidate_platform_key` and competes in the named platform's candidate pool; a controlled extra-platform homepage retains the other-bucket key and its service name. A candidate later resolved as confirmed or selected suspected must also produce the corresponding platform homepage module and completed positive-wave traversal. Each candidate row resolves to one `accounts` record. The row's `author` is the visible account name; the validator compares it directly with the subject display name and confirmed aliases after only trimming outer whitespace and a display-only leading `@`, derives `name_match: exact_display_name | exact_alias | other`, and rejects a contradictory hand-entered classification. Boolean `all_platform_name_claim` and `explicit_identity_conflict`; exact anchor keys `direct_crosslink`, `field`, `content_theme`, `works_history`, `language_style`, `avatar_visual`, `associated_person`, and `location`, each set to `none`, `weak`, or `confirming`; and a unique `evidence_urls` list. Any asserted all-platform claim, non-`none` anchor, or explicit conflict requires at least one real evidence URL already present in `coverage.source_inventory`. The validator recomputes `similarity_score` as 100 for exact display name, 90 for exact alias, 0 for other, plus 1 for the all-platform claim and 0/1/10 for each anchor strength. A confirming anchor requires `confirmed`; an explicit conflict requires `excluded_candidate`; among remaining exact-name automatic candidates, the unique highest score must be the sole automatically selected `suspected_homepage`. A tied maximum selects none and leaves those rows `unconfirmed_candidate`. Repeated observations may strengthen but never discard a previous name match, claim, anchor, or conflict; the completed final reconciliation-wave evaluation must preserve the strongest evidence seen. User-supplied pages are authoritative inputs rather than automatic candidates: all supplied suspected pages remain deliverable, and the presence of any one of them in an actual-platform slot prevents adding an automatic suspect without limiting the number of supplied pages.

### `representative_works`

Each work records `title`, `role`, `client_or_publisher`, `source_url`, and `notes`. Do not infer roles that the source does not support.

## Required Platform Keys

`platforms` must contain exactly these fourteen top-level keys:

1. `weibo`
2. `bilibili`
3. `douyin`
4. `xiaohongshu`
5. `zhihu`
6. `netease_music`
7. `tieba`
8. `douban`
9. `domestic_other`
10. `x`
11. `facebook`
12. `instagram`
13. `youtube`
14. `overseas_other`

Extra domestic services appear only in `domestic_other.subplatforms`; extra overseas services appear only in `overseas_other.subplatforms`. Examples include Threads, TikTok, Pixiv, Spotify, Bandcamp, Bluesky, Patreon, Gumroad, LinkedIn, IMDb, Vimeo, official sites, portfolios, and wikis.

Each `subplatforms` entry is one actual extra-platform homepage module and contains:

```json
{
  "entry_id": "bandcamp-main",
  "name": "Bandcamp",
  "homepage": {
    "status": "confirmed",
    "urls": ["https://artist.bandcamp.com/"],
    "url_identity_statuses": {"https://artist.bandcamp.com/": "confirmed"},
    "url_risk_group_ids": {"https://artist.bandcamp.com/": []},
    "risk_group_ids": []
  },
  "research_completion": {}
}
```

`entry_id` is a stable, bucket-unique lowercase id using `a-z`, digits, `_`, or `-`; `name` is the visible platform name. Duplicate visible names are allowed for multiple confirmed homepages on the same service, but their `entry_id` values differ. Suspected-homepage allowance is calculated across both other-platform buckets from the canonical URL's PSL-derived registrable-service domain plus controlled hosted-service and cross-domain aliases—not from `name`. Thus `Pixiv`, `pixiv.net`, `www.pixiv.net`, and the controlled `pixiv.me` alias share one actual-platform slot; so do different user subdomains such as `alice.bandcamp.com` and `bob.bandcamp.com` or `alice.weebly.com` and `bob.weebly.com`. They cannot create duplicate automatic suspects by changing labels, subdomains, or buckets. Unrelated registrable domains remain distinct; add a controlled cross-domain alias before delivery when one service genuinely uses several registrable domains. Missing bundled PSL support is a delivery blocker. An extra URL that belongs to one of the fourteen named platform domains is invalid in an other-platform bucket. `homepage.status` is `confirmed` or `suspected`, and every entry contains exactly one homepage URL plus the matching `url_identity_statuses` value. Its route module key is `subplatform:<entry_id>`; delivered accounts use the same `subplatform_entry_id`, and risk instances retain the visible `subplatform` name while targeting that entry-specific module key. `research_completion` follows the same route/item-ledger rules as a named platform. A discovered extra platform that remains blocked blocks the entire parent `其他` bucket. Zero actual extra homepages means an empty list; one means one entry; never create placeholders.

Every platform record contains:

```json
{
  "display_name": "微博",
  "discovery_status": "confirmed_account",
  "risk_group_ids": [],
  "subplatforms": [],
  "delivery_modules": {},
  "research_completion": {}
}
```

### `research_completion`

Every platform must prove that every Chapter 4 surface reached a defensible, item-by-item conclusion rather than stopping at a login wall or bounded sample:

```json
{
  "status": "complete",
  "homepage_review": "exhausted",
  "native_search_review": "exhausted",
  "route_results": [
    {
      "route_id": "weibo-homepage-timeline-browser-ui",
      "module_key": "homepage",
      "surface": "timeline",
      "route_family": "browser_ui_surface",
      "evidence_origin": "https://weibo.com/u/123456",
      "evidence_fingerprint": "64位小写SHA-256，由结果日志中全部原始证据SHA-256及适用时的浏览器路线清单SHA-256排序派生",
      "account_or_query_url": "https://weibo.com/u/123456",
      "resolved_url": "https://weibo.com/u/123456",
      "serial_route_index": 1,
      "linear_pass_index": 1,
      "tool_name": "Microsoft Edge",
      "tool_version": "当次可见桌面会话",
      "tool_kind": "browser_ui",
      "tool_path": null,
      "tool_sha256": null,
      "permission_basis": "用户亲自控制登录，Codex 仅在真实可见的交互式浏览器中进行普通只读遍历。",
      "official_product": "",
      "official_endpoint": "",
      "authorization_status": "not_required_browser_ui",
      "authorization_evidence": null,
      "edge_session_state": "public_visible",
      "edge_window_continuity_id": "9bd9d6e9-d8ad-4bce-a9c8-3b53a935d62a",
      "edge_page_continuity_id": "6f3ca92b-7226-46a1-91e1-9d19ec9d57d8",
      "max_task_open_edge_pages": 1,
      "user_login_completed_at": null,
      "edge_evidence_path": "<WORKSPACE>/.../weibo/timeline-browser-evidence.json",
      "edge_evidence_sha256": "64位小写SHA-256",
      "status": "complete",
      "termination": "cursor_exhausted",
      "discovered_items": 146,
      "reviewed_items": 146,
      "unreviewed_items": 0,
      "result_log_path": "<WORKSPACE>/.../weibo/profile-status.json",
      "item_ledger_path": "<WORKSPACE>/.../weibo/profile-items.jsonl",
      "item_ledger_sha256": "64位小写SHA-256",
      "query_ledger_path": null,
      "query_ledger_sha256": null,
      "aliases_covered": [],
      "keyword_groups_covered": [],
      "resolved_by_route_ids": [],
      "risk_terms_sha256": "64位小写SHA-256",
      "started_at": "2026-09-02T09:00:00+08:00",
      "completed_at": "2026-09-02T10:30:00+08:00",
      "boundary": ""
    }
  ],
  "unreviewed_relevant_hits": 0,
  "completion_note": "所有必需主页与搜索表面均逐帖到自然终点，发现数与复核数一致。"
}
```

Rules:

- Final handoff accepts only `status: complete`. `blocked_unresolved` is an internal in-progress state and is a delivery blocker.
- `homepage_review` is one of `exhausted`, `not_found_after_multiroute`, or `not_applicable`; `native_search_review` is `exhausted` or `not_applicable`. A final payload cannot contain `incomplete`.
- Every attempted acquisition route is a `route_results` record. `route_id` is unique across the entire payload, including parent and subplatform completions. `status` is `complete`, `blocked`, or `failed`; failed/blocked routes remain in the audit trail but do not count as coverage. A completed route has an empty `boundary` and empty `resolved_by_route_ids`. Every blocked/failed route has an exact boundary and one or more `resolved_by_route_ids`; each resolver must be complete and cover the same module, account/query URL, and `surface`.
- `serial_route_index` is retained as a compatibility field and is only a globally unique route-record ordinal. Its values are exactly `1..N`, with no duplicate, gap, or reuse, but the number does not assert start order, finish order, or non-overlap. Route-array order likewise does not control execution.
- At least one route with `linear_pass_index: 0` is required for identity/account-graph discovery. The legacy field name is retained, but it is now a wave marker rather than a linear-execution command: wave `0` is reserved for `account_discovery`; any positive value marks a detailed coverage or reconciliation wave. Positive waves need not be consecutive, need not start at Weibo, need not contain every platform, and may run platforms or independent surfaces concurrently. `coverage.final_linear_pass_index` equals the highest positive wave and identifies the final account-candidate reconciliation wave, not an instruction to rerun all fourteen platforms.
- Every completed positive-wave route may satisfy required-surface coverage, independent clean-route gates, risk item-ledger links, discovery status, or Chapter 4 data. Earlier positive waves remain valid unless a later route explicitly supersedes or resolves them. Every candidate observed in any route must still be re-evaluated with its strongest accumulated evidence in a completed route bearing `coverage.final_linear_pass_index`. Newly discovered accounts or required surfaces are added to the relevant platform work queue and may be processed immediately by a free worker; the final payload still requires all fourteen buckets complete and `pending_cross_platform_leads: []`.
- `module_key` is the exact Chapter 4 module key (`homepage`, `keyword_search`, `topic`, and so on), or `subplatform:<entry_id>` for an extra-platform homepage. `tool_name` and `tool_version` identify the actual tested route. A new webpage route uses `tool_kind: browser_ui`, the actual non-empty persistent desktop-browser name in `tool_name`, and `route_family: browser_ui_surface`, `browser_ui_index_discovery`, `browser_ui_crosslink_discovery`, or `browser_ui_institutional_discovery` as applicable. Default operation records the independently opened or selected Microsoft Edge session. A user-specified or verified persistent system desktop browser such as Chrome may record its actual name；a name plainly identifying Codex built-in／in-app／`iab`／temporary hosted／headless or another temporary browser is invalid. Existing schema 1.10 packages may continue to use `tool_kind: microsoft_edge_visible`, `tool_name: Microsoft Edge`, and the matching `microsoft_edge_visible_*` family. `manual_visible_browser` and `hosted_browser` remain outside the schema 1.10 enum. `local_script`, `official_api`, and `authorized_export` may directly establish a specific surface's completion using their own verified scope, provenance, natural-end and review evidence；这不解除每个十四平台桶至少一条完成的 `browser_ui` 或 legacy `microsoft_edge_visible` 必访路线。A local script requires an absolute `tool_path` and matching `tool_sha256`; every non-local route uses `null` for both fields.
- Every `browser_ui` or legacy `microsoft_edge_visible` route has `edge_session_state` equal to `public_visible`, `login_required`, or `user_login_completed`; canonical lowercase UUIDv4 values in `edge_window_continuity_id` and `edge_page_continuity_id`; a positive integer `max_task_open_edge_pages`; a timezone-bearing `user_login_completed_at` present only for `user_login_completed`; and `edge_evidence_path` plus `edge_evidence_sha256` identifying a validated, compatibility-named `edge-route-evidence-1.2` manifest. The `edge_*` and `max_task_open_edge_pages` names are retained only for schema compatibility: they identify the actual interactive browser window/page and the task-wide observed browser-page maximum regardless of browser product. The route records its entered `account_or_query_url` and actual `resolved_url`; the manifest repeats the latter as `final_visible_url`. Multiple routes may use different window/page ids. One page id is permanently bound to one physical browser page and one window id; it is not a reusable label for whichever tab happens to be open. Two routes with the same page id must have non-overlapping timezone-bearing intervals, while different pages, windows, platforms, independent surfaces, official APIs and authorized exports may overlap. `max_task_open_edge_pages` is the same positive task-wide observed maximum on all research browser routes and must not understate the parallel-page peak proven by route intervals. A route stays on its assigned page from the manifest-declared `surface_start` or `checkpoint_resume` to terminal evidence. Navigating that page within the surface is allowed；changing to another tab/window mid-route or assigning its id to a replacement page breaks continuity. A deliberate new parallel page receives a new page id and its own route；an accidental popup is closed without being read or adopted. These ids are random, non-sensitive labels and must contain no account name, email, Cookie, token, session value, profile identifier, or other credential/account data. A login-boundary route uses `login_required` and cannot complete. Non-browser routes set `edge_session_state`, `edge_window_continuity_id`, `edge_page_continuity_id`, `max_task_open_edge_pages`, `user_login_completed_at`, `edge_evidence_path`, and `edge_evidence_sha256` to `null` and require `resolved_url` to equal `account_or_query_url`.
- `route_family` uses only the validator's controlled values: `browser_ui_surface`, `browser_ui_index_discovery`, `browser_ui_crosslink_discovery`, `browser_ui_institutional_discovery`, the four legacy `microsoft_edge_visible_*` values, `official_api`, `authorized_export`, and `approved_research_product`. `evidence_origin` is the actual visible URL or official endpoint, and `evidence_fingerprint` is derived from all raw-evidence hashes plus the compatibility-named browser-evidence hash when applicable. There is no free-form `independence_group`. For a clean conclusion, the validator counts two routes only when both their controlled upstream provenance and their evidence fingerprints are different; changing a label or reusing the same file cannot manufacture independence.
- Every route records non-empty `permission_basis`, plus text fields `official_product` and `official_endpoint`. `authorization_status` is `not_required_browser_ui`, legacy `not_required_edge_visible`, `public_official_api`, `approved_app_permission`, `approved_research_access`, `written_platform_permission`, `authorized_export`, or `permission_missing`. A visible interactive-browser review normally uses `not_required_browser_ui`; the legacy alias may retain `not_required_edge_visible`. Both use a null `authorization_evidence`. Every completed non-browser route carries a sanitized, hashed local `authorization_evidence` record (`kind`, official `source_url`, `path`, `sha256`, `verified_at`) matching its authorization status. Permission missing always blocks completion. User consent to use a login session and a GitHub code license do not grant platform automation permission.
- Every route has a real UTF-8 JSONL item ledger and matching lowercase `item_ledger_sha256`; a zero-item route still uses an existing, hashed empty file. A completed route also has a real result log, reaches only `natural_end`, `cursor_exhausted`, or `empty_result_after_full_query`, and satisfies `discovered_items == reviewed_items` with `unreviewed_items == 0`.
- `surface` is not free text. It must be one canonical required surface from the validator's `SURFACE_MATRIX`. Every required surface is accounted for even when its tab/category is absent; an absent surface uses a completed zero-item route with terminal evidence, not omission. Examples include B站 `dynamics/videos/articles/live_replays/collections_courses`, X `posts/replies/reposts_quotes/media`, Instagram `posts/reels/highlights/tagged`, and YouTube `videos/shorts/live_archives/community_posts/public_playlists`.
- `result_log_path` is not a free-form status note. It is UTF-8 JSON using `schema_version: route-evidence-1.4`, repeats the route id, module, provenance, evidence fingerprint, entered URL, `resolved_url`, `serial_route_index`, `linear_pass_index`, permission record, all compatibility-named browser-session/page fields, status, termination, counts, `item_ledger_sha256`, `query_ledger_sha256`, resolver ids and timestamps exactly, and contains a non-empty `raw_evidence` list. Each raw entry has `path`, `sha256`, and `kind`; the file must exist under `$env:BACKGROUND_CHECK_WORKSPACE` and match its hash. The route-level browser manifest and its captured artifact are separately validated through `edge_evidence_path`; the route fingerprint is derived from every raw-evidence hash plus `edge_evidence_sha256`. A completed route may end at a different URL only when it is the explicitly referenced user-supplied canonicalization route; ordinary completed routes require identical start and final URLs. Blocked/failed routes preserve the actual login or verification destination. A completed route is rejected when machine-control fields in attached JSON evidence still say partial, blocked, failed, login wall, fixed cap, nonzero exit code, or forbid a negative conclusion.
- `max_pages`, `max_items`, `max_scrolls`, `max_comments`, `sample_complete`, `first_page_only`, `repeated_page_state`, `no_cursor`, HTTP/API errors, non-JSON, login walls, captcha, rate limits, timeouts, collector errors, and manual stops are never valid completion terminations.
- A login wall, challenge shell, empty anonymous page, 403, 418, 429, collector error, empty output file, or process exit code 0 never supports a clean conclusion by itself.
- If a visible interactive-browser route reaches a login wall, login redirect, verification page, or “登录后查看” state, preserve that exact failed-route evidence and stop automated input on that route only. Keep its assigned browser page open and ask the user to complete the account, password, captcha and two-factor steps personally on it; other independent routes may continue on their own pages. Do not read, fill, capture or store credentials; do not extract or replay cookies/tokens; do not use private endpoints, credentials extraction, session replay, or a replacement page to bypass login. The blocked/failed route keeps its own real, hashed item ledger containing every item reviewed before the wall；if no item was visible, keep an existing, hashed empty JSONL file. After the user confirms completion, use the same physical browser window/page ids and the exact original entry URL. The resolver need not be the next global record and may use a later positive wave；it must start after the boundary route ends and be one completed `browser_ui` or legacy `microsoft_edge_visible` route with `edge_session_state: user_login_completed`, matching module/surface/entry URL, the same `edge_window_continuity_id` and `edge_page_continuity_id`, valid time ordering, and either `review_start_mode: checkpoint_resume` or the legacy-compatible `surface_start`. `checkpoint_resume` continues from the next item after the saved checkpoint；its post-login ledger must not duplicate any pre-login `(item_id, URL)` pair, and the validator merges both ledgers for risk, decision, candidate and video-coverage gates. Legacy `surface_start` remains valid only when the resolver ledger contains every pre-login pair. A complete API/export route may supplement the same scope but cannot resolve or replace the blocked webpage route；index snippets alone cannot.
- Feishu delivery starts only after every research route has ended and the payload has passed validation; its tabs/windows are outside the research-route parallel-evidence schema and therefore receive no `serial_route_index`, `linear_pass_index`, or research `edge_page_continuity_id`. The sole delivery executor may keep one or more controlled read-only reference pages and may accept a generated document in a new browser tab or window. The generated document always has exactly one writer: never edit, read back, or validate the same document token concurrently from multiple workers or pages. Keep the source template page open until the generated document page actually exists, and never close the sole or last browser tab. Do not close, repurpose, navigate, or otherwise interfere with any user-owned page. If Feishu navigates the current controlled page instead, continue there; if it opens a new controlled page, confirm that page is the generated document before releasing an obsolete controlled template page.
- An alternate route resolves a blocked route only when it covers the same required surface to a natural endpoint and produces the same per-item evidence. A search snippet, metadata card, cached first page, mirror, or second empty collector is not an equivalent substitute for a homepage timeline.
- Every required search surface and every delivered confirmed or suspected homepage URL surface must have at least one completed permitted route in any positive coverage wave. A named platform's `not_found` conclusion must include a completed platform-native `account_discovery` route through an interactive browser UI or a permitted API in a positive wave. API／导出可承担该 discovery 或其他具体 surface 的穷尽证据，但无论各 surface 使用何种许可路线，每个十四平台桶仍须另有至少一条完成的 `browser_ui` 或 legacy `microsoft_edge_visible` 必访路线。Every clean search surface, clean delivered homepage URL surface, and not-found discovery conclusion also requires at least two genuinely independent completed positive-wave routes as derived from controlled provenance and non-reused raw evidence, zero unreviewed relevant hits, complete applicable review, and real ledgers. A risk on one URL/module never waives complete evidence or independent clean-conclusion checks on another URL/module. The removed self-reported `negative_conclusion_eligible` flag must not appear in schema `1.10`; the validator derives support directly from evidence.
- A risk hit does not waive completion. The platform still must resolve or exhaust the remaining applicable public surfaces so additional credible risks are not silently omitted.
- If the platform cannot reach `complete`, stop the final workflow. Never convert the boundary into `无问题`, `无相关内容`, `无个人主页`, or a low-risk verdict.
- For every `confirmed` or `suspected_homepage` account URL in top-level `accounts`, the matching platform has a completed route for every canonical homepage surface with the same `account_or_query_url`. For every confirmed topic/person page or delivered extra-platform homepage, the corresponding surface matrix is likewise required.
- For every required search module, a completed search route uses a real native-platform URL on the correct platform domain with search semantics; Baidu and Google use their actual general-search domains. The exact displayed module URL must itself be one of the completed query-ledger URLs, and every logged query is exhausted. Fixed display URLs do not replace the full internal query ledger.
- X `review_start_month` is not trusted as free text. When any confirmed or suspected X homepage is delivered, every reviewed homepage item must have a parseable date and the validator derives the earliest month across every delivered X homepage route ledger; the claimed `YYYY-MM` must equal that month. A delivered but undated/empty X homepage cannot be finalized under Chapter 4.
- Every completed search route lists every `aliases_covered`, the route's actual `keyword_groups_covered`, the exact full `risk_terms_sha256`, and a hashed `query_ledger_path`. `aliases_covered` always equals `coverage.aliases_checked`. Baidu and Google routes always use the complete `coverage.keyword_groups_checked`. A named-platform route uses exactly either `coverage.native_search_sentinel_groups` (adaptive identity-first route) or `coverage.keyword_groups_checked` (full route); do not add a redundant `search_strategy` field. The query ledger contains one identity-only query for every alias and the complete alias × that route's `keyword_groups_covered` product. Every canonical `query_text` also equals the actual native search input decoded from its `query_url`. Homepage-only routes use `null` query-ledger fields and empty alias/group lists.

The normalized file at `result_log_path` has this exact shape:

```json
{
  "schema_version": "route-evidence-1.4",
  "route_id": "weibo-homepage-timeline-browser-ui",
  "module_key": "homepage",
  "surface": "timeline",
  "account_or_query_url": "https://weibo.com/u/123456",
  "resolved_url": "https://weibo.com/u/123456",
  "route_family": "browser_ui_surface",
  "evidence_origin": "https://weibo.com/u/123456",
  "evidence_fingerprint": "64位小写SHA-256",
  "serial_route_index": 1,
  "linear_pass_index": 1,
  "tool_kind": "browser_ui",
  "tool_sha256": null,
  "permission_basis": "用户亲自控制登录，Codex 仅在真实可见的交互式浏览器中进行普通只读遍历。",
  "official_product": "",
  "official_endpoint": "",
  "authorization_status": "not_required_browser_ui",
  "authorization_evidence": null,
  "edge_session_state": "public_visible",
  "edge_window_continuity_id": "9bd9d6e9-d8ad-4bce-a9c8-3b53a935d62a",
  "edge_page_continuity_id": "6f3ca92b-7226-46a1-91e1-9d19ec9d57d8",
  "max_task_open_edge_pages": 1,
  "user_login_completed_at": null,
  "edge_evidence_path": "<WORKSPACE>/.../weibo/timeline-browser-evidence.json",
  "edge_evidence_sha256": "64位小写SHA-256",
  "status": "complete",
  "termination": "cursor_exhausted",
  "discovered_items": 146,
  "reviewed_items": 146,
  "unreviewed_items": 0,
  "item_ledger_sha256": "64位小写SHA-256",
  "query_ledger_sha256": null,
  "resolved_by_route_ids": [],
  "started_at": "2026-09-02T09:00:00+08:00",
  "completed_at": "2026-09-02T10:30:00+08:00",
  "raw_evidence": [
    {
      "path": "<WORKSPACE>/.../weibo/timeline-manual-review.json",
      "sha256": "64位小写SHA-256",
      "kind": "manual_review_log"
    }
  ]
}
```

`kind` is one of `collector_status`, `api_response`, `browser_snapshot`, `terminal_screenshot`, `manual_review_log`, or `authorized_export_manifest`. A normalized result log may not cite itself as raw evidence. A raw `browser_snapshot` is supplemental audit material only: it cannot serve as the required interactive-browser visual proof or network-preflight browser proof. The separate compatibility-named browser manifest and screenshot artifact are referenced by the route-level `edge_*` fields and must not be confused with this normalized route log.

The file at `edge_evidence_path` has this exact shape:

```json
{
  "schema_version": "edge-route-evidence-1.2",
  "route_id": "weibo-homepage-timeline-browser-ui",
  "account_or_query_url": "https://weibo.com/u/123456",
  "final_visible_url": "https://weibo.com/u/123456",
  "browser_family": "microsoft_edge",
  "window_mode": "visible",
  "edge_session_state": "public_visible",
  "edge_window_continuity_id": "9bd9d6e9-d8ad-4bce-a9c8-3b53a935d62a",
  "edge_page_continuity_id": "6f3ca92b-7226-46a1-91e1-9d19ec9d57d8",
  "max_task_open_edge_pages": 1,
  "serial_route_index": 1,
  "linear_pass_index": 1,
  "capture_scope": "full_visible_browser_window_with_tab_strip",
  "user_login_completed_at": null,
  "review_start_mode": "surface_start",
  "review_started_at": "2026-09-02T09:00:10+08:00",
  "captured_at": "2026-09-02T10:30:00+08:00",
  "artifact_path": "<WORKSPACE>/.../weibo/timeline-final-page.png",
  "artifact_sha256": "64位小写SHA-256",
  "artifact_kind": "browser_screenshot"
}
```

For a new `browser_ui` route, `browser_family` is non-empty and names the actual persistent desktop browser family；plainly Codex／in-app／`iab`／hosted／headless／temporary identities are invalid. `window_mode` is exactly `visible`, `max_task_open_edge_pages` is a positive integer with the generic compatibility meaning defined above, and `capture_scope` is exactly `full_visible_browser_window_with_tab_strip`. A legacy `microsoft_edge_visible` route remains valid only with `browser_family: microsoft_edge` and `capture_scope: full_visible_edge_window_with_tab_strip`. The full-window capture includes that route's browser tab strip and address bar so the artifact proves which assigned page and `final_visible_url` produced the terminal evidence；other task-owned browser pages or windows may exist for independent concurrent routes. The manifest route id, entered URL, final visible URL, record/wave indexes, browser session state, route-specific `edge_window_continuity_id`, route-specific `edge_page_continuity_id`, task-wide observed maximum page count, and user-login time must match `route_results`. Both continuity ids are canonical lowercase UUIDv4 values used only as random labels；they must never encode or contain an account, email, Cookie, token, session/profile identifier, or other credential data. A completed ordinary route uses `review_start_mode: surface_start`. A completed same-page login resolver may instead use `checkpoint_resume`; this mode is invalid without `edge_session_state: user_login_completed` and a matching blocked login route. `review_started_at` must be timezone-bearing, fall inside the route interval and, after a user-completed login, be at or after `user_login_completed_at`. `captured_at` and the separate artifact must also fall inside that interval. `artifact_kind` must be exactly `browser_screenshot`, and the separate artifact must be a real PNG, JPEG, or WebP image whose signature and SHA-256 match. JSON, HTML and `browser_snapshot` artifacts are forbidden as browser visual evidence. Never capture entered credentials, a captcha answer, two-factor code, Cookie, token or private request. A login-wall screenshot may show only the access-boundary state and must crop or redact credential fields and account identifiers.

`delivery_modules` is the authoritative handoff for the exact modules in Chapter 4 of the delivery Skill. A module record contains the final reproducible URL or URLs, its reviewed result state, and only the minimum data needed to render the fixed platform format. Use these common fields where applicable:

```json
{
  "homepage": {
    "status": "confirmed",
    "urls": ["https://example.com/profile", "https://example.com/secondary"],
    "url_identity_statuses": {
      "https://example.com/profile": "confirmed",
      "https://example.com/secondary": "suspected"
    },
    "url_risk_group_ids": {
      "https://example.com/profile": ["risk-001"],
      "https://example.com/secondary": []
    },
    "risk_group_ids": ["risk-001"]
  },
  "keyword_search": {"url": "https://example.com/search?q=Name", "result_status": "no_risk", "risk_group_ids": []},
  "topic": {"status": "not_found", "urls": [], "url_risk_group_ids": {}, "risk_group_ids": []},
  "review_start_month": "2024-06"
}
```

Account-homepage modules (`homepage` and `subject_homepage`) allow `status: confirmed`, `suspected`, or `not_found`. `confirmed` means at least one URL has `url_identity_statuses[url]=confirmed`; it may also contain all supplied suspected URLs or, when none was supplied, the platform's single automatically selected suspected URL. `suspected` means every URL is suspected and no confirmed URL exists. `not_found` has no URLs. Confirmed URLs come first and all suspected URLs come last. Topic/supertopic/Tieba-theme modules continue to allow only `confirmed` or `not_found` because they are related pages rather than subject accounts.

Every account-homepage module has `url_identity_statuses` whose keys exactly equal `urls` and whose values are `confirmed` or `suspected`; the map must match `accounts[].status` (`confirmed` or `suspected_homepage`) URL for URL. Every homepage-like module has `url_risk_group_ids` whose keys exactly equal `urls`; each URL has its own ordered risk-group list, and module-level `risk_group_ids` is exactly their union. This is mandatory because Chapter 4 renders the primary homepage, secondary confirmed pages, every user-supplied suspected page, and the optional automatically selected suspected homepage separately. Allowed final search result states are `risk`, `no_risk`, and `no_related_content`; `access_blocked` is an unfinished research state and is invalid in a final payload. URLs must be real HTTP(S) URLs and must not be placeholders. A search module with risks uses `result_status: risk`. `no_risk` means relevant result(s) were reviewed and therefore requires at least one `risk_decision: no_risk` item in the matching ledger. `no_related_content` permits only false-positive or out-of-scope reviewed rows, or a genuinely empty exhausted result. Both clean states have an empty risk list. Facts, screenshots, and direct post URLs remain in `risk_groups[].instances`; suspected-homepage instance facts begin with `该疑似主页账号` so their attribution boundary survives delivery.

Required module keys by platform:

- `weibo`: `homepage`, `keyword_search`, `topic`;
- `bilibili`, `douyin`, `xiaohongshu`, `zhihu`, `netease_music`, `facebook`, `instagram`, `youtube`: `homepage`, `keyword_search`;
- `tieba`: `homepage`, `topic_homepage`, `keyword_search`;
- `douban`: `subject_homepage`, `keyword_search`;
- `x`: `homepage`, `keyword_search`, `review_start_month`; use `YYYY-MM` for the earliest post actually checked on any delivered confirmed or suspected X homepage, or `null` when no X homepage is delivered;
- `domestic_other`: `baidu_search`; extra services remain in `subplatforms` and may be absent, singular, or repeated;
- `overseas_other`: `google_search`; extra services remain in `subplatforms` and may be absent, singular, or repeated.

网易云音乐关键词模块使用真实 `music.163.com/#/search/...` 结果 URL，fragment 含 `s` 或 `keywords` 查询；INS 使用真实 `instagram.com/explore/search/...` 结果 URL，带 `q` 查询。主页 URL 不能代替搜索模块。两者与其他具名平台一样，须有每个名称／别名的身份查询，以及名称×该路线实际 `keyword_groups_covered` 的查询台账；路线可在没有升级触发时采用哨兵组，也可直接采用完整风险词组。`native_search` 路线、逐项复核及无风险结论的独立来源证明可由覆盖充分的合规 API／导出或可见交互式浏览器完成；即使该 surface 由 API／导出完成，所属平台桶仍须另有至少一条完成的 `browser_ui` 或 legacy `microsoft_edge_visible` 必访路线。

For a person, the delivery layer renders confirmed homepage URLs as `个人主页` and suspected URLs as `疑似主页`. For an organization/company/brand it uses `官方主页` and `疑似官方主页`; for a project it uses `项目主页` and `疑似项目主页`. All suspected URLs appear after confirmed URLs and are never labeled as small accounts. A lone suspect uses the unnumbered label; multiple user-supplied suspects use `疑似主页1`, `疑似主页2` and the corresponding organization/project wording. Extra-platform suspected URLs render as `平台名疑似主页`. A common-name high-collision result with no selected URL renders through the ordinary no-homepage wording and exposes no candidate list.

There is no free-form platform `conclusion`. It was redundant and could conflict with Chapter 4's exact phrases. Delivery derives visible text only from the validated module state and Chapter 4.

`discovery_status` is required and must be one of:

- `confirmed_account`: a subject-owned homepage/profile was confirmed;
- `suspected_account`: no homepage is confirmed, but at least one user-supplied suspected page, or one automatically selected unique highest-similarity candidate, was fully reviewed as the platform's suspected homepage;
- `related_content_only`: relevant indexed or platform content was found, but a subject-owned homepage is not yet confirmed;
- `no_account_after_multiroute_search`: no credibly attributable account remained after at least two independent discovery routes, including a common-name high-collision result with no differentiating anchor or clear highest-similarity account, not merely one blocked static page;
- `access_blocked_unresolved`: access controls prevented a resolved account/content conclusion; this internal state is always invalid in a final payload.

The validator derives the only legal final status in this order: any confirmed account produces `confirmed_account`; otherwise a selected suspected homepage produces `suspected_account`; otherwise related content produces `related_content_only`; otherwise completed multiroute discovery produces `no_account_after_multiroute_search`. Extra subplatforms, risk links, confirmed topic pages, and each search module's exact `risk` / `no_risk` / `no_related_content` state participate in that derivation; the researcher cannot choose a softer value. There is no parallel free-form platform `findings` field because it would duplicate and potentially contradict those Chapter 4 modules. A static challenge shell, app shell, login wall, or empty anonymous HTML can support only internal `access_blocked_unresolved`; it cannot support `no_account_after_multiroute_search` or `未发现相关内容`. If an index or visible search returns relevant content but no confirmed or selected suspected homepage exists, use `related_content_only` and represent that result in the applicable search module and its item ledger. A主题贴吧 is related content rather than a subject-owned account. Directory/catalog presence without a subject-owned homepage is likewise `related_content_only`, not a separate parallel status.

For a no-account or no-risk platform, retain every completed Chapter 4 surface, its natural-end route evidence, and its per-item ledger. A precise access boundary is never enough. A required chapter may never disappear because no account was found.

After every named subplatform has been enumerated, the two `其他` records also carry these exact, required, unnumbered tail fields:

```json
{
  "platforms": {
    "domestic_other": {
      "other_platform_tail": "其他境内平台暂未发现相关账号或相关内容的负面及敏感信息。"
    },
    "overseas_other": {
      "other_platform_tail": "其他境外平台暂未发现相关账号或相关内容的负面及敏感信息。"
    }
  }
}
```

These statements do not replace discovered subplatform entries. Delivery writes each one only after the final enumerated domestic or overseas subplatform.

## Risk Groups

One `risk_group` represents one merged risk category:

```json
{
  "id": "risk-001",
  "title": "公开发布自伤及死亡主题内容",
  "category": "内容调性",
  "summary": "曾公开发布涉及自伤及死亡主题的内容，存在合作调性风险。",
  "explanation": "对象曾在相关作品及公开内容中反复使用自伤、死亡等主题。",
  "instances": [
    {
      "platform_key": "youtube",
      "subplatform": "",
      "module_targets": [
        {"module_key": "homepage", "module_url": "https://www.youtube.com/@channel"},
        {"module_key": "keyword_search", "module_url": "https://www.youtube.com/results?search_query=Name"}
      ],
      "published_at": "2025-01-01",
      "finding": "视频内容涉及……",
      "source_url": "https://www.youtube.com/watch?v=example",
      "source_type": "official_account_content",
      "screenshots": [
        {
          "path": "<WORKSPACE>/YYYY-MM-DD/对象名/process/evidence/youtube-example.png",
          "caption": "油管视频页面",
          "platform_label": "油管",
          "visible_text": "截图中可辨认的关键文字或画面说明",
          "sha256": "64位小写SHA-256"
        }
      ]
    }
  ]
}
```

Rules:

- `risk_summary_order` contains every `risk_group.id` exactly once and no other value.
- Each risk group has at least one platform instance.
- `instances[0]` is the canonical internal-jump destination for that risk group. Research must place the clearest primary evidence first. For a cross-platform group, later instances remain fully represented in their true platform chapters, but the top `举例N` sentence has only one jump and targets the platform fact block generated from `instances[0]`.
- Each instance has a valid required platform key, one or more unique `module_targets`, factual finding, direct source URL, source type, and at least one mapped screenshot. Every target contains the exact Chapter 4 `module_key` and that module's exact homepage/search `module_url`. The instance's group id must appear in the matching URL-level and module-level risk maps, and the completed route for that same module URL must contain a reviewed `risk` item-ledger row with the same group id and direct source URL. For a search target, that row's `query_or_account_urls` must include the displayed risk-query URL. Multi-target instances need this proof separately for every target. This prevents a risk from one small account or query being written under another. Missing screenshots must be returned to research; do not invent a file or silently omit evidence.
- Every screenshot records `path`, `caption`, `platform_label`, `visible_text`, and `sha256`. Files must be real PNG, JPEG, or WebP images under `$env:BACKGROUND_CHECK_WORKSPACE`, no larger than 20 MB. Normal CLI validation checks every path, image signature, size, and SHA-256 by default; `--structure-only` is an explicit diagnostic mode and cannot authorize delivery. The same screenshot file may not be reused as evidence for different platforms or different source URLs.
- Placeholder links or example data are invalid research evidence.
- The corresponding platform's `risk_group_ids` contains the group id. Cross-links are bidirectional.
- The corresponding delivery module and exact URL target contain the group id. If the same post is both on the homepage and returned by native search, include both module targets; delivery follows Chapter 4 for each target rather than falsely writing a clean fixed conclusion in one of them.
- Same-category instances from different platforms stay in one group, but each instance retains its true platform and evidence.
- `category` may be a broad taxonomy such as `内容调性`; merge only findings with the same specific underlying risk theme. For example, self-harm/death content and sexualized content remain separate even though both belong to `内容调性`.
- Distinct risk themes remain distinct even when they share a platform.
- A no-risk payload has empty `risk_groups` and `risk_summary_order`, and `verdict.has_risk` is `false`.

## Coverage

`coverage` records the research boundary, not final prose:

- `started_at`, `completed_at`
- `network_preflight`
- `risk_standard_path`
- `risk_standard_sha256`
- `risk_terms_path`
- `risk_terms_sha256`
- `risk_terms_count`
- `aliases_checked`
- `keyword_groups_checked`
- `native_search_sentinel_groups`
- `user_risk_leads`
- `search_engines_checked`
- `source_inventory`
- `final_linear_pass_index`
- `pending_cross_platform_leads`

`final_linear_pass_index` is a compatibility field containing the highest positive coverage-wave marker and naming the final account-candidate reconciliation wave. It does not impose a global platform order and does not invalidate complete evidence from earlier positive waves. `pending_cross_platform_leads` is the authoritative cross-platform queue and must be the exact empty list `[]` in a final payload; any queued URL or other value means the account graph is not closed and blocks delivery. `risk_terms_path` points to the UTF-8, newline-delimited, task-specific term file compiled from every applicable section/table/list in the complete maintained risk standard plus subject-specific aliases and terms. `aliases_checked` includes the subject display name, every `subject.aliases` value, and every non-empty `handle` from a `confirmed` or `suspected_homepage` account. Preserve each handle's original searchable form, including a leading `@` when present; do not claim an unsubmitted stripped form as equivalent. Every `aliases_checked` value must appear as an exact non-comment risk-term line and receive its own identity-only query in every completed search route. `risk_terms_count` equals its unique non-comment lines. Both the standard and term file carry SHA-256 values so the exact coverage input is reproducible.

`native_search_sentinel_groups` is a unique list of at least four real query expressions and a non-empty proper subset of `keyword_groups_checked`. It contains every general risk group the user explicitly asks to prioritize. The validator mechanically proves uniqueness, size, and the proper-subset relation. The researcher and delivery reviewer must still manually reconcile it against the user's request, and an untraceable or omitted requested concern blocks delivery. This set controls only the twelve named platforms' native searches. It never narrows the complete maintained risk-term file, homepage content review, item review, media review, Baidu, or Google.

`user_risk_leads` is the authoritative controlled list of concrete user-provided platform, post/content-class, incident, allegation, or other specific risk clues. It is required and may be `[]` only when the user supplied no concrete lead. Every row has exactly these four fields:

```json
{
  "lead_id": "user-lead-001",
  "platform_keys": ["douyin", "youtube"],
  "keyword_groups": ["台独 OR 港独 OR 辱华"],
  "description": "用户明确要求核查该事件及相关视频。"
}
```

`lead_id` is a unique stable lowercase identifier matching `[a-z0-9][a-z0-9_-]{0,63}`. `platform_keys` is a non-empty unique list drawn only from the twelve named platforms: `weibo`, `bilibili`, `douyin`, `xiaohongshu`, `zhihu`, `netease_music`, `tieba`, `douban`, `x`, `facebook`, `instagram`, and `youtube`. `keyword_groups` is a non-empty unique subset of the exact values in `coverage.keyword_groups_checked`; `description` is non-empty and preserves enough of the user's wording to audit the mapping. Every listed platform is mechanically upgraded to full search, so all of its completed search routes use the complete `keyword_groups_checked`. The schema can validate only leads that were recorded: the researcher and delivery reviewer must manually ensure that every concrete lead in the original request is represented completely, including all implicated platforms and applicable keyword groups. An omitted, weakened, or incompletely mapped lead blocks delivery even when the JSON is otherwise valid.

`network_preflight` distinguishes a platform boundary from a broken local proxy, DNS failure, or missing browser connection:

```json
{
  "status": "complete",
  "checked_at": "2026-09-02T08:55:00+08:00",
  "proxy_configured": true,
  "proxy_reachable": false,
  "direct_https_reachable": true,
  "browser_session_reachable": true,
  "domestic_route_reachable": true,
  "overseas_route_reachable": true,
  "tested_hosts": ["www.baidu.com", "www.google.com", "weibo.com", "x.com"],
  "log_path": "<WORKSPACE>/.../network-preflight.json"
}
```

`network_preflight` 和真实日志仍为必填项，最终 `status` 必须为 `complete`。校验器从全部具名及额外平台的实际路线判定通道，不能用声明隐藏浏览器 UI 路线。纯 `official_api`／`authorized_export`／合规 API `local_script` 包可使用 `direct_https` 或 `configured_proxy` 分别证明 domestic 与 overseas 非浏览器传输可达；每条成功记录须有真实 HTTP 200–399 响应且 `error` 为空，`browser_session_reachable=false`，所有浏览器专属字段为 null。这种纯 API 包只可作结构诊断或未完成检查点，因缺少十四平台桶的浏览器 UI 必访而不得通过最终交付门禁。存在任何实际 `browser_ui` 或 legacy `microsoft_edge_visible` 路线（含 blocked／failed）时，继续执行下述两次交互式浏览器预检，不用纯 HTTP 记录冒充浏览器恢复。

生成器为研究 Skill 的 `scripts/network_preflight.py`，日志 schema 保持 `network-preflight-1.4`。正式默认入口是 `--channel browser`，由执行者记录实际使用的可控有界面浏览器；`--channel edge` 仅作为旧命令兼容别名继续接受，不把 schema 1.10 对新 `browser_ui` 证据的接受范围收窄为某一浏览器产品。仅作结构诊断或未完成检查点的纯 API 调查可使用 `--channel api --domestic-url <境内公开测试端点> --overseas-url <境外公开测试端点>`，URL 不含凭证，可重复指定。API 模式不接收浏览器截图参数，不表示已取得平台数据权限，也不满足十四个平台的浏览器 UI 必访；失败测试不能手改为成功。每条 check 保留公共传输字段和 `browser_family`、`window_mode`、`evidence_path`、`evidence_sha256`、`evidence_kind`、`edge_window_continuity_id`、`edge_page_continuity_id`、`max_task_open_edge_pages`、`capture_scope`、`preflight_serial_index`、`started_at`、`captured_at`、`completed_at`；其中 `edge_*` 与 `max_task_open_edge_pages` 是通用浏览器连续性／页面峰值的兼容字段名，非浏览器记录中这些专属字段全部为 JSON null。

含 `browser_ui` 或 legacy `microsoft_edge_visible` 路线时恰有两条 `browser_session` 预检：domestic 的 `preflight_serial_index=1`、overseas 为 2；在一个真实可见的持久桌面浏览器页面依次完成，`max_task_open_edge_pages=1`，带时区区间不重叠，均先于研究浏览器路线。新证据使用 `capture_scope=full_visible_browser_window_with_tab_strip`；旧证据的 `full_visible_edge_window_with_tab_strip` 继续兼容。预检页 id 无须与后续研究页相同。每条使用 `evidence_kind=browser_evidence_manifest`，指向 `$env:BACKGROUND_CHECK_WORKSPACE` 下独立带哈希的 UTF-8 `browser-reachability-evidence-1.2` 清单。清单严格包含 `schema_version`、`url`、`browser_family`、`window_mode`、`edge_window_continuity_id`、`edge_page_continuity_id`、`max_task_open_edge_pages`、`capture_scope`、`preflight_serial_index`、`started_at`、`captured_at`、`completed_at`、`artifact_path`、`artifact_sha256`、`artifact_kind`，并与 check 一致；`browser_family` 须非空并记录实际持久桌面浏览器家族，不接受明显 Codex／in-app／`iab`／hosted／headless／temporary 身份。截图引用独立真实 PNG／JPEG／WebP `browser_screenshot`，不得用 JSON／HTML／DOM 文本、不可识别的图像或复用截图代替。正式 `--channel browser` 与 legacy `--channel edge` 均通过 `--browser-domestic-evidence` 和 `--browser-overseas-evidence` 接收清单；仅作结构诊断的纯 API 模式不要求这些浏览器预检，但也不得通过最终交付门禁。payload 摘要必须与日志逐项一致，失效代理不能写成平台登录墙。

`search_engines_checked` must contain lowercase `baidu` and `google`. Their authoritative run evidence is not duplicated under `coverage`: it lives in `platforms.domestic_other.research_completion.route_results` and `platforms.overseas_other.research_completion.route_results`. Each must include every identity-only query URL and the complete aliases × `keyword_groups_checked` product, the matching full risk-term hash, every normal-visible result item, false-positive decisions, and a natural-end termination. Baidu and Google cannot use the adaptive sentinel subset. Failed-route reasons likewise live only on their exact `route_results[].boundary`; platform-level and coverage-level boundary summaries are forbidden because they duplicate and can drift from the route log.

Every item-bearing `item_ledger_path` is UTF-8 JSONL. Each non-empty line is one unique reviewed item and contains at least:

```json
{
  "platform_key": "douyin",
  "surface": "native_search",
  "query_or_account_urls": [
    "https://www.douyin.com/search/Name",
    "https://www.douyin.com/search/Name%20风险词组"
  ],
  "item_id": "stable-platform-id",
  "url": "https://www.douyin.com/video/123",
  "item_kind": "content",
  "content_type": "video",
  "media_kinds": ["video"],
  "author": "对象名",
  "published_at": "2026-01-02",
  "title": "详情页完整公开标题",
  "text": "详情页展开后的完整公开简介",
  "video_metadata": {
    "detail_url": "https://www.douyin.com/video/123",
    "detail_capture_kind": "video_detail_page",
    "title_state": "present",
    "cover_state": "present",
    "cover_path": "<WORKSPACE>/具体任务/process/video-123-cover.png",
    "cover_sha256": "64位小写SHA-256",
    "description_state": "complete_expanded",
    "play_count_status": "not_applicable",
    "play_count": null,
    "play_count_source_text": "账号外关键词搜索视频，不参与账号热门排序",
    "observed_at": "2026-09-08T10:00:00+08:00",
    "native_rank_evidence": null
  },
  "media_review_status": "complete",
  "subject_interaction_review_status": "complete",
  "review_status": "reviewed",
  "risk_decision": "no_risk",
  "risk_group_id": ""
}
```

`risk_decision` is `risk`, `no_risk`, `false_positive`, or `out_of_scope`. A `risk` row has a valid `risk_group_id`; all other rows leave it empty. `query_or_account_urls` lists every logged query/account URL that returned the same unique item, so duplicate results across queries are not lost or duplicated. Stable item IDs and direct item URLs are unique within a route. Every route records `item_ledger_sha256`, and the file must match it. The route's `discovered_items` and `reviewed_items` equal the number of unique ledger rows. A zero-result or pre-login-zero-item route still has a real, hashed empty JSONL file. For a login-wall route, a legacy `surface_start` resolver ledger includes every unique pre-login `(item_id, URL)` pair；a `checkpoint_resume` resolver ledger contains only the post-checkpoint continuation and must be disjoint from the pre-login ledger. The validator uses the de-duplicated union as that resolved surface's evidence. This proves ledger consistency, same-page continuity and a natural endpoint；it does not independently authenticate that the operator visually read every page item or that the platform exposed no unseen item between the saved checkpoint and the first post-login row, so the real interactive-browser checkpoint evidence remains mandatory and must not be inferred from JSON alone.

Every item has a required non-empty `media_kinds` list. Its values are unique and drawn only from `none`, `image`, `audio`, `video`, `animated_image`, and `document`; `none` cannot be combined with another value. This is an observed-media declaration, not a restatement of `content_type`.

### Two-layer video review and account Top 10

A row is a real video when any of these redundant signals applies: its normalized `content_type` is `video`, `video_post`, `short_video`, `short`, `clip`, `reel`, `live`, `live_video`, `live_stream`, `livestream`, `live_replay`, or `live_archive`; its `media_kinds` contains `video`; its direct URL is a recognizable native video/live path; or it appears on a controlled video-only surface. Recognized paths include YouTube and `youtu.be` `/watch?v=`, `/shorts/`, `/live/`, and short-video paths; Bilibili and Douyin `/video/`; Instagram `/reel/`, `/reels/`, and `/tv/`; Facebook `/reel/`, `/reels/`, `/watch/`, `/videos/`, nested account `/videos/`, and `/watch?v=`; Zhihu `/zvideo/`; and Weibo `/tv/show/` and `/tv/v/`. Video-only surfaces include the configured Bilibili `videos`, `live_replays`, and `search_videos`; Xiaohongshu `videos` and `search_videos`; Zhihu and NetEase Music `videos`; Facebook `reels` and `videos`; Instagram `reels`; and YouTube `videos`, `shorts`, and `live_archives`. Douyin `works` is intentionally not surface-forced because it may contain image-text works; its actual `/video/` URL, `content_type`, and `media_kinds` remain authoritative. A video-only surface row must declare `video` even if its URL is opaque. A real video must use `item_kind: content`; an `account_candidate` must instead use an account-like homepage URL and can never use a video URL. A controlled video content type or recognizable video URL must also carry `media_kinds: ["video", ...]`. `animated_image` is reserved for an actual animated image and cannot substitute for `video`; generic `post`, `content`, `account_candidate`, mixed-media, or media-label changes cannot bypass video classification.

**Layer 1 — every real video.** Open each video's own detail page and preserve the complete detail-page title, cover, and fully expanded description before contextual triage. Every real-video row, including an account-external search result and a clear non-Top-10 item, has `media_review_status: complete`, an exact `video_metadata` object, and an exact `review_evidence.video_triage` object. `media_review_status: complete` means every layer applicable to that item is complete; it does not by itself claim that an otherwise non-upgraded video received the Layer-2 full-timeline review.

`video_metadata` contains exactly these fields and no others:

```json
{
  "detail_url": "https://www.douyin.com/video/123",
  "detail_capture_kind": "video_detail_page",
  "title_state": "present",
  "cover_state": "present",
  "cover_path": "<WORKSPACE>/具体任务/process/video-123-cover.png",
  "cover_sha256": "64位小写SHA-256",
  "description_state": "complete_expanded",
  "play_count_status": "observed",
  "play_count": 123456,
  "play_count_source_text": "12.3万次播放",
  "observed_at": "2026-09-08T10:00:00+08:00",
  "native_rank_evidence": null
}
```

`detail_url` equals the direct item URL and `detail_capture_kind` is exactly `video_detail_page`. `title_state` and `cover_state` are `present` or `empty_on_source`; `description_state` is `complete_expanded` or `empty_on_source`. `present` title and `complete_expanded` description must agree with the row's non-empty `title` and `text`. A present cover uses a real PNG, JPEG, or WebP file under `$env:BACKGROUND_CHECK_WORKSPACE` and a matching lowercase SHA-256; an actually absent source cover uses `empty_on_source` with both `cover_path` and `cover_sha256` set to null. The corresponding empty title or description state is allowed only when the detail page genuinely exposes no value. Do not invent missing metadata.

`play_count_status` is exactly one of `observed`, `native_top_rank`, `not_public`, `not_comparable`, or `not_applicable`. `observed` requires a non-negative integer `play_count`; every other status requires `play_count: null`. `play_count_source_text` is always non-empty and preserves either the visible value or the exact reason it is unavailable or inapplicable. When that text exposes an unambiguous common count form—an exact integer or comma-grouped integer, optionally using Chinese `万`/`亿` or `K`/`M`/`B` beside a playback/view label—the normalized integer must equal `play_count`; a non-observed status cannot carry such an explicit count. Ambiguous localized prose is not guessed. A delivered-account video cannot use `not_applicable`; a search or other non-account video cannot claim `native_top_rank` and never enters account ranking. `observed_at` is timezone-bearing and falls inside the corresponding route interval.

`native_rank_evidence` is null unless genuine native order was observed. When present it contains exactly a `path` and matching lowercase `sha256`, points to one UTF-8 JSON file under `$env:BACKGROUND_CHECK_WORKSPACE`, and is allowed only with `play_count_status: observed` or `native_top_rank`. `native_top_rank` requires it. The referenced JSON contains exactly:

```json
{
  "source_account_url": "https://www.douyin.com/user/example",
  "source_video_url": "https://www.douyin.com/video/123",
  "source_surface": "account_native_popular",
  "sort_mode": "popular",
  "ranking_scope": "account_all_videos",
  "native_rank": 1,
  "visible_order_text": "按最热视频排序，第1项",
  "observed_at": "2026-09-08T10:00:00+08:00",
  "ranking_snapshot_path": "<WORKSPACE>/具体任务/process/account-native-ranking.json",
  "ranking_snapshot_sha256": "账号级排序快照的64位小写SHA-256"
}
```

The wrapper is `{"path": "<WORKSPACE>/具体任务/process/video-123-native-rank.json", "sha256": "64位小写SHA-256"}`. `source_account_url` equals the delivered account URL, `source_video_url` equals the row URL, `source_surface` is exactly `account_native_popular`, `sort_mode` is `popular` or `most_viewed`, `ranking_scope` is exactly `account_all_videos`, `native_rank` is a positive integer, `visible_order_text` is non-empty, and `observed_at` exactly matches `video_metadata.observed_at`. `ranking_snapshot_path` is a real UTF-8 JSON account-order snapshot under `$env:BACKGROUND_CHECK_WORKSPACE` and its hash equals `ranking_snapshot_sha256`. Search ordering, a third-party chart, a per-surface subset, an un-hashed ordering claim, or individually authored rank rows that do not share one account snapshot is not native account-wide rank evidence.

The referenced account snapshot contains exactly:

```json
{
  "source_account_url": "https://www.douyin.com/user/example",
  "source_surface": "account_native_popular",
  "sort_mode": "popular",
  "ranking_scope": "account_all_videos",
  "observed_at": "2026-09-08T10:00:00+08:00",
  "ordered_video_urls": [
    "https://www.douyin.com/video/123",
    "https://www.douyin.com/video/456"
  ]
}
```

Every per-item field above matches the snapshot, and the item at zero-based list position `native_rank - 1` has the same stable video identity as `source_video_url`. The ordered list is non-empty and contains unique stable video identities. All native-rank rows within one account route use the same snapshot provenance. Across multiple completed routes, different genuine snapshots may exist; Top-10 selection uses one internally complete snapshot and never splices ranks from different paths, hashes, sort modes, scopes, accounts, or observation times. Numeric cutoff ties use native ordering only when all tied videos share one such snapshot; otherwise they fall back to `published_at` and canonical URL.

`review_evidence.video_triage` contains exactly `title_reviewed`, `cover_reviewed`, `description_reviewed`, `result`, `reason`, `risk_terms_sha256`, and `detail_source_ref`. The three review flags are true; `result` is `clear`, `suspected_risk`, or `risk_signal`; `reason` is item-specific non-empty text; and the risk-term hash equals the task's complete `coverage.risk_terms_sha256`. `detail_source_ref` contains exactly `path`, `sha256`, and `locator`, also appears in `review_evidence.evidence_refs`, and locates the same pre-review, complete normalized detail-page item whose row URL and `video_metadata.detail_url` equal this video URL and whose `detail_capture_kind` is `video_detail_page`. The detail reference cannot point to another video, a search card, an incomplete description, or a post-review conclusion. Because `video_metadata` is one of the content-hash fields, changing any of its values invalidates `review_evidence.content_sha256` and requires re-review rather than a hash-only rewrite.

For the account-ranking trigger, the validator aggregates all real videos from every completed positive-wave `homepage`, `subject_homepage`, or `subplatform:<entry_id>` route for each delivered account URL, across all of that account's required video surfaces. Search results, account-discovery results, topic pages, and any other video not bound to that delivered account URL do not participate. Repeated observations are de-duplicated by stable content identity and stable `item_id`. Recognized YouTube watch/shorts/live/`youtu.be`, Bilibili, Douyin, Instagram reel/reels/tv, Facebook reel/watch/videos, Zhihu zvideo, Weibo tv, and NetEase Music `#/video?id=` / `#/mv?id=` URL families normalize their platform video id to one identity; fragments and tracking parameters cannot create another item. When a row is independently established as a real video, Xiaohongshu `/explore/{note_id}` or `/discovery/item/{note_id}`, X/Twitter `/status/{id}`, and Instagram `/p/{shortcode}` likewise use the stable note/status/post id and ignore share/tracking queries for de-duplication; these generic post paths do not by themselves classify the row as a video. Unrecognized URLs use a canonical form that normalizes scheme/host and trailing slash and sorts query pairs, but preserves the fragment because an unknown or extra platform may use a hash router whose fragment carries content identity. Only a recognized stable identity, or a platform URL known not to use its fragment as content identity, may discard the fragment. Each stable content identity and item id remains one-to-one across routes. For a repeated item, aggregation retains its latest valid observed play count even if a later surface does not display a count; a later `not_public` or `not_comparable` value never erases that earlier valid count. Native ranks are retained with their snapshot provenance: ranks may legitimately change between genuine snapshots, but each selection uses one coherent complete snapshot and a later incomplete surface cannot erase an earlier complete one. Thus aliases, tracking parameters, duplicating a clear video across routes, changing its surface, or hiding a count on a later route cannot push a genuinely high-ranking account video out of the pool.

The account Top 10 is derived after de-duplication:

1. If the account has 10 or fewer unique real videos, select all of them.
2. If it has more than 10 and every unique video has a comparable public `observed` count, sort by `play_count` descending and select exactly 10. At the tenth-place count boundary, if every tied item has genuine, distinct native-order evidence, use ascending `native_rank` to fill the remaining slots. Otherwise use newer `published_at` first, then canonical URL in ascending lexical order, so the result is still exactly 10.
3. When counts are not all comparable but the platform supplies a complete, unique account-wide native popular order for ranks 1 through 10, select those native first 10.
4. When an account has more than 10 videos but neither all-comparable public counts nor complete native ranks 1 through 10, do not guess, do not block delivery solely for that uncertainty, and do not upgrade every video. The account-ranking trigger selects none; the independent triage and final-decision triggers below still apply.

**Layer 2 — detailed full-media review.** The exact `video_review_evidence` object below is mandatory for the union of: every video selected in its delivered account's Top 10; every video whose triage is `suspected_risk` or `risk_signal`; and every video whose final `risk_decision` is not `no_risk`. An account with fewer than 10 videos therefore requires Layer 2 for all of its videos. A triage-upgraded item has at least one contextual hit even if its final decision becomes `no_risk`. A clear, account-external or non-Top-10 video with final `no_risk` may stop after Layer 1. Full evidence may still be supplied for it, but any supplied `video_review_evidence` is always validated against every full-timeline rule below; optional presence never creates a validation bypass. A pure `animated_image` that is not a real video does not use `video_metadata` or video triage, but it still always requires `media_review_status: complete` and the complete Layer-2 `video_review_evidence` gate.

```json
{
  "video_review_evidence": {
    "duration_seconds": 60,
    "timeline_start_seconds": 0,
    "timeline_end_seconds": 60,
    "sampling_method": "equal_interval_plus_keyframes_scene_changes",
    "max_sampling_interval_seconds": 10,
    "sampled_frame_timestamps_seconds": [0, 10, 15, 20, 30, 40, 50, 60],
    "keyframe_scene_change_timestamps_seconds": [15, 30],
    "keyframe_scene_change_reviewed": true,
    "frame_manifest_path": "<WORKSPACE>/具体任务/process/video-123-frames.jsonl",
    "frame_manifest_sha256": "64位小写SHA-256",
    "full_audio_coverage": true,
    "audio_scan_method": "combined_full",
    "audio_text_path": "<WORKSPACE>/具体任务/process/video-123-full-audio.jsonl",
    "audio_text_sha256": "64位小写SHA-256",
    "audio_risk_terms_sha256": "与路线完整risk_terms_sha256一致",
    "ocr_visual_sensitive_elements_reviewed": true,
    "hits": [
      {
        "source_video_url": "https://www.douyin.com/video/123",
        "timestamp_seconds": 30,
        "context_start_seconds": 10,
        "context_end_seconds": 50,
        "evidence_kind": "frame",
        "evidence_path": "<WORKSPACE>/具体任务/process/video-123-00-30.png",
        "evidence_sha256": "64位小写SHA-256",
        "original_or_transcript": "00:30 的原文或完整转写摘录",
        "context": "已回看命中点前后各15秒后的具体语境。",
        "conclusion": "结合语境后的风险、误报或范围结论。"
      }
    ]
  }
}
```

The timeline starts at `0`, ends at `duration_seconds`, preserves strictly increasing unique sample timestamps, and has no adjacent gap greater than the declared maximum or 10 seconds. All numeric duration, timestamp, and interval values must be finite. `sampling_method` is fixed to equal-interval sampling plus detected keyframes/scene changes; every detected keyframe/scene-change timestamp is also present in the sampled-frame list, and `keyframe_scene_change_reviewed` is true. This is a fast full-timeline screen, not a bounded excerpt.

`frame_manifest_path` points to a hashed UTF-8 JSONL file under `$env:BACKGROUND_CHECK_WORKSPACE`. It contains exactly one row for every value in `sampled_frame_timestamps_seconds`, no missing or additional timestamp, and no frame file reused for two timestamps. Each row contains exactly:

```json
{
  "source_video_url": "https://www.douyin.com/video/123",
  "timestamp_seconds": 30,
  "frame_path": "<WORKSPACE>/具体任务/process/video-123-00-30.png",
  "frame_sha256": "64位小写SHA-256",
  "capture_kinds": ["interval_sample", "keyframe"]
}
```

`source_video_url` equals the reviewed item URL. `frame_path` is a real PNG, JPEG, or WebP file under `$env:BACKGROUND_CHECK_WORKSPACE`, and `frame_sha256` matches it. `capture_kinds` is a non-empty unique list drawn only from `interval_sample`, `keyframe`, and `scene_change`. A timestamp listed in `keyframe_scene_change_timestamps_seconds` carries `keyframe` or `scene_change` in the corresponding manifest row. The manifest's own file hash equals `frame_manifest_sha256`.

The entire audio track is scanned through `asr_full_audio`, `official_subtitles_full`, `manual_transcript_full`, or `combined_full`. `audio_text_path` is not an arbitrary text note: it points to a hashed UTF-8 JSONL timeline under `$env:BACKGROUND_CHECK_WORKSPACE`. Each row contains exactly:

```json
{
  "source_video_url": "https://www.douyin.com/video/123",
  "start_seconds": 0,
  "end_seconds": 12.5,
  "text": "完整转写、字幕或画面文字",
  "segment_kind": "speech"
}
```

`source_video_url` equals the reviewed item URL. Rows are in ascending order and form one continuous, non-overlapping timeline from exactly `0` through exactly `duration_seconds`, with finite values satisfying `0 <= start_seconds < end_seconds <= duration_seconds`. `segment_kind` is one of `speech`, `subtitle`, `onscreen_text`, `music_lyrics`, `silence`, or `unintelligible`; every non-`silence` row has non-empty `text`. `unintelligible` must be recorded honestly when encountered, but a timeline containing it cannot support completed full-audio review and therefore blocks delivery until resolved. The JSONL hash equals `audio_text_sha256`, and the same complete risk-term hash is recorded in `audio_risk_terms_sha256`. `ocr_visual_sensitive_elements_reviewed` proves OCR and visual-sensitive-element review across the preserved frame set. Without evidence covering both the complete frame timeline and complete audio timeline, the video cannot be marked complete.

Every risk, false-positive, or out-of-scope video decision has at least one `hits` row. Each hit records `source_video_url` equal to the reviewed item URL, its timestamp, a hashed screenshot/frame/transcript-excerpt artifact, the original wording or transcription, concrete context, and conclusion. A `screenshot` or `frame` hit must use the exact `frame_path` and `frame_sha256` from the frame-manifest row at the same `timestamp_seconds`; a `transcript_excerpt` hit must bind to the validated full audio-timeline file through the exact `audio_text_path` and `audio_text_sha256`. A detached excerpt, different video URL, unmatched timestamp, or arbitrary evidence file is invalid. `context_start_seconds` is no later than `max(0, timestamp_seconds - 15)` and `context_end_seconds` is no earlier than `min(duration_seconds, timestamp_seconds + 15)`; both stay inside the media and surround the hit. This preserves at least 15 seconds on each side except where the actual media boundary truncates that side, while allowing a wider interval when needed to retain a complete semantic segment. A clean `no_risk` video may use an empty hit list only after the complete timeline, full audio, OCR, and visual gates above pass. Whenever `video_review_evidence` is present it must pass these complete checks; a row that is neither a real video nor a pure `animated_image` must not contain it.

An account result uses controlled `item_kind: account_candidate`, matching `content_type: account_candidate`, and adds exactly this nested evaluation object:

```json
{
  "identity_candidate": {
    "candidate_platform_key": "bilibili",
    "candidate_subplatform": "",
    "name_match": "exact_display_name",
    "all_platform_name_claim": false,
    "anchor_strengths": {
      "direct_crosslink": "none",
      "field": "none",
      "content_theme": "weak",
      "works_history": "none",
      "language_style": "none",
      "avatar_visual": "none",
      "associated_person": "none",
      "location": "none"
    },
    "explicit_identity_conflict": false,
    "similarity_score": 101,
    "evidence_urls": ["https://space.bilibili.com/123456"]
  }
}
```

Non-candidate rows use `item_kind: content` and must not contain `identity_candidate`; `account_discovery` rows are the exception and must all be `account_candidate`. The candidate row's `author` is the platform-visible account name and is mechanically checked against the subject display name and confirmed aliases. `similarity_score` is derived, not subjective free text: exact display name = 100, exact confirmed alias = 90, other = 0, an all-platform same-name statement = 1, and each anchor contributes `none=0`, `weak=1`, or `confirming=10`. `evidence_urls` is empty only when there is no asserted claim, anchor, or conflict; otherwise it provides one or more real, inventory-backed pages supporting those factors. Every account candidate already displayed and reviewed in any complete, blocked, or failed route must reappear with a complete evaluation in a completed route bearing `coverage.final_linear_pass_index` unless that exact URL is already a user-supplied homepage; the final reconciliation evaluation must preserve the strongest name match, claim, anchor, and conflict evidence recorded in every earlier route. This prevents a stronger earlier candidate from silently disappearing or being downgraded before ranking. The final reconciliation-wave evaluations are the candidate pool of record. The validator rejects an unrepresented non-user account, a candidate URL with no account record, a false exact-name classification, an unsupported anchor/claim/conflict, a hand-entered score that differs from the factors, evidence downgrade, a suspected account with a confirming anchor or conflict, selection of a lower-ranked candidate, and selection when the highest score is tied. These rows are internal evidence only; unselected candidates never appear in the Feishu document and are not individually traversed as homepages.

Every completed search route also has a UTF-8 JSONL `query_ledger_path` and matching SHA-256. Each row has exactly:

```json
{
  "query_id": "douyin-name-risk-001",
  "alias": "对象名",
  "keyword_group": "台独 OR 港独 OR 辱华",
  "query_text": "对象名 台独 OR 港独 OR 辱华",
  "query_url": "https://www.douyin.com/search/对象名%20台独%20OR%20港独%20OR%20辱华",
  "termination": "natural_end",
  "discovered_items": 12,
  "reviewed_items": 12,
  "unreviewed_items": 0
}
```

For every alias there is one identity-only row with empty `keyword_group`, plus one row for every alias × the current route's `keyword_groups_covered` pair. `keyword_group` is the exact submitted risk expression, not a descriptive label. `query_text` equals the alias for the identity-only row and exactly `alias + space + keyword_group` for a risk row. The validator extracts the platform's real search input from its native query parameter or search path and requires it to equal `query_text`; an unrelated fixed query URL with merely correct ledger labels is invalid. Every row reaches a verified natural end and has equal discovered/reviewed counts with zero unreviewed items. The item ledger must cite each query URL exactly as many times as that query's unique discovered count.

Search mode is inferred, never declared: equality with `native_search_sentinel_groups` means adaptive; equality with `keyword_groups_checked` means full. A named platform may finish adaptively only when it has a confirmed subject account and no mechanical upgrade signal. Any one of the following signals upgrades the whole named platform: no confirmed account; a platform/module `risk_group_ids` value or any reviewed `risk` item; at least two distinct account-candidate URLs whose validator-derived `name_match` is `exact_display_name` or `exact_alias` and which lack an explicit identity conflict; or any item URL returned by a sentinel query that is absent from every identity-only query in that route. If any required search surface triggers, every completed search route for that platform must use the full `keyword_groups_checked`, including routes on other required search surfaces and independent confirmation routes. Result truncation, a non-natural endpoint, unreviewed items, or unresolved access does not merely trigger expansion: it fails completion under the existing route rules.

Every platform named in `coverage.user_risk_leads[].platform_keys` is an additional mechanical full-search trigger. If the user names a particular platform, post/content class, incident, allegation, or other specific risk clue, the researcher records it in `user_risk_leads`; every completed search route for each implicated platform then uses the full `keyword_groups_checked` before completion. This differs from a general concern group, which also belongs in `native_search_sentinel_groups`. Mechanical validation proves the upgrade for recorded rows, while the researcher and delivery reviewer remain responsible for checking the original request so that no concrete lead, platform, or applicable group is omitted from the controlled list.

An adaptive route still carries the full `risk_terms_sha256`, reviews every returned item, records all query-to-item origins, and applies the full maintained risk standard during contextual, OCR, visual, subtitle, transcript, and audio review. The sentinel subset reduces repeated query submissions only; it is not permission to reduce the risk taxonomy or sample returned results.

The old `coverage.general_search_runs` and `coverage.platform_runs` fields are removed as redundant. Their only authoritative replacement is each platform's `research_completion.route_results`; parallel summaries are forbidden because they can drift.

`risk_groups[].instances` is the authoritative source for every risk fact used in a platform chapter. `platforms.*.risk_group_ids` is the cross-link. Non-risk relevant results are represented only by the applicable delivery module's `result_status: no_risk` and its completed item ledger; no parallel platform narrative field is allowed.

## 审阅与终点证据加固

保持 schema 1.10 与 route-evidence-1.4 命名；默认校验同时执行 `scripts/review_proofs.py`。旧包仍可诊断，但缺少下述真实证明不得交付；不迁移旧标签，不自动填证明。下文早期字段示意须连同本节及两层视频规则使用，不是可以直接执行的完整生产样本。

### 逐项 review_evidence

非真实视频的每行台账 `review_evidence` 严格使用以下七键；真实视频必须且只能增加第八键 `video_triage`。`decision` 等于该行 risk_decision；review_mode 仅 agent_context、human_context、user_manual；reviewer 为真实审阅者／代理标识，reviewed_at 为带时区的实际审阅时间，context_reason 描述这条内容的具体语境，不得用“未命中”模板代替审阅。

```json
{
  "review_evidence": {
    "content_sha256": "真实内容的64位小写SHA-256",
    "decision": "no_risk",
    "context_reason": "该条讲述游戏难度，以虐待作比喻，未涉及动物议题。",
    "reviewer": "实际审阅者标识",
    "review_mode": "agent_context",
    "reviewed_at": "2026-09-06T10:00:30+08:00",
    "evidence_refs": [
      {"path": "<WORKSPACE>/具体任务/process/raw-items.json", "sha256": "真实源文件SHA-256", "locator": "json:/items/0"}
    ],
    "video_triage": {
      "title_reviewed": true,
      "cover_reviewed": true,
      "description_reviewed": true,
      "result": "clear",
      "reason": "完整标题、封面和展开简介逐项核查后未见风险信号。",
      "risk_terms_sha256": "与coverage.risk_terms_sha256一致",
      "detail_source_ref": {"path": "<WORKSPACE>/具体任务/process/raw-items.json", "sha256": "真实源文件SHA-256", "locator": "json:/items/0"}
    }
  }
}
```

每条 evidence_ref 严格含 path、sha256、locator，路径须位于 $env:BACKGROUND_CHECK_WORKSPACE 内并实存、哈希相符、定位非空。至少一条须定位审阅前保存的完整规范内容对象，重算内容哈希与被审阅行一致；定位到另一帖、任意非空 JSON 或含 review_evidence 的结论对象均不能自证。可保存保留原始来源的规范采集侧车，原 API／DOM 证据另行保留，不能事后伪造原始内容。

定位支持 JSON Pointer（json:/items/0）、JSONL物理行（jsonl:12 或 jsonl:12/text）及附加文本位置（text:12-18）；~1、~0分别解码为/、~。完整对象的哈希由 helper 的 content_sha256 唯一计算：选择以下**实际存在**的键，不补 null，用 json.dumps(ensure_ascii=False, sort_keys=True, separators=(",", ":")) 编为 UTF-8 后做 SHA-256：

```text
platform_key, item_id, url, item_kind, content_type, author, published_at, title,
text, media_kinds, video_metadata, media, attachments, subject_interactions
```

审阅标签和决定不参与内容哈希，决定另行对齐。surface、query_or_account_urls由路线／查询台账验证，不参与正文哈希；补充来源映射不要求重审相同正文。正文、归属、直接链接、媒体内容或任何 `video_metadata` 值变化须重新核实，不能只重写哈希。

### 路线 completion_evidence

每个 complete 路线的**result log**新增以下十键，不放进 payload 的 route_results 对象；blocked/failed 不要求完成证明。

```json
{
  "completion_evidence": {
    "kind": "content_end",
    "platform_key": "douyin",
    "surface": "works",
    "url": "https://www.douyin.com/user/example",
    "discovered_items": 26,
    "observed_at": "2026-09-06T10:00:45+08:00",
    "source_ref": {"path": "<WORKSPACE>/具体任务/process/raw-terminal.json", "sha256": "真实文件SHA-256", "locator": "json:/response/has_more"},
    "scope_locator": "/scope",
    "signal": "has_more_false",
    "marker": null
  }
}
```

kind仅 content_end（非零条）、empty_query（零条搜索／account_discovery）、empty_surface 或 absent_surface（零条主页表面）。平台、surface、最终URL及发现数必须与当前路线和实际台账相符；observed_at落在路线起止区间内。

source_ref严格含 path/hash定位三键（哈希键名仍为 sha256），必须匹配该日志 raw_evidence 中的 api_response、browser_snapshot 或 authorized_export_manifest 原始采集项；状态摘要、manual_review_log或风险样本不够。scope_locator 是不带 json: 的 JSON Pointer，指向同一 JSON／JSONL 采集对象的 platform_key、surface、url 范围信息。可将当时真实请求范围与原响应组成采集包装，不能补造来源事实。终点源使用带作用范围的结构化采集对象，不以裸文本说明或截图文件冒充。

| signal | 定位值 | 受控尾字段 |
| --- | --- | --- |
| empty_array | 空数组，非 absent_surface | items/list/results/cards/statuses/videos/archives |
| has_more_false | JSON false，非 absent_surface | has_more/hasMore/has_next/hasNext/has_next_page/hasNextPage |
| surface_absent | JSON false，仅 absent_surface | surface_present/surfacePresent/surface_exists/surfaceExists |
| explicit_end_marker | 实际终点节点的完整提示，非 absent_surface | end_marker/endMarker/end_text/endText/terminal_text/empty_state_text |

explicit_end_marker 的 marker须与定位文字去首尾空白后完整一致，且满足 helper 的受控结束语正则；包括“没有更多了”“暂无相关作品”“已到底”、no more results、end of results、all caught up 等。新平台提示须用真实终点证据补测试后再扩识别，不能截取帖子正文中的结束语。其余 signal 的 marker 必须为 null。loading=false、任意空属性、页面几何底部和仅有作品数都不证明结束；字段改名本身也不证明完整取数。

以上示例的原始终点结构可为 `{"scope":{"platform_key":"douyin","surface":"works","url":"实际主页"},"response":{"has_more":false,"items":[]}}`。这是结构示意，不是生产证据。仍须保留完整分页／滚动批次并对账，单个末页不能证明中间未漏页。

### 校验范围

默认和 --check-files 检查真实文件、哈希、定位、逐项证明与终点；--structure-only 明确输出不能授权交付的诊断错误。共享文案检查器 audit_handoff_prose.py 的 error 阻断，warning 显式输出 PROSE_MANUAL_REVIEW，必须逐条编辑复核，不能靠QA布尔值清零。

这些检查证明记录关联和一致性，不证明某人／模型真的读过、语义正确或全部媒体无遗漏，也不能鉴别有意伪造整套数据。实际全文／媒体审阅、反例抽查、原始分页计数与既有截图验收仍不可省略。

## Multiple Subjects

This contract represents exactly one subject. A multi-subject request produces one separately validated payload per subject. The delivery skill creates one Feishu document per subject by default. It may combine subjects into one document only when the user explicitly requests a combined report; in that case it validates every payload independently and repeats the complete per-subject structure, including all fourteen platform chapters, under the accepted multi-subject wrapper.

## QA Flags

The payload must contain these boolean flags, all `true`:

```json
{
  "all_risks_grouped": true,
  "all_risks_mapped_to_platforms": true,
  "mandatory_platforms_complete": true,
  "source_urls_checked": true,
  "screenshots_mapped": true,
  "risk_terms_complete_and_hashed": true,
  "network_preflight_complete": true,
  "baidu_general_search_complete": true,
  "google_general_search_complete": true,
  "all_required_surfaces_exhausted": true,
  "all_items_reviewed": true,
  "platform_discovery_reconciled": true,
  "other_platform_tail_present": true,
  "no_unresolved_platforms": true,
  "single_edge_page_serial_complete": true
}
```

`single_edge_page_serial_complete` is retained in schema `1.10` only as a legacy compatibility key. It asserts that every interactive-browser route was page-isolated, same-page route intervals did not overlap, and all parallel work was reconciled; it does not assert an Edge-only route, a one-page task, or serial platform execution.

These flags are assertions, not substitutes for validation. The validator independently checks structure and cross-links.
