[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$skillRoot = Split-Path -Parent $PSScriptRoot
$skillPath = Join-Path $skillRoot 'SKILL.md'
$runtimeRoot = Join-Path $env:FEISHU_MCP_ROOT 'scripts'
$runtimeFiles = @(
    (Join-Path $runtimeRoot 'login-feishu.ps1'),
    (Join-Path $runtimeRoot 'uat-recovery.psm1'),
    (Join-Path $runtimeRoot 'ensure-feishu-uat.ps1'),
    (Join-Path $runtimeRoot 'test-uat-recovery.ps1'),
    (Join-Path $runtimeRoot 'verify-live.mjs')
)
$requiredFiles = @(
    $skillPath,
    (Join-Path $skillRoot 'references\platform-format.md'),
    (Join-Path $skillRoot 'references\feishu-operations.md'),
    (Join-Path $skillRoot 'references\feishu-style-guide.md'),
    (Join-Path (Split-Path $skillRoot -Parent) 'review-feishu-background-check\SKILL.md')
) + $runtimeFiles

$missingFiles = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
if ($missingFiles.Count -gt 0) {
    throw "Missing identity-contract dependencies: $($missingFiles -join ', ')"
}

$skillContent = Get-Content -LiteralPath $skillPath -Raw -Encoding utf8
$frontmatter = [regex]::Match(
    $skillContent,
    '\A---\r?\n(?<body>.*?)\r?\n---(?:\r?\n|\z)',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)
if (-not $frontmatter.Success) {
    throw 'Invalid SKILL.md frontmatter envelope'
}

$requiredClauses = @(
    'pwsh -NoProfile -File "$env:FEISHU_MCP_ROOT\scripts\ensure-feishu-uat.ps1"',
    '`CODEX_OAUTH_REQUIRED`',
    '不得无人值守地启动或重复尝试',
    '任何“需要你授权”的答复必须同时给出',
    '首次 OAuth／当前应用从未获该账号授权',
    '仅有“浏览器没有自动完成”“登录失败”“令牌失效”或超时，不满足该状态',
    '没有得到 `READY` 不得进入正文写入',
    '必须调用 `$review-feishu-background-check`'
)
$missingClauses = @($requiredClauses | Where-Object { -not $skillContent.Contains($_) })
if ($missingClauses.Count -gt 0) {
    throw "Missing identity-contract clauses: $($missingClauses -join ' | ')"
}

foreach ($file in $requiredFiles) {
    $content = Get-Content -LiteralPath $file -Raw -Encoding utf8
    if ($content.Contains([char]0xFFFD)) {
        throw "UTF-8 replacement character found: $file"
    }
}

foreach ($file in ($runtimeFiles | Where-Object { $_ -match '\.(ps1|psm1)$' })) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        throw "PowerShell parse error in $file`n$($errors | Out-String)"
    }
}

$testOutput = & pwsh -NoProfile -File (Join-Path $runtimeRoot 'test-uat-recovery.ps1')
if ($LASTEXITCODE -ne 0) {
    throw "UAT recovery tests failed: $testOutput"
}
$testResult = $testOutput | ConvertFrom-Json
if (-not $testResult.ok) {
    throw "UAT recovery tests did not return ok=true: $testOutput"
}

[pscustomobject]@{
    ok = $true
    required_clauses = $requiredClauses.Count
    dependencies = $requiredFiles.Count
    recovery_cases = $testResult.cases
} | ConvertTo-Json -Compress
