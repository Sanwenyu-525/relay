# Disposable release EXE + PostgreSQL: kill the old Job after a real file effect
# while a test-only row lock prevents the original adapter receipt from saving.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $desktopRoot)
$releaseRoot = Join-Path $desktopRoot 'release'
$exe = Join-Path $releaseRoot 'relay-desktop.exe'
$node = Join-Path $workspaceRoot '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$seedHelper = Join-Path $PSScriptRoot 'm06-seed-file-write.mjs'
$lockHelper = Join-Path $PSScriptRoot 'm06-lock-file-write-receipt.mjs'
$webviewProbe = Join-Path $PSScriptRoot 'm06-probe-webview-no-receipt.mjs'
$bootstrapProbe = Join-Path $PSScriptRoot 'm03-probe-bootstrap.mjs'
$startSession = Join-Path $desktopRoot 'scripts\start-acceptance-session.ps1'
$stopSession = Join-Path $desktopRoot 'scripts\stop-acceptance-session.ps1'
$evidence = Join-Path $workspaceRoot 'docs\testing\evidence\m06-windows-job-no-receipt.txt'
$beforeScreenshot = Join-Path $workspaceRoot 'docs\testing\evidence\m06-webview-no-receipt-before.png'
$afterScreenshot = Join-Path $workspaceRoot 'docs\testing\evidence\m06-webview-no-receipt-after.png'
foreach ($required in @($exe, $node, $seedHelper, $lockHelper, $webviewProbe,
    $bootstrapProbe, $startSession, $stopSession)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing acceptance input: $required" }
}

