[CmdletBinding()]
param([Parameter(Mandatory=$true)][switch]$ConfirmNewMessagesOnly)
$ErrorActionPreference='Stop'
if (-not $ConfirmNewMessagesOnly) { throw 'Explicit new-messages-only initialization is required.' }
$bridgeRoot=Split-Path -Parent $PSScriptRoot
$stateDir=Join-Path $bridgeRoot 'state'
if (Test-Path -LiteralPath $stateDir) {
 if (@(Get-ChildItem -LiteralPath $stateDir -Force).Count -ne 0) { throw 'State must be empty; this helper never overwrites or migrates history.' }
} else { New-Item -ItemType Directory -Path $stateDir | Out-Null }
$cutoff=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
[ordered]@{acceptNewMessagesFromMs=$cutoff;listenerActivatedAt=[DateTimeOffset]::UtcNow.ToString('o');acceptanceRepliesFromMs=$cutoff;state='stopped';groupRepliesEnabled=$false;acceptanceRepliesEnabled=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir 'runtime.json') -Encoding utf8
[pscustomobject]@{initialized=$true;cutoffMs=$cutoff;listenerStarted=$false;oldBindingsRestored=$false} | ConvertTo-Json
