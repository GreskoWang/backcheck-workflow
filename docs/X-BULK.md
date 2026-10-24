# X 批量客户端

`skills/web-access/scripts/x-original-bulk-session.ps1` 将已取得的公开原帖链接按组采集，复用单个持久 owner 与 target。它不发现新账号，不遍历用户未指定的历史范围，不自动把内容标为已审阅。

清单示例（仅示例，不作为真实任务运行）：

```json
{"requestId":"CURRENT-REQUEST","groups":{"part-1":[{"url":"https://x.com/example/status/1234567890123456789"}]}}
```

每组 1 至 12 个 URL，全部匹配 `ExpectedHandle`，requestId 必须与参数相同。每组输出目录必须不存在，已存在时先核对 state.json 断点，不能清掉它重跑。

```powershell
. ./recovery-session-env.ps1
pwsh -NoProfile -File ./skills/web-access/scripts/x-original-bulk-session.ps1 -InitialUrl '已取得的原帖URL' -Owner 'current-task-x' -ManifestPath '当前清单路径' -OutputRoot '当前任务输出目录' -RequestId '当前requestId' -ExpectedHandle '已确认的账号handle'
```

通过持久 TTY 输入一行 `{"action":"bulk","group":"part-1"}`，其余受限命令与 cdp-session 相同。`finish` 或 stdin EOF 按原客户端规则 finalize 自建页；保留断点期间保留 owner 会话，不用 Ctrl+C 或重建客户端来清理未知状态。

正文就绪检查最多 8 轮、轮询预算 15 秒，每次请求另受 25 秒超时约束。原 URL、正文、账号 handle 与原帖链接均满足才返回。来源归因、引用和展开全文仍须实际阅读；正文/链接截断单独保留。

照片使用固定 `generic-posts` 配方的 X 原图分支，返回 `page_state.photo_readiness.version=1`。只在准确的 X `/status/…/photo/1—4` 路由检查视口内的公开媒体，读取 IMG 或可见 CSS 背景及对应 IMG 的解码尺寸，不读取浏览器存储或应用内部状态。X 的原图区域可能在 dialog 外，不能仅凭 dialog 后代节点判断为空。配方通过现有热加载更新，无需重启共享 broker 或重新授权。

公开媒体已解码且连续两次稳定后才截图。没有能力时保存明确错误，不触发重载。图片已加载不代表截图一定可用，遮挡、截图超时和空白仍需检查，保存后必须实际查看，空白截图不能计已看。

HTTP/工具超时、URL变化、真实登录跳转会立即停止本组并保存失败阶段。未加载只在同页查询，不刷新、不自动 recover、不重放导航、不重建 target。失败组原记录保留，剩余项从 state.json 派生，经核对后另建后续组。

配方测试覆盖加载中、坏图、已解码、隐藏元素、公开 CSS 背景、路由边界与节点预算。客户端覆盖延迟正文、预算耗尽、登录跳转、工具超时、延迟原图、坏图与完整批量断点。现场验收状态以 TOOL-AUDIT 与发布回归摘要为准。
