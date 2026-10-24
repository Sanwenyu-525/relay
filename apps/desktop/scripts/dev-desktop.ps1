# Tauri 开发模式桌面窗口：真实窗口 + Vite 前端热更新，不生成安装包。
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\scripts\dev-desktop.ps1
#     前台运行（Ctrl+C 停止）。
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\scripts\dev-desktop.ps1 -Action start
#     后台启动：立即返回，runner 进程与日志记录在 .relay-dev\dev-desktop\。
#   ... -Action status   查看后台实例状态（runner / 窗口 / Vite / 日志路径）。
#   ... -Action stop     停止后台实例：结束 runner 进程树并兜底清理 dev 版窗口与 Vite 残留。
#   ... -Action restart  先关闭旧的 dev 窗口（后台或前台实例），再以前台方式重新启动。
#                        仓库根的 dev-desktop.bat 双击即执行这一动作。
# 可选参数：
#   -ConfigPath <绝对路径>   桌面 desktop.env（默认优先 .relay-test\desktop.env，其次 %APPDATA%\dev.relay.agent\desktop.env）
#   -FrontendPort 5173       Vite 端口（需与 src-tauri DEV_ORIGIN/tauri.conf devUrl 一致，改动需同步 Rust 常量）
#   -RefreshApi              强制重新构建 apps/api 并刷新 src-tauri 暂存资源
#                            缺省时会对比源码与暂存产物的写入时间：源码更新则自动重建，
#                            因此菜单 6 也不会再悄悄跑旧的暂存 API。
#   -SkipApiRefresh         关闭上面的自动检测（只想开窗口、不重建时用）
#   -SkipNativeBuild        关闭 computer-runtime / file-io-helper 的自动检测与重建
#                           缺省时按源码写入时间判断：源码更新或产物缺失就自动 cargo build --release
#   -SkipFrontendCheck       已自行启动 Vite 时跳过启动检查
# 限制：与打包版共用单实例互斥；运行打包版时请先关闭，反之亦然。
# Rust 源码变更由 tauri dev 自动重编译并重启应用；前端由 Vite HMR 热更新。
param(
  [ValidateSet('', 'start', 'stop', 'status', 'restart')]
  [string]$Action = '',
  [string]$ConfigPath,
  [int]$FrontendPort = 5173,
  [switch]$RefreshApi,
  [switch]$SkipApiRefresh,
  [switch]$SkipNativeBuild,
  [switch]$SkipFrontendCheck,
  [switch]$RunForeground  # 内部参数：-Action start 以隐藏窗口后台拉起本脚本时使用
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$desktopRoot = Join-Path $repoRoot 'apps\desktop'
$tauriRoot = Join-Path $desktopRoot 'src-tauri'
$resourceRoot = Join-Path $tauriRoot 'resources'
$workbenchRoot = Join-Path $repoRoot 'apps\workbench'
$node = Join-Path $repoRoot '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$corepack = Join-Path (Split-Path -Parent $node) 'node_modules\corepack\dist\corepack.js'

$stateDir = Join-Path $repoRoot '.relay-dev\dev-desktop'
$pidFile = Join-Path $stateDir 'runner.pid'
$logOut = Join-Path $stateDir 'runner.out.log'
$logErr = Join-Path $stateDir 'runner.err.log'

function Assert-DesktopAvailable {
  $existing = @(Get-Process -Name 'relay-desktop' -ErrorAction SilentlyContinue)
  if ($existing.Count) {
    throw ('Relay 桌面进程已存在（PID ' + (($existing | Select-Object -ExpandProperty Id) -join ', ') + '）。请关闭现有窗口；若正在备份或恢复，请等待维护会话结束。未启动第二个实例。')
  }
  $guard = $null
  try {
    if ([Threading.Mutex]::TryOpenExisting('Local\RelayAgentDesktopSingleInstance', [ref]$guard)) {
      throw 'Relay 单实例锁正被已有窗口或维护会话占用。请关闭现有窗口或等待维护结束；未启动第二个实例。'
    }
  } finally {
    if ($guard) { $guard.Dispose() }
  }
}

function Stop-DevDesktop {
  param([switch]$IncludeWindow)
  if (Test-Path $pidFile) {
    $runnerPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    $runnerProc = if ($runnerPid) { Get-Process -Id $runnerPid -ErrorAction SilentlyContinue } else { $null }
    if ($runnerProc) {
      cmd.exe /d /c "taskkill /PID $runnerPid /T /F >nul 2>&1"
      Write-Host "已结束 runner 进程树（PID $runnerPid）。"
    } else {
      Write-Host 'runner 进程已不在（可能异常退出），仅清理残留。'
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    # 兜底清理只针对 dev 构建、且启动时间晚于 runner 的残留，不触碰打包版或用户自行启动的服务。
    $cleanupAfter = if ($runnerProc) { $runnerProc.StartTime } else { $null }
    if ($cleanupAfter) {
      Get-Process relay-desktop -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($tauriRoot, [System.StringComparison]::OrdinalIgnoreCase) -and $_.StartTime -gt $cleanupAfter } |
        Stop-Process -Force -ErrorAction SilentlyContinue
      $viteOwners = Get-NetTCPConnection -State Listen -LocalPort $FrontendPort -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
      foreach ($ownerPid in $viteOwners) {
        $owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
        if ($owner -and $owner.StartTime -gt $cleanupAfter) {
          Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
        }
      }
    }
  } elseif (-not $IncludeWindow) {
    Write-Host '没有后台运行记录（.relay-dev\dev-desktop\runner.pid 不存在）；前台运行的实例请在其终端 Ctrl+C 停止。'
  }
  if ($IncludeWindow) {
    # 重启要覆盖前台实例；只认 dev 构建路径，打包版与测试包窗口不在这里处理。
    $windows = @(Get-Process relay-desktop -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($tauriRoot, [System.StringComparison]::OrdinalIgnoreCase) })
    foreach ($window in $windows) {
      Write-Host "正在关闭旧的开发窗口（PID $($window.Id)）…"
      if (-not $window.CloseMainWindow() -or -not $window.WaitForExit(5000)) {
        Stop-Process -Id $window.Id -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

# 后台管理模式：PID 记录 + 日志集中在 .relay-dev\dev-desktop\；前台流程保持原样。
if ($Action -eq 'restart') {
  Stop-DevDesktop -IncludeWindow
  # 等窗口和单实例锁真正退出，避免紧接着的前台启动被旧实例挡住。
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 300
    $guard = $null
    $busy = $false
    try {
      if ([Threading.Mutex]::TryOpenExisting('Local\RelayAgentDesktopSingleInstance', [ref]$guard)) { $busy = $true }
    } catch {
      $busy = $false
    } finally {
      if ($guard) { $guard.Dispose() }
    }
  } while ($busy -and (Get-Date) -lt $deadline)
  if ($busy) { throw '旧桌面窗口未在 15 秒内退出，未启动第二个实例。请手动关闭后重试。' }
  Write-Host '旧开发窗口已清理，正在重新启动…'
}

if ($Action -eq 'start') {
  if (Test-Path $pidFile) {
    $old = Get-Content $pidFile -ErrorAction SilentlyContinue
    $oldProc = if ($old) { Get-Process -Id $old -ErrorAction SilentlyContinue } else { $null }
    if ($oldProc -and $oldProc.ProcessName -eq 'powershell') {
      Write-Host "dev 桌面已在后台运行（runner PID $old）。"
      Write-Host "日志：$logOut"
      Write-Host "查看状态：-Action status；停止：-Action stop"
      return
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
  Assert-DesktopAvailable
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  $runnerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
    '-RunForeground', '-FrontendPort', "$FrontendPort")
  if ($ConfigPath) { $runnerArgs += @('-ConfigPath', $ConfigPath) }
  if ($RefreshApi) { $runnerArgs += '-RefreshApi' }
  if ($SkipApiRefresh) { $runnerArgs += '-SkipApiRefresh' }
  if ($SkipNativeBuild) { $runnerArgs += '-SkipNativeBuild' }
  if ($SkipFrontendCheck) { $runnerArgs += '-SkipFrontendCheck' }
  $runner = Start-Process -FilePath 'powershell' -ArgumentList $runnerArgs -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $logOut -RedirectStandardError $logErr
  Set-Content -Path $pidFile -Value $runner.Id
  Write-Host "dev 桌面后台启动中（runner PID $($runner.Id)），窗口约 20-60 秒后出现（首次/改动大时更久）。"
  Write-Host "日志：$logOut / $logErr"
  Write-Host "查看状态：-Action status；停止：-Action stop"
  return
}

if ($Action -eq 'stop') {
  Stop-DevDesktop
  if (Test-Path $pidFile) { return }
  Write-Host 'dev 桌面已停止。'
  return
}

if ($Action -eq 'status') {
  $running = $false
  if (Test-Path $pidFile) {
    $runnerPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($runnerPid -and (Get-Process -Id $runnerPid -ErrorAction SilentlyContinue)) {
      $running = $true
      Write-Host "后台 runner：运行中（PID $runnerPid）"
    } else {
      Write-Host '后台 runner：已退出（PID 记录过期）'
    }
  } else {
    Write-Host '后台 runner：无记录'
  }
  $win = Get-Process relay-desktop -ErrorAction SilentlyContinue
  if ($win) {
    Write-Host ("桌面窗口：运行中（PID " + (($win | Select-Object -ExpandProperty Id) -join ', ') + "）")
  } else {
    Write-Host '桌面窗口：未运行'
  }
  $up = Get-NetTCPConnection -State Listen -LocalPort $FrontendPort -ErrorAction SilentlyContinue
  if ($up) { Write-Host "Vite（127.0.0.1:$FrontendPort）：监听中" } else { Write-Host "Vite（127.0.0.1:$FrontendPort）：未监听" }
  if ($running) { Write-Host "日志：$logOut" }
  elseif (-not $win -and $up) { Write-Host '提示：端口有监听但无运行记录，可能是前台实例或其它进程占用。' }
  return
}

function Invoke-Pnpm {
  param([string]$Directory, [string[]]$Arguments)
  Push-Location $Directory
  try {
    & $node $corepack 'pnpm@9.15.9' @Arguments
    # 用户按 Ctrl+C 时控制台向整个进程组广播 CTRL_C_EVENT，tauri/cargo 以 STATUS_CONTROL_C_EXIT 结束。
    # 这是预期内的停止方式（finally 仍会收尾），不能当成工具失败抛错。
    if ($LASTEXITCODE -eq -1073741510) { return }
    if ($LASTEXITCODE -eq 23 -and ($Arguments -join ' ') -eq 'exec tauri dev') {
      throw 'Relay 单实例锁检查未通过（退出码 23）。请查看上方宿主原因；若提示已有实例，请关闭已有窗口或等待维护会话结束后重试；现有数据已保留。'
    }
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') exited $LASTEXITCODE" }
  } finally { Pop-Location }
}

Assert-DesktopAvailable

foreach ($path in @($node, $corepack, (Join-Path $tauriRoot 'tauri.conf.json'))) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing input: $path" }
}

# 1) 暂存开发资源：dev 模式 Resource 目录解析到 src-tauri 根。
#    复用 build-release.ps1 已暂存的 resources\（由 dev-stack.bat Build 维护）；缺失时要求先构建一次。
if (-not (Test-Path (Join-Path $resourceRoot 'api\dist\src\main.js')) -or
    -not (Test-Path (Join-Path $resourceRoot 'node.exe'))) {
  throw 'src-tauri\resources 缺少打包资源；请先运行 dev-stack.bat Build 生成一次基础资源。'
}
# 刷新判据已抽到 stage-api.ps1：test-desktop.ps1 必须在补迁移之前用同一份实现刷新暂存，
# 否则「先迁移、后刷新」会让窗口内的迁移清单超前于数据库（SCHEMA_UNAVAILABLE）。
# -RefreshApi 强制刷新；-SkipApiRefresh 跳过；都不给时按源码/暂存写入时间自动判断。
& (Join-Path $PSScriptRoot 'stage-api.ps1') -RepoRoot $repoRoot -Force:$RefreshApi -Skip:$SkipApiRefresh

# tauri-build 在编译期就校验 bundle.resources 的每一条路径，缺任何一条 `tauri dev` 都编不过
# （报错是 build script 的 `resource path ... doesn't exist`，看不出缺的是打包资源）。
# computer-runtime / file-io-helper 是独立 crate 的 release 产物，`tauri dev` 不会重编译它们：
# 以前缺 exe 只报一句「先跑 cargo build」，源码改了却跑上一版 exe 则完全没有提示。
# 现在由 ensure-native-tools.ps1 按源码写入时间判断，落后或缺失就地 cargo build --release，
# 并把 resources 里的副本同步到新产物（resources 里那两个 exe 只由它维护）。
& (Join-Path $PSScriptRoot 'ensure-native-tools.ps1') -RepoRoot $repoRoot -Skip:$SkipNativeBuild
$extensionRoot = Join-Path $repoRoot 'apps\browser-extension'
$extensionStage = Join-Path $resourceRoot 'browser-extension'
New-Item -ItemType Directory -Path $extensionStage -Force | Out-Null
foreach ($file in @('manifest.json', 'background.js', 'options.html', 'options.js')) {
  $source = Join-Path $extensionRoot $file
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "浏览器扩展源文件缺失：$source" }
  Copy-Item -LiteralPath $source -Destination $extensionStage -Force
}
foreach ($name in @('node.exe', 'relay-file-io-helper.exe')) {
  $target = Join-Path $tauriRoot $name
  $source = Join-Path $resourceRoot $name
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "缺少打包资源：$source；请先运行 dev-stack.bat Build 生成一次基础资源。" }
  # dev 模式的 Resource 目录解析到 src-tauri 根，窗口实际用的是这里的副本。
  # 只在目标缺失时拷，会把 ensure-native-tools 刚重建的 exe 挡在门外（旧副本一直留着），
  # 因此按写入时间判断：源比目标新就覆盖。Copy-Item 保留源时间戳，重复启动不会再拷一次。
  $needsCopy = $true
  if (Test-Path -LiteralPath $target -PathType Leaf) {
    $needsCopy = (Get-Item -LiteralPath $source).LastWriteTimeUtc -gt (Get-Item -LiteralPath $target).LastWriteTimeUtc
  }
  if ($needsCopy) { Copy-Item -LiteralPath $source -Destination $target -Force }
}
$apiStage = Join-Path $tauriRoot 'api'
if (-not (Test-Path $apiStage)) {
  New-Item -ItemType Junction -Path $apiStage -Target (Join-Path $resourceRoot 'api') | Out-Null
}
$stagedMain = Join-Path $apiStage 'dist\src\main.js'
if (-not (Test-Path -LiteralPath $stagedMain -PathType Leaf)) { throw "暂存资源不完整：$stagedMain" }

# 2) 桌面配置：优先用户指定，其次标准测试库配置，最后打包版配置。
if (-not $ConfigPath) {
  $candidate = Join-Path $repoRoot '.relay-test\desktop.env'
  $fallback = Join-Path $env:APPDATA 'dev.relay.agent\desktop.env'
  $ConfigPath = if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate } elseif (Test-Path -LiteralPath $fallback -PathType Leaf) { $fallback } else { '' }
  if (-not $ConfigPath) { throw "未找到 desktop.env：请先运行 dev-stack.bat Start 准备测试环境，或用 -ConfigPath 指定配置文件。" }
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "desktop.env 不存在：$ConfigPath" }
$env:RELAY_DESKTOP_CONFIG_PATH = (Resolve-Path -LiteralPath $ConfigPath).Path
Write-Host "dev 桌面使用配置：$env:RELAY_DESKTOP_CONFIG_PATH"
# 与 test-desktop.ps1 的 DesktopDev 对齐：使用测试库配置时默认沿用同一份数据目录，
# 否则直接运行本脚本会落到 %APPDATA%，看不到试用环境里的产物。
$trialConfig = Join-Path $repoRoot '.relay-test\desktop.env'
if (-not $env:RELAY_DESKTOP_DATA_ROOT -and
    [IO.Path]::GetFullPath($ConfigPath) -eq [IO.Path]::GetFullPath($trialConfig)) {
  $env:RELAY_DESKTOP_DATA_ROOT = Join-Path $repoRoot '.relay-test\data'
  Write-Host "dev 桌面数据目录：$env:RELAY_DESKTOP_DATA_ROOT"
}

