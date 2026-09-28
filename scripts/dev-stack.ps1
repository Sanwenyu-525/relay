# 开发用途：开发期前后端启停的唯一入口。
# - 默认并行启动 apps/api（Fastify API）与 apps/workbench（Vite fixture 预览），退出时按序停止两者。
# - -FrontendOnly 只启动 apps/workbench：不需要 apps/api/.env、不构建后端、不启动 API，
#   用于在没有任何后端配置时预览 fixture 页面。
#
# 边界（与设计文档一致，不做额外推测）：
# - 只绑定回环地址；不创建 apps/api/.env、不生成凭据、不创建 RELAY_DATA_ROOT。
# - 后端使用 apps/api/dist/ 构建产物启动，脚本默认为其重新构建；需要预构建时用 -SkipBuild。
# - API 以受管 stdin 启动：停止时先关闭 stdin 触发正常退出（RELAY_API_STOP_ON_STDIN_EOF=true），
#   超时才强制结束进程树。
# - 这是开发期入口，不是 ADR-007 的桌面启动入口，也不代表前后端联调已经接通：workbench 仍是 fixture 预览，
#   不调用 API。
#
# 用法：
#   dev-stack.bat Preview
#   dev-stack.bat -FrontendOnly
#   powershell -ExecutionPolicy Bypass -File scripts/dev-stack.ps1 [-FrontendOnly] [-FrontendPort 5173] [-SkipInstall] [-SkipBuild]

[CmdletBinding()]
param(
  # 只启动前端 fixture 预览：不校验 apps/api/.env、不构建也不启动 API
  [switch]$FrontendOnly,
  # 前端开发服务器端口；必须与 apps/api/.env 中 RELAY_API_ALLOWED_ORIGINS 的 origin 一致
  [int]$FrontendPort = 5173,
  # 跳过两棵依赖树的安装检查
  [switch]$SkipInstall,
  # 跳过 apps/api 构建（dist/ 缺失时仍会失败）
  [switch]$SkipBuild,
  # 自检用：启动后 N 秒自动停止（0 表示一直运行到 Ctrl+C）
  [ValidateRange(0, 600)]
  [int]$SmokeSeconds = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 退出码：2 表示启动前检查未通过（与 API 自身的配置错误退出码一致），1 表示运行期失败
$exitPreflight = 2
$exitRuntime = 1

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$apiRoot = Join-Path $workspaceRoot 'apps\api'
$frontendRoot = Join-Path $workspaceRoot 'apps\workbench'
$apiEnvFile = Join-Path $apiRoot '.env'
$apiEnvExample = Join-Path $apiRoot '.env.example'
$apiEntry = Join-Path $apiRoot 'dist\src\main.js'
$frontendEntry = Join-Path $frontendRoot 'node_modules\vite\bin\vite.js'
$portableNodeRoot = Join-Path $workspaceRoot '.research\runtime-cache\node-v24.21.0-win-x64'
$portableNode = Join-Path $portableNodeRoot 'node.exe'
$portableCorepack = Join-Path $portableNodeRoot 'node_modules\corepack\dist\corepack.js'
$corepackPin = 'pnpm@9.15.9'
$requiredEnvKeys = @(
  'RELAY_API_BIND_HOST',
  'RELAY_API_PORT',
  'RELAY_API_ALLOWED_ORIGINS',
  'RELAY_API_BEARER_TOKEN',
  'RELAY_DB_URL',
  'RELAY_DB_POOL_MAX',
  'RELAY_DB_CONNECT_TIMEOUT_MS',
  'RELAY_DATA_ROOT',
  'RELAY_LOG_LEVEL',
  'RELAY_API_STOP_ON_STDIN_EOF'
)

function Fail-Preflight {
  param([string[]]$Lines)

  Write-Host ''
  Write-Host '启动前检查未通过，未启动任何进程：' -ForegroundColor Red
  foreach ($line in $Lines) {
    Write-Host "  - $line"
  }
  Write-Host ''
  exit $exitPreflight
}

# 说明：脚本被强行终止（例如直接关闭控制台窗口、被任务管理器结束）时无法执行下面的停止逻辑。
# API 会因 stdin 管道关闭而正常退出；Vite 可能残留，下次启动的端口检查会报出占用 PID。

function Read-DotEnv {
  param([string]$Path)

  $values = @{}
  # 必须显式按 UTF-8 读：默认（ANSI/GBK）解码会把中文注释行与紧随其后的键行并成一行，
  # 该行以 # 开头被当成注释跳过后，就会把存在的键误报为缺失。首行 BOM 也在这里去掉。
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $trimmed = $line.Trim().TrimStart([char]0xFEFF)
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) {
      continue
    }

    $separatorIndex = $trimmed.IndexOf('=')
    if ($separatorIndex -lt 1) {
      continue
    }

    $key = $trimmed.Substring(0, $separatorIndex).Trim()
    $value = $trimmed.Substring($separatorIndex + 1).Trim()
    if ($value.Length -ge 2) {
      $first = $value.Substring(0, 1)
      $last = $value.Substring($value.Length - 1, 1)
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }

    $values[$key] = $value
  }

  return $values
}

