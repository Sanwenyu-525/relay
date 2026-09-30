# Opt-in fixed Mock benchmark. Reuses run-integration.ps1 for an isolated PG cluster,
# roles, business migrations, official graph checkpoint setup, and cleanup.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$apiRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $apiRoot)
$nodeExe = Join-Path $workspaceRoot '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$tscEntry = Join-Path $apiRoot 'node_modules\typescript\bin\tsc'
$fixtureSource = Join-Path $apiRoot 'test\integration\m03-mock-benchmark.bench.ts'
$compiledFixture = Join-Path $apiRoot 'dist\test\integration\m03-mock-benchmark.bench.js'
$integrationRunner = Join-Path $PSScriptRoot 'run-integration.ps1'
$outputDir = Join-Path $workspaceRoot ('docs\testing\evidence\m03\mock-bench-' +
  (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$runnerLog = Join-Path $outputDir 'runner.log'
$oldOutputDir = [Environment]::GetEnvironmentVariable('RELAY_M03_BENCH_OUTPUT_DIR', 'Process')
$benchmarkExit = 1

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
try {
  foreach ($required in @($nodeExe, $tscEntry, $fixtureSource, $integrationRunner)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required benchmark input is missing: $required" }
  }
  $env:RELAY_M03_BENCH_OUTPUT_DIR = $outputDir
  "Benchmark output: $outputDir" | Tee-Object -FilePath $runnerLog
  Get-FileHash -Algorithm SHA256 $fixtureSource, (Join-Path $PSScriptRoot 'm03-mock-metrics-preload.mjs'), $integrationRunner |
    ForEach-Object { "INPUT_SHA256 $($_.Hash) $($_.Path)" } | Tee-Object -FilePath $runnerLog -Append

  Push-Location $apiRoot
  try {
    & $nodeExe $tscEntry -p tsconfig.json 2>&1 | Tee-Object -FilePath $runnerLog -Append
    $buildExit = $LASTEXITCODE
  } finally { Pop-Location }
  "BUILD_EXIT_CODE=$buildExit" | Tee-Object -FilePath $runnerLog -Append
  if ($buildExit -ne 0) { throw "API TypeScript build failed: $buildExit" }
  if (-not (Test-Path -LiteralPath $compiledFixture)) {
    throw "Compiled benchmark fixture is missing: $compiledFixture"
  }

  # Windows PowerShell 5.1 promotes native stderr merged with 2>&1 to an
  # ErrorRecord. initdb emits a harmless locale warning there; keep the exact
  # child output and use its exit code, rather than treating that line as a
  # failure of this wrapper.
  $priorErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $integrationRunner -SkipBuild -TestFile m03-mock-benchmark 2>&1 |
      Tee-Object -FilePath $runnerLog -Append
    $benchmarkExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $priorErrorActionPreference }
  "BENCHMARK_EXIT_CODE=$benchmarkExit" | Tee-Object -FilePath $runnerLog -Append
} catch {
  "BENCHMARK_ERROR=$($_.Exception.Message)" | Tee-Object -FilePath $runnerLog -Append
} finally {
  [Environment]::SetEnvironmentVariable('RELAY_M03_BENCH_OUTPUT_DIR', $oldOutputDir, 'Process')
}

"EVIDENCE_DIR=$outputDir" | Tee-Object -FilePath $runnerLog -Append
exit $benchmarkExit
