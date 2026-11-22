# 快速审阅上下文

路径示例中的 `<WORKSPACE>` 表示安装后解析出的工作区，不是可直接提交给工具的字面值。实际运行时从 `BACKGROUND_CHECK_WORKSPACE` 取得根目录，使用路径拼接生成绝对路径；这些本机运行记录留在被 Git 忽略的任务目录中。

审阅上下文只负责把“当前任务事实应写成什么”与“飞书现在写了什么”分开。一个任务建立一次；调查事实和平台合同未变化时，后续 revision 直接复用，不重新调查、不重新手工抄写十四个平台。本文件下面的 JSON 结构供单主体校验脚本使用；团队合并文档须另以全组派单顺序、每人十四平台和非本批区块保护为上下文，不把单主体标题结构套入。

## 基本结构

实际背调的 `client_challenge_review` 使用[甲方轻量 v3 契约](../../client-challenge-background-check/references/review-contract.md)。首轮全表及必要增量复评先于成稿；已闭环事项按同类去重规则选例，入选案例有公开事实、截图和来源对应，未闭环疑问仅内部记录，再完成最新终审。无需初次成品终审或逐轮哈希。

内部 `unresolved_items` 非空不构成 FAIL/BLOCKED。完成约定调查及必要复评后，按规则排除的疑问可以内部结项并继续交付，不需要全部查明。本文“事实或归因不足”的阻塞语义仅针对终稿保留断言、固定平台状态或实际执行验收所必需的事实；须公开的曾警惕原帖集合扣除这些内部疑问、已有同类风险覆盖的未选内容及用户明确审定删除。

```json
{
  "document": {
    "title": "9.12-对象名",
    "revision_id": 42
  },
  "block_list": {
    "has_more": false,
    "items": []
  },
  "review_context": {
    "subject_type": "person",
    "before_revision": 42,
    "after_revision": 42,
    "writer_id": "delivery-agent",
    "reviewer_id": "delivery-agent",
    "business_risk_review": {},
    "client_challenge_review": {},
    "risk_groups": [],
    "platforms": {},
    "disclaimer_review": {},
    "visual_check": {}
  }
}
```

`writer_id` 与 `reviewer_id` 可以相同，不为形式独立另起终审代理。甲方须实际新建且无调查缓存，调查阶段不再要求独立名词查询代理。

## 业务风险一致性复核

`review_context.business_risk_review.discovery_review` 复用当前调查的实际阅读、完整名词与来源记录，结构见[提取规程](../../background-check-research/references/discovery-check.md)。共享发现检查不再校验全量查询及查询代理；已核实事实仍按 `confirmed_hits` 或既有 `consolidation` 与终稿对应。甲方 v3 独立检查历史态度、入选案例和已有同类风险覆盖的内部去向，不强制重复公开同类原帖。

仅用户明确要求同步已有结论或排版时使用 `user_supplied/existing_report_only`，不把格式 PASS 当成完成新调查。实际调查继续真实阅读与提词，不产生查询回执前置要求。

每个当前 revision 都必须读取当前任务适用的用户业务风险表、公司关注口径和 `$env:BACKGROUND_CHECK_WORKSPACE\背调风险提示.md`，把研究材料中的全部已核实命中项先按风险表分类，再同风险摘要、平台主管代表证据、内部文字档案和结果等级反向比对，并在 `review_context.business_risk_review` 记录：

```json
{
  "status": "PASS",
  "scope": "current_business_risk_policy_and_full_document",
  "token": "目标文档token",
  "revision_id": 42,
  "policy_sources": [
    {
      "path": "<WORKSPACE>/背调风险提示.md",
      "sha256": "当前文件字节的64位小写SHA-256"
    }
  ],
  "discovery_review": "示意占位：必须从当前任务状态原样复制完整v2对象，不可提交此字符串",
  "confirmed_hits": [
    {
      "business_item": "命中的业务条目",
      "verified_fact": "已核实事实",
      "risk_group_index": 1,
      "summary_location": {"block_id": "风险摘要block id", "text": "当前风险摘要原文"},
      "platform_location": {"block_id": "平台主管事实block id", "text": "当前平台主管事实原文"},
      "result_level": "建议评估",
      "result_location": {"block_id": "背调结果block id", "text": "背调结果：建议评估"}
    }
  ],
  "conflicts": [],
  "reviewer_id": "delivery-agent",
  "checked_at": "2026-10-14T12:00:00+08:00"
}
```

