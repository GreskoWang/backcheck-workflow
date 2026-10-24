# Cross-platform risk scan

Scan a CSV or JSONL export with a UTF-8 newline-delimited keyword file:

```powershell
.\tools\risk_scan\run.ps1 -InputPath .\timeline.csv -Keywords .\keywords.txt -OutputPath .\hits.csv
```
