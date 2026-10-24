[CmdletBinding()]
param(
  [ValidateSet('GET', 'POST')]
  [string] $Method = 'GET',

  [Parameter(Mandatory = $true)]
  [string] $Path,

  [string] $Owner = $env:CDP_OWNER,

  [AllowEmptyString()]
  [string] $Body = '',

  [string] $OutFile,

  [int] $Port = $(if ($env:CDP_PROXY_PORT) { [int]$env:CDP_PROXY_PORT } else { 3456 })
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$Lease = $env:CDP_LEASE
$Manage = $env:CDP_MANAGE
$RequestId = $env:CDP_REQUEST_ID
$base = "http://127.0.0.1:$Port"
$uri = if ($Path.StartsWith('/')) { "$base$Path" } else { "$base/$Path" }

if ($Path -eq '/health') {
  $response = Invoke-WebRequest -UseBasicParsing -Method GET -Uri $uri -TimeoutSec 3
  $response.Content
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Owner)) {
  throw 'Owner is required. Pass -Owner or set CDP_OWNER.'
}
if (($Path.StartsWith('/new') -or $Path.StartsWith('/acquire')) -and [string]::IsNullOrWhiteSpace($RequestId)) {
  throw 'New/acquire requires a stable random CDP_REQUEST_ID environment value. Reuse the same value if the response is lost.'
}

$tokenDir = if ($env:CDP_PROXY_TOKEN_DIR) { $env:CDP_PROXY_TOKEN_DIR } else { Join-Path $env:USERPROFILE '.codex\cdp-proxy' }
$tokenFile = Join-Path $tokenDir "$Port.token"
if (!(Test-Path -LiteralPath $tokenFile)) {
  throw "Broker token file not found: $tokenFile"
}
$token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
if ($token.Length -lt 32) { throw 'Broker token file is invalid.' }

$headers = @{ Authorization = "Bearer $token"; 'X-CDP-Owner' = $Owner }
if (![string]::IsNullOrWhiteSpace($Lease)) { $headers['X-CDP-Lease'] = $Lease }
if (![string]::IsNullOrWhiteSpace($Manage)) { $headers['X-CDP-Manage'] = $Manage }
if (![string]::IsNullOrWhiteSpace($RequestId)) { $headers['X-CDP-Request-Id'] = $RequestId }
$params = @{ UseBasicParsing = $true; Method = $Method; Uri = $uri; Headers = $headers; TimeoutSec = 20; SkipHttpErrorCheck = $true }
if ($Method -eq 'POST') {
  $params.ContentType = if ($Path.StartsWith('/dom/query')) { 'application/json; charset=utf-8' } else { 'text/plain; charset=utf-8' }
  $params.Body = $Body
}
$pendingFile = $null
if ($OutFile) {
  $destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
  $pendingFile = Join-Path (Split-Path -Parent $destination) ('.cdp-response-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $params.OutFile = $pendingFile
  $params.PassThru = $true
}

try {
  $response = Invoke-WebRequest @params
  if ([int]$response.StatusCode -ge 400) {
    if ($pendingFile) { [IO.File]::ReadAllText($pendingFile) } else { $response.Content }
    exit 1
  }
  if ($pendingFile) {
    if (([uri]$uri).AbsolutePath -eq '/screenshot') {
      $stream = [IO.File]::OpenRead($pendingFile)
      try {
        $signature = [byte[]]::new(8)
        $count = $stream.Read($signature, 0, $signature.Length)
      } finally { $stream.Dispose() }
      $contentType = ([string]$response.Headers['Content-Type']).Split(';')[0].Trim().ToLowerInvariant()
      $isPng = $contentType -eq 'image/png' -and $count -eq 8 -and [Convert]::ToHexString($signature) -eq '89504E470D0A1A0A'
      $isJpeg = $contentType -eq 'image/jpeg' -and $count -ge 3 -and $signature[0] -eq 255 -and $signature[1] -eq 216 -and $signature[2] -eq 255
      if (!$isPng -and !$isJpeg) {
        @{ ok = $false; error = @{ code = 'screenshot_invalid_response'; message = 'Screenshot response has no matching PNG/JPEG content type and signature; destination was not changed.' } } | ConvertTo-Json -Compress
        exit 1
      }
    }
    [IO.File]::Move($pendingFile, $destination, $true)
  } else { $response.Content }
} catch {
  if ($_.ErrorDetails.Message) {
    $_.ErrorDetails.Message
  } else {
    throw
  }
  exit 1
} finally {
  if ($pendingFile -and (Test-Path -LiteralPath $pendingFile)) { Remove-Item -LiteralPath $pendingFile -Force }
}
