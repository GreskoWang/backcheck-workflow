$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\..\..\recovery-session-env.ps1")
$env:LOCALAPPDATA = $env:FEISHU_LOCALAPPDATA

function Get-FeishuCredential {
    $credentialPath = Join-Path $env:FEISHU_CREDENTIAL_DIR "credentials.json"
    if (-not (Test-Path -LiteralPath $credentialPath)) {
        throw "尚未配置飞书凭证。请先运行 configure-credentials.ps1。"
    }

    $config = Get-Content -Raw -LiteralPath $credentialPath | ConvertFrom-Json
    $secure = ConvertTo-SecureString $config.app_secret_protected
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }

    return [pscustomobject]@{
        AppId = [string]$config.app_id
        AppSecret = $plainSecret
    }
}

function Get-LarkMcpCliPath {
    $packageRoot = if ($env:FEISHU_MCP_PACKAGE_ROOT) { $env:FEISHU_MCP_PACKAGE_ROOT } else { Join-Path $PSScriptRoot '..\node_modules\@larksuiteoapi\lark-mcp' }
    $cliPath = Join-Path $packageRoot 'dist\cli.js' 
    if (-not (Test-Path -LiteralPath $cliPath)) {
        throw "未找到项目内飞书 MCP。请在仓库根目录运行 Setup-Backcheck.ps1 -InstallDependencies。"
    }
    return $cliPath
}

function Set-FeishuProcessEnvironment {
    param([Parameter(Mandatory)]$Credential)

    $env:APP_ID = $Credential.AppId
    $env:APP_SECRET = $Credential.AppSecret
    $env:LARK_DOMAIN = "https://open.feishu.cn"
    $env:LARK_TOKEN_MODE = "user_access_token"
}

