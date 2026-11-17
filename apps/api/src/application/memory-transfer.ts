import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { MemoryVersionRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { validationFailed } from './domain-error.js';
import { createMemoryRecord, type MemoryVersionInput } from './memory-write.js';
import { createRepositories } from './unit-of-work.js';

export const MEMORY_EXPORT_SCHEMA_VERSION = 2;
export const MEMORY_IMPORT_MAX_ITEMS = 200;
export const MEMORY_IMPORT_MAX_BYTES = 1_000_000;
export const MEMORY_IMPORT_MAX_VERSIONS = 50;

const MEMORY_TYPES = ['USER_PREFERENCE', 'PROJECT_FACT', 'EXPERIENCE', 'EPISODIC', 'UNKNOWN'];
const VERIFICATIONS = ['VERIFIED', 'UNVERIFIED', 'FAILED'];
const ORIGINS = ['HUMAN_CONFIRMED', 'AUTO_CAPTURE'];
const SOURCE_KINDS = ['MANUAL', 'USER_STATEMENT', 'MODEL_OBSERVATION', 'UNKNOWN'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** 人类可读、可重新导入的 JSON 导出；不携带会话 id、消息 id、凭据或内部 token。 */
export async function exportMemories(db: DbExecutor, workspaceId: string,
  projectId: string | null): Promise<JsonObject> {
  const r = createRepositories(db);
  const rows = await r.information.listMemoryExportRows(workspaceId, projectId);
  const memories: JsonObject[] = [];
  for (const row of rows) {
    const versions = await r.information.listVersions<MemoryVersionRow>('memory', row.id);
    memories.push({
      id: row.id, title: row.title, text: row.body_text,
      memory_type: row.memory_type, scope: row.scope,
      project_id: row.project_id, task_id: row.task_id, memory_key: row.memory_key,
      importance: row.importance, confidence: row.confidence,
      verification: row.verification, origin: row.origin, source_kind: row.source_kind,
      status: row.status, effective_status: row.effective_status,
      pinned: row.pinned,
      expires_at: row.expires_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
      verified_at: row.verified_at?.toISOString() ?? null,
      supersedes_id: row.supersedes_id, superseded_by_id: row.superseded_by_id,
      source_count: row.source_count,
      current_version: Number(row.current_version),
      versions: versions.slice().reverse().map((version) => ({
        version: Number(version.version), title: version.title, text: version.body_text,
        confirmed_by: version.confirmed_by,
        confirmed_at: version.confirmed_at.toISOString(),
        expires_at: version.expires_at?.toISOString() ?? null,
      })),
    });
  }
  return {
    schema_version: MEMORY_EXPORT_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    workspace_id: workspaceId,
    project_id: projectId,
    memories,
  };
}

interface ImportMemoryRow {
  readonly title: string; readonly text: string; readonly memory_type: string;
  readonly memory_key: string | null; readonly importance: number;
  readonly verification: 'VERIFIED' | 'UNVERIFIED' | 'FAILED';
  readonly project_id: string | null; readonly task_id: string | null; readonly scope?: string;
  readonly origin: 'HUMAN_CONFIRMED' | 'AUTO_CAPTURE';
  readonly source_kind: 'MANUAL' | 'USER_STATEMENT' | 'MODEL_OBSERVATION' | 'UNKNOWN';
  readonly confidence?: number;
  readonly verified_at?: Date | null;
  readonly pinned: boolean;
  readonly effective_status?: string;
  readonly versions: readonly MemoryVersionInput[];
}

function optionalDate(value: unknown, field: string): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw validationFailed([{ field, message: '必须是 ISO 时间或 null' }]);
  }
  return new Date(value);
}

