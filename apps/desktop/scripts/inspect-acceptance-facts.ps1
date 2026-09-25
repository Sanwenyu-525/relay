# Read-only cross-check of business rows created in one disposable M02 session.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($SessionRoot).TrimEnd('\')
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $root.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $root) -notlike 'relay-m02-acceptance-*') {
  throw 'Refusing to inspect a path outside a disposable M02 acceptance session'
}
$statePath = Join-Path $root 'session.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'Session marker is missing' }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if ($state.cluster_path -ne (Join-Path $root 'cluster') -or $state.data_root -ne (Join-Path $root 'data')) {
  throw 'Session paths do not match the disposable root'
}
$workspaceId = [string]$state.workspace_id
if ($workspaceId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
  throw 'Session workspace ID is missing or invalid'
}
$port = [int]$state.postgres_port
if ($port -lt 1 -or $port -gt 65535) { throw 'Session PostgreSQL port is invalid' }
$desktopRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $desktopRoot)
$psql = Join-Path $workspaceRoot '.research\runtime-cache\postgresql-18.6-2\pgsql\bin\psql.exe'
if (-not (Test-Path -LiteralPath $psql -PathType Leaf)) { throw 'Expected portable psql is missing' }

# The session owns this disposable database. No config or token is read, and no free-form SQL is accepted.
$sql = @'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT 'projects', COALESCE(json_agg(json_build_object('id', id, 'revision', revision, 'archived', archived_at IS NOT NULL) ORDER BY created_at), '[]'::json)::text
  FROM projects WHERE workspace_id = '__WORKSPACE_UUID__'::uuid;
SELECT 'tasks', COALESCE(json_agg(json_build_object('id', id, 'project_id', project_id, 'status', status, 'revision', revision,
  'acceptance_revision', acceptance_revision, 'current_completion_id', current_completion_id) ORDER BY created_at), '[]'::json)::text
  FROM tasks WHERE workspace_id = '__WORKSPACE_UUID__'::uuid;
SELECT 'task_acceptances', COALESCE(json_agg(json_build_object('task_id', a.task_id, 'acceptance_revision', a.acceptance_revision) ORDER BY a.task_id, a.acceptance_revision), '[]'::json)::text
  FROM task_acceptances a JOIN tasks t ON t.id = a.task_id WHERE t.workspace_id = '__WORKSPACE_UUID__'::uuid;
SELECT 'artifact_versions', COALESCE(json_agg(json_build_object('id', v.id, 'artifact_id', v.artifact_id, 'task_id', a.task_id,
  'version_number', v.version_number, 'size', v.size, 'content_sha256', encode(v.content_hash, 'hex')) ORDER BY a.created_at, v.version_number), '[]'::json)::text
  FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.workspace_id = '__WORKSPACE_UUID__'::uuid;
SELECT 'human_acceptances', COALESCE(json_agg(json_build_object('id', h.id, 'task_id', h.task_id,
  'acceptance_revision', h.acceptance_revision, 'accepted_version_refs', h.accepted_version_refs) ORDER BY h.created_at), '[]'::json)::text
  FROM human_acceptances h JOIN tasks t ON t.id = h.task_id WHERE t.workspace_id = '__WORKSPACE_UUID__'::uuid;
SELECT 'completion_records', COALESCE(json_agg(json_build_object('id', c.id, 'task_id', c.task_id,
  'acceptance_revision', c.acceptance_revision, 'human_acceptance_id', c.human_acceptance_id) ORDER BY c.committed_at), '[]'::json)::text
  FROM completion_records c JOIN tasks t ON t.id = c.task_id WHERE t.workspace_id = '__WORKSPACE_UUID__'::uuid;
COMMIT;
'@.Replace('__WORKSPACE_UUID__', $workspaceId)

& $psql '-X' '-w' '-A' '-t' '-F' '|' '-v' 'ON_ERROR_STOP=1' '-h' '127.0.0.1' '-p' "$port" '-U' 'relay_migrator' '-d' 'relay_m02_acceptance' '-c' $sql
if ($LASTEXITCODE -ne 0) { throw "Read-only acceptance query exited $LASTEXITCODE" }
