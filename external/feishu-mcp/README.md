# Codex 飞书 MCP

本目录使用飞书官方 `@larksuiteoapi/lark-mcp`，让本机 Codex CLI 以用户身份操作已授权的飞书云文档和知识库。

## 使用边界

这套连接仅用于背调任务的最终飞书云文档交付：读取模板和既有成品、在飞书中“使用该模板”生成文档、填写成品、插入证据截图及交付前复核。背调研究、网页采集和风险判断在本地研究 Skill 中完成；本连接不用于发消息、管理联系人、日历或其它飞书业务。

## 安全设计

- App Secret 不写入源码、Codex `config.toml` 或命令行参数。
- App Secret 使用当前 Windows 用户的 DPAPI 加密，保存在 本仓库 `.local/credentials/credentials.json`。
- `secure-launcher.mjs` 只在进程内解密凭证，并通过子进程环境传给飞书官方 MCP。
- 用户访问凭证由飞书官方 MCP 保存和刷新。
- 默认只启用文档与知识库工具；没有启用发消息、联系人、日历等工具。

## 飞书后台所需配置

应用：`cli_CONFIGURE_APP_ID`

OAuth 重定向 URL：

```text
http://localhost:3000/callback
```

最小权限：

```text
offline_access, docx:document, drive:drive, wiki:wiki:readonly
```

权限和安全设置修改后，需要创建并发布新版本才会生效。

## 本机初始化

在 PowerShell 7 中运行：

```powershell
pwsh -NoProfile -File "$env:BACKGROUND_CHECK_WORKSPACE\external\feishu-mcp\scripts\configure-credentials.ps1"
pwsh -NoProfile -File "$env:BACKGROUND_CHECK_WORKSPACE\external\feishu-mcp\scripts\login-feishu.ps1"
```

将 Setup 生成的 `config/codex-mcp.local.toml` 合并到当前 Codex 配置（保留已有服务），在空闲时重新加载后使用 `codex mcp list` 检查 `feishu` 服务。

## 自动预检与续权

背调飞书交付开始前统一运行：

```powershell
pwsh -NoProfile -File "$env:FEISHU_MCP_ROOT\scripts\ensure-feishu-uat.ps1"
```

脚本先执行不读取真实文档内容的只读 UAT 探针。已有令牌有效时直接返回 `READY`；令牌失效时先不经本机代理再探测一次（官方 MCP 会尝试刷新令牌），仍失效则使用已保存的 refresh token 做一次无浏览器静默续权，并在成功后再次运行探针。只有后置探针成功才返回 `READY`。这些重试不会修改系统代理或当前会话的持久设置。

`ensure-feishu-uat.ps1` 不再自动运行交互式 `login-feishu.ps1`。官方登录命令会打开浏览器、等待网页确认，并在等待前移除原有本地令牌；无人处理时约一分钟后只报泛化的 `Login failed`。只有静默续权确认不可用后，Codex 才启动现有 `login-feishu.ps1`，在可见浏览器核对原账号与既有权限并自行完成页面确认，再运行本预检直到 `READY`；仅出现密码、验证码、人机验证、切换账号、新权限或管理员审批等用户专属步骤时才请用户处理。回环代理连接失败时，可对该登录子进程使用 `-WithoutProxy` 重试一次。

输出状态固定为：

- `READY`：可以继续飞书 API 操作；
- `CODEX_OAUTH_REQUIRED`：已确认本地 refresh token 缺失或被拒绝；Codex 接手续签页面，`user_action_required=false`，不得直接转交用户；
- `USER_ACTION_REQUIRED`：只有实际观察到首次 OAuth／当前应用从未获该账号授权，或密码、验证码、人机验证、账号切换、权限增加、应用发版、管理员审批等用户专属步骤时才使用。单凭泛化的登录失败、浏览器超时或 access token 失效，不得推断为此状态；
- `TECHNICAL_FAILURE`：代理、网络、脚本、回调或接口故障，不能表述成用户未授权。

本机已授权的原账号和既有权限续签不需要再次向用户确认。`default_tools_approval_mode = "prompt"` 是 Codex 工具调用审批，不是飞书 OAuth 登录状态。

Codex 的全局 MCP 启动入口为：

```text
node $env:BACKGROUND_CHECK_WORKSPACE\external\feishu-mcp\scripts\secure-launcher.mjs
```

执行一次不读取真实文档内容的端到端验证：

```powershell
node "$env:BACKGROUND_CHECK_WORKSPACE\external\feishu-mcp\scripts\verify-live.mjs"
```

成功时会显示 `ok: true`、12 个工具，以及 `readOnlySearch: succeeded`。

只验证续权决策分支、不访问飞书网络：

```powershell
pwsh -NoProfile -File "$env:BACKGROUND_CHECK_WORKSPACE\external\feishu-mcp\scripts\test-uat-recovery.ps1"
```

## 在 Codex 中使用

重启 Codex 或新建任务后，可以直接提供飞书文档链接，例如：

```text
读取这个飞书文档并整理成三点摘要：https://.../docx/...
```

工具审批以当前 Codex 权限设置为准，不与飞书 OAuth 身份状态混为一谈。

## 默认启用的能力

- 读取文档基本信息和纯文本
- 遍历、读取、更新文档块
- 创建文档及子块
- 搜索云文档
- 搜索和读取知识库节点

## 背调截图上传

官方 MCP 当前没有暴露图片字节上传工具。本目录提供一个受限上传脚本，只允许读取 `$env:BACKGROUND_CHECK_WORKSPACE` 下不超过 20 MB 的 PNG、JPG/JPEG 或 WebP 图片，并把素材绑定到指定飞书文档：

```powershell
node "$env:BACKGROUND_CHECK_WORKSPACE\external\feishu-mcp\scripts\upload-image.mjs" `
  --file "$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\process\evidence\example.png" `
  --document-id "目标文档token" `
  --image-block-id "目标空图片块id"
```

默认只做预检并返回图片 SHA-256，不调用飞书上传接口。确认后添加 `--expected-sha256 "预检值" --commit` 才会上传。脚本会先确认图片块属于目标文档、类型为图片块且为空；覆盖已有图片还必须显式加 `--replace-existing`。

脚本只返回飞书 `file_token`，不会替换文档块内容。上传完成后，再用文档块接口的 `replace_image.token` 把返回值写入同一个图片块，并重新读取该块确认结果。
