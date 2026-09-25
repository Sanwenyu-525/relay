[CmdletBinding()]
param(
  [switch]$SimulateNodeFailure
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$experimentRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $experimentRoot)
$runtimeCache = Join-Path $workspaceRoot '.research\runtime-cache'
$nodeExe = Join-Path $runtimeCache 'node-v24.21.0-win-x64\node.exe'
$pgBin = Join-Path $runtimeCache 'postgresql-18.6-2\pgsql\bin'
$initdb = Join-Path $pgBin 'initdb.exe'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$dataDirectory = Join-Path $runtimeCache 'postgresql-18.6-2\relay-p00-cluster'
$serverLog = Join-Path $runtimeCache 'postgresql-18.6-2\relay-p00-server.log'
$tsxCli = Join-Path $experimentRoot 'node_modules\tsx\dist\cli.mjs'
$runner = Join-Path $experimentRoot 'src\run-real-pg.ts'
$resultsDirectory = Join-Path $experimentRoot 'results'

New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null
$runId = "$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssfffZ')-$($([guid]::NewGuid().ToString('N')).Substring(0, 8))"
$runResultPath = Join-Path $resultsDirectory "$runId.json"
$latestResultPath = Join-Path $resultsDirectory 'latest.json'
$startedAt = (Get-Date).ToUniversalTime().ToString('o')

function Write-RunReport([object]$Report) {
  $json = "$($Report | ConvertTo-Json -Depth 8)`n"
  [System.IO.File]::WriteAllText($runResultPath, $json, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($latestResultPath, $json, [System.Text.UTF8Encoding]::new($false))
}

function Read-CurrentRunReport {
  if (-not (Test-Path -LiteralPath $runResultPath)) {
    return $null
  }

  try {
    $candidate = Get-Content -LiteralPath $runResultPath -Raw | ConvertFrom-Json
    if ($candidate.run_id -ne $runId) {
      return $null
    }
    return $candidate
  } catch {
    return $null
  }
}

$initialReport = [ordered]@{
  run_id = $runId
  started_at = $startedAt
  finished_at = $null
  status = 'RUNNING'
  assertions = @()
  environment = [ordered]@{}
  input_sha256 = [ordered]@{}
  cleanup = [ordered]@{
    test_database = 'runner has not started'
    dedicated_postgresql = 'dedicated PostgreSQL has not started'
  }
  process = [ordered]@{
    node_exit_code = $null
    postgres_start_exit_code = $null
    postgres_stop_exit_code = $null
    failure_phase = $null
  }
}
Write-RunReport $initialReport

$serverStarted = $false
$postgresStartExitCode = $null
$postgresStopExitCode = $null
$nodeExitCode = $null
$failurePhase = $null
$failureMessage = $null

try {
  foreach ($path in @($nodeExe, $initdb, $pgCtl, $tsxCli, $runner)) {
    if (-not (Test-Path -LiteralPath $path)) {
      throw "Required P00 file is missing: $path"
    }
  }

  if (-not (Test-Path -LiteralPath (Join-Path $dataDirectory 'PG_VERSION'))) {
    & $initdb '-D' $dataDirectory '-U' 'relay_p00_admin' '-A' 'trust' '--encoding=UTF8'
    if ($LASTEXITCODE -ne 0) {
      throw "initdb failed with exit code $LASTEXITCODE"
    }
  }

  & $pgCtl 'status' '-D' $dataDirectory | Out-Null
  if ($LASTEXITCODE -eq 0) {
    throw 'The dedicated P00 PostgreSQL data directory is already running. Stop that known P00 process before retrying.'
  }
  if ($LASTEXITCODE -ne 3) {
    throw "pg_ctl status failed with unexpected exit code $LASTEXITCODE"
  }

  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()

  & $pgCtl 'start' '-D' $dataDirectory '-l' $serverLog '-o' "-h 127.0.0.1 -p $port" '-w' '-t' '30'
  $postgresStartExitCode = $LASTEXITCODE
  if ($postgresStartExitCode -ne 0) {
    throw "pg_ctl start failed with exit code $postgresStartExitCode; inspect the dedicated log at $serverLog"
  }
  $serverStarted = $true

  if ($SimulateNodeFailure) {
    $nodeExitCode = 1
    $failurePhase = 'simulated_node_failure'
  } else {
    $env:P00_PG_ADMIN_URL = "postgresql://relay_p00_admin@127.0.0.1:$port/postgres"
    $env:P00_RESULT_PATH = $runResultPath
    $env:P00_RUN_ID = $runId
    & $nodeExe $tsxCli $runner
    $nodeExitCode = $LASTEXITCODE
    if ($nodeExitCode -ne 0) {
      $failurePhase = 'node_runner'
    }
  }
} catch {
  if ($null -eq $failurePhase) {
    $failurePhase = 'setup_or_runner'
  }
  $failureMessage = $_.Exception.Message
} finally {
  if ($serverStarted) {
    & $pgCtl 'stop' '-D' $dataDirectory '-m' 'fast' '-w' '-t' '30'
    $postgresStopExitCode = $LASTEXITCODE
    if ($postgresStopExitCode -ne 0 -and $null -eq $failurePhase) {
      $failurePhase = 'postgres_stop'
    }
  }
}

$nodeReport = Read-CurrentRunReport
$nodeReportIsAwaitingCleanup = $null -ne $nodeReport -and $nodeReport.status -eq 'AWAITING_SERVER_CLEANUP'
$passed = $serverStarted -and $nodeExitCode -eq 0 -and $postgresStopExitCode -eq 0 -and $nodeReportIsAwaitingCleanup

if (-not $passed -and $null -eq $failurePhase) {
  $failurePhase = 'result_report_or_cleanup'
}

$testDatabaseCleanup = if ($null -ne $nodeReport -and $null -ne $nodeReport.cleanup) {
  $nodeReport.cleanup.test_database
} else {
  'runner did not produce a current test-database cleanup report'
}
$dedicatedPostgresCleanup = if ($serverStarted -and $postgresStopExitCode -eq 0) {
  'pg_ctl stop completed by run-real-pg.ps1'
} elseif ($serverStarted) {
  'pg_ctl stop failed; inspect the dedicated server log'
} else {
  'dedicated PostgreSQL did not start'
}

$finalReport = [ordered]@{
  run_id = $runId
  started_at = if ($null -ne $nodeReport -and $null -ne $nodeReport.started_at) { $nodeReport.started_at } else { $startedAt }
  finished_at = (Get-Date).ToUniversalTime().ToString('o')
  status = if ($passed) { 'PASSED' } else { 'FAILED' }
  assertions = if ($null -ne $nodeReport) { @($nodeReport.assertions) } else { @() }
  environment = if ($null -ne $nodeReport) { $nodeReport.environment } else { [ordered]@{} }
  input_sha256 = if ($null -ne $nodeReport) { $nodeReport.input_sha256 } else { [ordered]@{} }
  cleanup = [ordered]@{
    test_database = $testDatabaseCleanup
    dedicated_postgresql = $dedicatedPostgresCleanup
  }
  process = [ordered]@{
    node_exit_code = $nodeExitCode
    postgres_start_exit_code = $postgresStartExitCode
    postgres_stop_exit_code = $postgresStopExitCode
    failure_phase = $failurePhase
  }
}
if ($null -ne $failureMessage) {
  $finalReport.process.failure_message = $failureMessage
}
Write-RunReport $finalReport

if ($passed) {
  exit 0
}

exit 1
