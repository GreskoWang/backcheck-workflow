function Get-BridgeProcessRecord {
    param([Parameter(Mandatory)][int]$ProcessId)
    try {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    }
    catch {
        throw "Cannot verify process identity for PID $ProcessId through CIM."
    }
    if (-not $processInfo) { return $null }
    if ([string]::IsNullOrWhiteSpace([string]$processInfo.CommandLine) -or -not $processInfo.CreationDate) {
        throw "Process identity for PID $ProcessId is incomplete."
    }
    [pscustomobject]@{
        Pid = [int]$processInfo.ProcessId
        Name = [string]$processInfo.Name
        CommandLine = [string]$processInfo.CommandLine
        CreatedAt = [DateTimeOffset]$processInfo.CreationDate
    }
}

function Test-BridgeEntryArgument {
    param(
        [Parameter(Mandatory)][string]$CommandLine,
        [Parameter(Mandatory)][string]$EntryPath
    )
    $escapedPath = [regex]::Escape([IO.Path]::GetFullPath($EntryPath))
    $pattern = '(?i)(?:^|\s)(?:"' + $escapedPath + '"|' + $escapedPath + ')(?=\s|$)'
    [regex]::IsMatch($CommandLine, $pattern)
}

function Test-BridgeProcessRecord {
    param(
        [Parameter(Mandatory)]$Record,
        [Parameter(Mandatory)][string]$EntryPath
    )
    $Record.Name -ieq 'node.exe' -and
        (Test-BridgeEntryArgument -CommandLine $Record.CommandLine -EntryPath $EntryPath)
}

function Test-BridgeLockOwnership {
    param(
        [Parameter(Mandatory)]$Record,
        [Parameter(Mandatory)]$Owner,
        [Parameter(Mandatory)][string]$EntryPath
    )
    if (-not (Test-BridgeProcessRecord -Record $Record -EntryPath $EntryPath)) { return $false }
    if ($Record.Pid -ne [int]$Owner.pid -or [string]::IsNullOrWhiteSpace([string]$Owner.token)) {
        return $false
    }
    try {
        $lockCreatedAt = if ($Owner.createdAt -is [DateTime]) {
            [DateTimeOffset]$Owner.createdAt
        } else {
            [DateTimeOffset]::Parse([string]$Owner.createdAt)
        }
    }
    catch { throw 'Instance lock creation time is invalid.' }
    $Record.CreatedAt -le $lockCreatedAt.AddSeconds(1)
}

function Get-BridgeProcessesByEntry {
    param([Parameter(Mandatory)][string]$EntryPath)
    try {
        $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
    }
    catch {
        throw 'Cannot enumerate Node processes to verify bridge single-instance ownership.'
    }
    foreach ($processInfo in $processes) {
        if ([string]::IsNullOrWhiteSpace([string]$processInfo.CommandLine)) {
            throw 'A Node process has no readable command line; bridge identity is unverified.'
        }
        if (Test-BridgeEntryArgument -CommandLine $processInfo.CommandLine -EntryPath $EntryPath) {
            Get-BridgeProcessRecord -ProcessId ([int]$processInfo.ProcessId)
        }
    }
}
