## 当前 D 盘恢复配置（2026-10-17）

路径示例中的 `<WORKSPACE>` 表示安装后解析出的工作区，不是可直接提交给工具的字面值。实际运行时从 `BACKGROUND_CHECK_WORKSPACE` 取得根目录，使用路径拼接生成绝对路径；这些本机运行记录留在被 Git 忽略的任务目录中。

本机实际派单模式为 `desktop_native_handoff_v1`，工作目录 `$env:BACKGROUND_CHECK_WORKSPACE`，会话 Home `$env:CODEX_HOME`。下方旧 CLI 模式说明仅保留为历史实现记录。使用工作区 `背调工具.cmd` 进行状态检查、凭证录入、登录、群绑定和启动；入口会加载 D 盘运行环境。配置文件是 `config/backcheck-local.json`。不直接按历史示例启动监听。

当前不启用记账；旧表格目标已移除。旧列名、单价与责任人规则仍须在启用新账本前核对。群邀请链接只是参考入口，必须用机器人实际可见的 chat ID 完成本机绑定。启动前先执行 `CheckFeishu` 验证模板用户访问。首次启动只处理启用时间之后的新消息。

# 飞书群 → Codex 背调桥接

这个服务使用现有“云CLI”飞书应用的 DPAPI 凭据，通过官方 WebSocket 长连接接收指定群里的消息，并每 5 秒轮询群历史作为投递兜底。完整派单可直接以 `【背调需求…】` 开头发送；普通直接请求使用 `@云CLI 背调 …`。服务先做结构化派单预检；确认可执行后，只在群里发送一条接单消息，按原文顺序逐行列出整张派单里所有成员的 `代号 → 编号 → 对象`，并按六个监看代号分人记账，再把仅属于本机三个代号的核准范围串行交给本机 Codex。

## 当前团队分工与记账（2026-10-11）

- 结构化预检监看 `TS、TS1、临A、临H、BK1、BK2`，完整接单表仍覆盖整张派单；本机只为 `TS、临A、BK1` 启动 Codex 调查。`TS1、临H、BK2` 只按另一责任人名下记账，不在本机研究。
- 每个来源消息及需求块的对象生成独立幂等键，写入前后回读。记账状态保存在 `state/accounting-ledger.json`，飞书目标为各月 `YY年M月bd汇总` 工作表。普通项记入王书鲲 A 列或另一责任人 E 列，每项 200；明确一年项记入 D/G 列，每项 50。特殊、私人及分类不明项暂不自动计费。
- 2026-10-12起，原文明示两个代号共同处理同一对象时，每码各是一份收费任务；同编号、同对象、不同代号保留两行，两人或同人两码均各计普通200/一年50。幂等键包含来源消息、需求块、编号、代号和对象，同一代号重复投递只计一次。此规则仅用于新单及明确授权重试单，历史订单不追溯收费；未能归因的已有同名人工账格仍会阻塞核对。
- 电子表格读取沿用现有飞书应用连接；写入使用本机既有飞书用户令牌。应用身份可读该表，但写入返回 HTTP 403。用户令牌在 2026-10-11 已验证可写；失效时只尝试已有刷新流程，不申请新权限。账本或写入失败会在任务状态和本机日志中标记，不向派单群发送额外消息。
- 新月份缺页时自动复制本工作簿中的已验证模板，保留格式、标题和合计公式，清空副本数据区，再按派发上海时区年月记账。创建过程持久记录，响应不确定时回读唯一月页，不能重复复制或清除人工新增内容。现有数据行用完时在合计行上方插入行，并把各列 `COUNTA` 范围扩至新行。既有空白数据行先填充，合计行下方不会追加。
- 历史最终归属修正使用明确的 `state/accounting-reconciliation.json` 计划，由常驻进程在连接后执行纯记账回填；不启动调查，不发历史回执。来源、日期、年期与用户归属授权保存在账本，后续重放尊重已审核归属。2026-10-11核对的转移两项均为一年，H列按50元计；特殊/私人倍率与值保持原样。

