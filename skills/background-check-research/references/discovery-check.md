# 原文阅读、完整名词表与来源对应

名词表用于[虚拟甲方质询](../../client-challenge-background-check/SKILL.md)。调查主代理完整阅读用户范围内的材料，提取有具体指称的名词及其出现位置，不在质询前开展逐词背景研究，不另建名词查询子代理。

## 阅读和提取

- 保留原有平台、账号、时间窗和正文／媒体阅读范围。正文、配文、引用附言、本人回复及实际纳入的图片和视频均须实际阅读；缓存数量不能证明已读。
- 从已经阅读的材料提取全部特殊名词，包括人物、组织、作品、活动、演出、媒体、品牌、地名、口号、事件、域名、具体标签对象和原文别名。不按是否已知风险筛选名词；导航、普通日期和无具体指称的常用词不收录。
- 每条语义记录复用原缓存，保留 `batch_id,item_index,summary,names`；确实没有名词时保留具体 `no_special_terms_reason`。全范围确实无特殊名词时允许空表，不编造名称过检查。
- 去重表保存 `name,aliases,source_refs`。别名仅来自实际材料和有把握的识别，不为补全词典或证明常见名称而搜索；不能确定同一对象时保留不同原词。不同对象同名时用必要的上下文标签区分，保留原词及来源。
- 陌生、不确定的含义留给甲方表达疑问。名词提取不要求先有身份结论、背景来源、风险判断或逐项查询回执。

## 查漏与必要核实

原执行者复用已读材料做一次有边界的来源反查，核对是否漏提名词或漏读必要上下文。新词加入同一名词表，不因此启动逐词搜索。解释实际疑点时，优先原帖上下文和有把握的通用知识；只有确实不确定且会影响事实说明的事项才针对性核实，调查联网遵循当前访问规则。

## 现有记录与校验

继续复用 `discovery_review` v2 的实际采集、逐条语义、名词和来源记录；不重做已读平台，不把旧查询记录改成虚假的完成。旧 `subagent_review` 可保留作历史记录，但不再是完成条件，旧 `term_subagent_review` 步骤已退休。

必需步骤为 `source_collection,semantic_analysis,term_extraction,reverse_review`。校验实际批次、语义覆盖、完整名词与来源对应、反查结果及已经核实的应记事实。原有采集文件指纹可复用，不为质询每轮再生成哈希或重复证明文件。

全范围没有特殊名词时，`reverse_pass` 保留具体 `no_special_terms_reason` 和当前 `source_refs`；不要求查询子代理。声明 `truncated`、`text_truncated` 或 `needs_expansion` 的已采集正文仍须补齐，空名词表不能消除未读材料。

既有 v2 审计记录中的空采集批次须对应真实的零结果或客观不可访问观察。复用 `terminal_outcome` 的 `status:"complete"`、`kind:"no_results"` 或 `"objective_unavailable"`、实际原因、`evidence_refs` 及 `evidence:{path,sha256}`。证据 JSON 绑定当前 `source_ref`、带时区 `checked_at` 和 `access_outcome`；零结果须有 `collection_complete:true,result_count:0,observed_text`，客观不可访问须有明确的 `access_reason,access_message,content_obtained:false,result_count:null`。访问原因及业务结论遵循[当前访问规则](access-policy.md)。哈希失配、其他账号证据、加载中或超时不能结项；既有已核实事实也不会因此被删除。这是现有审计记录的校验合同，不新增普通交付的取证包要求。

```powershell
python "$env:BACKCHECK_SKILLS_ROOT/background-check-research/scripts/discovery_gate.py" --state <当前任务状态JSON>
```

`entities` 中已有独立调查核实的 `record_fact(s)` 仍需与终稿对应；普通名词不要求 `identity,background_refs,disposition` 等研究结论。确有尚未完成的正文、媒体或实际核实动作仍列 `open_items`；仅仅不知道词义不属于未完成平台调查。

脚本验证材料与记录的一致性，不能认证语义零遗漏或代理工具活动。发现真实漏读、漏提或来源错配时修正对应记录。用户仅要求同步已有结论时，保留原有 `user_supplied/existing_report_only` 的明确范围，不将排版通过称为新调查完成。

## 后续步骤

完成调查和必要画像补查 → 完整名词表交给一个新建、无调查缓存的甲方代理 → 简短事实说明与增量复评 → 按态度整理终稿 → 最新成品终审 → 提交检查。甲方质询不再以前置成品终审为启动条件。

质询角色、三态、六项事实、最多五轮和曾警惕事项的同类去重与选例收录以[甲方质询技能](../../client-challenge-background-check/SKILL.md)为唯一规则来源；[分类合并](risk-consolidation.md)控制正文选例上限；已有同类风险入稿时，曾警惕内容可只留内部记录。
