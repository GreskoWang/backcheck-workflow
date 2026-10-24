# Artifact Workflows

## Excel And CSV

Start by extracting a sheet manifest:

- workbook path
- sheet names
- dimensions
- header rows
- likely ID columns
- blank/merged/header-only regions

For analysis, create per-sheet CSV or JSONL only for relevant sheets. Preserve row numbers so findings can be traced back. For large output workbooks, verify:

- sheet names
- row counts
- column counts
- header values
- Excel's 32,767-character cell limit
- frozen panes or filters when requested

## DOCX And Word Templates

For templates, inspect before writing:

- heading text and style names
- table count and table headers
- placeholder phrases such as "填写", "插入案例", "TODO"
- page orientation needs for wide tables

When generating DOCX, prefer deterministic scripts. After generation:

1. Verify the document opens or can be parsed.
2. Verify required text appears.
3. Verify tables have the expected rows/cells.
4. Render pages to PNG/PDF when available.
5. If rendering fails because the environment lacks LibreOffice, Word export, or PDF rasterization tools, report the exact missing link and perform structural QA.

## PDF

Use text extraction for content analysis and page rendering for layout QA. Treat them as different checks:

- Text extraction proves the content exists.
- Page rendering proves the user-facing layout is readable.

If a PDF viewer screenshot is blank or grey, do not count it as visual QA. Use a PDF rasterizer such as PDFium/PyMuPDF/Poppler if available, or state the limitation.

## Markdown

Before replacing sections:

- Identify stable headings or marker text.
- Capture exact local context around the target.
- Patch the smallest possible region.
- Re-run section presence checks and replacement-character checks.

For generated Markdown, update the generator script and rerun instead of editing the output by hand.

## Deliverable QA Summary

A good final note should say what was verified and what could not be verified:

- "DOCX opens and paginates; table structure validated; visual PNG rendering unavailable because ..."
- "Workbook has N rows and M sheets; no cell truncation detected."
- "Markdown section count and required headings verified; no U+FFFD replacement characters."
