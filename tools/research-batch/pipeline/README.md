# 采集结束后的统一接续

CLI 新建输出目录默认使用精简模式，旧目录自动沿用原格式。工具只准备材料与记录实际阅读断点，不调查账号、不自动确认风险、不写飞书，也不结束 Goal。

## 普通任务

```powershell
# $python 使用本机已配置的 Python，$pipeline 为 tools/research-batch/pipeline/prepare.py。
& $python $pipeline prepare '任务/采集/result.json' --out '任务/阅读'
# 采集尚未结束时改用本地 watch，不轮询浏览器。
& $python $pipeline watch '任务/采集' --out '任务/阅读' --max-wait 1800
& $python $pipeline read --out '任务/阅读'
# 实际读完且输出未截断后，用 read 返回的 ID 确认。
& $python $pipeline confirm --out '任务/阅读' --batch '<batch_id>' --reviewer root
& $python $pipeline status --out '任务/阅读'
```

`read` 按标题、正文、引用连续返回一批，默认最多6000字符，长帖跨批续读；来源随批返回，不另存文本文件。再次read返回同一未确认批次。confirm只接受刚显示且未改变的批次，重复确认不推进两次。所有内容读完仍不自动得出“无问题”。

输出截断时不要确认：先运行 `discard-pending --out ...`，再在同一目录 prepare 加 `--max-chars 128..45000` 调整批次大小。只丢弃未确认批次，已读前缀不变。源缓存新增尾部内容时可续读；已读正文、归属或任务范围变化会保留断点并报冲突，需要针对变化核对，不能将旧确认强行套用。

每个阅读目录只有一个权威 `state.json`，含源缓存路径、任务绑定、游标、已读前缀指纹、最后锚点及媒体进度。不复制source-result，不创建文本分片、revisions、events或额外模型审阅回执。重复prepare在内容未变时不重复写状态。`processor.lock` 是操作系统互斥锁，`control.json` 仅用于取消信号，不是第二份研究进度。

## 图片与失败恢复

需要公开配图时在prepare/watch加 `--fetch-public`。程序只为新增来源映射准备媒体批次，重复调用不重下载或重编图。任务内 `image-cache` 按内容复用图片实体，来源映射分别保留；只读公开图片，不导出凭据或扩大访问权限。源图片在本任务外发生更新时，不能把缓存当作最新页面证明，需按原来源定向核验。

真实看完某个媒体批次全部画面后，用confirm确认它的 `media-XXXX`。失败、占位或未看画面不能确认，不逐张另写“无问题”。视频仍按原平台方法核查，图片缓存不能证明音频、字幕或评论已读。

网络或编图失败不撤销正文断点，也不会自动重试。确需处理失败批次时用 `--fetch-public --retry-media`，仅重试失败批次，成功图片从任务内缓存复用，不重新请求。`cancel --out ...` 只取消本地接续；显式 `--resume` 才清除取消信号。原采集worker需用它自己的cancel命令停止。

watch默认最多1800秒，上限14400秒，只观察本地文件；job ID/state/iterations须与结果一致。等待、超时、取消不会覆盖已有阅读状态。精简模式只向当前调用输出阶段事件，不另外保存事件日志，不自行唤醒模型或发消息。

`text_read_complete`只说明缓存正文读完。范围、图片、重点视频/互动、搜索及具体缺口仍由执行者核对；平台四态结论只写入本任务的当前结论，不复制到多个状态文件。风险证据独立保留事实、归属、原链接及必要截图。无问题缓存是临时阅读材料，平台交付核对且确认不再需要恢复后，由原任务回收；维护工具不得清空共享目录或其他任务断点。

## 旧任务兼容

已有revisions或旧state的目录自动保持旧格式。已有source-result、文本批次、review.json和旧阅读确认都不迁移或清理。显式旧格式诊断可加 `--layout legacy`；Python既有调用prepare_result/watch_job保留legacy默认，新调用使用layout="auto"。

旧格式仍按同任务、主体、范围、来源映射和正文指纹复用完整的实际阅读确认，跨任务、变更字段、截断输出和明确未读范围不会继承。旧格式的覆盖检查见 [coverage](../coverage/README.md)，不要求新精简模式补造其逐项审阅材料。新格式不能强制覆盖旧目录；使用同一任务的原格式续作即可。

## 验证

```powershell
& $python -m unittest discover -s 'tools/research-batch/test/pipeline' -p 'test_*.py'
```

回归覆盖按需全文续读、旧断点不变、任务/源内容冲突、媒体复用与来源映射、失败定向重试、取消、并发锁和CLI默认入口。模拟网络不代表真实平台已修复；本次精简不涉及broker或浏览器重载。
