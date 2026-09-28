# Tauri 开发模式桌面窗口：真实窗口 + Vite 前端热更新，不生成安装包。
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\scripts\dev-desktop.ps1
# 可选参数：
#   -ConfigPath <绝对路径>   桌面 desktop.env（默认优先 .relay-test\desktop.env，其次 %APPDATA%\dev.relay.agent\desktop.env）
#   -FrontendPort 5173       Vite 端口（需与 src-tauri DEV_ORIGIN/tauri.conf devUrl 一致，改动需同步 Rust 常量）
#   -RefreshApi              重新构建 apps/api 并刷新 src-tauri 暂存资源
#   -SkipFrontendCheck       已自行启动 Vite 时跳过启动检查
# 限制：与打包版共用单实例互斥；运行打包版时请先关闭，反之亦然。
# Rust 源码变更由 tauri dev 自动重编译并重启应用；前端由 Vite HMR 热更新。
param(
  [string]$ConfigPath,
  [int]$FrontendPort = 5173,
  [switch]$RefreshApi,
  [switch]$SkipFrontendCheck
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

function Invoke-Pnpm {
  param([string]$Directory, [string[]]$Arguments)
  Push-Location $Directory
  try {
    & $node $corepack 'pnpm@9.15.9' @Arguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') exited $LASTEXITCODE" }
  } finally { Pop-Location }
}

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
    $viteOut = Join-Path $env:TEMP "relay-vite-dev-$PID.out.log"
    $viteErr = Join-Path $env:TEMP "relay-vite-dev-$PID.err.log"
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
}