业务风险判定依据用户当前风险表与公司明确口径。`policy_sources` 必须只列实际适用并经校验器允许的当前风险表绝对路径和当前文件字节 SHA-256；伪造、不存在或夹带未声明文件的来源直接 `FAIL`，文件已变化则 `BLOCKED` 并重新读取。每一条入选终稿的平台代表事实分别写一条 `confirmed_hits`；同一事件及其质询补充说明可以合并成一条准确事实，不同事件不能靠堆入一段绕过证据额度。普通同类重复事实可复用原档案；甲方曾警惕的入选案例在 v3 `inclusions` 中对应公开风险事实和来源，已有同类风险覆盖而未选入的内容使用 `same_category_omissions` 留存内部去向；`verified_fact` 必须逐字等于 `platform_location.text`。`summary_location`、`platform_location`、`result_location` 都必须是当前完整快照中真实存在且原文完全一致的 `{block_id,text}`；不存在或伪造位置直接 `FAIL`。每条命中用 `risk_group_index` 指向其顶部风险组；全部风险组必须至少有一条命中记录。

已核实风险类别或影响判断的实质风险因助手自身道德或价值判断被遗漏、排除或降级时，`status="FAIL"`，`conflicts` 逐项记录业务条目、事实、缺失位置和最小修正；任何其他 PASS 均不能抵消。只有事实或归因尚不足以决定命中时才用 `BLOCKED`。未读取当前口径、记录缺失、token/revision 未绑定当前文档，或未完成全部已核实命中项的类别覆盖与选例／归档核对同样为 `BLOCKED`；已完整归档的同类超额事实未公开展示不构成遗漏，不得自动补成 PASS。`scripts/audit_feishu_snapshot.py` 对缺失／待审记录返回 `BLOCKED`，对显式冲突、无效来源或不存在的位置返回 `FAIL`，只有完整且无冲突的当前记录才允许该门禁 `PASS`。

## 全文免责语义复核

逐项区分来源材料与助手说明。原帖引文、截图文字和第三方原话核对来源与语境；需要精简的助手免责或泛化解释记入 `findings`。`scripts/disclaimer_gate.py` 定位候选句并提示明确来源引文，当前全文语义结论与扫描结果共同参与验收：

```json
{
  "status": "PASS",
  "scope": "full_document",
  "policy_version": "1.1.0",
  "token": "目标文档token",
  "revision_id": 42,
  "text_sha256": "review_text_fingerprint(document, items, raw_content)计算值",
  "reviewer_id": "delivery-agent",
  "checked_at": "2026-10-12T20:00:00+08:00",
  "findings": []
}
```

将此对象放入 `review_context.disclaimer_review`。首次须实际阅读全文；后续完整文字指纹和规则版本未变时，沿用已完成语义复核并绑定当前 revision；文字改变时，实际阅读变更段及上下文，结合已读且未变部分覆盖当前全文。没有可用基线仍须全文通读。发现免责时 `status="FAIL"`，`findings` 逐项记录 `{location, excerpt, reason}`。有任何 findings 即 FAIL，即使填写了 PASS 或其他检查未完成也不得通过。未闭环的权属、账号或其他疑问只保留内部记录；终稿不得包含待确认或未完成表述，也不能改写成已核实或无问题。标准格式白名单独立于 expected_blocks，自创模块不能通过添加预期字段取得许可。

共享脚本导出 `review_text_fingerprint`、`review_document_token`、`DISCLAIMER_POLICY_VERSION` 和 `audit_disclaimer_review`，后者返回 `errors`、`blocked`、`info`、`text_sha256`。单主体、团队合并和严格交付路线均使用此门槛。指纹仅由已有快照自动计算，不要求 research payload、额外台账或取证包。记录须绑定全文内容、token、revision 和规则版本；缺失、未完成或过期为 BLOCKED。变更文字、标题、图注或 raw content 后更新语义差量并重绑；纯样式变化只重绑，无需人工重读。视觉 PASS 及 `expected_blocks` 不能替代语义复核。

