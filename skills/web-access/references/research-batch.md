# 可恢复的批量阅读缓存

## 2026-10-24 采集完整性修复

运行 broker 的 `/health.capabilities` 出现 `research-dom-window-v2` 才表示已加载新的 B 站动态配方。它只读取视口及上下各一屏重叠内的卡片，不再对保留在 DOM 中的全部旧卡片反复读全文。每卡限额为 50000 节点/1000000 字符，整次快照保留 200000 节点/4000000 字符上限；超限明确返回 `extraction_truncated` 和 `truncation_reason`，不会为尚未访问的卡片制造空记录。端点及加载提示须在当前视口，离屏页尾不证明已到终点。

新版 worker 对同一页面、作者、日期、正文、引用及媒体完全一致但缺少原帖 ID 的观察做内容去重，`observation_identity=content_fingerprint_not_post_id` 仍是未解决的来源，不可冒充原帖 ID 或平台完成。不同媒体/作者/日期不合并，全空且无来源的媒体卡片不合并。`extraction_truncated` 或 `unattributed_empty_card` 时保存本轮取得内容并停下，不继续滚动或自动重试。已知作者、日期及原帖 URL 不被后来的 null 覆盖。

B站动态现优先使用固定配方在隔离 world 中维护的 `dom_observation_id`：同一 DOM 卡片、作者、日期及正文不变时，图片从未加载变为加载完成仍合并为一次观察，合并保留后来取得的媒体。它不写 DOM 属性、页面应用状态或浏览器存储。不同卡片、被复用为不同正文的节点及不相容的媒体集合不共用标识。归一化结果标记 `dom_observation_not_post_id`，公开原帖链接缺失仍是来源缺口。节点被重新挂载或页面重建会产生新的观察标识，不承诺跨页面去重；旧配方无此标识时继续使用上述内容指纹。不能把任一种观察标识冒充原帖 ID。

含 `research-recipe-reload-v1` 的 broker 会在固定配方快照前核对本地固定模块的内容哈希，返回 `recipeRevision`。修改通过检查的固定配方后可在同一 broker、租约和 Edge 连接中生效，不为这类更新重启服务或重新索要授权。它不接受调用方传入文件路径、代码或版本参数，模块校验失败则拒绝该次快照。修改 broker 本身仍须协调全部 owner 空闲后受控加载。验收同时绑定目标页、页面位置、磁盘哈希和每次快照的 `recipeRevision`，不能只看 capability 或旧截图。

本次修改不重写历史 `items.ndjson`，不移动已有阅读记录，不重置页面恢复额度。旧大缓存保持原状，续作使用同一批次、同一范围和实际断点；新版本的有界验证须由原任务协调有效 owner，不能复用失效 session/PID/capability。磁盘补丁和离线测试不等于运行服务已加载，现场至少核验三次窗口的日期、正文尾部和媒体对应后再扩大批次。

旧版 `unresolved-轮次-序号` 记录不会被本补丁自动迁移或压缩。已经触发 `cache_limit` 的历史目录不能靠直接 `resume` 消除旧文件的体积限制；保留该目录，在同一批次内从核实后的原页断点建立新的有界续作目录，并明确记录父目录、起点及原有恢复次数。旧缓存与阅读结论继续纳入总覆盖核对，新目录不代表从头调查，也不能重置故障恢复额度。

用于已授权主页的重复滚动、分页和正文取得。沿用登录态 Edge、原 owner、lease 和单一 broker；不新建第二套 CDP 连接，不开放任意 JavaScript，不导出浏览器认证材料。后台缓存只是取数，模型仍须实际阅读、归因、看图和核实原帖。

## 何时使用

主页内容较多、可以稳定连续读取时，优先启动一个固定配方后台任务，将机械滚动与等待交给程序，同时处理其他域名、已导出的正文或飞书写入。每个平台通常一条采集路线，不为单帖新建任务。开始前确认账号、所需时间范围和起点；从当前页面中段采到末尾只覆盖这段，不能宣称全主页完成。

固定配方为 `weibo-feed`、`bilibili-dynamic`、`bilibili-video`、`douyin-posts`、`xiaohongshu-notes`、`generic-posts`。配方只读当前可见DOM；折叠正文、列表摘要、未展示图集和占位保留缺口。B站已登记的分页控件可自动翻页，未识别的布局不得猜按钮。小红书详情正文可交给独立详情客户端；列表配方为空不证明无笔记。X等尚未支持的全文归因仍走原平台规程，不能套通用配方冒充完成。

