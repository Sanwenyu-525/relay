import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import type { DbExecutor } from '../infrastructure/database.js';
import type { GatewayDecision, LocalDirectoryWriteTier, ManagedResourceRow, ProjectRow } from '../infrastructure/database-schema.js';
import { INITIAL_PHASE_BY_PROJECT_TYPE } from '../project/project-phase.js';
import { toDecimalString } from '../shared/decimal.js';
import { defaultViewKind } from '../view/builtin-view.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, validationFailed } from './domain-error.js';
import { canonicalResourceIdentity, registrationFileWriteRootId, rootsOverlap } from './gateway-configuration.js';
import { rankActivePolicies, targetMatches } from './gateway-actions.js';
import { ensureLocalDirectoryReadAccess } from './local-directory-access.js';
import { lockWritableProjectInWorkspace, requireWorkspace } from './guards.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/**
 * 打开文件夹（工作台 §18.1 / 领域模型 §12.2）。
 *
 * 目录是当前工作目录，不是新 Workspace。真实路径、规范身份与 Windows 写身份在事务外采集，
 * 关联判定、歧义裁决与最小 Project/受管资源建立都在一个短事务内完成；本命令不产生任何
 * 文件读取、模型调用或外发，也不隐含 ALLOW —— 写准入仍由动作准入路径按连接与权限核对。
 */

export type WorkingDirectoryStatus = 'READY' | 'AMBIGUOUS' | 'NOT_READY';

export type WorkingDirectoryReason =
  | 'MULTIPLE_PROJECTS'
  | 'PROJECT_ARCHIVED'
  | 'RESOURCE_DISABLED'
  | 'OVERLAPPING_OTHER_PROJECT';

export type WorkingDirectoryWriteReadiness =
  | 'READY'
  | 'READ_ONLY'
  | 'RESOURCE_DISABLED'
  | 'RESOURCE_IDENTITY_UNBOUND'
  | 'RESOURCE_BUSY'
  | 'NEEDS_CONNECTION'
  | 'NEEDS_PERMISSION'
  | 'PERMISSION_DENIED';

/** 用 type 别名（而非 interface）声明：命令结果必须可赋给 JsonObject。 */
export type WorkingDirectoryCandidate = {
  readonly project_id: string;
  readonly project_title: string;
  readonly project_archived: boolean;
  readonly resource_id: string;
  readonly resource_status: string;
  readonly file_write_identity_bound: boolean;
};

export type OpenWorkingDirectoryResult = {
  readonly canonical_root: string;
  readonly display_name: string;
  readonly status: WorkingDirectoryStatus;
  readonly reason: WorkingDirectoryReason | null;
  readonly association: WorkingDirectoryCandidate | null;
  readonly created_project: boolean;
  readonly created_resource: boolean;
  readonly candidates: readonly WorkingDirectoryCandidate[];
  readonly write_readiness: WorkingDirectoryWriteReadinessDetail;
};

/**
 * 写档位投影。除状态与说明外，另给出该目录上 APPLY_CHANGESET 的生效策略：
 * 排序与准入走同一个 `rankActivePolicies`，界面只展示这里给出的档位，不再自己判定。
 * `policy_id` / `policy_revision` 是调整档位所需的乐观锁坐标；没核对到策略时为 null。
 */
export type WorkingDirectoryWriteReadinessDetail = {
  readonly status: WorkingDirectoryWriteReadiness;
  readonly detail: string;
  readonly policy_decision: GatewayDecision | null;
  readonly policy_id: string | null;
  readonly policy_revision: string | null;
  /** 生效条目覆盖的目标前缀：只有它等于本目录时，界面才允许改这一条策略。 */
  readonly policy_target_prefix: string | null;
  readonly write_tier: LocalDirectoryWriteTier | null;
  readonly access_revision: string;
};

const NO_POLICY = { policy_decision: null, policy_id: null, policy_revision: null,
  policy_target_prefix: null } as const;