# 与菜单 DesktopDev 对齐：试用库未运行时自动启动，否则窗口 setup 钩子才报
# PostgreSQL is unavailable 并 panic（exit 101），用户看到的是「启动不了」。
# 同一分支内再按暂存迁移集补库（先 stage-api 刷新暂存、后迁移，与菜单路径同序），
# 否则并行任务新增迁移后窗口报 PostgreSQL schema is incompatible。哈希算法与
# test-desktop.ps1 的 Get-MigrationSetHash 逐字一致，两处需同步维护。
if ([IO.Path]::GetFullPath($ConfigPath) -eq [IO.Path]::GetFullPath($trialConfig)) {
  $trialStatePath = Join-Path $repoRoot '.relay-test\session.json'
  if (-not (Test-Path -LiteralPath $trialStatePath -PathType Leaf)) {
    throw '试用测试环境尚未初始化（.relay-test\session.json 不存在）；请先运行 dev-stack.bat Start 准备测试环境。'
  }
  $trialState = Get-Content -LiteralPath $trialStatePath -Raw | ConvertFrom-Json
  if (-not $trialState.PSObject.Properties['port']) { throw 'session.json 缺少 port 字段，无法启动试用数据库；请重新运行 dev-stack.bat Start。' }
  $trialCluster = Join-Path $repoRoot '.relay-test\cluster'
  $trialPgCtl = Join-Path $repoRoot '.research\runtime-cache\postgresql-18.6-2\pgsql\bin\pg_ctl.exe'
  $dbBusy = @(Get-NetTCPConnection -State Listen -LocalPort $trialState.port -ErrorAction SilentlyContinue)
  if (-not $dbBusy.Count) {
    if (-not (Test-Path -LiteralPath (Join-Path $trialCluster 'PG_VERSION') -PathType Leaf)) {
      throw "试用数据库目录缺失（$trialCluster）；请先运行 dev-stack.bat Start 初始化测试环境。"
    }
    if (-not (Test-Path -LiteralPath $trialPgCtl -PathType Leaf)) {
      throw "未找到便携 PostgreSQL（$trialPgCtl）；请按部署文档准备 .research\runtime-cache 运行时缓存。"
    }
    Write-Host "试用数据库未运行，正在启动（127.0.0.1:$($trialState.port)）…"
    & $trialPgCtl start -D $trialCluster -l (Join-Path $repoRoot '.relay-test\postgres.log') -o "-h 127.0.0.1 -p $($trialState.port)" -w -t 30
    if ($LASTEXITCODE -ne 0) { throw "试用数据库启动失败（exit $LASTEXITCODE）；日志见 .relay-test\postgres.log" }
  }
  $trialMigrations = Join-Path $resourceRoot 'api\migrations'
  $migrationLines = @(Get-ChildItem -LiteralPath $trialMigrations -File -Filter '*.sql' | Sort-Object Name | ForEach-Object {
    $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  })
  if ($migrationLines.Count) {
    $hashBytes = [Text.Encoding]::UTF8.GetBytes(($migrationLines -join "`n") + "`n")
    $hashSha = [Security.Cryptography.SHA256]::Create()
    try { $devSchemaHash = ([BitConverter]::ToString($hashSha.ComputeHash($hashBytes))).Replace('-', '') } finally { $hashSha.Dispose() }
    $recordedHash = if ($trialState.PSObject.Properties['dev_schema_hash']) { $trialState.dev_schema_hash } else { $null }
    $stateReady = if ($trialState.PSObject.Properties['ready']) { [bool]$trialState.ready } else { $false }
    if ($devSchemaHash -ne $recordedHash) {
      Write-Host '数据库结构落后于暂存迁移集，正在补迁移…'
      if ($stateReady) {
        $backup = Join-Path $repoRoot ('.relay-test\before-upgrade-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.dump')
        & (Join-Path (Split-Path -Parent $trialPgCtl) 'pg_dump.exe') "postgresql://relay_api_admin@127.0.0.1:$($trialState.port)/relay_trial" -w -Fc -f $backup
        if ($LASTEXITCODE -ne 0) { throw "迁移前备份数据库失败（exit $LASTEXITCODE）" }
        Write-Host "已备份试用库：$backup"
      }
      $env:RELAY_MIGRATION_DB_URL = "postgresql://relay_migrator@127.0.0.1:$($trialState.port)/relay_trial"
      & $node (Join-Path $resourceRoot 'api\dist\src\cli\migrate.js')
      if ($LASTEXITCODE -ne 0) { Remove-Item Env:RELAY_MIGRATION_DB_URL -ErrorAction SilentlyContinue; throw "migrate 失败（exit $LASTEXITCODE）" }
      & $node (Join-Path $resourceRoot 'api\dist\src\cli\install-graph.js')
      if ($LASTEXITCODE -ne 0) { Remove-Item Env:RELAY_MIGRATION_DB_URL -ErrorAction SilentlyContinue; throw "install-graph 失败（exit $LASTEXITCODE）" }
      Remove-Item Env:RELAY_MIGRATION_DB_URL -ErrorAction SilentlyContinue
      $trialState.dev_schema_hash = $devSchemaHash
      [IO.File]::WriteAllText($trialStatePath, ($trialState | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
      Write-Host '数据库结构已升级。'
    }
  }
}

# 3) 前端 Vite：tauri dev 依赖 devUrl 可达；已监听则复用。
$portBusy = Get-NetTCPConnection -State Listen -LocalPort $FrontendPort -ErrorAction SilentlyContinue
$viteProcess = $null
if (-not $portBusy) {
  if (-not $SkipFrontendCheck) {
    Write-Host "启动 Vite（127.0.0.1:$FrontendPort）…"
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $viteOut = Join-Path $stateDir 'vite.out.log'
    $viteErr = Join-Path $stateDir 'vite.err.log'
    $viteProcess = Start-Process -FilePath $node -ArgumentList @((Join-Path $workbenchRoot 'node_modules\vite\bin\vite.js'), '--host', '127.0.0.1', '--port', "$FrontendPort", '--strictPort') -WorkingDirectory $workbenchRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $viteOut -RedirectStandardError $viteErr
    $deadline = (Get-Date).AddSeconds(30)
    do {
      Start-Sleep -Milliseconds 400
      $up = $false
      try { $up = (Invoke-WebRequest -Uri "http://127.0.0.1:$FrontendPort/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { }
    } while (-not $up -and (Get-Date) -lt $deadline -and -not $viteProcess.HasExited)
    if (-not $up) { throw "Vite 未在 30 秒内就绪；日志：$viteErr" }
  }
} else {
  Write-Host "端口 $FrontendPort 已有监听，复用现有前端服务。"
}

# 4) tauri dev：Rust 变更自动重编译重启；前端 HMR 由 Vite 提供。
$vsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $vsDevCmd -PathType Leaf)) { throw "缺少 VS Build Tools：$vsDevCmd" }
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
cmd.exe /d /s /c "call `"$vsDevCmd`" -arch=x64 >nul && set" | ForEach-Object {
  $name, $value = $_ -split '=', 2
  if ($name -and $null -ne $value) { Set-Item -Path "Env:$name" -Value $value }
}
Write-Host '启动 tauri dev 桌面窗口（Ctrl+C 停止）…'
try {
  Invoke-Pnpm $desktopRoot @('exec', 'tauri', 'dev')
} finally {
  if ($null -ne $viteProcess -and -not $viteProcess.HasExited) {
    Stop-Process -Id $viteProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ((Test-Path $pidFile) -and ((Get-Content $pidFile -ErrorAction SilentlyContinue) -eq $PID)) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
}
