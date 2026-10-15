import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { ProjectReturnReviewRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * project_return_reviews 的独占写入口（0069）。
 *
 * 一个 (workspace, project, fingerprint) 一条：同一份事实与证据的重复返回复用同一行，
 * 并发首插由唯一约束裁决（输方回读胜出行），不存在「同一事实的第二条核对」。
 */
export class ProjectReturnReviewRepository {
  constructor(private readonly db: DbExecutor) {}

  async findByFingerprint(workspaceId: string, projectId: string,
    fingerprint: string): Promise<ProjectReturnReviewRow | undefined> {
    return (await sql<ProjectReturnReviewRow>`
      select * from project_return_reviews
      where workspace_id = ${workspaceId} and project_id = ${projectId}
        and fingerprint = ${fingerprint}`.execute(this.db)).rows[0];
  }

  async listByProject(workspaceId: string, projectId: string,
    limit = 20): Promise<readonly ProjectReturnReviewRow[]> {
    return (await sql<ProjectReturnReviewRow>`
      select * from project_return_reviews
      where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by created_at desc, id desc limit ${limit}`.execute(this.db)).rows;
  }

  /** 并发首插：撞唯一约束时返回 undefined，由调用方回读胜出行，不产生第二条。 */
  async insertReview(input: {
    readonly workspaceId: string; readonly projectId: string;
    readonly fingerprint: string;
    readonly status: 'APPLICABLE' | 'CHANGED';
    readonly result: JsonObject;
  }): Promise<ProjectReturnReviewRow | undefined> {
    return (await sql<ProjectReturnReviewRow>`
      insert into project_return_reviews (id, workspace_id, project_id, fingerprint,
        status, result)
      values (${randomUUID()}, ${input.workspaceId}, ${input.projectId},
        ${input.fingerprint}, ${input.status}, ${JSON.stringify(input.result)}::jsonb)
      on conflict (workspace_id, project_id, fingerprint) do nothing
      returning *`.execute(this.db)).rows[0];
  }
}
