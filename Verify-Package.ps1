#requires -Version 7.2
[CmdletBinding()]
param([string]$PythonPath)
$ErrorActionPreference='Stop'
if (!$PythonPath) {
  $runtime=Join-Path $PSScriptRoot 'config\runtime-paths.json'
  if(Test-Path -LiteralPath $runtime){$PythonPath=(Get-Content -LiteralPath $runtime -Raw|ConvertFrom-Json).env.RESEARCH_PYTHON}
  else {$PythonPath=(Get-Command python -CommandType Application -ErrorAction Stop).Source}
}
& $PythonPath (Join-Path $PSScriptRoot 'scripts\package.py')
exit $LASTEXITCODE
