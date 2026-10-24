# 背调批量采集与阅读工具

使用前读 [manifest.json](manifest.json)。本包把重复滚动、正文整理和媒体编图交给程序，把账号归属、全文阅读、风险判断和原帖核验留给执行者。

默认入口与命令见 [批量阅读说明](../../skills/web-access/references/research-batch.md)。后台 worker 位于 web-access Skill，复用既有 Edge broker 和本任务租约；不另外直连 CDP。

- [coverage](coverage/README.md)：按字符导出全部文字及自动续读映射；校验实际批次确认与覆盖缺口。
- [media](media/README.md)：公开图片下载、本地图片分页编图、已有视频快照与时间戳编图。
- [pipeline](pipeline/README.md)：静默等待本地采集终态，自动接续文字、媒体与审阅待办；保留旧阅读确认和媒体失败。
- [详情客户端](../../skills/web-access/references/research-detail.md)：核对主体及原帖、读取正文和有限展开；不要求服务重载，未知布局不假通过。

所有入口的 `surface_completion` 均为 false。采集、导出、关键词扫描或编图成功都不证明已阅读，也不能自动生成“无问题”。普通任务不增加逐帖手工台账或取证包。

本包借鉴用户提供的 `交接包_20261014.zip` 中后台分页、正文批读、媒体 contact sheet 和固定校验的做法，并重新适配当前访问政策和四态完成判定。原包存放于本轮 process 的 raw 目录，仅作为来源保留；未直接安装其 Skill、启动器、私有接口或默认清白的渲染器。具体审阅与测试证据见 `$env:BACKGROUND_CHECK_WORKSPACE\process\claude-handoff-review-20261014`。
