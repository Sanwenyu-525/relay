# Inspect only the release host and bundled Node recorded by one disposable M02 session.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SessionRoot,
  [Parameter(Mandatory=$true)][ValidateSet('Snapshot', 'SecondInstance', 'AssertStopped', 'KillHostAndAssertJob')][string]$Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($SessionRoot).TrimEnd('\')
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $root.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $root) -notlike 'relay-m02-acceptance-*') {
  throw 'Refusing to inspect a path outside a disposable M02 acceptance session'
}
$statePath = Join-Path $root 'session.json'
$baselinePath = Join-Path $root 'process-baseline.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'Session marker is missing' }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if ($state.cluster_path -ne (Join-Path $root 'cluster') -or $state.data_root -ne (Join-Path $root 'data')) {
  throw 'Session paths do not match the disposable root'
}
$exe = [IO.Path]::GetFullPath([string]$state.release_exe)
$releaseRoot = Split-Path -Parent $exe
$node = Join-Path $releaseRoot 'node.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) {
  throw 'The session release is incomplete'
}
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $state.release_sha256) {
  throw 'The session release executable changed after startup'
}

function Get-RecordedProcess {
  param([int]$ProcessId, [string]$ExpectedPath)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  if (-not [string]::Equals($process.ExecutablePath, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Process $ProcessId is not the recorded release executable"
  }
  return [ordered]@{
    process_id = [int]$process.ProcessId
    parent_process_id = [int]$process.ParentProcessId
    creation_utc = ([datetime]$process.CreationDate).ToUniversalTime().ToString('o')
    executable_path = $process.ExecutablePath
  }
}

function Get-OwnedNodes {
  param([int]$HostId)
  $nodes = @()
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $HostId")) {
    if ([string]::Equals($process.ExecutablePath, $node, [StringComparison]::OrdinalIgnoreCase)) {
      $nodes += [ordered]@{
        process_id = [int]$process.ProcessId
        parent_process_id = [int]$process.ParentProcessId
        creation_utc = ([datetime]$process.CreationDate).ToUniversalTime().ToString('o')
        executable_path = $process.ExecutablePath
      }
    }
  }
  return @($nodes | Sort-Object process_id)
}

function Test-SameProcess {
  param($Recorded)
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($Recorded.process_id)" -ErrorAction SilentlyContinue
  return $null -ne $candidate -and
    [string]::Equals($candidate.ExecutablePath, $Recorded.executable_path, [StringComparison]::OrdinalIgnoreCase) -and
    ([datetime]$candidate.CreationDate).ToUniversalTime().ToString('o') -eq $Recorded.creation_utc
}

$primary = Get-RecordedProcess -ProcessId ([int]$state.desktop_pid) -ExpectedPath $exe
if ($Mode -eq 'Snapshot') {
  if (Test-Path -LiteralPath $baselinePath -PathType Leaf) { throw 'Session process baseline already exists; preserve the first snapshot' }
  if ($null -eq $primary) { throw 'The release host has already exited' }
  $nodes = @(Get-OwnedNodes -HostId ([int]$state.desktop_pid))
  if ($nodes.Count -ne 1) { throw "Expected exactly one bundled Node child; found $($nodes.Count)" }
  $baseline = [ordered]@{ session_id = $state.session_id; release_sha256 = $state.release_sha256; host = $primary; nodes = $nodes }
  $baseline | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $baselinePath -Encoding utf8
  $baseline | ConvertTo-Json -Depth 5
  exit 0
}

if (-not (Test-Path -LiteralPath $baselinePath -PathType Leaf)) { throw 'Run Snapshot while the release window is open' }
$baseline = Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json
if ($baseline.session_id -ne $state.session_id -or $baseline.release_sha256 -ne $state.release_sha256) {
  throw 'Process baseline does not match this release session'
}
if (@($baseline.nodes).Count -ne 1) { throw 'Process baseline does not contain exactly one bundled Node' }

if ($Mode -eq 'SecondInstance') {
  if (-not (Test-SameProcess $baseline.host) -or -not (Test-SameProcess $baseline.nodes[0])) {
    throw 'The primary host or Node changed before the single-instance test'
  }
  $before = @(Get-OwnedNodes -HostId ([int]$state.desktop_pid) | ForEach-Object { $_.process_id })
  $start = [Diagnostics.ProcessStartInfo]::new($exe)
  $start.UseShellExecute = $false
  $start.EnvironmentVariables['RELAY_DESKTOP_CONFIG_PATH'] = [string]$state.config_path
  $start.EnvironmentVariables['RELAY_DESKTOP_DATA_ROOT'] = [string]$state.data_root
  $contender = [Diagnostics.Process]::Start($start)
  if ($null -eq $contender) { throw 'Could not start the second release instance' }
  if (-not $contender.WaitForExit(10000)) {
    throw "Second instance did not exit in 10 seconds; PID $($contender.Id) remains for UI inspection"
  }
  $after = @(Get-OwnedNodes -HostId ([int]$state.desktop_pid) | ForEach-Object { $_.process_id })
  $contenderNodes = @(Get-OwnedNodes -HostId $contender.Id | ForEach-Object { $_.process_id })
  $passed = $contender.ExitCode -eq 23 -and (Test-SameProcess $baseline.host) -and
    (Test-SameProcess $baseline.nodes[0]) -and (($before -join ',') -eq ($after -join ',')) -and $contenderNodes.Count -eq 0
  $result = [ordered]@{ session_id = $state.session_id; mode = $Mode; contender_pid = $contender.Id;
    contender_exit_code = $contender.ExitCode; original_node_ids = $before; node_ids_after = $after;
    contender_node_ids_after_exit = $contenderNodes; passed = $passed }
  $result | ConvertTo-Json -Depth 4
  if (-not $passed) { exit 1 }
  exit 0
}

if ($Mode -eq 'KillHostAndAssertJob') {
  if (-not (Test-SameProcess $baseline.host) -or -not (Test-SameProcess $baseline.nodes[0])) {
    throw 'The primary host or Node changed before the Job Object test'
  }
  $hostProcess = [Diagnostics.Process]::GetProcessById([int]$state.desktop_pid)
  $hostProcess.Kill() # Deliberately no tree kill; the Job Object must end Node itself.
  [void]$hostProcess.WaitForExit(5000)
}

$deadline = [datetime]::UtcNow.AddSeconds(5)
do {
  $hostAlive = Test-SameProcess $baseline.host
  $nodeAlive = Test-SameProcess $baseline.nodes[0]
  if (-not $hostAlive -and -not $nodeAlive) { break }
  Start-Sleep -Milliseconds 100
} while ([datetime]::UtcNow -lt $deadline)
$passed = -not $hostAlive -and -not $nodeAlive
$result = [ordered]@{ session_id = $state.session_id; mode = $Mode;
  original_host_pid = $baseline.host.process_id; original_node_pid = $baseline.nodes[0].process_id;
  host_alive_after_wait = $hostAlive; node_alive_after_wait = $nodeAlive; passed = $passed }
$result | ConvertTo-Json -Depth 4
if (-not $passed) { exit 1 }
