# Extraction And Patching Patterns

## Large Resource Extraction

Use a staged approach:

1. Locate installed/source directories and candidate archives.
2. Build a manifest of archive members or resource files before extracting.
3. Probe one small representative file.
4. Decode edge cases before batch extraction.
5. Batch extract into normalized JSON/CSV.
6. Build final Excel/Markdown only after counts and sample decodes look sane.

Useful checks:

- expected language/file count
- duplicate IDs
- decoded sample text for non-Latin languages
- row counts before and after language merge
- max cell length before writing Excel

If decoding is uncertain, record the hypothesis and verify with known strings or side-by-side samples.

## Markdown Patch Recovery

When `apply_patch` fails:

- Do not widen the patch immediately.
- Re-read the exact target lines.
- Patch one stable paragraph or heading at a time.
- Avoid matching on URLs or long wrapped paragraphs unless necessary.
- If generated output keeps changing, patch the generator instead.

## Generator-First Edits

If a directory contains scripts that generate `Results/` or reports:

1. Identify whether the target file is generated.
2. Update the generator script.
3. Rerun the generator.
4. Validate the result.
5. Keep archived source material intact unless the user asks to delete it.

## Evidence Intermediates

For repeatable work, save:

- `artifact_probe.json`
- `sheet_manifest.json`
- `docx_structure.json`
- `resource_index.json`
- `extraction_summary.json`
- `qa_report.md`

These files are not the final deliverable, but they prevent re-discovering the same format details in later turns.
