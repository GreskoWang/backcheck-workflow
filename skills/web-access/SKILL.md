---
name: web-access
description: Background-check investigation must route to ego-browser; Feishu delivery and review keep their API/MCP workflows. The Edge and standalone research paths below apply only outside background-check investigation. Use when Codex needs robust web research, source verification, webpage extraction, dynamic or logged-in browsing through the user's persistent desktop Microsoft Edge via a local CDP broker, local Chrome/Edge bookmarks or history lookup, social-media or site investigation, or reusable site-pattern notes. This workflow keeps Edge visible and logged in while avoiding fragile extension-owned debugger handles.
---

## 背调联网入口（2026-10-31）

背调浏览器操作默认使用 ego，复用或恢复 Agent 自有 TaskSpace；遵循[当前访问规则](../background-check-research/references/access-policy.md)及 `ego-browser` 技能。Edge 和本技能的 CDP 入口不用于背调调查、截图或交付实显；获准的公开搜索、公开 API、导出和本地材料可以配合 Ego 使用。空间恢复不授权绕过登录、验证码、权限或安全拒绝。飞书交付、API 回读和终审继续按 OpenAPI／MCP 技能执行。

## 配置与模板

本节的背调初始化与飞书模板要求仅适用于背调项目；其他项目的网页访问直接使用下文对应入口。

首次部署或迁移机器时按工作区 `docs/INSTALL.md` 执行 `Setup-Backcheck.ps1`。日常背调加载 `recovery-session-env.ps1` 并复用现有配置；仅处理本次实际缺失的环境项。本机路径与账号配置位于 `config/runtime-paths.json` 和 `config/backcheck-local.json`。本地文件读取与修订按实际所需工具直接执行。

业务与写作方法保留在本 Skill 的 references 中。正式云模板由当前配置的 `template_document_token` 指定，在当前账号下只读核验后使用。`SYNTHETICDOC`、合成主体和内置 fixture 只用于离线回归，不是线上模板或真实调查记录。随包的 DOCX 保留既有版式参考，不代替当前飞书 API 模板核验。

# Web Access

This skill adapts Eze's `web-access` skill from Claude Code to the current Codex desktop environment. Keep the original idea: choose the lightest reliable web access path, escalate only when the evidence says to, and preserve reusable site knowledge.

Upstream: `https://github.com/eze-is/web-access` (`web-access`; the commonly mistyped `web-acess` URL is not the repository).

## Core Logic

发现阻断必要操作、丢失关键证据或可能导致错误结论的工具缺陷时，主动做最小复现、在已有授权内尝试可撤回修复，并验证原失败操作。将通用修复记录在本 Skill 的接口说明，平台特例写入对应站点方法；失败如实记录并切换可用路线。不得只报“工具限制”后等待催促，也不得把代码写好或测试通过当成现场已恢复。

Work goal-first, not tool-first:

1. Define what success means: the fact, page state, document, screenshot, account-visible content, or comparison the user needs.
2. Pick the most direct starting channel and test it.
3. Treat each result as evidence. If search, static fetch, or browser state is not moving toward success, change channel instead of repeating the same failure.
4. Stop when the success standard is met. Do not keep browsing for ornamental completeness.

Prefer primary sources for verification. Search engines are discovery tools, not proof. For background-investigation work, preserve source URLs, exact dates, entity names, and confidence boundaries; label inference, weak evidence, and inaccessible sources.

## Codex Tool Map

Use Codex's native tools as the first layer:

| Need | Preferred path |
| --- | --- |
| Public web discovery, current facts, news, broad source finding | `web.search_query`, then open primary sources |
| Known public URL, article, official page, documentation | `web.open` / `web.find`; use Jina only when a long article or PDF-like page is token-heavy |
| Raw HTML, metadata, JSON-LD, robots-light source inspection | PowerShell `Invoke-WebRequest` or `curl.exe` from shell |
| Dynamic pages, login state, social platforms with static anti-fetch behavior, UI operations | CDP proxy in this skill |
| User's previously visited pages, internal systems, forgotten URLs | `scripts/find-url.ps1` / `scripts/find-url.mjs` |

Do not use CDP for every web task. CDP is powerful but intrusive; use it when login state, dynamic rendering, UI interaction, or platform behavior makes the lighter layers insufficient.

## Skill Directory

Codex does not provide `CLAUDE_SKILL_DIR`. Resolve paths relative to this `SKILL.md`; in this installation the default is:

```powershell
$skill = "$env:USERPROFILE\.codex\skills\web-access"
```

