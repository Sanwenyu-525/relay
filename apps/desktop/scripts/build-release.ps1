# Build a release-directory package from the pinned Node, pnpm and MSVC toolchain.
# Keep this script ASCII-only for Windows PowerShell 5.1.
[CmdletBinding()]
param([switch]$SkipInstall, [switch]$TestPackage)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force -ErrorAction Stop
$desktopRoot = Split-Path -Parent $PSScriptRoot
$appsRoot = Split-Path -Parent $desktopRoot
$workspaceRoot = Split-Path -Parent $appsRoot
$tauriRoot = Join-Path $desktopRoot 'src-tauri'
$resourceRoot = Join-Path $tauriRoot 'resources'
$apiStage = Join-Path $resourceRoot 'api'
$lockedStage = Join-Path $resourceRoot 'api-lock-verify'
$node = Join-Path $workspaceRoot '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$corepack = Join-Path (Split-Path -Parent $node) 'node_modules\corepack\dist\corepack.js'
$vsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'
$workbenchRoot = Join-Path $appsRoot 'workbench'
$fontLicenseSource = Join-Path $workbenchRoot 'public\licenses\NOTO-FONTS-LICENSE.txt'
$fontLicenseDist = Join-Path $workbenchRoot 'dist\licenses\NOTO-FONTS-LICENSE.txt'
$helperRoot = Join-Path $appsRoot 'file-io-helper'
$helperExe = Join-Path $helperRoot 'target\release\relay-file-io-helper.exe'
$cargoReleaseRoot = Join-Path $tauriRoot 'target\release'
$releaseRoot = Join-Path $desktopRoot 'release'
if ($TestPackage) { $releaseRoot = Join-Path $workspaceRoot 'test-release' }
$exe = Join-Path $releaseRoot 'relay-desktop.exe'
if (@(Get-CimInstance Win32_Process | Where-Object {
  $processPath = $_.ExecutablePath
  if ($processPath -and $processPath.StartsWith('\\?\')) { $processPath = $processPath.Substring(4) }
  $processPath -and $processPath.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}).Count -gt 0) { throw 'Close the running release package before building.' }

foreach ($path in @($node, $corepack, $vsDevCmd, (Join-Path $workbenchRoot 'package.json'))) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required build input is missing: $path" }
}
if ((& $node --version) -ne 'v24.21.0') { throw 'The bundled Node must be v24.21.0' }
$env:PATH = "$(Split-Path -Parent $node);$env:PATH"

function Invoke-Pnpm {
  param([string]$Directory, [string[]]$Arguments)
  Push-Location $Directory
  try {
    & $node $corepack 'pnpm@9.15.9' @Arguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') exited $LASTEXITCODE" }
  } finally { Pop-Location }
}

function Get-BuildInputFingerprint {
  $inputs = @()
  foreach ($directory in @('apps\api\src', 'apps\api\migrations', 'apps\workbench\src', 'apps\workbench\public\licenses', 'apps\desktop\src-tauri\src', 'apps\desktop\scripts', 'apps\file-io-helper\src')) {
    $inputs += @(Get-ChildItem -LiteralPath (Join-Path $workspaceRoot $directory) -Recurse -File)
  }
  foreach ($relative in @(
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'docs\frontend\design-tokens.json', 'apps\api\package.json', 'apps\api\tsconfig.json',
    'apps\workbench\package.json', 'apps\workbench\pnpm-lock.yaml', 'apps\workbench\tsconfig.json',
    'apps\workbench\vite.config.ts', 'apps\workbench\index.html', 'apps\desktop\package.json',
    'apps\desktop\pnpm-lock.yaml', 'apps\desktop\pnpm-workspace.yaml',
    'apps\desktop\src-tauri\Cargo.toml', 'apps\desktop\src-tauri\Cargo.lock',
    'apps\desktop\src-tauri\tauri.conf.json', 'apps\desktop\src-tauri\build.rs',
    'apps\desktop\src-tauri\capabilities\default.json', 'apps\desktop\src-tauri\icons\icon.ico',
    'apps\file-io-helper\Cargo.toml', 'apps\file-io-helper\Cargo.lock'
  )) { $inputs += Get-Item -LiteralPath (Join-Path $workspaceRoot $relative) }
  $lines = foreach ($file in @($inputs | Sort-Object FullName)) {
    "$($file.FullName)|$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
  }
  $body = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash($body) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $sha.Dispose() }
}