## 平台上下文

`platforms` 必须且只能包含十四个平台。每个平台保存：

```json
{
  "微博": {
    "modules": [
      {
        "text": "（1）无个人主页；",
        "status": "no_result",
        "fact_evidence": {
          "source_type": "research_record",
          "source_locator": "<WORKSPACE>/YYYY-MM-DD/对象/调查结论.md#微博",
          "checked_at": "2026-09-12T19:50:00+08:00",
          "summary": "未确认到主体微博主页。",
          "confirmed_homepage_count": 0
        }
      }
    ],
    "risk_items": [],
    "expected_blocks": [
      {"kind": "text", "text": "（1）无个人主页；"}
    ]
  }
}
```

- `subject_type`：`person`、`organization` 或 `project`。
- `modules`：全部模块的精确成品文字；`status` 为 `no_result`、`checked_clean`、`risk`、`incomplete`、`not_applicable` 或下述有真实访问证据的 `objective_unavailable`，以及同一请求有用户明确例外的 `unavailable_closed`。
- 仅`境内其他内容`和`境外其他网站`的具名疑似主页可使用`（N）平台名疑似主页：URL`。该模块须以`platform_name`登记研究事实中的实际平台名，例如`"platform_name":"SoundCloud"`，并与正文标签精确相同；缺失或不匹配为BLOCKED。它仍须提供`confirmed_homepage_count:0`和大于零的`suspected_homepage_count`，不能把候选改成确认主页或无主页。该分支不放宽其他十二个平台的固定主页标签、关键词搜索或零结果要求。
- `fact_evidence`：沿用当前调查记录，必须有 `source_type`、`source_locator`、`checked_at`、`summary`。搜索模块带 `related_result_count`，主页带 `confirmed_homepage_count`，超话／主题贴吧带 `related_topic_count`；B站搜索另带 `checked_surfaces:["video","article"]`。
- `expected_blocks`：平台主管标题之后、唯一尾随空白块之前的完整顺序；类型为 `text`、`url`、`image`。
- `risk_items` 与 `risk_groups`：有风险时各平台 `risk_items` 按正文出现顺序列出 `{group_index, fact_text, image_count, url}`；顶部每个 `risk_group` 记录 `{title, summary, highlight_text, target_block_id}`。摘要是短风险名，图钉解释可以复用正文核心段落；顶部只覆盖明确入选事实及对应图片，不要求在图钉下再复制正文。平台主管中保留但不进入顶部的事实设置 `include_in_top:false`；未填时默认为入选。普通 `target_kind:"platform_fact"`（可省略）要求 `target_block_id` 是本组首个入选平台主管事实区块。H4 不加链接，只有图钉高亮句链接到该目标。无风险时两处均为空数组。严格受限来源省略 `url`，改用 `source_kind:"restricted_source"` 和 `restricted_source` 证据对象；公开评价只有稳定评论页而无可保留单条直链时使用下述 `platform_review_entry` 严格证据分支。

按用户2026-11-22更新，正文每个平台同类风险最多4个案例，超额或已有同类风险覆盖的未选内容仅留内部。`include_in_top:false` 只表示不放顶部举例，正文入选案例仍须 `image_count>=1`；不得用 `image_count:0` 追加事实和链接。真实来源、归属及必要复评仍须核对，同类去重不改变历史态度。

顶部证据采用原生双栏网格时，逐列检查事实与紧随图片，列宽保持50/50；展示顺序可以不同于平台主管顺序，但全部入选事实和图片必须对应，额外段落、缺图及无效列结构仍为FAIL。全文摘要、布局指纹和图钉跳转绑定原始完整区块树，不用展开后的临时序列替代成品快照。

