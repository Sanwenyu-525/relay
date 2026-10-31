$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile('D:\Develop\Relay-Agent\tmp\backend-execution-architecture-acceptance-2026-10-30\scripts\staged-api-acceptance.ps1',
  [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -eq 0) { Write-Output 'SYNTAX OK' }
else {
  foreach ($errorItem in $errors) {
    Write-Output ('{0}: {1}' -f $errorItem.Extent.StartLineNumber, $errorItem.Message)
  }
  exit 1
}
