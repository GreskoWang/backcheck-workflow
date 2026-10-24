# 采集结束后的统一接续

`prepare.py` 把已结束的采集接到全文分片、媒体清单、可选公开图片下载/编图及覆盖待办。
`watch` 从采集启动时即可挂在当前执行任务的后台：只观察本地文件，终态后自动准备一次；不再由模型反复查询采集状态和逐个拼接命令。
它不执行账号调查、自动确认已读或风险、不写飞书，不监听派单、不创建定时任务、对话或消息。

## 入口

```powershell
$python = $env:RESEARCH_PYTHON
$pipeline = "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\pipeline\prepare.py"

# 采集已结束：一条命令准备本地阅读材料，默认离线。
& $python -X utf8 $pipeline prepare 'D:\任务\采集\result.json' --out 'D:\任务\阅读准备'

# 采集仍在后台：观察本地job.json，终态后自动接续，只在新阶段输出NDJSON事件。
& $python -X utf8 $pipeline watch 'D:\任务\采集' --out 'D:\任务\阅读准备' --max-wait 1800

# 已授权任务需要公开图片时，自动继续下载和编图；不会读取浏览器认证材料。
& $python -X utf8 $pipeline watch 'D:\任务\采集' --out 'D:\任务\阅读准备' --fetch-public

& $python -X utf8 $pipeline status --out 'D:\任务\阅读准备'
& $python -X utf8 $pipeline cancel --out 'D:\任务\阅读准备'
# 确认仍要接续原任务后显式恢复；取消信号不会被普通重复调用清掉。
& $python -X utf8 $pipeline prepare 'D:\任务\采集\result.json' --out 'D:\任务\阅读准备' --resume
```

使用当前执行工具的后台进程包装器运行 `watch`；标准输出在阶段变化时刷新，可由工具捕获完成/受阻事件。
`watch` 不自行触发新的模型回合或站外通知；当前任务收到最终 `next_action` 后，必须继续实际阅读与核查。
`--fetch-public` 是是否执行下载的命令选项，不是再次征求用户授权的门槛；既有背调授权范围内需要公开图片时直接使用。登录验证、签名或访问限制仍按原浏览器规则处理。
同一个输出目录最多一个处理器，包括等待阶段；操作系统文件锁在进程退出后自动释放，不靠删除陈旧PID锁恢复。

`watch` 默认最多等待1800秒，可用 `--max-wait` 调整至不超过14400秒；`--poll-interval` 默认0.5秒、范围0.05–5秒，只读本地状态，不轮询浏览器或平台接口。
本地状态不变不重复输出。终态为 collected/needs_review/paused/failed，必须与 result.json 的 job id/state/iterations 相符；任务ID变更或陈旧结果不会串入当前任务。终态后结果提交有短暂缓冲，但不会无界等待缺失结果。
取消watch只取消本地接续，不修改或终止采集worker；需要停止采集时使用原 `research-batch.mjs cancel`。

## 默认自动完成什么

1. 验证输入格式、保留采集未完成/截断/媒体缺口；运行中的结果不冒充终态。
2. 标题、全文和引用分别映射，按默认6000个Unicode字符自动连续分片，可配置 `--max-chars 128..45000`；新增/改变内容的阅读确认全部为false，实际旧确认只在下述严格条件下复用。
3. 自动转换媒体清单，保存缺图和未支持媒体；没有媒体就跳过下载与编图。
4. 默认离线时把有媒体的阶段明确标为 pending_public_fetch；显式 `--fetch-public` 才调用既有公开图片下载器和本地接触图生成器。
5. 保存初始覆盖待办和 `next_action:model_review_required`，要求实际全文阅读、范围内媒体核查、原帖风险核验；采集缺口仍需补足。

公开下载默认最多3个并发、每项20秒，可用 `--concurrency 1..3`、`--timeout 0..120` 调整。
沿用原下载器的签名/凭据URL拒绝、真实图片校验、429停该host和零自动重试，不增加认证、Cookie、代理或TLS处理。
取消时不再开始新的请求；已在途请求完成或按单项超时退出，已下载内容保留。网络/编图失败不撤销已完成的文字分片。

部分失败或错误不隐性重抓。再次调用相同入口复用已有成果。
确需重试媒体时显式加 `--fetch-public --retry-media`，另开尝试目录；仅编图失败会复用已下载图片，已成功媒体不会重复下载。
对下载部分失败显式重试会另作一批下载，可能再次请求原已成功图片，应按当前任务需要决定；也可直接按既有失败来源单独恢复。