## 安全边界

- 只处理已绑定群中的明确命令或 `【背调需求…】` 完整派单；其他普通群消息静默忽略。
- 完整派单即使没有 `@云CLI`，也会由轮询兜底识别。
- 每条飞书消息按 `message_id` 持久去重。
- 消息先持久入队再认领；进程在中间退出时，重放不会丢单或生成第二个任务。
- 长连接与轮询共用同一消息处理、群绑定和去重逻辑；轮询水位持久保存，重启后从上次成功位置补收。
- 唯一的接单回复写入持久发件箱；飞书发送暂时失败时自动重试。
- 已绑定的派单群不发送受理、启动、心跳、完成、失败、飞书链接、状态、帮助或歧义提示。不可执行的消息只记录在本机状态和日志中。
- 背调任务串行执行，避免多个任务同时争用本机浏览器和登录态。
- 预检返回的编号重复、对象归属或结构校验失败只隔离该 `requestId`，记为 `failed/preflight_blocked` 和 `preflightFailureScope=request`；保持全局预检就绪，继续后续新单。失败单保持群内静默，未经同请求恢复审核不会自动重试。认证、全部候选模型不可用、网络重试耗尽及未识别异常记为 `preflightFailureScope=system`，仍阻止后续队列执行并保留待处理订单。单据错误不会清除已有系统阻塞。
- 每个新 requestId 通过固定版本 Codex CLI 和 ConPTY 创建 source=cli 对话；完成最小确认并持久绑定 requestId → threadId 后，以显式 UUID 运行 codex resume --no-daemon。CLI 会话文件和任务状态用于回读身份、权限及最终回复；同一 requestId 的中断不会自动重放。
- 当前安装默认 `CODEX_DISPATCH_MODE=desktop_native_handoff_v1`，沿用已绑定线程的创建方式。新机器需验证 Codex Desktop 的安装与派单入口，不能以离线 fixture 代替真实接单。其他历史模式保留供受控排查，不自动切换。
- CLI 建立对话时校验唯一标记、source=cli、originator=codex-tui、工作目录、CLI 版本、确认回复和只读/on-request/用户审核的运行上下文；正式续接再检查已绑定的会话文件和 requestId 标记。
- 新对话标题按 `飞书背调 日期｜前两个对象 等N项｜requestId` 生成，其中 `N` 按派单行数计算。CLI 的首条可见提示和真实执行提示都带该标题；标题工具不可用时不改变线程归属，也不改为复用旧对话。
- `requestId` 使用加密强随机后缀，任务存储同时强制 `requestId`、来源消息和 Codex thread 一对一唯一；重复绑定会让任务停止，不会猜测归属。
- 新建与续接开始前写入任务状态；CLI 续接标记在启动前持久化。进程中断、审批/信任/登录界面、会话不符、超时或验证失败一律进入 recovery_required，本地核对 rollout 后才能决定后续动作；不会自动再建对话或重放任务。
- CLI 子进程使用独立环境，去除父进程的 CODEX_* 会话变量，仅保留明确的 CODEX_HOME；执行固定为 workspace-write、on-request、用户审核、禁用沙箱内自动联网，不向 PTY 注入按键。
- `stop.ps1`、计划任务重装和卸载都先通过本机命名管道请求桥接进程自行退出。请求必须同时匹配 PID 和实例锁随机 token；桥接进程收到后先中止并回收仍在运行的 ConPTY，再断开飞书连接并释放 PID/实例锁。若在等待期限内未退出，脚本会重新核对 PID 文件、进程命令行和实例锁所有权，全部仍匹配时才强制终止。若中断发生在 bootstrap 阶段，任务保持 `recovery_required`，不会静默再建一个线程。
- 停机脚本与 Node 帮助程序明确使用 UTF-8 传递 JSON，保证中文根目录对应同一条命名管道；不依赖 Windows 默认 GB2312 编码。回归同时覆盖英文和中文临时目录中的独立测试进程。
- 计划任务直接运行 Node，并由每分钟健康触发器兜底拉起；异常退出后约 1 分钟自动重启，在电池供电时也保持运行。
- App Secret 继续由 `$env:BACKGROUND_CHECK_WORKSPACE\external\feishu-mcp\scripts\read-credential.ps1` 从 Windows DPAPI 读取，不写入本目录。
- 正式任务只有在每份飞书 docx 报告的终审快照经只读校验器重新算出 `PASS`、回执 token/revision 一致，且桥接器从飞书只读取得的最新 revision 仍一致时，才标记 `completed`。仅有飞书链接、文字自述“终审通过”、校验失败或文档又被编辑，均保持未完成。桥接器不向派单群发送这些状态。
- 请求正文作为不可信数据交给 Codex，并限制为公开来源背调范围。

