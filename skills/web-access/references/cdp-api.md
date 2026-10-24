# Edge CDP Broker API

## X 原图就绪配方

`POST /research/snapshot` 的固定 `generic-posts` 配方在准确的 X 原图路由返回 `page_state.photo_readiness.version=1`。它检查视口内公开 `pbs.twimg.com/media/` IMG、CSS 背景及对应已存在 IMG 的 complete、自然尺寸和显示尺寸，节点预算为 2000。原图可能在 dialog 外，因此以准确路由和公开视口为边界。此能力属于可热加载配方，未扩展 `/dom/query` 的字段或选择器，也不需要重启 broker。加载/解码状态不能替代截图后的实际视觉审阅，客户端要求两次稳定后截图。

## 元素文字完整性（2026-10-24）

`/health.capabilities` 含 `element-text-completeness-v1` 时，elements 查询中每个请求了 text 的元素额外返回 `text_truncated`。每项仍最多 1000 字符、200 个文本节点，任何一项截断都会传播到外层 `truncated=true`。这是完整性修复，不是解除大小限制。需全文时先用 elements 定位，再对唯一明确的公开内容节点使用 kind=text，检查其独立截断标记；不得把短卡片摘要当全文。旧运行实例没有该能力时，外层 `truncated=false` 不能证明各元素的文字完整。该变更也适用于已批准的开放 shadow 与同源可见 iframe 中的元素查询。

## 连接模型

- 控制面只监听 `http://127.0.0.1:3456`，服务标识为 `edge-cdp-broker-v2`。
- Broker 只自动发现当前可见、持久的 Microsoft Edge `DevToolsActivePort`；不启动临时、hosted、headless 或 Codex 内置浏览器，也不复制浏览器配置。
- 一个运行中的 Edge 调试实例只运行一个 broker。Broker 按 Edge loopback 调试端点派生并独占一个额外的 `127.0.0.1` TCP 锁端口；第二个 broker 即使使用不同控制面端口，也会在发布 HTTP API 和 bearer token 前以 `edge_profile_in_use` 失败。每条路线使用稳定的 `owner`；不同 target 可并行，同一 target 的命令串行执行且同时只能有一个 owner。`owner` 只是审计标签，真正的控制权由 `new/acquire` 返回的随机 `leaseToken` 决定。
- 普通调查正式交付前，保持已授权的可见 Edge 进程和 broker 持续运行。所有执行者复用同一连接；不得为普通维护、加载代码、诊断或释放内存重启任一进程。用户已明确授权的专项修复，仅按主 Skill“脚本弹窗地址与专项修复”执行一次必要的受控 broker 重载，始终保留 Edge 和全部原任务页，并核对恢复所有权、能力版本与原失败操作。只要两者持续运行，普通页面操作不会再次触发浏览器授权。
- 同一 broker 的全部执行者合计最多由 broker 主动放行 5 个可归属任务页额度，包括已管理页面、lease、待创建页面和可能弹窗的点击预留。第 6 个 `/new` 或无关 `/acquire` 返回 `task_page_limit_reached`，已满 5 个时 `/click` 与 `/clickAt` 也拒绝执行。受控页弹出的派生页没有调用方 capability；CDP 明确给出受控 `openerId` 时，新页原子承接点击预留并由 broker 自动关闭。`Page.windowOpen` 没有 target id，只标记已经在执行的 broker 点击所持有的短时事件乱序保护额度；保护窗结束自动释放。没有明确 `openerId` 时，不得根据 URL 或出现时间推断、读取或关闭 target。关闭失败的明确派生页和上次进程遗留的认证创建标记页继续占用额度；清理确认前拒绝新的页面占用和可能弹窗的点击。网站或浏览器自主产生的多弹窗、延迟弹窗、无 `openerId` 弹窗及断线期间弹窗无法由 CDP 可靠归属，实际物理页数可能瞬时超过 5；这是必须发现后停止的剩余边界，不属于硬保证。需要打开目标时先读取公开链接，再在现有页导航或显式 `/new`。不读取、关闭或计入用户无关页签。
- Broker 每次启动生成随机 bearer token，写在当前用户目录的 `.codex\cdp-proxy\3456.token`。只由登记客户端 `cdp-request.ps1`、`research-batch.mjs` 或 `research-detail.mjs` 在进程内读取并添加请求头，禁止把 token 放到命令行、日志或研究包；这不是平台登录凭证，不允许据此读取浏览器认证材料。
- Broker 退出、断线和闲置不会关闭 Edge 页面。只有 broker 自建页面的当前 lease 仍带有其随机管理 capability 时才能显式 `finalize`；审计用 owner 字符串不能授予关闭权，既有用户页只能 `release`。已去除创建标记的管理关系保存在当前 broker 进程内，重启后不能完整恢复，因此普通调查正式交付前不得重启 Edge 或 broker；已明确授权专项修复的 broker 重载仅适用前述主 Skill 例外，不允许重启 Edge、丢弃原任务页或复用旧 lease。外部异常重启仍须重新盘点页面。
- Lease 每次有效使用都会刷新，连续闲置 6 小时后自动过期。过期清理只 detach 并撤销 capability，绝不自行关闭页面；broker 自建页仍保留管理归属并继续占用额度，只有持有该页随机 `manageToken` 的调用方才能重新 `/acquire` 后 `/finalize`，旧 lease capability 不可复用。

