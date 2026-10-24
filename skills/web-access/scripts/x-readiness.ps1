# Public DOM only. Request failures stop immediately; polling never navigates or recovers.
function Wait-XPublicContent {
  param(
    [ValidateSet('Post','Photo')][string]$Kind,
    [string]$Url, [string]$Handle, [string]$Target,
    [scriptblock]$Call,
    [ValidateRange(1,12)][int]$MaxAttempts=8,
    [ValidateRange(1,30000)][int]$BudgetMilliseconds=15000,
    [ValidateRange(0,3000)][int]$PollMilliseconds=750
  )
  $clock=[Diagnostics.Stopwatch]::StartNew()
  $lastFingerprint=$null
  for($attempt=1; $attempt -le $MaxAttempts; $attempt++) {
    if($clock.ElapsedMilliseconds -ge $BudgetMilliseconds){break}
    $info=& $Call 'GET' ("/info?target=$Target") ''
    if($info.page.url -match '^https://(?:www\.)?x\.com/(?:i/flow/|account/access|login)'){throw 'login_or_verification_required'}
    if($info.page.url -ne $Url){throw 'source_url_mismatch'}
    if($Kind -eq 'Post') {
      $body=& $Call 'POST' ("/dom/query?target=$Target") '{"kind":"text","selector":"article","visibility":"rendered","maxChars":16000}'
      $links=& $Call 'POST' ("/dom/query?target=$Target") '{"kind":"elements","selector":"article a[href]","visibility":"rendered","limit":50,"fields":["text","href"]}'
      $ready=$body.value.found -and $body.value.text -match ('(?i)@'+[regex]::Escape($Handle)+'\b') -and @($links.value.items|Where-Object href -eq $Url).Count -gt 0
      if($ready){
        $after=& $Call 'GET' ("/info?target=$Target") ''
        if($after.page.url -ne $Url){throw 'source_url_mismatch'}
        return @{info=$info;body=$body;links=$links;attempts=$attempt;elapsedMs=$clock.ElapsedMilliseconds}
      }
    } else {
      # The modal is required: background thumbnails cannot satisfy photo readiness.
      $snapshot=& $Call 'POST' ("/research/snapshot?target=$Target") '{"recipe":"generic-posts"}'
      $images=$snapshot.value.page_state.photo_readiness
      if ($images.version -ne 1) {throw 'image_readiness_capability_missing'}
      $allVisible=@($images.items|Where-Object {$_.imageState.inPhotoPage -and $_.src -match '^https://pbs\.twimg\.com/media/'})
      $loaded=@($allVisible|Where-Object {$_.imageState.complete -and $_.imageState.naturalWidth -gt 0 -and $_.imageState.naturalHeight -gt 0 -and $_.imageState.inViewport})
      if($loaded.Count -gt 0 -and $loaded.Count -eq $allVisible.Count -and !$images.truncated){
        $fingerprint=(@($loaded|ForEach-Object {$_.src+'|'+$_.imageState.naturalWidth+'x'+$_.imageState.naturalHeight}) -join ';')
        if($fingerprint -eq $lastFingerprint){
          $after=& $Call 'GET' ("/info?target=$Target") ''
          if($after.page.url -ne $Url){throw 'source_url_mismatch'}
          return @{info=$info;images=$images;attempts=$attempt;elapsedMs=$clock.ElapsedMilliseconds;visualReviewRequired=$true}
        }
        $lastFingerprint=$fingerprint
      } else {$lastFingerprint=$null}
    }
    $remaining=$BudgetMilliseconds-$clock.ElapsedMilliseconds
    if($remaining -le 0){break}
    if($PollMilliseconds -gt 0){Start-Sleep -Milliseconds ([Math]::Min($PollMilliseconds,$remaining))}
  }
  if($Kind -eq 'Post'){throw 'article_not_ready_within_budget'}
  throw 'photo_not_ready_within_budget'
}
