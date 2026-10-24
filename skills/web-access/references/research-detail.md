# 详情与有限展开客户端

`scripts/research-detail.mjs` 复用已运行broker与原任务页的有效租约，不重载服务、不新建浏览器连接。适用于已取得原帖链接后，在独立详情页补取正文、实际日期和作者；不用于翻遍主页，不输出风险结论。

## 使用

先停止占用同一target的 `research-batch.mjs` worker，并等待其退出、释放target锁。不要直接结束进程或删除残留锁来腾位置；残留锁按原job恢复流程处理。不同target且不同平台／注册域的工作可继续并行；同一平台或注册域同一时刻只由一个执行者发起浏览器、API或脚本请求，共享限流及等待节奏，不能因换target绕开。该客户端与批量worker共用 `research-target-locks`；普通人工工具仍由执行者保证不与本客户端交叉控制同页。

在当前任务进程中已保存有效 `CDP_LEASE` 后运行；token仅由客户端从当前用户broker目录读取并放入请求头，不写入命令参数、日志或result。

```powershell
$node = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$detail = "$env:USERPROFILE\.codex\skills\web-access\scripts\research-detail.mjs"
& $node $detail --target $target --owner $owner --recipe weibo-detail --subject 1000000135 --post A00000001 --out "$env:BACKGROUND_CHECK_WORKSPACE\日期\对象\process\detail-新批次"
```

输出目录必须为新目录，已有材料不会覆盖。`--subject` 为任务已确认的微博UID、B站UID、X handle（不带@）或小红书24位用户ID；不传时只保留观察，不自动确认归属或点击展开。`--post` 可绑定已确认的帖ID／BV号；实际URL不匹配即停。可用 `--max-expand 0` 禁止自动展开；默认最多2次，不能扩大。`--port` 默认3456，仅允许本机回环HTTP服务。

## 配方与边界

| recipe | 接受的详情 | 当前提取方式 |
|---|---|---|
| `weibo-detail` | weibo.com的UID/帖ID、detail/status，m.weibo.cn的status/detail | 固定正文class候选；URL作者与当前作者链接核对；引用容器单独读取 |
| `bilibili-dynamic` | t.bilibili.com/数字ID，bilibili.com/opus或dynamic详情 | 固定正文与作者profile链接候选；多节点、未知布局不合并猜全文 |
| `bilibili-video` | bilibili.com/video/BV号 | 标题、简介、作者UID、日期分别保留；简介标为 `video_description_only`，不能证明已看视频 |
| `x-post` | X/Twitter的handle/status/数字ID | 保存单article的可见文本、时间和媒体候选；当前DOMschema无法可靠排除引用卡，故不赋为本人全文、不自动展开 |
| `xiaohongshu-detail` | explore/discovery/item及profile内24位帖ID | 固定标题、正文、作者profile链接和日期候选；不读取或保留xsec_token |

这些是有界候选配方。接口级测试通过不代表每个平台的当前布局现场已验证。生成class变化、多个正文节点、作者不匹配、未识别日期、截断和剩余展开入口均保留具体缺口；不fallback整页／整article文字作为本人正文。仅已核实布局可据输出继续判断。真实站点验证由任务执行者另留结果，不能把mock测试称作现场成功。

历史现场验证沉淀的可复用方法（不保留原帖、作者、账号、标题或任务材料）：

- 微博mobile可用`.weibo-text`与`.weibo-top`分离正文、作者和日期；宽时间选择器会混入视频时长。它只证明当时mobile布局，不证明桌面生成class或整账号完成。
- B站视频标题、作者稳定ID、简介与实际日期分字段读取；某日期selector无命中时不能伪补。视频文字取得不证明视频、音频或评论已看。
- 小红书激活同一任务页后重新查询窄selector，再按当前rendered index与expectedText点击。正文日期选择器须与评论日期分离。重复src节点不计独立配图，签名URL脱敏后不猜补下载链接。
- 这些是历史特定布局验证；B站动态、X全文及真实折叠展开没有因此完成。旧点击失败的具体reason曾被测试链丢失，不能倒推原因；仅保留“激活同页＋鲜查询窄selector”的已观察恢复方式。

自动展开先查询当前控件，再用固定selector、实际rendered index和 `expectedText` 点击；仅页面、主体与唯一详情容器一致才执行。每次点击后重读URL、主体和正文，地址变化或内容无进展即停止。不是用 `expectedText`在全页搜索按钮。采集总预算90秒（每次请求仍受broker短超时限制），最多75次请求；无任意JS、fetch、私有接口或凭证读取。