export interface OpenWorkingDirectoryInput {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly rootPath: string;
  /** 多项目歧义时的一次显式选择；不提供时不猜测作用域。 */
  readonly projectId?: string | null | undefined;
}

async function authorityWrite(repositories: Repositories, workspaceId: string): Promise<void> {
  if (await repositories.workspaces.lockAuthority(workspaceId, 'update') === undefined) {
    throw resourceNotFound('Workspace authority');
  }
}

function candidateOf(project: ProjectRow,
  resource: ManagedResourceRow): WorkingDirectoryCandidate {
  return { project_id: project.id, project_title: project.title,
    project_archived: project.archived_at !== null,
    resource_id: resource.id, resource_status: resource.status,
    file_write_identity_bound: resource.file_write_root_id !== null };
}

/** 只读投影：现有配置能支持到哪一步，不创建连接、不放宽权限。 */
async function writeReadiness(repositories: Repositories, workspaceId: string,
  association: WorkingDirectoryCandidate, canonicalRoot: string,
): Promise<OpenWorkingDirectoryResult['write_readiness']> {
  const access = await repositories.gateway.readLocalDirectoryAccess(association.resource_id);
  const accessFields = { write_tier: access?.write_tier ?? null,
    access_revision: toDecimalString(access?.revision ?? 0n) } as const;
  if (association.project_archived) {
    return { status: 'RESOURCE_DISABLED', detail: '项目已归档，其目录不提供执行准入。', ...NO_POLICY, ...accessFields };
  }
  if (association.resource_status !== 'ACTIVE') {
    return { status: 'RESOURCE_DISABLED', detail: '受管目录已停用，需要在受管资源中恢复后才能执行。', ...NO_POLICY, ...accessFields };
  }
  const occupied = await repositories.gateway.listOccupiedResources();
  if (occupied.some((row) => rootsOverlap(row.identity_key, canonicalRoot))) {
    return { status: 'RESOURCE_BUSY', detail: '该实际工作目录正被其他动作占用或隔离。', ...NO_POLICY, ...accessFields };
  }
  if (!association.file_write_identity_bound && access?.write_tier === 'READ_ONLY') {
    return { status: 'READ_ONLY', detail: '本目录当前为只读；该目录暂不具备文件写入身份。',
      ...NO_POLICY, ...accessFields };
  }
  if (!association.file_write_identity_bound) {
    return { status: 'RESOURCE_IDENTITY_UNBOUND',
      detail: '该目录尚未绑定 Windows 写身份，只能对话，不能写入文件。', ...NO_POLICY, ...accessFields };
  }
  const connections = await repositories.gateway.listConnections(workspaceId, association.project_id);
  const active = connections.filter((row) => row.status === 'ACTIVE');
  const writeConnections = (await Promise.all(active.map(async (row) => ({ row,
    capabilities: await repositories.gateway.listConnectionCapabilities(row.id) }))))
    .filter((entry) => entry.capabilities.includes('FILE_WRITE') &&
      typeof entry.row.config.root_path === 'string' &&
      targetMatches(entry.row.config.root_path, canonicalRoot, 'FILE_WRITE'));
  if (writeConnections.length === 0) {
    if (access?.write_tier === 'READ_ONLY') {
      return { status: 'READ_ONLY', detail: '本目录当前为只读；需要修改时，选择“请求批准”或更高的档位。',
        ...NO_POLICY, ...accessFields };
    }
    return { status: 'NEEDS_CONNECTION', detail: '本项目还没有绑定该目录的文件写入连接。', ...NO_POLICY, ...accessFields };
  }
  // 一次查询覆盖全部写入连接：策略按 项目 × 能力 × 动作 × 目标前缀 匹配，与连接无关，
  // 逐连接重复查询既没有意义，也曾让这里的档位与实际准入门核对不上。
  const policies = await repositories.gateway.listActivePolicies(workspaceId, association.project_id,
    'FILE_WRITE', 'APPLY_CHANGESET');
  const selected = rankActivePolicies(policies.filter((policy) =>
    targetMatches(policy.target_prefix, canonicalRoot, 'FILE_WRITE')));
  if (selected === undefined) {
    if (access?.write_tier === 'READ_ONLY') {
      return { status: 'READ_ONLY', detail: '本目录当前为只读；需要修改时，选择“请求批准”或更高的档位。',
        ...NO_POLICY, ...accessFields };
    }
    return { status: 'NEEDS_PERMISSION',
      detail: '还没有生效的文件写入权限条目；Gateway 会拒绝写入。请选择本目录权限档位。',
      ...NO_POLICY, ...accessFields };
  }
  const coordinate = { policy_decision: selected.decision, policy_id: selected.id,
    policy_revision: toDecimalString(selected.revision), policy_target_prefix: selected.target_prefix };
  if (selected.decision === 'DENY') {
    const managedPolicyIds = access === undefined ? [] : Object.values(access.policy_ids)
      .filter((value): value is string => typeof value === 'string');
    if (access?.write_tier === 'READ_ONLY' && managedPolicyIds.includes(selected.id)) {
      return { status: 'READ_ONLY', detail: '本目录当前为只读；需要修改时，选择“请求批准”或更高的档位。',
        ...coordinate, ...accessFields };
    }
    return { status: 'PERMISSION_DENIED',
      detail: '这个目录的文件写入权限条目为拒绝；拒绝不会被批准或范围授权覆盖。',
      ...coordinate, ...accessFields };
  }
  if (selected.decision === 'ASK') {
    return { status: 'READY',
      detail: '已具备受控文件修改的连接与权限；每次写入仍单独请求批准。', ...coordinate, ...accessFields };
  }
  // FULL 与 AUTO 在策略行上不可区分，差别只记在目录档位里，因此这里的说明必须读那一列。
  if (access?.write_tier === 'FULL') {
    return { status: 'READY',
      detail: '本目录已开放完全访问：目录内的新建、修改与删除不再逐次确认；Git、CLI 与目录外动作仍按原准入。',
      ...coordinate, ...accessFields };
  }
  return { status: 'READY',
    detail: '已具备受控文件修改的连接与自动准入权限；删除、Git 提交推送与扩大目录仍逐次确认。',
    ...coordinate, ...accessFields };
}

