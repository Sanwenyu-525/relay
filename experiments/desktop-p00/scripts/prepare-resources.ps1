[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$experimentRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $experimentRoot)
$sourceNode = Join-Path $workspaceRoot '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$sourceZip = Join-Path $workspaceRoot '.research\runtime-cache\node-v24.21.0-win-x64.zip'
$targetNode = Join-Path $experimentRoot 'src-tauri\resources\node.exe'
$expectedZipHash = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'

foreach ($path in @($sourceNode, $sourceZip)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Portable Node 24 input is missing from the approved P00 runtime cache: $path"
  }
}
if ((Get-FileHash -LiteralPath $sourceZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedZipHash) {
  throw 'Portable Node 24 ZIP does not match the P00 verified official input hash.'
}
if ((& $sourceNode --version) -ne 'v24.21.0') {
  throw 'Portable Node executable does not report v24.21.0.'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetNode) | Out-Null
Copy-Item -LiteralPath $sourceNode -Destination $targetNode -Force
if ((Get-FileHash -LiteralPath $targetNode -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $sourceNode -Algorithm SHA256).Hash) {
  throw 'Copied bundled Node resource hash mismatch.'
}