用户明确要求联动风险在平台主管只写“联动风险见联动部分”、不重复展开时，风险组使用 `target_kind:"document_block"`，将 `target_block_id` 指向联动表格该行的对象文字块，并增加：`target_text`（该目标块的精确文字）、`target_row_contains`（至少包含该行联动风评和一个实际来源 URL 的字符串列表）、`top_evidence`（顶部实际展示的 `{fact_text,image_count,top_fact_location}` 列表）。校验器验证目标确实位于表格行、该行包含声明的风评与来源，图钉只链接这个目标；不会再要求在十四平台主管复制同一联动风险。`top_evidence` 只描述顶部结构，不代替业务风险、来源和表格正文复核。

顶部使用简写时，对应 `risk_items` 增加 `top_fact_text`。与正文不同的简写还需 `top_fact_review`，含 `status:"PASS"`、当前 `token`／`revision_id`、精确 `fact_text`／`top_fact_text`、`reviewer_id` 和 `checked_at`。实际语义审阅须确认两段属于同一事实，归属与关键限定未变；这些字段只是保存审阅结果，不能自动生成语义判断。缺失或过期时为 BLOCKED。没有简写字段时保留原来的逐字镜像检查，全部事实、截图数量、来源与跳转检查仍执行。

自2026-10-30支持 `top_fact_location:"highlight"`：该事实由图钉解释承载，不在图钉下另放相同事实块。`top_fact_text`（未填时使用 `fact_text`）必须精确等于本组实际 `highlight_text`；不同于正文时仍须上述逐条语义审阅，确认该条正文事实被解释准确涵盖。一个图钉解释可涵盖同一事件的多条事实，每条都独立绑定审阅结果，不能用一条记录豁免其余事实。对应图片依正文事实顺序排列并按各项 `image_count` 核对，原帖 URL、跳转及业务门禁保持。省略位置或使用 `"block"` 时兼容原独立事实块；未知位置直接失败。该字段不允许仅靠一个笼统标题省去事实说明。

### 公开评价条目只有稳定评论页 URL

仅当 Facebook Page 的公开 reviews 页面已实际定位到一条具名、具日、可见全文的评价，但平台不给出可保留的单条公开 URL 时，风险项可设置 `source_kind:"platform_review_entry"`。成品仍显示精确 reviews 页面 URL；`review_entry_evidence` 必须绑定任务目录内的 JSON 记录和真实页面截图，记录含 `page_url`、`author`、`published_at`、逐字 `text`、`screenshot_path`、`screenshot_sha256`。证据对象另含记录／截图的 SHA-256、当前 `reviewer_id` 与带时区 `checked_at`，且该记录路径必须由实际 Facebook 模块 `fact_evidence.source_locator` 或 `source_locators[].locator` 声明。校验器实际读取文件、核对哈希、页面 URL、日期和正文风险事实，不接受主页、搜索页、空白截图或只填非空字段。该分支不能用于普通帖子、可取得单帖链接的评价或其他平台。

### 已确认的客观不可访问

`objective_unavailable` 只用于已确认删除、封禁、关闭、私密、权限限制、明确不存在或媒体失效的来源；规则及实际访问证据格式沿用[发现合同](../../background-check-research/references/discovery-check.md)。模块 `fact_evidence.terminal_outcome` 必须含 `status:"complete"`、`kind:"objective_unavailable"`、`conclusion:"无问题"`、真实 `reason`、`evidence_refs` 和 `evidence:{path,sha256}`。校验器实际读取 JSON 文件并核对字节指纹、明确的访问原因和页面提示、带时区时间、`content_obtained:false`、`result_count:null`，不能用声明或空回执代替。

实际证据 `source_ref` 必须是当前模块可见 URL，`fact_evidence.source_locator` 指向该证据文件或同一 URL，`checked_at` 与原记录一致。当前模块对应的数量字段显式保留 `null`，不填零、不混用已核下限，不宣称已阅读全文。B站搜索仍须在来源记录和 `fact_evidence` 中同时保留视频、专栏的实际访问核查 `checked_surfaces:["video","article"]`。正文沿用模块标签，只记完整 URL 与“无问题”；不可访问的 X 主页不要求补造最早已读月份。十四平台、范围、最新 revision、全文及视觉审阅等其余验收不变。

