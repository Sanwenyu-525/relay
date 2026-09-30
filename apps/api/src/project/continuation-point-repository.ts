import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  ProjectContinuationPointRefRow,
  ProjectContinuationPointRow,
} from '../infrastructure/database-schema.js';

/** 接续点只保存身份、说明与捕获时的确切版本引用；当前事实一律现查，不在这里维护第二套状态。 */
export class ContinuationPointRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(point: {
    readonly id: string;
    readonly workspaceId: string;
    readonly projectId: string;
    readonly name: string;
    readonly note: string | null;
    readonly statePhaseKey: string;
    readonly stateRevision: bigint;
    readonly nextActionTaskId: string | null;
  }): Promise<ProjectContinuationPointRow> {
    const result = await sql<ProjectContinuationPointRow>`
      insert into project_continuation_points (id, workspace_id, project_id, name, note,
        state_phase_key, state_revision, next_action_task_id)
      values (${point.id}, ${point.workspaceId}, ${point.projectId}, ${point.name}, ${point.note},
        ${point.statePhaseKey}, ${point.stateRevision}, ${point.nextActionTaskId})
      returning *`.execute(this.db);
    return result.rows[0]!;
  }

  async insertRef(ref: {
    readonly continuationPointId: string;
    readonly refKind: 'TASK' | 'ARTIFACT_VERSION';
    readonly refId: string;
    readonly refRevision: bigint;
    readonly ordinal: number;
  }): Promise<void> {
    const taskId = ref.refKind === 'TASK' ? ref.refId : null;
    const artifactVersionId = ref.refKind === 'ARTIFACT_VERSION' ? ref.refId : null;
    await sql`
      insert into project_continuation_point_refs (continuation_point_id, ref_kind, ref_id,
        ref_revision, ordinal, task_id, artifact_version_id)
      values (${ref.continuationPointId}, ${ref.refKind}, ${ref.refId}, ${ref.refRevision},
        ${ref.ordinal}, ${taskId}, ${artifactVersionId})`.execute(this.db);
  }

  async read(id: string): Promise<ProjectContinuationPointRow | undefined> {
    return (await sql<ProjectContinuationPointRow>`
      select * from project_continuation_points where id = ${id}`.execute(this.db)).rows[0];
  }

  async listByProject(workspaceId: string, projectId: string,
    limit: number): Promise<readonly ProjectContinuationPointRow[]> {
    const result = await sql<ProjectContinuationPointRow>`
      select * from project_continuation_points
      where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by captured_at desc, id desc
      limit ${limit}`.execute(this.db);
    return result.rows;
  }

  async listRefs(continuationPointId: string):
  Promise<readonly ProjectContinuationPointRefRow[]> {
    const result = await sql<ProjectContinuationPointRefRow>`
      select * from project_continuation_point_refs
      where continuation_point_id = ${continuationPointId}
      order by ordinal, ref_kind, ref_id`.execute(this.db);
    return result.rows;
  }
}
