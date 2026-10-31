# 把 apps/api 重新构建并暂存到 src-tauri\resources\api（pnpm build + deploy）。
# 由 dev-desktop.ps1 与 test-desktop.ps1 共用：启动器必须**先刷新暂存、再判断补迁移**。
# 若刷新发生在补迁移之后，暂存迁移集可能领先于数据库，窗口内 API 的 readiness 会以
# SCHEMA_UNAVAILABLE 退出（2026-10-20 实例：0125 在迁移决策之后才被暂存进来）。
# 判据是**源码内容指纹**，不是写入时间：2026-10-30 的实例中，源码已注册 /todos 路由，
# 但暂存产物仍是旧构建，只因为复制的文件带着更晚的时间戳，mtime 比较没有触发刷新，
# 桌面窗口里的 API 便以 404 回应一个已经存在的路由。内容指纹与「构建时记录的指纹」不一致即刷新。
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
$cachedNode = Join-Path $RepoRoot '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$cachedCorepack = Join-Path (Split-Path -Parent $cachedNode) 'node_modules\corepack\dist\corepack.js'
# 缓存不完整（例如只有 node.exe）时退回 PATH 上的 pnpm：启动器不该因为缓存缺一层目录就拒绝刷新 API。
$node = if (Test-Path -LiteralPath $cachedNode -PathType Leaf) { $cachedNode } else { $null }
$corepack = if (Test-Path -LiteralPath $cachedCorepack -PathType Leaf) { $cachedCorepack } else { $null }

function Invoke-Pnpm {
  param([string]$Directory, [string[]]$Arguments)
  Push-Location $Directory
  try {
    if ($node -ne $null -and $corepack -ne $null) {
      & $node $corepack 'pnpm@9.15.9' @Arguments
    } else {
      & pnpm @Arguments
    }
    # Ctrl+C 会向整个进程组广播 CTRL_C_EVENT：此时不能继续部署半成品，也不能当成普通失败。
    if ($LASTEXITCODE -eq -1073741510) { throw '暂存刷新被 Ctrl+C 中断；未部署不完整的构建。' }
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') exited $LASTEXITCODE" }
  } finally { Pop-Location }
}

<#
  暂存 API 是否落后于源码。

  判据是比较**源码内容指纹**与暂存目录里 `.build-info.json` 记录的指纹：
  源码范围覆盖所有会改变暂存内容的输入（src、migrations、skills、package.json、tsconfig.json）。
  指纹按「相对路径 + 文件字节」逐个喂给 SHA-256，和文件写入时间、deploy 是否保留时间戳都无关。

  为什么不再用 mtime：刷新时 tsc 只重写变化的产物，deploy 复制会保留源时间戳，
  旧文件完全可能比新源码「更新」；反过来，`git checkout` 也可能把内容没变的文件时间刷新。
  两者都会让 mtime 判据误报或漏报，而漏报的后果是窗口继续跑旧 API。
