param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $NodeArgs
)

$ErrorActionPreference = 'Stop'

function Test-NodeCandidate {
  param([string] $Candidate)

  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    return $false
  }

  try {
    & $Candidate --version *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

$candidates = New-Object System.Collections.Generic.List[string]

if ($env:CODEX_NODE) {
  $candidates.Add($env:CODEX_NODE)
}
if ($env:NODE_BINARY) {
  $candidates.Add($env:NODE_BINARY)
}

$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (Test-Path -LiteralPath $bundledNode) {
  $candidates.Add($bundledNode)
}

Get-Command node.exe,node -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty Source -Unique |
  ForEach-Object { $candidates.Add($_) }

foreach ($candidate in ($candidates | Select-Object -Unique)) {
  if (Test-NodeCandidate $candidate) {
    & $candidate @NodeArgs
    exit $LASTEXITCODE
  }
}

Write-Error "No usable Node.js runtime found. Install Node.js 22+ or set CODEX_NODE to a working node.exe."
exit 127
