# Dot-source for the local background-check workflow only.
$backcheckRuntime = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config\runtime-paths.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$backcheckLocal = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config\backcheck-local.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($property in $backcheckRuntime.env.PSObject.Properties) { Set-Item -LiteralPath ('Env:' + $property.Name) -Value ([string]$property.Value) }
$env:PATH = (($backcheckRuntime.path_entries + ($env:PATH -split ';') | Select-Object -Unique) -join ';')
$env:FEISHU_APP_ID = $backcheckLocal.app_id
$env:FEISHU_TEMPLATE_DOCUMENT_TOKEN = $backcheckLocal.template_document_token
$env:FEISHU_TARGET_GROUP_INVITE_URL = $backcheckLocal.target_group_invite_url
$env:FEISHU_ACCEPTANCE_REPLIES_ENABLED = ([bool]$backcheckLocal.acceptance_replies_enabled).ToString().ToLowerInvariant()
