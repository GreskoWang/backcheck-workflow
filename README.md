# 背调工作流复现包

Windows 上的公开来源调查、批量正文与媒体阅读、飞书成品交付和最新 revision 终审。保留已跑通的调查方法、十四平台格式、写作规则与派单隔离规则，当前技能快照已整合各分支有效改动，保留既有工具修复。浏览器使用 Ego，公开搜索/API 按当前访问规则执行，飞书交付、回读和终审继续使用 API/MCP。

先看 [安装与新机验收](docs/INSTALL.md)，再看 [完整执行流程](docs/WORKFLOW.md) 和 [工具审查与验证边界](docs/TOOL-AUDIT.md)。共同维护风险库时按 [维护与发布检查](docs/MAINTAINING.md) 更新规则和包清单。本包不包含账号凭证、浏览器状态、真实任务台账、历史 jobs 或私人调查素材。

| 资产 | 用途 |
| --- | --- |
| `skills/background-check-research` | 身份消歧、主页阅读、十四平台搜索、结论与缺口 |
| `skills/web-access` | 背调转向 ego；旧 Edge 接口仅用于非背调任务或另行授权的工具维护 |
| `tools/research-batch` | 本地来源映射、去重、媒体与覆盖检查；公开搜索/API 入口按当前访问规则核准 |
| `skills/deliver-feishu-background-check` | 模板复制、增量写入、固定文案与交付检查 |
| `skills/review-feishu-background-check` | 全文、业务口径、链接、revision 与必要实显终审 |
| `external/feishu-mcp` | 固定版本 MCP、DPAPI 凭证、本机 UAT 预检与续权 |
| `tools/feishu-codex-bridge` | 当前派单映射、requestId 隔离、单次接单回执与断点恢复 |
| `模板.docx`、`背调风险提示.*` | 既有版式参考与业务规则源，线上模板需单独核验 |

普通任务沿用轻量流程。完整 payload/哈希/逐帖台账仅用于用户明确要求的取证审计。已获取缓存、已截图、离线测试通过都不等于主体调查已完成。

以下为历史 Edge 路线的验证边界，不代表新机器或 ego 已验收。历史版本的 B站三窗口、网易云点击、X完整拼图和单帖正文/原图采集已有现场验收，见 [历史回归摘要](reports/regression-summary.json)。本轮变更、复现命令和现场验证范围见 [修复发布说明](docs/REPAIRS-2026-10-27.md)。另一台物理机器仍须重新安装、授权和验收。原生 CUA 网址识别和个别页面截图超时的全部底层原因未修复，不将它们表述为本次全部通过。
