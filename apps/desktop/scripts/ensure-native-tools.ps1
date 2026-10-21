# 确保 dev 桌面窗口依赖的本机 Rust 产物是最新的（computer-runtime / file-io-helper）。
#
# 为什么需要：这两个 exe 是独立 crate 的 release 产物，被拷进 src-tauri\resources 供宿主与 API 启动，
# `tauri dev` 不会重编译它们。源码改了却跑上一版 exe 时，窗口里的行为与代码不一致，而且没有任何提示——
# 之前缺产物时只给一句「先跑 cargo build 或 dev-stack.bat Build」，需要人工判断该不该重建。
#
# 判据与 stage-api.ps1 一致：源文件（src / Cargo.toml / Cargo.lock）最新写入时间晚于产物即视为落后，
# 产物缺失也算落后。只有落后时才准备 MSVC 环境并 `cargo build --release --locked`；
# 构建后把 exe 同步到 src-tauri\resources（deploy/打包之外，resources 里的副本只由这里维护）。
#
# 由 dev-desktop.ps1 在启动窗口前调用。-Skip 与 dev-desktop 的 -SkipNativeBuild 对应，显式关掉检测。
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  # 跳过检测与构建（只用于确认产物已自行准备好）
  [switch]$Skip,
  # 无论是否落后都重建
  [switch]$Force
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Skip) {
  Write-Host '已跳过本机 Rust 产物检测（-SkipNativeBuild）。'
  return
}

$resourceRoot = Join-Path $RepoRoot 'apps\desktop\src-tauri\resources'
$vsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'

# Manifest 决定重建哪个 crate；Exe 是 cargo 的 release 产物；Staged 是宿主/API 实际读取的那一份。
# 两个 crate 各自有独立的 Cargo.toml / Cargo.lock / target（不是同一个 workspace），
# 因此 --locked 必须配上各自的 manifest。tests 不参与二进制，不纳入判据。
$tools = @(
  [pscustomobject]@{
    Name = 'computer-runtime'
    Manifest = Join-Path $RepoRoot 'apps\computer-runtime\Cargo.toml'
    Exe = Join-Path $RepoRoot 'apps\computer-runtime\target\release\relay-computer-runtime.exe'
    Staged = Join-Path $resourceRoot 'relay-computer-runtime.exe'
    Sources = @(
      (Join-Path $RepoRoot 'apps\computer-runtime\src'),
      (Join-Path $RepoRoot 'apps\computer-runtime\Cargo.toml'),
      (Join-Path $RepoRoot 'apps\computer-runtime\Cargo.lock')
    )
  },
  [pscustomobject]@{
    Name = 'file-io-helper'
    Manifest = Join-Path $RepoRoot 'apps\file-io-helper\Cargo.toml'
    Exe = Join-Path $RepoRoot 'apps\file-io-helper\target\release\relay-file-io-helper.exe'
    Staged = Join-Path $resourceRoot 'relay-file-io-helper.exe'
    Sources = @(
      (Join-Path $RepoRoot 'apps\file-io-helper\src'),
      (Join-Path $RepoRoot 'apps\file-io-helper\Cargo.toml'),
      (Join-Path $RepoRoot 'apps\file-io-helper\Cargo.lock')
    )
  }
)

# 与 stage-api.ps1 同一套算法（那里对比暂存 dist，这里对比 release 产物）；刻意保持两份独立实现，
# 各自只服务一个目录，避免引入只有两处调用方的共享模块。
function Get-LatestWriteTime {
  param([string[]]$Paths)

  $latest = [DateTime]::MinValue
  foreach ($path in $Paths) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $item = Get-Item -LiteralPath $path
    if ($item.PSIsContainer) {
      $newest = Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTimeUtc -Descending | Select-Object -First 1
      if ($newest -and $newest.LastWriteTimeUtc -gt $latest) { $latest = $newest.LastWriteTimeUtc }
    } elseif ($item.LastWriteTimeUtc -gt $latest) {
      $latest = $item.LastWriteTimeUtc
    }
  }

  return $latest
}

