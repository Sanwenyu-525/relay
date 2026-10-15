import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type {
  ProjectDailyViewBaselineRow, ProjectDailyViewPresentationRow,
} from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * project_daily_view_baselines 的独占写入口（0063）。
 *
 * 每个 Project 至多一行基线（uq_daily_view_baseline_project），随「实际查看确认」单调推进；
 * presentation_id 在 Workspace 内唯一，同一展示结果只确认一次。
 * 单调判断（viewed_state_revision 只增不减）在使用侧行锁下完成，这里只提供读写原语。
 */
export class ProjectDailyViewRepository {
  constructor(private readonly db: DbExecutor) {}

  async findByProject(workspaceId: string, projectId: string,
    lock = false): Promise<ProjectDailyViewBaselineRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<ProjectDailyViewBaselineRow>`
      select * from project_daily_view_baselines
      where workspace_id = ${workspaceId} and project_id = ${projectId} ${suffix}`
      .execute(this.db)).rows[0];
  }

  /** 同一 Workspace 内 presentation_id 唯一：重复确认按原行回放，跨项目复用被拒绝。 */
  async findPresentation(workspaceId: string,
    presentationId: string): Promise<ProjectDailyViewBaselineRow | undefined> {
    return (await sql<ProjectDailyViewBaselineRow>`
      select * from project_daily_view_baselines
      where workspace_id = ${workspaceId} and presentation_id = ${presentationId}`
      .execute(this.db)).rows[0];
  }

  /**
   * 插入基线；并发首插由项目唯一约束裁决：撞线时不覆盖胜出行（do nothing），
   * 返回 undefined，由调用方重读后按单调语义判定，不产生第二行。
   */
  async insertBaseline(input: {
    readonly workspaceId: string; readonly projectId: string;
    readonly viewedStateRevision: bigint; readonly viewedFactRefs: JsonObject;
    readonly presentationId: string; readonly viewedPresentationSeq: bigint;
  }): Promise<ProjectDailyViewBaselineRow | undefined> {
    return (await sql<ProjectDailyViewBaselineRow>`
      insert into project_daily_view_baselines (id, workspace_id, project_id,
        viewed_state_revision, viewed_fact_refs, presentation_id, viewed_presentation_seq)
      values (${randomUUID()}, ${input.workspaceId}, ${input.projectId},
        ${input.viewedStateRevision}, ${JSON.stringify(input.viewedFactRefs)}::jsonb,
        ${input.presentationId}, ${input.viewedPresentationSeq})
      on conflict (workspace_id, project_id) do nothing
      returning *`.execute(this.db)).rows[0];
  }

  /** 单调推进：行锁 + 条件更新双保险，更小的 viewed_state_revision 不会被写入。 */
  async advanceBaseline(id: string, input: {
    readonly viewedStateRevision: bigint; readonly viewedFactRefs: JsonObject;
    readonly presentationId: string; readonly viewedPresentationSeq: bigint;
  }): Promise<ProjectDailyViewBaselineRow | undefined> {
    return (await sql<ProjectDailyViewBaselineRow>`
      update project_daily_view_baselines set
        viewed_state_revision = ${input.viewedStateRevision},
        viewed_fact_refs = ${JSON.stringify(input.viewedFactRefs)}::jsonb,
        presentation_id = ${input.presentationId},
        viewed_presentation_seq = ${input.viewedPresentationSeq},
        confirmed_at = now()
      where id = ${id}
        and viewed_presentation_seq < ${input.viewedPresentationSeq}
        and viewed_state_revision <= ${input.viewedStateRevision}
      returning *`.execute(this.db)).rows[0];
  }

  /**
   * 签发一次展示序号（0065）：读取时递增，顺序由服务端给出。
   * 确认只接受不超过已签发上限的序号，客户端不能自造顺序。
   */
  async issuePresentation(input: {
    readonly workspaceId: string; readonly projectId: string;
    readonly presentationId: string;
  }): Promise<bigint> {
    const result = await sql<{ issued_seq: bigint }>`
      insert into project_daily_view_presentation_counters
        (workspace_id, project_id, issued_seq, last_presentation_id)
      values (${input.workspaceId}, ${input.projectId}, 1, ${input.presentationId})
      on conflict (workspace_id, project_id) do update set
        issued_seq = project_daily_view_presentation_counters.issued_seq + 1,
        last_presentation_id = excluded.last_presentation_id,
        updated_at = now()
      returning issued_seq`.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('daily view presentation counter returned no row');
    return row.issued_seq;
  }

  /**
   * 0067（R6）：落一条真实签发的展示身份与当次事实摘要。
   * 与签发序号在同一事务内写入：确认时逐项核对，序号上限不再单独作为凭据。
   */
  async insertIssuedPresentation(input: {
    readonly workspaceId: string; readonly projectId: string;
    readonly presentationId: string; readonly issuedSeq: bigint;
    readonly stateRevision: bigint; readonly factRefs: JsonObject;
  }): Promise<ProjectDailyViewPresentationRow> {
    const result = await sql<ProjectDailyViewPresentationRow>`
      insert into project_daily_view_presentations (id, workspace_id, project_id,
        presentation_id, issued_seq, state_revision, fact_refs)
      values (${randomUUID()}, ${input.workspaceId}, ${input.projectId},
        ${input.presentationId}, ${input.issuedSeq}, ${input.stateRevision},
        ${JSON.stringify(input.factRefs)}::jsonb)
      returning *`.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('issued presentation insert returned no row');
    return row;
  }

  /** 真实签发记录：Workspace 内按 presentation_id 唯一；没有记录 = 这份身份从未展示过。 */
  async findIssuedPresentation(workspaceId: string,
    presentationId: string): Promise<ProjectDailyViewPresentationRow | undefined> {
    return (await sql<ProjectDailyViewPresentationRow>`
      select * from project_daily_view_presentations
      where workspace_id = ${workspaceId} and presentation_id = ${presentationId}`
      .execute(this.db)).rows[0];
  }

  /**
   * 0067（R6）：污染基线的可追溯恢复。只在「签发来源缺失且基线版本高于任何真实读取」
   * 这一不可能由真实展示产生的组合下允许覆盖：序号仍须严格推进，恢复留下审计。
   */
  async repairBaseline(id: string, input: {
    readonly viewedStateRevision: bigint; readonly viewedFactRefs: JsonObject;
    readonly presentationId: string; readonly viewedPresentationSeq: bigint;
  }): Promise<ProjectDailyViewBaselineRow | undefined> {
    return (await sql<ProjectDailyViewBaselineRow>`
      update project_daily_view_baselines set
        viewed_state_revision = ${input.viewedStateRevision},
        viewed_fact_refs = ${JSON.stringify(input.viewedFactRefs)}::jsonb,
        presentation_id = ${input.presentationId},
        viewed_presentation_seq = ${input.viewedPresentationSeq},
        confirmed_at = now()
      where id = ${id}
        and viewed_presentation_seq < ${input.viewedPresentationSeq}
        and viewed_state_revision > ${input.viewedStateRevision}
      returning *`.execute(this.db)).rows[0];
  }
}
