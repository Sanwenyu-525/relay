# Tauri 开发模式桌面窗口：真实窗口 + Vite 前端热更新，不生成安装包。
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\scripts\dev-desktop.ps1
#     前台运行（Ctrl+C 停止）。
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\scripts\dev-desktop.ps1 -Action start
#     后台启动：立即返回，runner 进程与日志记录在 .relay-dev\dev-desktop\。
#   ... -Action status   查看后台实例状态（runner / 窗口 / Vite / 日志路径）。
#   ... -Action stop     停止后台实例：结束 runner 进程树并兜底清理 dev 版窗口与 Vite 残留。
# 可选参数：
#   -ConfigPath <绝对路径>   桌面 desktop.env（默认优先 .relay-test\desktop.env，其次 %APPDATA%\dev.relay.agent\desktop.env）
#   -FrontendPort 5173       Vite 端口（需与 src-tauri DEV_ORIGIN/tauri.conf devUrl 一致，改动需同步 Rust 常量）
#   -RefreshApi              重新构建 apps/api 并刷新 src-tauri 暂存资源
#   -SkipFrontendCheck       已自行启动 Vite 时跳过启动检查
# 限制：与打包版共用单实例互斥；运行打包版时请先关闭，反之亦然。
# Rust 源码变更由 tauri dev 自动重编译并重启应用；前端由 Vite HMR 热更新。
param(
  [ValidateSet('', 'start', 'stop', 'status')]
  [string]$Action = '',
  [string]$ConfigPath,
  [int]$FrontendPort = 5173,
  [switch]$RefreshApi,
  [switch]$SkipFrontendCheck,
  [switch]$RunForeground  # 内部参数：-Action start 以隐藏窗口后台拉起本脚本时使用
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$desktopRoot = Join-Path $repoRoot 'apps\desktop'
$tauriRoot = Join-Path $desktopRoot 'src-tauri'
$resourceRoot = Join-Path $tauriRoot 'resources'
$apiRoot = Join-Path $repoRoot 'apps\api'
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

# 后台管理模式：PID 记录 + 日志集中在 .relay-dev\dev-desktop\；前台流程保持原样。
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
  if (-not (Test-Path $pidFile)) {
    Write-Host '没有后台运行记录（.relay-dev\dev-desktop\runner.pid 不存在）；前台运行的实例请在其终端 Ctrl+C 停止。'
    return
  }
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
if ($RefreshApi) {
  Invoke-Pnpm $repoRoot @('--filter', '@relay-agent/api', 'build')
  Remove-Item -LiteralPath (Join-Path $resourceRoot 'api') -Recurse -Force
  Invoke-Pnpm $repoRoot @('--config.node-linker=hoisted', '--filter', '@relay-agent/api', 'deploy', '--prod', (Join-Path $resourceRoot 'api'))
  Write-Host '已重新构建并暂存 apps/api。'
}
foreach ($name in @('node.exe', 'relay-file-io-helper.exe')) {
  $target = Join-Path $tauriRoot $name
  $source = Join-Path $resourceRoot $name
  if (-not (Test-Path $target)) { Copy-Item -LiteralPath $source -Destination $target }
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
