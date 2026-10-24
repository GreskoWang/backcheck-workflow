[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InitialUrl,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@-]{1,120}$')][string]$Owner,
  [ValidateRange(1, 65535)][int]$Port = $(if ($env:CDP_PROXY_PORT) { [int]$env:CDP_PROXY_PORT } else { 3456 }),
  [ValidateRange(100, 60000)][int]$RequestTimeoutMilliseconds = 25000,
  [string]$RequestScript = (Join-Path $PSScriptRoot 'cdp-request.ps1'),
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [Parameter(Mandatory=$true)][string]$RequestId,
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_]{1,15}$')][string]$ExpectedHandle
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'x-readiness.ps1')
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:Target = $null
$script:OwnsPage = $false
$script:CreationUnknown = $false
$script:SessionExitCode = 0
$script:StopReason = 'eof'
$allowedActions = @('query', 'scroll', 'navigate', 'info', 'activate', 'recover', 'click', 'clickAt', 'shot', 'bulk', 'finish')
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

  if ($Command.action -eq 'bulk') {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 30
    if ($manifest.requestId -ne $RequestId) { throw 'Wrong request' }
    if ($Command.group -notmatch '^[a-z0-9-]{1,30}$') { throw 'Invalid group' }
    $entries = @($manifest.groups.($Command.group))
    if ($entries.Count -lt 1 -or $entries.Count -gt 12) { throw 'Bounded queue required' }
    foreach ($entry in $entries) {
      if ($entry.url -notmatch ('^https://x\.com/' + [regex]::Escape($ExpectedHandle) + '/status/[0-9]{15,22}$')) { throw 'Unverified source route' }
    }
    $bulkOut = Join-Path $OutputRoot ('x-original-bulk-' + $Command.group)
    if (Test-Path -LiteralPath $bulkOut) { throw 'Output exists; inspect checkpoint first' }
    [void][IO.Directory]::CreateDirectory($bulkOut)
    $bulkState = @{ requestId=$manifest.requestId; group=$Command.group; state='running'; stage='starting'; owner=$Owner; targetId=$script:Target; completed=@(); current=$null; reviewed=$false; complete=$false }
    function Save-BulkState { [IO.File]::WriteAllText((Join-Path $bulkOut 'state.json'), (ConvertTo-PublicJson $bulkState), [Text.UTF8Encoding]::new($false)) }
    function Bulk-Call([string]$Verb,[string]$Route,[string]$JsonBody='', [string]$Destination='') {
      $response = Invoke-SessionRequest -Method $Verb -Path $Route -Body $JsonBody -OutFile $Destination
      if (!$response.ok) {
        $bulkState.error=if ($response.code -match '^[a-z][a-z0-9_]{1,80}$') { [string]$response.code } else { 'request_failed' }
        $bulkState.failure=@{stage=$bulkState.stage;code=$bulkState.error;unknown=[bool]$response.unknown}
        throw 'bulk_request_failed'
      }
      return $response.data
    }
    try {
      Save-BulkState
      foreach ($entry in $entries) {
        $url = [string]$entry.url; $postId = ($url -split '/')[-1]
        $bulkState.current=$url; $bulkState.stage='navigate_post'; Save-BulkState
        [void](Bulk-Call 'POST' ('/navigate?target=' + $script:Target + '&url=' + [uri]::EscapeDataString($url)))
        $bulkState.stage='wait_post_ready'; Save-BulkState
        $ready=Wait-XPublicContent -Kind Post -Url $url -Handle $ExpectedHandle -Target $script:Target -Call ${function:Bulk-Call}
        $pageInfo=$ready.info; $bodyRead=$ready.body; $linksRead=$ready.links
        $bulkState.stage='read_article_overview'; Save-BulkState
        $articleRead=Bulk-Call 'POST' ('/dom/query?target=' + $script:Target) '{"kind":"elements","selector":"article","visibility":"rendered","limit":20,"fields":["text"]}'
        $photoUrls=@($linksRead.value.items | ForEach-Object {$_.href} | Where-Object {$_ -match ('^' + [regex]::Escape($url) + '/photo/[1-4]$')} | Select-Object -Unique)
        $postRecord=@{url=$url; postId=$postId; observedAt=[DateTime]::UtcNow.ToString('o'); info=$pageInfo; mainText=$bodyRead; textScope='first rendered article; page URL and article permalink checked; quotes and expansion still require review'; articleOverview=$articleRead; articleOverviewComplete=$false; links=$linksRead; photoUrls=$photoUrls; photos=@(); reviewed=$false; attribution='article text may include quote; model verification required'; complete=$false}
        [IO.File]::WriteAllText((Join-Path $bulkOut ($postId + '.json')), (ConvertTo-PublicJson $postRecord), [Text.UTF8Encoding]::new($false))
        foreach ($photoUrl in $photoUrls) {
          $bulkState.stage='navigate_photo'; Save-BulkState
          [void](Bulk-Call 'POST' ('/navigate?target=' + $script:Target + '&url=' + [uri]::EscapeDataString($photoUrl)))
          $bulkState.stage='wait_photo_ready'; Save-BulkState
          $photoReady=Wait-XPublicContent -Kind Photo -Url $photoUrl -Handle $ExpectedHandle -Target $script:Target -Call ${function:Bulk-Call}
          $photoNo=($photoUrl -split '/')[-1]
          $photoFile=Join-Path $bulkOut ($postId + '-photo-' + $photoNo + '.jpg')
          $bulkState.stage='capture_photo'; Save-BulkState
          [void](Bulk-Call 'GET' ('/screenshot?target=' + $script:Target + '&format=jpeg') '' $photoFile)
          if (!(Test-Path -LiteralPath $photoFile -PathType Leaf)) { throw 'screenshot_missing' }
          $postRecord.photos+=@{url=$photoUrl;file=$photoFile;readiness=$photoReady;reviewed=$false}
          [IO.File]::WriteAllText((Join-Path $bulkOut ($postId + '.json')), (ConvertTo-PublicJson $postRecord), [Text.UTF8Encoding]::new($false))
        }
        $bulkState.completed+=@{url=$url;postId=$postId;photoCount=$postRecord.photos.Count;textTruncated=$bodyRead.value.truncated;linksTruncated=$linksRead.value.truncated}
        Save-BulkState
        Write-Public @{type='bulk_post_saved';source=$url;photoCount=$postRecord.photos.Count;count=$bulkState.completed.Count;reviewed=$false}
      }
      $bulkState.state='collected';$bulkState.stage='collected';$bulkState.current=$null;Save-BulkState
      Write-Public @{type='bulk_terminal';state='collected';group=$Command.group;count=$bulkState.completed.Count;reviewed=$false;complete=$false}
    } catch {
      $bulkState.state='stopped'
      if (!$bulkState.error) {
        $knownErrors=@('source_url_mismatch','article_text_unavailable','post_permalink_unverified','photo_url_mismatch','screenshot_missing','login_or_verification_required','article_not_ready_within_budget','photo_not_ready_within_budget','image_readiness_capability_missing')
        $bulkState.error=if ($_.Exception.Message -in $knownErrors) { $_.Exception.Message } else { 'bounded_step_failed' }
        $bulkState.failure=@{stage=$bulkState.stage;code=$bulkState.error;unknown=$false}
      }
      Save-BulkState
      Write-Public @{type='bulk_terminal';state='stopped';group=$Command.group;count=$bulkState.completed.Count;failure=$bulkState.failure;reviewed=$false;complete=$false}
    }
    return
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
  if (![uri]::TryCreate($InitialUrl, [UriKind]::Absolute, [ref]$initial) -or
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
  $createPath = '/new?activate=true&url=' + [uri]::EscapeDataString($InitialUrl)
  $created = $null
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    $result = Invoke-SessionRequest -Method POST -Path $createPath
    if ($result.ok -and $result.data.ready -eq $true -and $result.data.targetId -and
        $result.data.leaseToken -and $result.data.manageToken) { $created = $result.data; break }
    $script:CreationUnknown = $result.unknown -or ($result.ok -and $null -eq $result.data.ready)
    # Only an unknown response receives one recovery. Identical key and route.
    if (!$script:CreationUnknown) { break }
  }
  if ($null -eq $created) {
    $script:SessionExitCode = 1
    Write-Public @{ ok = $false; type = 'startup_error'; created = $false; creationUnknown = $script:CreationUnknown;
      error = @{ code = $(if ($script:CreationUnknown) { 'creation_unconfirmed' } else { 'creation_failed' }) } }
  } else {
    $env:CDP_LEASE = [string]$created.leaseToken
    $env:CDP_MANAGE = [string]$created.manageToken
    $script:Target = [string]$created.targetId
    $script:OwnsPage = $true
    $created = $null; $result = $null
    Write-Public @{ type = 'ready'; ready = $true; owner = $Owner; targetId = $script:Target; pid = $PID }
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
    } elseif ($script:CreationUnknown) {
      Write-Public @{ type = 'cleanup'; closed = $false; reason = 'creation_unconfirmed'; error = @{ code = 'cleanup_unconfirmed' } }
    }
  } finally {
    Remove-Item Env:CDP_LEASE, Env:CDP_MANAGE, Env:CDP_REQUEST_ID -ErrorAction SilentlyContinue
  }
}
exit $script:SessionExitCode
