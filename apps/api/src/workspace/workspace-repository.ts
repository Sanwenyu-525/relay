import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  WorkspaceExecutionAuthorityRow,
  WorkspaceRow,
} from '../infrastructure/database-schema.js';
import { requireRow } from '../shared/sql-rows.js';

export interface NewWorkspace {
  readonly id: string;
  readonly name: string;
}

/**
 * Workspace 与 Workspace 级执行权威。
 * 物理设计第 4 节要求创建 Workspace 时同步建立 authority 行；两者必须在同一事务写入。
 */
export class WorkspaceRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  async insertWorkspace(workspace: NewWorkspace): Promise<WorkspaceRow> {
    const result = await sql<WorkspaceRow>`
      insert into workspaces (id, name)
      values (${workspace.id}, ${workspace.name})
      returning id, name, revision, created_at, updated_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into workspaces');
  }

  async insertAuthorityRow(workspaceId: string): Promise<WorkspaceExecutionAuthorityRow> {
    const result = await sql<WorkspaceExecutionAuthorityRow>`
      insert into workspace_execution_authority (workspace_id)
      values (${workspaceId})
      returning workspace_id, revision, rule_revision, context_revision, updated_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into workspace_execution_authority');
  }

  async readWorkspace(workspaceId: string): Promise<WorkspaceRow | undefined> {
    const result = await sql<WorkspaceRow>`
      select id, name, revision, created_at, updated_at
      from workspaces
      where id = ${workspaceId}
    `.execute(this.db);

    return result.rows[0];
  }

  async readAuthority(workspaceId: string): Promise<WorkspaceExecutionAuthorityRow | undefined> {
    const result = await sql<WorkspaceExecutionAuthorityRow>`
      select workspace_id, revision, rule_revision, context_revision, updated_at
      from workspace_execution_authority
      where workspace_id = ${workspaceId}
    `.execute(this.db);

    return result.rows[0];
  }

  /** Gateway Admit 与撤销的 Workspace 串行化点，必须先于 Task/Run 加锁。 */
  async lockAuthority(workspaceId: string, mode: 'share' | 'update'): Promise<WorkspaceExecutionAuthorityRow | undefined> {
    const suffix = mode === 'share' ? sql`for share` : sql`for update`;
    const result = await sql<WorkspaceExecutionAuthorityRow>`
      select workspace_id, revision, rule_revision, context_revision, updated_at from workspace_execution_authority
      where workspace_id = ${workspaceId} ${suffix}
    `.execute(this.db);
    return result.rows[0];
  }

  async bumpAuthority(workspaceId: string): Promise<WorkspaceExecutionAuthorityRow> {
    const result = await sql<WorkspaceExecutionAuthorityRow>`
      update workspace_execution_authority set revision = revision + 1, updated_at = now()
      where workspace_id = ${workspaceId}
      returning workspace_id, revision, rule_revision, context_revision, updated_at
    `.execute(this.db);
    return requireRow(result.rows, 'bump workspace authority');
  }

  async bumpRuleRevision(workspaceId: string): Promise<WorkspaceExecutionAuthorityRow> {
    const result = await sql<WorkspaceExecutionAuthorityRow>`
      update workspace_execution_authority
      set rule_revision = rule_revision + 1, context_revision = context_revision + 1,
        updated_at = now()
      where workspace_id = ${workspaceId}
      returning workspace_id, revision, rule_revision, context_revision, updated_at
    `.execute(this.db);
    return requireRow(result.rows, 'bump rule revision');
  }

  async bumpContextRevision(workspaceId: string): Promise<WorkspaceExecutionAuthorityRow> {
    const result = await sql<WorkspaceExecutionAuthorityRow>`
      update workspace_execution_authority
      set context_revision = context_revision + 1, updated_at = now()
      where workspace_id = ${workspaceId}
      returning workspace_id, revision, rule_revision, context_revision, updated_at
    `.execute(this.db);
    return requireRow(result.rows, 'bump context revision');
  }
}
