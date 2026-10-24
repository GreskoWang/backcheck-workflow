[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "common.ps1")

$credential = Get-FeishuCredential
try {
    $payload = [ordered]@{
        app_id = $credential.AppId
        app_secret = $credential.AppSecret
    } | ConvertTo-Json -Compress

    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::Out.Write($payload)
}
finally {
    $payload = $null
    $credential.AppSecret = $null
}