## 启动与预检

```powershell
$skill = "$env:USERPROFILE\.codex\skills\web-access"
pwsh -NoProfile -File "$skill\scripts\check-deps.ps1"
```

预检会启动或复用隐藏运行的 broker。已运行实例通常在数秒内返回；首次启动需要创建并验证仅当前用户与 SYSTEM 可读的 token 及持久 HMAC key ACL，在内存紧张的 Windows 机器上最慢允许 45 秒，不能因一次性安全初始化较慢误判为启动失败。`cdp_handshake_timeout` 只表示端点已发现但当前握手预算（默认 30 秒）内没有完成连接；只有 Edge 确实显示安全提示时才请用户选择“允许”，否则等待普通可见 Edge 启动完成并只重试一次。若显示 `remote_debugging_unavailable`，先读取默认 Edge `Local State` 的 `devtools.remote_debugging.user-enabled`；值为 `true` 时只等待实时端点就绪，不要求用户切换开关，值不为 `true` 时才导航到 `edge://inspect/#remote-debugging` 启用该选项。不向用户索要端口或 target id。

## 请求包装器

交互式非健康检查请求都用包装器，避免 bearer 出现在进程参数；登记的后台 `research-batch.mjs` 在进程内使用相同 bearer、owner、lease 请求头和既有 broker 路由，不另建浏览器连接：

`research-detail.mjs` 同样只调用已有固定路由，在客户端处理详情选择器与有限展开，不要求重载broker。包装器stdout固定UTF-8；Node收集其输出时使用流解码，不能按每个Buffer独立转字符串而破坏跨块中文。2026-10-15中文、重音及emoji管道往返与既有截图保存回归通过。

```powershell
$request = "$env:USERPROFILE\.codex\skills\web-access\scripts\cdp-request.ps1"
$owner = 'case-20260910-youtube'
pwsh -NoProfile -File $request -Method GET -Path '/targets' -Owner $owner
```

