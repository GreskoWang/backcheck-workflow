# 批量路线的轻量覆盖校验

本工具只用于新的 `research-batch` 批量路线。普通既有背调不用补造研究包、逐帖哈希或手工阅读账。
阅读批次及字符映射由程序生成，阅读者只确认实际读完的批次；一个任务级正文指纹用于阻止新缓存复用旧确认。
它校验状态与记录是否一致，不替代模型阅读、风险判定、账号归属核实或飞书终审。

## 运行

```powershell
python coverage/validate.py job.json --export-text process/read
# 阅读 text-0001.txt 等；在 review.json 为实际读完的批次设 reviewed:true，并写 reviewer。
python coverage/validate.py job.json --review process/read/review.json --require-complete
```

`--export-text` 默认每批最多 45000 个 Unicode 字符，包含来源头；超长单帖会自动续到下一批，标题、正文、转发原文分别映射。
不输出固定前 N 字，不按行数猜输出长度。工具终端如仍出现截断，必须使用本地文件分段继续读取，不能直接确认该批次。
`--max-chars` 可缩小至阅读工具实际上限，最小 128。导出的 `review.json` 全部 `reviewed:false`，采集器不能自动设为已读。

默认退出码只反映格式能否消费：0 格式有效、1 格式错误、2 文件/JSON/导出错误。
加 `--require-complete` 后，覆盖未完成也返回 1。必须分别读取结果里的 `format_valid` 与 `coverage_complete`；不能用格式 PASS 宣称任务完成。
确认有风险而其他路线未完成时，保留 `risk_found`，同时 `coverage_complete:false`。

## 输入

采集器标准字段（其他 `job`/账号/日期/URL 元数据可保留）：

```json
{
  "schema_version": 1,
  "items": [{
    "source_id": "post-1",
    "post_url": "https://example.com/post/1",
    "title": "视频或笔记标题（可省略）",
    "text": "完整正文",
    "quoted_text": "转发原文（可省略）",
    "text_truncated": false,
    "needs_expansion": false,
    "media": [{"url": "https://example.com/img/1.jpg", "kind": "image"}],
    "media_count": 1
  }],
  "coverage": {
    "collection_complete": true,
    "stop_reason": "visible_endpoint",
    "visible_endpoint_verified": true,
    "observed_count": 1,
    "unresolved": []
  },
  "scope": {},
  "conclusion": "incomplete"
}
```

`source_id` 必须唯一；纯图片帖 `text` 可为空，但 `text_truncated` 必须明确。
若知道媒体未提取全，设置 `media_extraction_complete:false`；知道页面媒体数时保留 `media_count`，不能丢失后假设取全。
`text_truncated`/`needs_expansion` 仍为真时，分批读完现有短文本也不算全文完成。采集器必须准确标注截断，验证器无法猜回从未取得的原文。

有效终点为 `visible_endpoint` / `explicit_no_more` / `public_boundary` / `scope_boundary` / `no_results`。
错误、空响应、限额、取消、静止若干轮不能自行变成完成。`job.state=done` 只表示程序结束，不代替 `coverage`。
用户规定日期范围等采用 `scope_boundary` 时，补充 `scope.boundary:{verified:true,reason:"用户范围及到达依据"}`。

页面累计数大于公开可取得数时，**不强制追平不可枚举累计数**。需要同时说明：

```json
{
  "coverage": {"displayed_count": 3406, "displayed_count_enumerable": false, "stop_reason": "public_boundary"},
  "scope": {"public_boundary": {"verified": true, "reason": "已验证的公开可见边界及差异说明"}}
}
```

这不能用于替连续无新增、错误响应或未经核实的计数差额背书。`collection_complete`、`visible_endpoint_verified`、`observed_count` 等正常字段仍需保留。

## 阅读确认

`create_text_review_manifest(items,max_chars)` 自动生成以下结构；阅读者无需逐条写区间：

```json
{
  "text_snapshot_digest": "自动生成的整批正文指纹",
  "reviewer": "实际阅读者",
  "text_batches": [{"batch_id":"text-0001","reviewed":true,"segments":[{"source_id":"post-1","field":"text","start":0,"end":4}]}],
  "media_reviews": [{"post_source_id":"post-1","url":"https://example.com/img/1.jpg","reviewed":true,"capabilities":["overview"]}],
  "comment_reviews": [],
  "unread_ranges": []
}
```

字符范围左闭右开。漏一个批次或一个边界字符、读到截断输出、正文缓存变动、只做关键词扫描，都不能标全文读完。
非空`title`独立进入批次和指纹，不能只读视频简介而漏标题。无标题或空标题旧缓存保持原指纹，不因本次升级废弃已有实际阅读确认。
`collector` / `auto` / `automatic` 不能作为阅读者自动确认。该字段仍是实际阅读者的确认记录，程序无法证明阅读者是否理解。

图片默认允许拼图 `overview` 批看；已发现疑点的媒体设 `needs_original:true`，需要 `original` 确认。
整个平台图片明确不在授权范围内时才设 `scope.images:"none"`。`original` 同时满足 `overview`。
视频默认按重点范围，不要求全量逐帧：

```json
{
  "scope": {
    "selected_media": [{"post_source_id":"post-1","media_id":"video-1","required":["visual","audio"]}],
    "comments": [{"scope_id":"risk-video-author-comments"}]
  }
}
```

媒体以 `media_id` 或 URL 关联，`required` 能力按用户要求和疑点设置；`visual`、`audio`、`subtitle` 分别确认，准备好快照图不等于已审。
只有明确纳入的评论范围才需要 `comment_reviews`，其中对应 `scope_id` 的 `reviewed`、`complete`、`boundary_verified` 为真且无 `unread_ranges`。
范围本身的终点要按实际可见边界核实，不用无穷追逐全部历史评论。

结论四态为 `no_related_results`（无相关结果）、`checked_no_issue`（有结果且已查无问题）、`risk_found`（有风险）、`incomplete`（尚未完成）。
`no_related_results` 需要成功搜索后明确无结果的依据：`scope.search:{query:"关键词",no_results_verified:true}`，终点为 `no_results` 且没有条目。
失败的 Instagram 搜索和猜测主页的 HTTP 状态不支持“无本人”。

## 离线测试

```powershell
python -m unittest discover -s test/coverage -p "test_*.py" -v
```

反例取自交接包已披露缺口：54/77、55/103 提前停止；只读前95字；IG失败却无主页；分片边界漏字；采集完成误作已读；媒体缺失误作看完。
同时验证不可枚举累计数的公开边界、图片拼图、重点视频、指定评论和已知风险不因其他路线未完成而被抹掉。
