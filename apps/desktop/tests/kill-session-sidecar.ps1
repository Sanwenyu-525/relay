# Stop only the recorded bundled Node child in one disposable desktop test session.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($SessionRoot).TrimEnd('\')
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $root.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path -Leaf $root) -notmatch '^relay-m02-acceptance-[0-9a-f]{32}$') {
  throw 'Refusing to inspect a path outside a disposable M02 session'
}
$state = Get-Content -LiteralPath (Join-Path $root 'session.json') -Raw | ConvertFrom-Json
$baseline = Get-Content -LiteralPath (Join-Path $root 'process-baseline.json') -Raw | ConvertFrom-Json
if ($state.cluster_path -ne (Join-Path $root 'cluster') -or $state.data_root -ne (Join-Path $root 'data') -or
    $state.session_id -ne $baseline.session_id -or $state.release_sha256 -ne $baseline.release_sha256 -or
    @($baseline.nodes).Count -ne 1) {
  throw 'Session marker and process baseline differ'
}
$exe = [IO.Path]::GetFullPath([string]$state.release_exe)
$node = Join-Path (Split-Path -Parent $exe) 'node.exe'
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $state.release_sha256) {
  throw 'Release executable differs from the session marker'
}
$hostProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($baseline.host.process_id)"
$nodeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($baseline.nodes[0].process_id)"
if ($null -eq $hostProcess -or $null -eq $nodeProcess -or
    -not [string]::Equals($hostProcess.ExecutablePath, $exe, [StringComparison]::OrdinalIgnoreCase) -or
    -not [string]::Equals($nodeProcess.ExecutablePath, $node, [StringComparison]::OrdinalIgnoreCase) -or
    $nodeProcess.ParentProcessId -ne $hostProcess.ProcessId -or
    ([datetime]$hostProcess.CreationDate).ToUniversalTime().ToString('o') -ne $baseline.host.creation_utc -or
    ([datetime]$nodeProcess.CreationDate).ToUniversalTime().ToString('o') -ne $baseline.nodes[0].creation_utc) {
  throw 'The recorded host or Node process is no longer the same process'
}
Stop-Process -Id ([int]$nodeProcess.ProcessId) -Force
$deadline = [datetime]::UtcNow.AddSeconds(5)
do {
  $alive = Get-CimInstance Win32_Process -Filter "ProcessId = $($baseline.nodes[0].process_id)" -ErrorAction SilentlyContinue
  if ($null -eq $alive) { break }
  Start-Sleep -Milliseconds 100
} while ([datetime]::UtcNow -lt $deadline)
$hostAlive = $null -ne (Get-CimInstance Win32_Process -Filter "ProcessId = $($baseline.host.process_id)" -ErrorAction SilentlyContinue)
$passed = $null -eq $alive -and $hostAlive
Write-Host "session_id=$($state.session_id) stopped_node_pid=$($baseline.nodes[0].process_id) host_alive=$hostAlive node_gone=$($null -eq $alive) passed=$passed"
if (-not $passed) { exit 1 }
