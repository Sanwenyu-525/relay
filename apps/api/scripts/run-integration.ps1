# Runs the real PostgreSQL integration tests for apps/api.
# The cluster is created only inside a one-off temporary directory (dynamic loopback port,
# random relay_* database name). The script always stops it with pg_ctl and removes the directory.
# It never connects to another project or a user production database and never relies on a
# system-wide PostgreSQL installation.
# Roles: sql/bootstrap-roles.sql creates relay_migrator (DDL) and relay_app (application).
# The test database is owned by relay_migrator; tests connect with both real roles and never
# impersonate the application role with a superuser.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1
# Keep this file ASCII-only: Windows PowerShell reads BOM-less scripts as ANSI.

[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [string]$TestFile = '',
  [string]$TestNamePattern = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$apiRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $apiRoot)
$runtimeCache = Join-Path $workspaceRoot '.research\runtime-cache'
$nodeExe = Join-Path $runtimeCache 'node-v24.21.0-win-x64\node.exe'
$postgresBin = Join-Path $runtimeCache 'postgresql-18.6-2\pgsql\bin'
$initdbExe = Join-Path $postgresBin 'initdb.exe'
$pgCtlExe = Join-Path $postgresBin 'pg_ctl.exe'
$psqlExe = Join-Path $postgresBin 'psql.exe'
$tscEntry = Join-Path $apiRoot 'node_modules\typescript\bin\tsc'
$bootstrapRoles = Join-Path $apiRoot 'sql\bootstrap-roles.sql'
$testDirectory = Join-Path $apiRoot 'dist\test\integration'
$testPattern = Join-Path $apiRoot 'dist\test\integration\**\*.test.js'
if ($TestFile -ne '') {
  if ($TestFile -notmatch '^[a-z0-9-]+$') { throw 'TestFile must be a simple integration test basename' }
  $testPattern = Join-Path $testDirectory "$TestFile.integration.test.js"
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("relay-api-integration-$($([guid]::NewGuid().ToString('N')).Substring(0, 10))")
$dataDirectory = Join-Path $temporaryRoot 'cluster'
$serverLog = Join-Path $temporaryRoot 'server.log'
$databaseName = "relay_api_test_$($([guid]::NewGuid().ToString('N')).Substring(0, 12))"

$serverStarted = $false
$postgresStartExitCode = $null
$postgresStopExitCode = $null
$testExitCode = $null
$buildExitCode = $null
$businessMigrationExitCode = $null
$graphInstallExitCode = $null
$directoryRemoved = $false
$failureMessage = $null

Write-Host "Temporary cluster root: $temporaryRoot"

try {
  foreach ($requiredPath in @($nodeExe, $initdbExe, $pgCtlExe, $psqlExe, $tscEntry, $bootstrapRoles)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      throw "Required file is missing: $requiredPath"
    }
  }

  New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null

  if (-not $SkipBuild) {
    Push-Location $apiRoot
    try {
      & $nodeExe $tscEntry -p tsconfig.json
      $buildExitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }

    if ($buildExitCode -ne 0) {
      throw "tsc build failed with exit code $buildExitCode"
    }
  }
  if (-not (Test-Path -LiteralPath $testDirectory) -or
      ($TestFile -ne '' -and -not (Test-Path -LiteralPath $testPattern))) {
    throw "Built integration tests are missing: $testPattern"
  }

  & $initdbExe '-D' $dataDirectory '-U' 'relay_api_admin' '-A' 'trust' '--encoding=UTF8'
  if ($LASTEXITCODE -ne 0) {
    throw "initdb failed with exit code $LASTEXITCODE"
  }

  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()

  # Do not pipe pg_ctl start: postgres inherits the pipe write handle and PowerShell would
  # wait for an EOF that never arrives.
  & $pgCtlExe 'start' '-D' $dataDirectory '-l' $serverLog '-o' "-h 127.0.0.1 -p $port" '-w' '-t' '30'
  $postgresStartExitCode = $LASTEXITCODE
  if ($postgresStartExitCode -ne 0) {
    throw "pg_ctl start failed with exit code $postgresStartExitCode; inspect $serverLog"
  }
  $serverStarted = $true

  & $pgCtlExe 'status' '-D' $dataDirectory
  if ($LASTEXITCODE -ne 0) {
    throw "the temporary PostgreSQL cluster is not running after pg_ctl start; inspect $serverLog"
  }

  $adminUrl = "postgresql://relay_api_admin@127.0.0.1:$port/postgres"

  # Create the real migration and application roles, then hand the test database to the migration role.
  & $psqlExe $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-f' $bootstrapRoles
  if ($LASTEXITCODE -ne 0) {
    throw "creating the relay roles failed with exit code $LASTEXITCODE"
  }

  & $psqlExe $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-c' "create database $databaseName owner relay_migrator"
  if ($LASTEXITCODE -ne 0) {
    throw "creating the temporary test database failed with exit code $LASTEXITCODE"
  }

  $env:RELAY_TEST_ADMIN_DATABASE_URL = "postgresql://relay_api_admin@127.0.0.1:$port/$databaseName"
  $env:RELAY_TEST_MIGRATION_DATABASE_URL = "postgresql://relay_migrator@127.0.0.1:$port/$databaseName"
  $env:RELAY_TEST_DATABASE_URL = "postgresql://relay_app@127.0.0.1:$port/$databaseName"
  Write-Host "Test database: $databaseName on 127.0.0.1:$port (roles relay_migrator / relay_app)"

  # Business migrations precede the separate, trusted official Saver setup.
  # Do not leak the temporary migrator URL into CLI negative tests or the caller.
  $previousMigrationDatabaseUrl = [Environment]::GetEnvironmentVariable('RELAY_MIGRATION_DB_URL', 'Process')
  try {
    $env:RELAY_MIGRATION_DB_URL = $env:RELAY_TEST_MIGRATION_DATABASE_URL
    & $nodeExe (Join-Path $apiRoot 'dist\src\cli\migrate.js')
    $businessMigrationExitCode = $LASTEXITCODE
    if ($businessMigrationExitCode -ne 0) {
      throw "business migration failed with exit code $businessMigrationExitCode"
    }
    & $nodeExe (Join-Path $apiRoot 'dist\src\cli\install-graph.js')
    $graphInstallExitCode = $LASTEXITCODE
    if ($graphInstallExitCode -ne 0) {
      throw "graph checkpoint installation failed with exit code $graphInstallExitCode"
    }
  } finally {
    [Environment]::SetEnvironmentVariable('RELAY_MIGRATION_DB_URL', $previousMigrationDatabaseUrl, 'Process')
  }

  # Do not pipe node --test either: the test process spawns the API process under test.
  # Test files share this database; one test temporarily changes table-level RLS.
  # Keep files serial so that policy cannot hide rows from an unrelated file.
  Push-Location $apiRoot
  try {
    if ($TestNamePattern -eq '') {
      & $nodeExe '--test' '--test-concurrency=1' $testPattern
    } else {
      & $nodeExe '--test' '--test-concurrency=1' "--test-name-pattern=$TestNamePattern" $testPattern
    }
    $testExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} catch {
  $failureMessage = $_.Exception.Message

  if (Test-Path -LiteralPath $serverLog) {
    Write-Host '--- dedicated PostgreSQL log (tail) ---'
    Get-Content -LiteralPath $serverLog -Tail 40
  }
} finally {
  if ($serverStarted) {
    & $pgCtlExe 'stop' '-D' $dataDirectory '-m' 'fast' '-w' '-t' '30'
    $postgresStopExitCode = $LASTEXITCODE
  }

  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
  $directoryRemoved = -not (Test-Path -LiteralPath $temporaryRoot)
}

$passed = ($testExitCode -eq 0) -and ($businessMigrationExitCode -eq 0) -and ($graphInstallExitCode -eq 0) -and
  ($postgresStopExitCode -eq 0) -and $directoryRemoved -and ($null -eq $failureMessage)

Write-Host '--- integration summary ---'
Write-Host "tests exit code: $(if ($null -eq $testExitCode) { 'not run' } else { $testExitCode })"
Write-Host "build exit code: $(if ($null -eq $buildExitCode) { 'skipped' } else { $buildExitCode })"
Write-Host "business migration exit code: $(if ($null -eq $businessMigrationExitCode) { 'not run' } else { $businessMigrationExitCode })"
Write-Host "graph install exit code: $(if ($null -eq $graphInstallExitCode) { 'not run' } else { $graphInstallExitCode })"
Write-Host "postgres start exit code: $(if ($null -eq $postgresStartExitCode) { 'not started' } else { $postgresStartExitCode })"
Write-Host "postgres stop exit code: $(if ($null -eq $postgresStopExitCode) { 'not stopped' } else { $postgresStopExitCode })"
Write-Host "temporary cluster removed: $directoryRemoved"
if ($null -ne $failureMessage) {
  Write-Host "failure: $failureMessage"
}

if ($passed) {
  Write-Host 'status: PASSED'
  exit 0
}

Write-Host 'status: FAILED'
exit 1
