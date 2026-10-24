[CmdletBinding()]
param([string]$RootPath)

$ErrorActionPreference = 'Stop'
$bridgeRoot = if ([string]::IsNullOrWhiteSpace($RootPath)) {
    Split-Path -Parent $PSScriptRoot
} else {
    [IO.Path]::GetFullPath($RootPath)
}
. (Join-Path $PSScriptRoot 'bridge-process-identity.ps1')
$stateDir = Join-Path $bridgeRoot 'state'
$pidPath = Join-Path $stateDir 'bridge.pid'
$lockOwnerPath = Join-Path $stateDir 'bridge.instance.lock\owner.json'
$entryPath = [IO.Path]::GetFullPath((Join-Path $bridgeRoot 'src\bridge.mjs'))
$runtimePath = Join-Path $stateDir 'runtime.json'
$jobsPath = Join-Path $stateDir 'jobs.json'
$outboxPath = Join-Path $stateDir 'reply-outbox.json'
$userAlertBindingPath = Join-Path $stateDir 'user-alert-binding.json'

$bridgePid = $null
$running = $false
$processIdentity = 'missing_pid'
if (Test-Path -LiteralPath $pidPath) {
    $rawPid = (Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8).Trim()
    if ($rawPid -match '^\d+$') {
        $bridgePid = [int]$rawPid
        try {
            $record = Get-BridgeProcessRecord -ProcessId $bridgePid
            if (-not $record) {
                $processIdentity = 'process_missing'
            } elseif (-not (Test-BridgeProcessRecord -Record $record -EntryPath $entryPath)) {
                $processIdentity = 'pid_reused_or_unrelated'
            } elseif (-not (Test-Path -LiteralPath $lockOwnerPath)) {
                $processIdentity = 'lock_missing'
            } else {
                $owner = Get-Content -LiteralPath $lockOwnerPath -Raw | ConvertFrom-Json
                if (Test-BridgeLockOwnership -Record $record -Owner $owner -EntryPath $entryPath) {
                    $running = $true
                    $processIdentity = 'verified'
                } else {
                    $processIdentity = 'lock_mismatch'
                }
            }
        }
        catch {
            $processIdentity = 'unverified'
        }
    } else {
        $processIdentity = 'pid_invalid'
    }
}

$runtime = if (Test-Path -LiteralPath $runtimePath) {
    Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
} else { $null }
$jobs = if (Test-Path -LiteralPath $jobsPath) {
    @(Get-Content -LiteralPath $jobsPath -Raw -Encoding UTF8 | ConvertFrom-Json)
} else { @() }
$outbox = if (Test-Path -LiteralPath $outboxPath) {
    @(Get-Content -LiteralPath $outboxPath -Raw -Encoding UTF8 | ConvertFrom-Json)
} else { @() }
$scheduledTask = Get-ScheduledTask -TaskName 'Codex-Feishu-BackgroundCheck-Bridge' -ErrorAction SilentlyContinue

[pscustomobject]@{
    running = $running
    pid = $bridgePid
    processIdentity = $processIdentity
    connectionState = $runtime.state
    botName = $runtime.botName
    boundChatName = $runtime.boundChatName
    pairingRequired = $runtime.pairingRequired
    pollingState = $runtime.pollingState
    lastPollAt = $runtime.lastPollAt
    lastPollChats = $runtime.lastPollChats
    lastPollMessages = $runtime.lastPollMessages
    pollError = $runtime.pollError
    preflightStatus = $runtime.preflightStatus
    preflightModel = $runtime.preflightModel
    preflightCheckedAt = $runtime.preflightCheckedAt
    preflightError = $runtime.preflightError
    operatorAttentionRequired = [bool]$runtime.operatorAttentionRequired
    lastPreflightFailureRequestId = $runtime.lastPreflightFailureRequestId
    userAlertBindingPresent = Test-Path -LiteralPath $userAlertBindingPath
    lastUserAlertEvent = $runtime.lastUserAlertEvent
    lastUserAlertRequestId = $runtime.lastUserAlertRequestId
    lastUserAlertStatus = $runtime.lastUserAlertStatus
    lastUserAlertAt = $runtime.lastUserAlertAt
    lastUserAlertErrorCode = $runtime.lastUserAlertErrorCode
    pendingReplies = @($outbox | Where-Object status -eq 'pending').Count
    scheduledTaskState = if ($scheduledTask) { [string]$scheduledTask.State } else { 'NotInstalled' }
    queued = @($jobs | Where-Object status -eq 'queued').Count
    runningJobs = @($jobs | Where-Object status -eq 'running').Count
    runningStages = @($jobs | Where-Object status -eq 'running' | ForEach-Object { $_.stage })
    handedOff = @($jobs | Where-Object status -eq 'handed_off').Count
    handedOffRequestIds = @($jobs | Where-Object status -eq 'handed_off' | ForEach-Object { $_.requestId })
    pendingApprovals = @($jobs | Where-Object { $_.status -eq 'running' -and $_.stage -eq 'waiting_for_approval' } | ForEach-Object {
        [pscustomobject]@{
            requestId = $_.requestId
            threadId = $_.codexThreadId
            command = $_.codexCliApprovalReview.command
            target = $_.codexCliApprovalReview.target
            reason = $_.codexCliApprovalReview.reason
            permissionScope = $_.codexCliApprovalReview.permissionScope
            reviewable = $_.codexCliApprovalReview.reviewable
            expiresAt = $_.codexCliApprovalExpiresAt
        }
    })
    recoveryRequired = @($jobs | Where-Object status -eq 'recovery_required').Count
    recoveryRequiredRequestIds = @($jobs | Where-Object status -eq 'recovery_required' | ForEach-Object { $_.requestId })
    paused = @($jobs | Where-Object status -eq 'paused').Count
    pausedRequestIds = @($jobs | Where-Object status -eq 'paused' | ForEach-Object { $_.requestId })
    completed = @($jobs | Where-Object status -eq 'completed').Count
    failed = @($jobs | Where-Object status -eq 'failed').Count
    preflightBlocked = @($jobs | Where-Object { $_.status -eq 'failed' -and $_.stage -eq 'preflight_blocked' } | ForEach-Object {
        [pscustomobject]@{
            requestId = $_.requestId
            failureClass = $_.preflightFailureClass
            recoveryAction = $_.preflightRecoveryAction
        }
    })
} | ConvertTo-Json -Depth 4