## 交付终审凭据

执行背调的 Codex 在最终答复前，保存每份报告终审时实际使用的完整 JSON 快照，并写入 `state\review-evidence\<requestId>.json`：

```json
{
  "requestId": "RQ-...",
  "documents": [
    { "url": "https://my.feishu.cn/docx/报告token", "snapshotPath": "<WORKSPACE>/案件目录/终审快照.json" }
  ]
}
```

最终答复中列出的每个报告链接必须各有一项。桥接器独立运行个人 `review-feishu-background-check` 技能中的 `audit_feishu_snapshot.py`，再用现有飞书应用凭据执行只读文档 GET 核对最新 revision；接口没有读取文档的权限时不会把任务判为完成。此处不新增凭据或授权。

## 首次启动

```powershell
cd "$env:BACKGROUND_CHECK_WORKSPACE\tools\feishu-codex-bridge"
npm test
node .\src\check.mjs --review-access
pwsh -NoProfile -File ".\scripts\start.ps1"
```

在正式启动前，可在计划使用的 Windows 用户会话中只读检查飞书机器人、群列表和一份历史已完成报告的文档 revision 读取权限；此命令不创建 Codex 对话，也不发送群消息：

`reviewAccess.ok=false` 表示当前应用身份无法读取该历史文档的最新 revision，桥接器因此不会把新报告标记为完成。不要在聊天中粘贴凭据或原始错误日志。

以下旧空任务 SDK 探针只作历史记录，当前被保护性暂停；不要将它用于正式运行。

```powershell
node .\scripts\probe-empty-cli-thread.mjs
```

**当前暂停：**以上命令及 `--observe-terminal` 变体会立即以 `EMPTY_PROBE_PAUSED` 退出，不创建临时目录、任务或 Codex 进程，也不发送 PTY 按键。原探针每次使用新的系统临时目录，可能触发 Codex 的持久信任确认。待用户审阅固定目录及信任方案后，再修改探针并重新验证；勿将退出提示解释为已获得信任授权。

若要定位 CLI 回车后画面，使用同一隔离空任务的本地观察模式：

```powershell
node .\scripts\probe-empty-cli-thread.mjs --observe-terminal
```

该模式在回车后 2、5、15 秒输出按终端行号标注的脱敏画面。可识别的错误、警告、HTTP／系统错误码会保留可操作的文字，并替换其中的邮箱、路径、网址、设备码和凭据片段；非诊断文字仍隐藏。登录、授权或二维码画面整体隐藏，不输出认证内容。原始 PTY 数据只保留在进程内存中，不写入状态或日志。固定回复标记出现在画面上可能只是提示词回显，不能据此认定模型已回复；只有已验证的 session 事件可证实提交。请只提供脱敏观察结果，不要粘贴原始认证画面。

该脚本在系统临时目录建立隔离任务状态，测试对话只回复随机完成标识；不读取案件资料、不调用飞书、不发送群消息、不启动桥接监听或自启动。输出中的 `markerMatched` 与 `productionStateUnchanged` 应为 `true`。`titleApplied` 只表示 CLI 重命名步骤的结果；是否真的显示在 Codex 侧边栏还需要在用户界面核对。若当前账号出现 CLI 登录选择界面，脚本会因超时失败，不会自动登录或沿用其他账号的凭据。

