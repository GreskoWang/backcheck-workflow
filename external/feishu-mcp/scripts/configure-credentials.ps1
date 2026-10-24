[CmdletBinding()]
param(
    [string]$AppId = ''
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\..\..\recovery-session-env.ps1")
if (!$AppId) { $AppId = $env:FEISHU_APP_ID }
if ($AppId -ne $env:FEISHU_APP_ID -or $AppId -notmatch "^cli_[a-z0-9]+$") { throw "App ID must match the local configuration." }
$credentialDir = $env:FEISHU_CREDENTIAL_DIR
$credentialPath = Join-Path $credentialDir "credentials.json"

New-Item -ItemType Directory -Path $credentialDir -Force | Out-Null

$secret = Read-Host "请输入飞书 App Secret（输入不会显示）" -AsSecureString
if ($secret.Length -eq 0) {
    throw "App Secret 不能为空。"
}

$payload = [ordered]@{
    app_id = $AppId
    app_secret_protected = ConvertFrom-SecureString $secret
    created_at = [DateTimeOffset]::Now.ToString("o")
}

$json = $payload | ConvertTo-Json
[System.IO.File]::WriteAllText($credentialPath, $json, [System.Text.UTF8Encoding]::new($false))

Write-Host "凭证已使用当前 Windows 账户的 DPAPI 加密保存：$credentialPath"
Write-Host "源码和 Codex MCP 配置中不会保存明文 App Secret。"

