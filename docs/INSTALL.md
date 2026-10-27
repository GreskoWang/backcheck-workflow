# 安装与新机验收

## 环境

Windows 10/11、PowerShell 7.2+、Node.js 22+（含 npm）、Python 3.10+、Git for Windows、可见 Microsoft Edge，以及已登录的 Codex Desktop。当前回归环境为 Node 24.16.0、Python 3.12.14、Pillow 12.3.0。支持版本下限属于代码要求，并非每个组合都已实测。

将仓库放在自己的业务目录。在 PowerShell 7 中：

```powershell
./Setup-Backcheck.ps1 -InstallDependencies -AppId '你的飞书AppId' -TemplateToken '正式模板token'
. ./recovery-session-env.ps1
& $env:RESEARCH_PYTHON ./scripts/doctor.py
```

Node/Python 不在 PATH 时用 `-NodePath`、`-PythonPath` 指向实际可执行文件。不能选择 WindowsApps 的占位程序。Setup 不启动浏览器、监听、计划任务或调查，不覆盖已有本机配置。换目录后重新安装，不携带旧 `runtime-paths.json`。

`-RegisterSkills` 可把五个技能连接到当前 `CODEX_HOME/skills`，已有同名技能会保留并要求先处理冲突。用 `-CodexHomePath` 指定另一个 Codex Home，仅修改技能入口，不迁移会话。

## 账号与模板

```powershell
./backcheck.ps1 -Action Credentials
./backcheck.ps1 -Action Login
./backcheck.ps1 -Action CheckFeishu
```

App Secret 交互输入后由当前 Windows 用户 DPAPI 加密。新机器必须自行完成授权，不复制原机器 `.local`、OAuth storage、cookies 或 `auth.json`。Setup 生成 `config/codex-mcp.local.toml`，将该片段合并进 Codex 配置时保留已有服务；它没有明文凭证。MCP 依赖来自项目内锁文件，无需全局 `@latest`。

正式模板放在 `config/backcheck-local.json`，确认当前账号可只读访问后才使用。可在 `style_reference_urls` 配置用户验收过的成品参考。DOCX 用于版式参考，合成 token 只用于离线测试。

如需派单，使用 `BindGroup -ChatId` 绑定实际 chat ID，再核验范围规则。新安装默认监听、接单回执和记账均关闭。明确启用监听后执行 `Start`，新消息才进入当前业务，历史任务不会自动恢复。首次真实接单必须核对 requestId、文件哈希和分配范围，再检查新线程与回执；配置 enabled 不代表收到任务。安装阶段不要调用 `InstallAutostart`。

## 浏览器与回归

2026-10-27 修复增加 `--group repair` 专项回归，详见 [修复发布说明](REPAIRS-2026-10-27.md)。表格渲染需要 requirements.txt 中的 openpyxl/Pillow 以及相应字体；Windows 默认读取 `WINDIR`/`SystemRoot` 下的 Fonts，也可显式设置 `BACKCHECK_FONTS_DIR`。缺少指定字体会报告不可渲染，不用替代字体伪造通过。

加载环境后，执行 `skills/web-access/scripts/check-deps.ps1`。沿用可见 Edge 的既有账号；实际出现的浏览器安全授权、密码、验证码、首次 OAuth 或新增权限由用户确认，普通打开、点击、滚动和截图由工具执行。单页面失败不重启共享连接，先检查该页与其他页面的独立状态。

```powershell
& $env:RESEARCH_PYTHON ./scripts/run-regression.py --node $env:CODEX_NODE --pwsh (Get-Command pwsh).Source
./Verify-Package.ps1
```

回归只使用 fixture 和本机模拟服务，不发送飞书群消息，不恢复历史任务。完整旧取证校验器测试预算 300 秒，普通任务不需要反复运行它。取证审计的域名检查还需要 PSL，可通过 Git for Windows 自动发现或设置 `BACKCHECK_PSL_PATH`。

新机器现场验收至少包括：登录态页面正文与原图读取、一次普通点击、同页滚动的去重/预算、飞书只读模板与 UAT 预检；需要启用派单时再验收一条明确授权的新测试派单。禁止把本机换目录回归写成另一台物理机器已验收。
