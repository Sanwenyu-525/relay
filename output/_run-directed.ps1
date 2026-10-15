# 本轮整改的集成复验包装：只负责设置环境、调用官方 runner、把输出落到文件。
# 不能把 runner 放进管道——postgres 会继承管道的写句柄，调用方将永远等不到 EOF。
[CmdletBinding()]
param(
  [string]$TestFile = '',
  [switch]$SkipBuild
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$root = 'D:\Develop\Relay-Agent'
$log = Join-Path $root 'output\_int-directed.txt'
$env:RELAY_FILE_IO_HELPER = Join-Path $root 'apps\file-io-helper\target\x86_64-pc-windows-msvc\debug\relay-file-io-helper.exe'

$runnerArgs = @('-UseCLocale')
if ($SkipBuild) { $runnerArgs += '-SkipBuild' }
if ($TestFile -ne '') { $runnerArgs += @('-TestFile', $TestFile) }

Start-Transcript -Path $log -Force | Out-Null
$code = 99
try {
  & (Join-Path $root 'apps\api\scripts\run-integration.ps1') @runnerArgs
  $code = $LASTEXITCODE
} catch {
  $code = 98
  Write-Host "WRAPPER-CAUGHT: $($_.Exception.Message)"
} finally {
  Stop-Transcript | Out-Null
}
[System.IO.File]::AppendAllText($log, "EXITCODE=$code`r`n")