function Get-Identity([int]$ProcessId) {
  $row = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $row) { return $null }
  return [pscustomobject]@{ pid = [int]$row.ProcessId;
    created_utc = ([datetime]$row.CreationDate).ToUniversalTime().ToString('o');
    executable = [string]$row.ExecutablePath }
}
function Test-SameProcess($Identity) {
  if ($null -eq $Identity) { return $false }
  $row = Get-Identity -ProcessId $Identity.pid
  return $null -ne $row -and $row.created_utc -eq $Identity.created_utc -and
    [string]::Equals($row.executable, $Identity.executable, [StringComparison]::OrdinalIgnoreCase)
}
function Wait-HostIdentity([int]$ProcessId) {
  $deadline = [datetime]::UtcNow.AddSeconds(5)
  do {
    $row = Get-Identity -ProcessId $ProcessId
    if ($null -ne $row) {
      if (-not [string]::Equals($row.executable, $exe, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Desktop PID belongs to another executable'
      }
      return $row
    }
    Start-Sleep -Milliseconds 100
  } while ([datetime]::UtcNow -lt $deadline)
  throw 'Desktop host identity unavailable'
}
function Stop-Host($Identity) {
  if (-not (Test-SameProcess $Identity)) { return }
  if (-not [string]::Equals($Identity.executable, $exe, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to stop a process outside the release EXE'
  }
  [Diagnostics.Process]::GetProcessById($Identity.pid).Kill()
  $deadline = [datetime]::UtcNow.AddSeconds(12)
  while ((Test-SameProcess $Identity) -and [datetime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if (Test-SameProcess $Identity) { throw 'Desktop host did not stop' }
}
function Get-JobIdentities($HostIdentity) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($HostIdentity.pid)")
  $api = @($children | Where-Object { $_.CommandLine -like '*dist\src\main.js*' })
  $supervisor = @($children | Where-Object { $_.CommandLine -like '*dist\src\worker\supervisor-main.js*' })
  if ($api.Count -ne 1 -or $supervisor.Count -ne 1) { throw 'Expected API and Supervisor sidecars' }
  $workers = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($supervisor[0].ProcessId)" |
    Where-Object { $_.CommandLine -like '*dist\src\worker\main.js*' })
  if ($workers.Count -ne 1) { throw 'Expected one old Worker' }
  $ids = @($HostIdentity, (Get-Identity -ProcessId ([int]$api[0].ProcessId)),
    (Get-Identity -ProcessId ([int]$supervisor[0].ProcessId)),
    (Get-Identity -ProcessId ([int]$workers[0].ProcessId)))
  if (@($ids | Where-Object { $null -eq $_ }).Count -ne 0) { throw 'Sidecar identity disappeared' }
  return $ids
}
function Assert-Stopped([object[]]$Identities) {
  $deadline = [datetime]::UtcNow.AddSeconds(12)
  do {
    if (@($Identities | Where-Object { Test-SameProcess $_ }).Count -eq 0) { return }
    Start-Sleep -Milliseconds 100
  } while ([datetime]::UtcNow -lt $deadline)
  throw 'Old desktop Job still has a live process'
}
function Write-Evidence([string]$Line) {
  Add-Content -LiteralPath $evidence -Value $Line -Encoding utf8
  Write-Host $Line
}

$sessionRoot = $null
$statePath = $null
$firstHost = $null
$restartHost = $null
$firstIdentity = $null
$restartIdentity = $null
$oldJob = @()
$locker = $null
$lockerIdentity = $null
$releaseMarker = $null
$completed = $false
$oldConfig = [Environment]::GetEnvironmentVariable('RELAY_DESKTOP_CONFIG_PATH', 'Process')
$oldData = [Environment]::GetEnvironmentVariable('RELAY_DESKTOP_DATA_ROOT', 'Process')
$oldWebview = [Environment]::GetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'Process')
Set-Content -LiteralPath $evidence -Value 'M06 packaged Windows Job no-receipt acceptance attempt' -Encoding utf8

try {
  $sessionId = [guid]::NewGuid().ToString('N')
  $sessionRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "relay-m02-acceptance-$sessionId"))
  & $startSession -SkipDesktop -InstallGraph -UseCLocale -SessionId $sessionId
  if ($LASTEXITCODE -ne 0) { throw 'Disposable acceptance session failed to start' }
  $statePath = Join-Path $sessionRoot 'session.json'
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if ($state.session_id -ne $sessionId -or $state.desktop_pid -ne 0 -or
      $state.release_exe -ne $exe -or
      $state.release_sha256 -ne (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw 'Session marker does not bind the exact release EXE'
  }
  Write-Evidence "release_sha256=$($state.release_sha256) session_id=$sessionId"

  function Invoke-Seed([string]$Phase, [string[]]$Extra = @()) {
    $output = @(& $node $seedHelper $Phase $sessionRoot @Extra)
    if ($LASTEXITCODE -ne 0) { throw "Seed helper failed in $Phase" }
    return (($output -join '').Trim() | ConvertFrom-Json)
  }
  function Wait-Facts([string]$OperationId, [string]$Phase, [scriptblock]$Ready,
      [int]$Seconds = 50) {
    $deadline = [datetime]::UtcNow.AddSeconds($Seconds)
    do {
      $facts = Invoke-Seed -Phase 'facts' -Extra @($OperationId)
      if (& $Ready $facts) { return $facts }
      Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $deadline)
    throw "$Phase timed out; last=$($facts | ConvertTo-Json -Compress -Depth 6)"
  }
  $seed = Invoke-Seed -Phase 'seed'
  $readyMarker = Join-Path $sessionRoot 'receipt-lock.ready'
  $releaseMarker = Join-Path $sessionRoot 'receipt-lock.release'
  $lockOut = Join-Path $sessionRoot 'receipt-lock.out'
  $lockErr = Join-Path $sessionRoot 'receipt-lock.err'
  $locker = Start-Process -FilePath $node -ArgumentList @($lockHelper, $sessionRoot,
    $seed.operation_id, $readyMarker, $releaseMarker) -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $lockOut -RedirectStandardError $lockErr
  $lockerIdentity = Get-Identity -ProcessId $locker.Id
  if ($null -eq $lockerIdentity -or
      -not [string]::Equals($lockerIdentity.executable, $node, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Receipt row-lock helper identity unavailable'
  }

  $env:RELAY_DESKTOP_CONFIG_PATH = [string]$state.config_path
  $env:RELAY_DESKTOP_DATA_ROOT = [string]$state.data_root
  $firstHost = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
  $state.desktop_pid = $firstHost.Id
  $state | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $statePath -Encoding utf8
  $firstIdentity = Wait-HostIdentity -ProcessId $firstHost.Id
  $waiting = Wait-Facts -OperationId $seed.operation_id -Phase 'approval' -Ready {
    param($facts)
    $null -ne $facts.operation -and $facts.operation.status -eq 'WAITING_APPROVAL'
  }
  $approved = Invoke-Seed -Phase 'approve' -Extra @($seed.run_id, $seed.operation_id)
  $deadline = [datetime]::UtcNow.AddSeconds(50)
  while (-not (Test-Path -LiteralPath $readyMarker -PathType Leaf) -and
      [datetime]::UtcNow -lt $deadline -and (Test-SameProcess $lockerIdentity)) {
    Start-Sleep -Milliseconds 50
  }
  if (-not (Test-Path -LiteralPath $readyMarker -PathType Leaf)) {
    throw "Receipt row lock was not acquired: $(Get-Content -LiteralPath $lockErr -Raw -ErrorAction SilentlyContinue)"
  }
  $locked = Get-Content -LiteralPath $readyMarker -Raw | ConvertFrom-Json
  $before = Wait-Facts -OperationId $seed.operation_id -Phase 'blocked receipt' -Ready {
    param($facts)
    $null -ne $facts.invocation -and $facts.invocation.id -eq $locked.invocation_id -and
      $facts.invocation.status -eq 'DISPATCHING' -and
      $null -eq $facts.invocation.result_ref_kind -and $facts.invocation_count -eq 1
  }
  $deadline = [datetime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $seed.new_path -PathType Leaf) -and
      [datetime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
  if (-not (Test-Path -LiteralPath $seed.new_path -PathType Leaf) -or
      (Get-FileHash -LiteralPath $seed.new_path -Algorithm SHA256).Hash.ToLowerInvariant() -ne
        $seed.new_expected_sha256) { throw 'The original helper effect did not reach disk' }
  $oldJob = @(Get-JobIdentities -HostIdentity $firstIdentity)
  $launchId = [regex]::Match($before.invocation.worker_id,
    '^worker:desktop:([0-9a-f-]{36}):[0-9a-f-]{36}$').Groups[1].Value
  $armedRecord = Join-Path $state.data_root "runtime-launches\$launchId.json"
  if ($launchId -eq '' -or -not (Test-Path -LiteralPath $armedRecord -PathType Leaf)) {
    throw 'Original ARMED desktop launch record missing'
  }
  Write-Evidence "before_kill invocation_id=$($locked.invocation_id) worker_id=$($before.invocation.worker_id) receipt=null original_effect_sha256=$($seed.new_expected_sha256)"
  Stop-Host -Identity $firstIdentity
  Assert-Stopped -Identities $oldJob
  Set-Content -LiteralPath $releaseMarker -Value 'release' -Encoding ascii
  if (-not $locker.WaitForExit(10000) -or $locker.ExitCode -ne 0) {
    throw "Receipt lock helper did not release: $(Get-Content -LiteralPath $lockErr -Raw -ErrorAction SilentlyContinue)"
  }
  $stranded = Invoke-Seed -Phase 'facts' -Extra @($seed.operation_id)
  if ($stranded.invocation.id -ne $locked.invocation_id -or
      $null -ne $stranded.invocation.result_ref_kind -or $stranded.invocation_count -ne 1) {
    throw "Original no-receipt claim changed before recovery: status=$($stranded.invocation.status) receipt=$($stranded.invocation.result_ref_kind) count=$($stranded.invocation_count)"
  }
  Write-Evidence 'after_kill old_host_api_supervisor_worker_alive=0 original_receipt=null invocation_count=1'

  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $cdpPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort"
  $restartHost = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
  $state.desktop_pid = $restartHost.Id
  $state | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $statePath -Encoding utf8
  $restartIdentity = Wait-HostIdentity -ProcessId $restartHost.Id
  $recovered = Wait-Facts -OperationId $seed.operation_id -Phase 'trusted recovery' -Seconds 65 -Ready {
    param($facts)
    $null -ne $facts.stop_proof -and $facts.invocation.status -eq 'UNKNOWN' -and
      $facts.operation.status -eq 'UNKNOWN' -and $facts.claim.status -eq 'QUARANTINED'
  }
  if ($recovered.stop_proof.invocation_id -ne $locked.invocation_id -or
      $recovered.stop_proof.launch_id -ne $launchId -or
      $recovered.stop_proof.worker_id -ne $before.invocation.worker_id -or
      $recovered.stop_proof.worker_epoch -ne $before.invocation.worker_epoch -or
      $recovered.stop_proof.dispatch_epoch -ne $before.dispatch.epoch -or
      $recovered.stop_proof.command_id -ne $before.dispatch.command_id -or
      $recovered.stop_proof.stop_evidence -ne 'armed_job_absent_after_last_handle_closed' -or
      $recovered.invocation_count -ne 1 -or
      $null -ne $recovered.invocation.result_ref_kind) {
    throw 'Trusted stop proof did not preserve the original no-receipt identity'
  }
  $preview = Invoke-Seed -Phase 'preview' -Extra @($seed.operation_id)
  if ($preview.observation_mode -ne 'NO_RECEIPT' -or -not $preview.can_dispose -or
      $preview.invocation_id -ne $locked.invocation_id -or
      @($preview.files).Count -ne 2) {
    throw 'No-receipt observation was not safely disposable'
  }
  Write-Evidence "after_restart stop_evidence=$($recovered.stop_proof.stop_evidence) original_worker_bound=true operation=UNKNOWN invocation=UNKNOWN ledger=$($recovered.ledger.status) claim=QUARANTINED observation=NO_RECEIPT can_dispose=true invocation_count=1"
  & $node $bootstrapProbe $cdpPort 60000
  if ($LASTEXITCODE -ne 0) { throw 'Packaged WebView2 did not become ready' }
  & $node $webviewProbe $cdpPort $seed.run_id $seed.operation_id `
    $beforeScreenshot $afterScreenshot
  if ($LASTEXITCODE -ne 0) { throw 'No-receipt WebView2 probe failed' }
  $closed = Wait-Facts -OperationId $seed.operation_id -Phase 'human disposition' -Ready {
    param($facts)
    $facts.operation.status -eq 'MANUALLY_CLOSED' -and $facts.run.status -eq 'FAILED' -and
      $facts.task.status -eq 'READY' -and $facts.claim.status -eq 'RELEASED' -and
      $facts.dispatch.status -eq 'IDLE' -and $facts.outbox.status -eq 'DONE'
  }
  if ($closed.invocation.id -ne $locked.invocation_id -or
      $closed.invocation.status -ne 'UNKNOWN' -or $closed.invocation_count -ne 1 -or
      (Get-FileHash -LiteralPath $seed.new_path -Algorithm SHA256).Hash.ToLowerInvariant() -ne
        $seed.new_expected_sha256) { throw 'Manual disposition changed the original effect or invocation' }
  Write-Evidence "after_webview_disposition run=FAILED task=READY claim=RELEASED invocation=UNKNOWN invocation_count=1 before_screenshot=$beforeScreenshot after_screenshot=$afterScreenshot"
  Stop-Host -Identity $restartIdentity
  $completed = $true
} catch {
  Write-Evidence "M06_WINDOWS_JOB_NO_RECEIPT=FAIL reason=$($_.Exception.Message)"
  throw
} finally {
  $cleanupErrors = @()
  if ($releaseMarker -and -not (Test-Path -LiteralPath $releaseMarker)) {
    try { Set-Content -LiteralPath $releaseMarker -Value 'release' -Encoding ascii }
    catch { $cleanupErrors += $_.Exception.Message }
  }
  if ($null -ne $locker -and -not $locker.HasExited) {
    $locker.Kill()
    if (-not $locker.WaitForExit(10000)) { $cleanupErrors += 'Receipt locker remained alive' }
  }
  foreach ($identity in @($restartIdentity, $firstIdentity)) {
    try { Stop-Host -Identity $identity }
    catch { $cleanupErrors += $_.Exception.Message }
  }
  foreach ($started in @($restartHost, $firstHost)) {
    if ($null -eq $started -or $started.HasExited) { continue }
    try {
      $started.Kill()
      if (-not $started.WaitForExit(10000)) { throw 'Started desktop host remained alive' }
    } catch { $cleanupErrors += $_.Exception.Message }
  }
  foreach ($identity in @($oldJob | Select-Object -Skip 1)) {
    if (-not (Test-SameProcess $identity)) { continue }
    $path = [string]$identity.executable
    if ($path.StartsWith('\\?\')) { $path = $path.Substring(4) }
    if (-not [string]::Equals($path, (Join-Path $releaseRoot 'node.exe'),
        [StringComparison]::OrdinalIgnoreCase)) {
      $cleanupErrors += 'Refused to stop an unexpected sidecar'; continue
    }
    try { [Diagnostics.Process]::GetProcessById($identity.pid).Kill() }
    catch { $cleanupErrors += $_.Exception.Message }
  }
  try { Assert-Stopped -Identities $oldJob }
  catch { $cleanupErrors += $_.Exception.Message }
  [Environment]::SetEnvironmentVariable('RELAY_DESKTOP_CONFIG_PATH', $oldConfig, 'Process')
  [Environment]::SetEnvironmentVariable('RELAY_DESKTOP_DATA_ROOT', $oldData, 'Process')
  [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', $oldWebview, 'Process')
  if ($statePath -and (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    try {
      & $stopSession -SessionRoot $sessionRoot
      if ($LASTEXITCODE -ne 0) { throw "Session cleanup exited $LASTEXITCODE" }
    } catch { $cleanupErrors += $_.Exception.Message }
  }
  if ($cleanupErrors.Count -ne 0) { throw "M06 cleanup failed: $($cleanupErrors -join '; ')" }
  if ($completed) { Write-Evidence 'M06_WINDOWS_JOB_NO_RECEIPT=PASS' }
}
