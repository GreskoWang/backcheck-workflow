[CmdletBinding(DefaultParameterSetName = 'New')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'New')][string]$InitialUrl,
  [Parameter(Mandatory = $true, ParameterSetName = 'Resume')][ValidatePattern('^[A-Za-z0-9_-]{1,100}$')][string]$ExistingTarget,
  [Parameter(Mandatory = $true, ParameterSetName = 'Resume')][string]$ExpectedUrl,
  [Parameter(Mandatory = $true, ParameterSetName = 'Resume')][ValidateRange(0, 1)][int]$RecoveryAttemptsUsed = 0,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@-]{1,120}$')][string]$Owner,
  [ValidateRange(1, 65535)][int]$Port = $(if ($env:CDP_PROXY_PORT) { [int]$env:CDP_PROXY_PORT } else { 3456 }),
  [ValidateRange(100, 60000)][int]$RequestTimeoutMilliseconds = 25000,
  [string]$RequestScript = (Join-Path $PSScriptRoot 'cdp-request.ps1')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:Target = $null
$script:OwnsPage = $false
$script:HasLease = $false
$script:CreationUnknown = $false
$script:SessionExitCode = 0
$script:StopReason = 'eof'
$allowedActions = @('query', 'scroll', 'navigate', 'info', 'activate', 'recover', 'click', 'clickAt', 'shot', 'finish')
$allowedClickErrorReasons = @('not_found', 'not_visible', 'text_mismatch', 'not_visible_or_changed', 'occluded', 'traversal_limit', 'shadow_host_not_found', 'shadow_root_unavailable')
$requestExecutable = (Get-Process -Id $PID).Path

function ConvertTo-PublicJson {
  param($Value)
  $json = ConvertTo-Json -InputObject $Value -Depth 40 -Compress
  foreach ($name in @('CDP_LEASE', 'CDP_MANAGE', 'CDP_REQUEST_ID')) {
    $secret = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($secret) { $json = $json.Replace($secret, '[redacted]') }
  }
  return [regex]::Replace($json, 'Bearer\s+[A-Za-z0-9._~-]+', 'Bearer [redacted]', 'IgnoreCase')
}

function Write-Public {
  param($Value)
  [Console]::WriteLine((ConvertTo-PublicJson $Value))
  [Console]::Out.Flush()
}

function Invoke-SessionRequest {
  param([string]$Method, [string]$Path, [string]$Body = '', [string]$OutFile)
  $process = [Diagnostics.Process]::new()
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $requestExecutable
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
  $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
  foreach ($argument in @('-NoProfile', '-NonInteractive', '-File', $RequestScript, '-Method', $Method,
      '-Path', $Path, '-Owner', $Owner, '-Port', [string]$Port)) { [void]$start.ArgumentList.Add($argument) }
  if ($Body) { [void]$start.ArgumentList.Add('-Body'); [void]$start.ArgumentList.Add($Body) }
  if ($OutFile) { [void]$start.ArgumentList.Add('-OutFile'); [void]$start.ArgumentList.Add($OutFile) }
  # The owner process env is inherited. Capabilities never enter ArgumentList.
  $process.StartInfo = $start
  try {
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit($RequestTimeoutMilliseconds)) {
      try { $process.Kill($true) } catch {}
      [void]$process.WaitForExit(2000)
      return @{ ok = $false; unknown = $true; code = 'request_timeout'; exitCode = $null; data = $null }
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    [void]$stderrTask.GetAwaiter().GetResult()
    $data = $null
    if ($stdout.Trim()) {
      try { $data = ConvertFrom-Json -InputObject $stdout -Depth 40 } catch {
        return @{ ok = $false; unknown = $true; code = 'invalid_response'; exitCode = $process.ExitCode; data = $null }
      }
    }
    if ($process.ExitCode -ne 0) {
      $code = if ($data.error.code -match '^[a-z][a-z0-9_]{1,80}$') { [string]$data.error.code } else { 'request_failed' }
      $reason = if ($code -eq 'element_not_found' -and $data.error.details.reason -in $allowedClickErrorReasons) { [string]$data.error.details.reason } else { $null }
      return @{ ok = $false; unknown = ($null -eq $data -or $code -in @('operation_pending', 'target_still_marked'));
        code = $code; reason = $reason; exitCode = $process.ExitCode; data = $null }
    }
    return @{ ok = $true; unknown = $false; code = $null; exitCode = 0; data = $data }
  } catch {
    return @{ ok = $false; unknown = $true; code = 'request_process_failed'; exitCode = $null; data = $null }
  } finally { $process.Dispose() }
}

function Read-SessionCommand {
  param([string]$Line)
  $command = ConvertFrom-Json -InputObject $Line -Depth 20
  if ($command.action -notin $allowedActions) { throw 'unsupported action' }
  return $command
}

