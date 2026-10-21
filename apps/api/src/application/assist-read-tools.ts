import type { AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { InternalToolName } from '../workflow/tool-catalog.js';
import { INTERNAL_TOOL_DEFINITIONS } from '../workflow/tool-catalog.js';
import { assistantToolNames } from './assistant-readonly-round.js';
import { targetMatches } from './gateway-actions.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/**
 * 会话绑定的受管资源。
 *
 * 判定口径与执行时的 `agentSessionReadOrigin()` 一致：同工作区、同项目、ACTIVE；
 * 会话绑了目录就取那一个，没绑时不猜（只有一个候选才取，多个候选返回 undefined）。
 * 抽出来是为了让「能不能写」与「能看见哪些工具」用同一个资源，而不是各算一遍。
 */
async function sessionResource(repositories: Repositories, session: AssistSessionRow) {
  if (session.project_id === null) return undefined;
  const resources = (await repositories.gateway.listResources())
    .filter((resource) => resource.workspace_id === session.workspace_id &&
      resource.project_id === session.project_id && resource.status === 'ACTIVE');
  if (resources.length === 0) return undefined;
  return session.working_resource_id === null
    ? resources.length === 1 ? resources[0] : undefined
    : resources.find((candidate) => candidate.id === session.working_resource_id);
}

/**
 * 0126：本会话当前目录是否允许写。
 *
 * 判据是目录档位（`local_directory_access.write_tier`），不是连接能力：连接只说明
 * 「这个能力存在」，档位才说明「用户允许写」。只在 AUTO / FULL 下启用会话直写；
 * ASK 使用已有 Run 审批与恢复入口，避免生成无法在会话内接续的审批动作。
 */
export async function sessionWriteAllowed(db: DbExecutor,
  session: AssistSessionRow): Promise<boolean> {
  const repositories = createRepositories(db);
  const resource = await sessionResource(repositories, session);
  if (resource === undefined) return false;
  const access = await repositories.gateway.readLocalDirectoryAccess(resource.id);
  return access !== undefined && (access.write_tier === 'AUTO' || access.write_tier === 'FULL');
}

/** Resolve exactly the tools the current project's active connections can expose. */
export async function sessionReadToolsForCurrentConnections(db: DbExecutor,
  session: AssistSessionRow, allowWrite = false): Promise<readonly InternalToolName[]> {
  return resolveSessionReadTools(createRepositories(db), session, allowWrite);
}

export async function resolveSessionReadTools(repositories: Repositories,
  session: AssistSessionRow, allowWrite = false): Promise<readonly InternalToolName[]> {
  const resource = await sessionResource(repositories, session);
  if (resource === undefined) return [];
  const projectId = session.project_id;
  if (projectId === null) return [];
  const gateway = repositories.gateway;
  const capabilities = new Set<string>();
  for (const connection of await gateway.listConnections(session.workspace_id, projectId)) {
    if (connection.status !== 'ACTIVE') continue;
    for (const capability of await gateway.listConnectionCapabilities(connection.id)) {
      // 0126：写能力只在本轮允许写时进入候选。READ_ONLY 档位下即使连接声明了
      // FILE_WRITE 也不让模型看到写工具——否则它会一直调用、一直被拒，白烧预算。
      if (capability === 'FILE_WRITE' && !allowWrite) continue;
      if ((capability === 'FILE_READ' || capability === 'FILE_QUERY' || capability === 'GIT_READ' ||
           capability === 'FILE_WRITE') &&
          (typeof connection.config.root_path !== 'string' ||
            !targetMatches(connection.config.root_path, resource.canonical_root, capability))) continue;
      capabilities.add(capability);
    }
  }
  return assistantToolNames(INTERNAL_TOOL_DEFINITIONS
    .filter((definition) => capabilities.has(definition.capability))
    .map((definition) => definition.name), allowWrite);
}