## 运行

在持有目标页租约的进程中使用。`CDP_LEASE` 留在环境，不放命令行或任务文件；示例中的 target/owner 来自本任务已经取得的页面。Node优先使用 bundled runtime，以下 `$node`、`$python` 为其绝对路径。

```powershell
$runner = "$env:USERPROFILE\.codex\skills\web-access\scripts\research-batch.mjs"
& $node $runner start --target $target --owner $owner --recipe weibo-feed --out "$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\对象\process\weibo-batch"
& $node $runner status --out "$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\对象\process\weibo-batch"
& $node $runner read --out "$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\对象\process\weibo-batch"
```

`start` 确认独占 worker 后返回，后台继续；`status/read` 读取本地缓存。无需模型逐屏续命，也不轮询每个动作。默认每次观察间隔2秒、单次最多15分钟；这些是可配置的采集预算，不是整个平台或阅读时限。只有实际新内容才算进展。原平台有更长等待／公开限速时按其要求设置 `--interval-ms`，不得用更短间隔规避验证或限流。

任务目录保存 `job.json`、追加缓存 `items.ndjson`、`result.json` 和错误日志，不保存 lease、Cookie 或 token。自动去重、分离本人／引用文字、保留媒体来源。当前页变化、验证码、登录墙、超时或限额会保存已取得内容并停止本路线，不阻其他工作。

```powershell
& $node $runner cancel --out "$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\对象\process\weibo-batch"
# 等 status 显示已停止，再做原页点击、滚动、导航、release/finalize。
# 恢复时先按原规则取得同一任务页的新鲜有效lease；检查账号URL和断点。
& $node $runner resume --out "$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\对象\process\weibo-batch"
```

一个目标只允许一个本机采集worker，跨输出目录也互斥。前台拿同一个lease的操作仍由执行者协调：必须先cancel并确认停止，不与采集交叉控制。恢复仅回收已验证死亡且属于同一job的锁；活锁、未知归属、损坏缓存保留待核对，不强杀进程或猜测修复。不同任务不能借resume复用旧范围。

同一注册域名仍只由一个执行者推进页面和脚本请求；其他执行者阅读缓存或处理不同域名。因步数预算停止时，恢复需显式提高 `--max-steps` 至大于已记录 `iterations` 的总步数；时间预算每次恢复重新计时，`--max-seconds` 可显式调整，不能把反复续预算代替处理停滞或限流。

## 运行版本与终点

broker的 `/health.capabilities` 包含 `research-dom-snapshot-v1` 时使用固定结构化全文快照。缺少该能力时，worker兼容旧 `/dom/query`，仍可后台保存可见正文，但保留16000字符截断标记、来源和终点待核；兼容模式绝不自动声明完整。不能为了加载新模块中断其他owner的页面；受控切换按主Skill的专项修复规则。

兼容模式只缓存当前页面的可见正文，不自动证明所在表面适用该配方。启动前必须以/info实际URL、页面标题与账号字段共同确认主页／列表路由；账号名和数字ID也可能出现在搜索预览卡中，单靠它们不能证明已经进入主页。通过点击进入主页时先核对请求成功、clicked及点击后的真实主页URL，再启动worker；仍停在搜索页或入口不明确时停止，不把错误表面的缓存计入主页覆盖。

原页小幅上滚再下滚恢复一次后仍不增长，记 `stall` 或 `empty_response`，不当历史终点。只有已登记独立终点控件／已确认分页末页且无加载框架才标当前起点之后的可见终点；该标记不证明全文展开、媒体已看或绝对历史完整。公开边界或用户时间窗需按真实依据确认，不追平不可枚举累计数，也不允许54/77一类未核实差额被改写成全部看完。

## 整批阅读与媒体

优先在启动采集后运行统一接续入口，避免逐项手接命令：

```powershell
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\pipeline\prepare.py" watch "$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\对象\process\weibo-batch" --out "$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\对象\process\weibo-prepared" --max-wait 1800
```

