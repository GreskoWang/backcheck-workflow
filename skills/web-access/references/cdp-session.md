# 持久 CDP 客户端

路径示例中的 `<WORKSPACE>` 表示安装后解析出的工作区，不是可直接提交给工具的字面值。实际运行时从 `BACKGROUND_CHECK_WORKSPACE` 取得根目录，使用路径拼接生成绝对路径；这些本机运行记录留在被 Git 忽略的任务目录中。

`scripts/cdp-session.ps1` 在独立 PowerShell 进程中持有一个自建页的 lease、manage capability 与稳定创建 request ID。所有请求仍调用现有 `cdp-request.ps1`，不增加 broker 权限或任意 JavaScript / CDP 接口。

## 启动与持续使用

交互任务通过 `exec_command` 启动，设置 `tty:true`，保留其返回的执行会话 ID：

```powershell
pwsh -NoProfile -File "$env:BACKCHECK_SKILLS_ROOT\web-access\scripts\cdp-session.ps1" -InitialUrl 'https://example.com' -Owner 'task-example'
```

`InitialUrl` 必须是无用户名密码的公开 HTTP(S) URL；`Owner` 是任务标签，不能代替 capability。客户端输出 `type:ready`、owner、targetId 与 pid，不输出创建响应或 capability。不要在可能被重置的 Node REPL 内直接持有 capability；REPL 只可读已保存的公开查询或截图文件。

后续使用 `write_stdin` 向同一执行会话逐行发送 JSON。一次外层工具等待超时不代表 owner 已退出；继续使用原 session ID，不新建页。单个请求默认限时 25000ms，可用 `-RequestTimeoutMilliseconds` 在 100–60000ms 内调整；限时后仅终止该请求子进程，owner 继续接收命令。底层 wrapper 本身也有 HTTP 限时，先到的限时生效。

```json
{"action":"info"}
{"action":"query","body":{"kind":"text","selector":"body","maxChars":4000}}
{"action":"query","body":{"kind":"elements","selector":"main a[href]","visibility":"rendered","limit":20,"fields":["text","href","title"]},"path":"<WORKSPACE>/process/links.json"}
{"action":"scroll","y":600,"direction":"down"}
{"action":"scroll","y":600,"direction":"down","selector":"main"}
{"action":"navigate","url":"https://example.com"}
{"action":"activate"}
{"action":"recover"}
{"action":"click","body":{"selector":"a.example"}}
{"action":"clickAt","body":{"selector":"button.example"}}
{"action":"shot","path":"<WORKSPACE>/process/screen.jpg"}
{"action":"finish"}
```

`body` 沿用 [cdp-api.md](cdp-api.md) 的固定接口 schema。滚动距离为 1–2000px；截图经 wrapper 校验 HTTP 成功和图片签名后原子保存，失败不覆盖已有文件。查询的 `path` 可选，保存脱敏后的公开结果。客户端不接受 `retain`、任意路由、eval 或 raw CDP 命令；需要更复杂的既有接口时，在明确持久 owner 生命周期的前提下使用原受控入口。

## EOF 与异常

2026-10-16已隔离复现Windows PTY默认`Console.InputEncoding=gb2312`会把JSON中韩文`답변`变成`??`，导致正确元素的`expectedText`校验失败。客户端现在同时显式设置Console输入/输出为UTF-8；已有owner已载入旧代码时不热替换或重建页面，可在JSON字符串中使用ASCII Unicode转义（如`\uB2F5\uBCC0`），由原`ConvertFrom-Json`恢复同一文字，保留校验守卫。三阶段PTY证据在`新任务过程目录/历史验证证据未保留`及同目录修复记录；新owner的本地HTTP回环测试同时覆盖韩文到达请求体完整。