function Resolve-NodeRuntime {
  if (Test-Path -LiteralPath $portableNode) {
    return @{ Path = $portableNode; Origin ='project-portable' }
  }

  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return $null
  }

  return @{ Path = $command.Source; Origin = 'path' }
}

function Resolve-PnpmRunner {
  param([string]$NodePath)

  if ((Test-Path -LiteralPath $NodePath) -and (Test-Path -LiteralPath $portableCorepack)) {
    return @{ Name = "corepack $corepackPin"; File = $NodePath; Prefix = @($portableCorepack, $corepackPin) }
  }

  $corepackCommand = Get-Command corepack -ErrorAction SilentlyContinue
  if ($null -ne $corepackCommand) {
    return @{ Name = "corepack $corepackPin"; File = $corepackCommand.Source; Prefix = @($corepackPin) }
  }

  $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -ne $pnpmCommand) {
    return @{ Name = 'pnpm (PATH)'; File = $pnpmCommand.Source; Prefix = @() }
  }

  return $null
}

function Invoke-Pnpm {
  param(
    [hashtable]$Runner,
    [string]$WorkingDirectory,
    [string[]]$Arguments
  )

  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $Runner.File @($Runner.Prefix) @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm failed with exit code $LASTEXITCODE in $WorkingDirectory"
    }
  } finally {
    Pop-Location
  }
}

function Get-HttpResponse {
  param([string]$Url, [hashtable]$Headers = @{})

  try {
    if ($Headers.Count -gt 0) {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -Headers $Headers
    } else {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    }
    return @{ StatusCode = [int]$response.StatusCode; Content = [string]$response.Content }
  } catch {
    # Windows PowerShell 5.1 下非 2xx 的响应体不在 Exception.Response 的流里：Invoke-WebRequest 已经读过它，
    # 再读只会得到空串，响应体留在 ErrorDetails.Message。两个来源都取，用非空的那个，
    # 否则 503 的诊断分支（DATABASE_UNAVAILABLE / SCHEMA_UNAVAILABLE）永远拿不到 code 与 components。
    $detailsContent = ''
    if ($null -ne $_.ErrorDetails -and -not [string]::IsNullOrEmpty($_.ErrorDetails.Message)) {
      $detailsContent = [string]$_.ErrorDetails.Message
    }

    $webResponse = $null
    if ($null -ne $_.Exception -and $null -ne $_.Exception.Response) {
      $webResponse = $_.Exception.Response
      $streamContent = ''
      try {
        $reader = New-Object System.IO.StreamReader($webResponse.GetResponseStream())
        try {
          $streamContent = $reader.ReadToEnd()
        } finally {
          $reader.Dispose()
        }
      } catch {
        $streamContent = ''
      }

      $content = if ([string]::IsNullOrEmpty($streamContent)) { $detailsContent } else { $streamContent }
      return @{ StatusCode = [int]$webResponse.StatusCode; Content = $content }
    }

    if ($detailsContent -ne '') {
      # 没有 Response 对象时状态码未知，但保留可解析的响应体，便于调用方给出原因。
      return @{ StatusCode = $null; Content = $detailsContent }
    }

    return $null
  }
}

function Get-HttpStatusCode {
  param([string]$Url, [hashtable]$Headers = @{})

  $response = Get-HttpResponse -Url $Url -Headers $Headers
  if ($null -eq $response) {
    return $null
  }

  return $response.StatusCode
}

