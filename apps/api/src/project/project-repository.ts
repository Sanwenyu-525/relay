import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  GoalRow,
  GoalStatus,
  ProjectBlockerRow,
  ProjectBlockerTargetKind,
  ProjectGoalLinkRow,
  ProjectGoalRow,
  ProjectRiskRow,
  ProjectRow,
  ProjectStateRow,
  ProjectType,
  StateArtifactRefRow,
  StateCompletionRefRow,
} from '../infrastructure/database-schema.js';
import { requireRow } from '../shared/sql-rows.js';

export interface NewProject {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly projectType: ProjectType;
}

export interface NewGoal {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly description: string;
  readonly status: GoalStatus;
}

export interface NewProjectBlocker {
  readonly id: string;
  readonly projectId: string;
  readonly targetKind: ProjectBlockerTargetKind;
  readonly targetId: string;
  readonly reason: string;
  readonly sourceRef: string;
}

export interface NewProjectRisk {
  readonly id: string;
  readonly projectId: string;
  readonly statement: string;
  readonly sourceRef: string;
  readonly confirmationRef: string;
}

/** Project State 组合视图需要的完成依据引用（联表补出所属 Task 与验收版本）。 */
export interface StateCompletionRefViewRow {
  readonly project_id: string;
  readonly completion_id: string;
  readonly source_ref: string;
  readonly task_id: string;
  readonly acceptance_revision: bigint;
  readonly committed_at: Date;
}

/** Project State 组合视图需要的所选产物版本引用（联表补出版本号）。 */
export interface StateArtifactRefViewRow {
  readonly project_id: string;
  readonly artifact_version_id: string;
  readonly source_ref: string;
  readonly artifact_id: string;
  readonly version_number: bigint;
}

export interface ProjectListRow extends ProjectRow {
  readonly phase_key: string;
  readonly next_action_task_id: string | null;
  readonly state_revision: bigint;
  readonly cursor_created_at: string;
}

/** Stable, non-sensitive reasons returned when Project archival is unsafe. */
export type ProjectArchiveBlockerReason =
  | 'TASK_ACTIVE'
  | 'RUN_UNSETTLED'
  | 'GATEWAY_UNSETTLED'
  | 'UNKNOWN_EFFECT'
  | 'RESOURCE_CLAIM_UNSETTLED'
  | 'IMPORT_IN_FLIGHT'
  | 'ASSIST_IN_FLIGHT'
  | 'MODEL_CALL_STARTED'
  | 'REVIEW_OPEN';

/**
 * Project Owner 的写入面：Project 自身、Project–Goal 关联、Project State 与类型化 State 引用、
 * blocker/risk。Task、Artifact、完成凭据的写入不在这里。
 */