On Windows, use the PowerShell wrappers. They prefer Codex's bundled Node runtime at:

```text
%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
```

and fall back to a working `node` on PATH. This avoids the WindowsApps `node.exe` access-denied issue seen in Codex desktop.

## CDP Mode

本节仅用于非背调任务或用户另行明确授权的旧工具专项维护。背调调查部分不得启动此 CDP 入口，必须转到 ego-browser；下述 Edge broker 的连接、授权和恢复要求不适用于当前背调。

把故障限定在实际失败的控制器、页面或材料，不把单条路线的失败计数直接当作整个 Goal 的阻塞计数。普通技术故障沿用原断点和既有恢复计数，按有界恢复规则处理；仍失败时采用获准且不涉及安全拒绝的替代来源，将原路线记为具体缺口。明确的安全／权限拒绝须保留原文并遵守实际停止范围，不自行宣布只限制一次调用，不以另一入口重试被拒绝动作，也不把新回合或提示词修改当成拒绝解除。仍有不涉及该拒绝的可读缓存、其他获准来源、分析或交付工作时继续推进，所有剩余工作确实无法推进时才按 Goal 规则判定 blocked。

On Windows, prefer the user's visible, persistent Microsoft Edge profile and the single local CDP broker. Do not use Codex in-app/IAB, hosted, headless, or temporary browser profiles as a substitute for logged-in platform work. Before browser control, run:

```powershell
pwsh -NoProfile -File "$skill\scripts\check-deps.ps1"
```

The launcher reads Edge's `DevToolsActivePort`, starts or reuses one broker, and never asks the user for a port or target id. If Edge remote debugging is not enabled, navigate Edge to:

```text
edge://inspect/#remote-debugging
```

and enable **Allow remote debugging for this browser instance** only within the authorization rules below. A missing `DevToolsActivePort` means only that the live endpoint is not ready; it does not prove the switch is off. On Windows, inspect `Local State` at `devtools.remote_debugging.user-enabled`: when it is `true`, ensure the ordinary visible Edge using the default user-data directory is running, wait for the endpoint file and listener, then retry once without asking the user to toggle the switch. Edge may display a browser security confirmation when a debugging connection is established; a timeout alone does not prove that a prompt exists. A user's request to perform the browser task authorizes routine opening, navigation, reading, scrolling, clicking, and screenshots within that task, so do not ask them to pre-open Edge, choose a tab, provide an endpoint, or reconfirm every ordinary action. Authentication credentials, CAPTCHA, 2FA, new OAuth scopes, and paid access remain subject to their applicable user-confirmation rules. Handle Edge remote-debugging prompts as follows:

broker 明确要求授权时，简短说明当前连接状态；只有确认存在待处理的预期 Edge 授权提示，才请用户点击“允许”。背调及其工具修复不调用 CUA 查看或代点提示，不以超时推断弹窗存在或用户未授权。等待时继续已读缓存、分析和获准的飞书工作稿，不为制造提示反复重载 broker 或重启 Edge。

连接与页面可读性分别核对：`connected` 且 `approvalRequired=false` 只表示连接就绪，`/targets` 成功只证明能列页。在本任务原有、归属明确且持有有效租约的目标上，用 `/info` 核对实际 URL，再做小范围可见正文查询，通过后从断点继续，不新建页面重跑；需要看图时才通过 CDP 截图。保留原断点和恢复计数。能建页、列页或 activated=true 都不证明正文已加载，本地测试通过后仍须验证原失败页面，未现场复验只能称本地修复完成。已发生的安全拒绝仍受上文停止范围约束。

同一 Edge 调试实例只复用一个 broker；OS 级锁拒绝第二套连接域。同一 target 只有一个 owner 和串行命令队列，不与扩展或 DevTools 同时控制。`new` 必须复读确认认证创建标记已消失才返回 capability；失败不发布租约。禁止读取或导出 cookies、tokens、浏览器存储、凭据数据库和私有接口。断线、闲置或 broker 退出均保留页面，只通过具备本页管理 capability 的显式 finalize 关闭自建页。

交付前保留可见 Edge 与已授权 broker，不为普通维护、加载代码或释放内存重启；专项修复例外见下节。各执行者共用连接，普通页操作不重复索要授权。已去除创建标记的管理关系保存在当前 broker 进程内；外部异常退出后先保存断点、继续非浏览器工作，重连时重新盘点，不能假定旧 capability 可跨进程恢复。

