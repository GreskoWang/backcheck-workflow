# 本地媒体批读准备

复用交接包的等比缩略、网格批读和 videoshot 裁帧思路；不执行原包下载脚本。仅用已存在的 Python 与 Pillow。`media.py` **不访问网络、不下载、不执行清单中的代码、不覆盖已有目录**；可选上游 `fetch_assets.py` 仅下载清单里的公开图片，再交本地批读。

入口：`media.py sheet`（配图／封面墙／头像）与 `media.py videoshot`（已有雪碧图按元数据裁帧）。清单必须是 UTF-8 JSON，`schema_version` 为 `1`，`items` 非空。相对文件路径相对于清单目录解析。URL 和 UNC 路径不能作为本地文件输入。

## 从采集缓存直接导出

```powershell
$taskDir = Join-Path $env:BACKGROUND_CHECK_WORKSPACE '任务'
$python = $env:RESEARCH_PYTHON
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\media\export_manifest.py" "$taskDir\batch\result.json" "$taskDir\NEW-media.json"
```

自动读取标准 `result.items[].media[]`，保留“唯一媒体项→原媒体 ID→正文 ID→账号／原帖／日期”；跨帖同 URL 保留各自归因。image／photo／cover／thumbnail／video-poster可进入图片下载，video保留需播放核查的失败占位。明确非媒体类型在内嵌 `export_report` 按原因计数；类型未知或仍标候选／归属未核的媒体保留显式候选占位，不猜测过滤。已知媒体缺数、占位、未展开图集保留显式失败项，不能导出成空缺并假装看完。

签名／认证 URL 不写入新文件，不清洗后重试；URL形来源 ID、原帖及原媒体 ID 同样检查，必要时用稳定 hash 引用替代，绝不从旁路元数据写回原参数。未取得账号／日期显示“未取得…”，`source_metadata` 保留 null，不猜归因。导出不新增审阅。原 `result.json` 不变，输出文件必须不存在。

媒体项的 `candidate`、`attribution_verified`、`review_state`、`review_status` 及显式 `reviewed`／画面／音频／字幕／动作／评论布尔状态，贯穿导出、下载索引、本地manifest、编图JSON与CSV索引。未提供或类型不合法的归属状态默认为候选／未核；只有源记录已明确确认的状态才保留为真，不因成功下载或编图升级。格子标“候选/归属待核”，并保留失败项的同类状态。不能按URL里出现emoji/defaulticon等字样猜它已属于主体或直接丢弃。源记录已有审阅状态可保留，但本次准备步骤的summary仍是未审阅、覆盖未完成。

退出码 0=正常导出（包括纯文字或全部非媒体过滤），2=含明确失败占位但清单可继续消费，1=致命格式/输出错误。`export_report.empty_media_manifest:true` 且 `preparation_action:skip_fetch_and_sheet` 时直接跳过下载与编图；不能把空媒体清单当成背调受阻。其他清单可直接传给 `fetch_assets.py`，预声明失败项零请求并保留失败码，再传给 `media.py sheet` 占格。导出报告内的过滤数和失败数不代表完整媒体已审。

## 可选上游：公开图片下载

`fetch_assets.py` 使用相同来源字段，把图片项的 `local_path` 换成 `url`。可选 `referer` 仅接受公开 HTTP(S) 地址，不读取浏览器配置、Cookie、令牌或存储，不添加认证处理器，也不更改代理或 TLS 校验。URL userinfo、已知认证／签名参数、本地地址、非 HTTP(S) 与 HTTPS 降级跳转均拒绝；需要登录或签名授权的图片交回已有授权浏览器路线，不能自动放宽限制。可用的普通尺寸参数（例如 `w=400`）原样用于请求。

```json
{
  "schema_version": 1,
  "items": [{
    "source_id": "public-image-1",
    "post_source_id": "public-post-1",
    "account": "已确认账号",
    "post_url": "https://example.org/post/1",
    "date": "2026-10-14",
    "url": "https://images.example.org/1.jpg",
    "referer": "https://example.org/post/1"
  }]
}
```

