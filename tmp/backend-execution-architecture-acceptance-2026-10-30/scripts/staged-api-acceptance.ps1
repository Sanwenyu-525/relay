# Staged desktop API acceptance (2026-10-30 backend execution architecture round).
# Exercises, against the REAL staged API produced by stage-api.ps1:
#   1. content-fingerprint staging (.build-info.json present, no swap leftovers)
#   2. boot on a one-off PostgreSQL cluster (business migrations via the staged CLI)
#   3. GET /assist-sessions/:id/todos -> 404 problem+json RESOURCE_NOT_FOUND (session invisible)
#   4. GET /definitely-not-a-route   -> bare Fastify 404 (route missing) - the two 404s stay distinct
#   5. restart the API process -> the /todos route still answers with the same semantics
# The cluster and data root live in one temp directory and are always removed.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$EvidenceRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$runtimeCache = Join-Path $RepoRoot '.research\runtime-cache'
$nodeExe = Join-Path $runtimeCache 'node-v24.21.0-win-x64\node.exe'
$postgresBin = Join-Path $runtimeCache 'postgresql-18.6-2\pgsql\bin'
$initdbExe = Join-Path $postgresBin 'initdb.exe'
$pgCtlExe = Join-Path $postgresBin 'pg_ctl.exe'
$psqlExe = Join-Path $postgresBin 'psql.exe'
$stagedApi = Join-Path $RepoRoot 'apps\desktop\src-tauri\resources\api'
$bootstrapRoles = Join-Path $RepoRoot 'apps\api\sql\bootstrap-roles.sql'

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("relay-staged-api-" + [guid]::NewGuid().ToString('N').Substring(0, 10))
$dataDirectory = Join-Path $tempRoot 'cluster'
$serverLog = Join-Path $tempRoot 'pg.log'
$dataRoot = Join-Path $tempRoot 'data'
$databaseName = "relay_staged_$([guid]::NewGuid().ToString('N').Substring(0, 12))"
$results = [ordered]@{}

function Add-Result([string]$Name, [bool]$Passed, [string]$Detail) {
  $script:results[$Name] = [ordered]@{ passed = $Passed; detail = $Detail }
  $mark = if ($Passed) { 'PASS' } else { 'FAIL' }
  Write-Host "[$mark] $Name :: $Detail"
}

# PS 5.1's Invoke-WebRequest consumes the error stream internally, leaving an empty body on
# 404s; HttpClient keeps the body readable and never throws on non-2xx statuses.
Add-Type -AssemblyName System.Net.Http
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(15)
function Invoke-JsonGet([string]$Url, [string]$Token) {
  $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $Url)
  $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Token)
  $response = $client.SendAsync($request).GetAwaiter().GetResult()
  $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $contentType = ''
  if ($response.Content.Headers.ContentType -ne $null) {
    $contentType = $response.Content.Headers.ContentType.ToString()
  }
  $response.Dispose()
  return @{ status = [int]$response.StatusCode; contentType = $contentType; body = $body }
}

