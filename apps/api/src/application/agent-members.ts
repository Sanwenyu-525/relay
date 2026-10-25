import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { AgentMemberRow, AgentMemberRunMode, AgentMemberStatus } from '../team/agent-member-repository.js';

export type { AgentMemberRunMode, AgentMemberStatus } from '../team/agent-member-repository.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace, requireWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import {
  openRouterChatNotConfigured, selectionRejected,
} from './select-session-model.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';
import { computeModelConfigFingerprint, readModelPortConfig, readOpenRouterModelPortConfig } from '../workflow/model-port-config.js';
import { resolveModelSelection } from './model-selection-resolve.js';
import { toDecimalString } from '../shared/decimal.js';
import { POSTGRES_ERROR_CODES, postgresErrorCode } from '../infrastructure/postgres-error.js';
import { ConfigError } from '../config/config.js';

/**
 * 项目级长期 Agent 成员的应用 Owner（ADR-034 包 A，迁移 0139）。
 *
 * 成员是跨会话的稳定身份与配置：它不拥有 Task/Run/验收，也不给只读助手加写权限；
 * 执行权、私聊/群聊与事件唤醒由后续包接续，全部以「成员必须 ACTIVE」为闸门。
 * 角色模板是代码级目录：创建时把默认职责拷贝进成员，模板不是成员，也不自动建齐团队。
 */

export interface AgentRoleTemplate {
  readonly role_key: string;
  readonly label: string;
  readonly default_duties: string;
}

export const AGENT_ROLE_TEMPLATES: readonly AgentRoleTemplate[] = [
  { role_key: 'COORDINATION', label: '项目协调',
    default_duties: '统筹已授权范围的拆分、分派、依赖协调与状态汇总；需要人工决定时升级，不自行扩大范围、权限或修改验收条件。' },
  { role_key: 'PRODUCT', label: '产品与需求',
    default_duties: '澄清需求与验收标准，维护需求事实与优先级建议；需求变化须关联原来源，不凭群聊结论改写确认事实。' },
  { role_key: 'DESIGN', label: '设计',
    default_duties: '给出方案与取舍，产出设计产物并说明边界、风险与未决项。' },
  { role_key: 'DEVELOPMENT', label: '开发',
    default_duties: '在授权范围内实施修改、自测并记录证据；不越权改动共享事实，不绕过既有 Task/Run/Review 状态机。' },
  { role_key: 'TEST_REVIEW', label: '测试与审查',
    default_duties: '独立检查产物与验收条件，报告问题与证据；不代答人工验收，不自动产生通过结论。' },
];

const ROLE_KEYS = new Set(AGENT_ROLE_TEMPLATES.map((template) => template.role_key));

type Scope = { readonly workspaceId: string; readonly commandId: string };

async function authority(r: Repositories, workspaceId: string): Promise<void> {
  if (await r.workspaces.lockAuthority(workspaceId, 'share') === undefined) throw resourceNotFound('Workspace');
}

function audit(r: Repositories, scope: Scope, row: { project_id: string }, event: string, factRefs: JsonObject) {
  return r.activities.insertActivityRecord({
    id: randomUUID(), workspaceId: scope.workspaceId, projectId: row.project_id, taskId: null,
    actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: scope.commandId, eventType: event, factRefs,
  });
}

function requireText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw validationFailed([{ field, message: `需要 ${min}–${max} 字。` }]);
  }
  return value.trim();
}

export interface AgentMemberModelSelectionInput {
  readonly mode: 'INHERIT' | 'EXPLICIT';
  readonly model?: string;
}

/**
 * EXPLICIT 模型选择在配置时按会话模型选择同一口径解析并留指纹：
 * 目录外/收费型号类型化拒绝，绝不静默换型号；INHERIT 不在此解析——
 * 实际解析发生在执行时，届时不可用如实报告（PT-08）。
 */
