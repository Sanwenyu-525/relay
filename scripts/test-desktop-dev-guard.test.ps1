# Isolated developer-launch guard regression; no desktop, database or model is started.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture = Join-Path $temporary ('relay-dev-guard-test-' + [guid]::NewGuid().ToString('N'))
$mutexName = 'Local\RelayDevGuardTest-' + [guid]::NewGuid().ToString('N')
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$source = [IO.File]::ReadAllText((Join-Path $repo 'apps\desktop\scripts\dev-desktop.ps1'))
$guard = $null
$pending = $false
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-Text([string]$Path, [string]$Value) { [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($true)) }
function Run-Launch([string]$Action = '', [switch]$ExistingProcess) {
  $id = [guid]::NewGuid().ToString('N')
  $out = Join-Path $fixture "$id.out"
  $err = Join-Path $fixture "$id.err"
  $stub = if ($ExistingProcess) { 'function Get-Process { param($Name,$ErrorAction) [pscustomobject]@{ Id = 54321 } }' } else { 'function Get-Process { param($Name,$ErrorAction) }' }
  $wrapper = Join-Path $fixture "$id.ps1"
  Write-Text $wrapper ("[Console]::OutputEncoding = [Text.UTF8Encoding]::new(`$false)`n" + $stub + "`n& '" + (Join-Path $fixture 'apps\desktop\scripts\dev-desktop.ps1') + "' -Action '$Action'")
  $child = Start-Process $powershell -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $wrapper + '"'))
  try {
    $null = $child.Handle
    if (-not $child.WaitForExit(15000)) { $script:pending = $true; throw 'Guard test child timed out; fixture retained.' }
    $child.Refresh()
    [pscustomobject]@{ Code=$child.ExitCode; Output=(([IO.File]::ReadAllText($out),[IO.File]::ReadAllText($err)) -join "`n") }
  } finally { $child.Dispose() }
}
try {
  New-Item -ItemType Directory -Path (Join-Path $fixture 'apps\desktop\scripts') -Force | Out-Null
  Write-Text (Join-Path $fixture 'apps\desktop\scripts\dev-desktop.ps1') ($source.Replace('Local\RelayAgentDesktopSingleInstance',$mutexName))
  $guard = [Threading.Mutex]::new($false,$mutexName)
  foreach ($action in @('', 'start')) {
    $result = Run-Launch $action
    Assert ($result.Code -ne 0 -and $result.Output.Contains('单实例锁') -and $result.Output.Contains('未启动第二个实例')) 'Busy guard did not reject before preparation.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $fixture '.relay-dev'))) 'Busy launch created development state.'
  }
  $guard.Dispose(); $guard = $null
  $probe = $null
  Assert (-not [Threading.Mutex]::TryOpenExisting($mutexName,[ref]$probe)) 'Preflight leaked an open mutex handle.'
  $result = Run-Launch
  Assert ($result.Code -ne 0 -and $result.Output.Contains('Missing input:') -and -not $result.Output.Contains('单实例锁')) 'Released guard was still rejected.'
  $result = Run-Launch -ExistingProcess
  Assert ($result.Code -ne 0 -and $result.Output.Contains('PID 54321') -and $result.Output.Contains('未启动第二个实例')) 'Existing process was not explained.'

  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
  Assert ($errors.Count -eq 0) 'Developer script parse failed.'
  $function = $ast.Find({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Invoke-Pnpm' },$true)
  . ([scriptblock]::Create($function.Extent.Text))
  function Invoke-TestPnpmExit { $global:LASTEXITCODE = $script:mockExitCode }
  $node = 'Invoke-TestPnpmExit'
  $corepack = 'fixture-corepack'
  $originalDirectory = (Get-Location).Path
  foreach ($code in @(23, 7)) {
    $script:mockExitCode = $code
    $message = ''
    try { Invoke-Pnpm $fixture @('exec','tauri','dev') } catch { $message = $_.Exception.Message }
    if ($code -eq 23) { Assert ($message.Contains('单实例锁') -and $message.Contains('退出码 23')) 'Late busy exit was treated as a build failure.' }
    else { Assert ($message -eq 'pnpm exec tauri dev exited 7') 'Unrelated tool failure was hidden.' }
    Assert ((Get-Location).Path -eq $originalDirectory) 'Tool failure did not restore working directory.'
  }
  Write-Host 'PASS: 6 scenarios; foreground/background busy guard, release/no handle leak, process explanation, late exit 23 and unrelated failure.'
} finally {
  if ($guard) { $guard.Dispose() }
  Assert (-not $pending) "Timed-out child may still use fixture: $fixture"
  Assert ([IO.Path]::GetDirectoryName($fixture) -eq $temporary -and [IO.Path]::GetFileName($fixture).StartsWith('relay-dev-guard-test-')) 'Unsafe fixture cleanup path.'
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
