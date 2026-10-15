import { sql } from 'kysely';
import { requireRow } from '../shared/sql-rows.js';
/** tasks 的读取列必须与 TaskRow 一致；用同一片段避免各方法漏列新增字段（例如 0002 的 goal_alignment_mode、0004 的 executor_run_id）。 */
const TASK_COLUMNS = sql.raw('id, workspace_id, project_id, title, status, mode, acceptance_revision, executor_kind, ownership_epoch, executor_run_id, current_completion_id, goal_alignment_mode, priority, due_local_date::text as due_local_date, due_timezone, revision, created_at, updated_at');
/**
 * Task Owner 的写入面：Task 自身、不可变验收版本与 criteria、显式 Goal 对齐、依赖。
 * 完成凭据本体归 CompletionRepository；这里只负责 Task 侧当前指针的 CAS 更新。
 */
export class TaskRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insertTask(task) {
        const result = await sql `
      insert into tasks (
        id, workspace_id, project_id, title, status, mode,
        acceptance_revision, executor_kind, ownership_epoch, current_completion_id
      )
      values (
        ${task.id}, ${task.workspaceId}, ${task.projectId}, ${task.title}, ${task.status}, ${task.mode},
        ${task.acceptanceRevision}, ${task.executorKind}, ${task.ownershipEpoch},
        ${task.currentCompletionId}
      )
      returning ${TASK_COLUMNS}
    `.execute(this.db);
        return requireRow(result.rows, 'insert into tasks');
    }
    async readTask(taskId) {
        const result = await sql `
      select ${TASK_COLUMNS}
      from tasks
      where id = ${taskId}
    `.execute(this.db);
        return result.rows[0];
    }
    async readTaskForShare(taskId) {
        return (await sql `select ${TASK_COLUMNS} from tasks
      where id = ${taskId} for share`.execute(this.db)).rows[0];
    }
    /** Task 行锁：状态迁移、展示字段、显式 Goal 对齐与依赖都在同一行上串行化。 */
    async lockTask(taskId) {
        const result = await sql `
      select ${TASK_COLUMNS}
      from tasks
      where id = ${taskId}
      for update
    `.execute(this.db);
        return result.rows[0];
    }
    /** 展示字段只允许改 title；status/mode/执行权/验收版本不经过本方法。 */
    async updateTaskTitle(taskId, expectedRevision, title) {
        const result = await sql `
      update tasks
      set title = ${title}, revision = revision + 1, updated_at = now()
      where id = ${taskId} and revision = ${expectedRevision}
      returning ${TASK_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    async updatePlanningMetadata(input) {
        const result = await sql `
      update tasks set priority = ${input.priority},
        due_local_date = ${input.dueLocalDate}::date,
        due_timezone = ${input.dueTimezone},
        revision = revision + 1, updated_at = now()
      where id = ${input.taskId} and revision = ${input.expectedRevision}
      returning ${TASK_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    /** 状态迁移的条件更新：from 与 revision 都匹配才会写入，否则返回 undefined 由调用方裁决语义。 */
    async applyTaskStatus(input) {
        const result = await sql `
      update tasks
      set status = ${input.toStatus}, revision = revision + 1, updated_at = now()
      where id = ${input.taskId} and revision = ${input.expectedRevision}
        and status = ${input.fromStatus}
      returning ${TASK_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    /**
     * Delegate 的执行权授予：HUMAN → 指定 AI Run，并递增 ownership_epoch。
     * 条件里保留 executor_kind = 'HUMAN'，因此并发 Delegate 只有第一个能写入；
     * 第二个要么因 revision 变化失败，要么因执行者已不是 HUMAN 失败。
     */
    async assignExecutionToRun(input) {
        const result = await sql `
      update tasks
      set status = 'IN_PROGRESS',
          mode = 'DELEGATE_AI',
          executor_kind = 'AI',
          executor_run_id = ${input.runId},
          ownership_epoch = ownership_epoch + 1,
          revision = revision + 1,
          updated_at = now()
      where id = ${input.taskId}
        and revision = ${input.expectedRevision}
        and executor_kind = 'HUMAN'
        and status = 'READY'
      returning ${TASK_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    /**
     * 释放 AI 执行权（Run 进入终态时）：回到 HUMAN 并再次递增 epoch，
     * 使该 Run 的迟到结果无法再匹配当前 epoch。mode 回到 ME。
     */
    async releaseExecutionFromRun(input) {
        const result = await sql `
      update tasks
      set status = ${input.toStatus},
          mode = 'ME',
          executor_kind = 'HUMAN',
          executor_run_id = null,
          ownership_epoch = ownership_epoch + 1,
          revision = revision + 1,
          updated_at = now()
      where id = ${input.taskId}
        and revision = ${input.expectedRevision}
        and executor_run_id = ${input.runId}
      returning ${TASK_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    /**
     * 任务列表的键集分页：过滤条件（project_id 或 Inbox）与稳定排序键 (created_at DESC, id DESC)。
     * 多取一行用于判断是否还有下一页，游标由调用方编码；游标解码出的键由调用方校验后传入。
     */
    async listTasksPage(input) {
        const cursor = input.before === null
            ? sql ``
            : sql `and (created_at, id) < (${input.before.createdAt}::timestamptz, ${input.before.id}::uuid)`;
        const projectFilter = input.projectId === undefined
            ? sql ``
            : input.projectId === null
                ? sql `and project_id is null`
                : sql `and project_id = ${input.projectId}`;
        const result = await sql `
      select ${TASK_COLUMNS},
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          as cursor_created_at
      from tasks
      where workspace_id = ${input.workspaceId}
        ${projectFilter}
        ${cursor}
      order by created_at desc, id desc
      limit ${input.limit + 1}
    `.execute(this.db);
        return result.rows;
    }
    /** Today reads all current Workspace tasks before applying eligibility and ranking. */
    async listTodayTasks(workspaceId) {
        const result = await sql `
      select ${TASK_COLUMNS} from tasks
      where workspace_id = ${workspaceId}
        and status in ('INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED')
        and (project_id is null or exists (
          select 1 from projects p where p.id = project_id and p.archived_at is null))
      order by created_at, id
    `.execute(this.db);
        return result.rows;
    }
    async readAcceptanceVersion(taskId, acceptanceRevision) {
        const result = await sql `
      select task_id, acceptance_revision, objective, required_output_spec, source, created_at
      from task_acceptances
      where task_id = ${taskId} and acceptance_revision = ${acceptanceRevision}
    `.execute(this.db);
        return result.rows[0];
    }
    async listCriteria(taskId, acceptanceRevision) {
        const result = await sql `
      select task_id, acceptance_revision, criterion_id, statement, required, method, target_spec,
             created_at
      from acceptance_criteria
      where task_id = ${taskId} and acceptance_revision = ${acceptanceRevision}
      order by criterion_id
    `.execute(this.db);
        return result.rows;
    }
    async insertAcceptanceVersion(acceptance) {
        const result = await sql `
      insert into task_acceptances (
        task_id, acceptance_revision, objective, required_output_spec, source
      )
      values (
        ${acceptance.taskId}, ${acceptance.acceptanceRevision}, ${acceptance.objective},
        ${JSON.stringify(acceptance.requiredOutputSpec)}::jsonb, ${acceptance.source}
      )
      returning task_id, acceptance_revision, objective, required_output_spec, source, created_at
    `.execute(this.db);
        return requireRow(result.rows, 'insert into task_acceptances');
    }
    async listAcceptanceVersions(taskId) {
        const result = await sql `
      select task_id, acceptance_revision, objective, required_output_spec, source, created_at
      from task_acceptances
      where task_id = ${taskId}
      order by acceptance_revision
    `.execute(this.db);
        return result.rows;
    }
    async insertCriterion(criterion) {
        const result = await sql `
      insert into acceptance_criteria (
        task_id, acceptance_revision, criterion_id, statement, required, method, target_spec
      )
      values (
        ${criterion.taskId}, ${criterion.acceptanceRevision}, ${criterion.criterionId},
        ${criterion.statement}, ${criterion.required}, ${criterion.method},
        ${JSON.stringify(criterion.targetSpec)}::jsonb
      )
      returning task_id, acceptance_revision, criterion_id, statement, required, method,
                target_spec, created_at
    `.execute(this.db);
        return requireRow(result.rows, 'insert into acceptance_criteria');
    }
    async insertExplicitGoal(input) {
        const result = await sql `
      insert into task_explicit_goals (task_id, project_id, goal_id)
      values (${input.taskId}, ${input.projectId}, ${input.goalId})
      returning task_id, project_id, goal_id, created_at
    `.execute(this.db);
        return requireRow(result.rows, 'insert into task_explicit_goals');
    }
    async insertDependency(input) {
        const result = await sql `
      insert into task_dependencies (workspace_id, task_id, depends_on_task_id, dependency_kind)
      values (${input.workspaceId}, ${input.taskId}, ${input.dependsOnTaskId}, ${input.dependencyKind})
      returning workspace_id, task_id, depends_on_task_id, dependency_kind, created_at
    `.execute(this.db);
        return requireRow(result.rows, 'insert into task_dependencies');
    }
    async listExplicitGoals(taskId) {
        const result = await sql `
      select task_id, project_id, goal_id, created_at
      from task_explicit_goals
      where task_id = ${taskId}
      order by goal_id
    `.execute(this.db);
        return result.rows;
    }
    /** 显式集合是整体替换（INHERIT 时替换为空）：先清空再写入，中间状态不对外提交。 */
    async deleteExplicitGoals(taskId) {
        const result = await sql `
      delete from task_explicit_goals
      where task_id = ${taskId}
    `.execute(this.db);
        return Number(result.numAffectedRows ?? 0n);
    }
    /** 原子解除 Project–Goal 关联时的清理：只移除指定 Goal 的显式对齐行，保留其他对齐。 */
    async deleteExplicitGoal(taskId, goalId) {
        const result = await sql `
      delete from task_explicit_goals
      where task_id = ${taskId} and goal_id = ${goalId}
    `.execute(this.db);
        return Number(result.numAffectedRows ?? 0n);
    }
    /** 关联事实变化后递增 Task revision（相对自增，不做 CAS，避免与其他写入口互相覆盖）。 */
    async bumpTaskRevision(taskId) {
        const result = await sql `
      update tasks
      set revision = revision + 1, updated_at = now()
      where id = ${taskId}
      returning ${TASK_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    /** Goal 对齐模式的 CAS 更新：显式集合的行随后写入，两者在同一事务内提交。 */
    async applyGoalAlignmentMode(input) {
        const result = await sql `
      update tasks
      set goal_alignment_mode = ${input.mode}, revision = revision + 1, updated_at = now()
      where id = ${input.taskId} and revision = ${input.expectedRevision}
      returning ${TASK_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    async listDependencies(taskId) {
        const result = await sql `
      select d.task_id, d.depends_on_task_id, d.dependency_kind,
             t.status as depends_on_status, t.title as depends_on_title
      from task_dependencies d
      join tasks t on t.id = d.depends_on_task_id
      where d.task_id = ${taskId}
      order by d.depends_on_task_id
    `.execute(this.db);
        return result.rows;
    }
    /**
     * 未满足的 BLOCKS 依赖（上游不是 DONE 才算未满足；CANCELLED 不算完成，需要显式解除依赖）。
     * 批量版本供任务列表一次取回，避免逐行查询。
     */
    async listUnfinishedBlockingDependencies(taskIds) {
        if (taskIds.length === 0) {
            return [];
        }
        const result = await sql `
      select d.task_id, d.depends_on_task_id
      from task_dependencies d
      join tasks t on t.id = d.depends_on_task_id
      where d.task_id = any(${taskIds}::uuid[])
        and d.dependency_kind = 'BLOCKS'
        and t.status <> 'DONE'
      order by d.task_id, d.depends_on_task_id
    `.execute(this.db);
        return result.rows;
    }
    /**
     * 从某 Task 出发的全部依赖后继（含 INFORMS，用于环检测）。
     * 递归 CTE 在 Workspace 内展开，避免依赖环导致无限递归（UNION 去重保证终止）。
     */
    async listDependencyClosure(workspaceId, taskId) {
        const result = await sql `
      with recursive reachable as (
        select d.depends_on_task_id as task_id
        from task_dependencies d
        where d.task_id = ${taskId} and d.workspace_id = ${workspaceId}
        union
        select d.depends_on_task_id
        from task_dependencies d
        join reachable r on d.task_id = r.task_id
        where d.workspace_id = ${workspaceId}
      )
      select task_id from reachable
    `.execute(this.db);
        return result.rows.map((row) => row.task_id);
    }
    async deleteDependency(taskId, dependsOnTaskId) {
        const result = await sql `
      delete from task_dependencies
      where task_id = ${taskId} and depends_on_task_id = ${dependsOnTaskId}
    `.execute(this.db);
        return Number(result.numAffectedRows ?? 0n) > 0;
    }
    /** Project State 组合视图：项目内指定状态的 Task（派生 in_progress，不建第二份清单）。 */
    async listProjectTasksByStatus(projectId, statuses) {
        const result = await sql `
      select ${TASK_COLUMNS}
      from tasks
      where project_id = ${projectId} and status = any(${statuses}::text[])
      order by created_at, id
    `.execute(this.db);
        return result.rows;
    }
    async listTasksByIds(taskIds) {
        if (taskIds.length === 0) {
            return [];
        }
        const result = await sql `
      select ${TASK_COLUMNS}
      from tasks
      where id = any(${taskIds}::uuid[])
      order by id
    `.execute(this.db);
        return result.rows;
    }
    /** 显式 Goal 对齐的读取投影：用于 State 依赖版本与 Task 查询的有效 Goal 计算。 */
    async listExplicitGoalRefsByProject(projectId) {
        const result = await sql `
      select task_id, goal_id
      from task_explicit_goals
      where project_id = ${projectId}
      order by task_id, goal_id
    `.execute(this.db);
        return result.rows;
    }
    /** 每个 Task 当前验收版本里的必需 criterion 数量（列表投影批量判定前置条件用）。 */
    async countRequiredCriteriaForTasks(taskIds) {
        if (taskIds.length === 0) {
            return new Map();
        }
        const result = await sql `
      select ac.task_id, count(*) as required_count
      from acceptance_criteria ac
      join tasks t
        on t.id = ac.task_id and t.acceptance_revision = ac.acceptance_revision
      where ac.task_id = any(${taskIds}::uuid[]) and ac.required
      group by ac.task_id
    `.execute(this.db);
        return new Map(result.rows.map((row) => [row.task_id, Number(row.required_count)]));
    }
    /** 设置 Task 当前完成凭据并推进到 DONE（先插入 completion_records，再调用本方法）。
     * revision 不匹配时返回 undefined，由调用方按幂等/冲突语义处理，不自动重试。
     */
    async applyCompletionPointer(input) {
        const result = await sql `
      update tasks
      set status = 'DONE',
          acceptance_revision = ${input.acceptanceRevision},
          current_completion_id = ${input.completionId},
          revision = revision + 1,
          updated_at = now()
      where id = ${input.taskId} and revision = ${input.expectedRevision}
      returning ${TASK_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    /**
     * 自动完成（P06）：Task 置 DONE、写当前完成指针，并把 AI 执行权交回人工。
     *
     * 与人工完成的差别（docs/architecture/runtime-context.md 第 5 节）：释放执行权同样递增
     * ownership_epoch 使该 Run 的迟到结果无法再匹配，但**保留 mode = 'DELEGATE_AI' 供展示**，
     * 不把这次自动执行显示成人工模式。条件里带 executor_run_id = runId，旧 Run 不能替新执行者完成。
     */
    async completeFromRun(input) {
        const result = await sql `
      update tasks
      set status = 'DONE',
          acceptance_revision = ${input.acceptanceRevision},
          current_completion_id = ${input.completionId},
          executor_kind = 'HUMAN',
          executor_run_id = null,
          ownership_epoch = ownership_epoch + 1,
          revision = revision + 1,
          updated_at = now()
      where id = ${input.taskId}
        and revision = ${input.expectedRevision}
        and executor_run_id = ${input.runId}
        and status = 'IN_PROGRESS'
      returning ${TASK_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    /**
     * 重开：切到新的 acceptance_revision、回到 READY 并清空当前完成指针。
     * 历史 completion_records / human_acceptances 保留在原周期，只解除 Task 侧的当前指向
     * （ck_tasks_completion 要求非 DONE 时指针必须为空）；模式回到 ME（重开默认 ME）。
     */
    async applyReopenRevision(input) {
        const result = await sql `
      update tasks
      set status = 'READY',
          mode = 'ME',
          acceptance_revision = ${input.acceptanceRevision},
          current_completion_id = null,
          revision = revision + 1,
          updated_at = now()
      where id = ${input.taskId} and revision = ${input.expectedRevision} and status = 'DONE'
      returning ${TASK_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    /** Human-owned contract edit: status/owner/mode remain unchanged. */
    async applyContractChangeRevision(input) {
        const result = await sql `update tasks set
      acceptance_revision = ${input.nextAcceptanceRevision},
      revision = revision + 1, updated_at = now()
      where id = ${input.taskId} and revision = ${input.expectedRevision}
        and acceptance_revision = ${input.expectedAcceptanceRevision}
        and executor_kind = 'HUMAN' and executor_run_id is null
        and status in ('INBOX', 'READY', 'IN_PROGRESS')
      returning ${TASK_COLUMNS}`.execute(this.db);
        return result.rows[0];
    }
}