async function normalizeModelSelection(r: Repositories, input: AgentMemberModelSelectionInput | undefined): Promise<JsonObject> {
  if (input === undefined || input.mode === 'INHERIT') return { mode: 'INHERIT' };
  const requested = requireText(input.model, 'model_selection.model', 1, 200);
  const portConfig = readModelPortConfig(process.env);
  const sync = await r.modelCatalog.readSyncState();
  const entries = await r.modelCatalog.readEntries(false);
  const resolved = resolveModelSelection({
    requested,
    ...(portConfig === undefined ? {} : { defaultModel: portConfig.model }),
    catalog: {
      snapshotSeq: toDecimalString(sync.snapshot_seq),
      models: entries.map((entry) => ({ source_model_id: entry.source_model_id, is_free: entry.is_free })),
    },
  });
  if (!resolved.ok) throw selectionRejected(resolved.rejection);
  let fingerprint: string;
  try {
    const config = resolved.selection.connection === 'openrouter'
      ? readOpenRouterModelPortConfig(process.env, resolved.selection.model) : portConfig;
    if (config === undefined) throw selectionRejected({ code: 'MODEL_NOT_REGISTERED', detail: `“${requested}”不可选：本实例未配置默认可执行模型连接。` });
    fingerprint = computeModelConfigFingerprint(config);
  } catch (error) {
    if (resolved.selection.connection === 'openrouter' && error instanceof ConfigError) throw openRouterChatNotConfigured();
    throw error;
  }
  return {
    mode: 'EXPLICIT', model: resolved.selection.model, connection: resolved.selection.connection,
    free_only: resolved.selection.freeOnly, config_fingerprint: fingerprint,
  };
}

/** 外部运行方式目前只保存展示性标签；可信绑定随 ADR-033 领取协议落地，本列不构成授权。 */
function normalizeExternalBinding(runMode: AgentMemberRunMode, value: unknown): JsonObject {
  if (runMode === 'BUILTIN') {
    if (value !== undefined && value !== null && (typeof value !== 'object' || Object.keys(value).length > 0)) {
      throw validationFailed([{ field: 'external_binding', message: '内置成员不保存外部绑定。' }]);
    }
    return {};
  }
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validationFailed([{ field: 'external_binding', message: '外部绑定需要对象。' }]);
  }
  const label = (value as { principal_label?: unknown }).principal_label;
  if (label === undefined) return {};
  return { principal_label: requireText(label, 'external_binding.principal_label', 1, 200) };
}

function requireRunMode(value: unknown): AgentMemberRunMode {
  if (value !== 'BUILTIN' && value !== 'EXTERNAL') {
    throw validationFailed([{ field: 'run_mode', message: '运行方式需要 BUILTIN 或 EXTERNAL。' }]);
  }
  return value;
}

const memberView = (row: AgentMemberRow, coordinatorMemberId: string | null) => ({
  agent_member_id: row.id, project_id: row.project_id, name: row.name, role_key: row.role_key,
  duties: row.duties, status: row.status, run_mode: row.run_mode,
  model_selection: row.model_selection, external_binding: row.external_binding,
  is_coordinator: coordinatorMemberId === row.id,
  revision: row.revision.toString(),
  created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
});

export interface CreateAgentMemberInput {
  readonly projectId: string;
  readonly name: string;
  readonly roleKey: string;
  readonly duties: string | undefined;
  readonly runMode: AgentMemberRunMode;
  readonly modelSelection: AgentMemberModelSelectionInput | undefined;
  readonly externalBinding: unknown;
}

export async function createAgentMember(db: DbExecutor, input: Scope & CreateAgentMemberInput) {
  const name = requireText(input.name, 'name', 1, 100);
  const template = AGENT_ROLE_TEMPLATES.find((candidate) => candidate.role_key === input.roleKey);
  if (template === undefined) {
    throw validationFailed([{ field: 'role_key', message: `角色需要是 ${[...ROLE_KEYS].join(' / ')} 之一。` }]);
  }
  const runMode = requireRunMode(input.runMode);
  const externalBinding = normalizeExternalBinding(runMode, input.externalBinding);
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'CreateAgentMember',
    target: { project_id: input.projectId },
    body: {
      name, role_key: template.role_key, run_mode: runMode,
      duties: input.duties === undefined ? template.default_duties : requireText(input.duties, 'duties', 1, 2000),
      model_selection: input.modelSelection === undefined ? { mode: 'INHERIT' }
        : { mode: input.modelSelection.mode, ...(input.modelSelection.model === undefined ? {} : { model: input.modelSelection.model }) },
      external_binding: externalBinding,
    },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      await lockWritableProjectInWorkspace(r, input.workspaceId, input.projectId);
      const modelSelection = await normalizeModelSelection(r, input.modelSelection);
      let row: AgentMemberRow;
      try {
        row = await r.agentMembers.insert({
          id: randomUUID(), workspace_id: input.workspaceId, project_id: input.projectId,
          name, role_key: template.role_key,
          duties: input.duties === undefined ? template.default_duties : requireText(input.duties, 'duties', 1, 2000),
          run_mode: runMode, model_selection: modelSelection, external_binding: externalBinding,
        });
      } catch (error) {
        if (postgresErrorCode(error) === POSTGRES_ERROR_CODES.uniqueViolation) {
          throw validationFailed([{ field: 'name', message: '同一项目内已有同名成员。' }]);
        }
        throw error;
      }
      await audit(r, input, row, 'AGENT_MEMBER_CREATED', { agent_member_id: row.id, role_key: row.role_key, run_mode: row.run_mode });
      return memberView(row, null);
    },
  });
}

