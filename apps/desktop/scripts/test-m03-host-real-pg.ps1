# Exact release + disposable PG: kill only the Tauri host while Mock Worker owns a claim.
# This is a test fixture; the bearer stays in the short-lived CDP helper process.
[CmdletBinding()]
param(
  [ValidateRange(1,64)][int]$BacklogCount = 1,
  [ValidateSet('Clean','Unknown')][string]$Scenario = 'Clean',
  [switch]$ExpectLaunchAck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $desktopRoot)
$releaseRoot = Join-Path $desktopRoot 'release'
$exe = Join-Path $releaseRoot 'relay-desktop.exe'
$node = Join-Path $workspaceRoot '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$psql = Join-Path $workspaceRoot '.research\runtime-cache\postgresql-18.6-2\pgsql\bin\psql.exe'
$resultName = if ($ExpectLaunchAck) { "m03-host-real-pg-ack-$Scenario-$BacklogCount" } else {
  "m03-host-real-pg-$Scenario-$BacklogCount"
}
$log = Join-Path $desktopRoot "results\$resultName.log"
$evidence = Join-Path $desktopRoot "results\$resultName.evidence.txt"
if ($Scenario -eq 'Unknown' -and $BacklogCount -ne 1) {
  throw 'The UNKNOWN fault fixture requires one isolated Run'
}
foreach ($inputPath in @($exe, $node, $psql, (Join-Path $releaseRoot 'desktop-build-manifest.json'))) {
  if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw "Missing release test input: $inputPath" }
}

function Get-Identity {
  param([int]$ProcessId)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  return [pscustomobject]@{
    pid = [int]$process.ProcessId
    parent_pid = [int]$process.ParentProcessId
    created_utc = ([datetime]$process.CreationDate).ToUniversalTime().ToString('o')
    executable = [string]$process.ExecutablePath
  }
}

function Test-SameProcess {
  param($Identity)
  $current = Get-Identity -ProcessId $Identity.pid
  return $null -ne $current -and $current.created_utc -eq $Identity.created_utc -and
    [string]::Equals($current.executable, $Identity.executable, [StringComparison]::OrdinalIgnoreCase)
}

function Get-RunFacts {
  param([string]$Url, [string]$RunId, [string]$CommandId, [switch]$IncludeAttempts)
  if ($RunId -notmatch '^[0-9a-f-]{36}$' -or $CommandId -notmatch '^[0-9a-f-]{36}$') {
    throw 'Run/command identity is invalid'
  }
  $query = "select i.status,i.epoch,i.worker_id,o.status," +
    "(select count(*) from command_receipts where command_id='$CommandId')," +
    "(select count(*) from run_commands where source_command_id='$CommandId')" +
    $(if ($IncludeAttempts) { "," +
      "(select count(*) from step_attempts a join run_steps s on s.id=a.step_id where s.run_id='$RunId' and s.step_kind='BUILD_CONTEXT')" } else { '' }) +
    " from run_invocations i join run_commands c on c.run_id=i.run_id" +
    " join run_command_outbox o on o.command_id=c.id where i.run_id='$RunId'"
  $line = & $psql $Url '-X' '-w' '-v' 'ON_ERROR_STOP=1' '-t' '-A' '-F' '|' '-c' $query
  if ($LASTEXITCODE -ne 0) { throw "Run facts query failed: $LASTEXITCODE" }
  $parts = @(([string]($line -join '')).Trim() -split '\|')
  if ($parts.Count -ne $(if ($IncludeAttempts) { 7 } else { 6 })) { throw 'Run facts query returned an unexpected row' }
  return [pscustomobject]@{
    invocation_status = $parts[0]; epoch = [long]$parts[1]; worker_id = $parts[2]
    outbox_status = $parts[3]; receipt_count = [int]$parts[4]
    command_count = [int]$parts[5]
    first_step_attempts = $(if ($IncludeAttempts) { [int]$parts[6] } else { $null })
  }
}

function Wait-RunFacts {
  param([string]$Url, [string]$RunId, [string]$CommandId,
    [string]$InvocationStatus, [string]$OutboxStatus, [int]$Seconds)
  $deadline = [datetime]::UtcNow.AddSeconds($Seconds)
  do {
    $facts = Get-RunFacts -Url $Url -RunId $RunId -CommandId $CommandId
    if ($facts.invocation_status -eq $InvocationStatus -and $facts.outbox_status -eq $OutboxStatus) {
      return $facts
    }
    Start-Sleep -Milliseconds 100
  } while ([datetime]::UtcNow -lt $deadline)
  throw "Run did not reach $InvocationStatus/$OutboxStatus; last $($facts | ConvertTo-Json -Compress)"
}

