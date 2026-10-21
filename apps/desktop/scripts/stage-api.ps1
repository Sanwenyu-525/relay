# 把 apps/api 重新构建并暂存到 src-tauri\resources\api（pnpm build + deploy）。
# 由 dev-desktop.ps1 与 test-desktop.ps1 共用：启动器必须**先刷新暂存、再判断补迁移**。
# 若刷新发生在补迁移之后，暂存迁移集可能领先于数据库，窗口内 API 的 readiness 会以
# SCHEMA_UNAVAILABLE 退出（2026-10-20 实例：0125 在迁移决策之后才被暂存进来）。
# 判据与原 dev-desktop.ps1 实现一致：只比较写入时间，只改前端/Rust 不触发刷新。
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [switch]$Force,
  [switch]$Skip
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Skip) { return }
$apiRoot = Join-Path $RepoRoot 'apps\api'
$resourceRoot = Join-Path $RepoRoot 'apps\desktop\src-tauri\resources'
$node = Join-Path $RepoRoot '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$corepack = Join-Path (Split-Path -Parent $node) 'node_modules\corepack\dist\corepack.js'

function Invoke-Pnpm {
  param([string]$Directory, [string[]]$Arguments)
  Push-Location $Directory
  try {
    & $node $corepack 'pnpm@9.15.9' @Arguments
    # Ctrl+C 会向整个进程组广播 CTRL_C_EVENT：此时不能继续部署半成品，也不能当成普通失败。
    if ($LASTEXITCODE -eq -1073741510) { throw '暂存刷新被 Ctrl+C 中断；未部署不完整的构建。' }
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') exited $LASTEXITCODE" }
  } finally { Pop-Location }
}

<#
  暂存 API 是否落后于源码。

  判据只用写入时间：源码最新时间晚于暂存产物最新时间即为落后；刷新后 pnpm deploy 会写入新的产物，
  下一次不会重复触发。只改前端或 Rust 不会误触发。

  源码范围必须覆盖所有会改变暂存内容的输入：src、migrations、skills（skills/builtin/gh 在
  apps/api/package.json 的 files 里，会随 deploy 进暂存）、package.json、tsconfig.json。
  漏掉 skills / tsconfig 时，「只改内置技能」或「只改编译选项」不会被判为落后，窗口会继续跑旧产物。

  基准取暂存产物（dist / migrations / skills / package.json）里最新的一份：deploy 会保留源文件时间戳，
  真正把基准推前的是 tsc 新写出的 dist；因此把 skills 纳入判据也不会造成每次启动都重建。
#>
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

function Get-ApiStaleness {
  $stagedApi = Join-Path $resourceRoot 'api'
  $latestSource = Get-LatestWriteTime @(
    (Join-Path $apiRoot 'src'),
    (Join-Path $apiRoot 'migrations'),
    (Join-Path $apiRoot 'skills'),
    (Join-Path $apiRoot 'package.json'),
    (Join-Path $apiRoot 'tsconfig.json')
  )
  # 不遍历 node_modules：它体积大、且由 deploy 整棵写入（其时间由上面的 dist 代表）。
  $latestStaged = Get-LatestWriteTime @(
    (Join-Path $stagedApi 'dist'),
    (Join-Path $stagedApi 'migrations'),
    (Join-Path $stagedApi 'skills'),
    (Join-Path $stagedApi 'package.json')
  )
  [pscustomobject]@{ Stale = ($latestSource -gt $latestStaged)
    SourceLatest = $latestSource; StagedLatest = $latestStaged }
}

if (-not $Force) {
  $staleness = Get-ApiStaleness
  if (-not $staleness.Stale) { return }
  Write-Host ("apps/api 源码新于暂存资源（源码 {0} / 暂存 {1}），自动刷新暂存 API。" -f
    $staleness.SourceLatest.ToString('u'), $staleness.StagedLatest.ToString('u'))
}
foreach ($path in @($node, $corepack)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing input: $path" }
}
Invoke-Pnpm $RepoRoot @('--filter', '@relay-agent/api', 'build')
Remove-Item -LiteralPath (Join-Path $resourceRoot 'api') -Recurse -Force
Invoke-Pnpm $RepoRoot @('--config.node-linker=hoisted', '--filter', '@relay-agent/api', 'deploy', '--prod', (Join-Path $resourceRoot 'api'))
Write-Host '已重新构建并暂存 apps/api。'