## 版本与输出

```text
阅读准备/
  processor.lock           操作系统锁文件，不是人工台账
  control.json             本地取消信号
  state.json               当前阶段和next_action
  events.ndjson            自动生成的轻量事件
  revisions/rev-0001-.../
    meta.json
    source-result.json     本次输入缓存快照
    text/text-0001.txt ...  全文批次
    text/review.json        自动映射；由实际阅读者确认
    text/plan.json          自动续读/复用计划，取消恢复不重排已有批次
    text/prepared.json
    media-manifest.json
    assets-0001/           仅显式fetch-public时
    sheets-0001/           仅显式fetch-public时
    initial-coverage.json
    preparation-state.json
```

按内容、范围、采集状态和分片配置生成任务级revision；时间戳变化不新建版本。
相同输入幂等复用，已有 `review.json` 确认绝不覆盖；正文/范围或分片配置改变另建revision，旧版本保留。
仅补媒体、覆盖状态或其它非文字信息时，不强制重读逐字相同的已读文字：同一job/请求身份、同一主体和scope，且来源ID、post_url、account/account_id一致，标题/正文/引用字段逐字相同，才允许复用旧确认。
版本指纹与借读判断同时绑定已有top/job owner、thread/thread_id/threadId、task_id/taskId、requestId/request_id；单帖详情另绑定target，不能用固定recipe+post的job.id跨执行上下文套用缓存。详情具有owner+target或明确task/request身份时才允许缓存/借读；这些身份都不足时仍可准备正文，但每次新建未读版本。历史未绑定这些上下文的详情缓存不借读。普通唯一job.id的批量任务保持原用法，不要求用户手工补身份台账。
旧确认必须有匹配旧正文指纹、有效实际阅读者、未截断输出、合法且无缺口的完整字段阅读区间，原导出文件也需与其来源映射一致；部分字段尚未读全、旧指纹错误、collector自报或文件改动均不复用。
较新同任务/context的review存在明确unread_ranges时，阻断向更早版本借读，不能跳过否定声明再找旧PASS；只保留其后真正重读确认的字段。明确未读范围不会因补图和新版本而变成已读，原声明也不被改写。
新review绑定当前整批正文指纹，复用项保留原阅读者和 `reused_from` 来源，旧文件不改；只有新增/变化字段导出新txt，`next_action`给出未读批次数和已复用字段数。跨任务/请求、主体、范围或来源映射变化不能借用确认。
无标题旧缓存使用兼容指纹，后来新取得的标题仍为未读。复用已读不自动确认媒体、风险结论或成品PASS。
取消中途的 text.pending 可接续，但既有文件不同、成品批次被修改或事件日志损坏时保留并报告冲突，不静默覆盖或丢弃。
这些是工具自动缓存/续读元数据，不要求普通历史报告补造研究包、逐帖哈希或人工台账。

## 事件与结束条件

事件含稳定 `event_id`，消费者可据此去重。包括：waiting_for_collection、collection_terminal、collected、text_ready、media_manifest_ready、media_pending、media_ready、needs_review、cancelled、error。
`collected` 仅指采集记录通过终点一致性检查；text_ready/媒体ready仅指材料准备好。
所有事件始终 `review_status:not_reviewed`、`surface_completion:false`；最终状态也不自动设 coverage_complete=true。
收集错误、截断文本、未展示图集和失败媒体不会被改写成“无问题”。

`status:prepared` 是本地准备结束；随后模型读取未确认的批次、确认实际已读项、核查媒体/风险，再走原飞书交付与终审。没有可下载公开图、仅剩视频/签名/其它失败占格时，默认直接标needs_review保留缺口，不要求无用下载。
程序不生成研究/飞书PASS，也不结束Goal。

退出码：0=本地材料已准备（仍未阅读）；2=正文可用但媒体待处理/部分失败；3=本地取消；1=错误或等待超时。
CLI最终回执给出状态、版本目录、阶段摘要及明确next_action；watch另逐行输出新阶段事件，状态不变保持静默。

## 离线验证

```powershell
& $python -X utf8 -m unittest discover -s "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\test\pipeline" -p 'test_*.py' -v
```

测试用模拟下载transport并运行真实覆盖/媒体组件；真实网络被禁止。包括100条长文、九图3/9缺口、失败占格、旧确认保留、新revision、跨进程互斥、下载中取消、静默等待与终态接续、陈旧结果/任务ID变更拒绝及CLI事件输出。
离线通过不代表真实平台提速倍数或完整背调端到端已验收。
