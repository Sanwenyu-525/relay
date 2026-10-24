# Isolated regression: an initialized trial can open the desktop development window without test-release.
# No packaged desktop or model is started; a real temporary PostgreSQL cluster is used.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture = Join-Path $temporary ('relay-dev-no-package-test-' + [guid]::NewGuid().ToString('N'))
$trial = Join-Path $fixture '.relay-test'
$cluster = Join-Path $trial 'cluster'
$statePath = Join-Path $trial 'session.json'
$pgSource = Join-Path $repo '.research\runtime-cache\postgresql-18.6-2\pgsql'
$pgBindir = Join-Path $pgSource 'bin'
$pgLink = Join-Path $fixture '.research\runtime-cache\postgresql-18.6-2\pgsql'
$pgCtl = Join-Path $pgBindir 'pg_ctl.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$eventsPath = Join-Path $fixture 'events.jsonl'
$savedEvents = $env:RELAY_LAUNCHER_TEST_EVENTS
$savedExpectedDataRoot = $env:RELAY_EXPECTED_DATA_ROOT
$launcherPending = $false
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-Text([string]$Path, [string]$Content) { [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false)) }
function Events { @(Get-Content -LiteralPath $eventsPath | ForEach-Object { $_ | ConvertFrom-Json }) }
function Run-Launcher([string]$Action) {
  $logId = [guid]::NewGuid().ToString('N')
  $stdout = Join-Path $fixture "$logId.out"
  $stderr = Join-Path $fixture "$logId.err"
  $process = Start-Process -FilePath $powershell -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $fixture 'run.ps1') + '"'), $Action)
  try {
    $null = $process.Handle
    if (-not $process.WaitForExit(60000)) { $script:launcherPending = $true; throw 'Launcher did not exit within 60 seconds; fixture preserved.' }
    $process.Refresh()
    [pscustomobject]@{ Code = $process.ExitCode; Output = ((Get-Content -LiteralPath $stdout, $stderr -Raw) -join "`n") }
  } finally { $process.Dispose() }
}
function Run-OK([string]$Action) {
  $result = Run-Launcher $Action
  Assert ($result.Code -eq 0) "$Action failed (exit $($result.Code)): $($result.Output)"
  return $result
}
function New-StagedResource([string]$RelativePath) {
  $path = Join-Path $fixture "apps\desktop\src-tauri\resources\$RelativePath"
  New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
  Write-Text $path 'fixture'
}
try {
  foreach ($directory in @('scripts', 'apps\desktop\scripts', 'apps\desktop\src-tauri\resources', '.research\runtime-cache\postgresql-18.6-2')) {
    New-Item -ItemType Directory -Path (Join-Path $fixture $directory) -Force | Out-Null
  }
  New-Item -ItemType Junction -Path $pgLink -Target $pgSource | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'test-desktop.ps1') -Destination (Join-Path $fixture 'scripts\test-desktop.ps1')
  Write-Text (Join-Path $fixture 'run.ps1') @'
param([string]$Action)
$ErrorActionPreference = 'Stop'
function Get-Process { param([string]$Name, $ErrorAction) }
& (Join-Path $PSScriptRoot 'scripts\test-desktop.ps1') -Action $Action
'@
  Write-Text (Join-Path $fixture 'apps\desktop\scripts\stage-api.ps1') @'
param([string]$RepoRoot, [switch]$Force, [switch]$Skip)
$ErrorActionPreference = 'Stop'
if (-not $RepoRoot -or -not (Test-Path -LiteralPath $RepoRoot)) { throw 'stage-api.ps1 did not receive a valid RepoRoot.' }
if ($Skip) { throw 'DesktopDev skipped staging without -SkipApiRefresh.' }
Add-Content -LiteralPath $env:RELAY_LAUNCHER_TEST_EVENTS -Value '{"event":"stage"}'
'@
  Write-Text (Join-Path $fixture 'apps\desktop\scripts\dev-desktop.ps1') @'
