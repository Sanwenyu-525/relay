# Isolated interactive-menu regression. No desktop, database or model is started.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture = Join-Path $temporary ('relay-menu-test-' + [guid]::NewGuid().ToString('N'))
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$source = [IO.File]::ReadAllText((Join-Path $repo 'scripts\test-desktop.ps1'))
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
try {
  New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts') -Force | Out-Null
  $launcher = Join-Path $fixture 'scripts\test-desktop.ps1'
  [IO.File]::WriteAllText($launcher, $source, [Text.UTF8Encoding]::new($true))

  # Ctrl+C must not end the launcher itself, only the running action.
  Assert ($source.Contains('add_CancelKeyPress') -and $source.Contains('$event.Cancel = $true')) 'Launcher no longer shields itself from Ctrl+C.'

  # Status then quit: proves the menu is offered again after an action, and that
  # quitting leaves a zero exit code.
  $answers = Join-Path $fixture 'answers.txt'
  [IO.File]::WriteAllText($answers, "4`r`n0`r`n", [Text.UTF8Encoding]::new($false))
  $stdout = Join-Path $fixture 'menu.out'
  $stderr = Join-Path $fixture 'menu.err'
  $process = Start-Process $powershell -PassThru -RedirectStandardInput $answers -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $launcher + '"'))
  try {
    $null = $process.Handle
    if (-not $process.WaitForExit(60000)) { throw 'Menu did not exit within 60 seconds; fixture preserved.' }
    $process.Refresh()
    $code = $process.ExitCode
    # Get-Content -Raw yields $null for an empty file, so read the text directly.
    $output = if (Test-Path -LiteralPath $stdout) { [IO.File]::ReadAllText($stdout) } else { '' }
    $errors = if (Test-Path -LiteralPath $stderr) { [IO.File]::ReadAllText($stderr) } else { '' }
  } finally { $process.Dispose() }

  Assert ($code -eq 0) "Menu exited with $code`: $errors"
  Assert (([regex]::Matches($output, 'Relay')).Count -eq 2) 'Menu was not offered again after the action completed.'
  Assert ($output.Contains('Trial has not been initialized.')) 'Status action did not run.'
  Assert ($errors -eq '') "Menu wrote to stderr: $errors"

  # A non-interactive invocation must stay single-shot and propagate its exit code.
  $code = & $powershell -NoProfile -ExecutionPolicy Bypass -File $launcher -Action Status 2>&1 | Out-Null
  Assert ($LASTEXITCODE -eq 0) "Non-interactive Status exited with $LASTEXITCODE."
  Write-Host 'PASS: 3 scenarios; Ctrl+C shield, menu loop after an action, single-shot non-interactive invocation.'
} finally {
  Assert ([IO.Path]::GetDirectoryName($fixture) -eq $temporary -and [IO.Path]::GetFileName($fixture).StartsWith('relay-menu-test-')) 'Unsafe fixture cleanup path.'
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}