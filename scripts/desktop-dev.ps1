# One-click native Tauri dev window for the workbench.
# Flow: activate MSVC -> ensure a Vite dev server on 127.0.0.1:<port> (reuse if present, else start and clean up on exit) -> run `pnpm tauri dev` in the foreground.
# Keep this script ASCII-only: Windows PowerShell 5.1 mis-decodes UTF-8 Chinese bytes here and breaks string parsing.
[CmdletBinding()]
param(
  [int]$FrontendPort = 5173
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$workbenchRoot = Join-Path $root 'apps\workbench'
$desktopRoot = Join-Path $root 'apps\desktop'

function Test-ViteReady {
  param([int]$Port)
  try {
    # /@vite/client is served only by a running Vite dev server.
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/@vite/client" -UseBasicParsing -TimeoutSec 2
    return $resp.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Resolve-VsDevCmd {
  # Prefer vswhere (works for Community/Professional/BuildTools); fall back to the pinned BuildTools path used by build-release.ps1.
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
    $installPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
    if ($installPath) {
      $candidate = Join-Path $installPath 'Common7\Tools\VsDevCmd.bat'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
  }
  $fallback = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'
  if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
  return $null
}

# 1. Locate Visual Studio and activate the MSVC environment (same import trick as build-release.ps1).
$vsDevCmd = Resolve-VsDevCmd
if (-not $vsDevCmd) { throw 'Cannot find Visual Studio developer command environment (VsDevCmd.bat). Install VS 2022 with the C++ desktop workload.' }
Write-Host "Activating MSVC: $vsDevCmd"
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
cmd.exe /d /s /c "call `"$vsDevCmd`" -arch=x64 >nul && set" | ForEach-Object {
  $name, $value = $_ -split '=', 2
  if ($name -and $null -ne $value) { Set-Item -Path "Env:$name" -Value $value }
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'cargo not found on PATH. Install the stable toolchain via rustup.' }
Write-Host "cargo: $(& cargo --version)"

# 2. Ensure a Vite dev server is listening. Reuse an existing one (parallel sessions may already run it); otherwise start our own.
$startedVite = $null
if (Test-ViteReady -Port $FrontendPort) {
  Write-Host "Reusing an existing Vite dev server on 127.0.0.1:$FrontendPort (it will not be started or stopped by this script)."
} else {
  Write-Host "Starting workbench Vite dev server (port $FrontendPort) ..."
  $pnpmCmd = Join-Path (Split-Path -Parent (Get-Command pnpm -ErrorAction Stop).Source) 'pnpm.cmd'
  if (-not (Test-Path -LiteralPath $pnpmCmd -PathType Leaf)) { $pnpmCmd = 'pnpm.cmd' }
  $startedVite = Start-Process -FilePath $pnpmCmd -ArgumentList @('dev', '--port', "$FrontendPort", '--strictPort') -WorkingDirectory $workbenchRoot -PassThru -WindowStyle Minimized
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-ViteReady -Port $FrontendPort) { $ready = $true; break }
    if ($startedVite.HasExited) { break }
  }
  if (-not $ready) {
    if (-not $startedVite.HasExited) { & taskkill /T /F /PID $startedVite.Id 2>$null | Out-Null }
    throw "Vite did not become ready on 127.0.0.1:$FrontendPort; cannot continue."
  }
  Write-Host "Vite is ready."
}

# 3. Launch the native window. First run compiles Rust in debug mode and can take several minutes.
Write-Host "Launching native Tauri dev window (first run does a debug cargo build and may take several minutes) ..."
Write-Host "Note: the tauri dev window still loads frontend fixture data, not a live backend integration."
$tauriExit = 0
Push-Location $desktopRoot
try {
  & pnpm tauri dev
  $tauriExit = $LASTEXITCODE
} finally {
  Pop-Location
  if ($startedVite -and -not $startedVite.HasExited) {
    Write-Host "Stopping the Vite process tree started by this run (PID $($startedVite.Id)) ..."
    & taskkill /T /F /PID $startedVite.Id 2>$null | Out-Null
  }
}
exit $tauriExit