#>
function Get-SourceHash {
  $inputs = @(
    (Join-Path $apiRoot 'src'),
    (Join-Path $apiRoot 'migrations'),
    (Join-Path $apiRoot 'skills'),
    (Join-Path $apiRoot 'package.json'),
    (Join-Path $apiRoot 'tsconfig.json')
  )
  $files = foreach ($input in $inputs) {
    if (-not (Test-Path -LiteralPath $input)) { continue }
    $item = Get-Item -LiteralPath $input
    if ($item.PSIsContainer) {
      Get-ChildItem -LiteralPath $input -Recurse -File -ErrorAction SilentlyContinue
    } else {
      $item
    }
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $buffer = New-Object System.IO.MemoryStream
  try {
    foreach ($file in ($files | Sort-Object -Property FullName)) {
      # 不用 `[IO.Path]::GetRelativePath`：Windows PowerShell 5.1 的 .NET Framework 没有这个 API。
      $relative = $file.FullName.Substring($RepoRoot.Length).TrimStart([char]'\', [char]'/').Replace('\', '/')
      $name = [System.Text.Encoding]::UTF8.GetBytes("$relative`0")
      $buffer.Write($name, 0, $name.Length)
      $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
      $buffer.Write($bytes, 0, $bytes.Length)
      $buffer.WriteByte(0)
    }
    return -join ($sha.ComputeHash($buffer.ToArray()) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
    $buffer.Dispose()
  }
}

function Get-GitInfo {
  $head = $null
  $dirty = $null
  try {
    $head = (& git -C $RepoRoot rev-parse HEAD 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $head) { $head = $head.Trim() }
    $status = (& git -C $RepoRoot status --porcelain --untracked-files=normal 2>$null) -join "`n"
    if ($LASTEXITCODE -eq 0) { $dirty = ($status.Trim().Length -gt 0) }
  } catch {
    # 没有 git 或仓库不可读：指纹仍然有效，只是构建信息少了版本号。
  }
  [pscustomobject]@{ Head = $head; Dirty = $dirty }
}

function Get-ApiStaleness {
  $stagedApi = Join-Path $resourceRoot 'api'
  $sourceHash = Get-SourceHash
  $stagedHash = $null
  $infoPath = Join-Path $stagedApi '.build-info.json'
  if (Test-Path -LiteralPath $infoPath -PathType Leaf) {
    try {
      $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
      if ($info.PSObject.Properties.Name -contains 'sourceHash') { $stagedHash = $info.sourceHash }
    } catch {
      # 构建信息损坏等同于缺失：按落后处理，重建一次即可恢复。
    }
  }
  # 指纹相同但产物不存在（手工删过 dist）也必须重建，不能只信记录。
  $entry = Join-Path $stagedApi 'dist\src\main.js'
  [pscustomobject]@{ Stale = ((-not (Test-Path -LiteralPath $entry -PathType Leaf)) -or ($stagedHash -ne $sourceHash))
    SourceHash = $sourceHash; StagedHash = $stagedHash }
}

if (-not $Force) {
  $staleness = Get-ApiStaleness
  if (-not $staleness.Stale) { return }
  Write-Host ("apps/api 源码内容与暂存记录不一致（源码 {0} / 暂存 {1}），自动刷新暂存 API。" -f
    $staleness.SourceHash.Substring(0, 12),
    $(if ($staleness.StagedHash) { $staleness.StagedHash.Substring(0, 12) } else { '未记录' }))
}
if ($node -ne $null -and $corepack -ne $null) {
  foreach ($path in @($node, $corepack)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing input: $path" }
  }
} elseif ((Get-Command pnpm -ErrorAction SilentlyContinue) -eq $null) {
  throw '暂存刷新需要 pnpm：缓存里的 node/corepack 不完整，PATH 上也没有 pnpm。'
}
# 指纹在**构建前**采集（2026-10-30 执行链整改）：它记录的是本次构建读到的那份源码。
# 构建期间源码再变化时，构建后的指纹会掩盖漂移（暂存记录与「产物实际来源」不一致，
# 下一次启动不再重建）；记录构建前指纹，源码一旦变化就会被下一次 staleness 判定发现并重建。
$sourceHash = Get-SourceHash
Invoke-Pnpm $RepoRoot @('--filter', '@relay-agent/api', 'build')
# 完整构建结果先部署到暂存目录，再用目录交换替换现有版本（2026-10-30 执行链整改）。
# 旧流程是先删除再部署：构建失败虽不删（在删除之前），但部署被中断/Ctrl+C 时，
# 本机就落在「没有任何可用 API」的状态。新流程里，最后一个可用版本要么原样保留，
# 要么被一个部署完整、带指纹的目录一次性替换。
$livePath = Join-Path $resourceRoot 'api'
$stagingPath = Join-Path $resourceRoot ('api.staging-' + [guid]::NewGuid().ToString('N'))
$previousPath = Join-Path $resourceRoot ('api.previous-' + [guid]::NewGuid().ToString('N'))
# 清掉上次硬中断（进程被杀、finally 没跑到）留下的半成品；正常流程不会见到它们。
Get-ChildItem -LiteralPath $resourceRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'api.staging-*' -or $_.Name -like 'api.previous-*' } |
  Remove-Item -Recurse -Force
$swapped = $false
try {
  Invoke-Pnpm $RepoRoot @('--config.node-linker=hoisted', '--filter', '@relay-agent/api',
    'deploy', '--prod', $stagingPath)
  # 构建信息在交换前写进暂存目录：发布的目录要么完整带上指纹，要么根本不被切换进来。
  $git = Get-GitInfo
  $buildInfo = [ordered]@{
    sourceHash = $sourceHash
    builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    gitHead = $git.Head
    gitDirty = $git.Dirty
  } | ConvertTo-Json
  # 不带 BOM：这份文件也会被 Node 脚本直接 JSON.parse。
  [System.IO.File]::WriteAllText((Join-Path $stagingPath '.build-info.json'), $buildInfo,
    (New-Object System.Text.UTF8Encoding($false)))
  $hadLive = Test-Path -LiteralPath $livePath
  if ($hadLive) {
    try {
      Move-Item -LiteralPath $livePath -Destination $previousPath
    } catch {
      throw ("无法移出当前暂存 API（{0}）：桌面版可能正在运行；原版本未动，请关闭后重试。" -f
        $_.Exception.Message)
    }
  }
  try {
    Move-Item -LiteralPath $stagingPath -Destination $livePath
    $swapped = $true
  } catch {
    # 交换第二步失败：把旧版本放回去，本机不落一个没有 API 的状态。
    if ($hadLive -and -not (Test-Path -LiteralPath $livePath) -and
        (Test-Path -LiteralPath $previousPath)) {
      Move-Item -LiteralPath $previousPath -Destination $livePath
    }
    throw
  }
} finally {
  if (-not $swapped -and (Test-Path -LiteralPath $stagingPath)) {
    try { Remove-Item -LiteralPath $stagingPath -Recurse -Force } catch { }
  }
  if (Test-Path -LiteralPath $previousPath) {
    # 成功交换后这是旧版本，删除失败只留待下一次启动清扫；交换失败时它已被移回原位。
    try { Remove-Item -LiteralPath $previousPath -Recurse -Force } catch { }
  }
}
Write-Host ("已重新构建并暂存 apps/api（源码指纹 {0}）。" -f $sourceHash.Substring(0, 12))
