# M01-only isolated PostgreSQL cluster. Never connects to a user database.
# Keep ASCII: Windows PowerShell reads BOM-less scripts as ANSI.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$experimentRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $experimentRoot)
$runtimeCache = Join-Path $workspaceRoot '.research\runtime-cache'
$nodeExe = Join-Path $runtimeCache 'node-v24.21.0-win-x64\node.exe'
$postgresBin = Join-Path $runtimeCache 'postgresql-18.6-2\pgsql\bin'
$initdbExe = Join-Path $postgresBin 'initdb.exe'
$pgCtlExe = Join-Path $postgresBin 'pg_ctl.exe'
$psqlExe = Join-Path $postgresBin 'psql.exe'
$bootstrapRoles = Join-Path $workspaceRoot 'apps\api\sql\bootstrap-roles.sql'

$temporaryBase = [System.IO.Path]::GetTempPath()
$temporaryRoot = Join-Path $temporaryBase ("relay-m01-pg-$([guid]::NewGuid().ToString('N'))")
$dataDirectory = Join-Path $temporaryRoot 'cluster'
$serverLog = Join-Path $temporaryRoot 'server.log'
$databaseName = "relay_m01_$($([guid]::NewGuid().ToString('N')).Substring(0, 12))"
$started = $false
$testExit = $null
$stopExit = $null
$failure = $null

try {
  foreach ($required in @($nodeExe, $initdbExe, $pgCtlExe, $psqlExe, $bootstrapRoles)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing required file: $required" }
  }
  New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
  & $initdbExe '-D' $dataDirectory '-U' 'relay_api_admin' '-A' 'trust' '--encoding=UTF8' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "initdb exit: $LASTEXITCODE" }

  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()

  # Do not pipe pg_ctl start: postgres can inherit the pipe writer and prevent EOF.
  & $pgCtlExe 'start' '-D' $dataDirectory '-l' $serverLog '-o' "-h 127.0.0.1 -p $port" '-w' '-t' '30'
  if ($LASTEXITCODE -ne 0) { throw "pg_ctl start exit: $LASTEXITCODE" }
  $started = $true

  $adminUrl = "postgresql://relay_api_admin@127.0.0.1:$port/postgres"
  & $psqlExe $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-f' $bootstrapRoles | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "bootstrap roles exit: $LASTEXITCODE" }
  & $psqlExe $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-c' "create database $databaseName owner relay_migrator" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "create database exit: $LASTEXITCODE" }

  $env:RELAY_M01_MIGRATION_URL = "postgresql://relay_migrator@127.0.0.1:$port/$databaseName"
  $env:RELAY_M01_APP_URL = "postgresql://relay_app@127.0.0.1:$port/$databaseName"
  Write-Host "M01 isolated PostgreSQL: 18.6, loopback dynamic port, roles relay_migrator/relay_app"
  Push-Location $experimentRoot
  try {
    & $nodeExe '--test' 'src/stack-pg.test.mjs'
    $testExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} catch {
  $failure = $_.Exception.Message
  if (Test-Path -LiteralPath $serverLog) { Get-Content -LiteralPath $serverLog -Tail 25 }
} finally {
  Remove-Item Env:RELAY_M01_MIGRATION_URL -ErrorAction SilentlyContinue
  Remove-Item Env:RELAY_M01_APP_URL -ErrorAction SilentlyContinue
  if ($started) {
    & $pgCtlExe 'stop' '-D' $dataDirectory '-m' 'fast' '-w' '-t' '30' | Out-Null
    $stopExit = $LASTEXITCODE
  }
  if (Test-Path -LiteralPath $temporaryRoot) {
    $resolved = (Resolve-Path -LiteralPath $temporaryRoot).Path
    $base = [System.IO.Path]::GetFullPath($temporaryBase).TrimEnd('\')
    if (-not $resolved.StartsWith($base + '\relay-m01-pg-', [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove unexpected path: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

$removed = -not (Test-Path -LiteralPath $temporaryRoot)
Write-Host "M01 summary: test_exit=$testExit stop_exit=$stopExit temporary_cluster_removed=$removed"
if ($null -ne $failure) { Write-Host "M01 failure: $failure" }
if ($testExit -eq 0 -and $stopExit -eq 0 -and $removed -and $null -eq $failure) { exit 0 }
exit 1