function Invoke-SessionCommand {
  param($Command)
  if ($Command.action -eq 'recover') {
    if ($RecoveryAttemptsUsed -ge 1) {
      Write-Public @{ ok = $false; action = 'recover'; targetId = $script:Target; sessionAlive = $true; error = @{ code = 'recovery_budget_exhausted' }; recoveryAttemptsUsed = $RecoveryAttemptsUsed }
      return
    }
    # An attempted or unknown recovery consumes the budget too.
    $script:RecoveryAttemptsUsed++
  }
  $path = $null; $method = 'POST'; $body = ''; $outputFile = $null
  switch ($Command.action) {
    'query' {
      if (!$Command.body) { throw 'query body required' }
      $path = "/dom/query?target=$script:Target"
      $body = ConvertTo-Json -InputObject $Command.body -Depth 20 -Compress
    }
    'scroll' {
      $distance = 0
      if (![int]::TryParse([string]$Command.y, [ref]$distance) -or $distance -lt 1 -or $distance -gt 2000 -or
          $Command.direction -notin @('up', 'down')) { throw 'bounded scroll parameters required' }
      $path = "/scroll?target=$script:Target&y=$distance&direction=$($Command.direction)"
      if ($Command.selector) { $path += '&selector=' + [uri]::EscapeDataString([string]$Command.selector) }
    }
    'navigate' {
      $destination = $null
      if (![uri]::TryCreate([string]$Command.url, [UriKind]::Absolute, [ref]$destination) -or
          $destination.Scheme -notin @('http', 'https') -or $destination.UserInfo) { throw 'public URL required' }
      $path = '/navigate?target=' + $script:Target + '&url=' + [uri]::EscapeDataString($destination.AbsoluteUri)
    }
    'info' { $method = 'GET'; $path = "/info?target=$script:Target" }
    'activate' { $path = "/activate?target=$script:Target" }
    'recover' { $path = "/recover?target=$script:Target" }
    { $_ -in @('click', 'clickAt') } {
      if (!$Command.body) { throw 'click body required' }
      $path = "/$($Command.action)?target=$script:Target"
      $body = ConvertTo-Json -InputObject $Command.body -Depth 20 -Compress
    }
    'shot' {
      if ([string]::IsNullOrWhiteSpace([string]$Command.path)) { throw 'screenshot path required' }
      $method = 'GET'; $path = "/screenshot?target=$script:Target&format=jpeg"; $outputFile = [string]$Command.path
    }
    default { throw 'unsupported action' }
  }
  $result = Invoke-SessionRequest -Method $method -Path $path -Body $body -OutFile $outputFile
  if (!$result.ok) {
    $publicError = @{ code = $result.code; exitCode = $result.exitCode }
    if ($result.reason) { $publicError.reason = $result.reason }
    Write-Public @{ ok = $false; action = $Command.action; targetId = $script:Target; sessionAlive = $true;
      error = $publicError }
    return
  }
  if ($Command.action -eq 'shot') {
    if (!(Test-Path -LiteralPath $outputFile -PathType Leaf)) { throw 'screenshot not saved' }
    Write-Public @{ ok = $true; action = 'shot'; targetId = $script:Target; data = @{ path = $outputFile } }
  } else {
    if ($null -eq $result.data) { throw 'empty command result' }
    if ($Command.action -eq 'query' -and $Command.path) {
      [IO.File]::WriteAllText([string]$Command.path, (ConvertTo-PublicJson $result.data), [Text.UTF8Encoding]::new($false))
    }
    Write-Public @{ ok = $true; action = $Command.action; targetId = $script:Target; data = $result.data }
  }
}

