#requires -Version 7.2
[CmdletBinding()]
param(
  [string]$NodePath,
  [string]$PythonPath,
  [string]$CodexHomePath = $(if ($env:CODEX_HOME) {$env:CODEX_HOME} else {Join-Path $env:USERPROFILE '.codex'}),
  [string]$AppId = '',
  [string]$TemplateToken = '',
  [switch]$InstallDependencies,
  [switch]$RegisterSkills
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($PSScriptRoot)
function Resolve-Program([string]$Requested,[string]$Name) {
  if ($Requested) { $candidate=(Resolve-Path -LiteralPath $Requested -ErrorAction Stop).Path }
  else { $candidate=(Get-Command $Name -CommandType Application -ErrorAction Stop).Source }
  if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) {throw "Missing executable: $Name"}
  if ($candidate -match '\\WindowsApps\\python(?:3)?\.exe$') {throw 'Select a real Python installation, not the Windows Store alias.'}
  return $candidate
}
function Save-NewJson([string]$Path,$Value) {
  if (Test-Path -LiteralPath $Path) {return}
  [IO.File]::WriteAllText($Path,((ConvertTo-Json -InputObject $Value -Depth 12)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
}
$node=Resolve-Program $NodePath 'node'
$python=Resolve-Program $PythonPath 'python'
$pwsh=(Get-Process -Id $PID).Path
$nodeMajor=[int](& $node -p 'process.versions.node.split(".")[0]')
if ($LASTEXITCODE -ne 0 -or $nodeMajor -lt 22) {throw 'Node.js 22 or newer is required.'}
& $python -c 'import sys; assert sys.version_info >= (3,10), "Python 3.10 or newer is required"'
if ($LASTEXITCODE -ne 0) {throw 'Python version check failed.'}
$local=Join-Path $root '.local'
foreach($part in @('temp','credentials','feishu-profile','cdp-proxy','npm-cache')) {[void][IO.Directory]::CreateDirectory((Join-Path $local $part))}
$configFile=Join-Path $root 'config\backcheck-local.json'
Save-NewJson $configFile ([ordered]@{
  schema_version=1;app_id=$AppId;target_group_invite_url='';target_chat_id='';
  template_document_url=$(if($TemplateToken){'https://my.feishu.cn/docx/'+$TemplateToken}else{''});
  template_document_token=$TemplateToken;template_read_verified=$false;style_reference_urls=@();
  listener_enabled=$false;acceptance_replies_enabled=$false;
  accounting=@{enabled=$false;spreadsheet_token='';rules_reviewed=$false};codex_proxy_url='';cutover=@{}
})
$envMap=[ordered]@{
  CODEX_HOME=[IO.Path]::GetFullPath($CodexHomePath);CODEX_NODE=$node;NODE_BINARY=$node;
  BACKCHECK_CONFIG_PATH=$configFile;BACKGROUND_CHECK_WORKSPACE=$root;RESEARCH_WORKSPACE=$root;
  BACKCHECK_SKILLS_ROOT=(Join-Path $root 'skills');FEISHU_MCP_ROOT=(Join-Path $root 'external\feishu-mcp');
  FEISHU_MCP_PACKAGE_ROOT=(Join-Path $root 'external\feishu-mcp\node_modules\@larksuiteoapi\lark-mcp');
  FEISHU_UAT_SCRIPT=(Join-Path $root 'external\feishu-mcp\scripts\ensure-feishu-uat.ps1');
  FEISHU_CREDENTIAL_READER=(Join-Path $root 'external\feishu-mcp\scripts\read-credential.ps1');
  FEISHU_REVIEW_PYTHON=$python;RESEARCH_PYTHON=$python;RESEARCH_BATCH_TEST_PYTHON=$python;
  FEISHU_REVIEW_AUDITOR=(Join-Path $root 'skills\review-feishu-background-check\scripts\audit_feishu_snapshot.py');
  RESEARCH_BATCH_TEST_COVERAGE=(Join-Path $root 'tools\research-batch\coverage\validate.py');
  CDP_PROXY_TOKEN_DIR=(Join-Path $local 'cdp-proxy');FEISHU_CREDENTIAL_DIR=(Join-Path $local 'credentials');
  FEISHU_LOCALAPPDATA=(Join-Path $local 'feishu-profile');CODEX_DISPATCH_MODE='desktop_native_handoff_v1';
  FEISHU_GROUP_REPLIES_ENABLED='false';FEISHU_ACCEPTANCE_REPLIES_ENABLED='false';
  TEMP=(Join-Path $local 'temp');TMP=(Join-Path $local 'temp');NPM_CONFIG_CACHE=(Join-Path $local 'npm-cache');
  PYTHONDONTWRITEBYTECODE='1';PYTHONUTF8='1'
}
$runtimeFile=Join-Path $root 'config\runtime-paths.json'
if (Test-Path -LiteralPath $runtimeFile) {
  $current=Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8|ConvertFrom-Json
  if ($current.env.BACKGROUND_CHECK_WORKSPACE -ne $root -or $current.env.CODEX_NODE -ne $node -or $current.env.RESEARCH_PYTHON -ne $python) {
    throw 'Existing runtime paths differ. Preserve the old file and review the new installation location before replacing it.'
  }
} else {
  Save-NewJson $runtimeFile ([ordered]@{env=$envMap;path_entries=@((Split-Path $node),(Split-Path $python),(Split-Path $pwsh));feishu_local_appdata=(Join-Path $local 'feishu-profile')})
}
if ($InstallDependencies) {
  $npmCli=Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'
  if (!(Test-Path -LiteralPath $npmCli)) {throw 'The selected Node installation must include npm.'}
  foreach($relative in @('tools\feishu-codex-bridge','external\feishu-mcp')) {
    Push-Location (Join-Path $root $relative)
    try {& $node $npmCli ci --no-audit --no-fund; if($LASTEXITCODE -ne 0){throw "npm ci failed: $relative"}} finally {Pop-Location}
  }
  & $python -m pip install --requirement (Join-Path $root 'requirements.txt')
  if ($LASTEXITCODE -ne 0) {throw 'Python dependencies failed.'}
}
if ($RegisterSkills) {
  $skillHome=Join-Path $CodexHomePath 'skills'
  [void][IO.Directory]::CreateDirectory($skillHome)
  foreach($skill in Get-ChildItem -LiteralPath (Join-Path $root 'skills') -Directory) {
    $destination=Join-Path $skillHome $skill.Name
    if(Test-Path -LiteralPath $destination){
      $existing=Get-Item -LiteralPath $destination
      if (!$existing.LinkType -or [IO.Path]::GetFullPath([string]$existing.Target) -ne $skill.FullName) {throw "Existing skill preserved; resolve registration manually: $($skill.Name)"}
    } else {New-Item -ItemType Junction -Path $destination -Target $skill.FullName | Out-Null}
  }
}
$mcpConfig=Join-Path $root 'config\codex-mcp.local.toml'
if (!(Test-Path -LiteralPath $mcpConfig)) {
  $command=$node.Replace('\','/')
  $launcher=(Join-Path $root 'external\feishu-mcp\scripts\secure-launcher.mjs').Replace('\','/')
  $fragment="[mcp_servers.feishu]`ncommand = '$command'`nargs = ['$launcher']`n"
  [IO.File]::WriteAllText($mcpConfig,$fragment,[Text.UTF8Encoding]::new($false))
}
[pscustomobject]@{status='CONFIGURED_NOT_AUTHENTICATED';workspace=$root;node=$node;python=$python;
 dependencies_installed=[bool]$InstallDependencies;skills_registered=[bool]$RegisterSkills;
 listener_started=$false;credentials_copied=$false;browser_started=$false}|ConvertTo-Json -Compress
