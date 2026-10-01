# Isolated launcher regression. Run with Windows PowerShell 5.1; no desktop/model is started.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture = Join-Path $temporary ('relay-launcher-test-' + [guid]::NewGuid().ToString('N'))
$package = Join-Path $fixture 'test-release'
$trial = Join-Path $fixture '.relay-test'
$cluster = Join-Path $trial 'cluster'
$pgSource = Join-Path $repo '.research\runtime-cache\postgresql-18.6-2\pgsql'
$pgLink = Join-Path $fixture '.research\runtime-cache\postgresql-18.6-2\pgsql'
$pgCtl = Join-Path $pgSource 'bin\pg_ctl.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$eventsPath = Join-Path $fixture 'events.jsonl'
$markerPath = Join-Path $trial 'session.json'
$manifestPath = Join-Path $package 'desktop-build-manifest.json'
$savedEvents = $env:RELAY_LAUNCHER_TEST_EVENTS
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
    $null = $process.Handle # Keep the handle so Windows PowerShell 5.1 retains ExitCode.
    if (-not $process.WaitForExit(60000)) { $script:launcherPending = $true; throw 'Launcher did not exit within 60 seconds; fixture preserved.' }
    $process.Refresh()
    [pscustomobject]@{ Code = $process.ExitCode; Output = ((Get-Content -LiteralPath $stdout, $stderr -Raw) -join "`n") }
  } finally { $process.Dispose() }
}
function Run-OK([string]$Action) {
  $result = Run-Launcher $Action
  Assert ($result.Code -eq 0) "$Action failed (exit $($result.Code)): $($result.Output)"
}
try {
  foreach ($directory in @('scripts', 'test-release\api\dist\src\cli', 'apps\api\sql',
      'apps\desktop\scripts', '.research\runtime-cache\postgresql-18.6-2')) {
    New-Item -ItemType Directory -Path (Join-Path $fixture $directory) -Force | Out-Null
  }
  New-Item -ItemType Junction -Path $pgLink -Target $pgSource | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'test-desktop.ps1') -Destination (Join-Path $fixture 'scripts\test-desktop.ps1')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'verify-desktop-package.mjs') -Destination (Join-Path $fixture 'scripts\verify-real.mjs')
  Copy-Item -LiteralPath (Join-Path $repo 'apps\api\sql\bootstrap-roles.sql') -Destination (Join-Path $fixture 'apps\api\sql\bootstrap-roles.sql')
  Copy-Item -LiteralPath (Join-Path $repo '.research\runtime-cache\node-v24.21.0-win-x64\node.exe') -Destination (Join-Path $package 'node.exe')
  Write-Text (Join-Path $fixture 'run.ps1') @'
param([string]$Action)
$ErrorActionPreference = 'Stop'
# Only this child fixture ignores the user's unrelated running desktop process.
function Get-Process { param([string]$Name, $ErrorAction) }
& (Join-Path $PSScriptRoot 'scripts\test-desktop.ps1') -Action $Action -SkipDesktop
'@
  Write-Text (Join-Path $fixture 'scripts\verify-desktop-package.mjs') @'
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.RELAY_LAUNCHER_TEST_EVENTS, '{"event":"verify"}\n');
await import('./verify-real.mjs');
'@
  $cliStub = @'
const fs = require('node:fs'), path = require('node:path');
const trial = path.join(path.dirname(process.env.RELAY_LAUNCHER_TEST_EVENTS), '.relay-test');
fs.appendFileSync(process.env.RELAY_LAUNCHER_TEST_EVENTS, JSON.stringify({
  event: path.basename(__filename, '.js'),
  backups: fs.readdirSync(trial).filter(name => /^before-upgrade-.*\.dump$/.test(name))
    .map(name => fs.statSync(path.join(trial, name)).size),
}) + '\n');
'@
  foreach ($name in @('migrate', 'install-graph', 'init-workspace')) {
    Write-Text (Join-Path $package "api\dist\src\cli\$name.js") $cliStub
  }
  Write-Text (Join-Path $fixture 'apps\desktop\scripts\dev-desktop.ps1') @'
