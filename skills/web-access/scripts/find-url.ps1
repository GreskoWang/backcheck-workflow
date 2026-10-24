param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Args
)

$runner = Join-Path $PSScriptRoot 'run-node.ps1'
$script = Join-Path $PSScriptRoot 'find-url.mjs'

& $runner $script @Args
exit $LASTEXITCODE
