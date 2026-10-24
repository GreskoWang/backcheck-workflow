[CmdletBinding()]
param([string]$RootPath)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\..\recovery-session-env.ps1')
$bridgeRoot = if ([string]::IsNullOrWhiteSpace($RootPath)) {
    Split-Path -Parent $PSScriptRoot
} else {
    [IO.Path]::GetFullPath($RootPath)
}
if ($bridgeRoot -eq [IO.Path]::GetPathRoot($bridgeRoot)) {
    throw 'Bridge root must name a non-root directory.'
}
. (Join-Path $PSScriptRoot 'bridge-process-identity.ps1')
$stateDir = Join-Path $bridgeRoot 'state'
$logDir = Join-Path $bridgeRoot 'logs'
$pidPath = Join-Path $stateDir 'bridge.pid'
$entry = [IO.Path]::GetFullPath((Join-Path $bridgeRoot 'src\bridge.mjs'))
$lockOwnerPath = Join-Path $stateDir 'bridge.instance.lock\owner.json'

New-Item -ItemType Directory -Path $stateDir, $logDir -Force | Out-Null

$bridgeProcesses = @(Get-BridgeProcessesByEntry -EntryPath $entry)
if ($bridgeProcesses.Count -gt 1) {
    throw 'Multiple live bridge processes use the same entry; refusing to start another.'
}
if (Test-Path -LiteralPath $pidPath) {
    $rawPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($rawPid -notmatch '^\d+$') { throw 'Bridge PID file is invalid.' }
    $existingPid = [int]$rawPid
    $existing = Get-BridgeProcessRecord -ProcessId $existingPid
    $owner = if (Test-Path -LiteralPath $lockOwnerPath) {
        Get-Content -LiteralPath $lockOwnerPath -Raw | ConvertFrom-Json
    } else { $null }
    if ($existing -and $owner -and
        (Test-BridgeLockOwnership -Record $existing -Owner $owner -EntryPath $entry)) {
        if ($bridgeProcesses.Count -ne 1 -or $bridgeProcesses[0].Pid -ne $existingPid) {
            throw 'Bridge process inventory disagrees with the instance lock.'
        }
        Write-Output "ALREADY_RUNNING pid=$existingPid"
        exit 0
    }
    if ($bridgeProcesses.Count -ne 0) {
        throw 'A bridge process is live but PID and lock ownership disagree; refusing duplicate startup.'
    }
    $stateAbsolute = [IO.Path]::GetFullPath($stateDir).TrimEnd('\')
    $pidAbsolute = [IO.Path]::GetFullPath($pidPath)
    $archive = "$pidAbsolute.stale-$(Get-Date -Format 'yyyyMMddHHmmss')-$([guid]::NewGuid().ToString('N'))"
    if (-not $pidAbsolute.StartsWith($stateAbsolute + '\', [StringComparison]::OrdinalIgnoreCase) -or
        -not $archive.StartsWith($stateAbsolute + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Stale PID archive path is outside the bridge state directory.'
    }
    Move-Item -LiteralPath $pidAbsolute -Destination $archive -ErrorAction Stop
    Write-Output 'STALE_PID_ARCHIVED'
} elseif ($bridgeProcesses.Count -ne 0) {
    throw 'A live bridge process has no PID file; refusing duplicate startup.'
}

& node (Join-Path $PSScriptRoot '..\..\..\config\listener-preflight.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Listener prerequisites are incomplete.' }
$node = (Get-Command node -ErrorAction Stop).Source
$stdout = Join-Path $logDir 'process-out.log'
$stderr = Join-Path $logDir 'process-err.log'
$process = Start-Process `
    -FilePath $node `
    -ArgumentList @('"{0}"' -f $entry) `
    -WorkingDirectory $bridgeRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

$confirmed = $false
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    Start-Sleep -Seconds 1
    if ($process.HasExited) { break }
    if (Test-Path -LiteralPath $pidPath) {
        $newPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
        if ($newPid -eq [string]$process.Id -and (Test-Path -LiteralPath $lockOwnerPath)) {
            $newOwner = Get-Content -LiteralPath $lockOwnerPath -Raw | ConvertFrom-Json
            if ([int]$newOwner.pid -eq $process.Id) { $confirmed = $true; break }
        }
    }
}
if ($process.HasExited) {
    throw "Bridge exited during startup (code=$($process.ExitCode)); inspect sanitized runtime status."
}
if (-not $confirmed) { throw "Bridge startup identity was not confirmed for pid=$($process.Id)." }

Write-Output "STARTED pid=$($process.Id)"
if (Test-Path -LiteralPath (Join-Path $stateDir 'runtime.json')) {
    Get-Content -LiteralPath (Join-Path $stateDir 'runtime.json') -Raw
}

