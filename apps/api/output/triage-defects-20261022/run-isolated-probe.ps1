# Runs the real PostgreSQL integration tests for apps/api.
# The cluster is created only inside a one-off temporary directory (dynamic loopback port,
# random relay_* database name). The script always stops it with pg_ctl and removes the directory.
# It never connects to another project or a user production database and never relies on a
# system-wide PostgreSQL installation.
# Roles: sql/bootstrap-roles.sql creates relay_migrator (DDL) and relay_app (application).
# The test database is owned by relay_migrator; tests connect with both real roles and never
# impersonate the application role with a superuser.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1
# On Windows hosts whose default locale is unavailable to initdb, add -UseCLocale.
# Keep this file ASCII-only: Windows PowerShell reads BOM-less scripts as ANSI.

[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [string]$TestFile = '',
  [string]$TestNamePattern = '',
  [switch]$UseCLocale
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$apiRoot = 'D:\Develop\Relay-Agent\apps\api'
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $apiRoot)
$runtimeCache = Join-Path $workspaceRoot '.research\runtime-cache'
$nodeExe = Join-Path $runtimeCache 'node-v24.21.0-win-x64\node.exe'
$postgresBin = Join-Path $runtimeCache 'postgresql-18.6-2\pgsql\bin'
$initdbExe = Join-Path $postgresBin 'initdb.exe'
$pgCtlExe = Join-Path $postgresBin 'pg_ctl.exe'
$psqlExe = Join-Path $postgresBin 'psql.exe'
$tscEntry = Join-Path $apiRoot 'node_modules\typescript\bin\tsc'
$bootstrapRoles = Join-Path $apiRoot 'sql\bootstrap-roles.sql'
$testDirectory = Join-Path $apiRoot 'output\triage-defects-20261022'
$testSourceDirectory = Join-Path $apiRoot 'output\triage-defects-20261022'
if ($TestFile -ne '') {
  if ($TestFile -notmatch '^[a-z0-9-]+(,[a-z0-9-]+)*$') { throw 'TestFile must be a comma-separated list of simple integration test basenames' }
  $requestedFiles = @($TestFile -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
} else {
  $requestedFiles = @()
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
$failedSuites = @()
$testFileNameIndex = @{}

Write-Host "Temporary cluster root: $temporaryRoot"

try {
  foreach ($requiredPath in @($nodeExe, $initdbExe, $pgCtlExe, $psqlExe, $tscEntry, $bootstrapRoles)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      throw "Required file is missing: $requiredPath"
    }
  }

  # Both resource registration and managed-content publication use native I/O.
  # Any suite may publish content indirectly; avoid a drifting basename list.
  # An explicitly supplied helper remains the exact artifact under test.
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and
      [string]::IsNullOrWhiteSpace($env:RELAY_FILE_IO_HELPER)) {
    $cargo = (Get-Command cargo -ErrorAction Stop).Source
    $helperManifest = Join-Path $workspaceRoot 'apps\file-io-helper\Cargo.toml'
    & $cargo build --locked --target x86_64-pc-windows-msvc --manifest-path $helperManifest
    if ($LASTEXITCODE -ne 0) { throw "Native file I/O helper build failed with exit code $LASTEXITCODE" }
    $sourceHelper = Join-Path $workspaceRoot 'apps\file-io-helper\target\x86_64-pc-windows-msvc\debug\relay-file-io-helper.exe'
    if (-not (Test-Path -LiteralPath $sourceHelper -PathType Leaf)) {
      throw "Native file I/O helper was not produced: $sourceHelper"
    }
    $env:RELAY_FILE_IO_HELPER = $sourceHelper
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
  # tsc leaves outputs for deleted sources behind. Run the current source suites,
  # so historical temporary acceptance probes cannot enter later regressions.
  $testSources = @(if ($TestFile -eq 'm03-mock-benchmark') {
    Get-Item -LiteralPath (Join-Path $testSourceDirectory 'm03-mock-benchmark.bench.ts')
  } else {
    Get-ChildItem -LiteralPath $testSourceDirectory -Recurse -File -Filter '*.test.ts' |
      Where-Object { $requestedFiles.Count -eq 0 -or $requestedFiles -contains ($_.Name -replace '\.integration\.test\.ts$', '') }
  })
  if ($testSources.Count -eq 0) {
    throw "Integration test sources are missing: $TestFile"
  }
  # 指定了文件就必须逐个解析到真实源文件：少匹配任何一个都要报错。
  # 静默少跑一个套件会让「定向回归全绿」看起来覆盖了实际没跑的出口。
  $resolvedNames = @($testSources | ForEach-Object { $_.Name -replace '\.integration\.test\.ts$', '' })
  $missing = @($requestedFiles | Where-Object { $resolvedNames -notcontains $_ })
  if ($missing.Count -gt 0) {
    throw ("No integration test source matched: " + ($missing -join ', '))
  }
  $testFiles = @($testSources | ForEach-Object {
    $relative = $_.FullName.Substring($testSourceDirectory.Length + 1)
    Join-Path $testDirectory ($relative -replace '\.ts$', '.js')
  })
  foreach ($testPath in $testFiles) {
    if (-not (Test-Path -LiteralPath $testPath -PathType Leaf)) {
      throw "Built integration test is missing: $testPath"
    }
  }
  Write-Host ("Current source integration suites: " + $testFiles.Count)
  # 每个文件一个短且唯一的库名后缀（PostgreSQL 标识符上限 63 字符）。
  for ($index = 0; $index -lt $testFiles.Count; $index += 1) {
    $testFileNameIndex[$testFiles[$index]] = ('f{0:d3}_{1}' -f $index,
      ([guid]::NewGuid().ToString('N')).Substring(0, 12))
  }

  $initdbArgs = @('-D', $dataDirectory, '-U', 'relay_api_admin', '-A', 'trust', '--encoding=UTF8')
  if ($UseCLocale) { $initdbArgs += '--locale=C' }
  $phaseWatch = [System.Diagnostics.Stopwatch]::StartNew()
  & $initdbExe @initdbArgs
  if ($LASTEXITCODE -ne 0) {
    throw "initdb failed with exit code $LASTEXITCODE"
  }
  Write-Host ("[timing] initdbMs=" + $phaseWatch.ElapsedMilliseconds)

  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()

  # Do not pipe pg_ctl start: postgres inherits the pipe write handle and PowerShell would
  # wait for an EOF that never arrives.
  $pgWatch = [System.Diagnostics.Stopwatch]::StartNew()
  # Maintenance must also detect a real prepared transaction after its client disconnects.
  & $pgCtlExe 'start' '-D' $dataDirectory '-l' $serverLog '-o' "-h 127.0.0.1 -p $port -c max_prepared_transactions=2" '-w' '-t' '30'
  $postgresStartExitCode = $LASTEXITCODE
  if ($postgresStartExitCode -ne 0) {
    throw "pg_ctl start failed with exit code $postgresStartExitCode; inspect $serverLog"
  }
  Write-Host ("[timing] postgresStartMs=" + $pgWatch.ElapsedMilliseconds)
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
    $migrateWatch = [System.Diagnostics.Stopwatch]::StartNew()
    & $nodeExe (Join-Path $apiRoot 'dist\src\cli\migrate.js')
    $businessMigrationExitCode = $LASTEXITCODE
    if ($businessMigrationExitCode -ne 0) {
      throw "business migration failed with exit code $businessMigrationExitCode"
    }
    Write-Host ("[timing] businessMigrationMs=" + $migrateWatch.ElapsedMilliseconds)
    & $nodeExe (Join-Path $apiRoot 'dist\src\cli\install-graph.js')
    $graphInstallExitCode = $LASTEXITCODE
    if ($graphInstallExitCode -ne 0) {
      throw "graph checkpoint installation failed with exit code $graphInstallExitCode"
    }
  } finally {
    [Environment]::SetEnvironmentVariable('RELAY_MIGRATION_DB_URL', $previousMigrationDatabaseUrl, 'Process')
  }

  # Do not pipe node --test either: the test process spawns the API process under test.
  #
  # 每个测试文件用**独占数据库**，而不是全部文件共享一个库。理由是生产语义本身是全局的：
  # Assist 领取（`claimNextPendingMessage`）、Run 命令队列与维护准入都按整库选取，
  # `--test-concurrency=1` 只保证文件不并发执行，并不提供任何数据隔离。共享一个库时，
  # 某个套件遗留的 PENDING 消息会被下一个套件启动的真实 API 进程领走，于是出现
  # 「单跑全绿、全量串行却失败」这种无法归因的组合失败。
  #
  # 这里按 `CREATE DATABASE ... TEMPLATE` 从已迁移的库克隆：迁移只跑一次，每个文件拿到
  # 干净副本，跑完即删。生产 claim 逻辑、维护门与连接安全门都不需要为此放宽。
  Push-Location $apiRoot
  try {
    $testExitCode = 0
    foreach ($testFile in $testFiles) {
      $fileDatabase = "relay_api_test_$($testFileNameIndex[$testFile])"
      # owner 必须显式指定：CREATE DATABASE ... TEMPLATE 默认把新库交给执行者（管理员），
      # 而 public schema 归 pg_database_owner，owner 变了迁移角色就失去建表权限。
      & $psqlExe $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' `
        '-c' "create database $fileDatabase template $databaseName owner relay_migrator"
      if ($LASTEXITCODE -ne 0) {
        throw "creating the isolated database for $testFile failed with exit code $LASTEXITCODE"
      }
      try {
        $env:RELAY_TEST_ADMIN_DATABASE_URL = "postgresql://relay_api_admin@127.0.0.1:$port/$fileDatabase"
        $env:RELAY_TEST_MIGRATION_DATABASE_URL = "postgresql://relay_migrator@127.0.0.1:$port/$fileDatabase"
        $env:RELAY_TEST_DATABASE_URL = "postgresql://relay_app@127.0.0.1:$port/$fileDatabase"
        if ($TestNamePattern -eq '') {
          & $nodeExe '--test' '--test-concurrency=1' $testFile
        } else {
          & $nodeExe '--test' '--test-concurrency=1' "--test-name-pattern=$TestNamePattern" $testFile
        }
        if ($LASTEXITCODE -ne 0) {
          $failedSuites += ([System.IO.Path]::GetFileNameWithoutExtension($testFile))
          $testExitCode = 1
        }
      } finally {
        & $psqlExe $adminUrl '-w' '-c' "drop database if exists $fileDatabase with (force)" | Out-Null
      }
    }
    if ($failedSuites.Count -gt 0) { Write-Host ("failing suites: " + ($failedSuites -join ', ')) }
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