探针启动后立即输出阶段，此后每 15 秒输出一次当前阶段与已等待秒数。CLI 等待输入回显稳定后再发送 Enter；发送后 20 秒内仍未发现新 session 即停止，总体引导上限为 180 秒，SDK 空回复最长等待 120 秒。默认模式的失败结果只包含阶段、错误类别和不含正文的 session 发现统计；观察模式另输出脱敏画面。`newSessionFileCount=0` 说明监视目录没有出现新 session 文件；大于 0 但仍无标记，说明尚不能证明初始提示已被提交。不要把 `cliSignInRequired=false` 单独解释为已成功登录。

首次启动后，从 `state\pairing.json` 读取八位绑定码，在目标群发送：

```text
@云CLI 绑定背调群 八位绑定码
```

服务会从这条真实群消息中记录 `chat_id`。邀请链接仅作为人工核对信息，不会被当作 `chat_id`。

## 群内派单

```text
@云CLI 背调 对象名；主页链接；补充范围
```

全组派单也可以直接发送，无需另加命令：

```text
【背调需求9.29】
ddl9.30下午五点前
每人两个
TS-TS3
1、对象甲
2、对象乙
……
```

如只想在本机验证分配是否正确，可在消息第一行加 `派单测试`。群里不会回复，也不会创建 Goal 或启动调查；映射从本机任务状态或 `check:dispatch` 命令读取：

```text
派单测试
【背调需求9.29】
……
```

本机监看 `TS`、`TS1`、`临A/A`、`临H/H`、`BK1`、`BK2`，只执行 `TS`、`临A/A`、`BK1` 的项目：

- 常规派单按代号顺序每人一项。
- 写明“每人两个”时，顺序为 `TS、TS、TS1、TS1、TS2、TS2……`。
- 显式的编号合并或代号对应关系优先。
- 显式多段范围按文字顺序展开，例如 `jw1-jw4，临a-j，bk1-bk2`；其他成员代号只参与位置计算。
- 接单消息中全组每个编号对象单独列一行；非本机代号只用于团队核对，不会进入本机 Goal、调查或交付。存在会改变本机归属的歧义时，不创建 Goal、不启动调查，并保持群内静默。

只验证派单识别、不启动背调：

```powershell
Get-Content -Raw ".\test\fixtures\sample-dispatch.txt" | npm run check:dispatch
```

## 运维

```powershell
pwsh -NoProfile -File ".\scripts\status.ps1"
pwsh -NoProfile -File ".\scripts\stop.ps1"
pwsh -NoProfile -File ".\scripts\install-autostart.ps1"
pwsh -NoProfile -File ".\scripts\uninstall-autostart.ps1"
```

`stop.ps1` 默认先禁用计划任务触发器，避免每分钟健康触发器在停机后立即拉起新进程；禁用不会终止当前实例。脚本随后向桥接进程的本机控制管道发送优雅停机请求，并最多等待 30 秒。只有控制管道不可用或进程未在期限内退出，且强制终止前再次验证同一个 PID、入口脚本和实例锁 token，才会使用硬终止。手工通过 `start.ps1` 启动和由计划任务启动的实例走同一路径。维护场景若需要停机后恢复原计划任务启用状态，可显式使用：

若当前 Windows 账号的 CIM 进程身份查询被拒绝，`stop.ps1` 会报错并保留 PID 与实例锁，不会把未知进程当作已经退出；请在能核验该进程身份的原运行账号下处理。

```powershell
pwsh -NoProfile -File ".\scripts\stop.ps1" -KeepScheduledTaskEnabled
```

当前版本首次替换尚未加载控制管道、也尚未创建实例锁的旧进程时，没有可接收优雅请求的端点。这个一次性兼容路径要求 PID 文件、`node.exe`、绝对入口脚本和进程创建时间全部匹配，并确认实例锁始终没有出现；等待期结束后再次逐项核验，才会强制终止。新版本启动后必须存在实例锁，后续停机均走带 PID 和 token 的优雅路径。

