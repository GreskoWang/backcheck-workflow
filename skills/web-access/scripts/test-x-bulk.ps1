$ErrorActionPreference='Stop'
$root=$PSScriptRoot
. (Join-Path $PSScriptRoot 'x-readiness.ps1')
$source=Join-Path $root 'x-original-bulk-session.ps1'
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'Production script parse failed' }
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('offline-x-client-'+[guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $fixtureRoot) { throw 'Fixture directory exists; preserve earlier run' }
[void][IO.Directory]::CreateDirectory($fixtureRoot)
$requestId='OFFLINE-REQUEST'
$url='https://x.com/example/status/2076120752273981709'
$manifest=@{requestId=$requestId;groups=@{happy=@(@{url=$url});timeout=@(@{url=$url});missing=@(@{url=$url})}}
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'x-original-queue.json'),($manifest|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$definition=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-SessionCommand'},$false)
$definitionText=$definition.Extent.Text
$ManifestPath=Join-Path $fixtureRoot 'x-original-queue.json'
$OutputRoot=$fixtureRoot
$RequestId='OFFLINE-REQUEST'
$ExpectedHandle='example'
. ([scriptblock]::Create($definitionText))
$script:Target='offline-fixture'; $Owner='offline-fixture'
$script:mockCurrentUrl=$null; $script:infoCalls=0
function ConvertTo-PublicJson($Value) { ConvertTo-Json -InputObject $Value -Depth 40 -Compress }
function Write-Public($Value) { }
function Invoke-SessionRequest {
  param($Method,$Path,$Body='',$OutFile)
  if ($Path.StartsWith('/navigate?')) {
    $script:mockCurrentUrl=[uri]::UnescapeDataString(($Path -split '&url=',2)[1])
    return @{ok=$true;data=@{ok=$true}}
  }
  if ($Path.StartsWith('/info?')) {
    $script:infoCalls++
    if ($script:offlineMode -eq 'timeout') { return @{ok=$false;code='cdp_timeout';unknown=$true} }
    return @{ok=$true;data=@{page=@{url=$script:mockCurrentUrl}}}
  }
  if ($Path.StartsWith('/dom/query?')) {
    $q=$Body|ConvertFrom-Json
    if ($q.kind -eq 'text') {
      if ($q.selector -eq 'main') { return @{ok=$true;data=@{value=@{found=$true;text='相关用户 Example @example';truncated=$false}}} }
      if ($script:offlineMode -eq 'missing') { return @{ok=$true;data=@{value=@{found=$false;text='';truncated=$false}}} }
      return @{ok=$true;data=@{value=@{found=$true;text=('Example @example '+('正文'*600)+' END_OF_POST');truncated=$false}}}
    }
    if ($q.selector -eq 'article') { return @{ok=$true;data=@{value=@{items=@(@{text='Example @example 短摘要'});truncated=$false}}} }
    return @{ok=$true;data=@{value=@{items=@(@{href=$script:mockCurrentUrl;text='时间'});truncated=$false}}}
  }
  throw 'Unexpected mock route; no network is available in this test'
}
$results=@()
foreach($case in @('happy','timeout','missing')) {
  $script:offlineMode=$case; $script:infoCalls=0
  Invoke-SessionCommand ([pscustomobject]@{action='bulk';group=$case})
  $out=Join-Path $fixtureRoot ('x-original-bulk-'+$case)
  $state=Get-Content -LiteralPath (Join-Path $out 'state.json') -Raw|ConvertFrom-Json
  if($case -eq 'happy') {
    $post=Get-Content -LiteralPath (Join-Path $out '2076120752273981709.json') -Raw|ConvertFrom-Json
    if($state.state -ne 'collected' -or $post.mainText.value.text -notmatch 'END_OF_POST$' -or $post.mainText.value.text.Length -le 1000 -or $post.complete -or $post.articleOverviewComplete) { throw 'Complete article text was not preserved honestly' }
  } elseif($case -eq 'timeout') {
    if($state.error -ne 'cdp_timeout' -or $state.failure.stage -ne 'wait_post_ready' -or $script:infoCalls -ne 1 -or $state.completed.Count -ne 0) { throw 'Failure stage/code/retry count not preserved' }
  } elseif($state.error -ne 'article_not_ready_within_budget' -or $state.completed.Count -ne 0) { throw 'Missing article incorrectly accepted' }
  $results+=@{case=$case;pass=$true;state=$state.state;error=$state.error;stage=$state.stage}
}
$summary=@{status='offline_only';networkCalls=0;browserOperations=0;productionCacheModified=$false;cases=$results;onlineRestored=$false}
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'results.json'),($summary|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$summary|ConvertTo-Json -Depth 8
