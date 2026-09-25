[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 30,
  [switch]$TestBuildManifestMismatch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$experimentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$artifactPath = Join-Path $experimentRoot 'src-tauri\target\release\relay-desktop-p00.exe'
$bundledNodePath = Join-Path $experimentRoot 'src-tauri\target\release\node.exe'
$buildManifestPath = Join-Path $experimentRoot 'src-tauri\target\release\p00-build-manifest.json'
$resultDirectory = Join-Path $experimentRoot 'results'
$runId = [guid]::NewGuid().ToString('N')
$resultPath = Join-Path $resultDirectory "$runId.json"
$latestPath = Join-Path $resultDirectory 'latest.json'

$inputFiles = @(
  '.gitignore',
  'README.md',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'public/frame-probe.html',
  'public/frame-probe.js',
  'src/main.ts',
  'src/App.vue',
  'src/style.css',
  'scripts/prepare-resources.ps1',
  'scripts/build-release.ps1',
  'scripts/build-release.ps1',
  'scripts/run-release.ps1',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
  'src-tauri/capabilities/default.json',
  'src-tauri/src/main.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/resources/sidecar.mjs',
  'src-tauri/resources/fake-worker.mjs',
  'src-tauri/resources/node.exe',
  'src-tauri/icons/icon.ico',
  'src-tauri/target/release/p00-build-manifest.json'
)

$buildInputFiles = @(
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'public/frame-probe.html',
  'public/frame-probe.js',
  'src/main.ts',
  'src/App.vue',
  'src/style.css',
  'scripts/prepare-resources.ps1',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
  'src-tauri/capabilities/default.json',
  'src-tauri/src/main.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/resources/sidecar.mjs',
  'src-tauri/resources/fake-worker.mjs',
  'src-tauri/resources/node.exe',
  'src-tauri/icons/icon.ico'
)

function Get-InputHashes {
  $hashes = [ordered]@{}
  foreach ($relativePath in $inputFiles) {
    $fullPath = Join-Path $experimentRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "P00 input is missing: $relativePath"
    }
    $hashes[$relativePath] = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  return $hashes
}

function Get-BuildInputHashes {
  $hashes = [ordered]@{}
  foreach ($relativePath in $buildInputFiles) {
    $fullPath = Join-Path $experimentRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "P00 build input is missing: $relativePath"
    }
    $hashes[$relativePath] = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  return $hashes
}

function Assert-BuildManifest {
  param([pscustomobject]$Manifest)
  if ($Manifest.schema_version -ne 1) {
    throw 'P00 release build manifest has an unsupported schema version'
  }
  $actualInputs = Get-BuildInputHashes
  foreach ($relativePath in $buildInputFiles) {
    $manifestHash = $Manifest.build_input_sha256.$relativePath
    if ($manifestHash -ne $actualInputs[$relativePath]) {
      throw "P00 release build manifest does not match current build input: $relativePath; rerun scripts/build-release.ps1"
    }
  }
  $artifactHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Manifest.artifact_sha256 -ne $artifactHash) {
    throw 'P00 release build manifest does not match the release executable; rerun scripts/build-release.ps1'
  }
  $resourceHashes = [ordered]@{
    'fake-worker.mjs' = (Get-FileHash -LiteralPath (Join-Path $experimentRoot 'src-tauri\target\release\fake-worker.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
    'node.exe' = (Get-FileHash -LiteralPath $bundledNodePath -Algorithm SHA256).Hash.ToLowerInvariant()
    'sidecar.mjs' = (Get-FileHash -LiteralPath (Join-Path $experimentRoot 'src-tauri\target\release\sidecar.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  foreach ($name in $resourceHashes.Keys) {
    if ($Manifest.bundled_resource_sha256.$name -ne $resourceHashes[$name]) {
      throw "P00 release build manifest does not match bundled resource: $name; rerun scripts/build-release.ps1"
    }
  }
  return [ordered]@{
    artifact_sha256 = $artifactHash
    build_input_sha256 = $actualInputs
    bundled_resource_sha256 = $resourceHashes
    manifest = 'src-tauri/target/release/p00-build-manifest.json'
  }
}

function Get-ResidualBundledNodeCount {
  param([string]$ExpectedPath)
  $canonicalPath = [IO.Path]::GetFullPath($ExpectedPath)
  return @(
    Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
      try {
        $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $canonicalPath
      } catch {
        $false
      }
    }
  ).Count
}

function Get-OwnedBundledNodeProcesses {
  param([int]$RootProcessId)
  $canonicalPath = [IO.Path]::GetFullPath($bundledNodePath)
  $allNodeProcesses = @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop | Where-Object {
      try {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $canonicalPath
      } catch {
        $false
      }
    }
  )
  $parents = [System.Collections.Generic.Queue[int]]::new()
  $parents.Enqueue($RootProcessId)
  $owned = [System.Collections.Generic.List[object]]::new()
  $seen = [System.Collections.Generic.HashSet[int]]::new()
  while ($parents.Count -gt 0) {
    $parentId = $parents.Dequeue()
    foreach ($candidate in $allNodeProcesses | Where-Object { $_.ParentProcessId -eq $parentId }) {
      if ($seen.Add([int]$candidate.ProcessId)) {
        [void]$owned.Add([pscustomobject]@{
          process_id = [int]$candidate.ProcessId
          parent_process_id = [int]$candidate.ParentProcessId
        })
        $parents.Enqueue([int]$candidate.ProcessId)
      }
    }
  }
  return @($owned)
}

function Wait-OwnedBundledNodeProcesses {
  param(
    [int]$RootProcessId,
    [int]$MinimumCount,
    [int]$WaitSeconds = 6
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  do {
    $owned = @(Get-OwnedBundledNodeProcesses -RootProcessId $RootProcessId)
    if ($owned.Count -ge $MinimumCount) {
      return $owned
    }
    Start-Sleep -Milliseconds 75
  } while ([DateTime]::UtcNow -lt $deadline)
  return @(Get-OwnedBundledNodeProcesses -RootProcessId $RootProcessId)
}

function Get-ExistingValidatedNodeProcessIds {
  param([int[]]$ProcessIds)
  $canonicalPath = [IO.Path]::GetFullPath($bundledNodePath)
  return @(
    foreach ($processId in $ProcessIds) {
      $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
      if ($null -ne $candidate) {
        try {
          if ($candidate.ExecutablePath -and [IO.Path]::GetFullPath($candidate.ExecutablePath) -eq $canonicalPath) {
            $processId
          }
        } catch {}
      }
    }
  )
}

function Stop-ValidatedNodeProcesses {
  param([int[]]$ProcessIds)
  foreach ($processId in Get-ExistingValidatedNodeProcessIds -ProcessIds $ProcessIds) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

function Start-P00ReleaseProcess {
  param(
    [string[]]$Arguments = @(),
    [hashtable]$Environment = @{}
  )
  $previous = @{}
  try {
    foreach ($key in $Environment.Keys) {
      $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
      [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
    }
    return Start-Process -FilePath $artifactPath -ArgumentList $Arguments -PassThru -WindowStyle Hidden
  } finally {
    foreach ($key in $Environment.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
    }
  }
}

function Wait-P00NativeWindow {
  param(
    [System.Diagnostics.Process]$Process,
    [int]$WaitSeconds = 5
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  do {
    $Process.Refresh()
    if ($Process.MainWindowHandle -ne 0 -and $Process.MainWindowTitle -eq 'Relay P00 Desktop — Tauri WebView') {
      return [ordered]@{
        handle = $Process.MainWindowHandle.ToInt64()
        title = $Process.MainWindowTitle
      }
    }
    Start-Sleep -Milliseconds 50
  } while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline)
  return $null
}

function Invoke-ExpectedReadinessFailure {
  param([ValidateSet('wrong-nonce', 'exit-before-ready')][string]$Mode)
  $process = $null
  $ownedBeforeCleanup = @()
  try {
    $process = Start-P00ReleaseProcess -Environment @{ P00_FAKE_WORKER_MODE = $Mode }
    $exited = $process.WaitForExit(8000)
    $ownedBeforeCleanup = @(Get-OwnedBundledNodeProcesses -RootProcessId $process.Id)
    $passed = $exited -and $process.ExitCode -ne 0 -and $ownedBeforeCleanup.Count -eq 0
    return [ordered]@{
      expected = 'release host rejects the controlled FakeWorker readiness failure before a usable instance exists'
      mode = $Mode
      owned_node_process_ids_before_cleanup = @($ownedBeforeCleanup | ForEach-Object { $_.process_id })
      process_exit_code = if ($exited) { $process.ExitCode } else { $null }
      status = if ($passed) { 'PASSED' } else { 'FAILED' }
    }
  } catch {
    return [ordered]@{
      expected = 'release host rejects the controlled FakeWorker readiness failure before a usable instance exists'
      mode = $Mode
      failure = $_.Exception.Message
      owned_node_process_ids_before_cleanup = @($ownedBeforeCleanup | ForEach-Object { $_.process_id })
      status = 'FAILED'
    }
  } finally {
    if ($null -ne $process -and -not $process.HasExited) {
      $process.Kill()
      [void]$process.WaitForExit(5000)
    }
    Stop-ValidatedNodeProcesses -ProcessIds @($ownedBeforeCleanup | ForEach-Object { $_.process_id })
  }
}

function Invoke-SingleInstanceCheck {
  $primary = $null
  $contender = $null
  $primaryNodes = @()
  try {
    $primary = Start-P00ReleaseProcess -Arguments @('--p00-hold')
    $nativeWindow = Wait-P00NativeWindow -Process $primary
    $primaryNodes = @(Wait-OwnedBundledNodeProcesses -RootProcessId $primary.Id -MinimumCount 2)
    $contender = Start-P00ReleaseProcess -Arguments @('--p00-hold')
    $contenderExited = $contender.WaitForExit(6000)
    $nodesAfterContender = @(Get-OwnedBundledNodeProcesses -RootProcessId $primary.Id)
    $primaryNodeIds = @($primaryNodes | ForEach-Object { $_.process_id } | Sort-Object)
    $nodesAfterContenderIds = @($nodesAfterContender | ForEach-Object { $_.process_id } | Sort-Object)
    $primary.Refresh()
    $passed = $null -ne $nativeWindow -and
      $primaryNodes.Count -ge 2 -and
      $contenderExited -and
      $contender.ExitCode -eq 23 -and
      -not $primary.HasExited -and
      (@($primaryNodeIds) -join ',') -eq (@($nodesAfterContenderIds) -join ',')
    return [ordered]@{
      expected = 'a duplicate release launch exits before starting a second sidecar; the existing host receives a focus attempt'
      contender_exit_code = if ($contenderExited) { $contender.ExitCode } else { $null }
      existing_node_process_ids = $primaryNodeIds
      existing_node_process_ids_after_contender = $nodesAfterContenderIds
      focus_observation = 'not asserted because this test launches the window hidden; the host calls SetForegroundWindow on duplicate detection'
      status = if ($passed) { 'PASSED' } else { 'FAILED' }
    }
  } catch {
    return [ordered]@{
      expected = 'a duplicate release launch exits before starting a second sidecar; the existing host receives a focus attempt'
      failure = $_.Exception.Message
      status = 'FAILED'
    }
  } finally {
    if ($null -ne $contender -and -not $contender.HasExited) {
      $contender.Kill()
      [void]$contender.WaitForExit(5000)
    }
    if ($null -ne $primary -and -not $primary.HasExited) {
      [void]$primary.CloseMainWindow()
      if (-not $primary.WaitForExit(6000)) {
        $primary.Kill()
        [void]$primary.WaitForExit(5000)
      }
    }
    Stop-ValidatedNodeProcesses -ProcessIds @($primaryNodes | ForEach-Object { $_.process_id })
  }
}

function Invoke-ForcedHostTerminationCheck {
  $process = $null
  $ownedNodes = @()
  try {
    $process = Start-P00ReleaseProcess -Arguments @('--p00-hold')
    $nativeWindow = Wait-P00NativeWindow -Process $process
    $ownedNodes = @(Wait-OwnedBundledNodeProcesses -RootProcessId $process.Id -MinimumCount 2)
    $ownedNodeIds = @($ownedNodes | ForEach-Object { $_.process_id })
    # Deliberately omit Process.Kill($true): the Job Object must terminate these exact children itself.
    $process.Kill()
    $hostExited = $process.WaitForExit(5000)
    $deadline = [DateTime]::UtcNow.AddSeconds(6)
    do {
      $remainingNodeIds = @(Get-ExistingValidatedNodeProcessIds -ProcessIds $ownedNodeIds)
      if ($remainingNodeIds.Count -eq 0) { break }
      Start-Sleep -Milliseconds 75
    } while ([DateTime]::UtcNow -lt $deadline)
    $passed = $null -ne $nativeWindow -and $ownedNodes.Count -ge 2 -and $hostExited -and $remainingNodeIds.Count -eq 0
    return [ordered]@{
      expected = 'forcing only the release host to exit causes the Job Object to terminate its sidecar and FakeWorker without harness tree cleanup'
      host_killed_without_tree_flag = $true
      owned_node_process_ids_before_host_kill = $ownedNodeIds
      owned_node_process_ids_after_job_wait = $remainingNodeIds
      process_exit_code = if ($hostExited) { $process.ExitCode } else { $null }
      status = if ($passed) { 'PASSED' } else { 'FAILED' }
    }
  } catch {
    return [ordered]@{
      expected = 'forcing only the release host to exit causes the Job Object to terminate its sidecar and FakeWorker without harness tree cleanup'
      failure = $_.Exception.Message
      status = 'FAILED'
    }
  } finally {
    if ($null -ne $process -and -not $process.HasExited) {
      $process.Kill()
      [void]$process.WaitForExit(5000)
    }
    Stop-ValidatedNodeProcesses -ProcessIds @($ownedNodes | ForEach-Object { $_.process_id })
  }
}

function Invoke-FrameProbePositiveControl {
  $controlRunId = [guid]::NewGuid().ToString('N')
  $controlResultPath = Join-Path $resultDirectory "$controlRunId.json"
  $process = $null
  $ownedBeforeCleanup = @()
  try {
    Write-StandaloneRunResult -Path $controlResultPath -Id $controlRunId -Body ([ordered]@{
      artifact = 'src-tauri/target/release/relay-desktop-p00.exe'
      artifact_kind = 'release executable directory package (tauri build --no-bundle); not MSI or NSIS'
      status = 'RUNNING'
    })
    $process = Start-P00ReleaseProcess -Arguments @('--p00-automated', '--p00-frame-probe-control') -Environment @{
      P00_RESULT_PATH = $controlResultPath
      P00_RUN_ID = $controlRunId
    }
    $nativeWindow = Wait-P00NativeWindow -Process $process
    $exited = $process.WaitForExit(15000)
    if (-not $exited) {
      throw 'P00 frame-probe control launch did not exit within 15 seconds'
    }
    $runtimeResult = Get-Content -LiteralPath $controlResultPath -Raw | ConvertFrom-Json
    $passed = $null -ne $nativeWindow -and
      $process.ExitCode -eq 0 -and
      $runtimeResult.run_id -eq $controlRunId -and
      $runtimeResult.status -eq 'AWAITING_PARENT_EXIT' -and
      $runtimeResult.same_origin_frame_probe_executed -eq $true -and
      $runtimeResult.same_origin_frame_probe_navigation_blocked -eq $false -and
      $runtimeResult.worker_instance_valid -eq $true -and
      $runtimeResult.sidecar_graceful_exit -eq $true -and
      $runtimeResult.sidecar_reaped -eq $true
    Write-StandaloneRunResult -Path $controlResultPath -Id $controlRunId -Body ([ordered]@{
      artifact = 'src-tauri/target/release/relay-desktop-p00.exe'
      artifact_kind = 'release executable directory package (tauri build --no-bundle); not MSI or NSIS'
      expected = 'with the P00-only native subframe blocker disabled, the CSP-permitted external same-origin probe script executes in the real WebView; bridge availability and bootstrap outcome are recorded separately'
      native_window = $nativeWindow
      process_exit_code = $process.ExitCode
      runtime = $runtimeResult
      status = if ($passed) { 'PASSED' } else { 'FAILED' }
    })
    return [ordered]@{
      result = "results/$controlRunId.json"
      same_origin_frame_probe_executed = $runtimeResult.same_origin_frame_probe_executed
      same_origin_frame_probe_bridge_available = $runtimeResult.same_origin_frame_probe_bridge_available
      same_origin_frame_probe_bootstrap_succeeded = $runtimeResult.same_origin_frame_probe_bootstrap_succeeded
      same_origin_frame_probe_completion_reported = $runtimeResult.same_origin_frame_probe_completion_reported
      status = if ($passed) { 'PASSED' } else { 'FAILED' }
    }
  } catch {
    $failure = $_.Exception.Message
    if ($null -ne $process) {
      try {
        if (-not $process.HasExited) {
          $ownedBeforeCleanup = @(Get-OwnedBundledNodeProcesses -RootProcessId $process.Id)
          $process.Kill()
          [void]$process.WaitForExit(5000)
        }
      } catch {
        $failure = "$failure; P00 control host cleanup failed: $($_.Exception.Message)"
      }
    }
    Stop-ValidatedNodeProcesses -ProcessIds @($ownedBeforeCleanup | ForEach-Object { $_.process_id })
    Write-StandaloneRunResult -Path $controlResultPath -Id $controlRunId -Body ([ordered]@{
      artifact = 'src-tauri/target/release/relay-desktop-p00.exe'
      artifact_kind = 'release executable directory package (tauri build --no-bundle); not MSI or NSIS'
      expected = 'with the P00-only native subframe blocker disabled, the CSP-permitted external same-origin probe script executes in the real WebView; bridge availability and bootstrap outcome are recorded separately'
      failure = $failure
      status = 'FAILED'
    })
    return [ordered]@{
      result = "results/$controlRunId.json"
      status = 'FAILED'
    }
  }
}

function Get-EnvironmentEvidence {
  $operatingSystem = Get-CimInstance Win32_OperatingSystem
  $webViewDirectory = 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application'
  $webViewVersion = @(
    Get-ChildItem -LiteralPath $webViewDirectory -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^\d+(\.\d+){3}$' } |
      Sort-Object { [version]$_.Name } -Descending |
      Select-Object -First 1 -ExpandProperty Name
  ) | Select-Object -First 1
  return [ordered]@{
    architecture = $operatingSystem.OSArchitecture
    webview2_version = $webViewVersion
    windows_build = $operatingSystem.BuildNumber
    windows_caption = $operatingSystem.Caption
    windows_version = $operatingSystem.Version
  }
}

function Get-SourceRevision {
  $workspaceRoot = Split-Path -Parent (Split-Path -Parent $experimentRoot)
  $revision = & git -C $workspaceRoot rev-parse --verify HEAD 2>$null
  if ($LASTEXITCODE -eq 0 -and $revision) {
    return $revision.Trim()
  }
  $global:LASTEXITCODE = 0
  return 'unavailable: repository has no Git HEAD at run time'
}

function Write-RunResult {
  param([System.Collections.IDictionary]$Body)
  Write-StandaloneRunResult -Path $resultPath -Id $runId -Body $Body
}

function Write-StandaloneRunResult {
  param(
    [string]$Path,
    [string]$Id,
    [System.Collections.IDictionary]$Body
  )
  $Body.run_id = $Id
  $Body.input_sha256 = Get-InputHashes
  $Body.source_revision = Get-SourceRevision
  $Body | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM
}

New-Item -ItemType Directory -Force -Path $resultDirectory | Out-Null
if (Test-Path -LiteralPath $resultPath) {
  throw "The generated P00 run result path already exists: $resultPath"
}

Write-RunResult ([ordered]@{
  artifact = 'src-tauri/target/release/relay-desktop-p00.exe'
  artifact_kind = 'release executable directory package (tauri build --no-bundle); not MSI or NSIS'
  status = 'RUNNING'
})

if ($TestBuildManifestMismatch) {
  $manifest = Get-Content -LiteralPath $buildManifestPath -Raw | ConvertFrom-Json
  $fixture = $manifest | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $fixture.build_input_sha256.'src/App.vue' = ('0' * 64)
  $rejected = $false
  $message = $null
  try {
    [void](Assert-BuildManifest -Manifest $fixture)
  } catch {
    $message = $_.Exception.Message
    $rejected = $message -like '*current build input: src/App.vue*'
  }
  Write-RunResult ([ordered]@{
    artifact = 'src-tauri/target/release/relay-desktop-p00.exe'
    expected = 'an in-memory manifest fixture with a changed src/App.vue hash is rejected before any release process starts'
    observed_error = $message
    release_process_started = $false
    status = if ($rejected) { 'PASSED' } else { 'FAILED' }
  })
  if (-not $rejected) {
    throw 'P00 build manifest negative fixture was not rejected'
  }
  return
}

$oldResultPath = $env:P00_RESULT_PATH
$oldRunId = $env:P00_RUN_ID
$process = $null
$normalOwnedBeforeCleanup = @()
$detailedResultWritten = $false
$buildVerification = $null
try {
  if (-not (Test-Path -LiteralPath $buildManifestPath -PathType Leaf)) {
    throw 'P00 release build manifest is missing; rerun scripts/build-release.ps1'
  }
  $buildManifest = Get-Content -LiteralPath $buildManifestPath -Raw | ConvertFrom-Json
  $buildVerification = Assert-BuildManifest -Manifest $buildManifest
  if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
    throw "P00 release executable is missing: $artifactPath"
  }
  if (-not (Test-Path -LiteralPath $bundledNodePath -PathType Leaf)) {
    throw "P00 bundled Node resource is missing: $bundledNodePath"
  }

  $nodeVersion = (& $bundledNodePath --version).Trim()
  if ($nodeVersion -ne 'v24.21.0') {
    throw "P00 bundled Node version is not the fixed input: $nodeVersion"
  }

  $env:P00_RESULT_PATH = $resultPath
  $env:P00_RUN_ID = $runId
  $process = Start-Process -FilePath $artifactPath -ArgumentList '--p00-automated' -PassThru -WindowStyle Hidden
  $nativeWindow = $null
  $windowDeadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $process.Refresh()
    if ($process.MainWindowHandle -ne 0 -and $process.MainWindowTitle -eq 'Relay P00 Desktop — Tauri WebView') {
      $nativeWindow = [ordered]@{
        handle = $process.MainWindowHandle.ToInt64()
        title = $process.MainWindowTitle
      }
      break
    }
    Start-Sleep -Milliseconds 50
  } while (-not $process.HasExited -and [DateTime]::UtcNow -lt $windowDeadline)
  if ($null -eq $nativeWindow) {
    throw 'P00 executable did not expose the expected native Tauri window handle and title'
  }
  $exited = $process.WaitForExit($TimeoutSeconds * 1000)
  if (-not $exited) {
    $normalOwnedBeforeCleanup = @(Get-OwnedBundledNodeProcesses -RootProcessId $process.Id)
    $process.Kill()
    $process.WaitForExit()
    Stop-ValidatedNodeProcesses -ProcessIds @($normalOwnedBeforeCleanup | ForEach-Object { $_.process_id })
    throw "P00 automated executable did not exit within $TimeoutSeconds seconds; only the P00 host was terminated and exact captured bundled children were checked"
  }

  $appResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  $residualBundledNodeCount = Get-ResidualBundledNodeCount -ExpectedPath $bundledNodePath
  $normalPassed = $process.ExitCode -eq 0 -and
    $appResult.run_id -eq $runId -and
    $appResult.status -eq 'AWAITING_PARENT_EXIT' -and
    $appResult.webview_reloaded_handshake -eq $true -and
    $appResult.fake_worker_ready -eq $true -and
    $appResult.worker_instance_valid -eq $true -and
    $appResult.node_resource_resolved -eq $true -and
    $appResult.sidecar_graceful_exit -eq $true -and
    $appResult.sidecar_reaped -eq $true -and
    $appResult.same_origin_frame_probe_executed -eq $false -and
    $appResult.same_origin_frame_probe_navigation_blocked -eq $true -and
    $appResult.same_origin_frame_navigation_blocked -eq $true -and
    $appResult.sidecar_node_version -eq 'v24.21.0' -and
    $appResult.verification.no_token_status -eq 401 -and
    $appResult.verification.bad_host_status -eq 421 -and
    $appResult.verification.bad_origin_status -eq 403 -and
    $residualBundledNodeCount -eq 0

  $hostChecks = [ordered]@{}
  if ($normalPassed) {
    $hostChecks.frame_probe_csp_control = Invoke-FrameProbePositiveControl
    $hostChecks.readiness_wrong_nonce = Invoke-ExpectedReadinessFailure -Mode 'wrong-nonce'
    $hostChecks.readiness_exit_before_ready = Invoke-ExpectedReadinessFailure -Mode 'exit-before-ready'
    $hostChecks.single_instance = Invoke-SingleInstanceCheck
    $hostChecks.forced_host_termination = Invoke-ForcedHostTerminationCheck
  } else {
    $hostChecks.not_run = [ordered]@{
      reason = 'the normal release path did not pass; dependent host checks were not run'
      status = 'NOT_RUN'
    }
  }
  $hostChecksPassed = $normalPassed -and
    $hostChecks.frame_probe_csp_control.status -eq 'PASSED' -and
    $hostChecks.readiness_wrong_nonce.status -eq 'PASSED' -and
    $hostChecks.readiness_exit_before_ready.status -eq 'PASSED' -and
    $hostChecks.single_instance.status -eq 'PASSED' -and
    $hostChecks.forced_host_termination.status -eq 'PASSED'
  $passed = $normalPassed -and $hostChecksPassed

  Write-RunResult ([ordered]@{
    artifact = 'src-tauri/target/release/relay-desktop-p00.exe'
    artifact_sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    artifact_kind = 'release executable directory package (tauri build --no-bundle); not MSI or NSIS'
    bundled_node = [ordered]@{ path = 'src-tauri/target/release/node.exe'; version = $nodeVersion }
    bundled_resource_sha256 = [ordered]@{
      'fake-worker.mjs' = (Get-FileHash -LiteralPath (Join-Path $experimentRoot 'src-tauri\target\release\fake-worker.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
      'node.exe' = (Get-FileHash -LiteralPath $bundledNodePath -Algorithm SHA256).Hash.ToLowerInvariant()
      'sidecar.mjs' = (Get-FileHash -LiteralPath (Join-Path $experimentRoot 'src-tauri\target\release\sidecar.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    environment = Get-EnvironmentEvidence
    native_process_id = $process.Id
    native_window = $nativeWindow
    process_exit_code = $process.ExitCode
    residual_bundled_node_count = $residualBundledNodeCount
    host_checks = $hostChecks
    build_verification = $buildVerification
    sidecar = $appResult
    status = if ($passed) { 'PASSED' } else { 'FAILED' }
  })
  $detailedResultWritten = $true
  if (-not $passed) {
    throw 'P00 automated checks returned an incomplete or failed result'
  }
} catch {
  if ($detailedResultWritten) {
    throw
  }
  $failure = $_.Exception.Message
  if ($null -ne $process) {
    try {
      if (-not $process.HasExited) {
        $normalOwnedBeforeCleanup = @(Get-OwnedBundledNodeProcesses -RootProcessId $process.Id)
        $process.Kill()
        [void]$process.WaitForExit(5000)
        Stop-ValidatedNodeProcesses -ProcessIds @($normalOwnedBeforeCleanup | ForEach-Object { $_.process_id })
      }
    } catch {
      $failure = "$failure; owned P00 process cleanup failed: $($_.Exception.Message)"
    }
  }
  $exitCode = if ($null -eq $process) { $null } elseif ($process.HasExited) { $process.ExitCode } else { $null }
  $residualBundledNodeCount = if (Test-Path -LiteralPath $bundledNodePath -PathType Leaf) {
    Get-ResidualBundledNodeCount -ExpectedPath $bundledNodePath
  } else {
    $null
  }
  Write-RunResult ([ordered]@{
    artifact = 'src-tauri/target/release/relay-desktop-p00.exe'
    artifact_kind = 'release executable directory package (tauri build --no-bundle); not MSI or NSIS'
    failure = $failure
    process_exit_code = $exitCode
    residual_bundled_node_count = $residualBundledNodeCount
    status = 'FAILED'
  })
  throw
} finally {
  if ($null -eq $oldResultPath) { Remove-Item Env:P00_RESULT_PATH -ErrorAction SilentlyContinue } else { $env:P00_RESULT_PATH = $oldResultPath }
  if ($null -eq $oldRunId) { Remove-Item Env:P00_RUN_ID -ErrorAction SilentlyContinue } else { $env:P00_RUN_ID = $oldRunId }
  if (Test-Path -LiteralPath $resultPath) {
    Copy-Item -LiteralPath $resultPath -Destination $latestPath -Force
  }
}