function parseVersions(row: Record<string, unknown>, index: number, title: string,
  text: string): readonly MemoryVersionInput[] {
  const raw = row.versions;
  if (raw === undefined) {
    // v1 导出没有版本历史：当前正文就是唯一版本。
    return [{ version: 1, title, text, confirmedBy: 'import',
      ...(optionalDate(row.verified_at, `memories[${index}].verified_at`) === null ? {}
        : { confirmedAt: optionalDate(row.verified_at, `memories[${index}].verified_at`) }),
      expiresAt: optionalDate(row.expires_at, `memories[${index}].expires_at`) }];
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MEMORY_IMPORT_MAX_VERSIONS) {
    throw validationFailed([{ field: `memories[${index}].versions`,
      message: `版本必须是 1–${MEMORY_IMPORT_MAX_VERSIONS} 条数组` }]);
  }
  const versions: MemoryVersionInput[] = [];
  let lastVersion = 0;
  for (const [versionIndex, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw validationFailed([{ field: `memories[${index}].versions[${versionIndex}]`,
        message: '必须是对象' }]);
    }
    const version = item as Record<string, unknown>;
    if (typeof version.version !== 'number' || !Number.isInteger(version.version) ||
        version.version < 1 || version.version > 9999 || version.version <= lastVersion) {
      throw validationFailed([{ field: `memories[${index}].versions[${versionIndex}].version`,
        message: '版本号必须严格递增的正整数' }]);
    }
    lastVersion = version.version;
    const versionTitle = typeof version.title === 'string' ? version.title.trim() : '';
    const versionText = typeof version.text === 'string' ? version.text.trim() : '';
    if (versionTitle === '' || versionText === '') {
      throw validationFailed([{ field: `memories[${index}].versions[${versionIndex}]`,
        message: '版本 title/text 不能为空' }]);
    }
    const confirmedBy = typeof version.confirmed_by === 'string' && version.confirmed_by.trim() !== ''
      ? version.confirmed_by.trim().slice(0, 64) : 'import';
    versions.push({ version: version.version, title: versionTitle, text: versionText,
      confirmedBy, confirmedAt: optionalDate(version.confirmed_at,
        `memories[${index}].versions[${versionIndex}].confirmed_at`),
      expiresAt: optionalDate(version.expires_at,
        `memories[${index}].versions[${versionIndex}].expires_at`) });
  }
  // 根表标题/正文必须与最后一条版本一致，否则导入后“当前版本”会指向另一段文本。
  if (versions[versions.length - 1]!.title !== title || versions[versions.length - 1]!.text !== text) {
    throw validationFailed([{ field: `memories[${index}].versions`,
      message: '最后一条版本必须与当前 title/text 一致' }]);
  }
  return versions;
}