export interface EditAgentMemberInput {
  readonly agentMemberId: string;
  readonly expectedRevision: string;
  readonly name: string;
  readonly duties: string;
  readonly runMode: AgentMemberRunMode;
  readonly modelSelection: AgentMemberModelSelectionInput | undefined;
  readonly externalBinding: unknown;
  readonly reason: string;
}

export async function editAgentMember(db: DbExecutor, input: Scope & EditAgentMemberInput) {
  const name = requireText(input.name, 'name', 1, 100);
  const duties = requireText(input.duties, 'duties', 1, 2000);
  const runMode = requireRunMode(input.runMode);
  const externalBinding = normalizeExternalBinding(runMode, input.externalBinding);
  const reason = requireText(input.reason, 'reason', 1, 4000);
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'EditAgentMember',
    target: { agent_member_id: input.agentMemberId },
    body: {
      expected_revision: input.expectedRevision, name, duties, run_mode: runMode, reason,
      ...(input.modelSelection === undefined ? {}
        : { model_selection: { mode: input.modelSelection.mode, ...(input.modelSelection.model === undefined ? {} : { model: input.modelSelection.model }) } }),
      ...(Object.keys(externalBinding).length === 0 ? {} : { external_binding: externalBinding }),
    },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const row = await r.agentMembers.read(input.agentMemberId, true);
      if (row?.workspace_id !== input.workspaceId) throw resourceNotFound('AgentMember');
      await lockWritableProjectInWorkspace(r, input.workspaceId, row.project_id);
      if (row.revision !== requireRevision(input.expectedRevision, 'expected_revision')) {
        throw revisionConflict({ entityType: 'AGENT_MEMBER', expectedRevision: input.expectedRevision, actualRevision: row.revision.toString() });
      }
      if (row.status === 'ARCHIVED') throw invalidTransition('已归档成员是留档记录，不能再修改。');
      const modelSelection = input.modelSelection === undefined
        ? row.model_selection : await normalizeModelSelection(r, input.modelSelection);
      let updated: AgentMemberRow;
      try {
        updated = await r.agentMembers.update(row.id, { name, duties, run_mode: runMode, model_selection: modelSelection, external_binding: externalBinding });
      } catch (error) {
        if (postgresErrorCode(error) === POSTGRES_ERROR_CODES.uniqueViolation) {
          throw validationFailed([{ field: 'name', message: '同一项目内已有同名成员。' }]);
        }
        throw error;
      }
      const coordinator = await r.agentMembers.readCoordinator(row.project_id);
      await audit(r, input, updated, 'AGENT_MEMBER_EDITED', { agent_member_id: updated.id, reason });
      return memberView(updated, coordinator?.member_id ?? null);
    },
  });
}

export interface SetAgentMemberStatusInput {
  readonly agentMemberId: string;
  readonly expectedRevision: string;
  readonly status: AgentMemberStatus;
  readonly reason: string;
}

const ALLOWED_STATUS_TRANSITIONS: Record<AgentMemberStatus, readonly AgentMemberStatus[]> = {
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

export async function setAgentMemberStatus(db: DbExecutor, input: Scope & SetAgentMemberStatusInput) {
  const reason = requireText(input.reason, 'reason', 1, 4000);
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'SetAgentMemberStatus',
    target: { agent_member_id: input.agentMemberId },
    body: { expected_revision: input.expectedRevision, status: input.status, reason },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const row = await r.agentMembers.read(input.agentMemberId, true);
      if (row?.workspace_id !== input.workspaceId) throw resourceNotFound('AgentMember');
      await lockWritableProjectInWorkspace(r, input.workspaceId, row.project_id);
      if (row.revision !== requireRevision(input.expectedRevision, 'expected_revision')) {
        throw revisionConflict({ entityType: 'AGENT_MEMBER', expectedRevision: input.expectedRevision, actualRevision: row.revision.toString() });
      }
      if (row.status === input.status) throw invalidTransition('状态没有变化，请读回当前结果。');
      if (!ALLOWED_STATUS_TRANSITIONS[row.status].includes(input.status)) {
        throw invalidTransition(`成员状态不能从 ${row.status} 改为 ${input.status}。`);
      }
      const updated = await r.agentMembers.setStatus(row.id, input.status);
      await audit(r, input, updated, 'AGENT_MEMBER_STATUS_CHANGED', { agent_member_id: updated.id, status: updated.status, reason });
      const coordinator = await r.agentMembers.readCoordinator(row.project_id);
      return memberView(updated, coordinator?.member_id ?? null);
    },
  });
}

