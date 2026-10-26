# 三小时定向背调交接契约（schema 1.11）

路径示例中的 `<WORKSPACE>` 表示安装后解析出的工作区，不是可直接提交给工具的字面值。实际运行时从 `BACKGROUND_CHECK_WORKSPACE` 取得根目录，使用路径拼接生成绝对路径；这些本机运行记录留在被 Git 忽略的任务目录中。

本文件只适用于默认研究模式 `research_profile: three_hour_targeted_v1`。旧的
`schema_version: 1.10` 继续按照 [handoff-contract.md](handoff-contract.md) 执行，
并视为 `exhaustive_audit`；不得把本文件的限量规则用于放宽旧包。

第一章和第四章的最终文案、模块顺序、链接样式、截图位置与固定结论，仍以
`deliver-feishu-background-check/SKILL.md` 为绝对交付标准。本契约只规定调查包如何记录并
机器校验以下声明：
十四个平台已按定向范围访问并闭合、每个纳入的个人／官方／项目账号主页的全部公开帖子
文字已到真实自然终点并完成全词表／规则扫描、用户线索已闭环、所有实际发现风险均有截图和
直接链接、其他被选中的检查项没有漏审。微博超话／话题页、贴吧主题吧、搜索结果、作品目录、
第三方标签页和评论流不属于账号主页全文范围。它不要求为未命中干净帖或其他未选结果伪造
逐项哈希、截图、OCR 或人工精读证明。校验器能检查结构、URL 语义、文件哈希、数量和跨字段一致性，但无法仅凭
JSON 认证执行者是否真实操作了交互式浏览器页面、是否实际阅读了画面或是否遗漏了未记录事实；这些仍由
研究执行者遵守操作规则并对真实性负责，不得把结构校验通过表述成行为取证。

## 1. 文件与顶层结构

研究 Skill 写出一个 UTF-8 JSON 文件，通常为：

`$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\<对象名>\process\delivery\research_payload.json`

证据文件留在同一任务目录的 `process` 下。默认最终对外交付物仍只有通过回读验证的飞书
云文档，研究包是内部事实源。

顶层严格包含：

