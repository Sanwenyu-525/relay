import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ProjectViewConfigurationRow } from '../infrastructure/database-schema.js';
import type { ViewKind } from './builtin-view.js';

/** Workbench owns only presentation selection, separate from Project State and Run. */
export class ViewRepository {
  constructor(private readonly db: DbExecutor) {}

  async insertDefault(projectId: string, workspaceId: string,
    kind: ViewKind): Promise<ProjectViewConfigurationRow> {
    const row = await sql<ProjectViewConfigurationRow>`
      insert into project_view_configurations (project_id, workspace_id, kind)
      values (${projectId}, ${workspaceId}, ${kind})
      returning *`.execute(this.db);
    return row.rows[0]!;
  }

  async read(projectId: string, lock = false): Promise<ProjectViewConfigurationRow | undefined> {
    return (await sql<ProjectViewConfigurationRow>`
      select * from project_view_configurations where project_id = ${projectId}
      ${lock ? sql`for no key update` : sql``}`.execute(this.db)).rows[0];
  }

  async setKind(projectId: string, expectedRevision: bigint,
    kind: ViewKind): Promise<ProjectViewConfigurationRow | undefined> {
    return (await sql<ProjectViewConfigurationRow>`
      update project_view_configurations set kind = ${kind}, revision = revision + 1,
        updated_at = now()
      where project_id = ${projectId} and revision = ${expectedRevision}
      returning *`.execute(this.db)).rows[0];
  }
}