`owner` 允许字母、数字、点、下划线、冒号、`@` 和连字符；它只是审计标签。`new/acquire` 还必须使用预先生成的稳定随机 request id；只放入当前 PowerShell 进程的 `CDP_REQUEST_ID` 环境变量，不作为 `pwsh -File` 参数。若响应丢失，必须用同一值重试，broker 会重放同一个 target/lease 结果而不会重复建页。`new` 在内部创建、导航并重新读取 target；只有确认页面不再是受认证创建标记后，才把记录置为 `complete` 并返回 `leaseToken` 和该自建页专属的 `manageToken`。明确失败、结果未知或仍带标记时一律不发布 capability，调用方只可用原 request id 恢复。把两个 token 分别临时放入 `CDP_LEASE` 与 `CDP_MANAGE`，并在 `finally` 中连同 `CDP_REQUEST_ID` 一起清除。不得把这三项写进日志、研究包、共享命令或子进程命令行。Broker 的崩溃遗留空白页标记带有端口专属、ACL 保护的持久密钥 HMAC；只回收 HMAC 验证通过、没有 lease 且没有外部调试器的页面，绝不按公开 URL 形状猜测或关闭用户页面。跨进程互斥锁还会阻止另一 broker 建立第二套 lease 域。

## 端点

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/health` | GET | 无需 token 的最小健康状态；返回连接状态和任务页使用量，不返回页面、端口或 token |
| `/targets` | GET | 以隐私收敛形式列出页面 target，只标记 `available` 或 `busy`；标题恒为 `null`，URL 只返回 origin，busy 页不披露附着或隔离细节 |
| `/acquire?target=ID` | POST | 携带稳定随机 `X-CDP-Request-Id`，租用既有页面并返回随机 lease capability；重新租用 broker 自建页还必须携带该页的 `X-CDP-Manage` |
| `/release?target=ID` | POST | 携带 lease 释放并 detach，不关闭页面 |
| `/new?url=URL` | POST | 携带稳定随机 `X-CDP-Request-Id`，新建、导航并复读任务页；仅在内部 HMAC 标记已经消失后返回 `ready=true`、`targetId`、`leaseToken` 与 `manageToken`；`activate=true` 时前台打开 |
| `/finalize?target=ID` | POST | 关闭当前 owner 由 broker 创建的任务页 |
| `/recover?target=ID` | POST | 对超时后被隔离的 target 做一次 detach、reattach 和固定只读探测 |
| `/navigate?target=ID&url=URL` | POST | 在页面中导航；YouTube 等重页面只做短有界等待 |
| `/back?target=ID` | POST | 后退并短等待 |
| `/info?target=ID` | GET | 返回标题、URL、readyState 和 contextVersion |
| `/activate?target=ID` | POST | 将持有有效租约的任务页切到前台，保持URL、页面内容和滚动位置；不创建或刷新页面 |
| `/dom/query?target=ID` | POST | 在隔离 world 中执行固定、只读 DOM 查询；body 为受限 JSON schema |
| `/research/snapshot?target=ID` | POST | body仅 `{ "recipe": "weibo-feed" }` 等已登记配方；同一租约／队列／隔离world读取完整可见正文及具体缺口，返回前清洗公开URL；返回 `recipeRevision` 标识本次实际使用的固定本地配方哈希，不接受代码、路径、版本、选择器、fetch地址或认证材料 |
| `/click?target=ID` | POST | body 为 CSS 选择器，调用页面 click |
| `/clickAt?target=ID` | POST | body 为 CSS 选择器，发送 CDP 鼠标事件 |
| `/scroll?target=ID&y=500&direction=down` | POST | 增量滚动视口中央内容所属的可见滚动容器，没有内部容器时滚动窗口；重页面每次最多 800px，禁止直达底部 |
| `/screenshot?target=ID` | GET | 返回当前视口截图；客户端用 `-OutFile` 保存，不接受服务端路径 |

截图保存（2026-10-13 本地修复）：`cdp-request.ps1 -OutFile` 先写同目录临时文件，只有 HTTP 成功且截图 Content-Type 与 PNG/JPEG 签名一致时才替换目的文件。错误 JSON 原样返回并以非零状态退出；200 响应伪装图片时返回 `screenshot_invalid_response`。失败不会新建假图片或覆盖既有截图，临时文件在 finally 清理。此修复已用本地模拟响应复现验收，尚未在原超时页面现场复验，也不消除截图超时本身。旧截图文件仍需检查格式；历史 239 字节 `cdp_timeout` JSON 不能作为视觉证据或平台空结果。收到超时／隔离错误时仍按下文对该 target 最多恢复一次，再换路线。

`/eval` 与 `/setFiles` 均已移除。前者永久返回 `410 endpoint_removed`，后者需要单独的显式授权流程。

`research-dom-snapshot-v1` 表示固定研究快照已加载；它不恢复任意eval或私有接口。任务级后台运行、持久缓存、取消、恢复和分批阅读由客户端 `research-batch.mjs` 管理，详见[批量缓存](research-batch.md)。单次固定快照保留采集截断／展开／媒体缺口，不能把HTTP成功当作全文完成；客户端兼容旧DOM通道时仍明确未确认完整性。

`bilibili-attribution-v2` 表示已加载 B 站原创／引用区分、普通 span 展开提示及小头像过滤修正。实际空间搜索页的 `.bili-dyn-content__orig` 也承载原创正文，只有其 `.reference` 变体作为引用卡；引用作者从该卡的公开作者区读取。正文、引用和待展开标记仍须现场核对。固定查询另登记 HTTPS 默认端口 `space.bilibili.com/<数字UID>/search` 及 `/search/dynamic` 的公开 `keyword`，保留查询范围用于断点与来源核对，认证、签名、高熵值及其他参数继续过滤。

点击定位会先排除隐藏副本、隐藏祖先及可编辑载体，优先选择当前视口中的第一个可见匹配；没有视口匹配时才滚动到第一个可渲染匹配。定位后仍检查实际遮挡。普通HTTP(S)链接标记为`target=_blank`时，点击在当前持有租约的页面跟随该链接，避免产生没有管理能力的新页；不执行该链接的页面点击回调。原始目的地址仅在broker内部用于导航，不输出到工具响应，URL脱敏保持不变。其他点击继续使用原有弹窗归属和容量限制。2026-09-12隐藏副本、祖先隐藏、视口优先、遮挡、可编辑元素和新页链接单元测试通过；现场验证结果见对应平台方法。

点击JSON中的expectedText只校验已经选中的元素，不负责从全体匹配中按文字搜索。需要点击特定作者或卡片时，先用相同selector、visibility为rendered的elements查询取得实际顺序，再传index及expectedText作为变化校验；不能仅传宽泛selector（如a）和目标文字，误认为会定位到该名字。当前页变化后重新查询顺序。

脚本弹窗修复：`/health.capabilities`包含`click-popup-urls-v1`才表示当前实例已加载。`/click`、`/clickAt`新增`popupUrls`（最多4个去重、脱敏的HTTP(S)地址）和`popupUrlStatus`（`captured`已观察、`filtered`含被拒绝的地址、`not_observed`未观察到）。只取受控来源页在本次点击内的`Page.windowOpen`导航事件，未立即取得时最多再观察750ms；不读取新页，也不按URL或时间认领页面。捕获记录不随弹窗额度的消费而消失，因此两种事件先后顺序都保留地址。明确归属弹窗仍关闭；无openerId页面仍不据此关闭。空数组不证明没有链接，脱敏地址不能猜补。拿到地址后在独立详情页验证内容，clicked=true不是完成依据。专项修复所需的受控重载按SKILL.md“脚本弹窗地址与专项修复”执行。

滚动返回 `position.target`（`element` 或 `window`）、容器内 `x/y`、`moved`、`atStart` 和 `atEnd`。内部容器滚动时，`/info` 的窗口 `scroll.y` 可以保持0；用返回值与新增卡片／日期核对翻页，必要时截图。`atEnd` 只说明当前已加载容器的底部，`moved=false`、灰占位和页头总量均不证明检查完成。续载停顿时先同页上滚约300—500px、再下滚500—800px，短等后复读实际新内容；该恢复方法已在2026-09-17/22的Instagram、Facebook历史页验证。2026-09-12贴吧内部容器0→750→1500也已实测。恢复无效时保留具体断点与缺口，不重复整页刷新或停止其他路线。

`scroll-selector-v1`实现持久客户端已文档化的可选`selector`：`/scroll?...&selector=main`经现有安全CSS校验，必须恰好匹配一个可见、非敏感的普通主页面DOM元素；只从它向祖先寻找可滚区域（可使用其可滚的文档祖先），不扫描子frame。无匹配、多匹配、隐藏或不可滚明确失败，不回落视口中心，也不产生iframe wheel或接受坐标；省略selector保持原有中心pane逻辑。用相同选择器先做小范围公开elements核对实际文字和唯一性，页面结构改变后重新核对。2026-10-17离线补实现及回归，不代表当前运行实例已加载或抖音原失败场景已恢复；须由root统一盘点、必要加载后实际验收。

`iframe-center-wheel-v1` 表示当前实例已加载可见iframe的窄补充：主页面无内部滚动pane、外层window无可滚距、视口中心实际命中可见iframe且原DOM滚动未移动时，同一 `/scroll` 仅对该固定中心发送一次原生mouseWheel。只允许up/down与1—800px，不接受客户端坐标，不进入子frame DOM或读取其存储，不新增CDP方法或权限；普通窗口、内部pane及末尾不换pane的原路径不变。返回 `position.target="iframe"`、`wheelDispatched=true`、`motionConfirmed=false`，`x/y/moved/atStart/atEnd` 为null，表示框内运动未知。必须实际查看新的截图或新卡片确认滚动，不能把事件发送成功称为moved或终点；截图超时仍保留具体缺口。wheel结果未知沿原隔离与不重放规则处理。磁盘更新和本地自测不表示运行broker已生效；本批只有root核对全部owner并保护其他任务后才能受控加载与现场复验。

后台页停留在加载占位或无限列表暂底时，可先使用`POST /activate?target=ID`激活同一任务页，再核对内容并做一次增量滚动。需要`/health.capabilities`含`leased-page-activate-v1`；服务端沿用租约、串行队列及短超时，只有固定的`Page.bringToFront`调用，不提供任意CDP入口。`activated=true`只表示切换操作完成，不证明续载恢复；以实际新内容为准。不要为激活已有页面新建同网址页面或刷新列表。

`/dom/query` 只接受以下三种 JSON。未知字段、属性值比较选择器、CSS escape、伪类/伪元素、敏感/隐藏载体和非白名单字段都会被拒绝：

```json
{"kind":"document"}
```

```json
{"kind":"text","selector":"main","visibility":"rendered","maxChars":8000}
```

```json
{"kind":"elements","selector":"ytd-video-renderer a#video-title[href]","visibility":"rendered","limit":20,"fields":["tag","text","href","title"]}
```

`text` 最多扫描 2500 个文本节点并返回 16000 字符；`elements` 最多扫描 2000 个候选、返回 50 项。字段白名单只有 `tag`、`text`、`href`、`src`、`poster`、`title`、`ariaLabel`、`alt`、`role`、`dateTime`、`lang`、`rel`、`target`、`type`；属性值还会再次经过敏感词和高熵串过滤。不返回元素 `id`、`className`、`name`、`value`、`content`、`style`、`data-*`、DOM handle、执行上下文、完整 DOM 或隐藏文字。URL 会删除认证信息、fragment，并只保留登记的公开路由参数。服务端与DOM使用同一登记函数：YouTube公开视频参数及results的search_query；HTTPS默认端口下Facebook的profile.php?id、permalink.php/story.php的id与story_fbid、photo.php?fbid、watch的v，X/Twitter的search?q与f、Instagram关键词页的q、森空岛article?id。未知主机／路由、认证或高熵值继续过滤；公开原链接与ID须在任务断点另行核对，不从脱敏残缺地址猜补。

`/health.capabilities` 包含 `public-route-query-ids-v1` 才表示运行实例已加载上述公开查询参数修复；磁盘文件更新不代表既有 broker 已切换。连接状态、租约与任务页数量均不能证明原失败页面已经恢复。

## 常用流程

```powershell
$request = "$env:USERPROFILE\.codex\skills\web-access\scripts\cdp-request.ps1"
$owner = 'case-20260910-youtube'
$env:CDP_REQUEST_ID = [guid]::NewGuid().ToString('N')
$encoded = [uri]::EscapeDataString('https://www.youtube.com/@OpenAI/videos')
$created = pwsh -NoProfile -File $request -Method POST -Path "/new?url=$encoded" -Owner $owner | ConvertFrom-Json
$target = $created.targetId
$env:CDP_LEASE = $created.leaseToken
$env:CDP_MANAGE = $created.manageToken
try {
  pwsh -NoProfile -File $request -Method GET -Path "/info?target=$target" -Owner $owner
  pwsh -NoProfile -File $request -Method POST -Path "/dom/query?target=$target" -Owner $owner -Body '{"kind":"elements","selector":"ytd-video-renderer a#video-title[href]","limit":20,"fields":["text","href","title"]}'
  pwsh -NoProfile -File $request -Method POST -Path "/scroll?target=$target&y=500&direction=down" -Owner $owner
  pwsh -NoProfile -File $request -Method GET -Path "/screenshot?target=$target" -Owner $owner -OutFile "$env:TEMP\edge-shot.png"
} finally {
  try {
    pwsh -NoProfile -File $request -Method POST -Path "/finalize?target=$target" -Owner $owner
  } finally {
    Remove-Item Env:CDP_LEASE,Env:CDP_MANAGE,Env:CDP_REQUEST_ID -ErrorAction SilentlyContinue
  }
}
```

若页面是 broker 新建且工作已真正完成，用 `/finalize` 代替 `/release`。登录待办页、checkpoint 页和用户既有页面一律 release，不得 finalize。

## 超时与恢复

- 整个 HTTP 请求绝对上限 18 秒；共享连接握手默认 30 秒（`CDP_HANDSHAKE_TIMEOUT_MS`）；元数据 2 秒；固定 DOM 查询 5 秒；导航和截图最多 15 秒。单个请求先返回不取消仍在进行的共享握手，预检显示 connecting 时等待该次连接，不重复发起连接。Broker 不循环重试。
- `target_detached`、`inspector_detached` 或 session invalid 时，当前命令最多自动 reattach 一次；仍失败就返回结构化错误。
- 第一次失败后刷新 `/targets`，重新定位页面并只重试一次更小的命令；不要复用页面变化前的 DOM/AX 节点，不要原样连续重试。
- YouTube、X、Instagram 等重型 SPA 禁止全量 AX tree、全 DOM snapshot、整页 `innerHTML`、`direction=bottom` 或一次大滚动；使用小字段、小批次和增量滚动。

常见错误：

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `cdp_handshake_timeout` | Edge 端点已发现，但当前握手预算（默认 30 秒）内未完成连接 | 有实际安全提示时由用户点一次“允许”；否则等待启动完成并只重试一次 |
| `remote_debugging_unavailable` | 未发现有效的 Edge `DevToolsActivePort` 与实时监听 | `Local State` 已启用时等待普通可见 Edge 就绪；否则才打开设置页启用 |
| `edge_profile_in_use` | 同一 Edge 调试实例已有 broker 持有 OS 级互斥锁 | 复用已有 broker；不得换控制面端口启动第二套 lease 域 |
| `lease_conflict` | target 已由另一条路线占用 | 使用本路线自己的 target；不得抢占 |
| `lease_token_required` | 后续 target 请求没有携带 acquire/new 返回的 capability | 在当前进程临时设置 `CDP_LEASE`，调用后立即清除 |
| `lease_expired` | lease 连续闲置已超过 6 小时 | 既有用户页用新 request id 重新 `/acquire`；自建页还需原 `CDP_MANAGE`，旧 lease 不可复用 |
| `manage_token_required` / `manage_token_conflict` | 重新租用自建页时缺少或误用了页面管理 capability | 使用该页 `/new` 返回并仅保存在当前进程中的 `CDP_MANAGE`；不得用 owner 猜测或接管 |
| `idempotency_key_required` | `/new` 或 `/acquire` 未携带稳定随机 request id | 先生成一次并临时设置 `CDP_REQUEST_ID`，响应丢失时仍复用同一值 |
| `idempotency_key_conflict` | 同一 request id 被用于不同操作或参数 | 停止请求并检查调用方，不得改 key 盲目重放 |
| `operation_pending` | `/new` 的响应未知，且暂未找回带内部标记的页面 | 稍后用完全相同的 request id 重试；不得另建页 |
| `target_still_marked` | `/new` 尚未确认页面离开受认证创建标记，因此没有发布 lease | 用完全相同的 request id 重试；不得把该页当成已交付页面 |
| `task_page_limit_reached` | 已打开、持有或等待创建的任务页合计达到 5 个 | 既有用户页先 `release`；broker 自建页必须 `finalize` 关闭后才释放额度；仅明确带受控 `openerId` 的派生弹窗由 broker 自动关闭 |
| `orphan_marker_unresolved` | 上次中断遗留的认证创建标记页尚未确认关闭 | 不另建页；等待 broker 再次清理，或确认该页已由 Edge／用户关闭后重试 |
| `derived_target_unresolved` | 受控页产生的无 lease 派生页尚未确认关闭 | 不继续新建、租用或点击；等待 broker 重试关闭或确认 target 已消失 |
| `outcome_unknown` | 点击、滚动或导航可能已生效，但响应丢失 | 不自动重放；先 `/recover` 并核对页面状态 |
| `cdp_timeout` / `request_timeout` | 命令或整次请求超出短预算 | 刷新 target，缩小命令后重试一次 |
| `target_quarantined` | 上一条命令超时，当前 session 不再复用 | 调用一次 `/recover`；失败则 checkpoint 或换新 target |
| `screenshot_invalid_response` | 客户端未收到格式匹配的PNG/JPEG | 目的文件未改；核对返回内容与target状态，不把旧图当本次截图 |
| `target_detached` / `inspector_detached` | 会话失效 | Broker 自动 reattach 一次；失败则 checkpoint |
| `heavy_page_requires_incremental_scroll` | 重页面滚动过大或直达底部 | 改为每次 300—800px |
| `unsafe_selector` / `invalid_element_fields` | 查询可能探测隐藏值或请求非公开字段 | 改用简单 tag/class/id 选择器、公开存在性属性和字段白名单 |
| `close_not_allowed` | 尝试关闭用户既有页 | 改用 release |

## 安全边界

- Broker 没有任意 JS 或任意 CDP 方法入口；内部 CDP 采用正向白名单。DOM 读取只运行固定函数，参数通过 `Runtime.callFunctionOn` 传入隔离 world。
- 禁止 Cookie/token/localStorage/sessionStorage/凭证数据库读取、隐藏字段探测与私有接口重放。
- 不在正被控制的页面打开 DevTools；第二个调试器会使现有连接 detach。
- 不把 DOM 数据冒充截图；视觉证据必须用原内容页截图。
- 不读取、切换、关闭用户无关页面。只通过 owner 租约操作任务 target。


截图响应需要缩小时，可用同一受管目标的 `/screenshot?target=ID&format=jpeg`，保存为 `.jpg`；现有实现固定 JPEG quality=80，客户端仍核对 Content-Type 与文件签名。2026-10-15 已在一个 PNG 截图超时的 X 任务页完成一次正常 recover 后现场验证：JPEG 成功并实际看清原未读末屏。该结果只证明这条缩小路线在该现场有效，不表示 PNG 超时已修复，也不保证其他页面成功。每次调用只请求一张可能耗时的截图，等待、其他 DOM 请求和图片查看拆到后续调用，避免长串操作导致执行内核重置及租约 capability 丢失。失败仍遵守一次缩小恢复与共享故障预算，不逐平台循环重试。

## 可选同源可见 iframe 定位（2026-10-24 本地补丁，待现场验收）

运行实例 `/health.capabilities` 含 `visible-same-origin-frame-v1` 时，text、elements 查询及 JSON click/clickAt 可增加 `frameSelector`，值仅接受 `iframe` 或 `iframe#公开ID`。先查询框内同一 selector 的 rendered 顺序，再用 index 与 expectedText 点击。只进入唯一、当前可见且无遮挡的同源 HTTP(S) 框架；跨域、隐藏、认证/账户设置路由、可编辑载体、嵌套 iframe 均不可用。框内字段白名单、结果大小、URL 清洗、租约、串行队列和弹窗额度沿用原规则。点击还核对父页面遮挡，并换算 frame 边界与坐标。

