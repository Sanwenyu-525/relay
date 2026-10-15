import { sql } from 'kysely';
/** 接续点只保存身份、说明与捕获时的确切版本引用；当前事实一律现查，不在这里维护第二套状态。 */
export class ContinuationPointRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insert(point) {
        const result = await sql `
      insert into project_continuation_points (id, workspace_id, project_id, name, note,
        state_phase_key, state_revision, next_action_task_id)
      values (${point.id}, ${point.workspaceId}, ${point.projectId}, ${point.name}, ${point.note},
        ${point.statePhaseKey}, ${point.stateRevision}, ${point.nextActionTaskId})
      returning *`.execute(this.db);
        return result.rows[0];
    }
    async insertRef(ref) {
        const taskId = ref.refKind === 'TASK' ? ref.refId : null;
        const artifactVersionId = ref.refKind === 'ARTIFACT_VERSION' ? ref.refId : null;
        await sql `
      insert into project_continuation_point_refs (continuation_point_id, ref_kind, ref_id,
        ref_revision, ordinal, task_id, artifact_version_id)
      values (${ref.continuationPointId}, ${ref.refKind}, ${ref.refId}, ${ref.refRevision},
        ${ref.ordinal}, ${taskId}, ${artifactVersionId})`.execute(this.db);
    }
    async read(id) {
        return (await sql `
      select * from project_continuation_points where id = ${id}`.execute(this.db)).rows[0];
    }
    async listByProject(workspaceId, projectId, limit) {
        const result = await sql `
      select * from project_continuation_points
      where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by captured_at desc, id desc
      limit ${limit}`.execute(this.db);
        return result.rows;
    }
    async listRefs(continuationPointId) {
        const result = await sql `
      select * from project_continuation_point_refs
      where continuation_point_id = ${continuationPointId}
      order by ordinal, ref_kind, ref_id`.execute(this.db);
        return result.rows;
    }
}
