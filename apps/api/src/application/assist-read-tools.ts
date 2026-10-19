import type { AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { InternalToolName } from '../workflow/tool-catalog.js';
import { INTERNAL_TOOL_DEFINITIONS } from '../workflow/tool-catalog.js';
import { assistantToolNames } from './assistant-readonly-round.js';
import { targetMatches } from './gateway-actions.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/** Resolve exactly the read tools the current project's active connections can expose. */
export async function sessionReadToolsForCurrentConnections(db: DbExecutor,
  session: AssistSessionRow): Promise<readonly InternalToolName[]> {
  return resolveSessionReadTools(createRepositories(db), session);
}

export async function resolveSessionReadTools(repositories: Repositories,
  session: AssistSessionRow): Promise<readonly InternalToolName[]> {
  if (session.project_id === null) return [];
  const gateway = repositories.gateway;
  const resources = (await gateway.listResources())
    .filter((resource) => resource.workspace_id === session.workspace_id &&
      resource.project_id === session.project_id && resource.status === 'ACTIVE');
  if (resources.length === 0) return [];
  const resource = session.working_resource_id === null
    ? resources.length === 1 ? resources[0] : undefined
    : resources.find((candidate) => candidate.id === session.working_resource_id);
  if (resource === undefined) return [];
  const capabilities = new Set<string>();
  for (const connection of await gateway.listConnections(session.workspace_id, session.project_id)) {
    if (connection.status !== 'ACTIVE') continue;
    for (const capability of await gateway.listConnectionCapabilities(connection.id)) {
      if ((capability === 'FILE_READ' || capability === 'FILE_QUERY' || capability === 'GIT_READ') &&
          (typeof connection.config.root_path !== 'string' ||
            !targetMatches(connection.config.root_path, resource.canonical_root, capability))) continue;
      capabilities.add(capability);
    }
  }
  return assistantToolNames(INTERNAL_TOOL_DEFINITIONS
    .filter((definition) => capabilities.has(definition.capability))
    .map((definition) => definition.name));
}
