# ASCII-only source so Windows PowerShell 5.1 can load it without a BOM.
function Read-StrictUtf8Json {
  param(
    [Parameter(Mandatory=$true)][string]$LiteralPath,
    [Parameter(Mandatory=$true)][string]$Label
  )
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  try {
    $raw = [System.IO.File]::ReadAllText($LiteralPath, $utf8)
  } catch [System.Text.DecoderFallbackException] {
    throw "diagnostic_utf8_invalid:$Label"
  } catch {
    throw "diagnostic_file_unavailable:$Label"
  }
  try {
    return ConvertFrom-Json -InputObject $raw -ErrorAction Stop
  } catch {
    throw "diagnostic_json_invalid:$Label"
  }
}

function Read-SharedUtf8Lines {
  param([Parameter(Mandatory=$true)][string]$LiteralPath)
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $stream = $null
  $reader = $null
  try {
    # Codex keeps a writable session handle open. ReadAllLines uses a read-only
    # sharing mode that can conflict with that writer on Windows PowerShell 5.1.
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $stream = New-Object System.IO.FileStream($LiteralPath,
      [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    $reader = New-Object System.IO.StreamReader($stream, $utf8, $true)
    $raw = $reader.ReadToEnd()
    return @($raw -split "`n" | ForEach-Object { $_.TrimEnd("`r") } | Where-Object { $_ })
  } catch [System.Text.DecoderFallbackException] {
    throw 'diagnostic_utf8_invalid:session'
  } catch [System.IO.IOException] {
    $win32 = $_.Exception.HResult -band 0xffff
    if ($win32 -eq 32 -or $win32 -eq 33) { throw 'diagnostic_file_busy:session' }
    throw 'diagnostic_file_unavailable:session'
  } catch {
    throw 'diagnostic_file_unavailable:session'
  } finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function ConvertTo-AsciiJson {
  param([Parameter(Mandatory=$true)]$Value)
  $json = ConvertTo-Json -InputObject $Value -Depth 8 -Compress
  $builder = New-Object System.Text.StringBuilder
  foreach ($character in $json.ToCharArray()) {
    if ([int][char]$character -gt 127) {
      [void]$builder.Append(('\u{0:x4}' -f [int][char]$character))
    } else {
      [void]$builder.Append($character)
    }
  }
  return $builder.ToString()
}

function Invoke-SafeNodeJson {
  param(
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$ScriptPath,
    [string]$Marker = 'SYNTHETIC_COMPANY_REMOTE_JSON:',
    [int]$TimeoutMs = 60000
  )
  if (-not [System.IO.File]::Exists($NodePath) -or -not [System.IO.File]::Exists($ScriptPath)) {
    return [pscustomobject]@{ status = 'reader_path_unavailable'; reasonCode = 'missing_executable_or_script' }
  }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $NodePath
  $start.Arguments = '"' + $ScriptPath.Replace('"', '\"') + '"'
  $start.WorkingDirectory = Split-Path -Parent $ScriptPath
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  try {
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMs)) {
      try { $process.Kill() } catch {}
      [void]$process.WaitForExit(5000)
      return [pscustomobject]@{ status = 'reader_timeout'; reasonCode = 'node_timeout' }
    }
    $stdout = [string]$stdoutTask.Result
    $stderr = [string]$stderrTask.Result
    $marked = @($stdout -split "`r?`n" | Where-Object { $_.StartsWith($Marker) })
    if ($marked.Count -ne 1) {
      return [pscustomobject]@{
        status = 'reader_output_invalid'
        reasonCode = if ($marked.Count -eq 0) { 'marker_missing' } else { 'multiple_markers' }
        nodeExitCode = $process.ExitCode
        stderrPresent = $stderr.Length -gt 0
      }
    }
    try {
      $value = ConvertFrom-Json -InputObject $marked[0].Substring($Marker.Length) -ErrorAction Stop
      if ($process.ExitCode -ne 0) {
        return [pscustomobject]@{
          status = 'reader_nonzero_exit'
          reasonCode = 'node_nonzero_exit'
          nodeExitCode = $process.ExitCode
          stderrPresent = $stderr.Length -gt 0
        }
      }
      return $value
    } catch {
      return [pscustomobject]@{
        status = 'reader_output_invalid'
        reasonCode = 'marked_json_invalid'
        nodeExitCode = $process.ExitCode
        stderrPresent = $stderr.Length -gt 0
      }
    }
  } catch {
    return [pscustomobject]@{ status = 'reader_process_failed'; reasonCode = 'spawn_or_wait_failed' }
  } finally {
    $process.Dispose()
  }
}

function Get-SyntheticCompanyProcessRole {
  param(
    [Parameter(Mandatory=$true)]$Candidate,
    [Parameter(Mandatory=$true)][string]$ThreadId,
    [Parameter(Mandatory=$true)][datetime]$StartedUtc,
    [int]$DiagnosticParentPid = 0
  )
  $command = [string]$Candidate.CommandLine
  $isRecovery = $command.Contains('resume-synthetic_company-once.mjs')
  if ($isRecovery -and $DiagnosticParentPid -gt 0 -and
      [int]$Candidate.ProcessId -eq $DiagnosticParentPid) { return $null }
  if ($command.Contains('run-synthetic_company-once.mjs')) { return 'one_time_parent' }
  if ($isRecovery) { return 'recovery_parent' }
  if ($command.Contains($ThreadId)) { return 'bound_resume' }
  if ($Candidate.Name -eq 'codex.exe' -and
      ([datetime]$Candidate.CreationDate).ToUniversalTime() -ge $StartedUtc) {
    return 'recent_codex_candidate'
  }
  return $null
}
