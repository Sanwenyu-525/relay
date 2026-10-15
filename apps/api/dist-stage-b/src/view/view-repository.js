import { sql } from 'kysely';
/** Workbench owns only presentation selection, separate from Project State and Run. */
export class ViewRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insertDefault(projectId, workspaceId, kind) {
        const row = await sql `
      insert into project_view_configurations (project_id, workspace_id, kind)
      values (${projectId}, ${workspaceId}, ${kind})
      returning *`.execute(this.db);
        return row.rows[0];
    }
    async read(projectId, lock = false) {
        return (await sql `
      select * from project_view_configurations where project_id = ${projectId}
      ${lock ? sql `for no key update` : sql ``}`.execute(this.db)).rows[0];
    }
    async setKind(projectId, expectedRevision, kind) {
        return (await sql `
      update project_view_configurations set kind = ${kind}, revision = revision + 1,
        updated_at = now()
      where project_id = ${projectId} and revision = ${expectedRevision}
      returning *`.execute(this.db)).rows[0];
    }
}
