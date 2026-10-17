# Runs the M02 browser human path against a one-off PostgreSQL 18 and the real API.
# No .env or existing database is read. The generated bearer token stays in process memory.
# The cluster and artifact root live under one validated temporary directory and are removed.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File apps/workbench/scripts/run-real-api-browser.ps1

param([ValidateSet('M02', 'FreeModels')][string]$Scenario = 'M02')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workbenchRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $workbenchRoot)
$apiRoot = Join-Path $repoRoot 'apps\api'
$nodeExe = Join-Path $repoRoot '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$pgBin = Join-Path $repoRoot '.research\runtime-cache\postgresql-18.6-2\pgsql\bin'
$initdbExe = Join-Path $pgBin 'initdb.exe'
$pgCtlExe = Join-Path $pgBin 'pg_ctl.exe'
$psqlExe = Join-Path $pgBin 'psql.exe'
$viteEntry = Join-Path $workbenchRoot 'node_modules\vite\bin\vite.js'
$playwrightEntry = Join-Path $workbenchRoot 'node_modules\@playwright\test\cli.js'
$apiEntry = Join-Path $apiRoot 'dist\src\main.js'
$migrateEntry = Join-Path $apiRoot 'dist\src\cli\migrate.js'
$installGraphEntry = Join-Path $apiRoot 'dist\src\cli\install-graph.js'
$workspaceEntry = Join-Path $apiRoot 'dist\src\cli\init-workspace.js'
$rolesFile = Join-Path $apiRoot 'sql\bootstrap-roles.sql'
$helperManifest = Join-Path $repoRoot 'apps\file-io-helper\Cargo.toml'
$helperExe = Join-Path $repoRoot 'apps\file-io-helper\target\x86_64-pc-windows-msvc\debug\relay-file-io-helper.exe'
$tscEntryApi = Join-Path $apiRoot 'node_modules\typescript\bin\tsc'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("relay-m02-browser-$([guid]::NewGuid().ToString('N').Substring(0, 10))")
$cluster = Join-Path $temporaryRoot 'cluster'
$dataRoot = Join-Path $temporaryRoot 'artifacts'
$serverLog = Join-Path $temporaryRoot 'postgres.log'
$databaseName = "relay_m02_$([guid]::NewGuid().ToString('N').Substring(0, 12))"
$workspaceId = '11111111-1111-4111-8111-111111111111'
$token = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$pgStopCode = $null
$testCode = $null
$apiProcess = $null
$workerProcess = $null
$uiProcess = $null
$failure = $null
$removed = $false

function Free-Port {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  return $port
}

function Wait-Http {
  param([string]$Url, [int]$Seconds = 20)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ([int]$response.StatusCode -eq 200) { return }
    } catch { }
    Start-Sleep -Milliseconds 200
  }
  throw "HTTP endpoint did not become ready: $Url"
}

function Stop-Child {
  param([System.Diagnostics.Process]$Process)
  if ($null -ne $Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force
    [void]$Process.WaitForExit(5000)
  }
  return $null -eq $Process -or $Process.HasExited
}