示例：`{"kind":"elements","frameSelector":"iframe#g_iframe","selector":"a[href]","visibility":"rendered","limit":30,"fields":["text","href"]}`。这不是任意脚本接口，不扩大 CDP 方法白名单。

本地 frame、click、shadow 和 proxy 回归通过，但当前任务的服务重载被自动审批拒绝，尚未完成原网易云页面点击验收。运行实例未出现该 capability 前不得调用或宣称修复成功。

## 可选开放 Shadow DOM 定位（接口正文）

`/health.capabilities` 含 `visible-open-shadow-v1` 时，text、elements 查询可增加 `shadowPath`。每步是 `{ "selector": "公开宿主选择器", "index": 0 }`；最多 8 步，index 为 0—1999 的整数（省略为 0），按当前范围内 rendered 可见匹配宿主的顺序定位。构造路径序号时，必须使用同层、同选择器、visibility 为 rendered 的列表，不能拿 viewport 过滤后的列表序号代替；列表变化后重新读取。每步只进入该宿主的开放 `shadowRoot`。CSS 规则、禁读载体、公开字段和 URL 脱敏保持不变；不进入封闭根、iframe，不读取存储、隐藏值或私有接口。

```json
{"kind":"elements","shadowPath":[{"selector":"demo-comments","index":0},{"selector":"demo-thread","index":0}],"selector":"button","visibility":"viewport","limit":10,"fields":["tag","text"]}
```