function Get-EffectFacts {
  param([string]$Url, [string]$RunId)
  if ($RunId -notmatch '^[0-9a-f-]{36}$') { throw 'Effect Run ID is invalid' }
  $line = & $psql $Url '-X' '-w' '-v' 'ON_ERROR_STOP=1' '-t' '-A' '-F' '|' '-c' `
    "select operation_id,status,dispatch_count from run_effect_actions where run_id='$RunId'"
  if ($LASTEXITCODE -ne 0) { throw "Effect facts query failed: $LASTEXITCODE" }
  $parts = @(([string]($line -join '')).Trim() -split '\|')
  if ($parts.Count -ne 3) { throw 'Effect facts query returned an unexpected row' }
  return [pscustomobject]@{ operation_id = $parts[0]; status = $parts[1]; dispatch_count = [int]$parts[2] }
}

function Get-RunStepsLockCount {
  param([string]$Url)
  $line = & $psql $Url '-X' '-w' '-q' '-v' 'ON_ERROR_STOP=1' '-t' '-A' '-c' `
    "set statement_timeout to '2s'; select count(*) from pg_locks where relation='run_steps'::regclass and mode='AccessExclusiveLock' and granted"
  if ($LASTEXITCODE -ne 0) { throw "Run-step lock probe failed: $LASTEXITCODE" }
  return [int](([string]($line -join '')).Trim())
}