try {
  $initial = $null
  $startUrl = if ($ExistingTarget) { $ExpectedUrl } else { $InitialUrl }
  if (![uri]::TryCreate($startUrl, [UriKind]::Absolute, [ref]$initial) -or
      $initial.Scheme -notin @('http', 'https') -or $initial.UserInfo) { throw 'public initial URL required' }
  if (!(Test-Path -LiteralPath $RequestScript -PathType Leaf)) { throw 'request wrapper missing' }
  Remove-Item Env:CDP_LEASE, Env:CDP_MANAGE, Env:CDP_REQUEST_ID -ErrorAction SilentlyContinue
  $firstLine = $null
  # Plain-pipes helpers often arrive with immediate EOF. Do not create a page
  # until an actual, valid first command exists in that mode.
  if ([Console]::IsInputRedirected) {
    do { $firstLine = [Console]::ReadLine() } while ($null -ne $firstLine -and [string]::IsNullOrWhiteSpace($firstLine))
    if ($null -eq $firstLine) { Write-Public @{ type = 'no_input'; created = $false }; exit 0 }
    [void](Read-SessionCommand $firstLine)
  }
  $env:CDP_REQUEST_ID = [guid]::NewGuid().ToString('N')
  $createPath = if ($ExistingTarget) { '/acquire?target=' + $ExistingTarget } else { '/new?activate=true&url=' + [uri]::EscapeDataString($InitialUrl) }
  $created = $null
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    $result = Invoke-SessionRequest -Method POST -Path $createPath
    $validExisting = $ExistingTarget -and $result.data.targetId -eq $ExistingTarget -and $result.data.leaseToken
    $validNew = !$ExistingTarget -and $result.data.ready -eq $true -and $result.data.targetId -and $result.data.leaseToken -and $result.data.manageToken
    if ($result.ok -and ($validExisting -or $validNew)) { $created = $result.data; break }
    $script:CreationUnknown = $result.unknown -or ($result.ok -and !$validExisting -and !$validNew)
    # Only an unknown response receives one recovery. Identical key and route.
    if (!$script:CreationUnknown) { break }
  }
  if ($null -eq $created) {
    $script:SessionExitCode = 1
    Write-Public @{ ok = $false; type = 'startup_error'; created = $false; creationUnknown = $script:CreationUnknown;
      error = @{ code = $(if ($script:CreationUnknown) { 'creation_unconfirmed' } else { 'creation_failed' }) } }
  } else {
    $env:CDP_LEASE = [string]$created.leaseToken
    if (!$ExistingTarget) { $env:CDP_MANAGE = [string]$created.manageToken }
    $script:Target = [string]$created.targetId
    $script:HasLease = $true
    $script:OwnsPage = !$ExistingTarget
    $created = $null; $result = $null
    if ($ExistingTarget) {
      $verified = Invoke-SessionRequest -Method GET -Path "/info?target=$script:Target"
      if (!$verified.ok -or $verified.data.page.url -cne $ExpectedUrl) {
        Write-Public @{ type = 'resume_verification_failed'; ok = $false; targetId = $script:Target; recoveryAttemptsUsed = $RecoveryAttemptsUsed; error = @{ code = $(if (!$verified.ok) { $verified.code } else { 'resume_url_mismatch' }) } }
        throw 'existing target URL not verified'
      }
      Write-Public @{ type = 'resume_verified'; targetId = $script:Target; data = $verified.data; recoveryAttemptsUsed = $RecoveryAttemptsUsed }
    }
    Write-Public @{ type = 'ready'; ready = $true; owner = $Owner; targetId = $script:Target; pid = $PID; existingTarget = [bool]$ExistingTarget; recoveryAttemptsUsed = $RecoveryAttemptsUsed }
    :commandLoop while ($true) {
      $line = if ($null -ne $firstLine) { $firstLine } else { [Console]::ReadLine() }
      $firstLine = $null
      if ($null -eq $line) { $script:StopReason = 'eof'; break }
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try {
        $command = Read-SessionCommand $line
        if ($command.action -eq 'finish') { $script:StopReason = 'finish'; break commandLoop }
        Invoke-SessionCommand $command
      } catch {
        Write-Public @{ ok = $false; type = 'command_error'; sessionAlive = $true; targetId = $script:Target;
          error = @{ code = 'invalid_or_failed_command' } }
      }
    }
  }
} catch {
  $script:SessionExitCode = 1; $script:StopReason = 'session_error'
  Write-Public @{ ok = $false; type = 'session_error'; error = @{ code = 'session_failed' } }
} finally {
  try {
    if ($script:OwnsPage) {
      # A lost close response is never replayed. Only explicit closed=true is
      # accepted; clearing env or release is not proof that a page was closed.
      $cleanup = Invoke-SessionRequest -Method POST -Path "/finalize?target=$script:Target"
      $closed = $cleanup.ok -and $cleanup.data.closed -eq $true
      if (!$closed) { $script:SessionExitCode = 1 }
      Write-Public @{ type = 'cleanup'; targetId = $script:Target; reason = $script:StopReason; closed = [bool]$closed;
        error = $(if ($closed) { $null } else { @{ code = 'cleanup_unconfirmed' } }) }
    } elseif ($script:HasLease) {
      $cleanup = Invoke-SessionRequest -Method POST -Path "/release?target=$script:Target"
      $released = $cleanup.ok -and $cleanup.data.released -eq $true
      if (!$released) { $script:SessionExitCode = 1 }
      Write-Public @{ type = 'cleanup'; targetId = $script:Target; reason = $script:StopReason; released = [bool]$released; closed = $false; recoveryAttemptsUsed = $RecoveryAttemptsUsed;
        error = $(if ($released) { $null } else { @{ code = 'cleanup_unconfirmed' } }) }
    } elseif ($script:CreationUnknown) {
      Write-Public @{ type = 'cleanup'; closed = $false; reason = 'creation_unconfirmed'; error = @{ code = 'cleanup_unconfirmed' } }
    }
  } finally {
    Remove-Item Env:CDP_LEASE, Env:CDP_MANAGE, Env:CDP_REQUEST_ID -ErrorAction SilentlyContinue
  }
}
exit $script:SessionExitCode