# 只在确实要编译时才准备：没装 VS Build Tools 的机器如果产物本来就是最新的，不应该因此启动失败。
function Initialize-MsvcEnvironment {
  if (-not (Test-Path -LiteralPath $vsDevCmd -PathType Leaf)) {
    throw "缺少 VS Build Tools：$vsDevCmd；无法自动重建本机产物。装好后重试，或用 DevDesktop 的 -SkipNativeBuild 跳过检测。"
  }

  $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
  # 与 dev-desktop.ps1 同一方式：只用 vsDevCmd 输出的环境变量，不额外包装编译命令。
  cmd.exe /d /s /c "call `"$vsDevCmd`" -arch=x64 >nul && set" | ForEach-Object {
    $name, $value = $_ -split '=', 2
    if ($name -and $null -ne $value) { Set-Item -Path "Env:$name" -Value $value }
  }
}

function Sync-StagedCopy {
  param([pscustomobject]$Tool)

  if (-not (Test-Path -LiteralPath $Tool.Exe -PathType Leaf)) {
    throw "缺少产物：$($Tool.Exe)（自动构建未产生该文件）。"
  }
  $needsCopy = $true
  if (Test-Path -LiteralPath $Tool.Staged -PathType Leaf) {
    $needsCopy = (Get-Item -LiteralPath $Tool.Exe).LastWriteTimeUtc -gt (Get-Item -LiteralPath $Tool.Staged).LastWriteTimeUtc
  }
  if ($needsCopy) {
    New-Item -ItemType Directory -Path $resourceRoot -Force | Out-Null
    Copy-Item -LiteralPath $Tool.Exe -Destination $Tool.Staged -Force
    Write-Host "[$($Tool.Name)] 已同步到 src-tauri\resources。"
  }
}

# --- 1) 判定：只收集落后的工具，未落后的一行带过，避免启动日志里看不出到底重建了什么 ---
$stale = @()
foreach ($tool in $tools) {
  $reason = $null
  if (-not (Test-Path -LiteralPath $tool.Exe -PathType Leaf)) {
    $reason = '缺少产物'
  } elseif ($Force) {
    $reason = '按 -Force 重建'
  } else {
    $sourceLatest = Get-LatestWriteTime $tool.Sources
    $exeTime = (Get-Item -LiteralPath $tool.Exe).LastWriteTimeUtc
    if ($sourceLatest -gt $exeTime) {
      $reason = ('源码新于产物（源码 {0} / 产物 {1}）' -f $sourceLatest.ToString('u'), $exeTime.ToString('u'))
    }
  }

  if ($reason) {
    Write-Host "[$($tool.Name)] $reason，自动构建…" -ForegroundColor Cyan
    $stale += $tool
  } else {
    Write-Host "[$($tool.Name)] 产物已是最新，跳过构建。"
  }
}

# --- 2) 构建：整批只需要准备一次 MSVC 环境 ---
if ($stale.Count -gt 0) {
  Initialize-MsvcEnvironment
  $cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
  if ($null -eq $cargoCommand) {
    throw '找不到 cargo（未安装 Rust 或不在 PATH）；无法自动重建本机产物。'
  }

  foreach ($tool in $stale) {
    Write-Host "[$($tool.Name)] cargo build --release --locked…"
    # Windows PowerShell 5.1 的坑：cargo 把 "Compiling …" 与编译警告写在 stderr 上，
    # 一旦调用方把本脚本的输出重定向或接管道，stderr 会被转成 NativeCommandError，
    # 在 $ErrorActionPreference='Stop' 下直接中断构建（退出码 1，但 cargo 其实没失败）。
    # 这里按住错误首选项，结果只按 cargo 的退出码判定。
    $nativePreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $cargoCommand.Source build --release --locked --manifest-path $tool.Manifest
    } finally {
      $ErrorActionPreference = $nativePreference
    }
    # Ctrl+C 会向整个进程组广播 CTRL_C_EVENT：此时产物可能被截断，不能继续同步。
    if ($LASTEXITCODE -eq -1073741510) { throw "[$($tool.Name)] 自动构建被 Ctrl+C 中断；未同步不完整的产物。" }
    if ($LASTEXITCODE -ne 0) { throw "[$($tool.Name)] cargo build 失败（退出码 $LASTEXITCODE）。" }
  }
}

# --- 3) 同步：staged 副本落后于产物时补一份（例如 resources 被手工清理过）---
foreach ($tool in $tools) { Sync-StagedCopy -Tool $tool }

if ($stale.Count -eq 0) {
  Write-Host '本机 Rust 产物无需重建。'
}