- TTY 模式启动后建页，空行不结束会话，`finish` 或 stdin EOF 进入统一清理。
- 非 TTY 模式先读取并验证第一条命令；空输入 / 仅空行 EOF 输出 `type:no_input,created:false`，不请求建页。有效输入执行后 EOF 清理，适合有限的一次性任务。
- 无效 JSON、接口失败和单请求超时只返回结构化错误，owner 继续运行。stdout 不包含请求 stderr、原始创建响应或环境 capability。
- `element_not_found`仅透传固定白名单`reason`（如`text_mismatch`、`occluded`、`not_visible_or_changed`），帮助区分文字变化和遮挡；不透传完整error.details、请求体或凭据。此变化只在新建owner中生效，旧owner仍只返回code/exitCode；不得因此盲点或移除expectedText守卫。
- 普通会话异常、EOF 和 `finish` 都在 `finally` 显式调用一次 `/finalize`。只有明确 `closed:true` 才成功；`closed:false`、超时或结果未知均输出 `cleanup_unconfirmed` 并以非零状态结束，不重放 finalize。

新建只生成一次 request ID。若请求结果未知，最多按完全相同 request ID、URL 与参数恢复一次；明确失败不重试。两次仍未取得能力时报告创建/清理未确认，不按 URL 猜测认领或关闭页面。

强制杀死 owner、操作系统崩溃或 broker 退出不能保证 `finally` 执行；本客户端不提供落盘 capability 恢复。遇到这类边界须保存已知 target ID 与公开断点，按现有授权盘点，不能把能力清空、release 或进程消失称为页面已关闭。客户端本身不重启 Edge / broker，也不操作无关页面。

## 回归验证

### 受控重载后接回原页面

只有所有使用者已空闲、保存断点且本次重载已获授权时，才重载连接核心。重载不重启 Edge，不关闭页面。旧 owner 的 capability 不能跨 broker 进程复用，不再向旧 owner 发送命令。

根据已保存的准确 target 和 URL，启动原页接管模式：

```powershell
pwsh -NoProfile -File "$env:BACKCHECK_SKILLS_ROOT\web-access\scripts\cdp-session.ps1" -ExistingTarget 'KNOWN_TARGET_ID' -ExpectedUrl 'https://example.com/original' -RecoveryAttemptsUsed 1 -Owner 'original-task-owner'
```

该模式只通过 `/acquire` 获取已知页租约，先用 `/info` 严格核对完整 URL，再报告 ready。不会新建、导航或重放滚动。`RecoveryAttemptsUsed` 必须明确传入断点中的已用次数，不能因重载归零；为 1 时拒绝 recover，为 0 时最多尝试一次。尝试失败或结果未知也消耗额度。原页模式在 finish、EOF、启动核对失败或异常退出时只 `/release`，永不 finalize。失败保留原页和断点，不能换页重置预算。

隔离查询上下文只在 target、session、主 frame 和 loader 身份全部匹配时复用，每次先读取 frame tree；导航、脱离或连接变化立即作废。首次上下文创建预算为 5 秒，读取总预算为 10 秒，真实超时仍隔离原 target，不自动重试。`/health` 的 `isolated-context-reuse-v1` 表明已加载该版本，连接成功本身仍不等于页面可读。

```powershell
node "$env:BACKCHECK_SKILLS_ROOT\web-access\scripts\cdp-session-selftest.mjs"
node "$env:BACKCHECK_SKILLS_ROOT\web-access\scripts\cdp-request-selftest.mjs"
```

session 自测使用临时本地 HTTP fixture 和合成 capability，不连接运行 broker。覆盖空非 TTY EOF、有效命令后的 EOF、截图错误/超时后的继续操作、调用方断开、丢失创建响应的同键恢复、明确创建失败、清理结果未知、UTF-8 与能力脱敏。模拟通过后仍需现场确认：独立 owner 建测试页 → 重置 Node REPL → 原 owner info/query/截图 → finish 且 `closed:true`；再验证非 TTY 单命令 EOF 与空输入。
