# Check the packaged frozen diff in a disposable WebView2 + PostgreSQL session.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $desktopRoot)
$start = Join-Path $desktopRoot 'scripts\start-acceptance-session.ps1'
$stop = Join-Path $desktopRoot 'scripts\stop-acceptance-session.ps1'
$release = Join-Path $desktopRoot 'release'
$exe = Join-Path $release 'relay-desktop.exe'
$node = Join-Path $release 'node.exe'
$seedHelper = Join-Path $PSScriptRoot 'm06-seed-file-write.mjs'
$probe = Join-Path $PSScriptRoot 'm06-probe-webview-diff.mjs'
$evidence = Join-Path $workspaceRoot 'docs\testing\evidence\m06-webview-file-write-diff.txt'
$screenshot = Join-Path $workspaceRoot 'docs\testing\evidence\m06-webview-file-write-diff.png'
$identityScreenshot = Join-Path $workspaceRoot 'docs\testing\evidence\m06-webview-managed-root-identity.png'
$sessionId = [guid]::NewGuid().ToString('N')
$sessionRoot = Join-Path ([IO.Path]::GetTempPath()) "relay-m02-acceptance-$sessionId"
$statePath = Join-Path $sessionRoot 'session.json'
$oldConfig = [Environment]::GetEnvironmentVariable('RELAY_DESKTOP_CONFIG_PATH', 'Process')
$oldData = [Environment]::GetEnvironmentVariable('RELAY_DESKTOP_DATA_ROOT', 'Process')
$oldWebview = [Environment]::GetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'Process')
$passed = $false
try {
  & $start -SkipDesktop -InstallGraph -UseCLocale -SessionId $sessionId
  if ($LASTEXITCODE -ne 0) { throw 'Disposable acceptance session did not start' }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if ($state.session_id -ne $sessionId -or $state.desktop_pid -ne 0 -or
      $state.release_sha256 -ne (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw 'Disposable session identity or release changed'
  }
  $seed = (& $node $seedHelper 'seed' $sessionRoot) -join '' | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $seed.phase -ne 'seed') { throw 'FILE_WRITE seed failed' }
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $cdpPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort"
  $env:RELAY_DESKTOP_CONFIG_PATH = [string]$state.config_path
  $env:RELAY_DESKTOP_DATA_ROOT = [string]$state.data_root
  $hostProcess = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
  $state.desktop_pid = $hostProcess.Id
  [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
  & $node (Join-Path $PSScriptRoot 'm03-probe-bootstrap.mjs') $cdpPort 60000
  if ($LASTEXITCODE -ne 0) { throw 'Packaged WebView2 did not become ready' }
  & $node $probe $cdpPort $seed.run_id $seed.operation_id $screenshot `
    $seed.project_id $seed.resource_id $identityScreenshot
  if ($LASTEXITCODE -ne 0) { throw 'Packaged frozen diff WebView2 probe failed' }
  $passed = $true
} finally {
  [Environment]::SetEnvironmentVariable('RELAY_DESKTOP_CONFIG_PATH', $oldConfig, 'Process')
  [Environment]::SetEnvironmentVariable('RELAY_DESKTOP_DATA_ROOT', $oldData, 'Process')
  [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', $oldWebview, 'Process')
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($saved.session_id -ne $sessionId) { throw 'Disposable session identity changed before cleanup' }
    if ($saved.desktop_pid -gt 0) {
      $actual = Get-CimInstance Win32_Process -Filter "ProcessId = $($saved.desktop_pid)"
      if ($null -ne $actual) {
        if (-not [string]::Equals($actual.ExecutablePath, $exe,
            [StringComparison]::OrdinalIgnoreCase)) { throw 'Desktop PID was reused before cleanup' }
        $live = Get-Process -Id ([int]$saved.desktop_pid) -ErrorAction Stop
        if (-not $live.CloseMainWindow() -or -not $live.WaitForExit(15000)) {
          throw 'Disposable desktop window did not close normally'
        }
      }
    }
    & $stop -SessionRoot $sessionRoot
    if ($LASTEXITCODE -ne 0) { throw 'Disposable WebView2 session cleanup failed' }
  }
}
if ($passed) {
  @(
    'M06 packaged WebView2 frozen diff acceptance',
    "release_sha256=$($state.release_sha256)",
    "session_id=$sessionId",
    "run_id=$($seed.run_id) operation_id=$($seed.operation_id)",
    'CREATE and MODIFY frozen planned text visible; planned effect explicitly separated from ledger and disk',
    "screenshot=$screenshot",
    'registered Windows FILE_WRITE root identity visible in the packaged Connections page',
    "identity_screenshot=$identityScreenshot",
    'postgres_stopped=true temporary_root_removed=true',
    'M06_WEBVIEW_FILE_WRITE_DIFF=PASS'
  ) | Set-Content -LiteralPath $evidence -Encoding utf8
  Write-Host 'M06_WEBVIEW_FILE_WRITE_DIFF=PASS'
}
