param([Parameter(Mandatory=$true)][string]$InputPath,[Parameter(Mandatory=$true)][string]$Keywords,[Parameter(Mandatory=$true)][string]$OutputPath)
$py = if ($env:CODEX_PYTHON) { $env:CODEX_PYTHON } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' }
& $py (Join-Path $PSScriptRoot 'risk_text_scan.py') --input $InputPath --terms $Keywords --out-csv $OutputPath