其他任务占用页面或暂时不能重载服务，只限制对应页面／新服务能力，不构成停止适配的理由。有空余额度时新建本任务受控页，使用已加载接口验证；客户端适配、离线准备和其他域名继续推进，不要求用户再次授权新页。

所有执行者合计最多五个可归属任务页额度，包含管理页、租约、待创建页和点击弹窗预留；满额拒绝新占用及可能弹窗的点击。明确受控 `openerId` 的派生页承接预留后自动关闭；关闭未确认或认证创建标记尚未清理时继续占额并拒绝新操作。`Page.windowOpen` 仅标记本次点击的短时预留，不能凭 URL／时间推断、读取或关闭无 `openerId` 页面。站点自主、延迟、多弹窗或断线弹窗不能保证物理页数始终不超五，发现后停止新增，按[接口说明](references/cdp-api.md)处理。优先读取目的链接后在当前页导航或显式 new；复用平台页，用完的既有用户页 release、自建页 finalize。不读取、关闭或计入用户无关页。

For YouTube and other heavy SPAs, use small bounded DOM reads and incremental scrolls, then reacquire elements after every navigation or structure change. Do not request a full accessibility tree, full DOM snapshot, whole-page `innerHTML`, or one long scroll. If a browser command times out or a target detaches, refresh targets, reattach once, retry one smaller command, then checkpoint that target instead of repeating 30-second waits.

### Common CDP Calls

交互式研究默认使用[持久客户端](references/cdp-session.md)：通过 `exec_command` 的 `tty:true` 启动 `scripts/cdp-session.ps1`，保留返回的执行会话 ID，后续用 `write_stdin` 发送受限 JSON 命令。持有 capability 的 PowerShell owner 必须独立于可能被重置的 Node REPL；不要在 Node REPL 中直接保存 capability 或启动依赖其生命周期的持页子进程。一次请求或外层工具等待超时后，继续复用原执行会话，不重建页。

```powershell
pwsh -NoProfile -File "$skill\scripts\cdp-session.ps1" -InitialUrl 'https://example.com' -Owner 'task-example'
```

客户端只通过现有 `cdp-request.ps1` 调用固定 action 白名单，capability 仅保存在持久 owner 与请求子进程的环境中。新建响应丢失最多用同一 request ID 和同一路径恢复一次；明确失败不盲重试。命令级异常与请求超时不退出 owner。`finish`、stdin EOF 或会话普通异常均在 `finally` 显式 finalize 自建页，只有 `closed:true` 才报告关闭成功；关闭结果未知不重放。非 TTY 空输入不建页，有效输入执行后 EOF 同样清理。

低层 `new` / `acquire` 仍由 request wrapper 提供，仅在能持续保存环境 capability 并负责清理的独立 owner 中使用。需要保留断点时，在该 owner 内保留管理 capability 后 release，不能 release 后退出而遗失能力。既有用户页始终只 release。清理失败先核对实际 target 状态，不把 release、HTTP 返回或移除环境变量当成已关闭页面。

Read [references/cdp-api.md](references/cdp-api.md) when you need the full endpoint list, fixed DOM-query schema, screenshot details, click modes, leases, or troubleshooting.

### 脚本弹窗地址与专项修复

`/click`、`/clickAt` 的 `popupUrls` 返回当前受控来源页在同次点击期间发出的 `Page.windowOpen` 公开HTTP(S)目的地址，沿用URL脱敏；`popupUrlStatus` 区分captured、filtered与not_observed。捕获器独立于弹窗额度，避免targetCreated先到并消费额度后丢失地址。它不读取弹窗正文，也不把URL或时间用于认领无openerId页面。明确归属的弹窗仍自动关闭；用返回链接显式创建详情页，原列表保持原处。详见[接口说明](references/cdp-api.md)。

用户明确要求修复当前阻断任务的控制器缺陷时，可在针对性测试通过并保存任务页断点后，对已确认的broker进程做一次必要的受控重载；这是专项修复，不适用于普通维护。保留Edge及全部页面，重新盘点并只恢复原任务已知页面的控制权，核对能力版本和原失败操作。旧lease不跨进程复用；不能为加载代码重启Edge、扩大权限或猜测无关页面归属。

## Local Chrome URL Lookup