路径省略或为空时，查询保持普通 DOM 行为。路径宿主与 elements 列表统一采用非零可见矩形口径编号；零尺寸宿主（包括本身无矩形的 display:contents）不进入，本版不支持此类宿主。进入开放根后，返回的文本包含当前组件内可见的开放根和插槽文字；已分配插槽不重复读取备用文字。每次请求共用 2000 个候选、2500 个文本节点、8000 个遍历节点、128 个开放根上限，每段文本遍历／命中下钻最多 16 层开放根；原 50 项、16000 字、64 KiB 与超时限制继续有效。触顶明确标记 truncated。正文选择器仍需指向该根内真实存在的元素，不能以“查到宿主”代表读完其评论。

`/click` 和 `/clickAt` 仍接受原 CSS 字符串，也接受受限 JSON。JSON 只允许 selector、shadowPath、index、expectedText；原请求体 2048 字节上限不变。index 可选，按最终范围中可见候选的顺序选择；未给 index 时维持视口优先。expectedText 为 1—160 字的普通可见文字，按空白归一化后精确比对，点击前后不符就停止。

```json
{"shadowPath":[{"selector":"demo-comments","index":0},{"selector":"demo-thread","index":0}],"selector":"button","expectedText":"共 2 条回复"}
```

示例是本地验收页的组件名称，不是 B站内部选择器。B站应先从公开 DOM 查询发现当前结构，核对作者、正文和展开文字，再定位该楼层；每次展开或续载后重新获取位置。点击仍检查宿主可见性、实际遮挡、租约和弹窗额度，closed 根与不可验证命中一律停止。clicked=true 只表示点击完成，须复读新增回复和截图确认结果。

相关返回原因包括 shadow_host_not_found、shadow_root_unavailable、traversal_limit、text_mismatch、not_visible_or_changed；点击继续通过现有 element_not_found 错误的 reason 字段返回定位原因。
