---
name: source-artifact-stabilizer
description: Stabilize messy source artifacts before analysis, writing, extraction, or delivery. Use when Codex needs to read or normalize files with Windows/PowerShell encoding risk, Chinese paths or column names, Excel/CSV/DOCX/PDF/Markdown sources, game/resource archives, large text dumps, fragile Markdown edits, or DOCX/Excel output QA. Also use when previous attempts hit mojibake, question-mark paths, PowerShell heredoc failures, template/style surprises, file-format uncertainty, or resource-package reverse engineering.
---

## 配置与模板

先在工作区执行 `Setup-Backcheck.ps1`，再加载 `recovery-session-env.ps1`。本机路径与账号配置分别位于 `config/runtime-paths.json` 和 `config/backcheck-local.json`，不得复制另一台机器的凭证或运行状态。跨机器安装步骤见工作区 `docs/INSTALL.md`。

业务与写作方法保留在本 Skill 的 references 中。正式云模板由当前配置的 `template_document_token` 指定，在当前账号下只读核验后使用。`SYNTHETICDOC`、合成主体和内置 fixture 只用于离线回归，不是线上模板或真实调查记录。随包的 DOCX 保留既有版式参考，不代替当前飞书 API 模板核验。

# Source Artifact Stabilizer

## Overview

Use this skill before doing the business analysis when the hard part is making source material reliable. The goal is to convert unpredictable artifacts into auditable intermediate files, avoid Windows encoding traps, make precise edits safely, and verify deliverables before handing them back.

This is not the social-media traversal or coverage-matrix workflow. For platform-by-platform public profile checking, use the background-check skill; use this skill only for the local file and artifact handling underneath.

## Quick Start

1. Inventory the artifacts before interpreting them.
   - Run `scripts/probe_artifact.py` on the source folder or key files.
   - Save probe output into the task's `Process/`, `scratch/`, or working evidence folder when the task is complex.

2. Normalize before analysis.
   - Convert Excel sheets to row-aware CSV/JSON summaries.
   - Convert DOCX/PDF/templates to text plus table/heading structure.
   - Convert binary/resource archives to manifests before extracting content.
   - Keep original files untouched; write intermediates under `Process/`, `scratch/`, or task-local `raw/processed/`.

3. Guard against Windows encoding problems.
   - Do not embed Chinese paths or column names in scripts sent through PowerShell stdin.
   - Prefer script files plus command-line arguments, directory enumeration, or temporary ASCII paths.
   - Use the bundled Python from workspace dependencies if `python` resolves to the Windows Store shim.
   - Read [windows-encoding.md](references/windows-encoding.md) when paths, Chinese text, or shell quoting are involved.

4. Edit and deliver with proof.
   - For Markdown, locate exact anchors before patching long Chinese sections.
   - For DOCX, verify structure and render pages when possible.
   - For Excel, verify row counts, sheet names, truncation, and frozen/header rows when applicable.
   - Read [artifact-workflows.md](references/artifact-workflows.md) for file-type workflows.
   - Read [extraction-and-patching.md](references/extraction-and-patching.md) for fragile patching and resource extraction.

## Workflow

### 1. Build an Artifact Inventory

Create a small manifest before reading deeply:

- Absolute path
- File type and extension
- Size and modified time
- Encoding or binary signature when detectable
- For Excel: sheet names, dimensions, headers
- For DOCX: paragraphs, headings, tables, images
- For Markdown/text: line count, headings, replacement characters
- For directories: extension histogram and representative files

Example:

```powershell
& $bundledPython "$env:BACKCHECK_SKILLS_ROOT\source-artifact-stabilizer\scripts\probe_artifact.py" `
  "O:\project\Resources" `
  --out "O:\project\Process\artifact_probe.json"
```

If bundled paths are unknown, call the workspace dependency tool first and use its Python path.

### 2. Normalize to Intermediates

Do not start the final analysis from raw, fragile artifacts when extraction is nontrivial.

- Excel: create `sheet_manifest.json`, plus CSV/JSONL per relevant sheet when row-level review is needed.
- Word templates: extract heading tree, paragraph text, table cells, style names, and placeholders.
- PDF: extract text for content work and render pages for layout work when available.
- Markdown: preserve exact anchors and line numbers before large replacements.
- Resource archives: create an index of candidate files before decompression or parsing.

### 3. Work Around Encoding and Shell Fragility

Known reliable patterns:

- Write reusable scripts as files, then pass paths as arguments.
- Use PowerShell here-strings only for small ASCII-heavy scripts.
- Use UTF-8 explicit reads/writes.
- Avoid direct `Get-Content` trust for Chinese display; validate bytes or parse with UTF-8.
- If a library breaks on a Chinese path, copy the source to a task-local ASCII temp path, process it, and map results back to the original.

### 4. Patch Precisely

Before editing long Markdown or generated scripts:

- Read the exact local context around the target.
- Use small patches around stable anchors.
- If a patch fails, fetch the exact snippet and retry narrowly.
- Prefer updating the generator script when a file is generated; do not hand-edit generated outputs if the generator will overwrite them.

### 5. Verify Deliverables

Verification must match the artifact:

- DOCX: openability, page count, text presence, table integrity, and page-rendered PNG/PDF when possible.
- Excel: sheet names, row counts, column headers, truncation limits, formulas/table filters if relevant.
- Markdown: target sections present, no replacement-character corruption, links preserved.
- Large extraction: input file count, output row count, checksum or sample decode checks, and known edge cases.

If a visual rendering chain fails because the environment lacks LibreOffice/Word/PDF tools, report that limitation and perform structural QA instead.

## Resources

- `scripts/probe_artifact.py`: lightweight artifact inventory for directories and common source files.
- `references/windows-encoding.md`: Windows/PowerShell/Python encoding patterns and anti-patterns.
- `references/artifact-workflows.md`: practical workflows for Excel, DOCX, PDF, Markdown, and generated deliverables.
- `references/extraction-and-patching.md`: resource-package extraction, Markdown patching, and repeatable generator edits.
