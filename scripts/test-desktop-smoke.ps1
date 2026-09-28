# Run after dev-stack.bat Build. Uses the dedicated trial database and preserves it.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'dev-stack.bat'
$trial = Join-Path $root '.relay-test'
$pg = Join-Path $root '.research\runtime-cache\postgresql-18.6-2\pgsql\bin'
function Invoke-Entry {
  param([string[]]$Arguments)
  & $entry @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Entry failed: $Arguments" }
}
Invoke-Entry @('Start', '-SkipDesktop')
$before = Get-Content -LiteralPath (Join-Path $trial 'session.json') -Raw | ConvertFrom-Json
$content = [guid]::NewGuid().ToString()
$probe = Join-Path $trial "data\launcher-smoke-$content.txt"
Set-Content -LiteralPath $probe -Value $content
Invoke-Entry @('Start', '-SkipDesktop')
Invoke-Entry @('Stop')
& (Join-Path $pg 'pg_ctl.exe') status -D (Join-Path $trial 'cluster') *> $null
if ($LASTEXITCODE -ne 3) { throw 'PostgreSQL did not stop' }
Invoke-Entry @('Stop')
Invoke-Entry @('Start', '-SkipDesktop')
try {
  $after = Get-Content -LiteralPath (Join-Path $trial 'session.json') -Raw | ConvertFrom-Json
  if ($before.workspace_id -ne $after.workspace_id -or $before.command_id -ne $after.command_id) { throw 'Workspace identity changed after restart' }
  if ((Get-Content -LiteralPath $probe -Raw).Trim() -ne $content) { throw 'Data did not survive restart' }
  $count = & (Join-Path $pg 'psql.exe') "postgresql://relay_api_admin@127.0.0.1:$($after.port)/relay_trial" -w -tAc "SELECT count(*) FROM workspaces WHERE id='$($after.workspace_id)'"
  if ($LASTEXITCODE -ne 0 -or ($count -join '').Trim() -ne '1') { throw 'Workspace was not retained in PostgreSQL' }
  $handle = [IO.File]::Open((Join-Path $trial 'launcher.lock'), 'Open', 'ReadWrite', 'None')
  try {
    $ErrorActionPreference = 'Continue'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'test-desktop.ps1') Status *> $null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -eq 0) { throw 'Concurrent launcher was not rejected' }
  } finally { $ErrorActionPreference = 'Stop'; $handle.Dispose() }
} finally { Invoke-Entry @('Stop') }
Remove-Item -LiteralPath $probe
Write-Host 'PASS: initialization, repeated start/stop, PostgreSQL + file persistence, stable workspace, exclusive launcher lock.'