function parseImportRows(payload: unknown): readonly ImportMemoryRow[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw validationFailed([{ field: 'payload', message: '必须是导出对象' }]);
  }
  const object = payload as Record<string, unknown>;
  if (object.schema_version !== 1 && object.schema_version !== MEMORY_EXPORT_SCHEMA_VERSION) {
    throw validationFailed([{ field: 'schema_version', message: '不支持的导出格式版本' }]);
  }
  if (!Array.isArray(object.memories)) {
    throw validationFailed([{ field: 'memories', message: '必须是数组' }]);
  }
  if (object.memories.length > MEMORY_IMPORT_MAX_ITEMS) {
    throw validationFailed([{ field: 'memories', message: `一次最多导入 ${MEMORY_IMPORT_MAX_ITEMS} 条` }]);
  }
  const rows: ImportMemoryRow[] = [];
  for (const [index, raw] of object.memories.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw validationFailed([{ field: `memories[${index}]`, message: '必须是对象' }]);
    }
    const row = raw as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (title === '' || text === '') {
      throw validationFailed([{ field: `memories[${index}]`, message: 'title/text 不能为空' }]);
    }
    const memoryType = typeof row.memory_type === 'string' && MEMORY_TYPES.includes(row.memory_type)
      ? row.memory_type : 'UNKNOWN';
    const memoryKey = typeof row.memory_key === 'string' && row.memory_key.trim() !== ''
      ? row.memory_key.trim().toLowerCase() : null;
    const importance = typeof row.importance === 'number' && Number.isFinite(row.importance)
      ? Math.min(Math.max(Math.round(row.importance), 1), 5) : 3;
    const verification = typeof row.verification === 'string' && VERIFICATIONS.includes(row.verification)
      ? row.verification as ImportMemoryRow['verification'] : 'UNVERIFIED';
    const projectId = typeof row.project_id === 'string' ? row.project_id : null;
    const taskId = typeof row.task_id === 'string' ? row.task_id : null;
    if (projectId !== null && !UUID_PATTERN.test(projectId)) {
      throw validationFailed([{ field: `memories[${index}].project_id`, message: '必须是 UUID' }]);
    }
    if (taskId !== null && !UUID_PATTERN.test(taskId)) {
      throw validationFailed([{ field: `memories[${index}].task_id`, message: '必须是 UUID' }]);
    }
    const scope = typeof row.scope === 'string' ? row.scope : undefined;
    if (scope === 'TASK' && taskId === null) {
      throw validationFailed([{ field: `memories[${index}].task_id`, message: 'TASK 作用域必须带 task_id' }]);
    }
    if (scope !== undefined && scope !== 'TASK' && taskId !== null) {
      throw validationFailed([{ field: `memories[${index}].task_id`, message: '只有 TASK 作用域允许 task_id' }]);
    }
    if (scope === 'WORKSPACE' && projectId !== null) {
      throw validationFailed([{ field: `memories[${index}].project_id`, message: 'WORKSPACE 作用域不能带 project_id' }]);
    }
    if (scope === 'PROJECT' && projectId === null) {
      throw validationFailed([{ field: `memories[${index}].project_id`, message: 'PROJECT 作用域必须带 project_id' }]);
    }
    /*
     * 来源与可信度按导出值恢复，而不是把导入者重写成“人工确认”。
     * 旧文件缺字段时退回原行为（手工导入视为 HUMAN_CONFIRMED/MANUAL）。
     */
    const origin = typeof row.origin === 'string' && ORIGINS.includes(row.origin)
      ? row.origin as ImportMemoryRow['origin'] : 'HUMAN_CONFIRMED';
    const sourceKind = typeof row.source_kind === 'string' && SOURCE_KINDS.includes(row.source_kind)
      ? row.source_kind as ImportMemoryRow['source_kind'] : 'MANUAL';
    const confidence = typeof row.confidence === 'number' && Number.isFinite(row.confidence)
      ? Math.min(Math.max(Math.round(row.confidence), 0), 100) : undefined;
    const pinned = row.pinned === true;
    const effectiveStatus = typeof row.effective_status === 'string' ? row.effective_status : undefined;
    const verifiedAt = verification === 'VERIFIED'
      ? optionalDate(row.verified_at, `memories[${index}].verified_at`) : null;
    rows.push({ title, text, memory_type: memoryType, memory_key: memoryKey, importance,
      verification, project_id: projectId, task_id: taskId,
      ...(scope === undefined ? {} : { scope }), origin, source_kind: sourceKind,
      ...(confidence === undefined ? {} : { confidence }), verified_at: verifiedAt, pinned,
      ...(effectiveStatus === undefined ? {} : { effective_status: effectiveStatus }),
      versions: parseVersions(row, index, title, text) });
  }
  return rows;
}

