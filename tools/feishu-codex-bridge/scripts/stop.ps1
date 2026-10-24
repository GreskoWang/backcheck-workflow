[CmdletBinding()]
param(
    [ValidateRange(5, 300)]
    [int]$TimeoutSeconds = 30,

    [ValidateRange(1, 30)]
    [int]$RequestTimeoutSeconds = 5,

    [switch]$KeepScheduledTaskEnabled,

    [string]$RootPath,

    [ValidateNotNullOrEmpty()]
    [string]$ScheduledTaskName = 'Codex-Feishu-BackgroundCheck-Bridge'
)

$ErrorActionPreference = 'Stop'
$bridgeRoot = if ([string]::IsNullOrWhiteSpace($RootPath)) {
    Split-Path -Parent $PSScriptRoot
} else {
    [IO.Path]::GetFullPath($RootPath)
}
if ($bridgeRoot -eq [IO.Path]::GetPathRoot($bridgeRoot)) {
    throw 'Bridge root must name a non-root directory.'
}
$stateDir = Join-Path $bridgeRoot 'state'
$pidPath = Join-Path $stateDir 'bridge.pid'
$lockPath = Join-Path $stateDir 'bridge.instance.lock'
$ownerPath = Join-Path $lockPath 'owner.json'
$entryPath = [IO.Path]::GetFullPath((Join-Path $bridgeRoot 'src\bridge.mjs'))
$requestHelper = Join-Path $PSScriptRoot 'request-shutdown.mjs'
$taskName = $ScheduledTaskName

function Get-BridgeProcessInfo {
    param([int]$BridgeProcessId)
    try {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$BridgeProcessId" -ErrorAction Stop
    }
    catch {
        throw "Cannot verify process identity for pid $BridgeProcessId through CIM; refusing to treat it as stopped."
    }
    if (-not $processInfo -and (Get-Process -Id $BridgeProcessId -ErrorAction SilentlyContinue)) {
        throw "CIM did not identify live pid $BridgeProcessId; refusing to treat it as stopped."
    }
    $processInfo
}

function Test-ExactCommandArgument {
    param(
        [string]$CommandLine,
        [string]$ExpectedPath
    )
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    $escapedPath = [regex]::Escape($ExpectedPath)
    $pattern = '(?i)(?:^|\s)(?:"' + $escapedPath + '"|' + $escapedPath + ')(?=\s|$)'
    [regex]::IsMatch($CommandLine, $pattern)
}

function Read-LockOwner {
    param([switch]$AllowMissing)
    if (-not (Test-Path -LiteralPath $ownerPath)) {
        if ($AllowMissing) { return $null }
        throw 'Instance lock owner is missing; refusing to signal a live process.'
    }
    $owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
    $ownerProcessId = [int]$owner.pid
    $ownerToken = [string]$owner.token
    if ($ownerProcessId -le 0 -or [string]::IsNullOrWhiteSpace($ownerToken)) {
        throw 'Instance lock owner is invalid; refusing to stop the bridge.'
    }
    [pscustomobject]@{ ProcessId = $ownerProcessId; Token = $ownerToken }
}

function Assert-BridgeProcessIdentity {
    param(
        [int]$BridgeProcessId,
        [long]$ExpectedCreationTicks = 0
    )
    $currentPidText = if (Test-Path -LiteralPath $pidPath) {
        (Get-Content -LiteralPath $pidPath -Raw).Trim()
    } else { '' }
    if ($currentPidText -ne [string]$BridgeProcessId) {
        throw "PID file changed while stopping; refusing to signal pid $BridgeProcessId."
    }

    $processInfo = Get-BridgeProcessInfo -BridgeProcessId $BridgeProcessId
    if (-not $processInfo) { return $null }
    if (
        [IO.Path]::GetFileName([string]$processInfo.ExecutablePath) -ne 'node.exe' -or
        -not (Test-ExactCommandArgument `
            -CommandLine ([string]$processInfo.CommandLine) `
            -ExpectedPath $entryPath)
    ) {
        throw "PID $BridgeProcessId does not belong to this bridge; refusing to stop it."
    }
    $creationTicks = ([DateTime]$processInfo.CreationDate).ToUniversalTime().Ticks
    if ($ExpectedCreationTicks -gt 0 -and $creationTicks -ne $ExpectedCreationTicks) {
        throw "PID $BridgeProcessId was reused while stopping; refusing to signal it."
    }
    $processInfo
}

