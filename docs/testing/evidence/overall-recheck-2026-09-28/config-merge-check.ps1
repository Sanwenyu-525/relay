$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path
$script = [IO.File]::ReadAllText((Join-Path $root 'scripts/test-desktop.ps1'))
$start = $script.IndexOf('  $runtimeOwnedKeys =')
$end = $script.IndexOf('  $env:RELAY_DESKTOP_CONFIG_PATH = $config', $start)
if ($start -lt 0 -or $end -lt $start) { throw 'Cannot locate production merge block' }
$merge = [ScriptBlock]::Create($script.Substring($start, $end - $start))
$config = Join-Path $PSScriptRoot 'audit-only-desktop.env'
$state = @{workspace_id='11111111-1111-4111-8111-111111111111'}
$previous = $env:RELAY_DB_URL
try {
  $env:RELAY_DB_URL = 'postgresql://audit@127.0.0.1/audit'
  [IO.File]::WriteAllText($config, "# audit fixture`nRELAY_DB_URL=old`nRELAY_DB_POOL_MAX=9`nRELAY_MODEL_PROVIDER=openai-compatible`nRELAY_MODEL_NAME=audit-model`nRELAY_MODEL_API_KEY=audit-placeholder`n", [Text.UTF8Encoding]::new($false))
  . $merge
  $first = [IO.File]::ReadAllText($config)
  . $merge
  $second = [IO.File]::ReadAllText($config)
  if ($first -ne $second) { throw 'Merge is not idempotent' }
  if ($second -notmatch 'RELAY_MODEL_NAME=audit-model' -or $second -notmatch 'RELAY_MODEL_API_KEY=audit-placeholder') { throw 'Model fields were lost' }
  if (($second -split "`n" | Where-Object {$_ -match '^RELAY_DB_URL='}).Count -ne 1) { throw 'Duplicate runtime key' }
  Write-Output 'PASS: exact production merge block preserves ASCII model settings and is idempotent'
} finally {
  $env:RELAY_DB_URL = $previous
  if (Test-Path -LiteralPath $config) { Remove-Item -LiteralPath $config }
}
