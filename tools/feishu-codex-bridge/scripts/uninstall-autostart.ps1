[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskName = 'Codex-Feishu-BackgroundCheck-Bridge'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
& (Join-Path $PSScriptRoot 'stop.ps1') | Out-Null
if ($task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "REMOVED task=$taskName"
} else {
    Write-Output 'NOT_INSTALLED'
}