`status.ps1` 会列出 `recoveryRequired` 及对应请求编号。旧版本留下的任务若已有 thread ID、但没有持久化 owner，默认同样拒绝恢复。只允许在核对 Codex session、标题和请求标记确属同一批次，并停止桥接服务后显式迁移：

```powershell
# 先 dry-run；不会写状态
node .\scripts\migrate-thread-owner.mjs `
  --request-id "RQ-..." `
  --thread-id "..." `
  --evidence "已核对 session 标题与 requestId 标记"

# 停止服务并复核 dry-run 后，才可添加 --apply
node .\scripts\migrate-thread-owner.mjs `
  --request-id "RQ-..." `
  --thread-id "..." `
  --evidence "已核对 session 标题与 requestId 标记" `
  --apply
```

若该任务此前已被隔离为 `recovery_required`，成功迁移会保留核验记录并将它原子转回 `queued`，随后只恢复已核实的同一 thread。

本机关闭、休眠或断网时无法即时执行；恢复后，飞书长连接会自动重连，轮询会从持久水位补收飞书历史仍可读取的消息，本地已入队任务会恢复。

轮询参数可通过环境变量调整：`FEISHU_POLL_INTERVAL_SECONDS` 和 `FEISHU_POLL_LOOKBACK_MINUTES`。轮询需要应用具备读取群消息历史的权限。

可见对话引导默认使用已验证的 `gpt-5.6-luna`、`low` 和 180 秒超时，可分别通过 `CODEX_BOOTSTRAP_MODEL`、`CODEX_BOOTSTRAP_REASONING_EFFORT`、`CODEX_BOOTSTRAP_TIMEOUT_SECONDS` 调整。引导固定关闭 CLI 启动更新提示，并只做一次不调用工具的确认；真实背调仍使用 `CODEX_MODEL` 和 `CODEX_REASONING_EFFORT`。

## 隔离续接探针状态（2026-10-03）

当前安装的 Codex SDK 0.158.0 使用无界面 `codex exec resume`，普通审阅者路径的运行层会设置 `approval_policy=never`，因此 `scripts/probe-sdk-continuation.mjs` 在调用模型前阻断，不能视为 CLI→SDK 续接验证通过。

`scripts/probe-cli-continuation.mjs` 是独立的 CLI→CLI 替代探针，针对固定空任务目录和已核实的唯一线程。它用交互式 `codex resume` 的位置参数提交一次固定无工具提示词，显式指定只读、`on-request`、人工审批、禁用已知 MCP/通知/网页搜索，并使用 `--no-daemon`。它不写入 PTY 键盘；出现信任、登录或更新确认页面会终止。探针只读取目标会话文件，并要求新回合持久记录的审批、审阅者、沙箱、线程及固定回复全部匹配。每次尝试前原子写入 `state-probes/` 的独立标记，失败或中断后不自动重试。

CLI→CLI 空任务续接已在用户账号单次验证：固定回复、权限上下文和原 thread ID 一致。正式桥接代码现改用 CLI 续接并通过离线模拟；真实派单、浏览器访问、飞书写入和终审仍未验证。

## CLI 正式执行准备与权限边界（2026-10-03）

- 新分支在 `src/cli-thread-execution.mjs`。启动前须读取原始 CLI 会话文件，确认唯一文件、requestId 标记、thread ID、工作目录、source/originator 和版本。`codex resume` 只传一个显式 UUID 和当前批次提示词，运行中核对提示词、`turn_context`（`workspace-write`、`on-request`、`user`）、最终完成事件与原文件前缀。失败不自动重试；桥接进程退出时终止其 ConPTY 子进程。
- 桥接状态在 CLI 续接前记录 `codexCliAttemptStartedAt` 和线程 ID。异常退出后 `recovery_required`；即使有人误把状态改成 `queued`，旧尝试标记也会阻止再次执行。重新续作必须先人工核对同一 rollout 的实际完成情况及文档副作用，再设计明确恢复步骤。现阶段没有自动恢复命令。
- 背调成果与截图的计划写入位置为 `$env:BACKGROUND_CHECK_WORKSPACE`；桥接自己的 `state/`、`logs/` 同在该目录。Codex 自身会在用户的 `CODEX_HOME/sessions` 保存会话；须确认运行账号对此已有权限。登录态 Microsoft Edge 和 CDP broker 涉及用户配置/进程，飞书 MCP 与 DPAPI 读凭据脚本位于独立运行目录，飞书 OpenAPI/MCP 交付还需联网与文档权限。这些能力不能由 `$env:BACKGROUND_CHECK_WORKSPACE` 的 workspace-write 自动推定，遇到审批、信任、登录或网络限制应停在本地恢复状态。
- CLI 正式执行明确关闭 `sandbox_workspace_write.network_access`，不使用 `danger-full-access` 或自动批准。公开研究可先用允许的 Web 工具；若 Edge/CDP、本机飞书运行时或 API 需要额外文件或网络权限，应对实际操作逐项审核。未在这次改动中扩大工作区、修改全局信任、增加凭据或启用监听。另有 Desktop 原生实验分支和旧 SDK 范围预检，不能把本次 CLI 空探针的结论延伸到它们。

## SYNTHETIC_COMPANY 单项受控测试

用户在当前对话明确授权把原派单消息 `om_x100b6486cd5674a8c4a7b5609c5f6b4` 的第 5 项 SYNTHETIC_COMPANY 作为一次直接指定测试；原代号 TS8 仅保留为来源，不改变本机长期接单范围。在持有原 DPAPI 凭据的正常 Windows 用户会话中、经审查后，只运行一次：

```powershell
Set-Location "$env:BACKGROUND_CHECK_WORKSPACE\tools\feishu-codex-bridge"
node .\scripts\run-synthetic_company-once.mjs --execute
```

入口先只读核对绑定群与原消息 ID、时间、TS8／SYNTHETIC_COMPANY 和三个网址。通过后取得桥接实例锁，只用合成来源键 `原消息ID#item-5-synthetic_company-direct-test` 新建一条独立 `requestId`；原消息不写入 seen 状态。已有同项测试即停止，不自动恢复或重跑。执行使用 `runBackgroundCheck` 的 CLI 分支与原桥接的线程绑定、报告快照审计及最新 revision 复核；不启动监听、不发送群消息。出现登录、信任、审批或异常中断时停在本地状态。当前受限执行账户不能解密 DPAPI，真实执行和飞书成品尚未验证。
# 私聊故障告警