$buildInputFingerprint = Get-BuildInputFingerprint

if (-not $SkipInstall) {
  Invoke-Pnpm $workspaceRoot @('install', '--frozen-lockfile')
  Invoke-Pnpm $workbenchRoot @('install', '--frozen-lockfile', '--ignore-workspace')
  Invoke-Pnpm $desktopRoot @('install', '--frozen-lockfile', '--ignore-workspace')
}
Invoke-Pnpm $workspaceRoot @('--filter', '@relay-agent/api', 'build')
Invoke-Pnpm $workbenchRoot @('build')
if (-not (Test-Path -LiteralPath $fontLicenseDist -PathType Leaf) -or
    (Get-FileHash -LiteralPath $fontLicenseDist -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath $fontLicenseSource -Algorithm SHA256).Hash) {
  throw 'The frontend build did not preserve the distributed font license'
}

function Remove-GeneratedStage {
  param([string]$Stage)
  if (-not (Test-Path -LiteralPath $Stage)) { return }
  $resolvedRoot = [IO.Path]::GetFullPath($resourceRoot).TrimEnd('\')
  $resolvedStage = [IO.Path]::GetFullPath($Stage)
  if ($resolvedStage -ne (Join-Path $resolvedRoot 'api') -and
      $resolvedStage -ne (Join-Path $resolvedRoot 'api-lock-verify')) {
    throw 'Refusing to remove an unexpected API staging path'
  }
  if ((Get-Item -LiteralPath $resolvedStage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Refusing to remove an API staging link'
  }
  # Enumerate without following junctions. Use the extended path so deep pnpm
  # store entries remain visible on Windows PowerShell 5.1.
  $extendedStage = '\\?\' + $resolvedStage
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($extendedStage)
  $links = @()
  while ($pending.Count -gt 0) {
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($pending.Pop())) {
      $attributes = [IO.File]::GetAttributes($entry)
      if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
        $links += Get-Item -LiteralPath $entry -Force
      } elseif ($attributes -band [IO.FileAttributes]::Directory) {
        $pending.Push($entry)
      }
    }
  }
  foreach ($link in $links) {
    $target = [string]$link.Target
    if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path $link.DirectoryName $target }
    $resolvedTarget = [IO.Path]::GetFullPath($target)
    if (-not $resolvedTarget.StartsWith($resolvedStage.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
      $selfLink = Join-Path $resolvedStage 'node_modules\.pnpm\node_modules\@relay-agent\api'
      $sourceApi = [IO.Path]::GetFullPath((Join-Path $appsRoot 'api'))
      if ($link.FullName.Substring(4) -ne $selfLink -or $resolvedTarget -ne $sourceApi) {
        throw 'Refusing to remove an API staging directory with unexpected external links'
      }
    }
  }
  # Delete verified links themselves first, then only the verified stage tree.
  foreach ($link in $links) {
    if ($link.Attributes -band [IO.FileAttributes]::Directory) {
      [IO.Directory]::Delete($link.FullName)
    } else { [IO.File]::Delete($link.FullName) }
  }
  [IO.Directory]::Delete($extendedStage, $true)
}
New-Item -ItemType Directory -Path $resourceRoot -Force | Out-Null
Remove-GeneratedStage $apiStage
Remove-GeneratedStage $lockedStage
Invoke-Pnpm $workspaceRoot @('--filter', '@relay-agent/api', 'deploy', '--prod', $lockedStage)
# pnpm 9 deploy disables lockfile reads with the hoisted linker. Install the
# reviewed deploy files using the workspace lock instead, rebased to this stage.
New-Item -ItemType Directory -Path $apiStage -Force | Out-Null
foreach ($entry in @('dist', 'migrations', 'package.json')) {
  Copy-Item -LiteralPath (Join-Path $lockedStage $entry) -Destination $apiStage -Recurse
}
$deployLockPath = Join-Path $apiStage 'pnpm-lock.yaml'
$workspaceLockText = [IO.File]::ReadAllText((Join-Path $workspaceRoot 'pnpm-lock.yaml'))
$apiImporterPattern = '(?m)^  \.: \{\}\r?\n\r?\n  apps/api:\r?$'
if ([regex]::Matches($workspaceLockText, $apiImporterPattern).Count -ne 1) {
  throw 'The workspace lock must have an empty root importer followed by apps/api'
}
[IO.File]::WriteAllText($deployLockPath, [regex]::Replace($workspaceLockText, $apiImporterPattern, '  .:'), (New-Object Text.UTF8Encoding($false)))
Invoke-Pnpm $apiStage @('install', '--prod', '--frozen-lockfile', '--ignore-workspace', '--config.node-linker=hoisted')
Remove-Item -LiteralPath $deployLockPath

