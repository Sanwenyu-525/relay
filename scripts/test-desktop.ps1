# Desktop trial entry point. Save as UTF-8 with BOM for Windows PowerShell 5.1.
[CmdletBinding()]
param(
  [ValidateSet('Menu', 'Build', 'Start', 'Stop', 'Status', 'Preview', 'DesktopDev')]
  [string]$Action = 'Menu',
  [switch]$SkipInstall,
  [switch]$FrontendOnly,
  [int]$FrontendPort = 5173,
  [switch]$SkipBuild,
  [ValidateRange(0, 600)][int]$SmokeSeconds = 0,
  [switch]$SkipDesktop,
  # DesktopDev 由 dev-desktop.ps1 的源码/暂存时间判据决定是否刷新 apps/api 暂存资源：
  # 改了 API 源码却跑上一版构建，曾把一次已修好的真实修复藏成一整天。本开关显式跳过该判据，
  # 只在确认 src-tauri\resources\api 已是最新时使用。
  [switch]$SkipApiRefresh,
  # 同上，作用于 computer-runtime / file-io-helper 两个本机 Rust 产物：dev-desktop.ps1 默认按源码
  # 写入时间自动 cargo build --release，本开关显式关掉（确认 target\release 已是最新时使用）。
  [switch]$SkipNativeBuild
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force -ErrorAction Stop
$root = Split-Path -Parent $PSScriptRoot
$interactive = $Action -eq 'Menu'
if ($interactive -and ($FrontendOnly -or $PSBoundParameters.ContainsKey('FrontendPort') -or $SkipBuild -or $SkipInstall -or $SmokeSeconds)) {
  $interactive = $false
  $Action = 'Preview'
}
if ($interactive) {
  # Ctrl+C 只结束当前动作并回到菜单，而不是关掉启动器：屏蔽 PowerShell 自身的终止处理，
  # Ctrl+C 仍会送达 tauri/cargo/Vite 等子进程，由它们各自清理，finally 照常执行。
  # handler 里只能做纯 .NET 赋值：控制事件线程没有 runspace，放 cmdlet 会抛异常并连带终止本进程。
  $null = [Console]::add_CancelKeyPress([ConsoleCancelEventHandler] {
    param($sender, $event)
    $event.Cancel = $true
  })
}
do {
# 交互模式每轮都重新显示菜单：不能用 $Action 判断，它仍是上一次选中的动作。
if ($interactive) {
  Write-Host "Relay 桌面测试版`n1. 启动测试版`n2. 打包最新测试版`n3. 停止测试环境（保留数据）`n4. 查看状态和目录`n5. 浏览器开发预览`n6. 桌面开发窗口（热更新，改了 API 会自动刷新暂存）`n0. 退出"
  switch (Read-Host '请选择') {
    '1' { $Action = 'Start' }
    '2' { $Action = 'Build' }
    '3' { $Action = 'Stop' }
    '4' { $Action = 'Status' }
    '5' { $Action = 'Preview' }
    '6' { $Action = 'DesktopDev' }
    '0' { return }
    default { Write-Host '无效选项，请重新选择。' }
  }
  # switch 里不能用 continue（它只跳出 switch），所以在外面判断是否需要重新提示。
  if ($Action -eq 'Menu') { continue }
}
if ($Action -eq 'Preview') {
  & (Join-Path $PSScriptRoot 'dev-stack.ps1') -FrontendOnly:$FrontendOnly -FrontendPort $FrontendPort -SkipInstall:$SkipInstall -SkipBuild:$SkipBuild -SmokeSeconds $SmokeSeconds
  if ($interactive) { continue }
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
try {
  $lock = [IO.File]::Open((Join-Path $trial 'launcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
} catch [IO.IOException] {
  $busy = '已有测试启动器或桌面开发会话正在运行，请先在其终端按 Ctrl+C 停止，再操作测试环境。'
  if (-not $interactive) { throw $busy }
  Write-Host $busy
  continue
}
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
# 开发窗口执行的是 src-tauri\resources\api 暂存产物，其迁移集可以领先于 test-release 包。
# 只比较包清单 SHA-256 会漏掉「暂存产物新增/改写迁移但包未重打包」这一路，数据库停在旧
# 迁移集、readiness 又要求清单完全相等，于是窗口以 SCHEMA_UNAVAILABLE 启动失败。
# 这里按同一规则（文件名 + 内容 SHA-256）给暂存迁移集算一个摘要，与 session.json 中记录的
# 值比较；变化即与包清单变化同等对待，从暂存产物补迁移。
# 刷新已先于本判据执行（见下方 stage-api.ps1 调用），因此摘要与窗口实际运行的清单一致。
function Get-MigrationSetHash {
  param([string]$Directory)
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $null }
  $lines = @(Get-ChildItem -LiteralPath $Directory -File -Filter '*.sql' | Sort-Object Name | ForEach-Object {
    $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  })
  if (-not $lines.Count) { return $null }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n") + "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '') } finally { $sha.Dispose() }
}
# DesktopDev 时优先取暂存产物作为 migrate/install-graph/init-workspace 的来源；暂存产物缺失时
# 退回测试包（dev-desktop.ps1 在真正开窗前会另行拒绝缺少暂存资源的开发启动）。
$stagedApi = Join-Path $root 'apps\desktop\src-tauri\resources\api'
try {
  if ($Action -eq 'Build') {
    if (@(Get-TrialProcesses).Count) { throw 'Close the desktop window before rebuilding.' }
    & (Join-Path $root 'apps\desktop\scripts\build-release.ps1') -TestPackage -SkipInstall:$SkipInstall
    Write-Host "测试包已生成：$package"
    if ($interactive) { continue }
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
    if ($interactive) { continue }
    return
  }
  if ($Action -eq 'Stop') {
    if (@(Get-TrialProcesses).Count) { throw 'Close the desktop window first, then choose Stop again. No process was forcibly killed.' }
    if (Test-Path -LiteralPath $statePath) {
      if ((Get-PgStatus) -eq 0) { Invoke-Checked $pgCtl @('stop', '-D', $cluster, '-m', 'fast', '-w', '-t', '30') }
    }
    Write-Host "测试环境已停止，数据已保留：$trial"
    if ($interactive) { continue }
    return
  }
  if ($Action -eq 'DesktopDev' -and (Get-Process -Name 'relay-desktop' -ErrorAction SilentlyContinue)) {
    throw '桌面窗口已在运行，请先关闭现有窗口，再启动桌面开发窗口。'
  }
  if (@(Get-TrialProcesses).Count) {
    if ($Action -eq 'DesktopDev') { throw '测试包进程仍在运行，请先关闭测试版，再启动桌面开发窗口。' }
    Write-Host 'The trial is already running. Use its existing window.'
    if ($interactive) { continue }
    return
  }
  foreach ($file in @($exe, $node, $pgCtl, $psql, (Join-Path $package 'desktop-build-manifest.json'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing input: $file. Run dev-stack.bat Build first." }
  }
  if ($Action -eq 'DesktopDev') { Write-Host '正在连接开发数据库…' }
  $manifestHash = (Get-FileHash -LiteralPath (Join-Path $package 'desktop-build-manifest.json') -Algorithm SHA256).Hash
  $state = $null
  if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.cluster_path -ne $cluster -or $state.schema_version -ne 1) { throw 'Trial marker does not match this directory.' }
  }
  # Daily development reuses the initialized database; package launches retain full verification.
  if ($Action -ne 'DesktopDev' -or $null -eq $state -or -not $state.ready -or $state.manifest_hash -ne $manifestHash) {
    Write-Host '正在校验测试包资源…'
    $manifest = Get-Content -LiteralPath (Join-Path $package 'desktop-build-manifest.json') -Raw | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $manifest.artifact_sha256) { throw 'Executable hash does not match the build manifest; rebuild.' }
    if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ne $manifest.resource_file_sha256.'node.exe') { throw 'Node hash mismatch; rebuild.' }
    Invoke-Checked $node @((Join-Path $PSScriptRoot 'verify-desktop-package.mjs'), $package)
  }
  if ($null -eq $state) {
    if (Test-Path -LiteralPath $cluster) { throw 'Cluster exists without its marker. Preserve it and inspect before retrying.' }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $state = [pscustomobject]@{ schema_version = 1; cluster_path = $cluster; port = $port; workspace_id = [guid]::NewGuid().ToString(); command_id = [guid]::NewGuid().ToString(); ready = $false; manifest_hash = ''; dev_schema_hash = '' }
    Save-State
  }
  # 刷新暂存必须发生在补迁移判据之前：dev-desktop.ps1 开窗前会按源码时间重建 resources\api，
  # 若它在迁移决策之后才把迁移集推前，窗口内 API 的 readiness 会以 SCHEMA_UNAVAILABLE 退出
  # （2026-10-20：0125 在补迁移之后才被暂存进来）。这里先刷新，再按刷新后的暂存集算摘要、
  # 补迁移；随后的 dev-desktop.ps1 用 -SkipApiRefresh，不再重复判断。
  if ($Action -eq 'DesktopDev' -and -not $SkipApiRefresh) {
    & (Join-Path $root 'apps\desktop\scripts\stage-api.ps1') -RepoRoot $root
  }
  # 暂存产物可用且本次是 DesktopDev 时，把暂存迁移集摘要纳入补迁移判据。
  $recordedDevSchemaHash = ''
  if ($state.PSObject.Properties.Name -contains 'dev_schema_hash' -and $state.dev_schema_hash) { $recordedDevSchemaHash = $state.dev_schema_hash }
  $stagedApiAvailable = Test-Path -LiteralPath (Join-Path $stagedApi 'dist\src\cli\migrate.js') -PathType Leaf
  $devSchemaHash = $recordedDevSchemaHash
  if ($Action -eq 'DesktopDev' -and $stagedApiAvailable) {
    $computedDevSchemaHash = Get-MigrationSetHash (Join-Path $stagedApi 'migrations')
    if ($computedDevSchemaHash) { $devSchemaHash = $computedDevSchemaHash }
  }
  $cliRoot = if ($Action -eq 'DesktopDev' -and $stagedApiAvailable) { $stagedApi } else { Join-Path $package 'api' }
  $devSchemaChanged = ($Action -eq 'DesktopDev') -and ($devSchemaHash -ne $recordedDevSchemaHash)
  $needsMigration = ($state.manifest_hash -ne $manifestHash) -or $devSchemaChanged
  if (-not (Test-Path -LiteralPath (Join-Path $cluster 'PG_VERSION'))) {
    Write-Host '首次使用：正在初始化开发数据库…'
    Invoke-Checked (Join-Path $pgBin 'initdb.exe') @('-D', $cluster, '-U', 'relay_api_admin', '-A', 'trust', '--encoding=UTF8', '--locale=C')
  }
  if ((Get-PgStatus) -ne 0) {
    Write-Host '正在启动本机数据库…'
    Invoke-Checked $pgCtl @('start', '-D', $cluster, '-l', (Join-Path $trial 'postgres.log'), '-o', "-h 127.0.0.1 -p $($state.port)", '-w', '-t', '30')
  } elseif ($Action -eq 'DesktopDev') {
    Write-Host '数据库已在运行，直接复用。'
  }
  $adminUrl = "postgresql://relay_api_admin@127.0.0.1:$($state.port)/postgres"
  if (-not $state.ready) {
    Invoke-Checked $psql @($adminUrl, '-w', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $root 'apps\api\sql\bootstrap-roles.sql'))
    $exists = Invoke-Checked $psql @($adminUrl, '-w', '-tAc', "SELECT 1 FROM pg_database WHERE datname='relay_trial'")
    if (($exists -join '').Trim() -ne '1') { Invoke-Checked $psql @($adminUrl, '-w', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE relay_trial OWNER relay_migrator') }
  }
  if ($needsMigration) {
    Write-Host '正在初始化或升级数据库结构…'
    if ($state.ready) {
      $backup = Join-Path $trial ('before-upgrade-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.dump')
      Invoke-Checked (Join-Path $pgBin 'pg_dump.exe') @("postgresql://relay_api_admin@127.0.0.1:$($state.port)/relay_trial", '-w', '-Fc', '-f', $backup)
      Write-Host "Database backup before migration: $backup"
    }
    $env:RELAY_MIGRATION_DB_URL = "postgresql://relay_migrator@127.0.0.1:$($state.port)/relay_trial"
    Invoke-Checked $node @((Join-Path $cliRoot 'dist\src\cli\migrate.js'))
    Invoke-Checked $node @((Join-Path $cliRoot 'dist\src\cli\install-graph.js'))
  }
  Remove-Item Env:RELAY_MIGRATION_DB_URL -ErrorAction SilentlyContinue
  $env:RELAY_DB_URL = "postgresql://relay_app@127.0.0.1:$($state.port)/relay_trial"
  if (-not $state.ready) {
    Invoke-Checked $node @((Join-Path $cliRoot 'dist\src\cli\init-workspace.js'), '--name', 'Relay trial', '--workspace-id', $state.workspace_id, '--command-id', $state.command_id) | Out-Null
  }
  $state.ready = $true
  $state.manifest_hash = $manifestHash
  $state.dev_schema_hash = $devSchemaHash
  Save-State
  $config = Join-Path $trial 'desktop.env'
  # 字段 Owner：DB/工作区四个运行时键由本脚本按当前状态重写；其余键（如 RELAY_MODEL_*
  # 用户模型配置）归用户所有，从既有文件原样保留——Start/Stop/重打包不丢用户配置。
  $runtimeOwnedKeys = @('RELAY_DB_URL', 'RELAY_DB_POOL_MAX', 'RELAY_DB_CONNECT_TIMEOUT_MS', 'RELAY_DESKTOP_WORKSPACE_ID')
  $userLines = @()
  if (Test-Path -LiteralPath $config) {
    $userLines = @(Get-Content -LiteralPath $config | Where-Object {
      $line = $_
      if ($line -match '^\s*([A-Za-z0-9_]+)\s*=') { -not ($runtimeOwnedKeys -contains $Matches[1]) }
      elseif ($line -match '^\s*#') { $true }
      else { $false }
    })
  }
  $runtimeLines = @(
    "RELAY_DB_URL=$env:RELAY_DB_URL",
    'RELAY_DB_POOL_MAX=4',
    'RELAY_DB_CONNECT_TIMEOUT_MS=3000',
    "RELAY_DESKTOP_WORKSPACE_ID=$($state.workspace_id)")
  [IO.File]::WriteAllText($config, (($runtimeLines + $userLines) -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
  $env:RELAY_DESKTOP_CONFIG_PATH = $config
  $env:RELAY_DESKTOP_DATA_ROOT = Join-Path $trial 'data'
  New-Item -ItemType Directory -Path $env:RELAY_DESKTOP_DATA_ROOT -Force | Out-Null
  if ($Action -eq 'DesktopDev') {
    Write-Host '正在打开桌面开发窗口（Ctrl+C 停止）…'
    # 暂存刷新已在本脚本补迁移之前完成（或按 -SkipApiRefresh 显式跳过）；
    # dev-desktop.ps1 不再自行判断，避免它在迁移之后又把迁移集推前。
    $devArgs = @{ ConfigPath = $config; FrontendPort = $FrontendPort; SkipApiRefresh = $true }
    if ($SkipNativeBuild) { $devArgs['SkipNativeBuild'] = $true }
    & (Join-Path $root 'apps\desktop\scripts\dev-desktop.ps1') @devArgs
  } elseif (-not $SkipDesktop) {
    $desktop = Start-Process -FilePath $exe -PassThru
    Start-Sleep -Seconds 3
    if ($desktop.HasExited) { throw 'Desktop exited during startup. Inspect the trial data logs.' }
  }
  Write-Host "Trial prepared. Workspace: $($state.workspace_id)`nData retained at: $trial"
} catch {
  Write-Host 'Trial data has been preserved. If PostgreSQL started, use dev-stack.bat Stop after closing the desktop.'
  if (-not $interactive) { throw }
  Write-Host "操作失败：$($_.Exception.Message)"
  Write-Host '已返回菜单。'
} finally {
  foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
  $lock.Dispose()
}
} while ($interactive)