param([string]$ConfigPath, [int]$FrontendPort, [switch]$SkipApiRefresh)
$ErrorActionPreference = 'Stop'
try {
  $handle = [IO.File]::Open((Join-Path (Split-Path $ConfigPath) 'launcher.lock'), 'Open', 'ReadWrite', 'None')
  $handle.Dispose()
  throw 'Launcher lock was not held during desktop development.'
} catch [IO.IOException] { }
if ($env:RELAY_DESKTOP_DATA_ROOT -ne $env:RELAY_EXPECTED_DATA_ROOT) {
  throw "Dev window did not inherit the trial data root: $($env:RELAY_DESKTOP_DATA_ROOT)"
}
if (-not (Select-String -LiteralPath $ConfigPath -Pattern '^RELAY_DB_URL=postgresql://relay_app@' -Quiet)) {
  throw 'Dev window was started without the trial database configuration.'
}
Add-Content -LiteralPath $env:RELAY_LAUNCHER_TEST_EVENTS -Value '{"event":"dev"}'
'@
  New-StagedResource 'api\dist\src\main.js'
  foreach ($name in @('migrate', 'install-graph', 'init-workspace')) {
    New-StagedResource "api\dist\src\cli\$name.js"
  }
  # Never executed on this path; existence is the contract checked by the launcher.
  New-StagedResource 'node.exe'
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $state = [pscustomobject]@{
    schema_version = 1; cluster_path = $cluster; port = $port
    workspace_id = [guid]::NewGuid().ToString(); command_id = [guid]::NewGuid().ToString()
    ready = $true; manifest_hash = 'fixture-dev-baseline'; dev_schema_hash = ''
  }
  $env:RELAY_LAUNCHER_TEST_EVENTS = $eventsPath
  $env:RELAY_EXPECTED_DATA_ROOT = Join-Path $trial 'data'

  # A fresh environment still needs one packaged build; this guard must not silently initialize from nothing.
  $missing = Run-Launcher 'DesktopDev'
  Assert ($missing.Code -ne 0 -and $missing.Output.Contains('Missing input:') -and
    $missing.Output.Contains('Run dev-stack.bat Build first.')) 'Uninitialized trial without a package was not rejected.'
  Assert (-not (Test-Path -LiteralPath $eventsPath)) 'Rejected start prepared staging or the window.'

  New-Item -ItemType Directory -Path $trial -Force | Out-Null
  Write-Text $statePath ($state | ConvertTo-Json)
  Write-Text (Join-Path $trial 'desktop.env') "# user setting`nRELAY_MODEL_PROVIDER=fixture-preserved`n"

  $first = Run-OK 'DesktopDev'
  Assert (-not $first.Output.Contains('Missing input')) 'Initialized development window still required a package.'
  Assert (((Events).event -join ',') -eq 'stage,dev') 'Initialized development start did not skip package verification and migration.'
  $after = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  Assert ($after.ready -and $after.manifest_hash -eq 'fixture-dev-baseline') 'Development start rewrote the recorded baseline.'
  $config = Get-Content -LiteralPath (Join-Path $trial 'desktop.env') -Raw
  Assert ($config.Contains("RELAY_DB_URL=postgresql://relay_app@127.0.0.1:$port/relay_trial") -and
    $config.Contains('# user setting')) 'Trial configuration was not rewritten safely.'

  $null = Run-OK 'DesktopDev'
  Assert (((Events).event -join ',') -eq 'stage,dev,stage,dev') 'Daily reuse reran verification or migration.'

  Run-OK 'Stop' | Out-Null
  & $pgCtl status -D $cluster *> $null
  Assert ($LASTEXITCODE -eq 3) 'Stop did not stop the fixture database.'
  Write-Host 'PASS: 4 scenarios; fresh environment still needs Build, initialized environment opens without a package, no verification or migration, daily reuse and Stop.'
} finally {
  $env:RELAY_LAUNCHER_TEST_EVENTS = $savedEvents
  $env:RELAY_EXPECTED_DATA_ROOT = $savedExpectedDataRoot
  Assert ([IO.Path]::GetDirectoryName($fixture) -eq $temporary -and [IO.Path]::GetFileName($fixture).StartsWith('relay-dev-no-package-test-')) 'Unsafe fixture cleanup path.'
  if (Test-Path -LiteralPath (Join-Path $cluster 'PG_VERSION')) {
    & $pgCtl status -D $cluster *> $null
    if ($LASTEXITCODE -eq 0) { & $pgCtl stop -D $cluster -m fast -w -t 30 | Out-Null; Assert ($LASTEXITCODE -eq 0) 'Fixture PostgreSQL failed to stop; files preserved.' }
    else { Assert ($LASTEXITCODE -eq 3) 'Fixture PostgreSQL status uncertain; files preserved.' }
  }
  Assert (-not $launcherPending) "Launcher timed out; fixture preserved at: $fixture"
  if (Test-Path -LiteralPath $pgLink) { [IO.Directory]::Delete($pgLink) }
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
  Write-Host "CLEAN: $fixture"
}
