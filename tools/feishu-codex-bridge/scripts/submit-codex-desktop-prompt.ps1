[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedPromptPath,

    [Parameter(Mandatory = $true)]
    [string]$Marker,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedProjectName,

    [switch]$ProbeOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
[Console]::InputEncoding = $OutputEncoding

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$resolvedPromptPath = (Resolve-Path -LiteralPath $ExpectedPromptPath).Path
$expectedPrompt = [System.IO.File]::ReadAllText($resolvedPromptPath, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($expectedPrompt)) {
    throw 'Expected prompt is empty.'
}
if (-not $expectedPrompt.Contains($Marker, [System.StringComparison]::Ordinal)) {
    throw 'Expected prompt does not contain the dispatch marker.'
}

$codexExecutablePaths = @(
    Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
        Where-Object {
            [string]::Equals(
                [string]$_.PackageFamilyName,
                'OpenAI.Codex_2p2nqsd0c76g0',
                [System.StringComparison]::OrdinalIgnoreCase
            )
        } |
        ForEach-Object {
            $candidatePath = [System.IO.Path]::GetFullPath(
                (Join-Path -Path $_.InstallLocation -ChildPath 'app\\ChatGPT.exe')
            )
            if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
                $candidatePath
            }
        } |
        Sort-Object -Unique
)
if ($codexExecutablePaths.Count -eq 0) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $sessionId = (Get-Process -Id $PID).SessionId
    throw "The registered OpenAI Codex AppX executable could not be verified for user=$identity sessionId=$sessionId."
}

function Get-GuardedCodexComposer {
    $candidates = @()
    $chatGptProcesses = @(
        Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 }
    )
    $observation = [ordered]@{
        visibleProcessCount = $chatGptProcesses.Count
        registeredWindowCount = 0
        exactEditorCount = 0
        enabledSendCount = 0
        disabledSendCount = 0
        exactProjectCount = 0
        loadingErrorCount = 0
        attachmentCount = 0
    }
    foreach ($chatGptProcess in $chatGptProcesses) {
        try {
            $processPath = [string]$chatGptProcess.Path
            $hasRegisteredExecutablePath = $false
            foreach ($registeredExecutablePath in $codexExecutablePaths) {
                if (
                    [string]::Equals(
                        $processPath,
                        $registeredExecutablePath,
                        [System.StringComparison]::OrdinalIgnoreCase
                    )
                ) {
                    $hasRegisteredExecutablePath = $true
                    break
                }
            }
            if (-not $hasRegisteredExecutablePath) {
                continue
            }
            $observation.registeredWindowCount++

            $root = [System.Windows.Automation.AutomationElement]::FromHandle($chatGptProcess.MainWindowHandle)
            if ($null -eq $root) { continue }
            if (
                $root.Current.ProcessId -ne $chatGptProcess.Id -or
                $root.Current.NativeWindowHandle -ne $chatGptProcess.MainWindowHandle
            ) {
                continue
            }
            if (
                -not [string]::Equals(
                    [string]$root.Current.ClassName,
                    'Chrome_WidgetWin_1',
                    [System.StringComparison]::Ordinal
                )
            ) {
                continue
            }
            $elements = $root.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )

            $matchingEditors = @()
            $sendButtons = @()
            $disabledSendButtons = @()
            $projectSelectors = @()
            $loadingErrors = @()
            $attachments = @()

            foreach ($element in $elements) {
                if ($element.Current.IsOffscreen) { continue }
                $controlType = $element.Current.ControlType
                $name = [string]$element.Current.Name

                # A prewarmed new draft can retain unrelated attachments even
                # when its text exactly matches the expected dispatch prompt.
                # Fail closed instead of submitting that extra material.
                if (
                    $controlType -eq [System.Windows.Automation.ControlType]::Button -and
                    ($name -match '(?i)^(?:remove|delete) (?:attachment|file|image)|^(?:移除|删除)(?:附件|文件|图片)|codex-clipboard-')
                ) {
                    $attachments += $element
                }

                if (
                    $controlType -eq [System.Windows.Automation.ControlType]::Edit -and
                    $element.Current.IsEnabled
                ) {
                    try {
                        $valuePattern = $element.GetCurrentPattern(
                            [System.Windows.Automation.ValuePattern]::Pattern
                        )
                        if (
                            [string]::Equals(
                                [string]$valuePattern.Current.Value,
                                $expectedPrompt,
                                [System.StringComparison]::Ordinal
                            )
                        ) {
                            $matchingEditors += $element
                        }
                    }
                    catch {
                        continue
                    }
                }

                if (
                    $controlType -eq [System.Windows.Automation.ControlType]::Button -and
                    [string]::Equals($name, '发送', [System.StringComparison]::Ordinal)
                ) {
                    if ($element.Current.IsEnabled) {
                        $sendButtons += $element
                    } else {
                        $disabledSendButtons += $element
                    }
                }

                if (
                    $controlType -eq [System.Windows.Automation.ControlType]::Button -and
                    $element.Current.IsEnabled -and
                    (
                        [string]::Equals(
                            $name,
                            "更改项目：$ExpectedProjectName",
                            [System.StringComparison]::Ordinal
                        ) -or
                        [string]::Equals(
                            $name,
                            "切换项目：$ExpectedProjectName",
                            [System.StringComparison]::Ordinal
                        )
                    )
                ) {
                    $projectSelectors += $element
                }

                if ($name.Contains('消息加载错误', [System.StringComparison]::Ordinal)) {
                    $loadingErrors += $element
                }
            }

            $observation.exactEditorCount += $matchingEditors.Count
            $observation.enabledSendCount += $sendButtons.Count
            $observation.disabledSendCount += $disabledSendButtons.Count
            $observation.exactProjectCount += $projectSelectors.Count
            $observation.loadingErrorCount += $loadingErrors.Count
            $observation.attachmentCount += $attachments.Count

            if (
                $matchingEditors.Count -eq 1 -and
                $sendButtons.Count -eq 1 -and
                $projectSelectors.Count -eq 1 -and
                $loadingErrors.Count -eq 0 -and
                $attachments.Count -eq 0
            ) {
                $candidates += [pscustomobject]@{
                    ProcessId = $chatGptProcess.Id
                    ProcessPath = $processPath
                    WindowHandle = $chatGptProcess.MainWindowHandle
                    RootRuntimeId = [string]::Join('.', $root.GetRuntimeId())
                    Root = $root
                    Editor = $matchingEditors[0]
                    SendButton = $sendButtons[0]
                }
            }
        }
        catch {
            continue
        }
    }

    $script:lastGuardObservation = $observation
    return @($candidates)
}

$deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
$candidates = @()
do {
    $candidates = @(Get-GuardedCodexComposer)
    if ($candidates.Count -gt 1) {
        throw "Expected exactly one guarded Codex composer, found $($candidates.Count)."
    }
    if ($candidates.Count -eq 0) {
        Start-Sleep -Milliseconds 250
    }
} while ($candidates.Count -eq 0 -and [DateTimeOffset]::UtcNow -lt $deadline)

if ($candidates.Count -ne 1) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $sessionId = (Get-Process -Id $PID).SessionId
    $counts = $script:lastGuardObservation | ConvertTo-Json -Compress
    throw "Timed out waiting for the uniquely guarded Codex composer; user=$identity sessionId=$sessionId controls=$counts."
}

$initialCandidate = $candidates[0]

# Re-enumerate immediately before invoking. This closes the gap where the
# selected window, editor value, project, or send control can change after the
# polling loop but before the click.
$freshCandidates = @(Get-GuardedCodexComposer)
if ($freshCandidates.Count -ne 1) {
    throw "Guarded Codex composer changed before invoke; found $($freshCandidates.Count)."
}
$candidate = $freshCandidates[0]
if (
    $candidate.ProcessId -ne $initialCandidate.ProcessId -or
    $candidate.WindowHandle -ne $initialCandidate.WindowHandle -or
    -not [string]::Equals(
        $candidate.RootRuntimeId,
        $initialCandidate.RootRuntimeId,
        [System.StringComparison]::Ordinal
    )
) {
    throw 'Guarded Codex composer identity changed before invoke.'
}

if ($ProbeOnly) {
    [pscustomobject]@{
        invoked = $false
        probeMatched = $true
        marker = $Marker
        processId = $candidate.ProcessId
        windowHandle = $candidate.WindowHandle
        composerMatches = 1
        sendMatches = 1
        projectMatches = 1
    } | ConvertTo-Json -Compress
    return
}

$invokePattern = $candidate.SendButton.GetCurrentPattern(
    [System.Windows.Automation.InvokePattern]::Pattern
)
$invokePattern.Invoke()

[pscustomobject]@{
    invoked = $true
    marker = $Marker
    processId = $candidate.ProcessId
    processPath = $candidate.ProcessPath
    windowHandle = $candidate.WindowHandle
    composerMatches = 1
    sendMatches = 1
    projectMatches = 1
    invokedAt = [DateTimeOffset]::Now.ToString('o')
} | ConvertTo-Json -Compress
