# 轻量质询记录 v3

规则只在[甲方质询技能](../SKILL.md)维护。本文件描述机器接口，不新增逐词搜索、前置终审或逐轮哈希要求。

## 主记录

```text
client_challenge_review = {
  version:3, task_id, source_revision, document_token, revision_id,
  policy_path:当前完整风险表路径,
  nouns:[{id,name}],
  child:{agent_id,created_agent_ids:[agent_id],fork_turns:"none",spawn_ref,spawned_at},
  rounds:[{index,agent_id,input,input_ref,response,result_ref,responded_at}],
  inclusions:[{id,occurrences:[{
    batch_id,item_index,source_url,kind,
    summary:{block_id,text},platform:{block_id,text},link:{block_id,text}
  }]}],
  current_final_review:实际最新完整终审输出文件路径
}
```

`nouns/input/response/inclusions` 可以内联，也可引用现有 JSON 文件路径或 `{path}`，无须新增哈希。已有采集文件的哈希继续核对；实际成品的原有文档版本与全文摘要校验保留。事件时间仅在真实可得时填写且带时区，不猜造工具未提供的精确时刻。消息定位可用实际 canonical task_name、调用／返回类型、轮次及保存的原始输入输出路径，不要求工具未提供的消息 UUID；脚本不证明自填定位真实。

`nouns` 完整导出调查记录的原名及已知别名，使用唯一稳定 ID。首轮 `input` 与此数组一致；后续 `input` 是本轮必要的六项事实数组，字段与主 Skill 相同。响应只含本轮输入对应的 ID 和态度／固定拒绝，按输入顺序，不重复已结束项。

每个首次疑问／警惕必须收到事实说明和实际复评。已解释的持续警惕／疑问可停止追问并收录；尚未处理的拒绝必须改写复评。停止询问的词保留最后态度。有实质新事实或消歧纠正时可重新询问已放松的词，仍使用六字段，不重复原样答案、不重置轮数、不撤销历史警惕。可选的 `ever_alert_ids/triggered_term_ids` 若提供，须与真实轮次重算结果一致；不另外维护强制 ledger/proof 文件。

六项事实中的链接、原文片段、上下文数组一一对应本次必要来源。片段必须是该名词实际来源的原文，不要求等于全部正文，不逐位置复制整篇文章。来源中的关键限定和不同语境由实际阅读核对。

## 终稿映射

`inclusions` 精确覆盖任一轮曾警惕及最终仍疑问的名词，每个关联原始位置 `(batch_id,item_index)` 都要有终稿事实和链接。多个名词、重复采集的同一原帖可以复用同一公开位置，不重复写正文。不能只把必记项放内部档案。

曾警惕项目 `kind="risk"`，即使最新态度为放松仍然如此。其 `summary/platform` 必须对应原有终审输出中实际审过的 `risk_locations`；若尚未命中具体业务类别，可在风险部分准确记录甲方关注及具体未知，不把未知编造成已证实指控。从未警惕但最终疑问使用 `kind="unresolved_doubt"`，公开平台文字明确标注“待确认”。

`source_url` 来自实际采集条目，`link` 位置包含完整可见 URL 或真实超链接；`platform` 写清所指对象与具体事实，不以空标题、仅有 URL 或无关履历代替。各别名共用同一实体出现映射；不同实体不能借同名合并。合并与截图额度不免除公开覆盖。

`current_final_review` 直接使用原有终审完整输出。根与 receipt 的 PASS、文档 token/revision、完整文档摘要、当前调查及风险表绑定必须一致；终审时间在最后实际复评和成稿之后。不需要 `initial_final_review`。

## 调用与续作

```powershell
. "$env:BACKGROUND_CHECK_WORKSPACE\recovery-session-env.ps1"
& $env:RESEARCH_PYTHON "$env:BACKCHECK_SKILLS_ROOT\client-challenge-background-check\scripts\client_challenge_gate.py" --state <提交状态JSON>
```

状态字段沿用 `client_challenge_review,discovery_review,items,document_token,revision_id,required_policy_path`，`items` 是完整成品区块。对话内交付按同等规则核对实际最终答复及位置，不伪造飞书回执适配机器接口。

CLI 和普通 API 只接受 v3。`historical_v1=True` 或 `historical_v2=True` 仅用于明确回放旧记录，不用于提交；旧测试不能证明新流程行为。材料或名词有实质增加时更新对应提取与质询覆盖，不重做已读平台、不改写旧态度，也不重置本任务五轮上限。原始事实消歧纠错保留依据并交回同一甲方复评，历史警惕不删除。

## 显式补漏与历史来源映射

用户明确授权的补漏例外使用 `user_authorized_exception`，包含本任务request_id、授权原文和真实消息定位authorization_ref、same_agent、history_preserved:true、scope名词ID、max_additional_rounds（1或2）、实际连续actual_rounds。不得修改首轮；第6轮只收授权漏词，后续仅作这些词的必要复评；默认五轮不变。

历史输入不得改写。原文分段摘录、图片转录与单页多段摘录可以在对应round之外保存 `source_excerpt_reviews`、`source_array_mappings`。每段文字须逐字对应实际源，图片转录和后来直接回读须绑定本地文件哈希、URL及实际人工阅读；补读不能冒充当时已提供的材料。当前事实纠错单独记录，不能冒充甲方新态度。校验器核对每个原始字符、来源及数组索引完整覆盖，不能凭一句“人工通过”跳过。

斜线分组显示名保留完整导出，正文可使用其中已核实的实际名称。无结果查询页中的助手查询词不算主体原帖出现项，需保留原缓存并记录语义映射更正。涉及未成年露骨内容的直链和图像不得公开；`publication_restriction`须绑定实际来源哈希、审阅者和原因`minor_sexual_content_safety`，公开保留对应事实，机器仍检查历史警惕、风险位置与其他来源完整性。
