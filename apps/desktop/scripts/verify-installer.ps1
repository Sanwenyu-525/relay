# Verify the Relay Agent installer lifecycle without touching user data.
# Refuses to run while any relay-desktop.exe is running: the NSIS template's default
# "app is running" check terminates by EXE name, which would also hit another session's
# dev window. Never kills processes itself.
# Keep this script ASCII-only for Windows PowerShell 5.1.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [string]$InstallDir = 'D:\Develop\relay-install-test'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$checks = @()
function Add-Check([string]$name, [bool]$ok, [string]$detail) {
  $script:checks += [pscustomobject]@{ name = $name; ok = $ok; detail = $detail }
}
function Result() {
  $failed = @($checks | Where-Object { -not $_.ok })
  [pscustomobject]@{ ok = ($failed.Count -eq 0); checks = $checks } | ConvertTo-Json -Depth 4
  if ($failed.Count -gt 0) { exit 1 }
}

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) { throw "Installer not found: $InstallerPath" }
$running = @(Get-CimInstance Win32_Process -Filter "Name='relay-desktop.exe'")
if ($running.Count -gt 0) {
  # Refuse instead of letting the installer kill another session's window by EXE name.
  throw "Relay Agent is running (pid $($running[0].ProcessId)). Close it through the UI first; this verifier never kills processes."
}
if (Test-Path -LiteralPath $InstallDir) { throw "Install dir already exists: $InstallDir" }

$appData = Join-Path $env:APPDATA 'dev.relay.agent'
$dataBefore = $null
if (Test-Path -LiteralPath $appData) {
  $dataBefore = @(Get-ChildItem -LiteralPath $appData -Recurse -Force -File -ErrorAction SilentlyContinue |
    Sort-Object FullName | ForEach-Object { "$($_.FullName)|$($_.Length)" })
}
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutBefore = @(Get-ChildItem -LiteralPath $startMenu -Recurse -Filter '*.lnk' -Force -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName })

try {
  # 1) Silent install to the chosen directory (no admin: installMode=currentUser).
  $install = Start-Process -FilePath $InstallerPath -ArgumentList @('/S', "/D=$InstallDir") -PassThru -Wait
  Add-Check 'silent-install-exit' ($install.ExitCode -eq 0) "exit=$($install.ExitCode)"

  # 2) Payload present.
  foreach ($relative in @('relay-desktop.exe', 'node.exe', 'api\dist\src\main.js',
      'api\dist\src\worker\supervisor-main.js', 'relay-file-io-helper.exe',
      'relay-computer-runtime.exe', 'uninstall.exe')) {
    $file = Join-Path $InstallDir $relative
    Add-Check "payload:$relative" (Test-Path -LiteralPath $file -PathType Leaf) $file
  }

  # 3) Start menu shortcut and uninstall registration.
  $shortcuts = @(Get-ChildItem -LiteralPath $startMenu -Recurse -Filter '*.lnk' -Force -ErrorAction SilentlyContinue |
    Where-Object { $shortcutBefore -notcontains $_.FullName -and $_.Name -like '*Relay*' })
  Add-Check 'start-menu-shortcut' ($shortcuts.Count -ge 1) (($shortcuts | ForEach-Object { $_.FullName }) -join '; ')
  $uninstallKeys = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    ForEach-Object {
      $item = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      # Strict mode throws on missing properties; only inspect keys that declare DisplayName.
      if ($null -ne $item -and ($item.PSObject.Properties.Name -contains 'DisplayName') -and
          $item.DisplayName -like '*Relay Agent*') { $item }
    })
  Add-Check 'uninstall-registry-entry' ($uninstallKeys.Count -ge 1) (($uninstallKeys | ForEach-Object { $_.PSChildName }) -join '; ')

  # 4) Silent uninstall keeps user data.
  $uninstaller = Join-Path $InstallDir 'uninstall.exe'
  $removal = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -PassThru -Wait
  Add-Check 'silent-uninstall-exit' ($removal.ExitCode -eq 0) "exit=$($removal.ExitCode)"
  Add-Check 'install-dir-removed' (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'relay-desktop.exe'))) $InstallDir
  $shortcutsAfter = @(Get-ChildItem -LiteralPath $startMenu -Recurse -Filter '*.lnk' -Force -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName })
  Add-Check 'shortcut-removed' (@($shortcuts | Where-Object { $shortcutsAfter -contains $_.FullName }).Count -eq 0) 'start menu'

  # 5) User data preserved byte-for-byte (same file list and sizes).
  if ($null -ne $dataBefore) {
    $dataAfter = @(Get-ChildItem -LiteralPath $appData -Recurse -Force -File -ErrorAction SilentlyContinue |
      Sort-Object FullName | ForEach-Object { "$($_.FullName)|$($_.Length)" })
    Add-Check 'user-data-preserved' (($dataBefore -join "`n") -eq ($dataAfter -join "`n")) "files=$($dataBefore.Count)"
  } else {
    Add-Check 'user-data-absent-before' $true 'no prior app data; nothing to preserve'
  }
} finally {
  # NSIS uninstallers copy themselves to temp and remove the install dir asynchronously;
  # wait briefly so the cleanup check is not a false negative.
  for ($i = 0; $i -lt 30 -and (Test-Path -LiteralPath $InstallDir); $i++) { Start-Sleep -Milliseconds 500 }
  # Leave a failed install for inspection instead of deleting it silently.
  if (Test-Path -LiteralPath $InstallDir) {
    Add-Check 'cleanup-required' $false "install dir still exists after verification: $InstallDir"
  }
}
Result
