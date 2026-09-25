# Compile the isolated M01 shell against the pinned Rust crates and MSVC target.
# Keep ASCII: Windows PowerShell reads BOM-less scripts as ANSI.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$experimentRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $experimentRoot 'tauri-smoke\src-tauri'
$vsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $vsDevCmd)) { throw "Missing VS developer command: $vsDevCmd" }
if (-not (Test-Path -LiteralPath (Join-Path $experimentRoot 'dist\react-smoke\index.html'))) {
  throw 'Build the React smoke page before checking Tauri'
}

$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
cmd.exe /d /s /c "call `"$vsDevCmd`" -arch=x64 >nul && set" | ForEach-Object {
  $name, $value = $_ -split '=', 2
  if ($name -and $null -ne $value) { Set-Item -Path "Env:$name" -Value $value }
}

Push-Location $tauriRoot
try {
  if (-not (Test-Path -LiteralPath 'Cargo.lock')) {
    & cargo generate-lockfile
    if ($LASTEXITCODE -ne 0) { throw "cargo generate-lockfile exit: $LASTEXITCODE" }
  }
  & cargo check --locked --target x86_64-pc-windows-msvc
  if ($LASTEXITCODE -ne 0) { throw "cargo check exit: $LASTEXITCODE" }
} finally {
  Pop-Location
}