function Get-ReadinessComponentStatus {
  param([object]$Payload, [string]$Name)

  if ($null -eq $Payload) {
    return $null
  }

  $components = $Payload.PSObject.Properties['components']
  if ($null -eq $components) {
    return $null
  }

  $component = $components.Value.PSObject.Properties[$Name]
  if ($null -eq $component) {
    return $null
  }

  $status = $component.Value.PSObject.Properties['status']
  # 不写成 `return if (...) {...}`：Windows PowerShell 5.1 不支持把 if 当表达式用在 return 后面，
  # 那会在运行期报 "The term 'if' is not recognized"。
  if ($null -eq $status) {
    return $null
  }

  return [string]$status.Value
}

function Wait-ForHttp {
  param([string]$Url, [int]$TimeoutSeconds = 20)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $status = Get-HttpStatusCode -Url $Url
    if ($null -ne $status -and $status -ge 200 -and $status -lt 300) {
      return $true
    }
    Start-Sleep -Milliseconds 300
  }

  return $false
}

# /health/ready 只作开发期提示：503 的两种原因（数据库不可达 / schema 不兼容）必须能区分出来，
# 否则启动日志无法说明后端为什么不能用。纯前端模式不会调用本函数。
function Write-ApiReadinessStatus {
  param([int]$ApiPort, [string]$Token)

  $readyHeaders = @{ Authorization = "Bearer $Token" }
  $readyResponse = Get-HttpResponse -Url "http://127.0.0.1:$ApiPort/health/ready" -Headers $readyHeaders
  if ($null -eq $readyResponse) {
    Write-Host '[api] /health/ready 无响应（凭据或网络问题），未确认数据库状态。' -ForegroundColor Yellow
    return
  }

  $readyPayload = $null
  try {
    $readyPayload = $readyResponse.Content | ConvertFrom-Json -ErrorAction Stop
  } catch {
    # 仅用于开发期提示；不可解析的响应仍按状态码给出结论。
  }

  $databaseStatus = Get-ReadinessComponentStatus -Payload $readyPayload -Name 'database'
  $schemaStatus = Get-ReadinessComponentStatus -Payload $readyPayload -Name 'schema'
  $problemCode = if ($null -eq $readyPayload -or $null -eq $readyPayload.PSObject.Properties['code']) {
    $null
  } else {
    [string]$readyPayload.code
  }

  if ($readyResponse.StatusCode -eq 200 -and $databaseStatus -eq 'up' -and $schemaStatus -eq 'up') {
    Write-Host '[api] /health/ready = 200，数据库与 schema 均匹配。'
  } elseif ($readyResponse.StatusCode -eq 503 -and $problemCode -eq 'DATABASE_UNAVAILABLE') {
    Write-Host '[api] /health/ready = 503 DATABASE_UNAVAILABLE：数据库不可达（schema 状态未知）；API 仍会监听。' -ForegroundColor Yellow
  } elseif ($readyResponse.StatusCode -eq 503 -and $problemCode -eq 'SCHEMA_UNAVAILABLE') {
    Write-Host '[api] /health/ready = 503 SCHEMA_UNAVAILABLE：数据库可达但 schema 不兼容；请先运行迁移入口。' -ForegroundColor Yellow
  } else {
    Write-Host "[api] /health/ready 返回 $($readyResponse.StatusCode)（database=$databaseStatus，schema=$schemaStatus，code=$problemCode）。" -ForegroundColor Yellow
  }
}

function Start-ManagedProcess {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory
  )

  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $FilePath
  $info.Arguments = ($Arguments | ForEach-Object {
    if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
  }) -join ' '
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  # stdin 保持为管道，停止时可关闭它以触发 API 的正常退出；
  # stdout/stderr 直接继承本脚本的控制台，避免后台读取线程带来的静默退出风险。
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $false
  $info.RedirectStandardError = $false
  $info.CreateNoWindow = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info

  if (-not $process.Start()) {
    throw "failed to start $Name"
  }

  return $process
}