export interface AssignProjectCoordinatorInput {
  readonly projectId: string;
  readonly memberId: string;
  /** 首次指派传 null；更换时须带当前协调者行的 revision，防止并发互换覆盖。 */
  readonly expectedCoordinatorRevision: string | null;
  readonly reason: string;
}

export async function assignProjectCoordinator(db: DbExecutor, input: Scope & AssignProjectCoordinatorInput) {
  const reason = requireText(input.reason, 'reason', 1, 4000);
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'AssignProjectCoordinator',
    target: { project_id: input.projectId, member_id: input.memberId },
    body: {
      member_id: input.memberId, reason,
      ...(input.expectedCoordinatorRevision === null ? {} : { expected_coordinator_revision: input.expectedCoordinatorRevision }),
    },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      await lockWritableProjectInWorkspace(r, input.workspaceId, input.projectId);
      const member = await r.agentMembers.read(input.memberId, true);
      if (member?.workspace_id !== input.workspaceId || member.project_id !== input.projectId) {
        throw resourceNotFound('AgentMember');
      }
      if (member.status !== 'ACTIVE') throw invalidTransition('只有启用中的成员可以担任项目协调者。');

      const current = await r.agentMembers.readCoordinator(input.projectId, true);
      if (current !== undefined && current.member_id === member.id) {
        throw invalidTransition('该成员已经是项目协调者。');
      }
      if (current !== undefined) {
        if (input.expectedCoordinatorRevision === null
          || current.revision !== requireRevision(input.expectedCoordinatorRevision, 'expected_coordinator_revision')) {
          throw revisionConflict({
            entityType: 'PROJECT_COORDINATOR', expectedRevision: input.expectedCoordinatorRevision ?? '0',
            actualRevision: current.revision.toString(),
          });
        }
      } else if (input.expectedCoordinatorRevision !== null) {
        throw revisionConflict({ entityType: 'PROJECT_COORDINATOR', expectedRevision: input.expectedCoordinatorRevision, actualRevision: '0' });
      }

      const assigned = await r.agentMembers.assignCoordinator(input.projectId, input.workspaceId, member.id, input.commandId);
      await audit(r, input, member, 'PROJECT_COORDINATOR_ASSIGNED',
        { project_id: input.projectId, agent_member_id: member.id, revision: assigned.revision.toString(), reason });
      return {
        project_id: input.projectId, agent_member_id: member.id, member_revision: member.revision.toString(),
        revision: assigned.revision.toString(),
      };
    },
  });
}

export async function listAgentMembers(db: DbExecutor, workspaceId: string, projectId: string) {
  return withTransaction(db, async (r) => {
    await requireWorkspace(r, workspaceId);
    await readProjectInWorkspace(r, workspaceId, projectId);
    const coordinator = await r.agentMembers.readCoordinator(projectId);
    return {
      project_id: projectId,
      coordinator_member_id: coordinator?.member_id ?? null,
      coordinator_revision: coordinator === undefined ? null : coordinator.revision.toString(),
      items: (await r.agentMembers.list(workspaceId, projectId)).map((row) => memberView(row, coordinator?.member_id ?? null)),
    };
  });
}

export async function readAgentMember(db: DbExecutor, workspaceId: string, id: string) {
  return withTransaction(db, async (r) => {
    const row = await r.agentMembers.read(id);
    if (row?.workspace_id !== workspaceId) throw resourceNotFound('AgentMember');
    const project = await readProjectInWorkspace(r, workspaceId, row.project_id);
    const coordinator = await r.agentMembers.readCoordinator(row.project_id);
    return {
      ...memberView(row, coordinator?.member_id ?? null),
      project: { title: project.title, revision: project.revision.toString(), archived: project.archived_at !== null },
      coordinator_revision: coordinator === undefined ? null : coordinator.revision.toString(),
    };
  });
}
