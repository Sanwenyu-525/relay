import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ProjectDailyViewBaselineRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { FieldError } from '../shared/field-error.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { resourceNotFound, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';

/**
 * 日常查看基线（总纲 §0.8.1 / 工作台 §18.9 / 领域模型 §12.5）。
 *
 * 返回项目时，顶部接续卡展示「相对上次实际查看摘要时」的变化；无基线只展示当前事实。
 * 一条基线 = 一次「实际查看确认」：针对一次已成功展示的结果（presentation_id）保存
 * 必要版本引用，不复制业务正文；viewed_state_revision 单调推进，迟到/过期确认不覆盖
 * 更新的基线；「已查看」不是接受或接手，本模块不参与验收、批准或执行权转移。
 * 命名接续点（N01）行为不变：确认日常查看不重设命名接续点，也不被它重设。
 */

const MAX_OPEN_TASK_IDS = 200;
const MAX_VIEWED_FACT_REFS_CHARS = 65536;

const OPEN_TASK_STATUSES = ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED'] as const;

/* -------------------------------------------------------------------------- */
/* 纯函数：delta 计算                                                          */
/* -------------------------------------------------------------------------- */

export interface DailyViewCurrentFacts {
  readonly phase_key: string | null;
  readonly next_action_task_id: string | null;
  readonly open_task_ids: readonly string[];
  readonly unresolved_blocker_count: number;
  readonly open_task_ids_truncated: boolean;
}

export type DailyViewDelta = {
  readonly phase_changed: boolean;
  readonly phase_before: string | null;
  readonly phase_after: string | null;
  readonly next_action_changed: boolean;
  readonly next_action_before: string | null;
  readonly next_action_after: string | null;
  readonly new_open_task_ids: readonly string[];
  readonly closed_task_ids: readonly string[];
  readonly unresolved_blocker_count_changed: boolean;
  /** 任务集合超出租捕范围或基线被截断时：新增/关闭无法逐项比对，不能说「没有变化」。 */
  readonly open_tasks_unknown: boolean;
};

/** 基线 refs 里该字段的类型正确取值；缺失或类型错返回 undefined（该维度未知，不猜）。 */
function typedRefStringOrNull(value: unknown): string | null | undefined {
  return typeof value === 'string' || value === null ? value : undefined;
}

function typedRefStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value : undefined;
}

function typedRefCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 顺序保持的差集：left 有 right 没有。集合可能重复时按出现次数对齐，避免虚报。 */
function difference(left: readonly string[], right: readonly string[]): readonly string[] {
  const remaining = new Map<string, number>();
  for (const item of right) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  const result: string[] = [];
  for (const item of left) {
    const count = remaining.get(item) ?? 0;
    if (count > 0) remaining.set(item, count - 1);
    else result.push(item);
  }
  return result;
}

/**
 * 相对基线的 delta。基线 refs 里没有（或类型不对）的字段按「未知」处理：
 * 保守地不声称变化（false），不猜——这是接续卡的诚实性底线。
 *
 * 任务集合只有在两侧都完整时才逐项比对：当前或基线任何一侧超出捕获上限，
 * 新增/关闭就置为 `open_tasks_unknown`，绝不把「没比出来」显示成「没有变化」。
 */
export function computeDailyDelta(current: DailyViewCurrentFacts,
  baselineRefs: JsonObject | null): DailyViewDelta | null {
  if (baselineRefs === null) return null;
  const phaseBefore = typedRefStringOrNull(baselineRefs.phase_key);
  const nextActionBefore = typedRefStringOrNull(baselineRefs.next_action_task_id);
  const baselineOpen = typedRefStringArray(baselineRefs.open_task_ids);
  const baselineBlockers = typedRefCount(baselineRefs.unresolved_blocker_count);
  const baselineTruncated = baselineRefs.open_task_ids_truncated === true ||
    (baselineOpen !== undefined && baselineOpen.length >= MAX_OPEN_TASK_IDS);
  const openTasksUnknown = current.open_task_ids_truncated || baselineTruncated ||
    baselineOpen === undefined;
  return {
    phase_changed: phaseBefore === undefined ? false : phaseBefore !== current.phase_key,
    phase_before: phaseBefore ?? null,
    phase_after: current.phase_key,
    next_action_changed: nextActionBefore === undefined
      ? false : nextActionBefore !== current.next_action_task_id,
    next_action_before: nextActionBefore ?? null,
    next_action_after: current.next_action_task_id,
    new_open_task_ids: openTasksUnknown ? []
      : difference(current.open_task_ids, baselineOpen ?? []),
    closed_task_ids: openTasksUnknown ? []
      : difference(baselineOpen ?? [], current.open_task_ids),
    unresolved_blocker_count_changed: baselineBlockers === undefined ? false
      : baselineBlockers !== current.unresolved_blocker_count,
    open_tasks_unknown: openTasksUnknown,
  };
}

