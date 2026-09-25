# Start a disposable PostgreSQL-backed desktop session for real Windows UI acceptance.
# This is test infrastructure; it never configures or manages an existing user PostgreSQL service.
[CmdletBinding()]
param([switch]$SkipDesktop, [switch]$InstallGraph)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent $PSScriptRoot
$appsRoot = Split-Path -Parent $desktopRoot
$workspaceRoot = Split-Path -Parent $appsRoot
$releaseRoot = Join-Path $desktopRoot 'release'
$exe = Join-Path $releaseRoot 'relay-desktop.exe'
$node = Join-Path $releaseRoot 'node.exe'
$apiRoot = Join-Path $releaseRoot 'api'
$pgBin = Join-Path $workspaceRoot '.research\runtime-cache\postgresql-18.6-2\pgsql\bin'
$initdb = Join-Path $pgBin 'initdb.exe'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$psql = Join-Path $pgBin 'psql.exe'
$roles = Join-Path $appsRoot 'api\sql\bootstrap-roles.sql'
$graphInstaller = Join-Path $apiRoot 'dist\src\cli\install-graph.js'
$requiredInputs = @($exe, $node, (Join-Path $apiRoot 'dist\src\cli\migrate.js'), (Join-Path $apiRoot 'dist\src\cli\init-workspace.js'), $initdb, $pgCtl, $psql, $roles)
if ($InstallGraph) { $requiredInputs += $graphInstaller }
foreach ($required in $requiredInputs) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required acceptance input is missing: $required" }
}

$sessionId = [guid]::NewGuid().ToString('N')
$sessionRoot = Join-Path ([IO.Path]::GetTempPath()) "relay-m02-acceptance-$sessionId"
$cluster = Join-Path $sessionRoot 'cluster'
$log = Join-Path $sessionRoot 'postgres.log'
$config = Join-Path $sessionRoot 'desktop.env'
$data = Join-Path $sessionRoot 'data'
$statePath = Join-Path $sessionRoot 'session.json'
$pgStarted = $false
$desktopStarted = $false
New-Item -ItemType Directory -Path $sessionRoot, $data -Force | Out-Null
try {
  & $initdb '-D' $cluster '-U' 'relay_api_admin' '-A' 'trust' '--encoding=UTF8'
  if ($LASTEXITCODE -ne 0) { throw "initdb exit: $LASTEXITCODE" }
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  # Even a timed-out pg_ctl start may have spawned this disposable server.
  $pgStarted = $true
  & $pgCtl 'start' '-D' $cluster '-l' $log '-o' "-h 127.0.0.1 -p $port" '-w' '-t' '30'
  if ($LASTEXITCODE -ne 0) { throw "pg_ctl start exit: $LASTEXITCODE" }
  $state = [ordered]@{
    schema_version = 1
    session_id = $sessionId
    release_exe = $exe
    release_sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    cluster_path = $cluster
    postgres_port = $port
    desktop_pid = 0
    config_path = $config
    data_root = $data
    workspace_id = $null
  }
  $state | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $statePath -Encoding utf8

  $adminUrl = "postgresql://relay_api_admin@127.0.0.1:$port/postgres"
  $migrationUrl = "postgresql://relay_migrator@127.0.0.1:$port/relay_m02_acceptance"
  $appUrl = "postgresql://relay_app@127.0.0.1:$port/relay_m02_acceptance"
  & $psql $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-f' $roles
  if ($LASTEXITCODE -ne 0) { throw "role bootstrap exit: $LASTEXITCODE" }
  & $psql $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-c' 'create database relay_m02_acceptance owner relay_migrator'
  if ($LASTEXITCODE -ne 0) { throw "test database creation exit: $LASTEXITCODE" }
  $env:RELAY_MIGRATION_DB_URL = $migrationUrl
  & $node (Join-Path $apiRoot 'dist\src\cli\migrate.js')
  if ($LASTEXITCODE -ne 0) { throw "release migration exit: $LASTEXITCODE" }
  if ($InstallGraph) {
    & $node $graphInstaller
    if ($LASTEXITCODE -ne 0) { throw "release graph install exit: $LASTEXITCODE" }
    Write-Host 'graph_install_exit=0'
  }
  Remove-Item Env:RELAY_MIGRATION_DB_URL
  if (Test-Path Env:RELAY_MIGRATION_DB_URL) { throw 'Migrator URL remained in runtime environment' }
  Write-Host 'runtime_migrator_url_cleared=true'
  $env:RELAY_DB_URL = $appUrl
  $workspaceResult = & $node (Join-Path $apiRoot 'dist\src\cli\init-workspace.js') '--name' 'M02 acceptance'
  if ($LASTEXITCODE -ne 0) { throw "release workspace init exit: $LASTEXITCODE" }
  $workspaceId = (($workspaceResult -join "`n") | ConvertFrom-Json).result.workspace_id
  if ($workspaceId -notmatch '^[0-9a-f-]{36}$') { throw 'Workspace initialization did not return a UUID' }

  $configBody = "RELAY_DB_URL=$appUrl`nRELAY_DB_POOL_MAX=4`nRELAY_DB_CONNECT_TIMEOUT_MS=3000`nRELAY_DESKTOP_WORKSPACE_ID=$workspaceId`n"
  [IO.File]::WriteAllText($config, $configBody, [Text.UTF8Encoding]::new($false))
  $env:RELAY_DESKTOP_CONFIG_PATH = $config
  $env:RELAY_DESKTOP_DATA_ROOT = $data
  $state.workspace_id = $workspaceId
  $state | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $statePath -Encoding utf8
  if (-not $SkipDesktop) {
    $desktop = Start-Process -FilePath $exe -PassThru
    $desktopStarted = $true
    $state.desktop_pid = $desktop.Id
    $state | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $statePath -Encoding utf8
    Start-Sleep -Seconds 3
    $desktop.Refresh()
    if ($desktop.HasExited) { throw "Release desktop exited during startup: $($desktop.ExitCode)" }
  }

  Write-Host "session_id=$sessionId"
  Write-Host "session_root=$sessionRoot"
  Write-Host "postgres_port=$port"
  Write-Host "desktop_pid=$($state.desktop_pid)"
  Write-Host "release_sha256=$((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant())"
  Write-Host "cleanup: powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/stop-acceptance-session.ps1 -SessionRoot `"$sessionRoot`""
} catch {
  $desktopStillRunning = $desktopStarted -and (-not $desktop.HasExited)
  if (-not $desktopStillRunning) {
    if ($pgStarted) {
      & $pgCtl 'stop' '-D' $cluster '-m' 'fast' '-w' '-t' '30' | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Host "Disposable PostgreSQL did not stop. Session kept at $sessionRoot; inspect $cluster, then retry the stop script with -SessionRoot `"$sessionRoot`". If the marker is missing, run: & `"$pgCtl`" stop -D `"$cluster`" -m fast -w -t 30."
        throw
      }
    }
    $resolved = [IO.Path]::GetFullPath($sessionRoot)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'relay-m02-acceptance-*') {
      Remove-Item -LiteralPath $resolved -Recurse -Force
    }
  } else {
    Write-Host "Desktop startup failed while its process is still running. Inspect/close that window, then run: powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/stop-acceptance-session.ps1 -SessionRoot `"$sessionRoot`""
  }
  throw
}
