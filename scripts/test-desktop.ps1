# Desktop trial entry point. Save as UTF-8 with BOM for Windows PowerShell 5.1.
[CmdletBinding()]
param(
  [ValidateSet('Menu', 'Build', 'Start', 'Stop', 'Status', 'Preview')]
  [string]$Action = 'Menu',
  [switch]$SkipInstall,
  [switch]$FrontendOnly,
  [int]$FrontendPort = 5173,
  [switch]$SkipBuild,
  [ValidateRange(0, 600)][int]$SmokeSeconds = 0,
  [switch]$SkipDesktop
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force -ErrorAction Stop
$root = Split-Path -Parent $PSScriptRoot
if ($Action -eq 'Menu' -and ($FrontendOnly -or $PSBoundParameters.ContainsKey('FrontendPort') -or $SkipBuild -or $SkipInstall -or $SmokeSeconds)) {
  $Action = 'Preview'
}
if ($Action -eq 'Menu') {
  Write-Host "Relay 桌面测试版`n1. 启动测试版`n2. 打包最新测试版`n3. 停止测试环境（保留数据）`n4. 查看状态和目录`n5. 浏览器开发预览`n0. 退出"
  switch (Read-Host '请选择') {
    '1' { $Action = 'Start' }
    '2' { $Action = 'Build' }
    '3' { $Action = 'Stop' }
    '4' { $Action = 'Status' }
    '5' { $Action = 'Preview' }
    '0' { return }
    default { throw 'Unknown selection' }
  }
}
if ($Action -eq 'Preview') {
  & (Join-Path $PSScriptRoot 'dev-stack.ps1') -FrontendOnly:$FrontendOnly -FrontendPort $FrontendPort -SkipInstall:$SkipInstall -SkipBuild:$SkipBuild -SmokeSeconds $SmokeSeconds
  return
}
$package = Join-Path $root 'test-release'
$trial = Join-Path $root '.relay-test'
$cluster = Join-Path $trial 'cluster'
$statePath = Join-Path $trial 'session.json'
$exe = Join-Path $package 'relay-desktop.exe'
$node = Join-Path $package 'node.exe'
$pgBin = Join-Path $root '.research\runtime-cache\postgresql-18.6-2\pgsql\bin'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$psql = Join-Path $pgBin 'psql.exe'
foreach ($directory in @($trial, $package, $cluster)) {
  if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Trial paths must not be links: $directory"
  }
}
New-Item -ItemType Directory -Path $trial -Force | Out-Null
# One launcher at a time; a crash releases the handle without deleting data.
$lock = [IO.File]::Open((Join-Path $trial 'launcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$savedEnvironment = @{}
foreach ($key in @('RELAY_DB_URL', 'RELAY_MIGRATION_DB_URL', 'RELAY_DESKTOP_CONFIG_PATH', 'RELAY_DESKTOP_DATA_ROOT')) {
  $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
function Invoke-Checked {
  param([string]$Program, [string[]]$Arguments)
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Tool failed: $([IO.Path]::GetFileName($Program)) (exit $LASTEXITCODE)" }
}
function Save-State {
  $temporary = $statePath + '.tmp'
  $state | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
}
function Get-TrialProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    $processPath = $_.ExecutablePath
    if ($processPath -and $processPath.StartsWith('\\?\')) { $processPath = $processPath.Substring(4) }
    $processPath -and $processPath.StartsWith($package + '\', [StringComparison]::OrdinalIgnoreCase)
  })
}
function Get-PgStatus {
  if (-not (Test-Path -LiteralPath (Join-Path $cluster 'PG_VERSION'))) { return 3 }
  & $pgCtl status -D $cluster *> $null
  if ($LASTEXITCODE -notin @(0, 3)) { throw 'Could not determine trial PostgreSQL status' }
  return $LASTEXITCODE
}
try {
  if ($Action -eq 'Build') {
    if (@(Get-TrialProcesses).Count) { throw 'Close the desktop window before rebuilding.' }
    & (Join-Path $root 'apps\desktop\scripts\build-release.ps1') -TestPackage -SkipInstall:$SkipInstall
    Write-Host "测试包已生成：$package"
    return
  }
  if ($Action -eq 'Status') {
    Write-Host "Package: $package`nPersistent data: $trial"
    $buildManifest = Join-Path $package 'desktop-build-manifest.json'
    if (Test-Path -LiteralPath $buildManifest) {
      $buildInfo = Get-Content -LiteralPath $buildManifest -Raw | ConvertFrom-Json
      Write-Host "Built at (UTC): $($buildInfo.built_at_utc)"
    }
    Write-Host "Package processes: $(@(Get-TrialProcesses).Count)"
    if (Test-Path -LiteralPath $statePath) { Write-Host "PostgreSQL running: $((Get-PgStatus) -eq 0)" }
    else { Write-Host 'Trial has not been initialized.' }
    return
  }
  if ($Action -eq 'Stop') {
    if (@(Get-TrialProcesses).Count) { throw 'Close the desktop window first, then choose Stop again. No process was forcibly killed.' }
    if (Test-Path -LiteralPath $statePath) {
      if ((Get-PgStatus) -eq 0) { Invoke-Checked $pgCtl @('stop', '-D', $cluster, '-m', 'fast', '-w', '-t', '30') }
    }
    Write-Host "测试环境已停止，数据已保留：$trial"
    return
  }
  if (@(Get-TrialProcesses).Count) { Write-Host 'The trial is already running. Use its existing window.'; return }
  foreach ($file in @($exe, $node, $pgCtl, $psql, (Join-Path $package 'desktop-build-manifest.json'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing input: $file. Run dev-stack.bat Build first." }
  }
  $manifest = Get-Content -LiteralPath (Join-Path $package 'desktop-build-manifest.json') -Raw | ConvertFrom-Json
  if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $manifest.artifact_sha256) { throw 'Executable hash does not match the build manifest; rebuild.' }
  if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ne $manifest.resource_file_sha256.'node.exe') { throw 'Node hash mismatch; rebuild.' }
  Invoke-Checked $node @((Join-Path $PSScriptRoot 'verify-desktop-package.mjs'), $package)
  if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.cluster_path -ne $cluster -or $state.schema_version -ne 1) { throw 'Trial marker does not match this directory.' }
  } else {
    if (Test-Path -LiteralPath $cluster) { throw 'Cluster exists without its marker. Preserve it and inspect before retrying.' }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $state = [pscustomobject]@{ schema_version = 1; cluster_path = $cluster; port = $port; workspace_id = [guid]::NewGuid().ToString(); command_id = [guid]::NewGuid().ToString(); ready = $false; manifest_hash = '' }
    Save-State
  }
  if (-not (Test-Path -LiteralPath (Join-Path $cluster 'PG_VERSION'))) {
    Invoke-Checked (Join-Path $pgBin 'initdb.exe') @('-D', $cluster, '-U', 'relay_api_admin', '-A', 'trust', '--encoding=UTF8', '--locale=C')
  }
  if ((Get-PgStatus) -ne 0) {
    Invoke-Checked $pgCtl @('start', '-D', $cluster, '-l', (Join-Path $trial 'postgres.log'), '-o', "-h 127.0.0.1 -p $($state.port)", '-w', '-t', '30')
  }
  $adminUrl = "postgresql://relay_api_admin@127.0.0.1:$($state.port)/postgres"
  if (-not $state.ready) {
    Invoke-Checked $psql @($adminUrl, '-w', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $root 'apps\api\sql\bootstrap-roles.sql'))
    $exists = Invoke-Checked $psql @($adminUrl, '-w', '-tAc', "SELECT 1 FROM pg_database WHERE datname='relay_trial'")
    if (($exists -join '').Trim() -ne '1') { Invoke-Checked $psql @($adminUrl, '-w', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE relay_trial OWNER relay_migrator') }
  }
  $manifestHash = (Get-FileHash -LiteralPath (Join-Path $package 'desktop-build-manifest.json') -Algorithm SHA256).Hash
  if ($state.manifest_hash -ne $manifestHash) {
    if ($state.ready) {
      $backup = Join-Path $trial ('before-upgrade-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.dump')
      Invoke-Checked (Join-Path $pgBin 'pg_dump.exe') @("postgresql://relay_api_admin@127.0.0.1:$($state.port)/relay_trial", '-w', '-Fc', '-f', $backup)
      Write-Host "Database backup before migration: $backup"
    }
    $env:RELAY_MIGRATION_DB_URL = "postgresql://relay_migrator@127.0.0.1:$($state.port)/relay_trial"
    Invoke-Checked $node @((Join-Path $package 'api\dist\src\cli\migrate.js'))
    Invoke-Checked $node @((Join-Path $package 'api\dist\src\cli\install-graph.js'))
  }
  Remove-Item Env:RELAY_MIGRATION_DB_URL -ErrorAction SilentlyContinue
  $env:RELAY_DB_URL = "postgresql://relay_app@127.0.0.1:$($state.port)/relay_trial"
  if (-not $state.ready) {
    Invoke-Checked $node @((Join-Path $package 'api\dist\src\cli\init-workspace.js'), '--name', 'Relay trial', '--workspace-id', $state.workspace_id, '--command-id', $state.command_id) | Out-Null
  }
  $state.ready = $true
  $state.manifest_hash = $manifestHash
  Save-State
  $config = Join-Path $trial 'desktop.env'
  [IO.File]::WriteAllText($config, "RELAY_DB_URL=$env:RELAY_DB_URL`nRELAY_DB_POOL_MAX=4`nRELAY_DB_CONNECT_TIMEOUT_MS=3000`nRELAY_DESKTOP_WORKSPACE_ID=$($state.workspace_id)`n", [Text.UTF8Encoding]::new($false))
  $env:RELAY_DESKTOP_CONFIG_PATH = $config
  $env:RELAY_DESKTOP_DATA_ROOT = Join-Path $trial 'data'
  New-Item -ItemType Directory -Path $env:RELAY_DESKTOP_DATA_ROOT -Force | Out-Null
  if (-not $SkipDesktop) {
    $desktop = Start-Process -FilePath $exe -PassThru
    Start-Sleep -Seconds 3
    if ($desktop.HasExited) { throw 'Desktop exited during startup. Inspect the trial data logs.' }
  }
  Write-Host "Trial prepared. Workspace: $($state.workspace_id)`nData retained at: $trial"
} catch {
  Write-Host 'Trial data has been preserved. If PostgreSQL started, use dev-stack.bat Stop after closing the desktop.'
  throw
} finally {
  foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
  $lock.Dispose()
}
