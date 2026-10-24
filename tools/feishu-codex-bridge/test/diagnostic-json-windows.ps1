# Run by powershell.exe 5.1, not pwsh. Source is ASCII for BOM-free compatibility.
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\diagnostic-json.ps1')
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ('diagnostic-json-test-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $tempRoot)
try {
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $chinese = ([char]0x4e2d).ToString() + ([char]0x6587).ToString()
  $japanese = ([char]0x65e5).ToString() + ([char]0x672c).ToString() + ([char]0x8a9e).ToString()
  $tail = ([char]0x672b).ToString() + ([char]0x5c3e).ToString() + $chinese
  $validPath = Join-Path $tempRoot 'valid.json'
  $validJson = '{"subject":"' + $chinese + $japanese + '","tail":"' + $tail + '"}'
  [System.IO.File]::WriteAllText($validPath, $validJson, $utf8)
  $bytes = [System.IO.File]::ReadAllBytes($validPath)
  if ($bytes.Length -lt 3 -or ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)) {
    throw 'fixture_has_bom'
  }
  $parsed = Read-StrictUtf8Json -LiteralPath $validPath -Label 'valid'
  if ($parsed.subject -cne ($chinese + $japanese) -or $parsed.tail -cne $tail) {
    throw 'utf8_roundtrip_failed'
  }
  $ascii = ConvertTo-AsciiJson -Value $parsed
  if ($ascii -match '[^\x00-\x7f]') { throw 'ascii_output_failed' }
  $again = ConvertFrom-Json -InputObject $ascii -ErrorAction Stop
  if ($again.tail -cne $tail) { throw 'ascii_json_roundtrip_failed' }

  $badJsonPath = Join-Path $tempRoot 'invalid.json'
  [System.IO.File]::WriteAllText($badJsonPath, '{"secret":"DO_NOT_ECHO_HISTORY","tail":', $utf8)
  $badJsonError = ''
  try { $null = Read-StrictUtf8Json -LiteralPath $badJsonPath -Label 'invalid' }
  catch { $badJsonError = [string]$_.Exception.Message }
  if ($badJsonError -cne 'diagnostic_json_invalid:invalid' -or
      $badJsonError.Contains('DO_NOT_ECHO_HISTORY')) { throw 'json_error_not_redacted' }

  $badUtf8Path = Join-Path $tempRoot 'invalid-utf8.json'
  [System.IO.File]::WriteAllBytes($badUtf8Path, [byte[]]@(123, 34, 120, 34, 58, 255, 125))
  $badUtf8Error = ''
  try { $null = Read-StrictUtf8Json -LiteralPath $badUtf8Path -Label 'invalid_utf8' }
  catch { $badUtf8Error = [string]$_.Exception.Message }
  if ($badUtf8Error -cne 'diagnostic_utf8_invalid:invalid_utf8') {
    throw 'utf8_error_not_redacted'
  }

  $sessionPath = Join-Path $tempRoot 'held-session.jsonl'
  [System.IO.File]::WriteAllText($sessionPath, '{"type":"event_msg"}' + "`n", $utf8)
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $writer = New-Object System.IO.FileStream($sessionPath,
    [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, $share)
  try {
    $sharedRows = @(Read-SharedUtf8Lines -LiteralPath $sessionPath)
    if ($sharedRows.Count -ne 1 -or $sharedRows[0] -cne '{"type":"event_msg"}') {
      throw 'shared_session_read_failed'
    }
  } finally { $writer.Dispose() }

  $nodePath = (Get-Command node -ErrorAction Stop).Source
  $markedPath = Join-Path $tempRoot 'marked.mjs'
  [System.IO.File]::WriteAllText($markedPath, @'
process.stderr.write('SECRET_NEVER_PRINT\n');
process.stdout.write('SYNTHETIC_COMPANY_REMOTE_JSON:{"status":"ok"}\n');
'@, $utf8)
  $marked = Invoke-SafeNodeJson -NodePath $nodePath -ScriptPath $markedPath
  if ($marked.status -cne 'ok' -or (ConvertTo-AsciiJson -Value $marked).Contains('SECRET_NEVER_PRINT')) {
    throw 'marked_reader_failed'
  }
  $unmarkedPath = Join-Path $tempRoot 'unmarked.mjs'
  [System.IO.File]::WriteAllText($unmarkedPath, @'
process.stderr.write('SECRET_NEVER_PRINT\n');
process.stdout.write('HISTORY_SENSITIVE\n');
'@, $utf8)
  $unmarked = Invoke-SafeNodeJson -NodePath $nodePath -ScriptPath $unmarkedPath
  $unmarkedJson = ConvertTo-AsciiJson -Value $unmarked
  if ($unmarked.reasonCode -cne 'marker_missing' -or
      $unmarkedJson.Contains('SECRET_NEVER_PRINT') -or
      $unmarkedJson.Contains('HISTORY_SENSITIVE')) { throw 'unmarked_reader_not_redacted' }

  $nonzeroPath = Join-Path $tempRoot 'nonzero.mjs'
  [System.IO.File]::WriteAllText($nonzeroPath, @'
process.stderr.write('SECRET_NEVER_PRINT\n');
process.stdout.write('SYNTHETIC_COMPANY_REMOTE_JSON:{"status":"checked_with_existing_app_identity"}\n');
process.exitCode = 7;
'@, $utf8)
  $nonzero = Invoke-SafeNodeJson -NodePath $nodePath -ScriptPath $nonzeroPath
  if ($nonzero.status -cne 'reader_nonzero_exit' -or $nonzero.nodeExitCode -ne 7 -or
      (ConvertTo-AsciiJson -Value $nonzero).Contains('SECRET_NEVER_PRINT')) {
    throw 'nonzero_reader_misclassified'
  }

  $fake = [pscustomobject]@{ ProcessId = 123; Name = 'node.exe';
    CommandLine = 'node resume-synthetic_company-once.mjs --execute'; CreationDate = [datetime]::UtcNow }
  $started = [datetime]::UtcNow.AddMinutes(-1)
  if ((Get-SyntheticCompanyProcessRole -Candidate $fake -ThreadId 'thread-1' -StartedUtc $started) -cne
      'recovery_parent') { throw 'recovery_process_not_classified' }
  if (Get-SyntheticCompanyProcessRole -Candidate $fake -ThreadId 'thread-1' -StartedUtc $started `
      -DiagnosticParentPid 123) { throw 'own_recovery_process_not_excluded' }

  Write-Output '{"ok":true,"shell":"Windows PowerShell 5.1","cases":10}'
} finally {
  $resolved = [System.IO.Path]::GetFullPath($tempRoot)
  if ($resolved.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $resolved).StartsWith('diagnostic-json-test-')) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
