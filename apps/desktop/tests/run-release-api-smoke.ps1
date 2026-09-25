# Real PostgreSQL and exact release Node/API check; no desktop window is started.
# Keep ASCII-only for Windows PowerShell 5.1.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $desktopRoot)
$releaseRoot = Join-Path $desktopRoot 'release'
$exe = Join-Path $releaseRoot 'relay-desktop.exe'
$node = Join-Path $releaseRoot 'node.exe'
$api = Join-Path $releaseRoot 'api'
$pgBin = Join-Path $workspaceRoot '.research\runtime-cache\postgresql-18.6-2\pgsql\bin'
$initdb = Join-Path $pgBin 'initdb.exe'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$psql = Join-Path $pgBin 'psql.exe'
$roles = Join-Path $workspaceRoot 'apps\api\sql\bootstrap-roles.sql'
$check = Join-Path $PSScriptRoot 'check-release-api.mjs'
foreach ($file in @($exe, $node, (Join-Path $api 'dist\src\cli\migrate.js'), (Join-Path $api 'dist\src\cli\init-workspace.js'), $initdb, $pgCtl, $psql, $roles, $check)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required smoke-test input is missing: $file" }
}

$id = [guid]::NewGuid().ToString('N')
$root = Join-Path ([IO.Path]::GetTempPath()) "relay-m02-acceptance-$id"
$cluster = Join-Path $root 'cluster'
$log = Join-Path $root 'postgres.log'
$config = Join-Path $root 'desktop.env'
$data = Join-Path $root 'data'
$marker = Join-Path $root 'session.json'
$pgStartAttempted = $false
$pgStopped = $false
$passed = $false
New-Item -ItemType Directory -Path $root, $data -Force | Out-Null
Write-Host "api_smoke_session=$id"
try {
  & $initdb '-D' $cluster '-U' 'relay_api_admin' '-A' 'trust' '--encoding=UTF8'
  if ($LASTEXITCODE -ne 0) { throw "initdb exit $LASTEXITCODE" }
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $pgStartAttempted = $true
  & $pgCtl 'start' '-D' $cluster '-l' $log '-o' "-h 127.0.0.1 -p $port" '-w' '-t' '30'
  if ($LASTEXITCODE -ne 0) { throw "pg_ctl start exit $LASTEXITCODE" }

  $adminUrl = "postgresql://relay_api_admin@127.0.0.1:$port/postgres"
  $migrationUrl = "postgresql://relay_migrator@127.0.0.1:$port/relay_m02_acceptance"
  $appUrl = "postgresql://relay_app@127.0.0.1:$port/relay_m02_acceptance"
  & $psql $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-f' $roles
  if ($LASTEXITCODE -ne 0) { throw "role bootstrap exit $LASTEXITCODE" }
  & $psql $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-c' 'create database relay_m02_acceptance owner relay_migrator'
  if ($LASTEXITCODE -ne 0) { throw "database creation exit $LASTEXITCODE" }

  $env:RELAY_MIGRATION_DB_URL = $migrationUrl
  & $node (Join-Path $api 'dist\src\cli\migrate.js')
  if ($LASTEXITCODE -ne 0) { throw "release migration exit $LASTEXITCODE" }
  $env:RELAY_DB_URL = $appUrl
  $workspaceResult = & $node (Join-Path $api 'dist\src\cli\init-workspace.js') '--name' 'M02 package smoke'
  if ($LASTEXITCODE -ne 0) { throw "release workspace initialization exit $LASTEXITCODE" }
  $workspaceId = (($workspaceResult -join "`n") | ConvertFrom-Json).result.workspace_id
  if ($workspaceId -notmatch '^[0-9a-f-]{36}$') { throw 'Workspace initialization did not return a UUID' }

  [IO.File]::WriteAllText($config, "RELAY_DB_URL=$appUrl`nRELAY_DB_POOL_MAX=4`nRELAY_DB_CONNECT_TIMEOUT_MS=3000`nRELAY_DESKTOP_WORKSPACE_ID=$workspaceId`n", [Text.UTF8Encoding]::new($false))
  [ordered]@{
    session_id = $id
    release_exe = $exe
    release_sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    cluster_path = $cluster
    postgres_port = $port
    desktop_pid = 0
    config_path = $config
    data_root = $data
    workspace_id = $workspaceId
  } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $marker -Encoding utf8
  & $node $check $root
  if ($LASTEXITCODE -ne 0) { throw "release API child check exit $LASTEXITCODE" }
  $passed = $true
} catch {
  Write-Host "smoke_failure=$($_.Exception.Message)"
} finally {
  if ($pgStartAttempted) {
    & $pgCtl 'stop' '-D' $cluster '-m' 'fast' '-w' '-t' '30'
    $pgStopped = ($LASTEXITCODE -eq 0)
  }
  if ($pgStopped -or -not $pgStartAttempted) {
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $resolved = [IO.Path]::GetFullPath($root)
    if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $resolved) -ne "relay-m02-acceptance-$id") {
      throw 'Refusing to remove a path outside this disposable session'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  } else {
    Write-Host "postgres_stop_failed_preserved=$root"
  }
}
Write-Host "postgres_stop_exit=$(if($pgStopped){0}else{'failed_or_not_started'}) temporary_root_removed=$(-not (Test-Path -LiteralPath $root))"
if ($passed -and $pgStopped -and -not (Test-Path -LiteralPath $root)) { exit 0 }
exit 1