已有风险保留 `risk` 及原风险证据；可附同一严格访问证明解释当前未知数量，不得用不可访问改成无风险或删除既有风险。未加载、超时、工具故障、未执行查询、可访问未读、证据不匹配均不能使用此分支。旧 `checked_clean` 或缺数量记录不自动升级；必须提交当前核查证据并重新通过各阶段检查。

### 已存在但当前空内容的微博超话

同名超话确实存在，且原页热门与最新均正常返回空内容时，保留完整 URL，精确写 `（3）超话/话题：完整URL 暂无帖子，无问题`。模块仍为 `checked_clean`，不能写 `no_result` 或“无超话”。`fact_evidence` 除通用来源、时间和实际摘要外，必须包含：

```json
{
  "related_topic_count": 1,
  "empty_existing_topic": true,
  "topic_content_count": 0,
  "topic_surface_states": {"hot": "empty", "latest": "empty"},
  "query_urls": ["与成品显示一致、实际检查的完整超话URL"]
}
```

此分支只适用于已核的微博空超话。主题存在数必须大于零，内容数必须为精确整数零；只查一个分类、错误页、登录框架、加载占位及未查看内容不能填写 empty。缺少必要事实为 BLOCKED，存在帖子却称“暂无帖子”为 FAIL；没有该组事实的普通话题仍使用原固定结论，不能借空主题字段绕过其他模块或门禁。

### 查询结果与其他已读内容分别记录

`related_result_count` 只指当前模块实际 URL 对应的名称/账号查询结果，不是全平台相关内容总数。豆瓣名称搜索正常为空，同时另一路线已读相关唱片条目时，名称模块仍为 `no_result`、计数 `0`、链接后写 `无涉及的内容及其互动`；人物主页按真实归属单独判断。已读唱片可在平台主管事实准备记录的 `additional_checked_content` 保存 URL、状态及独立来源，供业务与语义复核使用，不改变名称模块计数，不自动证明该内容已完成审阅，也不自动生成任何成品或语义 PASS。有风险事实仍须进入相应风险项，不能藏在补充记录中。其他查询返回相关结果时仍须使用 checked_clean/risk 与真实正数或已核下限，零结果不得改写成有结果。

### 受限来源：涉及未成年性暗示的公开直链

只有 X 风险事实的原帖直链会直接暴露涉及未成年人的露骨性内容时，才允许公开文档保留安全事实转述与遮挡图而不展示 URL。不得用此分支隐藏普通成人内容、政治内容、争议内容、失效链接或调查缺口，也不得因此删除、降级或弱化风险事实。

该风险项必须写为：

```json
{
  "group_index": 5,
  "fact_text": "与本地受限记录 report_summary 完全一致的安全事实转述",
  "image_count": 1,
  "source_kind": "restricted_source",
  "restricted_source": {
    "reason": "minor_sexual_content_safety",
    "record_path": "<WORKSPACE>/YYYY-MM-DD/对象/process/受限事实记录.json",
    "record_sha256": "64位小写SHA-256",
    "direct_url_sha256": "记录内 source_url 的 UTF-8 SHA-256",
    "original_image_path": "<WORKSPACE>/YYYY-MM-DD/对象/process/未遮挡原图.jpg",
    "original_image_sha256": "64位小写SHA-256",
    "safe_image_path": "<WORKSPACE>/YYYY-MM-DD/对象/process/公开遮挡图.jpg",
    "safe_image_sha256": "64位小写SHA-256",
    "reviewer_id": "与当前 review_context.reviewer_id 相同",
    "checked_at": "带时区的 ISO-8601 时间"
  }
}
```

记录文件必须位于 `$env:BACKGROUND_CHECK_WORKSPACE` 下、是小于 2 MiB 的现存 JSON，并逐字绑定 `fact_text`、确认账号归属、日期、帖子类型和真实 X status URL；原图与公开遮挡图必须是 `$env:BACKGROUND_CHECK_WORKSPACE` 下两个不同的现存图片文件，各自小于 10 MiB，路径须与记录文件一致。三份文件及直链哈希全部匹配，记录路径同时由当前 X 模块 `fact_evidence.source_locator` 或 `source_locators[].locator` 声明。公开文档和 `expected_blocks` 中该事实只允许“事实 → 安全图”，不得出现 URL；校验器仍会拒绝任何可见直链、哈希不一致、未确认归属、事实不一致、文件越界或把普通来源冒充受限来源的情况。

