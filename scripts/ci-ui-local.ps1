# Relay UI 质量门禁的本地等价脚本（Windows / PowerShell）。
#
# 该脚本与 .github/workflows/ui-quality.yml 执行同一组检查。它不替代 GitHub Actions：
# 上传报告、跨机器复现仍由 CI 负责。默认从仓库根运行，日志写入 tmp/UI-UNIFY-03/ci-<时间>/。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ci-ui-local.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ci-ui-local.ps1 -SkipInstall
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ci-ui-local.ps1 -SkipVisual -SkipBrowser

param(
  [switch]$SkipInstall,
  [switch]$SkipBrowser,
  [switch]$SkipVisual
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Workbench = Join-Path $Root "apps\workbench"
$LogDir = Join-Path $Root ("tmp\UI-UNIFY-03\ci-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "Relay UI quality local CI"
Write-Host "root      : $Root"
Write-Host "log       : $LogDir"

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $log = Join-Path $LogDir ("$Name.log")
  Write-Host ""
  Write-Host "==> $Name"
  Write-Host "    $Command $($Arguments -join ' ')"
  $LASTEXITCODE = 0
  & $Command @Arguments 2>&1 | Tee-Object -FilePath $log
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    throw "[$Name] failed with exit code $code; log: $log"
  }
}

Push-Location $Root
try {
  if (-not $SkipInstall) {
    Invoke-Step "install-root" "pnpm" @("install", "--frozen-lockfile")
    Invoke-Step "install-workbench" "pnpm" @("--dir", "apps/workbench", "install", "--frozen-lockfile")
  } else {
    Write-Host "skip install (explicitly requested)"
  }

  Invoke-Step "ui-conventions" "node" @("scripts/check-ui-conventions.mjs")
  Invoke-Step "guard-self-tests" "node" @("--test", "scripts/check-ui-conventions.test.mjs")
  Invoke-Step "typecheck" "pnpm" @("--dir", "apps/workbench", "run", "typecheck")
  Invoke-Step "build" "pnpm" @("--dir", "apps/workbench", "run", "build")
  Invoke-Step "vitest" "pnpm" @("--dir", "apps/workbench", "exec", "vitest", "run", "--maxWorkers=2")

  if (-not $SkipBrowser) {
    Invoke-Step "playwright-browser" "pnpm" @("--dir", "apps/workbench", "exec", "playwright", "test")
  } else {
    Write-Host "skip browser tests (explicitly requested)"
  }

  if (-not $SkipVisual) {
    Invoke-Step "visual" "pnpm" @("--dir", "apps/workbench", "run", "test:visual")
  } else {
    Write-Host "skip visual regression (explicitly requested)"
    Write-Host "NOTE: visual pixel assertions were NOT run in this local CI invocation."
  }

  Write-Host ""
  Write-Host "UI quality gate passed."
  Write-Host "Logs: $LogDir"
} finally {
  Pop-Location
}