try {
  foreach ($path in @($nodeExe, $initdbExe, $pgCtlExe, $psqlExe, $viteEntry, $playwrightEntry, $apiEntry, $migrateEntry, $installGraphEntry, $workspaceEntry, $rolesFile)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required tool or build output is missing: $path" }
  }
  New-Item -ItemType Directory -Path $temporaryRoot, $dataRoot -Force | Out-Null

  # Artifact bodies are published to managed storage through the native file I/O helper named by
  # RELAY_FILE_IO_HELPER. Without it every save fails honestly as "content was not fully published
  # to managed storage", so the real write path is never reached and this acceptance proves nothing.
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and
      [string]::IsNullOrWhiteSpace($env:RELAY_FILE_IO_HELPER)) {
    $cargo = (Get-Command cargo -ErrorAction Stop).Source
    & $cargo build --locked --target x86_64-pc-windows-msvc --manifest-path $helperManifest
    if ($LASTEXITCODE -ne 0) { throw "Native file I/O helper build failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath $helperExe -PathType Leaf)) { throw "Native file I/O helper was not produced: $helperExe" }
    $env:RELAY_FILE_IO_HELPER = $helperExe
  }

  # The API dist must match the current source, otherwise this acceptance reports on a stale build.
  Push-Location $apiRoot
  try {
    & $nodeExe $tscEntryApi '-p' 'tsconfig.json'
    if ($LASTEXITCODE -ne 0) { throw "API build failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }

  $pgPort = Free-Port
  $apiPort = Free-Port
  $uiPort = Free-Port
  if (@(@($pgPort, $apiPort, $uiPort) | Select-Object -Unique).Count -ne 3) { throw 'Port allocation collision; rerun the short-lived session' }

  # --locale=C pins the cluster locale: initdb otherwise derives it from the host locale, and a
  # host locale without a matching text search configuration makes initdb print that complaint to
  # stderr. initdb still exits 0, but the script sets $ErrorActionPreference='Stop', so PowerShell
  # 5.1 turns native stderr into a terminating NativeCommandError and the whole run aborts before
  # Playwright starts. Pinning the locale keeps this acceptance deterministic across machines.
  & $initdbExe '-D' $cluster '-U' 'relay_api_admin' '-A' 'trust' '--encoding=UTF8' '--locale=C'
  if ($LASTEXITCODE -ne 0) { throw "initdb exit $LASTEXITCODE" }
  # Never pipe pg_ctl start: the child retains the write handle and PowerShell waits for EOF.
  & $pgCtlExe 'start' '-D' $cluster '-l' $serverLog '-o' "-h 127.0.0.1 -p $pgPort" '-w' '-t' '30'
  if ($LASTEXITCODE -ne 0) { throw "pg_ctl start exit $LASTEXITCODE" }
  $adminUrl = "postgresql://relay_api_admin@127.0.0.1:$pgPort/postgres"
  & $psqlExe $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-f' $rolesFile
  if ($LASTEXITCODE -ne 0) { throw "role bootstrap exit $LASTEXITCODE" }
  & $psqlExe $adminUrl '-w' '-v' 'ON_ERROR_STOP=1' '-c' "create database $databaseName owner relay_migrator"
  if ($LASTEXITCODE -ne 0) { throw "database creation exit $LASTEXITCODE" }

  $env:RELAY_MIGRATION_DB_URL = "postgresql://relay_migrator@127.0.0.1:$pgPort/$databaseName"
  $env:RELAY_DB_URL = "postgresql://relay_app@127.0.0.1:$pgPort/$databaseName"
  & $nodeExe $migrateEntry
  if ($LASTEXITCODE -ne 0) { throw "migration exit $LASTEXITCODE" }
  & $nodeExe $installGraphEntry
  if ($LASTEXITCODE -ne 0) { throw "graph installation exit $LASTEXITCODE" }
  Remove-Item Env:RELAY_MIGRATION_DB_URL
  & $nodeExe $workspaceEntry '--name' 'M02 real browser session' '--workspace-id' $workspaceId
  if ($LASTEXITCODE -ne 0) { throw "workspace initialization exit $LASTEXITCODE" }

  $env:RELAY_API_BIND_HOST = '127.0.0.1'
  $env:RELAY_API_PORT = "$apiPort"
  $env:RELAY_API_ALLOWED_ORIGINS = "http://127.0.0.1:$uiPort"
  $env:RELAY_API_BEARER_TOKEN = $token
  $env:RELAY_DB_POOL_MAX = '4'
  $env:RELAY_DB_CONNECT_TIMEOUT_MS = '2000'
  $env:RELAY_DATA_ROOT = $dataRoot
  $env:RELAY_LOG_LEVEL = 'fatal'
  $env:RELAY_API_STOP_ON_STDIN_EOF = 'false'
  $apiArguments = @($apiEntry)
  if ($Scenario -eq 'FreeModels') {
    $fixturePort = Free-Port
    $fixturePreload = Join-Path $workbenchRoot 'tests\browser\fixtures\free-model-provider-preload.mjs'
    $env:NODE_ENV = 'test'
    $env:RELAY_MODEL_PROVIDER = 'fake'
    $env:RELAY_MODEL_CATALOG_ENABLED = 'true'
    $env:RELAY_MODEL_CATALOG_BASE_URL = 'https://openrouter.ai/api/v1'
    $env:RELAY_MODEL_CATALOG_API_KEY = ''
    $env:RELAY_OPENROUTER_API_KEY = 'synthetic-free-model-browser'
    $env:RELAY_MODEL_MAX_OUTPUT_TOKENS = '1024'
    $env:RELAY_MODEL_MAX_CALL_TOKENS = '16384'
    $env:RELAY_MODEL_MAX_SCOPE_CALLS = '16'
    $env:RELAY_MODEL_MAX_SCOPE_TOKENS = '262144'
    $env:RELAY_FREE_MODEL_FIXTURE_PORT = "$fixturePort"
    $env:RELAY_FREE_MODEL_FIXTURE_CLIENT = 'false'
    $env:RELAY_BROWSER_SCENARIO = 'free-models'
    # Node 24 --import only accepts file/data/node schemes, so the absolute Windows
    # path becomes a file:// URL. This line stays ASCII: Windows PowerShell 5.1 reads
    # a BOM-less script with the ANSI codepage, and a trailing double-byte char there
    # swallows the next newline, merging the assignment below into this comment.
    $fixturePreloadUrl = ([uri]$fixturePreload).AbsoluteUri
    $apiArguments = @('--import', $fixturePreloadUrl, $apiEntry)
  }
  $apiProcess = Start-Process -FilePath $nodeExe -ArgumentList $apiArguments -WorkingDirectory $apiRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $temporaryRoot 'api.out') -RedirectStandardError (Join-Path $temporaryRoot 'api.err')
  Wait-Http -Url "http://127.0.0.1:$apiPort/health/live"
  if ($Scenario -eq 'FreeModels') {
    $env:RELAY_FREE_MODEL_FIXTURE_CLIENT = 'true'
    $workerEntry = Join-Path $apiRoot 'dist\src\worker\main.js'
    $workerProcess = Start-Process -FilePath $nodeExe -ArgumentList @('--import', $fixturePreloadUrl, $workerEntry) -WorkingDirectory $apiRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $temporaryRoot 'worker.out') -RedirectStandardError (Join-Path $temporaryRoot 'worker.err')
  }

  Remove-Item Env:RELAY_API_BEARER_TOKEN
  Write-Host "M02 real browser: file I/O helper in use"
  $uiProcess = Start-Process -FilePath $nodeExe -ArgumentList @($viteEntry, '--host', '127.0.0.1', '--port', "$uiPort", '--strictPort') -WorkingDirectory $workbenchRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $temporaryRoot 'vite.out') -RedirectStandardError (Join-Path $temporaryRoot 'vite.err')
  Wait-Http -Url "http://127.0.0.1:$uiPort/"

  $env:RELAY_M02_API_BASE_URL = "http://127.0.0.1:$apiPort"
  $env:RELAY_M02_UI_BASE_URL = "http://127.0.0.1:$uiPort"
  $env:RELAY_M02_WORKSPACE_ID = $workspaceId
  $env:RELAY_M02_BEARER_TOKEN = $token
  if ($Scenario -eq 'FreeModels') { $env:RELAY_FREE_MODEL_FIXTURE_BASE_URL = "http://127.0.0.1:$fixturePort" }
  Write-Host "M02 real browser: PG18.6 / isolated $databaseName; API and UI on dynamic loopback ports"
  Push-Location $workbenchRoot
  try {
    & $nodeExe $playwrightEntry 'test' '--config' 'playwright.real-api.config.ts'
    $testCode = $LASTEXITCODE
  } finally { Pop-Location }
} catch {
  $failure = $_.Exception.Message
} finally {
  if ($Scenario -eq 'FreeModels' -and ($null -ne $failure -or ($null -ne $testCode -and $testCode -ne 0))) {
    foreach ($name in @('api.err', 'worker.err', 'worker.out')) {
      $diagnosticPath = Join-Path $temporaryRoot $name
      if (Test-Path -LiteralPath $diagnosticPath -PathType Leaf) {
        $diagnostic = (Get-Content -LiteralPath $diagnosticPath -Tail 12) -join "`n"
        Write-Host ($diagnostic.Replace($token, '[redacted]'))
      }
    }
  }
  Remove-Item Env:RELAY_MIGRATION_DB_URL -ErrorAction SilentlyContinue
  Remove-Item Env:RELAY_M02_BEARER_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:RELAY_API_BEARER_TOKEN -ErrorAction SilentlyContinue
  $childrenStopped = $true
  foreach ($child in @($uiProcess, $workerProcess, $apiProcess)) {
    try {
      if (-not (Stop-Child -Process $child)) { $childrenStopped = $false }
    } catch { $childrenStopped = $false }
  }
  $pgStopped = $true
  if (Test-Path -LiteralPath $cluster -PathType Container) {
    & $pgCtlExe 'status' '-D' $cluster
    $statusCode = $LASTEXITCODE
    if ($statusCode -eq 0) {
      & $pgCtlExe 'stop' '-D' $cluster '-m' 'fast' '-w' '-t' '30'
      $pgStopCode = $LASTEXITCODE
      $pgStopped = $pgStopCode -eq 0
    } elseif ($statusCode -eq 3) {
      $pgStopCode = 0
    } else {
      $pgStopCode = $statusCode
      $pgStopped = $false
    }
  }
  $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $safeTarget = [System.IO.Path]::GetFullPath($temporaryRoot)
  if (-not $safeTarget.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $safeTarget) -notmatch '^relay-m02-browser-[0-9a-f]{10}$') { throw "Unsafe cleanup target: $safeTarget" }
  if ($childrenStopped -and $pgStopped) {
    if (Test-Path -LiteralPath $safeTarget) { Remove-Item -LiteralPath $safeTarget -Recurse -Force }
    $removed = -not (Test-Path -LiteralPath $safeTarget)
  } else {
    Write-Host "Temporary session preserved because a process did not stop: $safeTarget"
    if (-not $pgStopped) { Write-Host "Retry stop: $pgCtlExe stop -D $cluster -m fast -w -t 30" }
    if (-not $childrenStopped) {
      foreach ($child in @($uiProcess, $workerProcess, $apiProcess)) {
        if ($null -ne $child -and -not $child.HasExited) { Write-Host "Retry stop: Stop-Process -Id $($child.Id) -Force" }
      }
      Write-Host 'Stop the remaining API/UI process before deleting the temporary directory.'
    }
  }
}

Write-Host "$Scenario real browser summary: playwright=$testCode pg_stop=$pgStopCode temporary_removed=$removed"
if ($null -ne $failure) { Write-Host "M02 real browser failure: $failure" }
if ($testCode -eq 0 -and $pgStopCode -eq 0 -and $removed -and $null -eq $failure) { exit 0 }
exit 1
