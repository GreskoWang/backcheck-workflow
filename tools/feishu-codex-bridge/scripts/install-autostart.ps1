[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\..\recovery-session-env.ps1')
& node (Join-Path $PSScriptRoot '..\..\..\config\listener-preflight.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Listener prerequisites are incomplete.' }
$taskName = 'Codex-Feishu-BackgroundCheck-Bridge'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $bridgeRoot 'src\bridge.mjs'
$node = (Get-Command node -ErrorAction Stop).Source

# Stop the old definition before replacing it so an active bridge can close its
# ConPTY and release its instance lock itself.
& (Join-Path $PSScriptRoot 'stop.ps1') | Out-Null

$pythonw = Join-Path (Split-Path -Parent $env:RESEARCH_PYTHON) 'pythonw.exe'
$launcher = Join-Path $PSScriptRoot 'launch-bridge-no-console.pyw'
if (-not (Test-Path -LiteralPath $pythonw -PathType Leaf)) { throw 'GUI Python runtime is unavailable; refusing a console-launching fallback.' }
$action = New-ScheduledTaskAction -Execute $pythonw -Argument ('"{0}" "{1}" "{2}"' -f $launcher, $node, $entry) -WorkingDirectory $bridgeRoot
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdogTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Principal $principal -Action $action -Trigger @($logonTrigger, $watchdogTrigger) -Settings $settings -Description 'Receives scoped Feishu background-check requests and runs local Codex.' -Force | Out-Null
Enable-ScheduledTask -TaskName $taskName | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 4

$pidPath = Join-Path $bridgeRoot 'state\bridge.pid'
$bridgePid = if (Test-Path -LiteralPath $pidPath) {
    [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
} else { $null }
$process = if ($bridgePid) { Get-Process -Id $bridgePid -ErrorAction SilentlyContinue } else { $null }
if (-not $process) {
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    $logPath = Join-Path $bridgeRoot 'logs\bridge.log'
    $detail = if (Test-Path -LiteralPath $logPath) { (Get-Content -LiteralPath $logPath -Tail 15) -join "`n" } else { '' }
    throw "Scheduled bridge did not start. LastTaskResult=$($info.LastTaskResult). $detail"
}

Write-Output "INSTALLED_AND_STARTED task=$taskName pid=$bridgePid"

