# 甲方质询执行记录与门禁

主流程维护一份 `client_challenge_review` v2。以下记录是主流程内部核验数据；**不得把这些字段、报告或缓存交给甲方子代理**。它的首轮输入只有名词表，后续输入只有 Skill 规定的六项事实。固定角色、规则和完整风险表是判定基准，不是本次调查材料。

## 来源及名词表

从已通过 `discovery_review` v2 的全部实体导出当前 `name` 与 `aliases`，按原词保留，使用稳定唯一 ID，不附风险分类、实体背景或上下文。名词表和首轮实际输入均为以下形式的 JSON 数组，二者内容须完全一致：

```json
[{"id":"N01","name":"Example Stage"},{"id":"N02","name":"示例舞台"}]
```

同一实体的多个原词可分别接受态度；出现内容通过原有语义记录对应到该实体。不得通过只导出已知风险词、遗漏别名或改名隐藏疑点。被问词在答复中使用表内原名，不换成主流程自行挑选的安全称谓。

仅在当前真实来源通过[发现阶段的合法空集规则](../../background-check-research/references/discovery-check.md#v2-状态与实际依据)时，完整名词表可以为 `[]`：逐条语义确实无名词，或实际空来源批次有带指纹的零结果／客观不可访问证据。门禁重新读取来源和独立研究回执，不能仅信空表或旧 PASS；未知访问数量继续为 `null`，不补造正文、名词或搜索回执。此分支仍须实际创建不同于调查名词代理的无缓存甲方子代理，首轮输入 `[]`、真实返回 `[]`，并保存一次实际轮次、空答复、工具依据和持续记录。不得用 `rounds:[]`、复用调查代理或跳过最新终审免除该环节；没有触发词时文字档案的 `terms/categories` 可为空。

启动前冻结已经完成上游审阅的 `discovery_review`；质询轮次、态度、答复和执行状态只更新独立的 `client_challenge_review` 及主任务状态，不能把日常质询进度塞回已审调查对象而改变其指纹。确实新增原始材料或名词时，按上游变化处理，不能伪装为仅更新进度。

若质询期间发现既有原帖的同名消歧错误，先由原名词查询代理核正，再重新执行发现阶段检查和完整终审。原始批次、任务版本、实体及别名清单均未增加或改名时，可以保留同一甲方代理和累计轮次，用 `discovery_correction` 记录一次元数据纠错：`previous_discovery` 为真实冻结调查文件引用，`revalidated_review` 为纠错后实际完整终审文件引用，`applies_from_answer` 为首次使用修正内容的答案轮次（2—4），另附具体 `reason` 和 `evidence_refs`。历史答案按原映射核验，后续答案和最终落点按修正映射核验；纠错终审须发生在该轮响应之后、修正答案之前，且修正答案必须再由同一甲方代理复评。禁止改写旧首次 PASS、旧答案或旧回执；此机制不允许新增材料、词表变更、清除既有警惕或重置五轮上限。

首次终审与最终终审针对同一实际交付目标。多份工作稿或共享文档流程先确定最后交付目标，完成该目标的原有终审后再启动一次甲方质询；工作稿阶段的 PASS 不重复创建甲方代理。共享回执仍只认证本任务已分配主体，不借整份文档摘要认证其他成员。

所有文件引用使用 `{path,sha256}`，路径指向本次实际文件，SHA-256 对实际文件字节计算。原始响应不得由主流程改写或添加字段。实际工具返回可以保存为 JSON 文件，创建／返回消息的引用另保留在内部记录中；不可伪造真实代理执行。

## 主记录字段

| 字段 | 要求 |
| --- | --- |
| `version` | 整数 `2`；v1 只用于显式历史回放，不能用于当前提交 |
| `task_id`、`source_revision` | 与当前调查记录一致 |
| `document_token`、`revision_id` | 当前待交付的成品版本 |
| `policy` | 当前完整业务风险表的文件引用，不能替换为助手摘要 |
| `nouns`、`first_input` | 完整名词表及首轮实际输入的文件引用 |
| `initial_final_review` | 创建甲方子代理前的实际完整终审 PASS 输出文件 |
| `current_final_review` | 全部事实答复、原帖补查及分类选例完成后的最新终审 PASS 输出文件 |
| `child` | 下述实际创建记录 |
| `rounds` | 按顺序保存实际 1—5 轮，不截去失败或拒绝轮次 |
| `ever_alert_ids` | 所有轮次曾 `警惕` 的 ID 并集，后续放松不删除 |
| `triggered_term_ids` | `ever_alert_ids` 与最后一轮仍 `疑问` 的 ID 并集 |
| `task_ledger` | 本次任务持续保存的创建／轮次汇总文件，不能用剩余轮次重建历史 |
| `followup` | 全部必记 ID 的原帖补查与文字归档文件引用 `{path,sha256}`，含分类与代表证据 |

子代理创建记录：

```text
child = {
  agent_id, created_agent_ids:[agent_id], fork_turns:"none",
  spawn_ref, spawned_at, proof:{path,sha256}
}
```

`proof` 的 JSON 精确包含 `task_id, source_revision, agent_id, fork_turns, spawn_ref, spawned_at, first_input_sha256, policy_sha256`。实际代理 ID 必须不同于主代理和调查阶段名词查询子代理。时间使用含时区的 ISO 8601；引用回到实际工具创建／返回消息。主代理核对代理工具活动，仅填这些字段不证明输入隔离。

## 逐轮记录及纯事实输入

每轮内部记录：

```text
{index, response:{path,sha256}, result_ref, responded_at,
 proof:{path,sha256}, answer:{path,sha256}, answer_ref, answered_at}
```

`response` 文件保存真实子代理原始数组：每个名词恰有一条 `{id,态度}`，或者对不合规答复使用 `{id,拒绝:"包含不合规的表述，拒绝接受"}`。拒绝项不得同时给态度，首轮没有事实答复可拒绝。每轮都完整返回名词表；格式违规须保留真实输出并退回规则，不暗改响应。

该轮 `proof` 精确包含 `task_id, source_revision, agent_id, index, result_ref, responded_at, response_sha256, input_sha256`。首轮输入指纹对应 `first_input`，其后对应上一轮 `answer`；不得把其他消息或工作缓存混在实际输入里。

`answer` 为数组，每项严格只有：`被问词, 出现链接, 出现原文, 上下文, 释义词所指代的对象, 实际含义`。前一个是原名字符串，后三个中的对象／含义为非空事实字符串；出现链接、出现原文、上下文均为等长非空字符串数组，按该实体出现位置的 `(batch_id,item_index)` 排序一一对应。主流程在内部维护来源映射，不能把 batch ID 等内部字段塞给子代理。

原文必须对应实际采集条目的完整正文，不用删去限定条件的片段。背景资料的归属和来源直接在对象／实际含义中事实性列明。上下文只能包含前后实际内容、时间及可核实引用关系；不能写“只是”“不构成”“不代表支持”等主流程推论。来源原文本来包含评价时保留原文及引用边界，不把原作者的评价当成主流程开脱。

图片观察记录不冒充贴主原话：该位置的“出现原文”可引用既有采集中同一原帖的完整正文，“上下文”另写实际画面内容。X 的 `/photo/N`、`/video/N` 与对应主帖须核对同一账号和 status ID；若媒体记录明确引用已采集的引用帖位置，且该位置含完全相同的图片链接，可使用包含主体附言和被引用内容的完整原文，保持引文归属。不能借无对应依据的邻帖替代；保留原批次及内部映射。没有可核对的原文时如实保留未知，不把执行说明或观察者推论放进原文。

每轮答案必须覆盖该轮全部疑问、警惕及拒绝项，不能多答无关放松项。全表放松时保存 `[]`。实际要发送给下一轮子代理的内容就是此数组，不附导语、风险判断或劝其放行的话。

首轮有疑问／警惕，需要事实答复后至少一次复评。最后一轮仍有疑问／警惕，也保存完整答复；其内容只能原样复用此前已发给子代理、且该词随后得到正常态度而未被后来拒绝的事实对象。同一对象后来被拒绝时，撤销其旧接受资格，不能在末轮从历史缓存恢复；只有后来确实再次被接受才能复用。新增实质措辞必须让子代理在剩余轮次审阅，不能在末轮塞入未经检查的开脱文字。最后一轮仍拒绝时直接 FAIL，不制造第六轮。仍警惕或疑问但事实已接受且补查、分类、归档及代表证据完整，不因此失败。

任务持续记录文件的结构为：

```text
{version:2,task_id,source_revision,created_agent_ids:[agent_id],
 rounds:[{index,agent_id,result_ref,response_sha256,answer_sha256}],
 triggered_term_ids:[最终必查并存档ID],ever_alert_ids:[所有曾警惕ID]}
```

这份汇总与各轮文件相互核对，用于识别缺轮、重置和误算；它不是工具调用真伪的密码学证明。主代理必须对照真实消息核验。

## 全量补查档案、类别合并与最新终审

全量名词质询、逐轮对应事实答复和所有必记名词逐项核查的范围不变。`triggered_term_ids` 只决定必须补查并文字归档的集合，不决定公开文档必须出现哪些词。按[分类合并规则](../../background-check-research/references/risk-consolidation.md)先核对原帖，再依据当前风险表归类、选例及存档。旧 `inclusion` 的“所有名词及出现位置必须公开落点”不再用于新提交。

`followup` 引用以下 UTF-8 JSON 文字档案；不同名词可引用同一份实际原帖缓存，不重复采集：

```text
{
  categories:[{
    id, platform, category, policy_excerpt, recommended_count, selection_reason,
    examples:[{batch_id,item_index,source_url,
      summary:{block_id,text},platform:{block_id,text},link:{block_id,text}}]
  }],
  terms:[{id,occurrences:[{
    batch_id,item_index,source_url,post_url,context,attribution,checked_at,
    evidence:{path,sha256},outcome,category_ids:[类别ID],reason
  }]}]
}
```

- `terms` 精确覆盖全部曾警惕及最终疑问 ID；每项 `occurrences` 覆盖该实体全部实际语境位置 `(batch_id,item_index)`。同帖重复提取可共享证据文件，但映射不能漏项。全量质询态度及释义记录继续保存，包括最终放松项。
- `source_url` 必须来自实际采集条目；`post_url` 是回归的原帖，须存在于实际核查的 `evidence` 文件。`context` 写原帖语境，`attribution` 写发言者及本人／第三方关系，`checked_at` 保存实际核查时间；可引用已经核实的完整缓存，不造重新访问记录。证据文件可为正文、媒体观察或已确认客观不可访问的页面状态 JSON。机器只能验证关联，实际读取和事实判断须有真实执行。
- `outcome` 仅允许 `risk`（命中具体类别）、`no_policy_hit`（按已核实语境无已成立类别命中，具体事实及未知如实存档）、`objective_unavailable`（已确认客观不可访问，按无问题结项）。后三种以外的未执行／待核状态不能伪装完成。`reason` 写分类依据及为何入选／同类超额归档／未命中／客观不可访问；不能为空或只写“已完成”。现有可见风险不能被不可访问结项抹掉。
- `risk` 的 `category_ids` 引用全部实际命中类别；其余两种为空。每个平台每个风险表类别只能有一个 `categories` 条目，别名、作者、原帖形式不能重开额度；`category` 使用风险表的类别原名，`policy_excerpt` 引用当前风险表包含该类别的实际条文，不得把“甲方疑问”或“名词关注项”另造为风险类别。
- `recommended_count` 为本类已选定的1—4例额度，通常3—4例；少量足以说明可收口，`selection_reason` 记录依据。每类 `examples` 为1至该额度例，包含原调查和质询补查共同入选的全部代表证据；达到选定额度后同类内容只保留在文字档案。每例绑定实际采集来源及终稿当前摘要／事实／完整链接；多个名词或同帖媒体变体不重复计例。
- 未入选的必查词及其原帖只需在文字档案中可核对，不要求名字或每条 URL 出现在终稿。入选正文写清实际行为与归因，不要求故意塞入所有参与人名、节目名称和别名。
- 不同类别使用不同的终稿风险索引；同一类别的正文公开事实都须属于其共用选例集合，不能旧正文留十几例、另声称补查只选三例。新实质风险和反证须核实并在类别摘要／代表证据中体现；语义拆分是否合理由实际终审核对。
- `categories` 可为空，前提是全量补查实际没有成立的类别命中；不能因质询态度仍警惕／疑问强造风险。全部词放松且无触发时，`terms` 和 `categories` 都为空，质询全过程仍保留。

终审文件直接使用 `audit_feishu_snapshot.py` 的完整输出，不用自填 `PASS` 摘要替代。要求 `verdict` 与 `receipt.verdict` 均为 PASS，错误和阻碍均为空，含文档 token、revision、`generated_at` 及 `document_sha256`。初次终审时间早于子代理创建；最终终审时间不早于全部答复，且 token、revision、完整区块摘要与当前成品一致。

完整输出与 `receipt` 还须一致绑定 `discovery_binding:{task_id,source_revision,discovery_sha256}`、`policy_sha256` 和 `risk_locations:[{risk_group_index,summary_location,platform_location}]`。调查摘要对当前完整 `discovery_review` 的规范 JSON 计算；不能拿同一共享文档另一对象的 PASS 充当本对象的依据。入选证据风险落点由原终审从已核验的风险摘要和平台正文角色生成，不由质询执行者另造；分类和选例发生在调查／交付阶段，档案中的超额事实不要求公开落点。共享文档保留原有 `assigned_subject_only`、主体和批次认证边界，完整文档摘要不扩大审阅范围。

若输入名词、调查材料或风险表变化，返回相应上游步骤补做；不得强行使旧回执匹配新内容、抹掉曾警惕项或重置五轮。新正文必须重新终审；审阅无需重新启动甲方子代理。

## 调用方式

本 Skill 的普通提交检查不要求研究包。准备一个指向当前实际任务材料的 JSON 对象，字段为 `client_challenge_review, discovery_review, items, document_token, revision_id, required_policy_path`；`items` 为当前完整文档区块，不能只摘取命中部分，`required_policy_path` 指向工作区当前风险表。飞书上下文另把同一主记录放入 `review_context.client_challenge_review`。

```powershell
. "$env:BACKGROUND_CHECK_WORKSPACE\recovery-session-env.ps1"
& $env:RESEARCH_PYTHON "$env:BACKCHECK_SKILLS_ROOT\client-challenge-background-check\scripts\client_challenge_gate.py" --state <当前提交状态JSON>
```

返回 `PASS/FAIL/BLOCKED`、具体错误、`ever_alert_ids` 及 `triggered_term_ids`。CLI 和默认 API 只接受 v2；`historical_v1=True` 仅用于显式复核旧档案，不提供 CLI 发布选项，也不能据此宣称旧成稿已符合新规则。失败时按对应缺失规则补做，不改状态绕过。机器交付校验器在最终 release 阶段调用同一函数；初次内容终审与 `--audit-only` 不依赖质询，以免先有质询才能获得启动质询所需 PASS 的循环。

对话内交付同样必须实际执行本 Skill 的新子代理、事实答复、全量原帖核查归档及类别选例核对，使用固定版本的最终答复及对应位置完成审阅；不得伪造飞书 token、区块或飞书终审回执去适配脚本。当前脚本针对真实飞书快照；无飞书时在任务内保留同等逐项人工核验结果，不能声称通过了飞书机器门禁。

脚本能校验字段、文件和当前内容绑定，不能自行证明没有遗漏名词、原始调查完整、代理确实未读缓存、释义是否事实准确或自然语言是否夹带判断。这些由真实执行、子代理拒绝机制及主流程事实核验共同负责；不得把机器 PASS 宣称为零遗漏或客观性保证。
