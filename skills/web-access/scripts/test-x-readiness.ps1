$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'x-readiness.ps1')
$url='https://x.com/example/status/1234567890123456789'
$script:probe=0; $script:calls=@()
$mock={param($method,$route,$body)
  $script:calls+=@{method=$method;route=$route}
  if($route.StartsWith('/info?')){
    if($script:mode -eq 'tool_timeout'){throw 'cdp_timeout'}
    return @{page=@{url=$(if($script:mode -eq 'login'){'https://x.com/i/flow/login'}else{$url})}}
  }
  $q=$body|ConvertFrom-Json
  if($q.kind -eq 'text'){
    $script:probe++
    return @{value=@{found=($script:mode -ne 'never' -and $script:probe -ge 3);text='Example @example full original text';truncated=$false}}
  }
  if($q.recipe -eq 'generic-posts'){
    $script:probe++
    return @{value=@{page_state=@{photo_readiness=@{version=1;items=@(@{src='https://pbs.twimg.com/media/fixture.jpg';imageState=@{complete=($script:probe -ge 2);naturalWidth=$(if($script:mode -eq 'broken'){0}else{800});naturalHeight=600;inViewport=$true;inPhotoPage=$true}});truncated=$false}}}}
  }
  return @{value=@{items=@(@{href=$url});truncated=$false}}
}
$cases=@(
  @{name='delayed_post';kind='Post';expected='ready';attempts=3},
  @{name='never';kind='Post';expected='article_not_ready_within_budget';attempts=4},
  @{name='tool_timeout';kind='Post';expected='cdp_timeout';attempts=0},
  @{name='login';kind='Post';expected='login_or_verification_required';attempts=0},
  @{name='delayed_photo';kind='Photo';expected='ready';attempts=3},
  @{name='broken';kind='Photo';expected='photo_not_ready_within_budget';attempts=4}
)
foreach($case in $cases){
  $script:mode=$case.name; $script:probe=0; $script:calls=@(); $result=$null; $errorCode=$null
  try {$result=Wait-XPublicContent -Kind $case.kind -Url $url -Handle example -Target fixture -Call $mock -MaxAttempts 4 -PollMilliseconds 0}
  catch {$errorCode=$_.Exception.Message}
  if($case.expected -eq 'ready'){
    if(!$result -or $result.attempts -ne $case.attempts){throw "Readiness failed: $($case.name)"}
  } elseif($errorCode -ne $case.expected){throw "Unexpected error: $($case.name): $errorCode"}
  if($script:probe -ne $case.attempts){throw "Wrong bounded attempt count: $($case.name)"}
  if(@($script:calls|Where-Object {$_.route -notmatch '^/(info|dom/query|research/snapshot)\?target=fixture$'}).Count){throw 'Unexpected mutating route'}
  if($case.name -eq 'tool_timeout' -and $script:calls.Count -ne 1){throw 'Timeout was replayed'}
}
@{status='PASS';cases=$cases.Count;networkCalls=0;reloads=0;automaticRecoveries=0;scope='offline readiness fixtures'}|ConvertTo-Json -Compress
