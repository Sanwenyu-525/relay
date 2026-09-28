# Disposable Windows Job -> original FILE_WRITE Invocation -> human disposition.
# The package must be rebuilt from the current source before running this test.
# Keep this file ASCII-only for Windows PowerShell 5.1.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $desktopRoot)
$releaseRoot = Join-Path $desktopRoot 'release'
$exe = Join-Path $releaseRoot 'relay-desktop.exe'
$node = Join-Path $workspaceRoot '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$helper = Join-Path $desktopRoot 'tests\m06-seed-file-write.mjs'
$manifest = Join-Path $releaseRoot 'desktop-build-manifest.json'
$migration = Join-Path $releaseRoot 'api\migrations\0033_m06_file_write_stop_proofs.sql'
$evidence = Join-Path $workspaceRoot 'docs\testing\evidence\m06-windows-job-file-write.txt'
foreach ($required in @($exe, $node, $helper, $manifest, $migration)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing M06 acceptance input: $required" }
}

function Get-Identity {
  param([int]$ProcessId)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  return [pscustomobject]@{
    pid = [int]$process.ProcessId
    created_utc = ([datetime]$process.CreationDate).ToUniversalTime().ToString('o')
    executable = [string]$process.ExecutablePath
  }
}

function Test-SameProcess {
  param($Identity)
  if ($null -eq $Identity) { return $false }
  $current = Get-Identity -ProcessId $Identity.pid
  return $null -ne $current -and $current.created_utc -eq $Identity.created_utc -and
    [string]::Equals($current.executable, $Identity.executable, [StringComparison]::OrdinalIgnoreCase)
}