function Stop-ManagedProcess {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$Name,
    [switch]$CloseStdinFirst,
    [int]$GracefulTimeoutMs = 5000
  )

  if ($null -eq $Process -or $Process.HasExited) {
    return
  }

  if ($CloseStdinFirst) {
    try {
      $Process.StandardInput.Close()
    } catch {
      Write-Host "[$Name] 关闭 stdin 失败，改为强制结束：$($_.Exception.Message)"
    }

    if ($Process.WaitForExit($GracefulTimeoutMs)) {
      Write-Host "[$Name] 已通过关闭 stdin 正常退出（exit $($Process.ExitCode)）"
      return
    }

    Write-Host "[$Name] 正常退出超时，改为强制结束进程树"
  }

  # 用 Start-Process 调用 taskkill：避免原生命令 stderr 在 $ErrorActionPreference='Stop' 下变成错误记录。
  Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', $Process.Id, '/T', '/F') -WindowStyle Hidden -Wait | Out-Null
  $Process.WaitForExit(5000) | Out-Null
  Write-Host "[$Name] 已结束"
}

# --- 启动前检查 -------------------------------------------------------------

if (-not (Test-Path -LiteralPath $apiRoot) -or -not (Test-Path -LiteralPath $frontendRoot)) {
  Fail-Preflight @("apps/api 或 apps/workbench 不存在；本脚本只适用于当前仓库结构。")
}

$envValues = @{}
$apiPort = 0

if ($FrontendOnly) {
  # 纯前端预览：不读 apps/api/.env、不构建后端，也不启动 API。
  Write-Host '已选择 -FrontendOnly：跳过 apps/api/.env 校验与后端构建/启动。' -ForegroundColor Yellow
} else {
  # 读取 .env.example 里的占位符凭据，只用于识别“还没替换”的 .env，不写入任何真实值。
  $exampleToken = $null
  if (Test-Path -LiteralPath $apiEnvExample) {
    $exampleValues = Read-DotEnv -Path $apiEnvExample
    if ($exampleValues.ContainsKey('RELAY_API_BEARER_TOKEN')) {
      $exampleToken = $exampleValues['RELAY_API_BEARER_TOKEN']
    }
  }

  if (-not (Test-Path -LiteralPath $apiEnvFile)) {
    # 第 2 步用 WriteAllText 显式写成 UTF-8 无 BOM：Set-Content -Encoding UTF8 在 PS 5.1 会写入 BOM，
    # 而 Node 的 --env-file 会把带 BOM 的第一个键读成 ".RELAY_API_BIND_HOST"。
    $tokenStep = if ($null -ne $exampleToken) {
      "  2) `$t = -join ((48..57) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]`$_ }); `$p = 'apps\api\.env'; `$c = (Get-Content `$p -Raw).Replace('$exampleToken', `$t); [System.IO.File]::WriteAllText((Resolve-Path `$p), `$c, (New-Object System.Text.UTF8Encoding(`$false)))"
    } else {
      '  2) 把 RELAY_API_BEARER_TOKEN 替换为自行生成的随机值（至少 32 字符、不含空白），文件保持 UTF-8 无 BOM。'
    }

    Fail-Preflight @(
      'apps/api/.env 不存在（该文件被 .gitignore 忽略），后端不会启动。',
      '准备步骤（在仓库根执行；脚本不代填凭据、不生成密钥）：',
      '  1) Copy-Item apps\api\.env.example apps\api\.env',
      $tokenStep,
      '  3) 按本机情况修改 RELAY_DB_URL（数据库角色与库名）与 RELAY_DATA_ROOT（已存在的绝对路径），再重新运行本脚本。',
      "只想预览前端时用 -FrontendOnly（不需要 .env）；缺失或非法的键会让 API 以退出码 2 结束。必填键：$($requiredEnvKeys -join ', ')。"
    )
  }

  $envValues = Read-DotEnv -Path $apiEnvFile
  $missingKeys = @($requiredEnvKeys | Where-Object { -not $envValues.ContainsKey($_) -or $envValues[$_] -eq '' })
  if ($missingKeys.Count -gt 0) {
    Fail-Preflight @(
      "apps/api/.env 缺少以下键：$($missingKeys -join ', ')。",
      "示例与说明见 apps/api/.env.example；脚本不会代填。"
    )
  }

  $envIssues = @()

  # Node 的 --env-file 不跳过 BOM：带 BOM 时第一个键会被读成 ".RELAY_API_BIND_HOST"，
  # 表现为 API 报 "RELAY_API_BIND_HOST is required"（明明文件里有），这里提前指出。
  $bomBuffer = New-Object byte[] 3
  $envStream = [System.IO.File]::OpenRead($apiEnvFile)
  try {
    $bomBytesRead = $envStream.Read($bomBuffer, 0, 3)
  } finally {
    $envStream.Dispose()
  }
  if ($bomBytesRead -eq 3 -and $bomBuffer[0] -eq 0xEF -and $bomBuffer[1] -eq 0xBB -and $bomBuffer[2] -eq 0xBF) {
    $envIssues += 'apps/api/.env 带 UTF-8 BOM：Node 会把第一个键读成 ".RELAY_API_BIND_HOST"，API 随即以退出码 2 报 "RELAY_API_BIND_HOST is required"；请另存为 UTF-8（无 BOM）。'
  }

  if ($null -ne $exampleToken -and $envValues['RELAY_API_BEARER_TOKEN'] -eq $exampleToken) {
    $envIssues += "RELAY_API_BEARER_TOKEN 仍是 .env.example 里的占位符，API 会以退出码 2 拒绝启动；请替换为自行生成的随机值（至少 32 字符、不含空白）。"
  }

  $dataRoot = $envValues['RELAY_DATA_ROOT']
  if (Test-Path -LiteralPath $dataRoot -PathType Container) {
    if (-not [System.IO.Path]::IsPathRooted($dataRoot)) {
      $envIssues += 'RELAY_DATA_ROOT 必须是绝对路径。'
    }
  } else {
    $envIssues += "RELAY_DATA_ROOT 指向的目录不存在：$dataRoot（脚本不会代建，请自行创建或修改 .env）。"
  }

  if (-not [int]::TryParse($envValues['RELAY_API_PORT'], [ref]$apiPort) -or $apiPort -lt 1024 -or $apiPort -gt 65535) {
    $envIssues += 'RELAY_API_PORT 必须是 1024-65535 的整数。'
  }

  $frontendOrigin = "http://127.0.0.1:$FrontendPort"
  $allowedOrigins = $envValues['RELAY_API_ALLOWED_ORIGINS']
  if ($allowedOrigins -notmatch [regex]::Escape($frontendOrigin)) {
    Write-Host "提示：RELAY_API_ALLOWED_ORIGINS 未包含 $frontendOrigin；浏览器跨源调用会被拒绝（当前预览不调用 API，仅作提醒）。" -ForegroundColor Yellow
  }

  if ($envValues['RELAY_API_STOP_ON_STDIN_EOF'] -ne 'true') {
    Write-Host '提示：RELAY_API_STOP_ON_STDIN_EOF 不为 true；停止时将直接强制结束 API 进程。' -ForegroundColor Yellow
  }

  if ($envIssues.Count -gt 0) {
    Fail-Preflight $envIssues
  }
}