function Assert-BridgeOwnership {
    param(
        [int]$BridgeProcessId,
        [string]$ExpectedToken
    )
    $processInfo = Assert-BridgeProcessIdentity -BridgeProcessId $BridgeProcessId
    if (-not $processInfo) { return $null }

    $currentOwner = Read-LockOwner
    if (
        $currentOwner.ProcessId -ne $BridgeProcessId -or
        $currentOwner.Token -ne $ExpectedToken
    ) {
        throw "Instance lock changed while stopping pid $BridgeProcessId; refusing to signal it."
    }
    $processInfo
}

function Assert-LegacyBridgeOwnership {
    param(
        [int]$BridgeProcessId,
        [long]$ExpectedCreationTicks
    )
    $processInfo = Assert-BridgeProcessIdentity `
        -BridgeProcessId $BridgeProcessId `
        -ExpectedCreationTicks $ExpectedCreationTicks
    if (-not $processInfo) { return $null }
    if (Test-Path -LiteralPath $lockPath) {
        throw "An instance lock appeared while stopping legacy pid $BridgeProcessId; refusing to signal it."
    }
    $processInfo
}

function Remove-MatchingPidFile {
    param([int]$BridgeProcessId)
    if (-not (Test-Path -LiteralPath $pidPath)) { return }
    $current = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($current -eq [string]$BridgeProcessId) {
        Remove-Item -LiteralPath $pidPath -Force
    }
}