## result.json

`schema_version: 1`；保留以下字段：

- `source`：实际详情URL、帖子ID、从路由读到的主体ID；URL移除query/fragment及认证材料。
- `subject`：期望主体、可见作者链接解析出的ID、是否一致；缺少或冲突不会改为已确认。
- `own`：能明确分离的本人正文；归属／结构不能确认时为空，原观察在 `observations.body_text`。
- `quoted`：单独识别的引用容器；引用作者尚未核实则明确为未知，不归给本人。
- `observations`：标题、日期、实际选择器、剩余展开控件；日期保留原页实际显示，不猜测年份／时间。小红书正文日期缺失时，宽selector的评论日期只存 `unassigned_date_observations`，不会赋给帖子。
- `media`：仅候选URL，归属与目视状态始终待核；头像、装饰图、占位和未展示图集可能混入，须由媒体步骤筛选。没有返回媒体也不证明无图／无视频。
- `coverage`：分别记录文字取得、文字人工阅读、媒体、评论和缺口；`text_collection_complete`不能作为平台完成或无风险结论。

另外保留可直接交接给既有轻量工具的标准 `items`、`job` 和 `scope`：每条 `source_id` 为此详情帖ID，`text`只含已确认的本人正文，`quoted_text`单独保存引用容器文字，`text_truncated`／`needs_expansion`明确剩余缺口。实际取得的视频／笔记标题另存 `items.title`，作为独立未读字段交给coverage和pipeline，不混入简介；没有标题的历史格式不补空title。作者名按已核实的同一UID选择非空可见名称，头像空链接不会遮掉后面的真实作者名；归属核验始终依据稳定ID。未归因的混合观察只在 `observations`，不会填成本人正文。标准媒体使用 `image`／`video`类型，并带 `candidate:true`、`attribution_verified:false`、`post_source_id`和稳定 `media_id`；媒体范围尚未核实，`media_extraction_complete:false`不能被下载或编图成功覆盖。

`needs_expansion`仅表示实际剩余展开控件或展开失败；日期、归属或引用分离待核放入 `needs_detail_review`和 `coverage.unresolved`，不会因日期未核就声称正文需展开。

`scope.kind=single_post_detail`，边界只绑定当前这一篇原帖；最后一次URL核对成功才记录 `scope_boundary` 与已验证边界。`coverage.collection_complete`与 `text_collection_complete`仅表示该详情的文字取得状态，不表示图片、评论、主页或整个平台完成；`unresolved`保留媒体归属／提取和实际故障。`observed_count`等于标准items数，未取得合法详情来源时为0。

`conclusion` 永远为 `incomplete`：客户端不审阅语义、不观看图片或视频、不读取评论，不完成整个账号。正文、引用、视频简介及画面不能互换。HTTP成功／按钮点击成功不能覆盖剩余缺口。

## 直接接到阅读准备

无需改写result.json或手工复制正文。以下默认完全离线，不下载媒体：

```powershell
$python = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\pipeline\prepare.py" prepare "$env:BACKGROUND_CHECK_WORKSPACE\日期\对象\process\detail-新批次\result.json" --out "$env:BACKGROUND_CHECK_WORKSPACE\日期\对象\process\detail-阅读准备"
# 或只导出未确认阅读批次及覆盖检查：
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\coverage\validate.py" "$env:BACKGROUND_CHECK_WORKSPACE\日期\对象\process\detail-新批次\result.json" --export-text "$env:BACKGROUND_CHECK_WORKSPACE\日期\对象\process\detail-全文分批"
```

准备阶段的 `prepared`／格式有效只说明交接成功，阅读确认仍为false、总体覆盖仍未完成。媒体候选须按[媒体批量工具](../../../tools/research-batch/media/README.md)的既有筛选和授权范围处理；不因为标准kind可消费就认定是本人配图或扩大视频范围。

## 本地验证

```powershell
& $node --test "$env:USERPROFILE\.codex\skills\web-access\scripts\research-detail-selftest.mjs"
```

测试包括固定schema、URL列表反例、主体冲突、展开后跳到其他帖子、长文截断、引用混入、媒体未看、与批量worker的锁冲突，以及真实本地HTTP＋CLI的capability仅在请求头和结果脱敏。该真实CLI产物继续调用现有coverage导出和pipeline prepare CLI，验证标准schema无需人工改接、阅读确认仍false；不加 `--fetch-public`。测试不访问真实平台，也不改变broker，每次测试的本机产物保存在工作区 `process/adapt-20261015/detail-client/contract-*`，不进入发布包。
