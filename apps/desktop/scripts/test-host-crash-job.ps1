# Kill a Rust host test process after it creates an ARMED Job with two Node processes.
# A fresh test process must prove the named Job is absent before it reports recovery.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$TestExe,
  [Parameter(Mandatory=$true)][string]$NodeExe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$testPath = [IO.Path]::GetFullPath($TestExe)
$nodePath = [IO.Path]::GetFullPath($NodeExe)
foreach ($path in @($testPath, $nodePath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing test input: $path" }
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('relay-desktop-crash-probe-' + [guid]::NewGuid().ToString())
$root = [IO.Path]::GetFullPath($root)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $root.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing a crash probe outside the system temp directory'
}
New-Item -ItemType Directory -Path $root -Force | Out-Null
$env:RELAY_TEST_NODE = $nodePath
$env:RELAY_JOB_PROBE_ROOT = $root
$env:RELAY_JOB_PROBE_MODE = 'hold'
$hostProcess = $null
$clean = $false
try {
  $hostProcess = Start-Process -FilePath $testPath -ArgumentList @(
    '--exact', 'job_sidecar::tests::host_crash_probe', '--nocapture'
  ) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'host.log')
  $ready = Join-Path $root 'probe-ready'
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $ready -PathType Leaf)) {
    if ($hostProcess.HasExited) { throw "Host probe exited early with $($hostProcess.ExitCode)" }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Host probe did not publish two Node PIDs' }
    Start-Sleep -Milliseconds 50
  }
  $pids = @((Get-Content -LiteralPath $ready -Raw).Trim() -split ' ' | ForEach-Object { [int]$_ })
  if ($pids.Count -ne 2) { throw 'Host probe PID record is invalid' }
  foreach ($id in $pids) {
    if (-not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { throw "Node PID $id was not running before host kill" }
  }
  Stop-Process -Id $hostProcess.Id -Force
  $hostProcess.WaitForExit(5000) | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  foreach ($id in $pids) {
    while (Get-Process -Id $id -ErrorAction SilentlyContinue) {
      if ([DateTime]::UtcNow -ge $deadline) { throw "Node PID $id survived host kill" }
      Start-Sleep -Milliseconds 50
    }
  }
  $env:RELAY_JOB_PROBE_MODE = 'recover'
  & $testPath --exact job_sidecar::tests::host_crash_recovery_probe --nocapture
  if ($LASTEXITCODE -ne 0) { throw "Fresh recovery probe exited $LASTEXITCODE" }
  Write-Host 'Host killed; both Node PIDs stopped; fresh ARMED Job recovery passed'
  $clean = $true
} finally {
  if ($hostProcess -and -not $hostProcess.HasExited) {
    Stop-Process -Id $hostProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($clean) {
    if ($root.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $root -Recurse -Force
    }
  } else {
    Write-Warning "Crash probe retained for diagnosis: $root"
  }
}