function Invoke-GracefulShutdownRequest {
    param(
        [string]$NodePath,
        [string]$RequestJson,
        [int]$TimeoutMilliseconds
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $NodePath
    $startInfo.ArgumentList.Add($requestHelper)
    $startInfo.WorkingDirectory = $bridgeRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    # The helper parses UTF-8 JSON. The Windows default can be GB2312, which
    # corrupts a Chinese bridgeRoot and selects a different named pipe.
    $startInfo.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $helperProcess = [Diagnostics.Process]::new()
    $helperProcess.StartInfo = $startInfo
    if (-not $helperProcess.Start()) {
        throw 'Could not start graceful shutdown helper.'
    }
    try {
        $helperProcess.StandardInput.WriteLine($RequestJson)
        $helperProcess.StandardInput.Close()
        if (-not $helperProcess.WaitForExit($TimeoutMilliseconds + 2000)) {
            $helperProcess.Kill($true)
            $helperProcess.WaitForExit()
            return [pscustomobject]@{ Accepted = $false; Detail = 'helper_timeout' }
        }
        $standardOutput = $helperProcess.StandardOutput.ReadToEnd().Trim()
        $standardError = $helperProcess.StandardError.ReadToEnd().Trim()
        [pscustomobject]@{
            Accepted = $helperProcess.ExitCode -eq 0
            Detail = if ($helperProcess.ExitCode -eq 0) { $standardOutput } else { $standardError }
        }
    } finally {
        $helperProcess.Dispose()
    }
}

$scheduledTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$reenableScheduledTask = $false
$disabledScheduledTask = $false
if ($scheduledTask -and $scheduledTask.State -ne 'Disabled') {
    # Disable triggers without terminating the running task instance.
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    $disabledScheduledTask = $true
    $reenableScheduledTask = [bool]$KeepScheduledTaskEnabled
}

try {
    if (-not (Test-Path -LiteralPath $pidPath)) {
        Write-Output 'NOT_RUNNING'
        return
    }

    $pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($pidText -notmatch '^\d+$') {
        throw 'Bridge PID file is invalid; refusing to stop an unknown process.'
    }
    $bridgeProcessId = [int]$pidText
    $processInfo = Get-BridgeProcessInfo -BridgeProcessId $bridgeProcessId
    if (-not $processInfo) {
        Remove-MatchingPidFile -BridgeProcessId $bridgeProcessId
        Write-Output 'NOT_RUNNING_STALE_PID_REMOVED'
        return
    }

    $owner = Read-LockOwner -AllowMissing
    $legacyCreationTicks = 0
    if ($owner) {
        if ($owner.ProcessId -ne $bridgeProcessId) {
            throw "PID file and instance lock disagree; refusing to stop pid $bridgeProcessId."
        }
        $null = Assert-BridgeOwnership -BridgeProcessId $bridgeProcessId -ExpectedToken $owner.Token
    } else {
        if (Test-Path -LiteralPath $lockPath) {
            throw 'Instance lock is present without a valid owner; refusing to stop a live process.'
        }
        $processInfo = Assert-BridgeProcessIdentity -BridgeProcessId $bridgeProcessId
        if (-not $processInfo) {
            Remove-MatchingPidFile -BridgeProcessId $bridgeProcessId
            Write-Output "STOPPED_DURING_VALIDATION pid=$bridgeProcessId"
            return
        }
        $legacyCreationTicks = ([DateTime]$processInfo.CreationDate).ToUniversalTime().Ticks
    }

    $requestAccepted = $false
    if ($owner) {
        $nodePath = (Get-Command node -ErrorAction Stop).Source
        if (-not (Test-Path -LiteralPath $requestHelper)) {
            throw "Graceful shutdown helper is missing: $requestHelper"
        }
        $request = @{
            bridgeRoot = $bridgeRoot
            pid = $bridgeProcessId
            token = $owner.Token
            timeoutMs = $RequestTimeoutSeconds * 1000
        } | ConvertTo-Json -Compress

        $requestResult = Invoke-GracefulShutdownRequest `
            -NodePath $nodePath `
            -RequestJson $request `
            -TimeoutMilliseconds ($RequestTimeoutSeconds * 1000)
        $requestAccepted = $requestResult.Accepted
        if ($requestAccepted) {
            Write-Verbose "Graceful shutdown accepted for pid $bridgeProcessId."
        } else {
            Write-Verbose "Graceful shutdown channel unavailable for pid ${bridgeProcessId}: $($requestResult.Detail)"
        }
    } else {
        Write-Verbose "Legacy bridge pid $bridgeProcessId predates the control channel and instance lock."
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Get-BridgeProcessInfo -BridgeProcessId $bridgeProcessId)) { break }
        Start-Sleep -Milliseconds 250
    }

    if (-not (Get-BridgeProcessInfo -BridgeProcessId $bridgeProcessId)) {
        Remove-MatchingPidFile -BridgeProcessId $bridgeProcessId
        $mode = if ($requestAccepted) { 'STOPPED_GRACEFULLY' } else { 'STOPPED_DURING_WAIT' }
        Write-Output "$mode pid=$bridgeProcessId"
        return
    }

    # Re-read all ownership anchors immediately before the forced fallback.
    if ($owner) {
        $null = Assert-BridgeOwnership -BridgeProcessId $bridgeProcessId -ExpectedToken $owner.Token
    } else {
        $null = Assert-LegacyBridgeOwnership `
            -BridgeProcessId $bridgeProcessId `
            -ExpectedCreationTicks $legacyCreationTicks
    }
    Stop-Process -Id $bridgeProcessId -Force -ErrorAction Stop
    $forcedDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while (
        [DateTime]::UtcNow -lt $forcedDeadline -and
        (Get-BridgeProcessInfo -BridgeProcessId $bridgeProcessId)
    ) {
        Start-Sleep -Milliseconds 100
    }
    if (Get-BridgeProcessInfo -BridgeProcessId $bridgeProcessId) {
        throw "Bridge pid $bridgeProcessId remained alive after forced termination."
    }
    Remove-MatchingPidFile -BridgeProcessId $bridgeProcessId
    Write-Output "STOPPED_FORCED_AFTER_TIMEOUT pid=$bridgeProcessId"
} catch {
    # A denied identity check or other failed stop must not leave an originally
    # enabled watchdog disabled.
    if ($disabledScheduledTask) {
        Enable-ScheduledTask -TaskName $taskName | Out-Null
        $disabledScheduledTask = $false
        $reenableScheduledTask = $false
    }
    throw
} finally {
    if ($reenableScheduledTask) {
        Enable-ScheduledTask -TaskName $taskName | Out-Null
    }
}