```powershell
$python = $env:RESEARCH_PYTHON
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\media\fetch_assets.py" "$taskDir\remote-media.json" "$taskDir\素材01"
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\media\media.py" sheet "$taskDir\素材01\local-manifest.json" "$taskDir\配图批读01"
```

默认最多 3 个并发，每项只作一次下载尝试，**不重试**；允许最多 5 次安全重定向，请求数包含实际发起的跳转尝试。每项默认 20 秒、10 MiB、4000万像素上限；可调 `--concurrency 1..3`、`--timeout`（不超过120秒）、`--max-bytes`（不超过50MiB）。首次返回 429 后，停止该批次对同一 host 的新请求，待处理项明确标为 `not_downloaded`；已在途项按实际结果记录，其他 host 继续。不会通过切代理、改认证或无限等待恢复。

只有 PNG／JPEG／GIF／WebP／AVIF 的 Content-Type、实际文件签名及 Pillow 完整解码一致才保存。AVIF 要求完整、长度对齐的首个32位 `ftyp` box在major或compatible品牌字段中明确含 `avif`／`avis`；不把minor字段或box外字样当签名，其他box编码仍按不支持处理。输出新的 `assets/`、`local-manifest.json`、`download-index.json`、UTF-8 BOM CSV、`summary.json`。每个来源项都有结果，失败项 `local_path:null`，可直接交给 `media.py sheet` 继续生成失败占格；不会因一张坏图丢掉后面图片。输出目录必须不存在；退出码 0=全部准备、2=部分失败、1=致命输入/输出错误。下载成功依然 `not_reviewed`、`coverage_complete:false`。

初版仅用可注入模拟 transport 验证，无真实站点访问；不据此宣称登录态兼容或端到端覆盖已验证。运行真实下载前，应由正常任务的既有授权与来源边界确定清单。

2026-10-15 AVIF增量验收：现有Pillow12.3.0原生解码器可用，下载器20项离线回归通过，包含本地生成有效AVIF、伪MP4／HEIC、截断ftyp、截断帧、MIME和体积／像素边界。已有任务缓存中的一条公开B站AVIF原URL已作真实1次GET（0重试），`image/avif`、签名和264×264解码一致，sheet实际目视成功。该结果只证明这一公开原URL链路，不证明所有AVIF或登录态资源可下载；未改写CDN地址、安装依赖或重载浏览器服务。

```powershell
$python = $env:RESEARCH_PYTHON
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\media\media.py" sheet "$taskDir\media.json" "$taskDir\配图批读01"
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\media\media.py" videoshot "$taskDir\videoshot.json" "$taskDir\视频采样01" --cols 3 --rows 4
```

输出父目录必须已存在，目标目录必须不存在；成功后整个结果目录原子改名提交。出现致命错误时，自己的 `.目标名.pending-*` 诊断目录保留，位置写在错误中。不会清理用户文件。

## 图片清单

```json
{
  "schema_version": 1,
  "items": [
    {
      "source_id": "weibo-123-image-1",
      "post_source_id": "weibo-123",
      "account": "已确认账号",
      "post_url": "https://example.org/post/123",
      "date": "2026-10-14",
      "local_path": "images/123-1.jpg",
      "media_kind": "post_image",
      "label": "配图 1/3"
    }
  ]
}
```

`source_id` 是每个媒体项的唯一 ID，不能重复；`post_source_id` 可选，用于连接正文项。`account`、`post_url`、`date` 必填并原样保留；未知日期应由上游明确标注，不由工具猜测。`label`、`media_kind` 可选。图片缩略保持比例，小图不放大，不把封面墙成功当作视频已播放。动画图片仅生成第一帧，`animated_frames` 提示原文件还有其他帧。

## videoshot 清单

每项必须有 `metadata` 或 `metadata_path` 二选一，以及 `sprite_paths` 数组。支持直接元数据或 `{ "code": 0, "data": { ... } }` 的接口响应。文件由上游按现有授权方式取得，本工具不请求接口。

