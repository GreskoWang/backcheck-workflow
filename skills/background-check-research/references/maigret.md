# Maigret 账号发现（当前禁用）

本文件只规定 Maigret 的当前状态和重新启用门槛，不是执行步骤。

## 当前状态：`prohibited_unregistered`

Maigret 尚未登记在 `$env:BACKGROUND_CHECK_WORKSPACE\tools\index.json` 及对应 manifest，其逐站自动 HTTP 请求也未完成来源、接口、请求内容、权限与凭证处理审核。因此：

- `three_hour_targeted_v1` 与 `exhaustive_audit` 均禁止安装、运行或引用 Maigret 新输出；
- 不得把历史 Maigret 输出升级为当前账号、身份、风险或平台完成证据；
- 不得把 Maigret 称为独立完成路线，也不得用它解除十四个平台的真实浏览器页面必访缺口；
- 账号扩展改用用户入口、执行者自主打开的浏览器原生搜索、公开交叉链接和已登记合规工具。

## 重新启用门槛

只有同时完成以下事项后，才可修改本状态：

1. 逐站审核真实实现、目标 URL、请求方式、响应内容、接口用途、平台权限与凭证处理；
2. 证明不读取受限页面、不调用私有接口、不携带或重放 Cookie、token、CSRF、Bearer 或其他登录材料；
3. 在 `$env:BACKGROUND_CHECK_WORKSPACE\tools\index.json` 和独立 manifest 中登记准确版本、入口、参数、权限边界、输出及 `surface_completion: false`；
4. 为直接 URL、私有接口、凭证读取、验证码／限流绕过和伪造完成状态添加 fail-closed 负向测试；
5. 通过 UTF-8、结构、来源、输出和网络行为复核，并由访问规则明确批准该窄用途。

仅补一个 manifest、仅确认开源许可证或仅声明“公开信息”都不足以重新启用。

## 获准后的最高边界

即使将来获准，Maigret 也只能产生 `unverified lead`，不能直接生成确认账号、疑似主页、风险或无风险结论：

- 只接受稳定 handle、旧 handle、邮箱前缀或已知主页中的可提取 ID；普通姓名不做宽泛排列组合；
- 默认只做 top-sites 或明确 tags 的窄范围发现，不自动运行全站或用户名排列组合；
- 每个命中仍在对应平台的真实浏览器原内容页面中核实，并按 `confirmed`、`unconfirmed_candidate`、`excluded_candidate` 分类；
- 每个平台最多自动选择一个唯一最高可信的 `suspected_homepage`，且该平台已有用户提供疑似主页时不得再自动选择；
- 结构化输出只留在对象 `process\` 内部，不作为用户交付物；
- 并发只受自身站点限流控制，不得恢复全任务网络锁，也不得限制其他独立浏览器路线；
- `exhaustive_audit` 仍不得突破 access-policy，获准的线索工具也不自动获得全站、私密或受限内容访问权。
