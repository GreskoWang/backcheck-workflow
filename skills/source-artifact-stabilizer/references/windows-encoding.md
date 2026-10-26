# Windows Encoding And Path Rules

Use this reference when paths, Chinese text, Excel column names, or shell quoting are involved.

## Failure Patterns

- `python` resolves to `WindowsApps\python.exe` and exits without running real code.
- PowerShell sends Chinese source text through stdin using the console code page, turning paths or column names into `?`.
- Bash heredocs such as `python - <<'PY'` are used in PowerShell and fail.
- Direct terminal display looks garbled even though the file bytes are valid UTF-8.
- A library can read the file content but fails when the path itself contains non-ASCII characters.

## Reliable Patterns

- Use bundled Python when available:

```powershell
& "$env:RESEARCH_PYTHON" script.py --input "$env:BACKGROUND_CHECK_WORKSPACE\含中文\file.xlsx"
```

- Write script files and pass values through `argv`, not through stdin source code.
- Enumerate files by extension from a known working directory instead of hard-coding Chinese filenames inside inline scripts.
- Use `-LiteralPath` in PowerShell for exact Windows paths.
- Use `Get-Content -Encoding UTF8` only for inspection; do not trust console display as proof that file bytes are broken.
- Use `utf-8-sig` for CSV/JSON that may contain a BOM.
- Use Unicode escapes for short Chinese search strings inside inline scripts if unavoidable.
- Copy to a task-local ASCII temp path only when a tool cannot handle the original path. Keep the original untouched and record the mapping.

## Anti-Patterns

- Do not pass Chinese paths or Chinese column names inside a `@' ... '@ | python -` script body.
- Do not infer file corruption from PowerShell mojibake alone.
- Do not repeatedly change encodings on the original file to "fix" display.
- Do not mix shell dialects. In PowerShell, use PowerShell here-strings or script files, not Bash heredocs.

## Minimal Diagnostic

1. Check which Python will run.
2. Check whether the path exists with `Test-Path -LiteralPath`.
3. Read bytes or parse the file with explicit UTF-8.
4. If only console display is garbled, continue; if parsed strings contain U+FFFD or literal `?` where Chinese should be, switch to argv/script-file patterns.