桥接器只在派单入库到研究启动交接之前，对启动预检失败、回执结果不确定、对话启动需人工核实等事件尝试向**已验证的用户私聊**发送告警。群内仍只允许符合规则的新派单分配回执；报告交付及研究交接后的事件不在告警范围。

不能用派单发送者或群绑定者代替告警收件人。用户须先在飞书中主动私聊机器人，发送当前会话给出的一次性完整挑战消息。操作员在同一账户中设置 `BG_ALERT_BIND_CHALLENGE` 为完整消息、`BG_ALERT_BIND_ISSUED_AT` 为挑战发出时间，再运行 `node scripts/bind-user-alert.mjs --execute-bind`。脚本只读取机器人可见的私聊历史，要求唯一、精确、未过期的用户消息，随后将该私聊的 open_id 与证明消息写入 `state/user-alert-binding.json`。绑定后可运行一次 `node scripts/send-user-alert-test.mjs --send-once`；该消息明确标注为启用测试，不汇总历史故障。

每个事件在 `state/user-alert-attempts.json` 中先登记尝试，再调用飞书 OpenAPI；确认或结果不确定均不自动重发。每小时最多尝试五条正式告警，超额事件记为 `rate_limited`。告警失败不会阻塞派单，`scripts/status.ps1` 显示最近结果。未绑定时不发送；桥接进程彻底退出、机器断线或飞书服务不可用时，同进程告警不能保证送达，需要另行部署独立监控才可覆盖。
