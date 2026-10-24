[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Import-Module -Name (Join-Path $PSScriptRoot 'uat-recovery.psm1') -Force

# The non-interactive preflight must not regress to the official interactive
# login command, which clears the stored token before waiting for a browser.
$ensureSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ensure-feishu-uat.ps1') -Raw -Encoding utf8
if ($ensureSource -match 'login-feishu\.ps1' -or $ensureSource -match 'node\s+\$?cliPath\s+login') {
    throw 'Preflight must not invoke the interactive login command'
}
if ($ensureSource -notmatch 'refresh-feishu-uat\.ps1' -or
    $ensureSource -notmatch 'Stage Refresh' -or
    $ensureSource -notmatch 'Stage PostProbe' -or
    $ensureSource -notmatch 'CODEX_OAUTH_REQUIRED') {
    throw 'Preflight must route expiry through silent refresh and a post-refresh probe'
}

$cases = @(
    @{ Name = 'valid probe'; Stage = 'Probe'; ExitCode = 0; Output = '{"ok":true,"readOnlySearch":"succeeded"}'; Direct = $false; Action = 'READY'; Reason = 'EXISTING_UAT_VALID' },
    @{ Name = 'valid direct probe'; Stage = 'Probe'; ExitCode = 0; Output = '{"ok":true,"readOnlySearch":"succeeded"}'; Direct = $true; Action = 'READY'; Reason = 'EXISTING_UAT_VALID_WITHOUT_PROXY' },
    @{ Name = 'expired probe retries without proxy'; Stage = 'Probe'; ExitCode = 1; Output = 'Current user_access_token is invalid or expired'; Direct = $false; Action = 'RUN_PROBE_WITHOUT_PROXY'; Reason = 'UAT_EXPIRED_RETRY_DIRECT' },
    @{ Name = 'expired direct probe invokes silent refresh'; Stage = 'Probe'; ExitCode = 1; Output = 'Current user_access_token is invalid or expired'; Direct = $true; Action = 'RUN_REFRESH_WITHOUT_PROXY'; Reason = 'UAT_EXPIRED_AFTER_DIRECT_PROBE' },
    @{ Name = 'probe failure requests direct retry'; Stage = 'Probe'; ExitCode = 1; Output = 'socket timeout'; Direct = $false; Action = 'RUN_PROBE_WITHOUT_PROXY'; Reason = 'PROBE_TECHNICAL_FAILURE' },
    @{ Name = 'direct probe failure'; Stage = 'Probe'; ExitCode = 1; Output = 'socket timeout'; Direct = $true; Action = 'TECHNICAL_FAILURE'; Reason = 'PROBE_TECHNICAL_FAILURE' },
    @{ Name = 'silent refresh success'; Stage = 'Refresh'; ExitCode = 0; Output = '{"status":"REFRESHED"}'; Direct = $false; Action = 'RUN_POST_PROBE'; Reason = 'SILENT_REFRESH_SUCCEEDED' },
    @{ Name = 'missing local token requires Codex OAuth continuation'; Stage = 'Refresh'; ExitCode = 3; Output = '{"status":"NO_LOCAL_TOKEN"}'; Direct = $false; Action = 'CODEX_OAUTH_REQUIRED'; Reason = 'OAUTH_PAGE_CONTINUATION_REQUIRED' },
    @{ Name = 'missing refresh token requires Codex OAuth continuation'; Stage = 'Refresh'; ExitCode = 3; Output = '{"status":"NO_REFRESH_TOKEN"}'; Direct = $false; Action = 'CODEX_OAUTH_REQUIRED'; Reason = 'OAUTH_PAGE_CONTINUATION_REQUIRED' },
    @{ Name = 'rejected refresh token requires Codex OAuth continuation'; Stage = 'Refresh'; ExitCode = 3; Output = '{"status":"REFRESH_TOKEN_REJECTED"}'; Direct = $false; Action = 'CODEX_OAUTH_REQUIRED'; Reason = 'OAUTH_PAGE_CONTINUATION_REQUIRED' },
    @{ Name = 'refresh network failure'; Stage = 'Refresh'; ExitCode = 2; Output = '{"status":"NETWORK_FAILURE"}'; Direct = $false; Action = 'TECHNICAL_FAILURE'; Reason = 'REFRESH_NETWORK_FAILURE' },
    @{ Name = 'login success'; Stage = 'Login'; ExitCode = 0; Output = 'Successfully logged in'; Direct = $false; Action = 'RUN_POST_PROBE'; Reason = 'OAUTH_LOGIN_SUCCEEDED' },
    @{ Name = 'loopback proxy first failure'; Stage = 'Login'; ExitCode = 1; Output = 'connect ECONNREFUSED 127.0.0.1:10808'; Direct = $false; Action = 'RUN_LOGIN_WITHOUT_PROXY'; Reason = 'LOOPBACK_PROXY_REFUSED' },
    @{ Name = 'loopback proxy direct failure'; Stage = 'Login'; ExitCode = 1; Output = 'connect ECONNREFUSED 127.0.0.1:10808'; Direct = $true; Action = 'TECHNICAL_FAILURE'; Reason = 'DIRECT_OAUTH_CONNECTION_FAILED' },
    @{ Name = 'generic login failure is technical'; Stage = 'Login'; ExitCode = 1; Output = 'Login failed'; Direct = $false; Action = 'TECHNICAL_FAILURE'; Reason = 'LOGIN_TECHNICAL_FAILURE' },
    @{ Name = 'first OAuth is explicit user action'; Stage = 'Login'; ExitCode = 1; Output = 'No local access token; first-time OAuth is required'; Direct = $false; Action = 'USER_ACTION_REQUIRED'; Reason = 'EXPLICIT_USER_VERIFICATION' },
    @{ Name = 'explicit verification'; Stage = 'Login'; ExitCode = 1; Output = '需要验证码'; Direct = $false; Action = 'USER_ACTION_REQUIRED'; Reason = 'EXPLICIT_USER_VERIFICATION' },
    @{ Name = 'post probe success'; Stage = 'PostProbe'; ExitCode = 0; Output = '{"ok":true,"readOnlySearch":"succeeded"}'; Direct = $false; Action = 'READY'; Reason = 'RENEWED_UAT_VERIFIED' },
    @{ Name = 'post probe failure requests direct retry'; Stage = 'PostProbe'; ExitCode = 1; Output = 'socket timeout'; Direct = $false; Action = 'RUN_PROBE_WITHOUT_PROXY'; Reason = 'POST_PROBE_TECHNICAL_FAILURE' },
    @{ Name = 'post direct probe success'; Stage = 'PostProbe'; ExitCode = 0; Output = '{"ok":true,"readOnlySearch":"succeeded"}'; Direct = $true; Action = 'READY'; Reason = 'RENEWED_UAT_VERIFIED_WITHOUT_PROXY' },
    @{ Name = 'post direct probe failure'; Stage = 'PostProbe'; ExitCode = 1; Output = 'socket timeout'; Direct = $true; Action = 'TECHNICAL_FAILURE'; Reason = 'POST_PROBE_TECHNICAL_FAILURE' }
)

foreach ($case in $cases) {
    $parameters = @{
        Stage = $case.Stage
        ExitCode = $case.ExitCode
        Output = $case.Output
    }
    if ($case.Direct) {
        $parameters.DirectRetryUsed = $true
    }
    $actual = Resolve-FeishuUatRecoveryDecision @parameters
    if ($actual.Action -ne $case.Action -or $actual.Reason -ne $case.Reason) {
        throw "Case '$($case.Name)' failed: expected $($case.Action)/$($case.Reason), got $($actual.Action)/$($actual.Reason)"
    }
}

[pscustomobject]@{
    ok = $true
    cases = $cases.Count
} | ConvertTo-Json -Compress