$nodeRuntime = Resolve-NodeRuntime
if ($null -eq $nodeRuntime) {
  if ($FrontendOnly) {
    Fail-Preflight @('找不到 node。请安装受支持的 Node（Vite 7 要求 ^20.19.0 或 >=22.12.0），或恢复项目便携 Node。')
  }

  Fail-Preflight @('找不到 node。请安装 Node 24（engines 要求 >=24 <25），或恢复项目便携 Node。')
}

$nodeVersionText = (& $nodeRuntime.Path --version).Trim()
$nodeMajor = 0
$nodeMinor = 0
$nodeVersionParts = $nodeVersionText.TrimStart('v') -split '\.'
[void][int]::TryParse($nodeVersionParts[0], [ref]$nodeMajor)
if ($nodeVersionParts.Length -gt 1) {
  [void][int]::TryParse($nodeVersionParts[1], [ref]$nodeMinor)
}

if ($FrontendOnly) {
  # 纯前端只受 Vite 的运行范围约束，不要求 apps/api 的 Node 24（engines 只对后端生效）。
  $nodeSupported = ($nodeMajor -eq 20 -and $nodeMinor -ge 19) -or ($nodeMajor -eq 22 -and $nodeMinor -ge 12) -or ($nodeMajor -gt 22)
  if (-not $nodeSupported) {
    Fail-Preflight @(
      "当前 node 为 $nodeVersionText，Vite 7 要求 ^20.19.0 或 >=22.12.0。",
      '可恢复项目便携 Node（.research/runtime-cache/node-v24.21.0-win-x64），或切换到受支持的 Node 后重试。'
    )
  }
} elseif ($nodeMajor -ne 24) {
  Fail-Preflight @(
    "当前 node 为 $nodeVersionText，apps/api 的 engines 要求 >=24 <25。",
    '可恢复项目便携 Node（.research/runtime-cache/node-v24.21.0-win-x64），或切换到 Node 24 后重试。'
  )
}

