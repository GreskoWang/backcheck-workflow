Set-StrictMode -Version Latest

function Test-FeishuUatProbeSuccess {
    param(
        [Parameter(Mandatory)][int]$ExitCode,
        [AllowEmptyString()][string]$Output
    )

    return $ExitCode -eq 0 -and $Output -match '"ok"\s*:\s*true' -and $Output -match '"readOnlySearch"\s*:\s*"succeeded"'
}

function Get-FeishuUatFailureKind {
    param([AllowEmptyString()][string]$Output)

    if ($Output -match 'ECONNREFUSED\s+127\.0\.0\.1:\d+') {
        return 'LOOPBACK_PROXY_REFUSED'
    }
    if (
        $Output -match 'Current user_access_token is invalid or expired' -or
        $Output -match 'user_access_token.{0,80}(invalid|expired)' -or
        $Output -match '(invalid|expired).{0,80}user_access_token'
    ) {
        return 'UAT_EXPIRED'
    }
    if (
        $Output -match '(first[- ]?time oauth|首次\s*OAuth|no local access token|应用.{0,20}(从未|尚未).{0,20}授权)' -or
        $Output -match '((enter|input|required|需要|请输入).{0,30}(password|密码|verification code|验证码|captcha|人机验证))' -or
        $Output -match '(switch account|切换账号|new scope|新增权限|app release|应用发版|administrator approval|管理员审批)'
    ) {
        return 'EXPLICIT_USER_VERIFICATION'
    }
    return 'TECHNICAL_FAILURE'
}

function Resolve-FeishuUatRecoveryDecision {
    param(
        [Parameter(Mandatory)][ValidateSet('Probe', 'Refresh', 'Login', 'PostProbe')][string]$Stage,
        [Parameter(Mandatory)][int]$ExitCode,
        [AllowEmptyString()][string]$Output,
        [switch]$DirectRetryUsed
    )

    if ($Stage -in @('Probe', 'PostProbe') -and (Test-FeishuUatProbeSuccess -ExitCode $ExitCode -Output $Output)) {
        $reason = if ($Stage -eq 'Probe') {
            if ($DirectRetryUsed) { 'EXISTING_UAT_VALID_WITHOUT_PROXY' } else { 'EXISTING_UAT_VALID' }
        } else {
            if ($DirectRetryUsed) { 'RENEWED_UAT_VERIFIED_WITHOUT_PROXY' } else { 'RENEWED_UAT_VERIFIED' }
        }
        return [pscustomobject]@{ Action = 'READY'; Reason = $reason }
    }

    $kind = Get-FeishuUatFailureKind -Output $Output

    if ($Stage -eq 'Probe') {
        if ($kind -eq 'UAT_EXPIRED') {
            if (-not $DirectRetryUsed) {
                return [pscustomobject]@{ Action = 'RUN_PROBE_WITHOUT_PROXY'; Reason = 'UAT_EXPIRED_RETRY_DIRECT' }
            }
            return [pscustomobject]@{ Action = 'RUN_REFRESH_WITHOUT_PROXY'; Reason = 'UAT_EXPIRED_AFTER_DIRECT_PROBE' }
        }
        if (-not $DirectRetryUsed) {
            return [pscustomobject]@{ Action = 'RUN_PROBE_WITHOUT_PROXY'; Reason = "PROBE_$kind" }
        }
        return [pscustomobject]@{ Action = 'TECHNICAL_FAILURE'; Reason = "PROBE_$kind" }
    }

    if ($Stage -eq 'Refresh') {
        if ($ExitCode -eq 0 -and $Output -match '"status"\s*:\s*"REFRESHED"') {
            return [pscustomobject]@{ Action = 'RUN_POST_PROBE'; Reason = 'SILENT_REFRESH_SUCCEEDED' }
        }
        if ($Output -match '"status"\s*:\s*"(NO_LOCAL_TOKEN|NO_REFRESH_TOKEN|REFRESH_TOKEN_REJECTED)"') {
            return [pscustomobject]@{ Action = 'CODEX_OAUTH_REQUIRED'; Reason = 'OAUTH_PAGE_CONTINUATION_REQUIRED' }
        }
        if ($Output -match '"status"\s*:\s*"NETWORK_FAILURE"') {
            return [pscustomobject]@{ Action = 'TECHNICAL_FAILURE'; Reason = 'REFRESH_NETWORK_FAILURE' }
        }
        return [pscustomobject]@{ Action = 'TECHNICAL_FAILURE'; Reason = 'REFRESH_TECHNICAL_FAILURE' }
    }

    if ($Stage -eq 'Login') {
        if ($ExitCode -eq 0 -and $Output -match 'Successfully logged in') {
            return [pscustomobject]@{ Action = 'RUN_POST_PROBE'; Reason = 'OAUTH_LOGIN_SUCCEEDED' }
        }
        if ($kind -eq 'LOOPBACK_PROXY_REFUSED' -and -not $DirectRetryUsed) {
            return [pscustomobject]@{ Action = 'RUN_LOGIN_WITHOUT_PROXY'; Reason = 'LOOPBACK_PROXY_REFUSED' }
        }
        if ($kind -eq 'EXPLICIT_USER_VERIFICATION') {
            return [pscustomobject]@{ Action = 'USER_ACTION_REQUIRED'; Reason = $kind }
        }
        return [pscustomobject]@{ Action = 'TECHNICAL_FAILURE'; Reason = if ($DirectRetryUsed -and $kind -eq 'LOOPBACK_PROXY_REFUSED') { 'DIRECT_OAUTH_CONNECTION_FAILED' } else { "LOGIN_$kind" } }
    }

    if ($kind -ne 'UAT_EXPIRED' -and -not $DirectRetryUsed) {
        return [pscustomobject]@{ Action = 'RUN_PROBE_WITHOUT_PROXY'; Reason = "POST_PROBE_$kind" }
    }
    return [pscustomobject]@{ Action = 'TECHNICAL_FAILURE'; Reason = "POST_PROBE_$kind" }
}

Export-ModuleMember -Function Test-FeishuUatProbeSuccess, Get-FeishuUatFailureKind, Resolve-FeishuUatRecoveryDecision
