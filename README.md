# 背调工作流复现包

Windows 上的公开来源调查、批量正文与媒体阅读、飞书成品交付和最新 revision 终审。保留已跑通的调查方法、十四平台格式、写作规则与派单隔离规则，工具和运行配置按 2026-10-24 的实际故障记录整理。

先看 [安装与新机验收](docs/INSTALL.md)，再看 [完整执行流程](docs/WORKFLOW.md) 和 [工具审查与验证边界](docs/TOOL-AUDIT.md)。共同维护风险库时按 [维护与发布检查](docs/MAINTAINING.md) 更新规则和包清单。本包不包含账号凭证、浏览器状态、真实任务台账、历史 jobs 或私人调查素材。

| 资产 | 用途 |
| --- | --- |
| `skills/background-check-research` | 身份消歧、主页阅读、十四平台搜索、结论与缺口 |
| `skills/web-access` | 可见 Edge、共享连接、页面所有权、固定 DOM 查询与批量客户端 |
| `tools/research-batch` | 来源映射、去重、预算、媒体与覆盖检查 |
| `skills/deliver-feishu-background-check` | 模板复制、增量写入、固定文案与交付检查 |
| `skills/review-feishu-background-check` | 全文、业务口径、链接、revision 与必要实显终审 |
| `external/feishu-mcp` | 固定版本 MCP、DPAPI 凭证、本机 UAT 预检与续权 |
| `tools/feishu-codex-bridge` | 当前派单映射、requestId 隔离、单次接单回执与断点恢复 |
| `模板.docx`、`背调风险提示.*` | 既有版式参考与业务规则源，线上模板需单独核验 |

普通任务沿用轻量流程。完整 payload/哈希/逐帖台账仅用于用户明确要求的取证审计。已获取缓存、已截图、离线测试通过都不等于主体调查已完成。

本机与独立新安装目录均已回归，B站三窗口、网易云点击、X完整拼图和新增单帖正文/原图采集已有现场验收。另一台物理机器仍须按安装文档重新授权和验收。个别页面截图超时的浏览器底层原因尚未确定，工具会保存失败阶段并停止，不把换页重试或重复授权当成修复。详见 [回归摘要](reports/regression-summary.json)。