平台状态、URL或风险事实变化时只更新受影响平台主管上下文；文档仅修正文案时不重建它。不得从待审文档反推事实状态，但允许交付步骤根据当前任务事实和固定平台主管合同机械生成精确预期文字。

## 视觉模式

首次审阅或布局变化使用 `fresh`：

```json
{
  "mode": "fresh",
  "revision_id": 42,
  "token": "目标文档token",
  "method": "登录态页面连续只读检查",
  "checked_at": "2026-09-12T20:00:00+08:00",
  "checks": {
    "heading_levels": true,
    "cards_and_grids": true,
    "visible_platform_numbers": true,
    "spacing": true,
    "images": true
  }
}
```

不强制截图路径。只有发现缺陷、需要定位修复或用户明确要求保留证据时，才可另加 `evidence`。

仅文字或链接变化且布局指纹未变时使用 `reuse_layout`：

```json
{
  "mode": "reuse_layout",
  "revision_id": 43,
  "token": "目标文档token",
  "method": "复用上一版视觉PASS并由校验器比较布局指纹",
  "checked_at": "2026-09-12T20:02:00+08:00",
  "baseline_revision": 42,
  "baseline_verdict": "PASS",
  "baseline_layout_fingerprint": "上一版PASS回执中的layout_fingerprint"
}
```

校验器自行计算当前布局指纹；不相同就 `BLOCKED: VISUAL_LAYOUT_CHANGED`，转做一次 `fresh` 页面检查。相同则复用视觉 PASS，不打开整页、不截图。

## 风险内链实际跳转

仅对文档中实际存在的风险图钉内链，真实点击后确认展开的目标正文可见，在 `visual_check.jump_checks` 保存一次观察。API href／目标区块存在或 `clicked=true` 不能证明此结果。无风险或无此类内链时不增加点击任务。普通交付写入器与团队审阅调用方均沿用同一记录；团队校验器可调用共享 `audit_internal_jump`。

```python
from audit_feishu_snapshot import jump_fingerprint

# 仅在实际页面检查或用户确认落点后填写；不是由 API 检查自动生成 PASS。
record = {
    "token": token,
    "source_block_id": source_block_id,  # 图钉高亮句的文字区块
    "target_block_id": target_block_id,  # 本组正文首个风险事实区块
    "method": "live_page",             # 或 user_confirmation
    "target_visible": True,            # 目标正文已展开且实际可见
    "checked_at": observed_at,          # 真实观察时间，ISO-8601 含时区
    "jump_fingerprint": jump_fingerprint(items, token, source_block_id, target_block_id),
}
snapshot["review_context"]["visual_check"]["jump_checks"] = [record]
```

每个真实内链保存一条记录，多条时依次追加。`jump_fingerprint` 由已有区块树计算，绑定文档、锚点文字／href、目标及两端的祖先位置和显示结构，不要求截图、额外研究包或台账。来源、目标和相关位置结构未变时保留原观察时间与记录，校验器对当前快照重算比对；锚点、落点或相关结构变化才重新点击。普通文字修订不使无关跳转作废。缺少真实观察或绑定过期为 `BLOCKED: INTERNAL_JUMP_*`，不阻止其他已授权写入，但不得宣称终审 PASS。

## Revision 与回执

### 用户明确结案的不可用页面（2026-10-31）

只有用户明确允许保留不可用结论并结案时，使用模块状态 `unavailable_closed`，正文链接后写 `公开页面不可用。`，不能改写为“无问题”或“无个人主页”。这不是恢复访问、完成内容阅读或零结果的证明。