```json
{
  "schema_version": 1,
  "items": [
    {
      "source_id": "bilibili-BVexample-video",
      "post_source_id": "bilibili-BVexample",
      "account": "已确认账号",
      "post_url": "https://www.bilibili.com/video/BVexample",
      "date": "2026-10-14",
      "metadata": {
        "img_x_len": 2,
        "img_y_len": 2,
        "img_x_size": 480,
        "img_y_size": 270,
        "image": ["https://example.org/sprite0.jpg", "https://example.org/sprite1.jpg"],
        "index": [0, 5, 10, 15, 20, 25]
      },
      "sprite_paths": ["sprites/0.jpg", "sprites/1.jpg"]
    }
  ]
}
```

`sprite_paths` 与 `metadata.image` 保持同一顺序。以 `metadata.index` 的每个元素为一帧的实际秒数，按每张图 `img_x_len × img_y_len` 个格子依次定位。没有 `index` 或时间戳不合法时报告失败，**不按时长估造间隔，不按亮度删除黑帧**。`metadata.index` 之外的雪碧图余格只计为 `unused_supplied_cell_count`，不冒充有时间戳的有效帧。

每帧派生 `source_id = 视频媒体ID::frame:六位索引`，原视频媒体 ID 保留为 `video_source_id`。保留 `post_source_id`、`metadata_index`（从 0 开始）、原 `metadata_timestamp`、`frame_timestamp`、`frame_timestamp_unit: seconds`、雪碧图序号／行／列、裁切框。缺少／损坏雪碧图以及裁框超出实际图片时，每个受影响时间戳都有失败项和可见失败格。

## 输出契约和阅读边界

- `sheet_0001.jpg` 等：分页接触图。默认 4 列 × 4 行，每格 360×260，加可读标签；页面限制 2000×2400，超过就报错，调整行列数或分批，不能静默缩成整墙。
- `index.json`：完整来源映射、每项状态、页码／格号、原尺寸和显示尺寸、错误、视频元数据映射。标签过长会显式标 `display_label_truncated`，完整值始终保留。
- `index.csv`：UTF-8 BOM，方便 Windows Excel 打开；失败项同样占行。
- `summary.json`：只记录准备状态、成功／失败数量和分页数量。始终为 `review_status: not_reviewed`、`coverage_complete: false`。
- `frames/*.png`：仅 videoshot 输出的时间戳采样帧，按原元数据裁出，不压缩成新视频。

退出码：`0` 全部输入已准备；`2` 有部分输入失败但已完整映射，继续读可用项并处理失败项；`1` 清单／布局／输出位置等致命错误。错误不会使其他正常媒体静默丢失。

生成成功不表示已经阅读。拼图不能确认账号归属，头像相同仍需独立共享锚点；小字、细节、疑点回原图。**视频采样不替代连续动作、音频、字幕、本人评论及重点视频播放核查。**最终审阅者需在任务既有进度中记录实际读过哪些项，不能把本工具输出的准备状态改写为平台完成。

## 验证

```powershell
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\test\media\test_media.py"
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\test\media\test_fetch_assets.py"
& $python -X utf8 "$env:BACKGROUND_CHECK_WORKSPACE\tools\research-batch\test\media\test_export_manifest.py"
```

离线测试覆盖来源对应、缺文件与损坏图、失败占格、分页、小图不放大／大图不失真、Unicode 路径、禁止远程文件、输出保护、布局上限、视频跨雪碧图边界、真实时间戳、黑帧保留、越界、缺元数据和单视频失败隔离。不依赖实际账号或登录态；不据此宣称实际平台端到端时长或覆盖率。

下载器测试只使用模拟 transport，覆盖来源映射及与 sheet 实际衔接、真实图片签名和类型、损坏响应、字节／像素限制、凭据 URL 拒绝与日志脱敏、429停 host、并发上限、零重试、跳转检查、输出保护及失败占位。