$pnpmRunner = Resolve-PnpmRunner -NodePath $nodeRuntime.Path
if ($null -eq $pnpmRunner) {
  Fail-Preflight @('找不到 pnpm 或 corepack。请先执行 "corepack enable pnpm" 或安装 pnpm 9.15.9。')
}

# 纯前端模式不启动 API，也就不检查 API 端口：那个端口上可能是上一次遗留的 API 进程。
$portsToCheck = if ($FrontendOnly) { @($FrontendPort) } else { @($apiPort, $FrontendPort) }
foreach ($port in $portsToCheck) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
    Fail-Preflight @(
      "端口 $port 已被占用（PID: $owners）。",
      '脚本不静默换端口；请先停止占用进程，或修改 .env / -FrontendPort 后重试。',
      "查看占用：Get-NetTCPConnection -State Listen -LocalPort $port | Select-Object LocalAddress, OwningProcess"
    )
  }
}

$nodeOriginLabel = '项目便携 Node'
if ($nodeRuntime.Origin -eq 'path') {
  $nodeOriginLabel = 'PATH 中的 node'
}

if ($FrontendOnly) {
  Write-Host '前端预览启停（仅回环地址，-FrontendOnly）' -ForegroundColor Cyan
} else {
  Write-Host '前后端开发启停（仅回环地址）' -ForegroundColor Cyan
}

Write-Host "工作区：$workspaceRoot"
Write-Host "运行时：$nodeOriginLabel $nodeVersionText；pnpm 入口：$($pnpmRunner.Name)"
if (-not $FrontendOnly) {
  Write-Host "API：http://127.0.0.1:$apiPort（apps/api）"
}

Write-Host "前端预览：http://127.0.0.1:$FrontendPort（apps/workbench，fixture 示例数据）"

# --- 准备：依赖与构建 -------------------------------------------------------

if ($SkipInstall) {
  Write-Host '已跳过依赖安装检查（-SkipInstall）。'
} elseif ($FrontendOnly) {
  Write-Host '检查前端依赖…'
  # apps/workbench 不在根 workspace 的 packages 列表里，必须显式 --ignore-workspace 才不会解析到根 workspace
  Invoke-Pnpm -Runner $pnpmRunner -WorkingDirectory $frontendRoot -Arguments @('install', '--ignore-workspace')
} else {
  Write-Host '检查依赖（根 workspace 与前端各自一棵依赖树）…'
  Invoke-Pnpm -Runner $pnpmRunner -WorkingDirectory $workspaceRoot -Arguments @('install')
  # apps/workbench 不在根 workspace 的 packages 列表里，必须显式 --ignore-workspace 才不会解析到根 workspace
  Invoke-Pnpm -Runner $pnpmRunner -WorkingDirectory $frontendRoot -Arguments @('install', '--ignore-workspace')
}

if ($FrontendOnly) {
  Write-Host '已跳过 apps/api 构建（-FrontendOnly 不启动后端）。'
} elseif ($SkipBuild) {
  Write-Host '已跳过 apps/api 构建（-SkipBuild）。'
} else {
  Write-Host '构建 apps/api（tsc → dist/）…'
  Invoke-Pnpm -Runner $pnpmRunner -WorkingDirectory $apiRoot -Arguments @('run', 'build')
}

if (-not $FrontendOnly -and -not (Test-Path -LiteralPath $apiEntry)) {
  Fail-Preflight @("缺少构建产物：$apiEntry。请在不加 -SkipBuild 的情况下重新运行。")
}

if (-not (Test-Path -LiteralPath $frontendEntry)) {
  Fail-Preflight @("缺少前端依赖：$frontendEntry。请先在该目录安装依赖（脚本默认会执行）。")
}

# --- 启动与停止 -------------------------------------------------------------

$apiProcess = $null
$frontendProcess = $null
$finalExitCode = 0
$smokeDeadline = (Get-Date).AddSeconds([Math]::Max($SmokeSeconds, 1))