/* -------------------------------------------------------------------------- */
/* 纯函数：viewed_fact_refs 入口校验                                           */
/* -------------------------------------------------------------------------- */

export type ViewedFactRefsValidation =
  | { readonly ok: true; readonly refs: JsonObject }
  | { readonly ok: false; readonly fieldErrors: readonly FieldError[] };

/**
 * viewed_fact_refs 形状校验：必须是 object，phase_key / next_action_task_id 为 string|null，
 * open_task_ids 为 string[]（上限 200）。它是「看到了什么」的事实记录，不与当前库状态
 * 核对一致性；unresolved_blocker_count 可选（历史维度），存在时必须是非负整数。
 */
export function validateViewedFactRefs(raw: unknown): ViewedFactRefsValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, fieldErrors: [{ field: 'viewed_fact_refs',
      message: 'must be a JSON object' }] };
  }
  const body = raw as Record<string, unknown>;
  const errors: FieldError[] = [];
  if (!('phase_key' in body) || typedRefStringOrNull(body.phase_key) === undefined) {
    errors.push({ field: 'viewed_fact_refs.phase_key', message: 'must be a string or null' });
  }
  if (!('next_action_task_id' in body) ||
      typedRefStringOrNull(body.next_action_task_id) === undefined) {
    errors.push({ field: 'viewed_fact_refs.next_action_task_id',
      message: 'must be a string or null' });
  }
  if (!('open_task_ids' in body) || !Array.isArray(body.open_task_ids)) {
    errors.push({ field: 'viewed_fact_refs.open_task_ids', message: 'must be an array of task ids' });
  } else {
    if (!body.open_task_ids.every((item): item is string => typeof item === 'string')) {
      errors.push({ field: 'viewed_fact_refs.open_task_ids',
        message: 'must contain only string task ids' });
    }
    if (body.open_task_ids.length > MAX_OPEN_TASK_IDS) {
      errors.push({ field: 'viewed_fact_refs.open_task_ids',
        message: `must not exceed ${MAX_OPEN_TASK_IDS} items` });
    }
  }
  if ('unresolved_blocker_count' in body && typedRefCount(body.unresolved_blocker_count) === undefined) {
    errors.push({ field: 'viewed_fact_refs.unresolved_blocker_count',
      message: 'must be a non-negative integer' });
  }
  if ('open_task_ids_truncated' in body &&
      typeof body.open_task_ids_truncated !== 'boolean') {
    errors.push({ field: 'viewed_fact_refs.open_task_ids_truncated',
      message: 'must be a boolean' });
  }
  if (JSON.stringify(body).length > MAX_VIEWED_FACT_REFS_CHARS) {
    errors.push({ field: 'viewed_fact_refs',
      message: `must not exceed ${MAX_VIEWED_FACT_REFS_CHARS} characters when serialized` });
  }
  if (errors.length > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, refs: body as JsonObject };
}

/* -------------------------------------------------------------------------- */
/* 投影                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 确认回显的事实必须与签发时的快照一致（R6）。
 * 必填三项（阶段 / 下一步 / 任务集合）严格比较；可选项只要客户端给出就比较，
 * 旧客户端省略可选项不视为篡改。
 */
function issuedFactsMatch(issued: JsonObject, refs: JsonObject): boolean {
  const same = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  for (const key of ['phase_key', 'next_action_task_id', 'open_task_ids'] as const) {
    if (!same(issued[key], refs[key])) return false;
  }
  for (const key of ['unresolved_blocker_count', 'open_task_ids_truncated'] as const) {
    if (key in refs && !same(issued[key], refs[key])) return false;
  }
  return true;
}

export type DailyViewBaselineProjection = {
  readonly presentation_id: string;
  readonly viewed_state_revision: string;
  readonly viewed_fact_refs: JsonObject;
  readonly viewed_presentation_seq: string;
  readonly confirmed_at: string;
};