`fact_evidence.source_type` 为 `research_record`，`source_locator` 指向同一 `requestId` 的实际 ego 观察 JSON 节点，包含 `url`、`browser:"ego"`、`available:false`、`terminal_message`、完整 `text`、带时区 `checked_at`。`closure_instruction_locator` 指向同一请求用户指令节点，包含用户实际回答 `answer:"保留不可用说明并结案"` 和逐项获准的 `urls`。校验器核对当前模块 URL、页面终态原文、请求归属和用户原话，不接受登录框、加载中、无记录的失败或一般历史授权。其他未完成模块仍按原规则阻止 PASS。

Bluesky 的原生 `/profile/<actor>/post/<rkey>` 是单条帖子路径，不能因含 `/profile/` 而误判为主页。普通主页和不带 `/post/<rkey>` 的路径继续被拒绝为风险原帖来源。

### 本人编排的 Linktree 链接页内容

Linktree 的正文就是本人编排的链接清单，没有独立帖子路径。仅此域名的单账号页可使用 `source_kind:"link_page_content"`，保留 `事实 → 截图 → 完整页面 URL`。`link_page_evidence` 含工作区内 `record_path`、`record_sha256`、`screenshot_path`、`screenshot_sha256`；实际 ego 记录包含 `url`、`browser:"ego"`、`author`、完整 `text`、`visible_labels`、带时区 `checked_at` 和与事实逐字相同的 `report_summary`。该记录路径须由真实 Linktree 模块的 `fact_evidence.source_locator` 声明。校验器核对域名和单账号路径、原文标签、账号、哈希及事实绑定，不适用于普通社媒主页、搜索页、可取得原帖直链的内容或仅有链接标题却未经读取的页面。

`document.revision_id`、`before_revision`、`after_revision` 必须一致。末尾 revision 变化时只允许再抓一次最新完整快照：布局指纹不变就重跑确定性检查并复用视觉；布局变化才更新视觉检查。持续变化则 `BLOCKED`。

PASS 回执绑定 token、revision、layout_fingerprint、reviewer_id、script_version、免责规则版本、全文指纹和 UTC 时间。任何后续写入均重跑确定性检查，并将语义复核绑定当前全文；只有 layout_fingerprint 变化才使视觉基线失效，风险跳转另按各自 jump_fingerprint 判断是否重查。


## 百度索引摘要指向非公开 BOOTH 店铺（1.10.6）

仅 `境内其他内容` 的 `source_kind:"search_index_summary"` 可声明这一证据形态。它不是把主页认作原帖：源 URL 只登记实际观察的 HTTPS 默认端口 BOOTH 店根，必须保留“百度检索摘要”及店铺当前非公开的事实归因，不能声称当前商品详情、现售或可下单。普通主页、未知站点、搜索页、BOOTH 商品猜链及仅填写类型标签仍按原规则拒绝。

`risk_items[]` 需有真实原生摘要 `source_locator`，以及 `search_index_evidence`：

```json
{"scope":"index_only","current_product_details_unread":true,"excerpt":"原生摘要逐字全文","index_claim_literal":"摘要中实际出现的具体条目原文","query_record_locator":"绝对本地JSON路径","destination_record_locator":"绝对本地JSON路径","private_record_locator":"绝对本地JSON路径#/value/text"}
```

四个定位必须彼此不同，均由该实际百度模块 `fact_evidence.source_locator` 或 `source_locators[].locator` 明确声明，且解析为存在的绝对 JSON 文件及严格 JSON Pointer。校验器实际读取：原生 `ok:true` 摘要节点与逐字摘录；正确 `wd` 查询对应的 `title/cards` 及原观察的百度跳转链接；独立闭环记录中的确切 `indexedShop`、已核原生索引及 private 边界、未声称商品详情；未截断原页的 `Currently, this shop is private.` 正文。非空字符串或元数据布尔值不能独自满足条件；这项支持不生成业务、全文语义、图片实看或跳转 PASS。

### 来源原话的审阅

**助手附加的免责说明、证据边界套话及其变体仍为 `FAIL`。** 有明确来源归属的原帖引文和截图原文交由当前全文语义审阅核对，不能仅因来源原话命中关键词就删除证据。引用不能包裹或豁免助手文案，也不能伪造来源；发现归属错误、助手免责或其他实质文字问题仍为 `FAIL`。未闭环疑问只留内部，不进入终稿；必要来源归属与已核实事实保留。