try {
  if ($FrontendOnly) {
    Write-Host '[ui] -FrontendOnly：不启动 API，只启动前端预览。'
  } else {
    $apiProcess = Start-ManagedProcess -Name 'api' -FilePath $nodeRuntime.Path `
      -Arguments @('--env-file=.env', 'dist/src/main.js') -WorkingDirectory $apiRoot
    Write-Host "[api] 已启动（PID $($apiProcess.Id)）；API 日志为 JSON 格式，按启动顺序出现在下面。"

    if (Wait-ForHttp -Url "http://127.0.0.1:$apiPort/health/live" -TimeoutSeconds 20) {
      Write-Host "[api] /health/live 可达（未鉴权）"
    } elseif ($apiProcess.HasExited) {
      Write-Host "[api] 进程已退出，退出码 $($apiProcess.ExitCode)" -ForegroundColor Red
      if ($apiProcess.ExitCode -eq $exitPreflight) {
        Write-Host '[api] 退出码 2 表示配置无效，请按上面的错误修正 apps/api/.env。' -ForegroundColor Red
      }
      $finalExitCode = $apiProcess.ExitCode
    } else {
      Write-Host '[api] 20 秒内未就绪，请查看上面的输出。' -ForegroundColor Yellow
    }
  }

  if ($finalExitCode -ne 0) {
    Write-Host '[ui] API 未启动成功，不启动前端。' -ForegroundColor Red
  } else {
    if (-not $FrontendOnly) {
      Write-ApiReadinessStatus -ApiPort $apiPort -Token $envValues['RELAY_API_BEARER_TOKEN']
    }

    $frontendProcess = Start-ManagedProcess -Name 'ui' -FilePath $nodeRuntime.Path `
      -Arguments @($frontendEntry, '--host', '127.0.0.1', '--port', "$FrontendPort", '--strictPort') `
      -WorkingDirectory $frontendRoot
    Write-Host "[ui] 已启动（PID $($frontendProcess.Id)）；Vite 日志随后出现。"

    if (Wait-ForHttp -Url "http://127.0.0.1:$FrontendPort/" -TimeoutSeconds 20) {
      Write-Host "[ui] http://127.0.0.1:$FrontendPort/ 可访问"
    } else {
      Write-Host "[ui] 20 秒内未就绪，请查看上面的输出。" -ForegroundColor Yellow
    }

    Write-Host ''
    Write-Host "蓝图预览：http://127.0.0.1:$FrontendPort/projects/project-hci?skill=blueprint"
    if (-not $FrontendOnly) {
      Write-Host "API 存活检查：http://127.0.0.1:$apiPort/health/live"
    }

    Write-Host '前端仍是示例数据，不调用 API；真实保存、执行与数据库写入尚未接入。' -ForegroundColor Yellow
    if ($FrontendOnly) {
      Write-Host '按 Ctrl+C 停止前端预览进程。'
    } else {
      Write-Host '按 Ctrl+C 停止两个进程（API 会先关闭 stdin 以正常退出）。'
    }

    Write-Host ''

    while ($true) {
      Start-Sleep -Milliseconds 300

      if ($SmokeSeconds -gt 0 -and (Get-Date) -ge $smokeDeadline) {
        Write-Host "[自检] 已到达 -SmokeSeconds $SmokeSeconds，主动停止。"
        break
      }

      if ($null -ne $apiProcess -and $apiProcess.HasExited) {
        Write-Host "[api] 进程退出，退出码 $($apiProcess.ExitCode)" -ForegroundColor Red
        $finalExitCode = $apiProcess.ExitCode
        break
      }

      if ($frontendProcess.HasExited) {
        Write-Host "[ui] 进程退出，退出码 $($frontendProcess.ExitCode)" -ForegroundColor Red
        $finalExitCode = $frontendProcess.ExitCode
        if ($finalExitCode -eq 0) {
          $finalExitCode = $exitRuntime
        }
        break
      }
    }
  }
} finally {
  Write-Host ''
  Write-Host '正在停止…'
  Stop-ManagedProcess -Process $frontendProcess -Name 'ui'
  Stop-ManagedProcess -Process $apiProcess -Name 'api' -CloseStdinFirst
  if ($FrontendOnly) {
    Write-Host '已停止前端预览进程。'
  } else {
    Write-Host '已停止前后端开发进程。'
  }
}

exit $finalExitCode