export async function importMemories(db: DbExecutor, input: { workspaceId: string;
  commandId: string; expectedPayload: JsonObject; projectId: string | null }) {
  if (Buffer.byteLength(JSON.stringify(input.expectedPayload), 'utf8') > MEMORY_IMPORT_MAX_BYTES) {
    throw validationFailed([{ field: 'payload', message: '导入文件过大' }]);
  }
  const rows = parseImportRows(input.expectedPayload);
  const exportedProjectId = (input.expectedPayload as Record<string, unknown>).project_id;
  if (input.projectId === null && typeof exportedProjectId === 'string' && exportedProjectId !== '') {
    throw validationFailed([{ field: 'project_id',
      message: '导出文件属于某个项目；请在对应项目作用域导入，避免跨项目写入。' }]);
  }
  for (const [index, row] of rows.entries()) {
    if (row.project_id !== null && input.projectId !== null && row.project_id !== input.projectId) {
      throw validationFailed([{ field: `memories[${index}].project_id`,
        message: '项目记忆不能导入到另一个项目作用域。' }]);
    }
  }
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'ImportMemories',
    target: { workspace_id: input.workspaceId }, body: { payload: input.expectedPayload },
    execute: async (r) => {
      if (await r.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) {
        throw validationFailed([{ field: 'workspace_id', message: '工作区不存在' }]);
      }
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref;
      const counts = { created: 0, superseded: 0, duplicate: 0, conflict: 0,
        sensitive: 0, skipped: 0 };
      // 工作空间导出可能同时包含项目/任务记忆：恢复时回到原始作用域，而不是提升可见性。
      for (const projectId of new Set(rows.map((row) => row.project_id).filter(
        (value): value is string => value !== null))) {
        const project = await r.projects.readProject(projectId);
        if (project?.workspace_id !== input.workspaceId) {
          throw validationFailed([{ field: 'memories.project_id',
            message: '导出文件包含不属于当前工作区的项目记忆，已拒绝整次导入。' }]);
        }
      }
      for (const [index, row] of rows.entries()) {
        if (row.task_id !== null) {
          const task = await r.tasks.readTask(row.task_id);
          if (task === undefined || task.workspace_id !== input.workspaceId
              || task.project_id !== row.project_id) {
            throw validationFailed([{ field: `memories[${index}].task_id`,
              message: '任务作用域必须属于导出文件中的同一项目与当前工作区' }]);
          }
        }
      }
      for (const row of rows) {
        // 已被替代/已停用的条目不再作为活动事实回到库里；历史关系不跨工作区搬运。
        if (row.effective_status === 'SUPERSEDED' || row.effective_status === 'RETIRED') {
          counts.skipped += 1;
          continue;
        }
        const outcome = await createMemoryRecord(db, r, {
          workspaceId: input.workspaceId, projectId: row.project_id, taskId: row.task_id,
          memoryType: row.memory_type, memoryKey: row.memory_key, title: row.title, text: row.text,
          // 来源与可信度按导出恢复：导入不是“人工确认”，不能把模型观察洗成已验证事实。
          origin: row.origin, sourceKind: row.source_kind, importance: row.importance,
          verification: row.verification, force: false,
          pinned: row.pinned, versions: row.versions,
          ...(row.confidence === undefined ? {} : { confidenceOverride: row.confidence }),
          ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }),
          commandId: input.commandId, actorRef: 'import', suppressActivity: true,
        });
        switch (outcome.kind) {
          case 'CREATED': counts.created += 1; break;
          case 'SUPERSEDED': counts.superseded += 1; break;
          case 'DUPLICATE': counts.duplicate += 1; break;
          case 'CONFLICT': counts.conflict += 1; break;
          case 'REJECTED_SENSITIVE': counts.sensitive += 1; break;
          default: counts.skipped += 1;
        }
      }
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: 'import', commandId: input.commandId,
        projectId: input.projectId, taskId: null, eventType: 'MEMORY_IMPORTED',
        factRefs: counts as unknown as JsonObject });
      await r.workspaces.bumpContextRevision(input.workspaceId);
      return counts;
    } });
}

export async function purgeMemories(db: DbExecutor, input: { workspaceId: string;
  commandId: string; projectId?: string | null; memoryType?: string; origin?: string;
  memoryIds?: readonly string[]; includeActive: boolean; confirmation: string }) {
  if (input.confirmation !== 'DELETE_MEMORIES') {
    throw validationFailed([{ field: 'confirmation', message: '需要显式确认 DELETE_MEMORIES' }]);
  }
  if (input.memoryIds !== undefined && input.memoryIds.length === 0) {
    throw validationFailed([{ field: 'memory_ids', message: '至少指定一条记忆' }]);
  }
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'PurgeMemories',
    target: { workspace_id: input.workspaceId },
    body: { project_id: input.projectId ?? null, memory_type: input.memoryType ?? 'ALL',
      origin: input.origin ?? 'ALL', memory_ids: input.memoryIds ?? [],
      include_active: input.includeActive, confirmation: input.confirmation }, execute: async (r) => {
      if (await r.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) {
        throw validationFailed([{ field: 'workspace_id', message: '工作区不存在' }]);
      }
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref;
      const ids = await r.information.listMemoryIdsForPurge(input.workspaceId, {
        ...(input.projectId === undefined || input.projectId === null ? {}
          : { projectId: input.projectId }),
        ...(input.memoryType === undefined ? {} : { memoryType: input.memoryType }),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        ...(input.memoryIds === undefined ? {} : { memoryIds: input.memoryIds }),
        includeActive: input.includeActive,
      });
      const deleted = await r.information.purgeMemories(input.workspaceId, ids);
      if (deleted > 0) {
        await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
          actorKind: 'HUMAN', actorRef: 'memory-purge', commandId: input.commandId,
          projectId: input.projectId ?? null, taskId: null, eventType: 'MEMORY_PURGED',
          factRefs: { deleted: String(deleted), include_active: input.includeActive } });
        await r.workspaces.bumpContextRevision(input.workspaceId);
      }
      return { deleted: String(deleted) };
    } });
}