export type DailyContinuationProjection = {
  readonly project_id: string;
  readonly current: {
    readonly state_revision: string;
    readonly phase_key: string | null;
    readonly next_action_task_id: string | null;
    readonly open_task_ids: readonly string[];
    readonly open_task_count: number;
    readonly open_task_ids_truncated: boolean;
    readonly waiting_task_count: number;
    readonly blocked_task_count: number;
    readonly unresolved_blocker_count: number;
  };
  readonly baseline: DailyViewBaselineProjection | null;
  readonly delta: DailyViewDelta | null;
  /**
   * 本次读取的服务端展示身份：确认必须回显它，序号是同 State revision 下的可信读取顺序。
   * 由服务端签发，不用客户端时钟；确认只接受不超过已签发上限的序号。
   */
  readonly presentation: {
    readonly presentation_id: string;
    readonly presentation_seq: string;
  };
  /**
   * 投影版本：基线行的 viewed_state_revision（无基线时 '0'）。
   * 基线单调推进，前端据此做请求竞态裁决：只接受不小于已展示值的投影。
   */
  readonly revision: string;
};

export async function readCurrentFacts(repositories: Repositories,
  projectId: string): Promise<DailyContinuationProjection['current']> {
  const state = await repositories.projects.readProjectState(projectId);
  if (state === undefined) throw resourceNotFound('Project state');
  const tasks = await repositories.tasks
    .listProjectTasksByStatus(projectId, OPEN_TASK_STATUSES);
  const blockers = await repositories.projects.listProjectBlockers(projectId);
  const truncated = tasks.length > MAX_OPEN_TASK_IDS;
  const visibleTasks = truncated ? tasks.slice(0, MAX_OPEN_TASK_IDS) : tasks;
  const openTaskIds = visibleTasks.map((task) => task.id);
  return { state_revision: toDecimalString(state.revision), phase_key: state.phase_key,
    next_action_task_id: state.next_action_task_id, open_task_ids: openTaskIds,
    open_task_count: openTaskIds.length, open_task_ids_truncated: truncated,
    waiting_task_count: tasks.filter((task) => task.status === 'WAITING').length,
    blocked_task_count: tasks.filter((task) => task.status === 'BLOCKED').length,
    unresolved_blocker_count: blockers.filter((blocker) => blocker.resolved_at === null).length };
}

async function buildProjection(repositories: Repositories, projectId: string,
  baseline: ProjectDailyViewBaselineRow | null,
  presentation: { readonly presentation_id: string; readonly presentation_seq: string },
  snapshot?: DailyContinuationProjection['current'],
): Promise<DailyContinuationProjection> {
  const current = snapshot ?? await readCurrentFacts(repositories, projectId);
  const baselineProjection = baseline === null ? null : {
    presentation_id: baseline.presentation_id,
    viewed_state_revision: toDecimalString(baseline.viewed_state_revision),
    viewed_fact_refs: baseline.viewed_fact_refs,
    viewed_presentation_seq: toDecimalString(baseline.viewed_presentation_seq),
    confirmed_at: baseline.confirmed_at.toISOString(),
  };
  return { project_id: projectId, current, baseline: baselineProjection,
    delta: computeDailyDelta(current, baseline?.viewed_fact_refs ?? null),
    presentation,
    revision: baseline === null ? '0' : toDecimalString(baseline.viewed_state_revision) };
}

/* -------------------------------------------------------------------------- */
/* 用例                                                                        */
/* -------------------------------------------------------------------------- */

export async function readProjectDailyContinuation(db: DbExecutor,
  workspaceId: string, projectId: string): Promise<DailyContinuationProjection> {
  const repositories = createRepositories(db);
  // 先核对可见性再签发展示序号：失权读取不产生任何展示身份。
  await readProjectInWorkspace(repositories, workspaceId, projectId);
  // R6：签发序号、事实快照与签发记录在同一事务内完成——展示顺序与快照新旧一致，
  // 并发读取由计数器行锁串行，不拿请求开始顺序冒充事实快照的新旧；
  // 页面展示的就是快照本身，确认回显它时逐项可核对。
  return withTransaction(db, async (tx) => {
    const presentationId = randomUUID();
    const seq = await tx.dailyViews.issuePresentation({ workspaceId, projectId,
      presentationId });
    const baseline = await tx.dailyViews.findByProject(workspaceId, projectId) ?? null;
    const snapshot = await readCurrentFacts(tx, projectId);
    await tx.dailyViews.insertIssuedPresentation({ workspaceId, projectId, presentationId,
      issuedSeq: seq, stateRevision: BigInt(snapshot.state_revision),
      factRefs: { phase_key: snapshot.phase_key,
        next_action_task_id: snapshot.next_action_task_id,
        open_task_ids: snapshot.open_task_ids,
        open_task_ids_truncated: snapshot.open_task_ids_truncated,
        unresolved_blocker_count: snapshot.unresolved_blocker_count } });
    return buildProjection(tx, projectId, baseline,
      { presentation_id: presentationId, presentation_seq: toDecimalString(seq) },
      snapshot);
  });
}

export interface ConfirmProjectDailyViewInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly commandId: string;
  readonly presentationId: string;
  /** 服务端在展示当时签发的序号：同 State revision 下的可信读取顺序。 */
  readonly presentationSeq: string;
  readonly viewedStateRevision: string;
  readonly viewedFactRefs: unknown;
}

/**
 * 「实际查看确认」：一条基线针对一次已成功展示的结果。
 *
 * 推进条件是**两个维度同时成立**：
 *   1. 展示序号严格大于基线（State 不变但任务集合变了也能推进，已看过的变化不再反复报新增）；
 *   2. viewed_state_revision 不倒退（迟到的旧展示不能覆盖新查看结果）。
 * 同一展示（presentation_id）重复确认由唯一约束回放；顺序来自服务端签发，不用客户端时钟。
 */
export async function confirmProjectDailyView(db: DbExecutor,
  input: ConfirmProjectDailyViewInput): Promise<CommandOutcome<DailyContinuationProjection>> {
  const viewedStateRevision = requireRevision(input.viewedStateRevision, 'viewed_state_revision');
  const presentationSeq = requireRevision(input.presentationSeq, 'presentation_seq');
  const validated = validateViewedFactRefs(input.viewedFactRefs);
  if (!validated.ok) throw validationFailed(validated.fieldErrors);
  const echoedPresentation = { presentation_id: input.presentationId,
    presentation_seq: toDecimalString(presentationSeq) };
  return runIdempotentCommand<DailyContinuationProjection>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'ConfirmProjectDailyView',
    target: { project_id: input.projectId },
    body: { presentation_id: input.presentationId,
      presentation_seq: toDecimalString(presentationSeq),
      viewed_state_revision: toDecimalString(viewedStateRevision),
      viewed_fact_refs: validated.refs },
    execute: async (repositories) => {
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, input.projectId);
      // R6：逐项对上真实签发记录——身份、序号、当次 State 版本与已展示事实缺一不可；
      // 「序号在已签发上限内」本身不再是凭据（它既不绑定身份，也不绑定内容）。
      const issued = await repositories.dailyViews
        .findIssuedPresentation(input.workspaceId, input.presentationId);
      if (issued === undefined) {
        throw validationFailed([{ field: 'presentation_id',
          message: 'presentation_id must come from a real daily continuation read' }]);
      }
      if (issued.project_id !== input.projectId) {
        throw validationFailed([{ field: 'presentation_id',
          message: '已被其他项目的查看确认使用' }]);
      }
      if (issued.issued_seq !== presentationSeq) {
        throw validationFailed([{ field: 'presentation_seq',
          message: 'presentation_seq must match the seq issued with this presentation_id' }]);
      }
      if (issued.state_revision !== viewedStateRevision) {
        throw validationFailed([{ field: 'viewed_state_revision',
          message: 'viewed_state_revision must equal the State version shown by this presentation' }]);
      }
      if (!issuedFactsMatch(issued.fact_refs, validated.refs)) {
        throw validationFailed([{ field: 'viewed_fact_refs',
          message: 'viewed_fact_refs must echo the facts shown by this presentation' }]);
      }
      // presentation 幂等优先：同一展示结果只确认一次，无论 command_id 是否一致。
      const byPresentation = await repositories.dailyViews.findPresentation(input.workspaceId,
        input.presentationId);
      if (byPresentation !== undefined) {
        if (byPresentation.project_id !== input.projectId) {
          throw validationFailed([{ field: 'presentation_id',
            message: '已被其他项目的查看确认使用' }]);
        }
        return buildProjection(repositories, input.projectId, byPresentation,
          echoedPresentation);
      }
      const settle = async (existing: ProjectDailyViewBaselineRow):
        Promise<DailyContinuationProjection> => {
        // 序号更大 = 这次展示读取更晚；revision 不倒退 = 迟到的旧展示不覆盖新查看结果。
        if (presentationSeq > existing.viewed_presentation_seq &&
            viewedStateRevision >= existing.viewed_state_revision) {
          const advanced = await repositories.dailyViews.advanceBaseline(existing.id,
            { viewedStateRevision, viewedFactRefs: validated.refs,
              presentationId: input.presentationId, viewedPresentationSeq: presentationSeq });
          if (advanced !== undefined) {
            await repositories.activities.insertActivityRecord({ id: randomUUID(),
              workspaceId: input.workspaceId, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
              commandId: input.commandId, projectId: input.projectId, taskId: null,
              eventType: 'PROJECT_DAILY_VIEW_CONFIRMED',
              factRefs: { project_id: input.projectId, presentation_id: input.presentationId,
                presentation_seq: toDecimalString(presentationSeq),
                viewed_state_revision: toDecimalString(viewedStateRevision) } });
            return buildProjection(repositories, input.projectId, advanced,
              echoedPresentation);
          }
        }
        // R6：污染旧基线的识别与恢复——基线身份没有任何签发来源，且版本高于任何真实
        // 读取（真实基线只能来自一次真实读取），说明它不是真实展示写下的；按本次真实
        // 确认修复并留下可追溯审计，不让污染基线永远挡住正常查看。
        const provenance = await repositories.dailyViews
          .findIssuedPresentation(input.workspaceId, existing.presentation_id);
        const currentState = await repositories.projects.readProjectState(input.projectId);
        if (provenance === undefined && currentState !== undefined &&
            existing.viewed_state_revision > currentState.revision &&
            presentationSeq > existing.viewed_presentation_seq) {
          const repaired = await repositories.dailyViews.repairBaseline(existing.id,
            { viewedStateRevision, viewedFactRefs: validated.refs,
              presentationId: input.presentationId,
              viewedPresentationSeq: presentationSeq });
          if (repaired !== undefined) {
            await repositories.activities.insertActivityRecord({ id: randomUUID(),
              workspaceId: input.workspaceId, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
              commandId: input.commandId, projectId: input.projectId, taskId: null,
              eventType: 'PROJECT_DAILY_VIEW_BASELINE_REPAIRED',
              factRefs: { project_id: input.projectId,
                presentation_id: input.presentationId,
                presentation_seq: toDecimalString(presentationSeq),
                viewed_state_revision: toDecimalString(viewedStateRevision),
                repaired_presentation_id: existing.presentation_id,
                repaired_state_revision:
                  toDecimalString(existing.viewed_state_revision) } });
            return buildProjection(repositories, input.projectId, repaired,
              echoedPresentation);
          }
        }
        // 相等 = 同一次展示的重复确认；更小 = 迟到确认：都不覆盖，返回当前基线投影。
        const current = await repositories.dailyViews.findByProject(input.workspaceId,
          input.projectId);
        return buildProjection(repositories, input.projectId, current ?? existing,
          echoedPresentation);
      };
      const existing = await repositories.dailyViews.findByProject(input.workspaceId,
        input.projectId, true);
      if (existing !== undefined) return settle(existing);
      const inserted = await repositories.dailyViews.insertBaseline({
        workspaceId: input.workspaceId, projectId: input.projectId,
        viewedStateRevision, viewedFactRefs: validated.refs,
        presentationId: input.presentationId, viewedPresentationSeq: presentationSeq });
      if (inserted !== undefined) {
        await repositories.activities.insertActivityRecord({ id: randomUUID(),
          workspaceId: input.workspaceId, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
          commandId: input.commandId, projectId: input.projectId, taskId: null,
          eventType: 'PROJECT_DAILY_VIEW_CONFIRMED',
          factRefs: { project_id: input.projectId, presentation_id: input.presentationId,
            presentation_seq: toDecimalString(presentationSeq),
            viewed_state_revision: toDecimalString(viewedStateRevision) } });
        return buildProjection(repositories, input.projectId, inserted, echoedPresentation);
      }
      // 并发首插撞线：重读胜出行并按单调语义判定，不产生第二行。
      const winner = await repositories.dailyViews.findByProject(input.workspaceId,
        input.projectId, true);
      if (winner === undefined) {
        throw new Error('daily view baseline row disappeared after conflict resolution');
      }
      return settle(winner);
    },
  });
}
