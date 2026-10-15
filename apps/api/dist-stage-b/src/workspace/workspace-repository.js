import { sql } from 'kysely';
import { requireRow } from '../shared/sql-rows.js';
/**
 * Workspace 与 Workspace 级执行权威。
 * 物理设计第 4 节要求创建 Workspace 时同步建立 authority 行；两者必须在同一事务写入。
 */
export class WorkspaceRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insertWorkspace(workspace) {
        const result = await sql `
      insert into workspaces (id, name)
      values (${workspace.id}, ${workspace.name})
      returning id, name, revision, created_at, updated_at
    `.execute(this.db);
        return requireRow(result.rows, 'insert into workspaces');
    }
    async insertAuthorityRow(workspaceId) {
        const result = await sql `
      insert into workspace_execution_authority (workspace_id)
      values (${workspaceId})
      returning workspace_id, revision, rule_revision, context_revision, updated_at
    `.execute(this.db);
        return requireRow(result.rows, 'insert into workspace_execution_authority');
    }
    async readWorkspace(workspaceId) {
        const result = await sql `
      select id, name, revision, created_at, updated_at
      from workspaces
      where id = ${workspaceId}
    `.execute(this.db);
        return result.rows[0];
    }
    async readAuthority(workspaceId) {
        const result = await sql `
      select workspace_id, revision, rule_revision, context_revision, updated_at
      from workspace_execution_authority
      where workspace_id = ${workspaceId}
    `.execute(this.db);
        return result.rows[0];
    }
    /** Gateway Admit 与撤销的 Workspace 串行化点，必须先于 Task/Run 加锁。 */
    async lockAuthority(workspaceId, mode) {
        const suffix = mode === 'share' ? sql `for share` : sql `for update`;
        const result = await sql `
      select workspace_id, revision, rule_revision, context_revision, updated_at from workspace_execution_authority
      where workspace_id = ${workspaceId} ${suffix}
    `.execute(this.db);
        return result.rows[0];
    }
    async bumpAuthority(workspaceId) {
        const result = await sql `
      update workspace_execution_authority set revision = revision + 1, updated_at = now()
      where workspace_id = ${workspaceId}
      returning workspace_id, revision, rule_revision, context_revision, updated_at
    `.execute(this.db);
        return requireRow(result.rows, 'bump workspace authority');
    }
    async bumpRuleRevision(workspaceId) {
        const result = await sql `
      update workspace_execution_authority
      set rule_revision = rule_revision + 1, context_revision = context_revision + 1,
        updated_at = now()
      where workspace_id = ${workspaceId}
      returning workspace_id, revision, rule_revision, context_revision, updated_at
    `.execute(this.db);
        return requireRow(result.rows, 'bump rule revision');
    }
    async bumpContextRevision(workspaceId) {
        const result = await sql `
      update workspace_execution_authority
      set context_revision = context_revision + 1, updated_at = now()
      where workspace_id = ${workspaceId}
      returning workspace_id, revision, rule_revision, context_revision, updated_at
    `.execute(this.db);
        return requireRow(result.rows, 'bump context revision');
    }
}