function Get-BlockedStepCount {
  param([string]$Url)
  $line = & $psql $Url '-X' '-w' '-q' '-v' 'ON_ERROR_STOP=1' '-t' '-A' '-c' `
    "set statement_timeout to '2s'; select count(*) from pg_locks where relation='run_steps'::regclass and not granted"
  if ($LASTEXITCODE -ne 0) { throw "Blocked Worker step probe failed: $LASTEXITCODE" }
  return [int](([string]($line -join '')).Trim())
}

function Assert-Stopped {
  param([object[]]$Identities)
  $deadline = [datetime]::UtcNow.AddSeconds(10)
  do {
    $alive = @($Identities | Where-Object { Test-SameProcess $_ })
    if ($alive.Count -eq 0) { return }
    Start-Sleep -Milliseconds 100
  } while ([datetime]::UtcNow -lt $deadline)
  throw "Host Job left process IDs alive: $(@($alive | ForEach-Object { $_.pid }) -join ',')"
}

function Write-Evidence {
  param([string]$Line)
  Add-Content -LiteralPath $evidence -Value $Line -Encoding utf8
  Write-Host $Line
}

$previousWebview = [Environment]::GetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'Process')
$sessionRoot = $null
$lockProcess = $null
$firstHost = $null
$restartHost = $null
$completed = $false
Set-Content -LiteralPath $evidence -Value "scenario=$Scenario backlog=$BacklogCount expect_launch_ack=$ExpectLaunchAck" -Encoding utf8
Start-Transcript -Path $log -Force | Out-Null
try {
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $before = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'relay-m02-acceptance-*' |
    Select-Object -ExpandProperty FullName)
  & (Join-Path $PSScriptRoot 'start-acceptance-session.ps1') -SkipDesktop
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "Desktop session failed: $LASTEXITCODE" }
  $newSessions = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'relay-m02-acceptance-*' |
    Where-Object { $before -notcontains $_.FullName })
  if ($newSessions.Count -ne 1) { throw "Expected one new disposable session; found $($newSessions.Count)" }
  $sessionRoot = [IO.Path]::GetFullPath($newSessions[0].FullName)
  if (-not $sessionRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Session root escaped the system temp directory'
  }
  $statePath = Join-Path $sessionRoot 'session.json'
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $dbUrl = "postgresql://relay_app@127.0.0.1:$($state.postgres_port)/relay_m02_acceptance"
  Write-Evidence "session_id=$($state.session_id) pg_port=$($state.postgres_port) release_sha256=$($state.release_sha256)"
  $created = (& $node (Join-Path $desktopRoot 'tests\m03-seed-run.mjs') $sessionRoot $BacklogCount) -join '' | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $created.seed_api_exit -ne 0) { throw 'Release API Run seed failed' }
  Write-Evidence "seeded_run_ids=$(@($created.runs | ForEach-Object { $_.run_id }) -join ',') seed_api_exit=0"
  $lockFile = Join-Path $sessionRoot 'hold-run-steps.sql'
  [IO.File]::WriteAllText($lockFile, "begin;`nlock table run_steps in access exclusive mode;`nselect pg_sleep(300);`nrollback;`n", [Text.UTF8Encoding]::new($false))
  $lockProcess = Start-Process -FilePath $psql -ArgumentList @($dbUrl, '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-f', $lockFile) `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $sessionRoot 'hold-run-steps.log')
  $lockDeadline = [datetime]::UtcNow.AddSeconds(10)
  while ((Get-RunStepsLockCount -Url $dbUrl) -ne 1) {
    if ($lockProcess.HasExited) { throw "Run-step lock session exited early: $($lockProcess.ExitCode)" }
    if ([datetime]::UtcNow -ge $lockDeadline) { throw 'Run-step lock was not acquired' }
    Start-Sleep -Milliseconds 50
  }
  Write-Evidence "run_steps_exclusive_lock=1 lock_psql_pid=$($lockProcess.Id)"
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $cdpPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort"
  $env:RELAY_DESKTOP_CONFIG_PATH = [string]$state.config_path
  $env:RELAY_DESKTOP_DATA_ROOT = [string]$state.data_root
  $firstHost = Start-Process -FilePath $exe -PassThru # Real visible desktop with Job-bound sidecars.
  $state.desktop_pid = $firstHost.Id
  $state | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $statePath -Encoding utf8
  $active = Wait-RunFacts -Url $dbUrl -RunId $created.run_id -CommandId $created.command_id -InvocationStatus 'ACTIVE' -OutboxStatus 'CLAIMED' -Seconds 15
  $firstReadiness = (& $node (Join-Path $desktopRoot 'tests\m03-probe-bootstrap.mjs') $cdpPort 30000) -join '' | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $firstReadiness.packaged_bootstrap -ne 'ready') {
    throw 'Initial packaged WebView did not become ready while the Worker step was held'
  }
  if ((Get-RunStepsLockCount -Url $dbUrl) -ne 1) { throw 'Worker step lock ended before host kill' }
  $hostIdentity = Get-Identity -ProcessId ([int]$state.desktop_pid)
  if ($null -eq $hostIdentity -or $hostIdentity.executable -ne $exe) { throw 'Host process identity changed' }
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($hostIdentity.pid)")
  $apiProcess = @($children | Where-Object { $_.CommandLine -like '*dist\src\main.js*' })
  $supervisorProcess = @($children | Where-Object { $_.CommandLine -like '*dist\src\worker\supervisor-main.js*' })
  if ($apiProcess.Count -ne 1 -or $supervisorProcess.Count -ne 1) { throw 'Expected distinct API and supervisor Node sidecars' }
  $workerProcess = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($supervisorProcess[0].ProcessId)" |
    Where-Object { $_.CommandLine -like '*dist\src\worker\main.js*' })
  if ($workerProcess.Count -ne 1) { throw 'Expected one claimed Mock Worker child' }
  $blockedDeadline = [datetime]::UtcNow.AddSeconds(10)
  while ((Get-BlockedStepCount -Url $dbUrl) -lt 1) {
    if ([datetime]::UtcNow -ge $blockedDeadline) { throw 'Mock Worker did not wait on the controlled run_steps lock' }
    Start-Sleep -Milliseconds 50
  }
  Write-Evidence 'run_steps_ungranted_worker_lock_count=1'
  $identities = @($hostIdentity,
    (Get-Identity -ProcessId ([int]$apiProcess[0].ProcessId)),
    (Get-Identity -ProcessId ([int]$supervisorProcess[0].ProcessId)),
    (Get-Identity -ProcessId ([int]$workerProcess[0].ProcessId)))
  if (@($identities | Where-Object { $null -eq $_ }).Count -ne 0) { throw 'A process vanished before PID snapshot' }
  $launchId = [regex]::Match($active.worker_id, '^worker:desktop:([0-9a-f-]{36}):[0-9a-f-]{36}$').Groups[1].Value
  if (-not $launchId) { throw 'Worker claim lacks the desktop launch identity' }
  if ($BacklogCount -gt 1) {
    $extraIds = @($created.runs | Select-Object -Skip 1 | ForEach-Object { $_.run_id })
    $claimed = (& $node (Join-Path $desktopRoot 'tests\m03-claim-pending.mjs') $sessionRoot $launchId ($extraIds -join ',')) -join '' | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or @($claimed.claimed).Count -ne ($BacklogCount - 1)) {
      throw 'Could not seed the controlled old-launch claim backlog'
    }
    Write-Evidence "controlled_old_launch_claims=$BacklogCount claimed_run_ids=$($extraIds -join ',')"
  }
  $record = Join-Path $state.data_root "runtime-launches\$launchId.json"
  if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { throw 'Old ARMED launch record is missing' }
  Write-Evidence "before_kill run_id=$($created.run_id) command_id=$($created.command_id) launch_id=$launchId facts=$($active | ConvertTo-Json -Compress)"
  Write-Evidence "processes_before_kill=$($identities | ConvertTo-Json -Compress)"
  [Diagnostics.Process]::GetProcessById($hostIdentity.pid).Kill() # Intentionally not a tree kill.
  Assert-Stopped -Identities $identities
  $stranded = Get-RunFacts -Url $dbUrl -RunId $created.run_id -CommandId $created.command_id
  if ($stranded.epoch -ne $active.epoch -or $stranded.outbox_status -ne 'CLAIMED' -or
      $stranded.command_count -ne 1 -or $stranded.receipt_count -ne 1) {
    throw "Stranded claim changed before trustworthy recovery: $($stranded | ConvertTo-Json -Compress)"
  }
  if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { throw 'Old ARMED proof was lost after host kill' }
  Write-Evidence "after_kill host_api_supervisor_worker_alive=0 old_record_retained=True facts=$($stranded | ConvertTo-Json -Compress)"
  $adminUrl = "postgresql://relay_api_admin@127.0.0.1:$($state.postgres_port)/relay_m02_acceptance"
  $terminated = & $psql $adminUrl '-X' '-w' '-q' '-v' 'ON_ERROR_STOP=1' '-t' '-A' '-c' `
    "select pg_terminate_backend(pid) from pg_locks where relation='run_steps'::regclass and mode='AccessExclusiveLock' and granted and pid <> pg_backend_pid()"
  if ($LASTEXITCODE -ne 0 -or ([string]($terminated -join '')).Trim() -ne 't') {
    throw 'Could not terminate the one controlled run-step lock backend'
  }
  $releaseDeadline = [datetime]::UtcNow.AddSeconds(10)
  while ((Get-RunStepsLockCount -Url $dbUrl) -ne 0) {
    if ([datetime]::UtcNow -ge $releaseDeadline) { throw 'Run-step lock remained after backend termination' }
    Start-Sleep -Milliseconds 50
  }
  Write-Evidence 'run_steps_exclusive_lock_after_release=0'
  $injected = $null
  if ($Scenario -eq 'Unknown') {
    $injected = (& $node (Join-Path $desktopRoot 'tests\m03-inject-unknown.mjs') `
      $sessionRoot $created.run_id $active.worker_id ([string]$active.epoch)) -join '' | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $injected.injected_effect -ne 'DISPATCHING_WITH_TAMPERED_TARGET') {
      throw 'UNKNOWN fault injection failed'
    }
    $pendingEffect = Get-EffectFacts -Url $dbUrl -RunId $created.run_id
    if ($pendingEffect.operation_id -ne $injected.operation_id -or
        $pendingEffect.status -ne 'DISPATCHING' -or $pendingEffect.dispatch_count -ne 1) {
      throw 'Fault injection did not preserve the original operation identity'
    }
    Write-Evidence "before_unknown_recovery effect=$($pendingEffect | ConvertTo-Json -Compress)"
  }
  $nextListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $nextListener.Start()
  $nextCdpPort = ([System.Net.IPEndPoint]$nextListener.LocalEndpoint).Port
  $nextListener.Stop()
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$nextCdpPort"
  $env:RELAY_DESKTOP_CONFIG_PATH = [string]$state.config_path
  $env:RELAY_DESKTOP_DATA_ROOT = [string]$state.data_root
  $restartHost = Start-Process -FilePath $exe -PassThru # Real visible desktop relaunch.
  $state.desktop_pid = $restartHost.Id
  $state | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $statePath -Encoding utf8
  $restartReadiness = (& $node (Join-Path $desktopRoot 'tests\m03-probe-bootstrap.mjs') $nextCdpPort 180000) -join '' | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $restartReadiness.packaged_bootstrap -ne 'ready') {
    throw 'Reopened packaged WebView did not pass the private readiness gate'
  }
  Write-Evidence "restart_bootstrap_elapsed_ms=$($restartReadiness.elapsed_ms) controlled_old_launch_claims=$BacklogCount"
  foreach ($run in @($created.runs)) {
    $current = Get-RunFacts -Url $dbUrl -RunId $run.run_id -CommandId $run.command_id
    if ($Scenario -eq 'Clean') {
      if (($current.invocation_status -eq 'ACTIVE' -or $current.invocation_status -eq 'STOP_REQUIRED') -and
          $current.worker_id.StartsWith("worker:desktop:$($launchId):")) {
        throw "An old-launch Worker claim survived clean recovery: $($run.run_id)"
      }
    } elseif ($current.invocation_status -ne 'ACTIVE' -or $current.worker_id -ne $active.worker_id -or
        $current.epoch -ne $active.epoch) {
      throw "UNKNOWN lost the original fenced claim: $($run.run_id)"
    }
    if ($current.command_count -ne 1 -or $current.receipt_count -ne 1) {
      throw "Original command identity changed during recovery: $($run.run_id)"
    }
  }
  if ($Scenario -eq 'Clean') {
    $settled = Wait-RunFacts -Url $dbUrl -RunId $created.run_id -CommandId $created.command_id -InvocationStatus 'IDLE' -OutboxStatus 'DONE' -Seconds 40
    $settled = Get-RunFacts -Url $dbUrl -RunId $created.run_id -CommandId $created.command_id -IncludeAttempts
    if ($settled.epoch -ne ($active.epoch + 1) -or $settled.command_count -ne 1 -or
        $settled.receipt_count -ne 1 -or $settled.first_step_attempts -ne 1) {
      throw "Recovered command facts disagree: $($settled | ConvertTo-Json -Compress)"
    }
  } else {
    $settled = Get-RunFacts -Url $dbUrl -RunId $created.run_id -CommandId $created.command_id
    $effect = Get-EffectFacts -Url $dbUrl -RunId $created.run_id
    if ($settled.invocation_status -ne 'ACTIVE' -or $settled.outbox_status -ne 'CLAIMED' -or
        $settled.epoch -ne $active.epoch -or $settled.command_count -ne 1 -or
        $settled.receipt_count -ne 1 -or $effect.operation_id -ne $injected.operation_id -or
        $effect.status -ne 'UNKNOWN' -or $effect.dispatch_count -ne 1) {
      throw "UNKNOWN was retried or lost: $($settled | ConvertTo-Json -Compress) / $($effect | ConvertTo-Json -Compress)"
    }
    $supervisorChild = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($restartHost.Id)" |
      Where-Object { $_.CommandLine -like '*dist\src\worker\supervisor-main.js*' })
    if ($supervisorChild.Count -ne 1) { throw 'Restarted supervisor is missing' }
    $workers = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($supervisorChild[0].ProcessId)" |
      Where-Object { $_.CommandLine -like '*dist\src\worker\main.js*' })
    if ($workers.Count -ne 0) { throw 'UNKNOWN unexpectedly spawned a new Worker' }
    Write-Evidence "after_unknown_recovery effect=$($effect | ConvertTo-Json -Compress) worker_count=0"
  }
  $oldRecordRetained = Test-Path -LiteralPath $record -PathType Leaf
  if ($ExpectLaunchAck -and $Scenario -eq 'Clean') {
    if ($oldRecordRetained) { throw 'Zero-claim old ARMED record survived durable launch ack' }
  } elseif (-not $oldRecordRetained) {
    throw 'Old ARMED proof was cleared without a zero-claim durable launch ack'
  }
  Write-Evidence "after_restart new_host_pid=$($restartHost.Id) old_record_retained=$oldRecordRetained facts=$($settled | ConvertTo-Json -Compress)"
  $restartHost.Kill()
  [void]$restartHost.WaitForExit(5000)
  $restartNodePids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($restartHost.Id)" |
    Where-Object { $_.ExecutablePath -eq (Join-Path $releaseRoot 'node.exe') })
  if ($restartNodePids.Count -ne 0) { throw 'Restart sidecars survived host stop' }
  & (Join-Path $PSScriptRoot 'stop-acceptance-session.ps1') -SessionRoot $sessionRoot
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "Disposable session cleanup failed: $LASTEXITCODE" }
  $completed = $true
  Write-Evidence "M03_REAL_HOST_RECOVERY=PASS scenario=$Scenario backlog=$BacklogCount pg_stop=0 temporary_root_removed=True"
} catch {
  Write-Evidence "M03_REAL_HOST_RECOVERY=FAIL reason=$($_.Exception.Message)"
  throw
} finally {
  if ($lockProcess -and -not $lockProcess.HasExited) {
    Stop-Process -Id $lockProcess.Id -Force -ErrorAction SilentlyContinue
  }
  [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', $previousWebview, 'Process')
  Stop-Transcript | Out-Null
  if (-not $completed -and $sessionRoot) {
    Write-Warning "M03 session retained for diagnosis: $sessionRoot; stop remaining desktop/Node processes and run apps/desktop/scripts/stop-acceptance-session.ps1 -SessionRoot `"$sessionRoot`""
  }
}
