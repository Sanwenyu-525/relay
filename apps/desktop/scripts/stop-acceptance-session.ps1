# Close only the desktop process and disposable PostgreSQL cluster recorded by the matching session.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($SessionRoot).TrimEnd('\')
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $root.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $root) -notlike 'relay-m02-acceptance-*') {
  throw 'Refusing to clean a path outside a disposable M02 acceptance session'
}
$statePath = Join-Path $root 'session.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'Session marker is missing' }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if ($state.cluster_path -ne (Join-Path $root 'cluster') -or $state.data_root -ne (Join-Path $root 'data')) {
  throw 'Session paths do not match the disposable root'
}
$desktopPid = [int]$state.desktop_pid
if ($desktopPid -lt 0) { throw 'Session desktop PID is invalid' }
$desktop = if ($desktopPid -eq 0) { $null } else {
  Get-CimInstance Win32_Process -Filter "ProcessId = $desktopPid" -ErrorAction SilentlyContinue
}
if ($null -ne $desktop) {
  if ($desktop.ExecutablePath -ne $state.release_exe) { throw 'Desktop PID has been reused by another executable' }
  throw 'The desktop window is still running. Close it through the real UI before cleaning its PostgreSQL session.'
}
$desktopRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $desktopRoot)
$pgCtl = Join-Path $workspaceRoot '.research\runtime-cache\postgresql-18.6-2\pgsql\bin\pg_ctl.exe'
if (-not (Test-Path -LiteralPath $pgCtl -PathType Leaf)) { throw 'Expected portable pg_ctl is missing' }
& $pgCtl 'status' '-D' $state.cluster_path | Out-Null
$pgStatus = $LASTEXITCODE
if ($pgStatus -eq 0) {
  & $pgCtl 'stop' '-D' $state.cluster_path '-m' 'fast' '-w' '-t' '30'
  if ($LASTEXITCODE -ne 0) { throw "Disposable PostgreSQL stop failed: $LASTEXITCODE" }
} elseif ($pgStatus -ne 3) {
  throw "Disposable PostgreSQL status could not be verified: $pgStatus"
}
Remove-Item -LiteralPath $root -Recurse -Force
Write-Host "session_id=$($state.session_id) postgres_stop_exit=0 temporary_root_removed=$(-not (Test-Path -LiteralPath $root))"
