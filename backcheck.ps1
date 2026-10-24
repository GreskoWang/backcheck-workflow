[CmdletBinding()]
param(
    [ValidateSet('Status','Credentials','Login','CheckFeishu','BindGroup','Start','Stop','InstallAutostart')]
    [string]$Action = 'Status',
    [string]$ChatId
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'recovery-session-env.ps1')
$localPath = Join-Path $PSScriptRoot 'config\backcheck-local.json'
$localConfig = Get-Content -LiteralPath $localPath -Raw | ConvertFrom-Json
$bridgePath = Join-Path $PSScriptRoot 'tools\feishu-codex-bridge'
$pwshPath = (Get-Command pwsh -ErrorAction Stop).Source
$nodePath = (Get-Command node -ErrorAction Stop).Source
function Save-LocalConfig {
    $json = $localConfig | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($localPath, $json + "`n", [Text.UTF8Encoding]::new($false))
}
switch ($Action) {
    'Status' {
        [ordered]@{
            workspace = $PSScriptRoot
            active_codex_home = $env:CODEX_HOME
            python = $env:RESEARCH_PYTHON
            node = $nodePath
            app_id = $localConfig.app_id
            credentials_present = (Test-Path -LiteralPath (Join-Path $env:FEISHU_CREDENTIAL_DIR 'credentials.json'))
            oauth_storage_present = (Test-Path -LiteralPath (Join-Path $env:FEISHU_LOCALAPPDATA 'lark-mcp-nodejs\Data\storage.json'))
            template_read_verified = $localConfig.template_read_verified
            target_chat_bound = (-not [string]::IsNullOrWhiteSpace($localConfig.target_chat_id))
            listener_enabled = $localConfig.listener_enabled
            accounting_enabled = $localConfig.accounting.enabled
        } | ConvertTo-Json
    }
    'Credentials' {
        & $pwshPath -NoProfile -ExecutionPolicy Bypass -File (Join-Path $env:FEISHU_MCP_ROOT 'scripts\configure-credentials.ps1') -AppId $localConfig.app_id
        exit $LASTEXITCODE
    }
    'Login' {
        & $pwshPath -NoProfile -ExecutionPolicy Bypass -File (Join-Path $env:FEISHU_MCP_ROOT 'scripts\login-feishu.ps1')
        exit $LASTEXITCODE
    }
    'CheckFeishu' {
        & $nodePath (Join-Path $PSScriptRoot 'config\feishu-readiness.mjs')
        exit $LASTEXITCODE
    }
    'BindGroup' {
        if ($ChatId -notmatch '^oc_[A-Za-z0-9]+$') { throw 'Provide the real oc_ chat ID from CheckFeishu. An invite link is not a chat ID.' }
        & $nodePath (Join-Path $PSScriptRoot 'config\feishu-readiness.mjs') --bind $ChatId
        exit $LASTEXITCODE
    }
    'Start' {
        if ([string]::IsNullOrWhiteSpace($localConfig.target_chat_id) -or -not $localConfig.template_read_verified) {
            throw 'Run CheckFeishu and BindGroup before starting.'
        }
        $statePath = Join-Path $bridgePath 'state'
        $runtimePath = Join-Path $statePath 'runtime.json'
        # Binding may already exist. Initialize only fresh activation metadata;
        # never reset a previous cutoff or revive historical jobs.
        if (-not (Test-Path -LiteralPath $runtimePath)) {
            foreach ($name in @('jobs.json','seen-message-ids.json','reply-outbox.json')) {
                if (Test-Path -LiteralPath (Join-Path $statePath $name)) { throw 'Unexpected historical state; inspect before activating.' }
            }
            New-Item -ItemType Directory -Path $statePath -Force | Out-Null
            $cutoff = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            $runtime = [ordered]@{acceptNewMessagesFromMs=$cutoff;acceptanceRepliesFromMs=$cutoff;listenerActivatedAt=[DateTimeOffset]::UtcNow.ToString('o');state='stopped';groupRepliesEnabled=$false;acceptanceRepliesEnabled=$false}
            [IO.File]::WriteAllText($runtimePath, ($runtime | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        }
        $localConfig.listener_enabled = $true
        Save-LocalConfig
        & $pwshPath -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bridgePath 'scripts\start.ps1')
        if ($LASTEXITCODE -ne 0) { $localConfig.listener_enabled = $false; Save-LocalConfig; exit $LASTEXITCODE }
    }
    'Stop' {
        $localConfig.listener_enabled = $false
        Save-LocalConfig
        & $pwshPath -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bridgePath 'scripts\stop.ps1')
        exit $LASTEXITCODE
    }
    'InstallAutostart' {
        if (-not $localConfig.listener_enabled) { throw 'Start and verify the listener before installing autostart.' }
        & $pwshPath -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bridgePath 'scripts\install-autostart.ps1')
        exit $LASTEXITCODE
    }
}