export class ProjectRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  async insertProject(project: NewProject): Promise<ProjectRow> {
    const result = await sql<ProjectRow>`
      insert into projects (id, workspace_id, title, project_type)
      values (${project.id}, ${project.workspaceId}, ${project.title}, ${project.projectType})
      returning id, workspace_id, title, project_type, archived_at, revision, created_at, updated_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into projects');
  }

  async readProject(projectId: string, lock = false): Promise<ProjectRow | undefined> {
    const result = await sql<ProjectRow>`
      select id, workspace_id, title, project_type, archived_at, revision, created_at, updated_at
      from projects
      where id = ${projectId} ${lock ? sql`for share` : sql``}
    `.execute(this.db);

    return result.rows[0];
  }

  /** 归档写入栅栏：KEY SHARE 与 ArchiveProject 的 FOR UPDATE 冲突，不阻塞普通非键更新。 */
  async lockProjectArchiveGate(projectId: string): Promise<ProjectRow | undefined> {
    const result = await sql<ProjectRow>`
      select id, workspace_id, title, project_type, archived_at, revision, created_at, updated_at
      from projects where id = ${projectId} for key share
    `.execute(this.db);
    return result.rows[0];
  }

  /** Workspace 范围的确定性键集分页；ProjectState 是 CreateProject 同事务建立的事实。 */
  async listProjectsPage(input: {
    readonly workspaceId: string;
    readonly status: 'active' | 'archived' | 'all';
    readonly limit: number;
    readonly before: { readonly createdAt: string; readonly id: string } | null;
  }): Promise<readonly ProjectListRow[]> {
    const archiveFilter = input.status === 'all' ? sql``
      : input.status === 'active' ? sql`and p.archived_at is null`
        : sql`and p.archived_at is not null`;
    const cursor = input.before === null ? sql``
      : sql`and (p.created_at, p.id) < (${input.before.createdAt}::timestamptz, ${input.before.id}::uuid)`;
    const result = await sql<ProjectListRow>`
      select p.id, p.workspace_id, p.title, p.project_type, p.archived_at,
             p.revision, p.created_at, p.updated_at,
             s.phase_key, s.next_action_task_id, s.revision as state_revision,
             to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               as cursor_created_at
      from projects p
      join project_states s on s.project_id = p.id
      where p.workspace_id = ${input.workspaceId}
        ${archiveFilter}
        ${cursor}
      order by p.created_at desc, p.id desc
      limit ${input.limit + 1}
    `.execute(this.db);
    return result.rows;
  }

  async insertProjectState(projectId: string, phaseKey: string): Promise<ProjectStateRow> {
    const result = await sql<ProjectStateRow>`
      insert into project_states (project_id, phase_key)
      values (${projectId}, ${phaseKey})
      returning project_id, phase_key, next_action_task_id, revision, created_at, updated_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into project_states');
  }

  async readProjectState(projectId: string): Promise<ProjectStateRow | undefined> {
    const result = await sql<ProjectStateRow>`
      select project_id, phase_key, next_action_task_id, revision, created_at, updated_at
      from project_states
      where project_id = ${projectId}
    `.execute(this.db);

    return result.rows[0];
  }

  async insertGoal(goal: NewGoal): Promise<GoalRow> {
    const result = await sql<GoalRow>`
      insert into goals (id, workspace_id, title, description, status)
      values (${goal.id}, ${goal.workspaceId}, ${goal.title}, ${goal.description}, ${goal.status})
      returning id, workspace_id, title, description, status, revision, created_at, updated_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into goals');
  }

  async linkGoalToProject(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly goalId: string;
  }): Promise<ProjectGoalRow> {
    const result = await sql<ProjectGoalRow>`
      insert into project_goals (workspace_id, project_id, goal_id)
      values (${input.workspaceId}, ${input.projectId}, ${input.goalId})
      returning workspace_id, project_id, goal_id, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into project_goals');
  }

  async insertStateCompletionRef(input: {
    readonly projectId: string;
    readonly completionId: string;
    readonly sourceRef: string;
  }): Promise<StateCompletionRefRow> {
    const result = await sql<StateCompletionRefRow>`
      insert into state_completion_refs (project_id, completion_id, source_ref)
      values (${input.projectId}, ${input.completionId}, ${input.sourceRef})
      returning project_id, completion_id, source_ref, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into state_completion_refs');
  }

  async insertStateArtifactRef(input: {
    readonly projectId: string;
    readonly artifactVersionId: string;
    readonly sourceRef: string;
  }): Promise<StateArtifactRefRow> {
    const result = await sql<StateArtifactRefRow>`
      insert into state_artifact_refs (project_id, artifact_version_id, source_ref)
      values (${input.projectId}, ${input.artifactVersionId}, ${input.sourceRef})
      returning project_id, artifact_version_id, source_ref, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into state_artifact_refs');
  }

  async insertBlocker(blocker: NewProjectBlocker): Promise<ProjectBlockerRow> {
    const result = await sql<ProjectBlockerRow>`
      insert into project_blockers (id, project_id, target_kind, target_id, reason, source_ref)
      values (
        ${blocker.id}, ${blocker.projectId}, ${blocker.targetKind}, ${blocker.targetId},
        ${blocker.reason}, ${blocker.sourceRef}
      )
      returning id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into project_blockers');
  }

  async insertRisk(risk: NewProjectRisk): Promise<ProjectRiskRow> {
    const result = await sql<ProjectRiskRow>`
      insert into project_risks (id, project_id, statement, source_ref, confirmation_ref)
      values (
        ${risk.id}, ${risk.projectId}, ${risk.statement}, ${risk.sourceRef}, ${risk.confirmationRef}
      )
      returning id, project_id, statement, source_ref, confirmation_ref, resolved_at, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into project_risks');
  }

  /**
   * Goal 关联与 Task 显式对齐的串行化点。
   * 用 FOR NO KEY UPDATE（而不是 FOR UPDATE）：既让同类命令互斥，又不阻塞其他事务对同一 Project
   * 行加 KEY SHARE（例如创建 Task 时的复合外键检查）。
   */
  async lockProject(projectId: string): Promise<ProjectRow | undefined> {
    const result = await sql<ProjectRow>`
      select id, workspace_id, title, project_type, archived_at, revision, created_at, updated_at
      from projects
      where id = ${projectId}
      for no key update
    `.execute(this.db);

    return result.rows[0];
  }

  /** Blueprint Skill snapshot must exclude concurrent Task inserts through the Project FK. */
  async lockProjectExclusive(projectId: string): Promise<ProjectRow | undefined> {
    return (await sql<ProjectRow>`select id, workspace_id, title, project_type,
      archived_at, revision, created_at, updated_at from projects
      where id = ${projectId} for update`.execute(this.db)).rows[0];
  }

  /** Archive holds FOR UPDATE; all ordinary Project writes hold its conflicting KEY SHARE gate. */
  async listArchiveBlockers(projectId: string): Promise<readonly ProjectArchiveBlockerReason[]> {
    const result = await sql<{ reason: ProjectArchiveBlockerReason }>`
      select reason from (
      select 1 as ordinal, 'TASK_ACTIVE' as reason where exists (
        select 1 from tasks t where t.project_id = ${projectId}
          and (t.status in ('IN_PROGRESS', 'WAITING', 'BLOCKED')
            or t.executor_kind <> 'HUMAN' or t.executor_run_id is not null)
      )
      union all select 2, 'RUN_UNSETTLED' where exists (
        select 1 from runs r join tasks t on t.id = r.task_id
        where t.project_id = ${projectId}
          and r.status not in ('COMPLETED', 'FAILED', 'CANCELLED')
      ) or exists (
        select 1 from run_command_outbox o
        join run_commands c on c.id = o.command_id
        join runs r on r.id = c.run_id join tasks t on t.id = r.task_id
        where t.project_id = ${projectId} and o.status in ('PENDING', 'CLAIMED')
      ) or exists (
        select 1 from run_invocations i
        join runs r on r.id = i.run_id join tasks t on t.id = r.task_id
        where t.project_id = ${projectId} and i.status <> 'IDLE'
      ) or exists (
        select 1 from run_control_requests c
        join runs r on r.id = c.run_id join tasks t on t.id = r.task_id
        where t.project_id = ${projectId} and c.status = 'PENDING'
      ) or exists (
        select 1 from run_steps s
        join runs r on r.id = s.run_id join tasks t on t.id = r.task_id
        where t.project_id = ${projectId} and s.status = 'RUNNING'
      ) or exists (
        select 1 from step_attempts a
        join run_steps s on s.id = a.step_id
        join runs r on r.id = s.run_id join tasks t on t.id = r.task_id
        where t.project_id = ${projectId} and a.status in ('PREPARED', 'RUNNING')
      ) or exists (
        select 1 from verification_sessions v join tasks t on t.id = v.task_id
        where t.project_id = ${projectId} and v.status = 'OPEN'
      )
      union all select 3, 'GATEWAY_UNSETTLED' where exists (
        select 1 from logical_operations o where o.project_id = ${projectId}
          and o.status in ('WAITING_APPROVAL', 'PREPARED', 'DISPATCHING')
      ) or exists (
        select 1 from invocation_attempts i
        join logical_operations o on o.id = i.operation_id
        where o.project_id = ${projectId} and i.status in ('PREPARED', 'DISPATCHING')
      ) or exists (
        select 1 from run_effect_actions e
        join runs r on r.id = e.run_id join tasks t on t.id = r.task_id
        where t.project_id = ${projectId} and e.status in ('PREPARED', 'DISPATCHING')
      )
      union all select 4, 'UNKNOWN_EFFECT' where exists (
        select 1 from logical_operations o where o.project_id = ${projectId}
          and o.status = 'UNKNOWN'
      ) or exists (
        select 1 from invocation_attempts i
        join logical_operations o on o.id = i.operation_id
        where o.project_id = ${projectId} and i.status = 'UNKNOWN'
          and not (o.status = 'MANUALLY_CLOSED' and exists (
            select 1 from file_write_manual_dispositions disposition
            where disposition.operation_id = o.id and disposition.invocation_id = i.id
              and disposition.run_id = o.run_id
          ))
      ) or exists (
        select 1 from run_effect_actions e
        join runs r on r.id = e.run_id join tasks t on t.id = r.task_id
        where t.project_id = ${projectId} and e.status = 'UNKNOWN'
      )
      union all select 5, 'RESOURCE_CLAIM_UNSETTLED' where exists (
        select 1 from resource_claims c where c.project_id = ${projectId}
          and c.status in ('HELD', 'QUARANTINED')
      )
      union all select 6, 'IMPORT_IN_FLIGHT' where exists (
        select 1 from import_jobs j where j.project_id = ${projectId}
          and j.status in ('QUEUED', 'RUNNING')
      )
      union all select 7, 'ASSIST_IN_FLIGHT' where exists (
        select 1 from assist_messages m
        join assist_sessions s on s.id = m.session_id
        left join tasks t on t.id = s.task_id
        where (s.project_id = ${projectId} or t.project_id = ${projectId})
          and m.status in ('PENDING', 'RUNNING')
      )
      union all select 8, 'MODEL_CALL_STARTED' where exists (
        select 1 from model_calls m
        left join step_attempts a on a.id = m.step_attempt_id
        left join run_steps rs on rs.id = a.step_id
        left join runs r on r.id = rs.run_id
        left join tasks rt on rt.id = r.task_id
        left join assist_messages am on am.id = m.assist_message_id
        left join assist_sessions ass on ass.id = am.session_id
        left join tasks at on at.id = ass.task_id
        where m.status = 'STARTED' and
          (rt.project_id = ${projectId} or ass.project_id = ${projectId}
            or at.project_id = ${projectId})
      )
      union all select 9, 'REVIEW_OPEN' where exists (
        select 1 from review_requests v
        left join tasks t on t.id = v.task_id
        left join runs r on r.id = v.run_id
        left join tasks rt on rt.id = r.task_id
        where v.status = 'OPEN' and
          (v.project_id = ${projectId} or t.project_id = ${projectId}
            or rt.project_id = ${projectId})
      )
      ) blockers order by ordinal
    `.execute(this.db);
    return result.rows.map((row) => row.reason);
  }

  async archiveProject(projectId: string, expectedRevision: bigint): Promise<ProjectRow | undefined> {
    const result = await sql<ProjectRow>`
      update projects set archived_at = clock_timestamp(), revision = revision + 1,
        updated_at = clock_timestamp()
      where id = ${projectId} and revision = ${expectedRevision} and archived_at is null
      returning id, workspace_id, title, project_type, archived_at, revision, created_at, updated_at
    `.execute(this.db);
    return result.rows[0];
  }

  /** 关联 Goal 集合是 Project 的事实：变更时按 Project revision 做 CAS。 */
  async bumpProjectRevision(
    projectId: string,
    expectedRevision: bigint,
  ): Promise<ProjectRow | undefined> {
    const result = await sql<ProjectRow>`
      update projects
      set revision = revision + 1, updated_at = now()
      where id = ${projectId} and revision = ${expectedRevision}
      returning id, workspace_id, title, project_type, archived_at, revision, created_at, updated_at
    `.execute(this.db);

    return result.rows[0];
  }

  async readGoal(goalId: string): Promise<GoalRow | undefined> {
    const result = await sql<GoalRow>`
      select id, workspace_id, title, description, status, revision, created_at, updated_at
      from goals
      where id = ${goalId}
    `.execute(this.db);

    return result.rows[0];
  }

  async lockGoal(goalId: string): Promise<GoalRow | undefined> {
    return (await sql<GoalRow>`select id, workspace_id, title, description,
      status, revision, created_at, updated_at from goals where id = ${goalId}
      for share`.execute(this.db)).rows[0];
  }

  async listProjectGoalLinks(projectId: string): Promise<readonly ProjectGoalLinkRow[]> {
    const result = await sql<ProjectGoalLinkRow>`
      select pg.project_id, pg.goal_id, g.title as goal_title, g.status as goal_status,
             g.revision as goal_revision, pg.created_at
      from project_goals pg
      join goals g on g.id = pg.goal_id
      where pg.project_id = ${projectId}
      order by pg.goal_id
    `.execute(this.db);

    return result.rows;
  }

  async findProjectGoalLink(
    projectId: string,
    goalId: string,
  ): Promise<ProjectGoalRow | undefined> {
    const result = await sql<ProjectGoalRow>`
      select workspace_id, project_id, goal_id, created_at
      from project_goals
      where project_id = ${projectId} and goal_id = ${goalId}
    `.execute(this.db);

    return result.rows[0];
  }

  async deleteProjectGoalLink(projectId: string, goalId: string): Promise<boolean> {
    const result = await sql`
      delete from project_goals
      where project_id = ${projectId} and goal_id = ${goalId}
    `.execute(this.db);

    return Number(result.numAffectedRows ?? 0n) > 0;
  }

  /** 解除关联前的影响清单：显式对齐该 Goal 的 Task 及其当前 revision。 */
  async listExplicitGoalTasksForGoal(
    projectId: string,
    goalId: string,
  ): Promise<readonly { readonly task_id: string; readonly revision: bigint }[]> {
    const result = await sql<{ task_id: string; revision: bigint }>`
      select teg.task_id, t.revision
      from task_explicit_goals teg
      join tasks t on t.id = teg.task_id
      where teg.project_id = ${projectId} and teg.goal_id = ${goalId}
      order by teg.task_id
    `.execute(this.db);

    return result.rows;
  }

  /** Project State 行锁：所有类型化 State 命令的串行化点（统一锁序中的 ProjectState）。 */
  async lockProjectState(projectId: string): Promise<ProjectStateRow | undefined> {
    const result = await sql<ProjectStateRow>`
      select project_id, phase_key, next_action_task_id, revision, created_at, updated_at
      from project_states
      where project_id = ${projectId}
      for update
    `.execute(this.db);

    return result.rows[0];
  }

  async bumpProjectStateRevision(
    projectId: string,
    expectedRevision: bigint,
  ): Promise<ProjectStateRow | undefined> {
    const result = await sql<ProjectStateRow>`
      update project_states
      set revision = revision + 1, updated_at = now()
      where project_id = ${projectId} and revision = ${expectedRevision}
      returning project_id, phase_key, next_action_task_id, revision, created_at, updated_at
    `.execute(this.db);

    return result.rows[0];
  }

  async setProjectStatePhase(
    projectId: string,
    expectedRevision: bigint,
    phaseKey: string,
  ): Promise<ProjectStateRow | undefined> {
    const result = await sql<ProjectStateRow>`
      update project_states
      set phase_key = ${phaseKey}, revision = revision + 1, updated_at = now()
      where project_id = ${projectId} and revision = ${expectedRevision}
      returning project_id, phase_key, next_action_task_id, revision, created_at, updated_at
    `.execute(this.db);

    return result.rows[0];
  }

  async setProjectStateNextAction(
    projectId: string,
    expectedRevision: bigint,
    nextActionTaskId: string | null,
  ): Promise<ProjectStateRow | undefined> {
    const result = await sql<ProjectStateRow>`
      update project_states
      set next_action_task_id = ${nextActionTaskId}, revision = revision + 1, updated_at = now()
      where project_id = ${projectId} and revision = ${expectedRevision}
      returning project_id, phase_key, next_action_task_id, revision, created_at, updated_at
    `.execute(this.db);

    return result.rows[0];
  }

  async findProjectStateArtifactRef(
    projectId: string,
    artifactVersionId: string,
  ): Promise<StateArtifactRefRow | undefined> {
    const result = await sql<StateArtifactRefRow>`
      select project_id, artifact_version_id, source_ref, created_at
      from state_artifact_refs
      where project_id = ${projectId} and artifact_version_id = ${artifactVersionId}
    `.execute(this.db);

    return result.rows[0];
  }

  async listProjectStateArtifactRefs(
    projectId: string,
  ): Promise<readonly StateArtifactRefViewRow[]> {
    const result = await sql<StateArtifactRefViewRow>`
      select sar.project_id, sar.artifact_version_id, sar.source_ref,
             av.artifact_id, av.version_number
      from state_artifact_refs sar
      join artifact_versions av on av.id = sar.artifact_version_id
      where sar.project_id = ${projectId}
      order by sar.artifact_version_id
    `.execute(this.db);

    return result.rows;
  }

  async listProjectStateCompletionRefs(
    projectId: string,
  ): Promise<readonly StateCompletionRefViewRow[]> {
    const result = await sql<StateCompletionRefViewRow>`
      select scr.project_id, scr.completion_id, scr.source_ref,
             cr.task_id, cr.acceptance_revision, cr.committed_at
      from state_completion_refs scr
      join completion_records cr on cr.id = scr.completion_id
      join tasks t
        on t.id = cr.task_id
        and t.project_id = scr.project_id
        and t.status = 'DONE'
        and t.acceptance_revision = cr.acceptance_revision
        and t.current_completion_id = scr.completion_id
      where scr.project_id = ${projectId}
      order by scr.completion_id
    `.execute(this.db);

    return result.rows;
  }

  async listProjectBlockers(projectId: string): Promise<readonly ProjectBlockerRow[]> {
    const result = await sql<ProjectBlockerRow>`
      select id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
      from project_blockers
      where project_id = ${projectId}
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }

  /**
   * 阻止某个 Task 开始的未解除 blocker：作用在 Project 上的 blocker，或作用在该 Task 上的 blocker。
   * 依据 contracts/01-facts-and-ownership.md 第 3 节与 information-planning 第 4 节的资格过滤。
   */
  async listUnresolvedBlockersForTask(
    projectId: string,
    taskId: string,
  ): Promise<readonly ProjectBlockerRow[]> {
    const result = await sql<ProjectBlockerRow>`
      select id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
      from project_blockers
      where project_id = ${projectId}
        and resolved_at is null
        and ((target_kind = 'TASK' and target_id = ${taskId})
             or (target_kind = 'PROJECT' and target_id = ${projectId}))
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }

  /** 一次取出多个 Task 的未解除 blocker，供列表投影批量计算可执行动作。 */
  async listUnresolvedBlockersForTasks(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<readonly ProjectBlockerRow[]> {
    if (taskIds.length === 0) {
      return [];
    }

    const result = await sql<ProjectBlockerRow>`
      select id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
      from project_blockers
      where project_id = ${projectId}
        and resolved_at is null
        and ((target_kind = 'TASK' and target_id = any(${taskIds}::uuid[]))
             or (target_kind = 'PROJECT' and target_id = ${projectId}))
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }

  /** 跨项目 Task 页的 blocker：仅取页面所属项目和 Task，避免逐项目 N+1 读取。 */
  async listUnresolvedBlockersForWorkspaceTasks(
    projectIds: readonly string[], taskIds: readonly string[],
  ): Promise<readonly ProjectBlockerRow[]> {
    if (projectIds.length === 0 || taskIds.length === 0) return [];
    const result = await sql<ProjectBlockerRow>`
      select id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
      from project_blockers
      where project_id = any(${projectIds}::uuid[])
        and resolved_at is null
        and ((target_kind = 'TASK' and target_id = any(${taskIds}::uuid[]))
             or (target_kind = 'PROJECT' and target_id = project_id))
      order by created_at, id
    `.execute(this.db);
    return result.rows;
  }

  async readBlocker(blockerId: string): Promise<ProjectBlockerRow | undefined> {
    const result = await sql<ProjectBlockerRow>`
      select id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
      from project_blockers
      where id = ${blockerId}
    `.execute(this.db);

    return result.rows[0];
  }

  /** 只在未解除时写入解除时间，返回受影响行；已解除返回 undefined。 */
  async resolveBlocker(blockerId: string): Promise<ProjectBlockerRow | undefined> {
    const result = await sql<ProjectBlockerRow>`
      update project_blockers
      set resolved_at = now()
      where id = ${blockerId} and resolved_at is null
      returning id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
    `.execute(this.db);

    return result.rows[0];
  }

  async listProjectRisks(projectId: string): Promise<readonly ProjectRiskRow[]> {
    const result = await sql<ProjectRiskRow>`
      select id, project_id, statement, source_ref, confirmation_ref, resolved_at, created_at
      from project_risks
      where project_id = ${projectId}
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }
}
