[CmdletBinding()]
param(
    [switch]$WithoutProxy
)

. (Join-Path $PSScriptRoot "common.ps1")

$credential = Get-FeishuCredential
Set-FeishuProcessEnvironment -Credential $credential
$cliPath = Get-LarkMcpCliPath
$proxyNames = @(
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy"
)
$proxySnapshot = @{}

if ($WithoutProxy) {
    foreach ($name in $proxyNames) {
        $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            $proxySnapshot[$name] = [string]$item.Value
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
    }
}

try {
    & node $cliPath login `
        --host localhost `
        --port 3000 `
        --scope "offline_access docx:document drive:drive wiki:wiki:readonly"
    exit $LASTEXITCODE
}
finally {
    if ($WithoutProxy) {
        foreach ($name in $proxyNames) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            if ($proxySnapshot.ContainsKey($name)) {
                Set-Item -LiteralPath "Env:$name" -Value $proxySnapshot[$name]
            }
        }
    }
    $env:APP_SECRET = $null
    $credential.AppSecret = $null
}