用当前执行工具的后台进程包装器等待阶段事件。watch只观察本地job/result，状态不变静默；终态后自动导出文字、媒体清单和覆盖待办。默认离线，已授权任务需要公开图片时直接加 `--fetch-public`，继续下载和编图，不另设用户确认；媒体失败不撤销文字成果。输出 `next_action:model_review_required` 后继续实际阅读、原帖核实及飞书流程。它不自行唤醒新模型回合或发送消息，不能把本地prepared当研究完成。取消、恢复、版本及事件契约见[接续说明](../../../tools/research-batch/pipeline/README.md)。

列表摘要、折叠和正文混入界面文字时，先停止同页worker，再用[详情客户端](research-detail.md)核对原帖与作者、展开正文；未知布局保留缺口，不能用整页文字替代本人正文。以下底层命令仍可用于单独导出或诊断：

```powershell
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\coverage\validate.py" "$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\对象\process\weibo-batch\result.json" --export-text "$env:BACKGROUND_CHECK_WORKSPACE\YYYY-MM-DD\对象\process\weibo-read-1" --max-chars 6000
```

工具通用默认最多45000个字符；本机终端示例先设为6000，避免大批中文超过输出上限。标题、正文和引用分开映射；超长单帖跨批续读，不是取正文前N字。阅读工具若仍截断，缩小 `--max-chars` 后使用新的输出目录继续。阅读者只确认确实读完的批次，映射自动生成，不手写逐帖阅读账。关键词只作第二道补漏。pipeline仅在同任务、同主体、同范围及同来源映射下，复用逐字未变且旧记录已完整确认的字段，并绑定新缓存；新增或改变字段继续未读。单独的coverage导出仍全部未读，不能直接套旧指纹。

先用 `media/export_manifest.py result.json NEW-manifest.json` 从采集缓存自动生成媒体清单，不逐张手抄来源；无媒体时跳过下载与编图。公开配图再用 `$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\media\fetch_assets.py` 下载，用 `media.py sheet` 生成分页接触图；已有本地雪碧图与真实时间戳元数据用 `media.py videoshot`。输入输出契约见[媒体说明](../../../tools/research-batch/media/README.md)与[覆盖说明](../../../tools/research-batch/coverage/README.md)。每格保留原帖、媒体ID和日期；缺图、损坏、签名访问失败保留记录，疑点回原图／原帖。视频快照只证明采样画面，不代表音频、字幕或评论已经查看。

`coverage/validate.py result.json --review read-dir/review.json --require-complete` 只核对批次、范围和确认是否一致，不代替阅读与判断。仅此批量路线使用这个轻量缓存格式，不要求普通既有报告补造研究包、逐帖哈希或取证材料。四态结论与采集、阅读、媒体状态保持独立；格式通过、程序结束、拼图生成均不等于背调完成。

## 持续加载提示与已加载帖子（2026-10-24）

部分微博主页在已加载帖子下方保留加载标记。默认加载等待仍适用于空框架；若原页已核实有可读帖子、正常滚动能获得新帖，可在已停止的同批 job.json 中显式设置 `scroll_with_loaded_items: true` 后继续。此选项默认关闭，验证或登录提示仍先停止，空列表仍不前滚；已加载列表在出现新内容或连续两个观察周期后允许固定小幅滚动，保留原停滞恢复和时间/步数上限。不得据此忽略限流、把占位当终点或宣布已读。

本机25项回归通过，飞傲官方微博同页现场缓存由4条增长至56条；仅证明批量推进恢复，不证明主页已读或全文已展开。当前配方可能对含“...展开”的卡片仍返回 `needs_expansion=false`，须同时检查实际文本与原页控件，不能依赖该布尔字段判定全文完整。

### B站下一页定位兼容（2026-10-24）
配方返回的下一页选择器可能含属性值比较，受限click会返回unsafe_selector。客户端现改为通过公开DOM枚举最多50个rendered button，按已登记下一页文字唯一匹配并校验expectedText后正常点击；截断、无匹配或多匹配停止，不放宽broker选择器规则。25项既有回归通过，现场从首40条到8页302条取得不同BV来源，确认翻页已生效，无服务重启。最后一页可能隐藏下一页而非禁用，自动结果仍为stall，须依据当前第8页、共8页和实际目录确认可见终点，不能以计数单独判断。