Use local Chrome/Edge/Chromium resources when the user references a page they have visited, bookmarks, internal systems, SSO dashboards, or a site name that public search cannot identify.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$skill\scripts\find-url.ps1" 财务 平台 --since 30d --limit 10
powershell -NoProfile -ExecutionPolicy Bypass -File "$skill\scripts\find-url.ps1" --only history --since 7d --sort visits
```

The adapted finder uses `sqlite3` when available and falls back to Codex's bundled Python `sqlite3` module on Windows.

## Browser Tactics

重复主页读取优先使用[可恢复批量缓存](references/research-batch.md)：固定DOM配方与本地后台worker复用本任务已有租约，自动滚动／分页。新任务只保存一份当前正文缓存，按需返回阅读批次，只确认实际读完的批次；不另导出整套正文、无问题材料档案或逐帖审阅回执。先核对账号、范围和起点；后台取数不等于已读。前台操作同页前先cancel并确认停止。旧目录继续兼容，不迁移、删除或重置原断点；不为精简加载重启broker或干扰其他owner。媒体批读、截断、终点与恢复命令统一放引用。

折叠正文或详情缺口使用[详情客户端](references/research-detail.md)，沿用现有租约并核对帖子与主体，不把整卡UI或列表摘要当本人正文。采集启动后可挂接 `tools/research-batch/pipeline/prepare.py watch`，仅观察本地状态，终态后准备单份阅读断点和媒体待办；使用 `read` 取一批、`confirm` 确认实际阅读，同内容不重复导出。该接续不监听派单，不自动确认风险或写飞书。

Use `/dom/query` as bounded, read-only eyes and the dedicated click/scroll/navigation endpoints as hands. Arbitrary JavaScript execution is unavailable:

- Inspect structure before clicking: title, URL, visible text, links, buttons, forms, embedded media.
- Prefer site-generated links over hand-built URLs; platform URLs often carry hidden context or tokens.
- Use `/click` for normal DOM clicks; use `/clickAt` when a real user gesture matters.
- Extract media URLs directly from DOM when images or videos carry the target content; screenshot only when visual rendering is the evidence.
- Treat platform messages like "content not found" as evidence, not final truth. It may mean bad URL context, access limitations, anti-fetch behavior, or actual deletion.

保留用户给出的公开原链接、账号／帖子 ID、实际查询词和列表断点；进入详情前先收集卡片链接，不能用数组序号或仅有 origin 的 `/targets` 地址代替原链接。导航后复读 `/info` 与可见页面，确认账号、帖子或搜索词没有丢失。接口只保留已登记的公开路由参数；被过滤的签名或认证参数不得猜补，也不得为保留原 URL 导出凭据。

无限列表先确认滚动的是内容容器：核对 `/scroll.position.target`、容器 y 与新增卡片／日期，不能只看窗口 y。骨架、灰占位、`atEnd=true`、`moved=false` 或页头总量都不能单独证明历史终点。暂停加载时优先在同页向上小滚约 300—500px，再向下小滚 500—800px，短等待后复读可见卡片；后台页可先激活同一任务页。以实际出现的新内容判断恢复；仍失败才按一次缩小恢复的规则保留缺口，继续其他可执行路线。滚动方法已在 2026-09-17/22 的 Instagram、Facebook 历史页验证，不保证站点永远续载。

For login-gated pages, first check whether the target content is already available. Only ask the user to log in when the needed content is actually inaccessible and login is likely to solve it.

## Site Patterns

Site experience lives in `references/site-patterns/{domain}.md`. After identifying the target domain:

1. Run or read the matching site pattern if one exists.
2. Treat dated notes as useful hints, not guarantees.
3. If CDP work reveals a verified new pattern, update the domain file with facts only.

Format:

```markdown
---
domain: example.com
aliases: [Example]
updated: 2026-04-25
---
## 平台特征
Verified loading, login, anti-fetch, or content behavior.

## 有效模式
Verified URL patterns, selectors, or operation strategy.

## 已知陷阱
What failed and why.
```

## Parallel Work In Codex

Parallelize search, public APIs, offline extraction, scanning, and writing freely when useful. All live Edge work shares one broker and one persistent authorization. Assign each agent an independent target and owner id; different targets may run concurrently, while commands for one target remain serialized. Keep the combined number of task pages at five or fewer; broker admission enforces this for attributable pages, while the workflow must detect and stop after an autonomous popup outside CDP attribution. An agent must release only its acquired user target, finalize only a broker-created target for which it holds the management capability, and never operate a target leased by another agent.

## References

| File | Load when |
| --- | --- |
| `references/cdp-session.md` | 默认持久交互客户端、JSON 命令、EOF 与超时清理边界 |
| `references/cdp-api.md` | CDP endpoint reference, examples, and troubleshooting |
| `references/site-patterns/{domain}.md` | Prior verified behavior for a target site |
