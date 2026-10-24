param([Parameter(Mandatory=$true)][string]$PayloadPath, [ValidateSet('stories','bugs')][string]$Kind = 'stories')
$ErrorActionPreference = 'Stop'
$passwordValue = [Environment]::GetEnvironmentVariable('ZENTAO_PASSWORD', 'User')
if ([string]::IsNullOrEmpty($passwordValue)) { throw 'ZENTAO_PASSWORD user variable unavailable' }
$authBody = @{ account = 'admin'; password = $passwordValue } | ConvertTo-Json
$authResult = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1/zentao/api.php/v1/tokens' -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($authBody))
$headers = @{ Token = $authResult.token }
$payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding utf8 | ConvertFrom-Json
$catalog = Invoke-RestMethod -Uri ('http://127.0.0.1/zentao/api.php/v1/products/1/' + $Kind + '?status=all&limit=500') -Headers $headers
if ([int]$catalog.total -ge 500) { throw 'Pagination required before deduplication' }
$existing = @($catalog.$Kind | Where-Object { $_.title -eq $payload.title })
$created = $false
if ($existing.Count -gt 0) { $storyId = $existing[0].id }
else {
  $json = $payload | ConvertTo-Json -Depth 8
  $result = Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1/zentao/api.php/v1/products/1/' + $Kind) -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
  $storyId = $result.id
  $created = $true
  if (-not $storyId) { throw 'Create outcome uncertain: inspect catalog before retry' }
}
$detail = Invoke-RestMethod -Uri ('http://127.0.0.1/zentao/api.php/v1/' + $Kind + '/' + $storyId) -Headers $headers
if ($detail.title -ne $payload.title) { throw 'Story identity verification failed' }
[pscustomobject]@{ id = $storyId; title = $detail.title; status = $detail.status; created = $created; verified = $true } | ConvertTo-Json
