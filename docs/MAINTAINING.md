# 共同维护风险库和复现包

从最新 `main` 新建分支，再修改共享文件。提交前先确认远端是否有其他维护者的新变更，合并后重新检查，不用旧副本覆盖他人的风险条目。

## 风险库

`背调风险提示.md` 是当前工具读取的业务规则文件，`背调风险提示.xlsx` 是随包保留的表格资料，`模板.docx` 是版式参考。修改规则应注明适用范围、判断依据和可回查的来源，避免把作品关联条件写成人物本人的观点或行为。

现有工具不会自动将 Markdown 和 Excel 双向同步。更新时在提交说明中写清改动了哪份资料，以及是否需要同步另一份，不把未同步的表格称为最新规则。仅维护规则内容时，不需要启动浏览器、群监听或重新执行历史调查。

## 路径和本机数据

仓库内使用相对路径、环境变量或明确标注的 `<WORKSPACE>` 示例。脚本根据自身位置、`BACKGROUND_CHECK_WORKSPACE`、系统环境或显式参数解析路径。JSON 示例里的占位符需要由调用方替换，验证器要求真实绝对路径的运行契约保持不变。

每个使用者运行安装入口后，会在自己的目录生成 `config/runtime-paths.json`、`config/backcheck-local.json` 和 `.local/`。这些文件、账号凭证、研究缓存、断点、日志和本机校验回执不得提交。无问题材料仍不逐帖存档，必要缓存和风险证据留在各自的工作目录。

测试中的路径由临时目录或明确标注的合成路径生成，不包含维护者的目录。跨系统测试仍覆盖 Windows 分隔符、中文和空格。标准 `env` shebang、网站 URL 和平台路由不属于维护者的本地目录。

## 提交前检查

在仓库根目录使用 Python 3.10 或更高版本执行：

```powershell
python -X utf8 scripts/check_portability.py
python -X utf8 -m unittest discover -s scripts -p test_package.py
python -X utf8 scripts/package.py --write
python -X utf8 scripts/package.py
git diff --stat
```

先检查路径，再根据最终文件字节更新 `package-manifest.json`，将它和此次修改一起提交。清单也覆盖新增和删除的文件，不能只更新风险条目而保留旧哈希。如果删除受 Git 跟踪的文件，先用 `git rm` 记录删除。编辑代码时，还应按 [安装与验收](INSTALL.md) 运行相应回归组。

GitHub 的 `Portable package` 工作流会在 Windows 和 Linux 上检查路径、被误提交的本机状态、Office XML/关系中的文件链接，以及清单的一致性。检查只用标准库，不使用账号或真实业务环境。仓库是否要求检查通过后才能合并，由维护者的分支规则决定。

保留 `.gitattributes` 的字节保持设置。上传工具应使用原始字节或 base64 创建 Git blob，避免字符串序列化改变换行。发布后核对远端文件的 Git blob SHA 与本地一致，再运行包校验，不能只验证上传前的副本。