function Inspect-InstalledPackages {
  param([string]$Stage)
  # The pnpm virtual store can exceed Windows PowerShell 5.1's path limit.
  $inspect = @'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const pending = [path.join(root, 'node_modules')];
const versions = new Set();
const links = [];
while (pending.length) {
  const directory = pending.pop();
  for (const entry of fs.readdirSync(path.toNamespacedPath(directory), { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) { links.push(file); continue; }
    if (entry.isDirectory()) { pending.push(file); continue; }
    if (entry.name !== 'package.json') continue;
    const pkg = JSON.parse(fs.readFileSync(path.toNamespacedPath(file), 'utf8'));
    if (pkg.name && pkg.version) versions.add(`${pkg.name}@${pkg.version}`);
  }
}
process.stdout.write(JSON.stringify({ versions: [...versions].sort(), links }));
'@
  $output = & $node '-e' $inspect $Stage
  if ($LASTEXITCODE -ne 0) { throw "Installed package inspection failed: $Stage" }
  return ($output | ConvertFrom-Json)
}
$lockedInfo = Inspect-InstalledPackages $lockedStage
$deployInfo = Inspect-InstalledPackages $apiStage
$lockedVersions = @($lockedInfo.versions)
$deployVersions = @($deployInfo.versions)
if ($lockedVersions.Count -eq 0 -or ($lockedVersions -join '|') -ne ($deployVersions -join '|')) {
  throw 'The hoisted API dependency versions differ from the frozen-lock deployment'
}
$stageLinks = @($deployInfo.links)
if ($stageLinks.Count -ne 0) { throw 'The bundled API node_modules still contains links' }
Remove-GeneratedStage $lockedStage
Copy-Item -LiteralPath $node -Destination (Join-Path $resourceRoot 'node.exe') -Force

$stageEntries = @(Get-ChildItem -LiteralPath $apiStage -Force | Select-Object -ExpandProperty Name | Sort-Object)
$expectedEntries = @('dist', 'migrations', 'node_modules', 'package.json')
if (($stageEntries -join '|') -ne ($expectedEntries -join '|')) {
  throw "API resource inventory is not the expected deploy set: $($stageEntries -join ', ')"
}
foreach ($required in @('dist\src\main.js', 'dist\src\worker\supervisor-main.js', 'dist\src\worker\main.js', 'migrations\0001_v001_human_core.sql', 'node_modules\fastify\package.json', 'node_modules\pg\package.json', 'node_modules\kysely\package.json', 'node_modules\@sinclair\typebox\package.json', 'package.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $apiStage $required))) { throw "Incomplete API resource: $required" }
}
$supervisorProtocolSource = Get-Content -LiteralPath (Join-Path $apiStage 'dist\src\worker\supervisor-main.js') -Raw
if (-not $supervisorProtocolSource.Contains('relay-desktop-supervisor-v1')) {
  throw 'The bundled supervisor lacks the required desktop recovery protocol'
}
$forbidden = @(Get-ChildItem -LiteralPath $resourceRoot -Recurse -Force -File | Where-Object {
  $_.Name -eq '.env' -or $_.Name -like '.env.*' -or $_.Name -like '*.pem' -or $_.Name -like '*.key'
})
if ($forbidden.Count -ne 0) { throw 'The desktop resources contain configuration or credential-like files' }

$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
cmd.exe /d /s /c "call `"$vsDevCmd`" -arch=x64 >nul && set" | ForEach-Object {
  $name, $value = $_ -split '=', 2
  if ($name -and $null -ne $value) { Set-Item -Path "Env:$name" -Value $value }
}
& cargo build --release --locked --manifest-path (Join-Path $helperRoot 'Cargo.toml')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $helperExe -PathType Leaf)) {
  throw 'The Windows file I/O helper build failed'
}
Copy-Item -LiteralPath $helperExe -Destination (Join-Path $resourceRoot 'relay-file-io-helper.exe') -Force
Invoke-Pnpm $desktopRoot @('exec', 'tauri', 'build', '--no-bundle')
if ((Get-BuildInputFingerprint) -ne $buildInputFingerprint) {
  throw 'Build input changed during release compilation; artifact manifest was not published'
}

$compiledExe = Join-Path $cargoReleaseRoot 'relay-desktop.exe'
foreach ($required in @($compiledExe, (Join-Path $cargoReleaseRoot 'node.exe'), (Join-Path $cargoReleaseRoot 'relay-file-io-helper.exe'), (Join-Path $cargoReleaseRoot 'api\dist\src\main.js'), (Join-Path $cargoReleaseRoot 'api\dist\src\worker\supervisor-main.js'), (Join-Path $cargoReleaseRoot 'api\dist\src\worker\main.js'))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Tauri build output is incomplete: $required" }
}
if (Test-Path -LiteralPath $releaseRoot) {
  $resolvedDesktop = [IO.Path]::GetFullPath($desktopRoot).TrimEnd('\')
  $resolvedRelease = [IO.Path]::GetFullPath($releaseRoot)
  $releaseItem = Get-Item -LiteralPath $releaseRoot -Force
  $expectedRelease = if ($TestPackage) { Join-Path $workspaceRoot 'test-release' } else { Join-Path $resolvedDesktop 'release' }
  if ($resolvedRelease -ne $expectedRelease -or
      ($releaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Refusing to replace an unexpected release directory'
  }
  Remove-Item -LiteralPath $resolvedRelease -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Copy-Item -LiteralPath $compiledExe -Destination $exe
Copy-Item -LiteralPath (Join-Path $cargoReleaseRoot 'node.exe') -Destination (Join-Path $releaseRoot 'node.exe')
Copy-Item -LiteralPath (Join-Path $cargoReleaseRoot 'relay-file-io-helper.exe') -Destination (Join-Path $releaseRoot 'relay-file-io-helper.exe')
Copy-Item -LiteralPath (Join-Path $cargoReleaseRoot 'api') -Destination $releaseRoot -Recurse
Copy-Item -LiteralPath (Join-Path $workbenchRoot 'dist\licenses') -Destination $releaseRoot -Recurse

$releaseEntries = @(Get-ChildItem -LiteralPath $releaseRoot -Force | Select-Object -ExpandProperty Name | Sort-Object)
if (($releaseEntries -join '|') -ne (@('api', 'licenses', 'node.exe', 'relay-desktop.exe', 'relay-file-io-helper.exe') -join '|')) {
  throw "Final release contains unexpected top-level entries: $($releaseEntries -join ', ')"
}

foreach ($required in @($exe, (Join-Path $releaseRoot 'node.exe'), (Join-Path $releaseRoot 'relay-file-io-helper.exe'), (Join-Path $releaseRoot 'api\dist\src\main.js'), (Join-Path $releaseRoot 'api\dist\src\worker\supervisor-main.js'), (Join-Path $releaseRoot 'api\dist\src\worker\main.js'), (Join-Path $releaseRoot 'api\migrations\0001_v001_human_core.sql'))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Release package is incomplete: $required" }
}
if (Test-Path -LiteralPath (Join-Path $releaseRoot 'api\.env')) { throw 'Release package includes a dotenv file' }

$releaseApiEntries = @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'api') -Force | Select-Object -ExpandProperty Name | Sort-Object)
if (($releaseApiEntries -join '|') -ne ($expectedEntries -join '|')) { throw 'Final API release inventory differs from the reviewed staging inventory' }
$releaseForbidden = @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'api') -Recurse -Force -File | Where-Object {
  $_.Name -eq '.env' -or $_.Name -like '.env.*' -or $_.Name -like '*.pem' -or $_.Name -like '*.key'
})
if ($releaseForbidden.Count -ne 0) { throw 'Final API release includes configuration or credential-like files' }

function Get-FileHashes {
  param([string]$Root, [string[]]$Subdirectories, [string[]]$Files)
  $hashes = [ordered]@{}
  $rootPrefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  foreach ($subdirectory in $Subdirectories) {
    $directory = [IO.Path]::GetFullPath((Join-Path $Root $subdirectory))
    if (-not $directory.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Hash directory escaped its root' }
    foreach ($file in @([IO.Directory]::EnumerateFiles(('\\?\' + $directory), '*', [IO.SearchOption]::AllDirectories) | Sort-Object)) {
      $normal = $file.Substring(4)
      if (-not $normal.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Hash input escaped its root' }
      $relative = $normal.Substring($rootPrefix.Length).Replace('\', '/')
      $hashes[$relative] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  foreach ($file in $Files) {
    $absolute = Join-Path $Root $file
    if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) { throw "Missing hash input: $absolute" }
    $hashes[$file.Replace('\', '/')] = (Get-FileHash -LiteralPath $absolute -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  return $hashes
}

$sourceHashes = [ordered]@{}
$sourceHashes['desktop'] = Get-FileHashes $desktopRoot @('src-tauri\src', 'scripts') @(
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'src-tauri\Cargo.toml', 'src-tauri\Cargo.lock',
  'src-tauri\build.rs', 'src-tauri\tauri.conf.json', 'src-tauri\capabilities\default.json',
  'src-tauri\icons\icon.ico'
)
$sourceHashes['api'] = Get-FileHashes (Join-Path $appsRoot 'api') @('src', 'migrations') @('package.json', 'tsconfig.json')
$sourceHashes['file_io_helper'] = Get-FileHashes $helperRoot @('src') @('Cargo.toml', 'Cargo.lock')
$sourceHashes['workbench'] = Get-FileHashes $workbenchRoot @('src', 'public\licenses') @('package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'index.html')
$sourceHashes['workspace_lock'] = (Get-FileHash -LiteralPath (Join-Path $workspaceRoot 'pnpm-lock.yaml') -Algorithm SHA256).Hash.ToLowerInvariant()
$sourceHashes['workspace_manifest'] = (Get-FileHash -LiteralPath (Join-Path $workspaceRoot 'pnpm-workspace.yaml') -Algorithm SHA256).Hash.ToLowerInvariant()
$sourceHashes['design_tokens'] = (Get-FileHash -LiteralPath (Join-Path $workspaceRoot 'docs\frontend\design-tokens.json') -Algorithm SHA256).Hash.ToLowerInvariant()
$resourceHashes = Get-FileHashes $releaseRoot @('api', 'licenses') @('node.exe', 'relay-file-io-helper.exe')

$manifest = [ordered]@{
  schema_version = 1
  built_at_utc = [DateTime]::UtcNow.ToString('o')
  node_version = (& $node --version)
  tauri_crate = '2.11.6'
  tauri_cli = '2.11.5'
  build_input_fingerprint_sha256 = $buildInputFingerprint
  artifact_sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  source_sha256 = $sourceHashes
  resource_file_sha256 = $resourceHashes
  resource_inventory = $releaseApiEntries
  forbidden_config_files = $releaseForbidden.Count
}
if ((Get-BuildInputFingerprint) -ne $buildInputFingerprint) {
  throw 'Build input changed during resource publication; artifact manifest was not published'
}
$manifestPath = Join-Path $releaseRoot 'desktop-build-manifest.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Host "Release directory: $releaseRoot"
Write-Host "Executable SHA256: $($manifest.artifact_sha256)"
Write-Host "Resource files hashed: $($resourceHashes.Count); forbidden config files: $($releaseForbidden.Count)"