```json
{
  "schema_version": "1.11",
  "research_profile": "three_hour_targeted_v1",
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

`schema 1.11` 只承载本定向模式。不要用它声明 `exhaustive_audit`。旧 `schema 1.10` 不要求、
也不自动补写 `research_profile`，继续走原有严格校验。

## 2. 三小时范围

`coverage.target_scope` 必须逐项等于：

```json
{
  "active_work_target_minutes": 180,
  "broad_discovery_freeze_minute": 90,
  "platform_search_max_pages": 3,
  "platform_search_max_results": 30,
  "general_search_main_name_max_pages": 10,
  "general_search_risk_query_max_pages": 3,
  "homepage_text_scope": "all_public_posts_to_natural_end",
  "media_latest_limit": 20,
  "media_popular_limit": 10,
  "media_historical_samples": 1,
  "comment_hot_limit": 20,
  "video_detail_trigger_interval_seconds": 10
}
```

180 分钟是熟练人工的活动工作目标，不含等待用户登录、平台故障、验证或限流恢复的时间。
工作时段默认分配如下：

1. 0—10 分钟：确认主体、用户给定主页、用户风险线索和十四平台清单；
2. 10—25 分钟：基本信息、代表作品和账号关系；账号一经确认即启动主页全文批量路线；
3. 25—90 分钟：十四个平台并行首轮访问，并持续推进已纳入账号主页的全文枚举与扫描；
4. 90—125 分钟：继续完成主页全文自然终点、媒体样本、热门视频和风险线索复核；
5. 125—165 分钟：仅在全部 `targeted_complete` 后写入飞书；否则收口关键缺口；
6. 165—180 分钟：回读、链接、图片和格式校验。

第 90 分钟只冻结广泛发现，不得停止已经纳入的主页全文路线；之后继续闭合全部纳入账号主页、
已经存在的高优先级线索和用户线索。时间到但仍有主页未到真实终点、未扫描文字、未闭合平台、
用户线索、访问障碍或风险证据缺口时，不得伪造 `targeted_complete`、干净结论或低风险结论。

## 3. 网页访问与并行

- 所有平台网页 UI 路线必须使用带持久用户配置与登录态的真实桌面浏览器页面。默认由执行者
  自主启动或选择 Microsoft Edge、创建任务页并导航；不要求用户预开 Edge、指定页签或提供
  endpoint／target。用户明确指定其他系统桌面浏览器，或执行者已确认另一系统桌面浏览器具备
  当前任务所需的持久配置／登录态时可以使用；Chrome 不因名称被禁用，但临时会话不合格。
  Codex 内置／in-app／`iab`／临时 hosted／headless 浏览器不得承担平台必访、原生搜索、主页、
  媒体、命中回查或登录恢复，也不得用无界面请求冒充真实页面访问。
- 十四个平台桶和每个纳入报告的账号主页都必须至少有一条
   `browser_ui + targeted_complete` 路线。旧研究包的 `microsoft_edge_visible` 作为兼容别名继续
  接受，并与 `browser_ui` 具有相同的交互式浏览器路线语义；新研究必须写 `browser_ui`。
  公开 API 或授权导出可在真实授权范围内承担账号主页全文分页路线，但不能替代十四个平台及
  每个账号主页的真实交互式浏览器必访，也不能替代风险／疑似风险命中回原页面的语境核验。
- 不同平台或独立表面可以并行。每条交互式浏览器路线绑定实际窗口和页面的连续性 UUID，不得让
  两条路线同时操纵同一物理页。
- 遇到登录墙或验证码，只保留边界并请用户亲自登录；不得读取、填写、保存或重放账号、
  密码、验证码、Cookie 或 token。用户完成后在同一交互式浏览器页面从已记录检查点继续，不重跑
  已复核部分。解决路线通常必须沿用同一个 `edge_page_continuity_id`；只有原调查页确已丢失时，
  blocked 路线的 `boundary` 才能以 `page_lost_new_continuity_required:` 起句，解决路线改用新的
  页面连续性 id、重新打开完全相同的入口 URL，并从最近可验证 checkpoint 继续。
- 不得使用私有接口、逆向接口或规避平台访问控制。

## 4. 主体、结论、账号与作品

### 4.1 `subject`

严格包含：`display_name`、`subject_type`、`category`、`basic_info`、
`basic_info_source_urls`、`report_date`、`aliases`、`strongest_handle`、
`user_supplied_homepages`、`scope`。

- `subject_type` 只能是 `person`、`organization`、`company`、`brand`、`project` 或
  `other_entity`。
- `report_date` 使用真实、补零的 `YYYY-MM-DD`。
- `basic_info_source_urls` 是非空、唯一的真实 HTTP(S) URL 列表，并全部进入
  `coverage.source_inventory`。
- `strongest_handle` 保存跨平台检索所用的最强账号名；确无可用 handle 时为 `""`。去掉显示用
  前导 `@` 后若与主体主名称相同，只提交一次查询。
- `scope` 严格包含非空 `unit`、非空 `included` 文本列表及 `excluded` 文本列表。
- `user_supplied_homepages` 必须是列表；无用户主页时用 `[]`。每项严格包含：

```json
{
  "platform_key": "youtube",
  "subplatform": "",
  "input_url": "https://www.youtube.com/@name",
  "canonical_url": "https://www.youtube.com/@name",
  "canonicalization_route_id": ""
}
```

原始 URL 与最终 URL 都进入来源清单；最终 URL 必须对应一个 `confirmed` 或
`suspected_homepage` 账号。用户未扩展范围时，不把成员、员工、合作方或同名账号自动归到主体。

### 4.2 `verdict`

严格包含 `has_risk`、`result_level`、`overall_conclusion`。`has_risk` 必须等于
`risk_groups` 是否非空；`result_level` 只能是 `建议谨慎评估`、`建议评估` 或 `低合作风险`。
有风险不得使用 `低合作风险`，无风险必须使用 `低合作风险`。

### 4.3 `accounts`

每项严格包含：`platform_key`、`subplatform`、`subplatform_entry_id`、`url`、`handle`、
`status`、`identity_basis`、`source_urls`。`status` 只能是 `confirmed`、
`suspected_homepage`、`unconfirmed_candidate` 或 `excluded_candidate`。交付账号 URL 进入对应主页
模块及来源清单；同名但无法确认的账号不得写成主体主页。同一个具名平台或额外平台模块内，
`accounts` 与主页模块的 URL 顺序一致，所有 `confirmed` 必须排在所有 `suspected_homepage` 前。
每个平台模块自动选择的疑似主页至多一个；只要该模块已有用户提供且最终标为疑似的主页，就
不得再自动添加疑似主页。用户提供的多个疑似 URL 均保留，并通过
`subject.user_supplied_homepages[].canonical_url` 与自动候选区分，不新增无法核验的来源标签。

### 4.4 `representative_works`

每项严格包含：`title`、`role`、`client_or_publisher`、`source_url`、`notes`。
`source_url` 必须是真实直接来源并进入来源清单；不得推断来源未支持的角色。

## 5. 十四个平台与交付模块

`platforms` 必须恰好包含：

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

普通平台记录严格包含：`display_name`、`discovery_status`、`risk_group_ids`、
`subplatforms`、`delivery_modules`、`research_completion`。两个“其他”桶另含固定的
`other_platform_tail`。

`discovery_status` 只能是：

- `confirmed_account`
- `suspected_account`
- `related_content_only`
- `no_account_after_targeted_search`

模块键必须严格对应第四章：

- 微博：`homepage`、`keyword_search`、`topic`
- B站、抖音、小红书、知乎、网易云音乐、Facebook、INS、油管：`homepage`、
  `keyword_search`
- 贴吧：`homepage`、`topic_homepage`、`keyword_search`
- 豆瓣：`subject_homepage`、`keyword_search`
- X：`homepage`、`keyword_search`、`review_start_month`
- 境内其他：`baidu_search`
- 境外其他：`google_search`

主页型模块沿用第四章交付形状：

```json
{
  "status": "confirmed",
  "urls": ["https://真实主页"],
  "url_identity_statuses": {"https://真实主页": "confirmed"},
  "url_risk_group_ids": {"https://真实主页": []},
  "risk_group_ids": []
}
```

账号主页模块状态是 `confirmed`、`suspected` 或 `not_found`；话题／贴吧主题模块不使用
`suspected`。`not_found` 的 URL 和映射均为空。搜索模块严格为：

```json
{
  "url": "https://真实搜索结果页",
  "result_status": "no_risk",
  "risk_group_ids": []
}
```

`result_status` 只能是 `risk`、`no_risk` 或 `no_related_content`。内部
`no_risk_in_targeted_scope` 只出现在 `research_completion.scope_conclusion`，交付层再按第四章
固定文案映射；不得把这句内部状态直接写进成品。搜索模块使用 `no_risk` 时，至少应有一项
相关结果进入本路线的 `items_reviewed`；确无相关结果时使用 `no_related_content`。

X 有主页时 `review_start_month` 使用实际检查到的最早月份 `YYYY-MM`；无主页时为 `null`。

### 5.1 额外平台

额外平台只进入 `domestic_other.subplatforms` 或 `overseas_other.subplatforms`。每项严格包含：

```json
{
  "entry_id": "bandcamp-main",
  "name": "Bandcamp",
  "homepage": {},
  "research_completion": {}
}
```

`entry_id` 匹配 `[a-z0-9][a-z0-9_-]{0,63}`，主页模块只含一个主页 URL，路线模块键使用
`subplatform:<entry_id>`。无额外平台就用空列表，不创建占位项。

两个固定尾句分别为：

- `其他境内平台暂未发现相关账号或相关内容的负面及敏感信息。`
- `其他境外平台暂未发现相关账号或相关内容的负面及敏感信息。`

## 6. `research_completion` 与路线

每个平台和每个实际额外平台严格包含：

```json
{
  "status": "targeted_complete",
  "scope_conclusion": "no_risk_in_targeted_scope",
  "route_results": [],
  "completion_note": "已按三小时定向范围完成该平台检查。"
}
```

有风险链接时 `scope_conclusion` 必须为 `risk_found`；否则为
`no_risk_in_targeted_scope`。`completion_note` 必须准确区分：账号主页全部公开帖子文字已到自然
终点，搜索结果、媒体画面、音轨和第三方评论仍按定向范围；不得把后者写成全站穷尽。

每条路线严格包含：

```json
{
  "route_id": "youtube-search-main",
  "module_key": "keyword_search",
  "surface": "targeted_review",
  "account_or_query_url": "https://www.youtube.com/results?search_query=name",
  "resolved_url": "https://www.youtube.com/results?search_query=name",
  "tool_kind": "browser_ui",
  "tool_name": "Microsoft Edge",
  "browser_family": "microsoft_edge",
  "executor_id": "agent-youtube",
  "edge_window_continuity_id": "00000000-0000-4000-8000-000000000001",
  "edge_page_continuity_id": "00000000-0000-4000-8000-000000000002",
  "status": "targeted_complete",
  "termination": "target_scope_complete",
  "selection_rule": "platform_first_3_pages_or_30_results",
  "pages_checked": 3,
  "items_selected": 30,
  "items_reviewed": 30,
  "flagged_items": 0,
  "scope_stop_reason": "item_limit",
  "minimum_scope_met": true,
  "query_kind": "main_name",
  "query_text": "对象名称",
  "query_risk_group": "",
  "query_terms": [],
  "started_at": "2026-09-09T09:00:00+08:00",
  "completed_at": "2026-09-09T09:20:00+08:00",
  "flagged_item_ledger_path": null,
  "flagged_item_ledger_sha256": null,
  "resolved_by_route_ids": [],
  "boundary": ""
}
```

共同规则：

- `route_id` 全包唯一；`executor_id` 记录真实工作负责人。
- `tool_kind` 只能是 `browser_ui`、`microsoft_edge_visible`、`official_api`、
  `authorized_export` 或 `local_script`。新研究使用 `browser_ui`；其 `tool_name` 和
  `browser_family` 必须分别记录实际持久桌面浏览器名称和稳定家族标识。默认填实际使用的
  `Microsoft Edge` 与 `microsoft_edge`；明确使用且确认具有所需持久配置／登录态的 Chrome 等
  系统桌面浏览器可填写其真实名称。明显表示 Codex 内置／in-app／`iab`／临时 hosted／headless
  或其他临时浏览器的名称无效。`microsoft_edge_visible` 仅为旧包兼容别名，使用时两项固定为
  `Microsoft Edge` 与 `microsoft_edge`。非浏览器路线两项均为 `null`。两种浏览器值都表示符合
  上述限制的桌面交互式浏览器 UI 路线。字段名 `edge_window_continuity_id` 和
  `edge_page_continuity_id` 暂为 schema 兼容名，分别表示通用交互式浏览器窗口／页面连续性 id；
  交互式浏览器路线的两项 id 都是小写 UUIDv4，非浏览器 UI 路线两项为 `null`。同一页面 id 在
  全包内只属于一个窗口 id，其路线时间区间不得重叠；不同页面 id 可以并行。
- `status` 只能是 `targeted_complete`、`blocked` 或 `failed`。
- 完成路线固定使用 `termination: target_scope_complete`、`minimum_scope_met: true`、空
  `boundary` 与空 `resolved_by_route_ids`。
- 阻塞／失败路线必须保留真实边界、`minimum_scope_met: false`，并由同平台、同模块、同表面的
  完成路线解析。交互式浏览器登录／验证恢复的完成路线仍必须是交互式浏览器 UI 路线，并使用相同页面 id；仅当
  原调查页确已丢失且 `boundary` 以 `page_lost_new_continuity_required:` 起句时，才允许以新页面
  id 重新打开完全相同的入口 URL 并从 checkpoint 继续。API、
  导出或脚本不能冒充用户登录后的页面续跑。恢复路线沿用原入口 URL，且开始时间不得早于边界
  路线的完成时间。
- `items_selected` 必须等于 `items_reviewed`。对
  `homepage_all_public_text_to_natural_end` 路线，这两个数都是账号主页全部唯一公开帖数量，
  `items_reviewed` 表示每条必需文字均已完整取得并完成全词表／规则扫描；未命中干净帖不要求
  人工逐条精读。对其他路线，它们仍是所选定向范围的数量，不表示全站
  `discovered == reviewed`，也不要求记录未选择内容。
- 每个平台必须有已完成的交互式浏览器 UI 原生关键词／通用搜索路线。主页、项目主页、话题和主题
  贴吧只有在模块不是 `not_found` 或确有 URL 时才要求自己的交互式浏览器 UI 完成路线；`not_found`
  由该平台已完成的交互式浏览器 UI 原生搜索支持，不为同一个空结果复制路线。百度和 Google 各自的
  主名称路线和组合高风险路线都必须由交互式浏览器 UI 完成。十四个平台桶及每个纳入报告的额外主页
  各有至少一条完成的交互式浏览器 UI 路线；API、导出或本地脚本只能作为额外补充路线，不能满足上述
  必需模块、必需查询或主页／话题样本门槛。
- 每个实际交付的个人／官方／项目账号主页及额外平台账号主页 URL 都分别对应一条
  `homepage_pinned_all_latest20_popular10_historical1_applicable_tabs` 交互式浏览器 UI 完成路线；该路线的
  `account_or_query_url` 和 `resolved_url` 都必须精确等于该模块 URL。一个 URL 的路线不能替
  另一个 URL 交差。具名平台两项 URL 都必须具有该平台真实主页／项目主页／话题页形态，不能
  用带查询参数的搜索页、作品详情页或另一主页冒充；额外平台主页也不能是搜索引擎结果页或
  路径／查询参数已明确指向帖子、视频、作品、文章、曲目等单条内容的详情页。该路线只承载
  主页身份／外链与媒体样本，不代表账号主页全文完成。
- 每个实际交付的微博超话／话题页和贴吧主题吧 URL 都分别对应一条
  `topic_related_first_30_items` 交互式浏览器 UI 完成路线；两项 URL 精确等于该话题页 URL，只检查与
  主体相关的前 30 个唯一条目或更早真实耗尽，不执行账号主页的 20／10／1 媒体样本，也不穷尽
  整个第三方话题历史。
- 每个实际交付的个人／官方／项目账号主页及额外平台账号主页 URL，还必须分别对应一条
  `homepage_all_public_text_to_natural_end` 完成路线，且两项 URL 都精确等于该账号主页 URL。
  该路线只允许 `browser_ui`、兼容别名 `microsoft_edge_visible`、`official_api` 或
  `authorized_export`；每个唯一公开帖的
  标题、正文、发布配文和展开后的完整视频简介／说明均须取得并完成完整风险词表／规则扫描，
  所有风险／疑似风险命中回到交互式浏览器原内容页逐项核验。微博超话／话题页和贴吧主题吧等
  第三方话题模块不要求该全文路线，也不得用它冒充账号主页。

### 6.1 选择规则与停止原因

受控 `selection_rule`：

- `platform_first_3_pages_or_30_results`：平台内先以主体主名称检索；`strongest_handle` 非空且
  去掉前导 `@` 后与主名称不同时，再提交一条 handle 查询。无结果或同名冲突时才增加别名／
  身份消歧。每条查询检查前三页或 30 项，以先到者为准。
- `homepage_pinned_all_latest20_popular10_historical1_applicable_tabs`：打开所有用户给定及确认
  主页；查看简介、外链，并对媒体画面检查全部置顶、最新 20 项、原生热门 10 项、1 项历史
  样本，同时进入每个适用 tab 确认是否有内容。重复内容去重。该规则不缩减主页全文路线。
- `homepage_all_public_text_to_natural_end`：遍历每个纳入账号的全部自有公开内容页签到自然
  终点、正常游标耗尽或经验证为空；逐项取得简介、帖子标题、正文、发布配文和展开后的完整
  视频简介／说明，执行完整风险词表／规则扫描并对账。默认不要求逐视频取得字幕、语音转写，
  也不要求人工精读每条未命中干净帖；所有命中项必须回交互式浏览器页面核验语境。
- `topic_related_first_30_items`：只用于微博超话／话题页和贴吧主题吧；在该真实话题 URL 中审阅
  与主体相关的前 30 个唯一条目，或在不足 30 项时到相关结果真实耗尽。它不代表账号主页，
  不使用账号媒体样本，也不要求穷尽整个第三方话题历史。
- `main_name_first_10_pages`：百度／Google 主名称查询前 10 页。
- `combined_high_risk_first_3_pages`：百度／Google 一条组合高风险查询前 3 页。
- `user_risk_lead_targeted`：用户点名平台、事件、帖子或视频的定向闭环。
- `identity_resolution_targeted`：身份撞名、账号归属或跳转确认。
- `risk_context_followup`：已经发现的风险或疑似风险的上下文复核。

每条路线另存 `query_kind`、`query_text`、`query_risk_group`、`query_terms`：

- `query_kind` 只能是 `main_name`、`strongest_handle`、`alias`、
  `combined_high_risk`、`non_query` 或 `targeted_followup`。
- 平台关键词路线至少有一条 `main_name`，其 `query_text` 精确等于主体主名称；需要 handle 时，
  另有一条 `strongest_handle`，其 `query_text` 精确等于 `subject.strongest_handle`。两者的
  `query_risk_group` 为空，`query_terms` 为 `[]`。
- `alias` 的 `query_text` 必须逐字来自 `subject.aliases`，并由交互式浏览器 UI 完成；它之前还必须有
  同模块的主名称／handle 无结果完成路线，或同平台、同模块、同表面已完成的身份消歧／用户
  线索路线，且该触发路线的完成时间不得晚于别名路线的开始时间。JSON 数组位置靠前但实际
  时间更晚，不算“之前”。其他模块或其他表面的无关跟进不能触发该别名查询。主查询有正常
  返回且没有上述身份或用户线索触发时，不得无条件扩大到别名。
- 百度／Google 主名称路线使用 `main_name`，并保存精确主名称；组合高风险路线使用
  `combined_high_risk`，保存实际提交的完整原始 `query_text`、非空风险组和 2—4 个实际包含在
  查询字符串中的代表词。两引擎使用同一个风险组和同序代表词；若存在用户风险线索，
  `user_risk_leads` 按用户优先级从高到低排列，组合查询风险组固定等于第一条线索的第一个
  `keyword_groups` 值，不能共同自报一个较低优先级的任意组；每个代表词还必须能逐字追溯到
  该首条线索的第一个风险表达、线索说明，或风险标准中同名风险组的关键词行，不能换成无关词。
  若没有用户风险线索，校验器从
  当前 `$env:BACKGROUND_CHECK_WORKSPACE\背调风险提示.md` 读取首个明确含“最高优先”的表格行：风险组必须等于该行
  首列，代表词必须是该行关键词列按 `/`、`、`、`；`、`,` 等分隔符拆出的完整词元；不能用
  一个词中的单字或任意子串凑够两项。
- 所有必需搜索路线的 `query_text` 必须精确等于从 `account_or_query_url` 原生查询参数或搜索
  路径解码得到的实际提交文本；URL 必须同时匹配该平台受控的真实搜索路径和对应非空查询参数，
  不能在主页、`/about/` 等无关路径上附加同名参数冒充搜索结果。完成路线的 `resolved_url` 也
  必须保持同一真实搜索路径并解码为同一查询，可以保留正常分页参数，但不能漂到根页或另一
  查询。不能只改 JSON 字段而保留另一个查询 URL。
- 两种主页路线均使用 `non_query`，三项查询内容字段全部为空；用户线索、身份和风险跟进使用
  `targeted_followup`。若跟进直接打开详情页，查询字段为空；若确实提交风险查询，则保存实际
  查询、风险组和 1—4 个代表词。

停止原因 `scope_stop_reason`：

- 平台搜索在第 3 页停止用 `page_limit`；第 30 项先到用 `item_limit`；更早确实没有后续结果
  用 `results_exhausted_early`。
- 主名称搜索在第 10 页停止用 `page_limit`，组合风险查询在第 3 页停止用 `page_limit`；更早
  无结果用 `results_exhausted_early`。
- 主页身份／媒体样本完成用 `scope_sample_complete`。
- 话题相关项达到 30 条用 `item_limit`；不足 30 条且相关结果真实耗尽用
  `results_exhausted_early`。
- 账号主页全文路线有内容时只接受 `natural_end` 或 `cursor_exhausted`，并要求
  `items_selected == items_reviewed >= 1`；经验证确为空时只接受 `empty_timeline`，并要求两项
  均为 0。固定页数、条数、时间窗口、平台可见窗口、重复游标或导出上限都不能冒充自然终点。
- 用户线索、身份或风险上下文闭环用 `target_resolved`。
- 阻塞用 `access_boundary`，失败用 `route_failed`。

`minimum_scope_met` 和停止原因只是人工范围声明及机械一致性字段。校验器不能凭 JSON 本身
证明置顶、20／10／1、所有适用 tab、全部正文或自然终点真的被取得；执行者仍对真实检查负责。

## 7. 普通干净项与风险／疑似风险台账

账号主页全部公开帖子文字必须在任务 `process` 中保留可对账的正文清单或批量导出结果，至少能
核对唯一内容标识／规范 URL、必需文字字段、页数或游标、日期范围、总数和停止原因；schema
1.11 不为每条未命中干净帖强制增加 JSON 字段、独立哈希、截图、OCR 或人工精读证明。全文
路线通过 `items_selected == items_reviewed` 声明全部唯一帖已完成文字取得与全词表／规则扫描。
其他普通干净内容只在路线中保存检查时间、入口／结束 URL、选择规则、页数、所选数、已审数
与范围结论：

- `flagged_items: 0`
- `flagged_item_ledger_path: null`
- `flagged_item_ledger_sha256: null`

只有实际风险、疑似风险、用户点名线索或需解释的误报进入轻量
`flagged_item_ledger_path`。文件是 UTF-8 JSONL，路线保存 SHA-256；行数必须等于
`flagged_items`，且不得超过 `items_reviewed`。每行至少包含：

```json
{
  "platform_key": "youtube",
  "item_id": "abc123",
  "url": "https://www.youtube.com/watch?v=abc123",
  "content_type": "video",
  "title": "详情页标题",
  "text": "完整展开简介",
  "review_status": "reviewed",
  "risk_decision": "risk",
  "risk_group_id": "risk-001",
  "review_reason": "结合上下文确认该内容存在风险。",
  "selection_basis": ["risk_hit"],
  "attribution": "subject_original",
  "video_review": {}
}
```

`risk_decision` 只能是 `risk`、`no_risk`、`false_positive` 或 `out_of_scope`；风险项必须有真实
风险组 id，其他项留空。`selection_basis` 是非空、唯一列表，只使用：`pinned`、`latest`、
`popular_top10`、`historical_sample`、`user_risk_lead`、`risk_hit`、`suspected_signal`、
`subject_reply`、`risk_interaction_chain`、`hot_comment_top20`、`search_scope`。

`attribution` 只能是 `subject_original`、`subject_reply`、`third_party_comment`、
`subject_interaction`、`external_source` 或 `uncertain_identity`，用于把主体原帖、主体回复、
第三方评论、点赞／转发互动、外部报道及身份不确定内容分开。

评论默认只选主体回复、风险内容互动链以及相关／热门前 20 条；不得把第三方评论或点赞写成
主体立场。

## 8. 视频

账号主页中的每条公开视频都必须通过全文路线取得标题、发布配文和展开后的完整简介／说明并
完成全词表／规则扫描；合规批量路线已取得这些字段时，不必为文字再次逐条打开详情页。定向
模式仍不打开所有视频画面，不要求所有视频完整播放，也不要求账号热门 10 条具有全音轨证明，
并且默认不要求逐视频取得字幕或语音转写。

- 选定范围内的普通视频检查标题、封面、完整展开简介并快速拖动；使用
  `mode: metadata_and_rapid_scrub`。
- 用户点名视频、风险视频和疑似风险视频升级到 `mode: targeted_10s_timeline`：全时间线按不大于
  10 秒间隔速查；发现实际风险／疑似命中后，回到命中位置附近查看完整语义段。
- 用户点名视频完成全时间线后若没有命中，不伪造命中时间或语义段。
- 默认不要求完整音轨；有风险语义需要听取时，只核查与命中有关的语义段。可以真实记录
  `full_audio_reviewed: true`，但校验器不会要求它为 true。
- 油管 `watch`／`shorts`／`live`、B站 `/video/` 等明确视频 URL 仍按视频校验；不得通过把
  `content_type` 改成普通帖子或清空 `media_kinds` 来绕过视频复核字段。
- `max_interval_seconds` 与所有命中时间必须是有限数值；`NaN`、正负无穷和负数无效。

`video_review` 严格包含：

```json
{
  "mode": "targeted_10s_timeline",
  "title_reviewed": true,
  "cover_reviewed": true,
  "description_reviewed": true,
  "rapid_scrub_reviewed": true,
  "full_timeline_reviewed": true,
  "max_interval_seconds": 10,
  "semantic_segment_reviewed": true,
  "full_audio_reviewed": false,
  "hit_timestamps_seconds": [20]
}
```

普通视频使用 `full_timeline_reviewed: false`、`max_interval_seconds: null`、
`semantic_segment_reviewed: false`、空命中列表。用户点名但无命中时仍完成不大于 10 秒间隔的
全时间线，语义段为 false、命中列表为空。实际风险、疑似风险或误报命中必须有至少一个真实
命中时间并完成附近语义段复核。

## 9. 风险组与证据闭环

`risk_summary_order` 必须逐项等于 `risk_groups[].id` 的顺序。每个风险组严格包含：`id`、
`title`、`category`、`summary`、`explanation`、`instances`。每个实例严格包含：

```json
{
  "platform_key": "youtube",
  "subplatform": "",
  "module_targets": [
    {"module_key": "keyword_search", "module_url": "https://真实搜索页"}
  ],
  "published_at": "2026-01-01",
  "finding": "一条事实句。",
  "source_url": "https://直接帖子或视频页",
  "source_type": "official_account_content",
  "screenshots": [
    {
      "path": "<WORKSPACE>/.../risk.png",
      "caption": "风险位置",
      "platform_label": "油管",
      "visible_text": "截图中的关键文字或画面说明",
      "sha256": "64位小写SHA-256"
    }
  ]
}
```

所有实际发现风险都必须同时满足：

1. 一句只陈述一个可证事实；
2. `source_url` 是直接内容 URL，不是主页、搜索页或占位链接，并且不得等于任何交付账号 URL、
   第四章主页／话题 URL 或搜索模块 URL；校验比较会忽略 fragment、尾斜杠及常见追踪参数，
   不得用 `utm_*` 等无害变体伪装成另一条 URL；具名平台使用直接帖子／视频／内容页形态，
   且路径或查询中必须有非空作品／帖子／视频 ID，不能把 `/shorts/`、`/reel/`、`watch?v=` 等
   空详情入口当作内容直链；境内外其他来源也不能使用网站根主页或任何搜索引擎结果页；
3. 至少一张真实 PNG／JPEG／WebP 截图，文件位于 `$env:BACKGROUND_CHECK_WORKSPACE` 下、最大 20 MB、签名和
   SHA-256 相符；
4. 风险组、平台、第四章模块及准确模块 URL 双向映射；
5. 同平台／模块的 flagged 台账含同一风险组 id 和直接 URL；
6. 主体原帖、主体回复、第三方评论和互动行为分别归属，不相互替换；疑似主页证据始终保留
   “疑似主页”身份边界。

截图文件不得跨平台或跨不同来源 URL 复用。发现风险后仍完成该平台的既定定向范围，但不升级
为全站穷尽。

## 10. 用户风险线索

`coverage.user_risk_leads` 是用户点名平台、帖子／视频、事件、指控或其他具体风险线索的
权威清单，按用户优先级从高到低排列，每项的 `keyword_groups` 也按优先级排列。确无具体线索
时使用 `[]`；不能用空列表隐藏用户已经给出的线索。每项严格包含：

```json
{
  "lead_id": "lead-001",
  "platform_keys": ["youtube"],
  "keyword_groups": ["用户点名的风险表达"],
  "description": "保留足以审计的用户原始线索。",
  "resolution_status": "risk_found",
  "risk_group_ids": ["risk-001"],
  "resolved_route_ids": ["youtube-risk-followup"],
  "resolution_note": "说明如何闭环及最终结论。"
}
```

`resolution_status` 只能是 `risk_found`、`no_risk_in_targeted_scope` 或 `out_of_scope`。
`risk_found` 必须关联风险组，其他状态不得关联风险组。每个涉及的平台都必须由至少一条
`browser_ui + targeted_complete + user_risk_lead_targeted` 专用路线闭合；旧包可使用兼容别名
`microsoft_edge_visible`。普通搜索或
其他完成路线不能替代。`risk_found` 的专用路线必须有 flagged 台账，台账中
`selection_basis` 含 `user_risk_lead`，并逐项覆盖该线索关联的风险组；
`no_risk_in_targeted_scope` 或 `out_of_scope` 可由该专用路线、明确状态和非空结论说明闭合而不
伪造干净项台账。校验器只能检查已记录线索；研究与交付复核者仍须对照用户原始请求，确保
没有漏项、弱化或错映平台。

## 11. `coverage`

严格包含：

- `started_at`
- `completed_at`
- `user_risk_leads`
- `search_engines_checked`
- `source_inventory`
- `pending_cross_platform_leads`
- `target_scope`

`search_engines_checked` 必须恰好含小写 `baidu` 和 `google`。`source_inventory` 是非空、唯一的
真实 HTTP(S) URL 列表，至少覆盖简介来源、交付账号、用户主页输入与最终地址、作品来源、
第四章模块 URL 及所有风险直接 URL。最终 `pending_cross_platform_leads` 必须为 `[]`。

## 12. QA 与最终门禁

`qa` 严格包含以下布尔项且全部为 true：

```json
{
  "all_fourteen_platforms_visited": true,
  "all_user_risk_leads_closed": true,
  "selected_items_reviewed": true,
  "all_found_risks_evidenced": true,
  "delivery_modules_mapped": true,
  "no_unresolved_platforms": true,
  "delivery_payload_validated": true
}
```

其中 `selected_items_reviewed` 同时声明：账号主页全部唯一公开帖的必需文字均已取得并完成
全词表／规则扫描，其他定向路线的全部选中项均已审完。它不能把固定上限或窗口边界改写为
自然终点。

这些布尔值不能替代机械校验。交付前必须运行：

```powershell
python scripts/validate_research_payload.py "$env:BACKGROUND_CHECK_WORKSPACE\...\research_payload.json"
```

校验器对 `schema 1.11 + three_hour_targeted_v1` 执行本契约；对旧 `schema 1.10` 原样执行
`exhaustive_audit`。结构诊断模式不能授权交付。随后仍须写入飞书、回读完整块列表，并运行
`validate_feishu_document.py`；只有研究包、最终文档结构、风险截图、直接链接和第四章格式全部
通过后才能返回链接。
