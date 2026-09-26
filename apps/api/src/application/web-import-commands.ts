import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { httpCommandScopeKey, LOCAL_ACTOR_REF } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { resourceNotFound, validationFailed } from './domain-error.js';
import { normalizedWebTarget } from './gateway-actions.js';
import { lockWritableProjectInWorkspace } from './guards.js';

/** 导入契约的配置版本标记；Gateway admit 用它与 origin 严格比对。 */
export const WEB_IMPORT_CONFIG_VERSION = 'web-import-v1';

export interface WebImportJobResult extends JsonObject {
  readonly import_job_id: string;
  readonly project_id: string;
  readonly connection_id: string;
  readonly status: 'QUEUED';
}

/** 用户把一个公共网页登记为导入 job：URL 随 job 冻结为规范化形式（admit 与
 * prepared operation 的 normalized_target 严格比对），边界由所选 WEB_FETCH
 * 连接冻结。抓取执行与 Knowledge 落库由 Worker 的导入 tick 驱动。 */
export async function createWebImportJob(db: DbExecutor, input: {
  workspaceId: string; projectId: string; commandId: string;
  url: string; connectionId: string;
}): Promise<CommandOutcome<WebImportJobResult>> {
  let sourceUri: string;
  try { sourceUri = normalizedWebTarget(input.url); } catch {
    throw validationFailed([{ field: 'url',
      message: 'must be an http(s) URL without userinfo or fragment' }]);
  }
  return runIdempotentCommand<WebImportJobResult>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateWebImportJob',
    target: { project_id: input.projectId },
    body: { url: sourceUri, connection_id: input.connectionId },
    execute: async (repositories) => {
      if (await repositories.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) {
        throw resourceNotFound('Workspace authority');
      }
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, input.projectId);
      const connection = await repositories.gateway.readConnection(input.connectionId);
      if (connection?.workspace_id !== input.workspaceId || connection.project_id !== input.projectId ||
          connection.status !== 'ACTIVE' ||
          !(await repositories.gateway.hasConnectionCapability(connection.id, 'WEB_FETCH'))) {
        throw resourceNotFound('Connection');
      }
      const job = await repositories.gateway.insertImportJob({ id: randomUUID(),
        workspaceId: input.workspaceId, projectId: input.projectId,
        actorRef: LOCAL_ACTOR_REF, configVersion: WEB_IMPORT_CONFIG_VERSION,
        sourceUri, commandId: input.commandId, connectionId: input.connectionId });
      return { import_job_id: job.id, project_id: input.projectId,
        connection_id: input.connectionId, status: 'QUEUED' as const };
    } });
}