/**
 * 目录写档位的只读入口（工作台 §18.1）。
 *
 * 与 OpenWorkingDirectory 共用同一个投影函数：对话页显示的档位必须与实际准入门禁同源，
 * 界面不能自己排一次策略次序。本查询不建立关联、不创建连接、不放宽任何权限。
 */
export async function readWorkingDirectoryWriteReadiness(db: DbExecutor, workspaceId: string,
  projectId: string, resourceId: string): Promise<WorkingDirectoryWriteReadinessDetail> {
  const repositories = createRepositories(db);
  const resource = await repositories.gateway.readResource(resourceId);
  if (resource === undefined || resource.workspace_id !== workspaceId || resource.project_id !== projectId) {
    throw resourceNotFound('Managed resource');
  }
  const project = await repositories.projects.readProject(projectId);
  if (project === undefined || project.workspace_id !== workspaceId) throw resourceNotFound('Project');
  return writeReadiness(repositories, workspaceId, candidateOf(project, resource), resource.canonical_root);
}

export async function openWorkingDirectory(db: DbExecutor, input: OpenWorkingDirectoryInput,
): Promise<CommandOutcome<OpenWorkingDirectoryResult>> {
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  // 已提交回执必须重放，即使目录此后被移动或删除；原生核对只在首次请求时发生。
  const prior = await createRepositories(db).receipts.findReceipt({ scopeKey, commandId: input.commandId });
  let prepared: { root: string; fileWriteRootId: string | null } | undefined;
  if (prior === undefined) {
    let root: string;
    try { root = await realpath(input.rootPath); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw validationFailed([{ field: 'root_path', message: 'must be an existing directory' }]);
      }
      throw error;
    }
    if (!(await stat(root)).isDirectory()) {
      throw validationFailed([{ field: 'root_path', message: 'must be an existing directory' }]);
    }
    prepared = { root, fileWriteRootId: await registrationFileWriteRootId(root) };
  }
  return runIdempotentCommand<OpenWorkingDirectoryResult>(db, {
    scopeKey, commandId: input.commandId, commandType: 'OpenWorkingDirectory',
    target: { workspace_id: input.workspaceId },
    body: { root_path: input.rootPath, project_id: input.projectId ?? null },
    execute: async (repositories) => {
      if (prepared === undefined) throw new Error('Working directory receipt disappeared during replay');
      const { root, fileWriteRootId } = prepared;
      const key = canonicalResourceIdentity(root);
      await authorityWrite(repositories, input.workspaceId);
      await requireWorkspace(repositories, input.workspaceId);
      await repositories.gateway.lockResourceRegistry();

      const all = await repositories.gateway.listResources();
      const sameIdentity = all.filter((row) => row.workspace_id === input.workspaceId &&
        row.identity_key === key && row.status === 'ACTIVE');
      const disabled = all.filter((row) => row.workspace_id === input.workspaceId &&
        row.identity_key === key && row.status !== 'ACTIVE');
      // 嵌套根不因为不同 identity_key 而成为第二个写 Owner；重叠只如实报告，不静默改作用域。
      const overlapping = all.filter((row) => row.workspace_id === input.workspaceId &&
        row.status === 'ACTIVE' && rootsOverlap(row.canonical_root, root));

      const projectOf = async (resource: ManagedResourceRow): Promise<ProjectRow> => {
        const project = await repositories.projects.readProject(resource.project_id);
        if (project === undefined || project.workspace_id !== input.workspaceId) {
          throw resourceNotFound('Project');
        }
        return project;
      };

      const finish = async (resource: ManagedResourceRow, createdProject: boolean, createdResource: boolean,
        candidates: readonly WorkingDirectoryCandidate[], status: WorkingDirectoryStatus,
        reason: WorkingDirectoryReason | null): Promise<OpenWorkingDirectoryResult> => {
        const project = await projectOf(resource);
        const association = candidateOf(project, resource);
        if (status === 'READY' && reason === null && resource.status === 'ACTIVE' &&
            project.archived_at === null) {
          const wasConfigured = await repositories.gateway.readLocalDirectoryAccess(resource.id);
          await ensureLocalDirectoryReadAccess(repositories, { workspaceId: input.workspaceId,
            projectId: project.id, resource });
          if (createdResource || wasConfigured === undefined) {
            await repositories.workspaces.bumpAuthority(input.workspaceId);
          }
        }
        return { canonical_root: resource.canonical_root, display_name: basename(root) || root,
          status, reason, association,
          created_project: createdProject, created_resource: createdResource,
          candidates,
          write_readiness: await writeReadiness(repositories, input.workspaceId, association,
            resource.canonical_root) };
      };

      if (input.projectId !== undefined && input.projectId !== null) {
        const chosen = [...sameIdentity, ...disabled].find((row) => row.project_id === input.projectId);
        if (chosen !== undefined && chosen.status !== 'ACTIVE') {
          // 停用过的同一目录不靠重新打开获得写准入，也不换新资源 ID 绕过停用。
          return finish(chosen, false, false, [], 'NOT_READY', 'RESOURCE_DISABLED');
        }
        if (chosen !== undefined) {
          const project = await projectOf(chosen);
          if (project.archived_at !== null) {
            return finish(chosen, false, false, [], 'NOT_READY', 'PROJECT_ARCHIVED');
          }
          const siblings = overlapping.filter((row) => row.id !== chosen.id);
          return finish(chosen, false, false, siblings.length === 0 ? [] :
            await Promise.all(siblings.map(async (row) => candidateOf(await projectOf(row), row))),
          'READY', null);
        }
        // 显式选定作用域但该目录尚未登记：在选定项目内建立关联，不另开项目。
        if (input.projectId === '') throw validationFailed([{ field: 'project_id', message: 'must be a uuid' }]);
        const project = await repositories.projects.readProject(input.projectId);
        if (project === undefined || project.workspace_id !== input.workspaceId) {
          throw resourceNotFound('Project');
        }
        if (project.archived_at !== null) {
          const placeholder = all.find((row) => row.project_id === input.projectId);
          if (placeholder === undefined) throw invalidTransition('所选项目已归档。');
          return finish(placeholder, false, false, [], 'NOT_READY', 'PROJECT_ARCHIVED');
        }
      }

      if (sameIdentity.length > 1) {
        const candidates = await Promise.all(sameIdentity.map(async (row) => candidateOf(await projectOf(row), row)));
        return { canonical_root: root, display_name: basename(root) || root, status: 'AMBIGUOUS',
          reason: 'MULTIPLE_PROJECTS', association: null, created_project: false, created_resource: false,
          candidates,
          write_readiness: { status: 'NEEDS_PERMISSION',
            detail: '同一实际目录关联了多个项目；先选定作用域再继续。', ...NO_POLICY,
            write_tier: null, access_revision: '0' } };
      }
      if (sameIdentity.length === 1) {
        const existing = sameIdentity[0]!;
        const project = await projectOf(existing);
        if (project.archived_at !== null) {
          return finish(existing, false, false, [], 'NOT_READY', 'PROJECT_ARCHIVED');
        }
        const candidates = overlapping.filter((row) => row.id !== existing.id);
        return finish(existing, false, false, candidates.length === 0 ? [] :
          await Promise.all(candidates.map(async (row) => candidateOf(await projectOf(row), row))),
          'READY', null);
      }
      if (disabled.length > 0) {
        // 停用过的同一目录不靠重新打开获得写准入，也不换新资源 ID 绕过停用。
        return finish(disabled[0]!, false, false, [], 'NOT_READY', 'RESOURCE_DISABLED');
      }

      let projectId: string;
      let createdProject = false;
      if (input.projectId === undefined || input.projectId === null) {
        // 已有重叠受管根时不新开项目：那会让同一片实际目录出现第二个写 Owner。
        // 改为列出既有作用域，由用户显式选定；选定后同一项目内仍可登记子根。
        if (overlapping.length > 0) {
          const candidates = await Promise.all(overlapping.map(async (row) =>
            candidateOf(await projectOf(row), row)));
          return { canonical_root: root, display_name: basename(root) || root, status: 'NOT_READY',
            reason: 'OVERLAPPING_OTHER_PROJECT', association: candidates[0] ?? null,
            created_project: false, created_resource: false, candidates,
            write_readiness: { status: 'RESOURCE_BUSY',
              detail: '这个目录落在另一个已受管根之内或包含它；先选定作用域，不会另建第二个写 Owner。',
              ...NO_POLICY, write_tier: null, access_revision: '0' } };
        }
        const projectId0 = randomUUID();
        const project = await repositories.projects.insertProject({ id: projectId0,
          workspaceId: input.workspaceId, title: basename(root) || root, projectType: 'GENERAL' });
        await repositories.projects.insertProjectState(project.id, INITIAL_PHASE_BY_PROJECT_TYPE.GENERAL);
        await repositories.views.insertDefault(project.id, input.workspaceId, defaultViewKind('GENERAL'));
        await repositories.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
          actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
          projectId: project.id, taskId: null, eventType: 'PROJECT_CREATED',
          factRefs: { project_id: project.id, project_type: project.project_type,
            source: 'WORKING_DIRECTORY', root_path: root } });
        projectId = project.id;
        createdProject = true;
      } else {
        projectId = input.projectId;
        await lockWritableProjectInWorkspace(repositories, input.workspaceId, projectId);
      }
      const resource = await repositories.gateway.insertResource({ id: randomUUID(),
        workspaceId: input.workspaceId, projectId, canonicalRoot: root,
        identityKey: key, fileWriteRootId });
      const siblings = overlapping.filter((row) => row.project_id === projectId);
      return finish(resource, createdProject, true, siblings.length === 0 ? [] :
        await Promise.all(siblings.map(async (row) => candidateOf(await projectOf(row), row))),
      'READY', null);
    } });
}