$serverStarted = $false
try {
  foreach ($requiredPath in @($nodeExe, $initdbExe, $pgCtlExe, $psqlExe, $bootstrapRoles)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) { throw "missing: $requiredPath" }
  }
  New-Item -ItemType Directory -Force -Path $tempRoot, $dataRoot | Out-Null

  # --- 1. staged layout checks -------------------------------------------------
  $entry = Join-Path $stagedApi 'dist\src\main.js'
  $buildInfoPath = Join-Path $stagedApi '.build-info.json'
  Add-Result 'staged entry exists' (Test-Path -LiteralPath $entry -PathType Leaf) $entry
  $buildInfoOk = $false
  $buildInfoDetail = 'missing'
  if (Test-Path -LiteralPath $buildInfoPath -PathType Leaf) {
    try {
      $info = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
      $buildInfoOk = ($info.PSObject.Properties.Name -contains 'sourceHash') -and
        ($info.sourceHash -is [string] -and $info.sourceHash.Length -ge 32)
      $buildInfoDetail = "sourceHash=$($info.sourceHash.Substring(0, 12)) builtAt=$($info.builtAt)"
    } catch { $buildInfoDetail = "unreadable: $($_.Exception.Message)" }
  }
  Add-Result 'staged fingerprint record' $buildInfoOk $buildInfoDetail
  $leftovers = @(Get-ChildItem -LiteralPath (Split-Path -Parent $stagedApi) -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'api.staging-*' -or $_.Name -like 'api.previous-*' })
  Add-Result 'no swap leftovers' ($leftovers.Count -eq 0) ("leftovers=" + $leftovers.Count)

  # --- 2. one-off cluster + staged CLI migrations ------------------------------
  & $initdbExe -D $dataDirectory -U relay_api_admin -A trust --encoding=UTF8 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start(); $pgPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
  # Do NOT pipe pg_ctl start: the postmaster inherits the pipe write handle and PowerShell
  # would wait forever for an EOF that never arrives (same rule as run-integration.ps1).
  & $pgCtlExe 'start' '-D' $dataDirectory '-l' $serverLog '-o' "-h 127.0.0.1 -p $pgPort -c max_prepared_transactions=2" '-w' '-t' '30'
  if ($LASTEXITCODE -ne 0) { throw 'pg_ctl start failed' }
  $serverStarted = $true
  $adminUrl = "postgresql://relay_api_admin@127.0.0.1:$pgPort/postgres"
  & $psqlExe $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-f' $bootstrapRoles | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'bootstrap roles failed' }
  & $psqlExe $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-c' "create database $databaseName owner relay_migrator" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'create database failed' }
  $migrationUrl = "postgresql://relay_migrator@127.0.0.1:$pgPort/$databaseName"
  $appUrl = "postgresql://relay_app@127.0.0.1:$pgPort/$databaseName"

  $previousMigrationUrl = [Environment]::GetEnvironmentVariable('RELAY_MIGRATION_DB_URL', 'Process')
  $env:RELAY_MIGRATION_DB_URL = $migrationUrl
  try {
    & $nodeExe (Join-Path $stagedApi 'dist\src\cli\migrate.js') 2>&1 | Tee-Object -Variable migrateLog | Out-Null
    Add-Result 'staged cli migrate' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
    & $nodeExe (Join-Path $stagedApi 'dist\src\cli\install-graph.js') 2>&1 | Out-Null
    Add-Result 'staged cli install-graph' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
  } finally {
    [Environment]::SetEnvironmentVariable('RELAY_MIGRATION_DB_URL', $previousMigrationUrl, 'Process')
  }

  # --- 3. boot the staged API --------------------------------------------------
  $apiPort = 0
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start(); $apiPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
  $bearer = (-join ((1..48) | ForEach-Object { [char](Get-Random -InputObject (97..122)) }))
  $apiEnv = @{
    RELAY_API_BIND_HOST = '127.0.0.1'
    RELAY_API_PORT = [string]$apiPort
    RELAY_API_ALLOWED_ORIGINS = 'http://127.0.0.1:5173'
    RELAY_API_BEARER_TOKEN = $bearer
    RELAY_DB_URL = $appUrl
    RELAY_DB_POOL_MAX = '8'
    RELAY_DB_CONNECT_TIMEOUT_MS = '5000'
    RELAY_DATA_ROOT = $dataRoot
    RELAY_LOG_LEVEL = 'info'
    RELAY_API_STOP_ON_STDIN_EOF = 'false'
  }
  function Start-StagedApi {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeExe
    $psi.Arguments = "`"$(Join-Path $stagedApi 'dist\src\main.js')`""
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    foreach ($key in $apiEnv.Keys) { $psi.EnvironmentVariables[$key] = $apiEnv[$key] }
    # Inherit this script's stdout/stderr: config failures print their error code to stderr
    # and must be visible in the acceptance log, and inherited handles never fill a pipe.
    $process = [System.Diagnostics.Process]::Start($psi)
    return $process
  }
  function Wait-Liveness($process, [int]$port, [string]$token) {
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
      if ($process.HasExited) { throw "staged api exited early: $($process.ExitCode)" }
      try {
        $probe = Invoke-JsonGet "http://127.0.0.1:$port/health/live" $token
        if ($probe.status -eq 200) { return $true }
      } catch { }
      Start-Sleep -Milliseconds 500
    }
    return $false
  }

  $apiProcess = Start-StagedApi
  $firstBootLive = Wait-Liveness $apiProcess $apiPort $bearer
  Add-Result 'first boot liveness' $firstBootLive "port=$apiPort pid=$($apiProcess.Id)"

  $sessionUrl = "http://127.0.0.1:$apiPort/api/v1/workspaces/$([guid]::NewGuid())/assist-sessions/$([guid]::NewGuid())/todos"
  $todosProbe = Invoke-JsonGet $sessionUrl $bearer
  Write-Host ("todos probe: status={0} ct={1} body={2}" -f $todosProbe.status, $todosProbe.contentType, $todosProbe.body)
  $todosProblem = $todosProbe.body | ConvertFrom-Json
  if ($todosProblem.PSObject.Properties.Name -notcontains 'code') { throw "todos problem body has no code: $($todosProbe.body)" }
  Add-Result 'todos 404 is session-invisible' (($todosProbe.status -eq 404) -and
    ($todosProbe.contentType -like 'application/problem+json*') -and
    ($todosProblem.code -eq 'RESOURCE_NOT_FOUND')) "status=$($todosProbe.status) code=$($todosProblem.code) ct=$($todosProbe.contentType)"
  # The API shapes EVERY 404 through its global notFoundHandler (problem+json RESOURCE_NOT_FOUND,
  # in place since the initial commit). "Route missing" and "session invisible" therefore carry
  # the same code on a current build; the client tells them apart by probing the known session
  # endpoint (apps/workbench/src/api/resources/sessionTodos.ts), not by the body alone.
  $missingRouteUrl = "http://127.0.0.1:$apiPort/api/v1/workspaces/$([guid]::NewGuid())/definitely-not-a-route"
  $missingProbe = Invoke-JsonGet $missingRouteUrl $bearer
  $missingBody = $missingProbe.body | ConvertFrom-Json
  Add-Result 'route-missing 404 is shaped problem+json' (($missingProbe.status -eq 404) -and
    ($missingProbe.contentType -like 'application/problem+json*') -and
    ($missingBody.code -eq 'RESOURCE_NOT_FOUND')) "status=$($missingProbe.status) ct=$($missingProbe.contentType) code=$($missingBody.code)"

  # --- 4. restart and re-probe -------------------------------------------------
  $apiProcess.Kill()
  $apiProcess.WaitForExit(15000) | Out-Null
  $apiProcess = Start-StagedApi
  $secondBootLive = Wait-Liveness $apiProcess $apiPort $bearer
  Add-Result 'restart liveness' $secondBootLive "pid=$($apiProcess.Id)"
  $reprobe = Invoke-JsonGet $sessionUrl $bearer
  Add-Result 'todos route after restart' (($reprobe.status -eq 404) -and
    ((($reprobe.body | ConvertFrom-Json).code) -eq 'RESOURCE_NOT_FOUND')) "status=$($reprobe.status)"
  $apiProcess.Kill()
  $apiProcess.WaitForExit(15000) | Out-Null
} catch {
  Add-Result 'script failure' $false $_.Exception.Message
} finally {
  if ($serverStarted) {
    & $pgCtlExe 'stop' '-D' $dataDirectory '-m' 'fast' '-w' '-t' '30'
  }
  Start-Sleep -Milliseconds 300
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$summary = [ordered]@{
  ranAt = (Get-Date).ToUniversalTime().ToString('o')
  stagedApi = $stagedApi
  results = $results
  passed = (@($results.Values | Where-Object { $_.passed }).Count)
  failed = (@($results.Values | Where-Object { -not $_.passed }).Count)
}
$summaryPath = Join-Path $EvidenceRoot 'desktop\staged-api-acceptance.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $summaryPath) | Out-Null
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
Write-Host "summary written: $summaryPath"
if ($summary.failed -gt 0) { exit 1 }
exit 0