function Stop-TestHost {
  param($Identity)
  if (-not (Test-SameProcess $Identity)) { return }
  if (-not [string]::Equals($Identity.executable, $exe, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to stop a process outside the M06 release EXE'
  }
  [Diagnostics.Process]::GetProcessById($Identity.pid).Kill()
  $deadline = [datetime]::UtcNow.AddSeconds(10)
  while ((Test-SameProcess $Identity) -and [datetime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if (Test-SameProcess $Identity) { throw 'Desktop host did not stop' }
}

function Wait-HostIdentity {
  param([int]$ProcessId)
  $deadline = [datetime]::UtcNow.AddSeconds(5)
  do {
    $identity = Get-Identity -ProcessId $ProcessId
    if ($null -ne $identity) {
      if (-not [string]::Equals($identity.executable, $exe, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Desktop host PID belongs to another executable'
      }
      return $identity
    }
    Start-Sleep -Milliseconds 100
  } while ([datetime]::UtcNow -lt $deadline)
  throw 'Desktop host process identity is unavailable'
}

function Stop-StartedHost {
  param($StartedProcess, $Identity)
  if ($null -eq $StartedProcess) { return }
  if ($null -ne $Identity) { Stop-TestHost -Identity $Identity }
  if (-not $StartedProcess.HasExited) {
    # The Process object still holds the exact process started by this script.
    $StartedProcess.Kill()
    if (-not $StartedProcess.WaitForExit(10000)) { throw 'Started desktop host did not stop' }
  }
}

function Stop-RecordedSidecars {
  param([object[]]$Identities)
  if ($null -eq $Identities -or $Identities.Count -eq 0) { return }
  $nodeExe = Join-Path $releaseRoot 'node.exe'
  foreach ($identity in @($Identities | Select-Object -Skip 1)) {
    if (-not (Test-SameProcess $identity)) { continue }
    $path = [string]$identity.executable
    if ($path.StartsWith('\\?\')) { $path = $path.Substring(4) }
    if (-not [string]::Equals($path, $nodeExe, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Refusing to stop a sidecar outside the M06 release directory'
    }
    [Diagnostics.Process]::GetProcessById($identity.pid).Kill()
  }
  Assert-Stopped -Identities $Identities
}

function Assert-Stopped {
  param([object[]]$Identities)
  $deadline = [datetime]::UtcNow.AddSeconds(12)
  do {
    $alive = @($Identities | Where-Object { Test-SameProcess $_ })
    if ($alive.Count -eq 0) { return }
    Start-Sleep -Milliseconds 100
  } while ([datetime]::UtcNow -lt $deadline)
  throw "Old Job left process IDs alive: $(@($alive | ForEach-Object { $_.pid }) -join ',')"
}

function Get-JobChildren {
  param($HostIdentity)
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($HostIdentity.pid)")
  $api = @($children | Where-Object { $_.CommandLine -like '*dist\src\main.js*' })
  $supervisor = @($children | Where-Object { $_.CommandLine -like '*dist\src\worker\supervisor-main.js*' })
  if ($api.Count -ne 1 -or $supervisor.Count -ne 1) {
    throw 'Expected one API and one supervisor sidecar'
  }
  $workers = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($supervisor[0].ProcessId)" |
    Where-Object { $_.CommandLine -like '*dist\src\worker\main.js*' })
  if ($workers.Count -ne 1) { throw 'Expected one live Job-bound Worker' }
  $identities = @($HostIdentity,
    (Get-Identity -ProcessId ([int]$api[0].ProcessId)),
    (Get-Identity -ProcessId ([int]$supervisor[0].ProcessId)),
    (Get-Identity -ProcessId ([int]$workers[0].ProcessId)))
  if (@($identities | Where-Object { $null -eq $_ }).Count -ne 0) {
    throw 'A sidecar vanished before its process identity was recorded'
  }
  return $identities
}

function Write-Evidence {
  param([string]$Line)
  Add-Content -LiteralPath $evidence -Value $Line -Encoding utf8
  Write-Host $Line
}

$sessionRoot = $null
$state = $null
$firstHost = $null
$restartHost = $null
$firstIdentity = $null
$restartIdentity = $null
$oldProcesses = @()
$completed = $false
$previousHold = [Environment]::GetEnvironmentVariable('M06_ACCEPTANCE_FILE_WRITE_HOLD_MS', 'Process')
$previousConfig = [Environment]::GetEnvironmentVariable('RELAY_DESKTOP_CONFIG_PATH', 'Process')
$previousData = [Environment]::GetEnvironmentVariable('RELAY_DESKTOP_DATA_ROOT', 'Process')
Set-Content -LiteralPath $evidence -Value 'M06 Windows Job FILE_WRITE acceptance attempt' -Encoding utf8

try {
  $sessionId = [guid]::NewGuid().ToString('N')
  $sessionRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "relay-m02-acceptance-$sessionId"))
  & (Join-Path $PSScriptRoot 'start-acceptance-session.ps1') `
    -SkipDesktop -InstallGraph -UseCLocale -SessionId $sessionId
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $sessionRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      (Split-Path -Leaf $sessionRoot) -notlike 'relay-m02-acceptance-*') {
    throw 'Disposable session path escaped the system temp directory'
  }
  $statePath = Join-Path $sessionRoot 'session.json'
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if ($state.data_root -ne (Join-Path $sessionRoot 'data') -or
      $state.release_exe -ne $exe) { throw 'Disposable session marker does not match the release' }
  $releaseHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($state.release_sha256 -ne $releaseHash) { throw 'Release EXE changed after session creation' }
  Write-Evidence "release_sha256=$releaseHash manifest_sha256=$((Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()) migration_0033_sha256=$((Get-FileHash -LiteralPath $migration -Algorithm SHA256).Hash.ToLowerInvariant())"
  Write-Evidence "session_id=$($state.session_id)"

  function Invoke-Helper {
    param([string]$Phase, [string[]]$Extra = @())
    $output = @(& $node $helper $Phase $sessionRoot @Extra)
    if ($LASTEXITCODE -ne 0) { throw "M06 $Phase helper exited $LASTEXITCODE" }
    $line = ($output -join '').Trim()
    try { return $line | ConvertFrom-Json }
    catch { throw "M06 $Phase helper did not return one JSON object" }
  }
  function Wait-Facts {
    param([string]$OperationId, [string]$Phase, [scriptblock]$Ready, [int]$Seconds = 40)
    $deadline = [datetime]::UtcNow.AddSeconds($Seconds)
    do {
      $facts = Invoke-Helper -Phase 'facts' -Extra @($OperationId)
      if (& $Ready $facts) { return $facts }
      Start-Sleep -Milliseconds 150
    } while ([datetime]::UtcNow -lt $deadline)
    throw "M06 $Phase did not reach the expected state; last=$($facts | ConvertTo-Json -Compress -Depth 8)"
  }

  $seed = Invoke-Helper -Phase 'seed'
  foreach ($id in @($seed.run_id, $seed.task_id, $seed.operation_id)) {
    if ($id -notmatch '^[0-9a-f-]{36}$') { throw 'Seed returned an invalid business ID' }
  }
  Write-Evidence "seed run_id=$($seed.run_id) task_id=$($seed.task_id) operation_id=$($seed.operation_id)"
  $env:RELAY_DESKTOP_CONFIG_PATH = [string]$state.config_path
  $env:RELAY_DESKTOP_DATA_ROOT = [string]$state.data_root
  $env:M06_ACCEPTANCE_FILE_WRITE_HOLD_MS = '90000'
  $firstHost = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
  $state.desktop_pid = $firstHost.Id
  $state | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $statePath -Encoding utf8
  $firstIdentity = Wait-HostIdentity -ProcessId $firstHost.Id
  $waiting = Wait-Facts -OperationId $seed.operation_id -Phase 'approval wait' -Ready {
    param($facts)
    $null -ne $facts.operation -and $facts.operation.status -eq 'WAITING_APPROVAL' -and
      $null -ne $facts.run -and $facts.run.status -eq 'WAITING_APPROVAL'
  }
  Write-Evidence "approval_wait operation=$($waiting.operation.status) run=$($waiting.run.status)"
  $approved = Invoke-Helper -Phase 'approve' -Extra @($seed.run_id, $seed.operation_id)
  Write-Evidence "approved review_id=$($approved.review_id) resume_command_id=$($approved.resume_command_id)"
  $staged = Wait-Facts -OperationId $seed.operation_id -Phase 'staged adapter receipt' -Seconds 50 -Ready {
    param($facts)
    $null -ne $facts.invocation -and $facts.invocation.status -eq 'DISPATCHING' -and
      $facts.invocation.result_ref_kind -eq 'FILE_WRITE_ADAPTER_V1' -and
      $null -ne $facts.dispatch -and $facts.dispatch.status -eq 'ACTIVE' -and
      $null -ne $facts.outbox -and $facts.outbox.status -eq 'CLAIMED'
  }
  if ($staged.invocation_count -ne 1 -or $staged.invocation.worker_id -notmatch
      '^worker:desktop:([0-9a-f-]{36}):[0-9a-f-]{36}$') {
    throw 'Staged FILE_WRITE lacks one original desktop Invocation'
  }
  $launchId = [regex]::Match($staged.invocation.worker_id,
    '^worker:desktop:([0-9a-f-]{36}):[0-9a-f-]{36}$').Groups[1].Value
  $oldRecord = Join-Path $state.data_root "runtime-launches\$launchId.json"
  if (-not (Test-Path -LiteralPath $oldRecord -PathType Leaf)) {
    throw 'Original ARMED desktop launch record is missing'
  }
  $oldRecordHash = (Get-FileHash -LiteralPath $oldRecord -Algorithm SHA256).Hash.ToLowerInvariant()
  $oldProcesses = Get-JobChildren -HostIdentity $firstIdentity
  Write-Evidence "before_kill invocation_id=$($staged.invocation.id) worker_id=$($staged.invocation.worker_id) worker_epoch=$($staged.invocation.worker_epoch) dispatch_epoch=$($staged.dispatch.epoch) command_id=$($staged.dispatch.command_id) adapter_receipt=$($staged.invocation.result_ref_kind) armed_sha256=$oldRecordHash"
  Write-Evidence "processes_before_kill=$($oldProcesses | ConvertTo-Json -Compress -Depth 4)"
  Stop-TestHost -Identity $firstIdentity
  Assert-Stopped -Identities $oldProcesses
  $stranded = Invoke-Helper -Phase 'facts' -Extra @($seed.operation_id)
  if ($stranded.invocation.id -ne $staged.invocation.id -or
      $stranded.dispatch.epoch -ne $staged.dispatch.epoch -or
      $stranded.outbox.status -ne 'CLAIMED' -or
      $stranded.invocation_count -ne 1) {
    throw 'Original claim changed before trusted desktop recovery'
  }
  Write-Evidence 'after_kill host_api_supervisor_worker_alive=0 original_claim_retained=true'

  $restartHost = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
  $state.desktop_pid = $restartHost.Id
  $state | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $statePath -Encoding utf8
  $restartIdentity = Wait-HostIdentity -ProcessId $restartHost.Id
  $recovered = Wait-Facts -OperationId $seed.operation_id -Phase 'trusted stop proof' -Seconds 65 -Ready {
    param($facts)
    $null -ne $facts.stop_proof -and $facts.operation.status -eq 'UNKNOWN' -and
      $facts.invocation.status -eq 'UNKNOWN' -and $facts.ledger.status -eq 'PARTIAL' -and
      $facts.claim.status -eq 'QUARANTINED'
  }
  $proof = $recovered.stop_proof
  if ($proof.invocation_id -ne $staged.invocation.id -or
      $proof.operation_id -ne $seed.operation_id -or $proof.run_id -ne $seed.run_id -or
      $proof.worker_id -ne $staged.invocation.worker_id -or
      $proof.worker_epoch -ne $staged.invocation.worker_epoch -or
      $proof.dispatch_epoch -ne $staged.dispatch.epoch -or
      $proof.command_id -ne $staged.dispatch.command_id -or
      $proof.launch_id -ne $launchId -or
      $proof.stop_evidence -ne 'armed_job_absent_after_last_handle_closed' -or
      $recovered.invocation_count -ne 1) {
    throw 'Persisted desktop stop proof is not bound to the original FILE_WRITE claim'
  }
  $ledgerFiles = @($recovered.ledger.files)
  $newFile = @($ledgerFiles | Where-Object { $_.relative_path -eq 'new.txt' })
  $existingFile = @($ledgerFiles | Where-Object { $_.relative_path -eq 'existing.txt' })
  if ($ledgerFiles.Count -ne 2 -or $newFile.Count -ne 1 -or $existingFile.Count -ne 1 -or
      $newFile[0].action -ne 'CREATE' -or $newFile[0].status -ne 'APPLIED' -or
      $null -ne $newFile[0].baseline_sha256 -or
      $newFile[0].target_sha256 -ne $seed.new_expected_sha256 -or
      $newFile[0].actual_sha256 -ne $seed.new_expected_sha256 -or
      $existingFile[0].action -ne 'MODIFY' -or $existingFile[0].status -ne 'CONFLICT' -or
      $existingFile[0].baseline_sha256 -ne $seed.existing_baseline_sha256 -or
      $existingFile[0].observed_baseline_sha256 -ne $seed.existing_conflict_sha256 -or
      $existingFile[0].target_sha256 -ne $seed.existing_target_sha256 -or
      $existingFile[0].actual_sha256 -ne $seed.existing_conflict_sha256 -or
      (Get-FileHash -LiteralPath $seed.new_path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $seed.new_expected_sha256 -or
      (Get-FileHash -LiteralPath $seed.existing_path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $seed.existing_conflict_sha256) {
    throw 'Recovered per-file ledger disagrees with the original adapter receipt or disk'
  }
  Write-Evidence 'after_restart_files new=APPLIED target_and_disk_match=true existing=CONFLICT original_observation_and_disk_match=true'
  Write-Evidence "after_restart proof=$($proof | ConvertTo-Json -Compress -Depth 4) operation=$($recovered.operation.status) invocation=$($recovered.invocation.status) ledger=$($recovered.ledger.status) claim=$($recovered.claim.status) invocation_count=$($recovered.invocation_count)"
  $disposed = Invoke-Helper -Phase 'dispose' -Extra @($seed.operation_id)
  $closed = Wait-Facts -OperationId $seed.operation_id -Phase 'human disposition' -Ready {
    param($facts)
    $null -ne $facts.operation -and $facts.operation.status -eq 'MANUALLY_CLOSED' -and
      $null -ne $facts.run -and $facts.run.status -eq 'FAILED' -and
      $null -ne $facts.task -and $facts.task.status -eq 'READY' -and
      $null -ne $facts.claim -and $facts.claim.status -eq 'RELEASED' -and
      $null -ne $facts.dispatch -and $facts.dispatch.status -eq 'IDLE' -and
      $null -ne $facts.outbox -and $facts.outbox.status -eq 'DONE'
  }
  if ($closed.invocation.id -ne $staged.invocation.id -or
      $closed.invocation.status -ne 'UNKNOWN' -or $closed.ledger.status -ne 'PARTIAL' -or
      $closed.invocation_count -ne 1) {
    throw 'Human disposition changed the original Invocation or PARTIAL ledger'
  }
  Write-Evidence "after_disposition command_id=$($disposed.command_id) disposition_id=$($disposed.disposition_id) operation=$($closed.operation.status) run=$($closed.run.status) task=$($closed.task.status) claim=$($closed.claim.status) dispatch=$($closed.dispatch.status) outbox=$($closed.outbox.status) invocation_count=$($closed.invocation_count)"
  Stop-StartedHost -StartedProcess $restartHost -Identity $restartIdentity
  $completed = $true
} catch {
  Write-Evidence "M06_WINDOWS_JOB_FILE_WRITE=FAIL reason=$($_.Exception.Message)"
  throw
} finally {
  $cleanupErrors = @()
  try { Stop-StartedHost -StartedProcess $restartHost -Identity $restartIdentity }
  catch { $cleanupErrors += $_.Exception.Message }
  try { Stop-StartedHost -StartedProcess $firstHost -Identity $firstIdentity }
  catch { $cleanupErrors += $_.Exception.Message }
  try { Stop-RecordedSidecars -Identities $oldProcesses }
  catch { $cleanupErrors += $_.Exception.Message }
  [Environment]::SetEnvironmentVariable('M06_ACCEPTANCE_FILE_WRITE_HOLD_MS', $previousHold, 'Process')
  [Environment]::SetEnvironmentVariable('RELAY_DESKTOP_CONFIG_PATH', $previousConfig, 'Process')
  [Environment]::SetEnvironmentVariable('RELAY_DESKTOP_DATA_ROOT', $previousData, 'Process')
  if ($null -ne $sessionRoot -and (Test-Path -LiteralPath (Join-Path $sessionRoot 'session.json'))) {
    try {
      & (Join-Path $PSScriptRoot 'stop-acceptance-session.ps1') -SessionRoot $sessionRoot
      if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "Session cleanup exited $LASTEXITCODE" }
      Write-Evidence 'postgres_stopped=true temporary_root_removed=true'
    } catch { $cleanupErrors += "M06 disposable session needs manual inspection: $sessionRoot; $($_.Exception.Message)" }
  }
  if ($cleanupErrors.Count -ne 0) {
    Write-Evidence "M06_WINDOWS_JOB_FILE_WRITE=FAIL cleanup=$($cleanupErrors -join '; ')"
    throw "M06 cleanup failed: $($cleanupErrors -join '; ')"
  }
}
if ($completed) { Write-Evidence 'M06_WINDOWS_JOB_FILE_WRITE=PASS' }