param([string]$ConfigPath, [int]$FrontendPort)
$ErrorActionPreference = 'Stop'
try {
  $handle = [IO.File]::Open((Join-Path (Split-Path $ConfigPath) 'launcher.lock'), 'Open', 'ReadWrite', 'None')
  $handle.Dispose()
  throw 'Launcher lock was not held during desktop development.'
} catch [IO.IOException] { }
Add-Content -LiteralPath $env:RELAY_LAUNCHER_TEST_EVENTS -Value '{"event":"dev"}'
'@
  Write-Text (Join-Path $package 'relay-desktop.exe') 'fixture desktop'
  Write-Text (Join-Path $package 'relay-file-io-helper.exe') 'fixture helper'
  $resources = @{}
  Get-ChildItem -LiteralPath $package -Recurse -File | Where-Object { $_.Name -ne 'relay-desktop.exe' } | ForEach-Object {
    $resources[$_.FullName.Substring($package.Length + 1).Replace('\', '/')] = (Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()
  }
  $manifest = @{ schema_version = 1; artifact_sha256 = (Get-FileHash -LiteralPath (Join-Path $package 'relay-desktop.exe')).Hash.ToLowerInvariant(); resource_file_sha256 = $resources }
  Write-Text $manifestPath ($manifest | ConvertTo-Json -Depth 5)
  $originalManifest = Get-Content -LiteralPath $manifestPath -Raw
  $env:RELAY_LAUNCHER_TEST_EVENTS = $eventsPath
  Run-OK 'DesktopDev'
  $first = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  Assert ($first.ready -and $first.cluster_path -eq $cluster -and $first.schema_version -eq 1) 'Initialization marker is not ready.'
  Assert (((Events).event -join ',') -eq 'verify,migrate,install-graph,init-workspace,dev') 'First startup did not perform the required preparation.'
  $probe = 'launcher-' + [guid]::NewGuid().ToString('N')
  $dbUrl = "postgresql://relay_api_admin@127.0.0.1:$($first.port)/relay_trial"
  & (Join-Path $pgSource 'bin\psql.exe') $dbUrl -w -v ON_ERROR_STOP=1 -c "CREATE TABLE launcher_probe (value text); INSERT INTO launcher_probe VALUES ('$probe')" | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'Could not write the database persistence probe.'
  Add-Content -LiteralPath (Join-Path $trial 'desktop.env') -Value "# user setting`nRELAY_MODEL_PROVIDER=fixture-preserved"
  Run-OK 'DesktopDev'
  Assert (((Events).event -join ',') -eq 'verify,migrate,install-graph,init-workspace,dev,dev') 'Daily reuse ran verification or migration.'
  # A matching ready marker must avoid parsing/hashing package resources on the fast path.
  Write-Text $manifestPath 'invalid JSON is deliberately cached by this fixture'
  $first.manifest_hash = (Get-FileHash -LiteralPath $manifestPath).Hash
  Write-Text $markerPath ($first | ConvertTo-Json)
  Write-Text (Join-Path $package 'relay-desktop.exe') 'changed fixture desktop'
  Write-Text (Join-Path $package 'relay-file-io-helper.exe') 'changed fixture helper'
  Run-OK 'DesktopDev'
  Write-Text $manifestPath $originalManifest
  $first.manifest_hash = (Get-FileHash -LiteralPath $manifestPath).Hash
  Write-Text $markerPath ($first | ConvertTo-Json)
  Write-Text (Join-Path $package 'relay-desktop.exe') 'fixture desktop'
  Write-Text (Join-Path $package 'relay-file-io-helper.exe') 'fixture helper'
  Run-OK 'Stop'
  & $pgCtl status -D $cluster *> $null
  Assert ($LASTEXITCODE -eq 3) 'Stop did not stop the fixture database.'
  Run-OK 'DesktopDev'
  $after = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  Assert ($after.port -eq $first.port -and $after.workspace_id -eq $first.workspace_id -and $after.command_id -eq $first.command_id) 'Restart changed the persistent session identity.'
  $value = & (Join-Path $pgSource 'bin\psql.exe') $dbUrl -w -tAc 'SELECT value FROM launcher_probe'
  Assert ($LASTEXITCODE -eq 0 -and ($value -join '').Trim() -eq $probe) 'Restart did not reuse the same database.'
  Assert (@((Events) | Where-Object { $_.event -eq 'verify' }).Count -eq 1) 'Restart reran package verification.'
  $manifest['fixture_revision'] = 2
  Write-Text $manifestPath ($manifest | ConvertTo-Json -Depth 5)
  Run-OK 'DesktopDev'
  $upgrades = @((Events) | Where-Object { $_.event -in @('migrate', 'install-graph') })
  Assert ($upgrades.Count -eq 4 -and $upgrades[2].event -eq 'migrate' -and $upgrades[3].event -eq 'install-graph') 'Package change did not rerun migration and graph installation.'
  Assert ($upgrades[2].backups.Count -eq 1 -and $upgrades[2].backups[0] -gt 0 -and $upgrades[3].backups.Count -eq 1) 'A nonempty backup was not present before migration and graph installation.'
  $config = Get-Content -LiteralPath (Join-Path $trial 'desktop.env') -Raw
  Assert ($config.Contains('# user setting') -and $config.Contains('RELAY_MODEL_PROVIDER=fixture-preserved')) 'User configuration was lost.'
  $handle = [IO.File]::Open((Join-Path $trial 'launcher.lock'), 'Open', 'ReadWrite', 'None')
  try { Assert ((Run-Launcher 'DesktopDev').Code -ne 0) 'Concurrent launcher was not rejected.' } finally { $handle.Dispose() }
  Write-Text (Join-Path $package 'relay-file-io-helper.exe') 'corrupt helper'
  $rejected = Run-Launcher 'Start'
  Assert ($rejected.Code -ne 0 -and $rejected.Output.Contains('Package hash mismatch: relay-file-io-helper.exe')) 'Start accepted a corrupt package resource.'
  Assert (@((Events) | Where-Object { $_.event -eq 'verify' }).Count -eq 3) 'Start skipped full package verification.'
  Write-Host 'PASS: first initialization, cached fast path, same database restart, backup before upgrade, configuration retention, launcher lock, and Start resource rejection.'
} finally {
  $env:RELAY_LAUNCHER_TEST_EVENTS = $savedEvents
  Assert ([IO.Path]::GetDirectoryName($fixture) -eq $temporary -and [IO.Path]::GetFileName($fixture).StartsWith('relay-launcher-test-')) 'Unsafe cleanup path.'
  if (Test-Path -LiteralPath (Join-Path $cluster 'PG_VERSION')) {
    & $pgCtl status -D $cluster *> $null
    if ($LASTEXITCODE -eq 0) { & $pgCtl stop -D $cluster -m fast -w -t 30 | Out-Null; Assert ($LASTEXITCODE -eq 0) 'Fixture PostgreSQL failed to stop; files preserved.' }
    else { Assert ($LASTEXITCODE -eq 3) 'Fixture PostgreSQL status uncertain; files preserved.' }
  }
  Assert (-not $launcherPending) "Launcher timed out; fixture preserved at: $fixture"
  # Remove the junction itself before recursively deleting this checked temporary root.
  if (Test-Path -LiteralPath $pgLink) { [IO.Directory]::Delete($pgLink) }
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
  Write-Host "CLEAN: $fixture"
}
