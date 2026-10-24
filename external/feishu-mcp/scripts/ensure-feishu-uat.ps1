[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\..\recovery-session-env.ps1')

$modulePath = Join-Path $PSScriptRoot 'uat-recovery.psm1'
$verifyPath = Join-Path $PSScriptRoot 'verify-live.mjs'
$refreshPath = Join-Path $PSScriptRoot 'refresh-feishu-uat.ps1'
Import-Module -Name $modulePath -Force

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$ArgumentList
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $ArgumentList) {
        [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()

    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Output = (($stdoutTask.GetAwaiter().GetResult(), $stderrTask.GetAwaiter().GetResult()) -join "`n").Trim()
    }
}

function Write-RecoveryState {
    param(
        [Parameter(Mandatory)][ValidateSet('READY', 'CODEX_OAUTH_REQUIRED', 'USER_ACTION_REQUIRED', 'TECHNICAL_FAILURE')][string]$Status,
        [Parameter(Mandatory)][string]$Reason,
        [Parameter(Mandatory)][string]$Stage,
        [Parameter(Mandatory)][bool]$UserActionRequired,
        [Parameter(Mandatory)][int]$ExitCode
    )

    [pscustomobject]@{
        status = $Status
        reason = $Reason
        stage = $Stage
        user_action_required = $UserActionRequired
    } | ConvertTo-Json -Compress
    exit $ExitCode
}

function Invoke-Probe {
    param([switch]$WithoutProxy)

    $arguments = @($verifyPath)
    if ($WithoutProxy) {
        $arguments += '--without-proxy'
    }
    return Invoke-CapturedProcess -FilePath 'node' -ArgumentList $arguments
}

$probe = Invoke-Probe
$decision = Resolve-FeishuUatRecoveryDecision -Stage Probe -ExitCode $probe.ExitCode -Output $probe.Output
if ($decision.Action -eq 'RUN_PROBE_WITHOUT_PROXY') {
    $probe = Invoke-Probe -WithoutProxy
    $decision = Resolve-FeishuUatRecoveryDecision -Stage Probe -ExitCode $probe.ExitCode -Output $probe.Output -DirectRetryUsed
}
if ($decision.Action -eq 'READY') {
    Write-RecoveryState -Status READY -Reason $decision.Reason -Stage probe -UserActionRequired $false -ExitCode 0
}
if ($decision.Action -ne 'RUN_REFRESH_WITHOUT_PROXY') {
    Write-RecoveryState -Status TECHNICAL_FAILURE -Reason $decision.Reason -Stage probe -UserActionRequired $false -ExitCode 2
}

$refresh = Invoke-CapturedProcess -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $refreshPath)
$decision = Resolve-FeishuUatRecoveryDecision -Stage Refresh -ExitCode $refresh.ExitCode -Output $refresh.Output

if ($decision.Action -eq 'CODEX_OAUTH_REQUIRED') {
    Write-RecoveryState -Status CODEX_OAUTH_REQUIRED -Reason $decision.Reason -Stage refresh -UserActionRequired $false -ExitCode 4
}
if ($decision.Action -ne 'RUN_POST_PROBE') {
    Write-RecoveryState -Status TECHNICAL_FAILURE -Reason $decision.Reason -Stage refresh -UserActionRequired $false -ExitCode 2
}

$postProbe = Invoke-Probe
$decision = Resolve-FeishuUatRecoveryDecision -Stage PostProbe -ExitCode $postProbe.ExitCode -Output $postProbe.Output
if ($decision.Action -eq 'RUN_PROBE_WITHOUT_PROXY') {
    $postProbe = Invoke-Probe -WithoutProxy
    $decision = Resolve-FeishuUatRecoveryDecision -Stage PostProbe -ExitCode $postProbe.ExitCode -Output $postProbe.Output -DirectRetryUsed
}
if ($decision.Action -eq 'READY') {
    Write-RecoveryState -Status READY -Reason $decision.Reason -Stage post_probe -UserActionRequired $false -ExitCode 0
}

Write-RecoveryState -Status TECHNICAL_FAILURE -Reason $decision.Reason -Stage post_probe -UserActionRequired $false -ExitCode 2
