[CmdletBinding()]
param(
  [switch]$SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$experimentRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $experimentRoot)
$nodeExe = Join-Path $workspaceRoot '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$corepack = Join-Path (Split-Path -Parent $nodeExe) 'node_modules\corepack\dist\corepack.js'
$vsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'
$artifactPath = Join-Path $experimentRoot 'src-tauri\target\release\relay-desktop-p00.exe'
$manifestPath = Join-Path $experimentRoot 'src-tauri\target\release\p00-build-manifest.json'
$buildInputFiles = @(
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'public/frame-probe.html',
  'public/frame-probe.js',
  'src/main.ts',
  'src/App.vue',
  'src/style.css',
  'scripts/prepare-resources.ps1',
  'scripts/build-release.ps1',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
  'src-tauri/capabilities/default.json',
  'src-tauri/src/main.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/resources/sidecar.mjs',
  'src-tauri/resources/fake-worker.mjs',
  'src-tauri/resources/node.exe',
  'src-tauri/icons/icon.ico'
)

function Get-Hashes {
  param([string[]]$RelativePaths)
  $hashes = [ordered]@{}
  foreach ($relativePath in $RelativePaths) {
    $path = Join-Path $experimentRoot $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Required P00 build input is missing: $relativePath"
    }
    $hashes[$relativePath] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  return $hashes
}

function Assert-SameHashes {
  param(
    [System.Collections.IDictionary]$Expected,
    [System.Collections.IDictionary]$Actual
  )
  foreach ($relativePath in $buildInputFiles) {
    if ($Expected[$relativePath] -ne $Actual[$relativePath]) {
      throw "P00 build input changed while the release was being built: $relativePath; no build manifest was published"
    }
  }
}

foreach ($path in @($nodeExe, $corepack, $vsDevCmd)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required P00 build input is missing: $path"
  }
}

& (Join-Path $PSScriptRoot 'prepare-resources.ps1')

$env:NO_PROXY = '*'
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''
$env:ALL_PROXY = ''
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
cmd.exe /d /s /c "call `"$vsDevCmd`" -arch=x64 >nul && set" | ForEach-Object {
  $name, $value = $_ -split '=', 2
  if ($name -and $null -ne $value) {
    Set-Item -Path "Env:$name" -Value $value
  }
}

Push-Location $experimentRoot
try {
  if (-not $SkipInstall) {
    & $nodeExe $corepack pnpm@9.15.9 install --frozen-lockfile --registry=https://registry.npmjs.org
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
  }
  $buildInputSnapshot = Get-Hashes -RelativePaths $buildInputFiles
  & $nodeExe $corepack pnpm@9.15.9 typecheck
  if ($LASTEXITCODE -ne 0) { throw "Vue typecheck failed with exit code $LASTEXITCODE" }
  & $nodeExe $corepack pnpm@9.15.9 build:frontend
  if ($LASTEXITCODE -ne 0) { throw "Vite static build failed with exit code $LASTEXITCODE" }
  & $nodeExe $corepack pnpm@9.15.9 exec tauri build --no-bundle
  if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed with exit code $LASTEXITCODE" }

  foreach ($path in @($artifactPath, (Join-Path $experimentRoot 'src-tauri\target\release\node.exe'), (Join-Path $experimentRoot 'src-tauri\target\release\sidecar.mjs'), (Join-Path $experimentRoot 'src-tauri\target\release\fake-worker.mjs'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "P00 release package is incomplete after build: $path"
    }
  }
  Assert-SameHashes -Expected $buildInputSnapshot -Actual (Get-Hashes -RelativePaths $buildInputFiles)
  [ordered]@{
    schema_version = 1
    artifact_sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    build_input_sha256 = $buildInputSnapshot
    bundled_resource_sha256 = [ordered]@{
      'fake-worker.mjs' = (Get-FileHash -LiteralPath (Join-Path $experimentRoot 'src-tauri\target\release\fake-worker.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
      'node.exe' = (Get-FileHash -LiteralPath (Join-Path $experimentRoot 'src-tauri\target\release\node.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
      'sidecar.mjs' = (Get-FileHash -LiteralPath (Join-Path $experimentRoot 'src-tauri\target\release\sidecar.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
} finally {
  Pop-Location
}
