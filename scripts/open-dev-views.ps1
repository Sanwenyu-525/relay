# Start the feature map server and open the three local read-only views.
# Save as UTF-8 with BOM for Windows PowerShell 5.1.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 4318
# 用项目固定的 Node 24；PATH 上的默认 node 可能不是 24。
$fixedNode = Join-Path $root '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$node = if (Test-Path -LiteralPath $fixedNode) { $fixedNode } else { (Get-Command node -ErrorAction Stop).Source }
$views = @((Join-Path $root 'preview.html'), (Join-Path $root 'motion-border-prototype.html'))
foreach ($view in $views) {
  if (-not (Test-Path -LiteralPath $view)) { throw "缺少预览页面：$view" }
}
$url = "http://127.0.0.1:$port/"
$listener = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($listener.Count) {
  Write-Host "功能地图已在运行（PID $($listener[0].OwningProcess)），直接打开。"
} else {
  $log = Join-Path $root 'output\feature-map\server.log'
  New-Item -ItemType Directory -Path (Split-Path -Parent $log) -Force | Out-Null
  $process = Start-Process -FilePath $node -ArgumentList 'scripts/feature-map.mjs', '--serve', "--port=$port" `
    -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
  # 端口真正监听前打开页面只会得到连接错误，所以先等监听就绪。
  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    if (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count) { $ready = $true; break }
    if ($process.HasExited) { throw "功能地图服务启动失败，退出码 $($process.ExitCode)；见 $log.err" }
  }
  if (-not $ready) { throw "功能地图服务 10 秒内没有监听 $port；见 $log.err" }
  Write-Host "功能地图已启动（PID $($process.Id)），日志：$log"
}
Start-Process $url
foreach ($view in $views) { Start-Process $view }
Write-Host "停止服务：Stop-Process -Id <PID>（上方输出）"