import { randomUUID } from 'node:crypto';

import type { AssistPlanRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { PlanBody } from './plan-goal-envelope.js';
import { resourceNotFound } from './domain-error.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/**
 * 0127：会话内计划版本（工作台 §44.1）。
 *
 * 三条不变量：
 *   * **版本不可变**。修改计划＝写入新版本并把上一版标 SUPERSEDED；已写出的版本永远按原样读出，
 *     因此「按第 2 版执行」永远指向同一份内容。
 *   * **同一原消息只产出一版**（`uq_assist_plan_source`）。恢复重放读到的是同一行，
 *     不会在同一条消息上叠加两个版本。
 *   * **默认只存在会话里**。这里没有任何写项目的代码路径：导出计划是用户显式请求的
 *     独立动作（客户端保存文件），规划过程本身零写入。
 */

export interface PlanProjection {
  readonly plan_id: string;
  readonly session_id: string;
  /** 版本号由服务端给出；客户端不得按标题或时间自行匹配版本。 */
  readonly version: number;
  readonly status: 'CURRENT' | 'SUPERSEDED';
  readonly goal: string;
  readonly scope: readonly string[];
  readonly steps: readonly { readonly title: string; readonly detail: string | null }[];
  readonly verification: readonly { readonly statement: string;
    readonly method: string }[];
  readonly open_questions: readonly string[];
  readonly source_message_id: string;
  readonly created_at: string;
}

/**
 * 四段清单（scope / steps / verification / open_questions）在库里就是 **JSON 数组**：
 * 迁移 0127 声明 `jsonb NOT NULL DEFAULT '[]'::jsonb`，写入方
 * （`plan-goal-repository.ts` 的 `insertPlanVersion`）也直接存数组。
 * 列的 TS 类型 `JsonObject` 只表示「一段 JSON」，所以这里按运行时形状取；
 * 形状不符就当空，绝不静默丢内容——以前按 `value['items']` 取，数组上永远取不到，
 * 于是「版本行落库了、计划内容一律读不回」。
 */
function asArray(value: JsonObject): readonly unknown[] {
  return Array.isArray(value) ? value as unknown as readonly unknown[] : [];
}

function stringItems(value: JsonObject): string[] {
  // scope / open_questions 由 `recordPlanFromMessage` 落成 `[{ text }]` 的数组；
  // 同时接受纯字符串元素，避免历史行被读成空。
  return asArray(value).flatMap((item): string[] => {
    if (typeof item === 'string') return [item];
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const text = (item as JsonObject).text;
      return typeof text === 'string' ? [text] : [];
    }
    return [];
  });
}

function objectItems(value: JsonObject): JsonObject[] {
  return asArray(value).filter((item): item is JsonObject =>
    typeof item === 'object' && item !== null && !Array.isArray(item));
}

export function planProjection(row: AssistPlanRow): PlanProjection {
  return {
    plan_id: row.id, session_id: row.session_id, version: row.version, status: row.status,
    goal: row.goal, scope: stringItems(row.scope),
    steps: objectItems(row.steps).map((step) => ({ title: String(step.title ?? ''),
      detail: typeof step.detail === 'string' ? step.detail : null })),
    verification: objectItems(row.verification).map((item) => ({
      statement: String(item.statement ?? ''), method: String(item.method ?? 'HUMAN') })),
    open_questions: stringItems(row.open_questions),
    source_message_id: row.source_message_id, created_at: row.created_at.toISOString(),
  };
}

export interface SessionPlanView {
  readonly latest: PlanProjection | null;
  /** 最新在前；含最新一版，便于「核对是否过期」时直接比版本号。 */
  readonly versions: readonly PlanProjection[];
}

export async function readSessionPlan(db: DbExecutor, input: {
  workspaceId: string; sessionId: string }): Promise<SessionPlanView> {
  const repositories = createRepositories(db);
  const session = await repositories.assist.readSession(input.sessionId);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist session');
  }
  const rows = await repositories.planGoals.listPlans(session.id, 20);
  return { latest: rows[0] === undefined ? null : planProjection(rows[0]),
    versions: rows.map(planProjection) };
}

export async function readPlanVersion(db: DbExecutor, input: {
  workspaceId: string; sessionId: string; planId: string }): Promise<PlanProjection> {
  const repositories = createRepositories(db);
  const session = await repositories.assist.readSession(input.sessionId);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist session');
  }
  const row = await repositories.planGoals.readPlan(input.planId);
  // 跨会话引用按不可见处理：知道 id 不等于有权限读另一个会话的计划。
  if (row === undefined || row.session_id !== session.id) throw resourceNotFound('Assist plan');
  return planProjection(row);
}

/**
 * 把一次计划模式输出落成一个新版本。
 *
 * 必须与消息结算在**同一事务**里调用：正文与计划版本要么一起提交，要么都不提交，
 * 否则会出现「用户看到了第 3 版计划，但消息里说的是别的」这种无法核对的状态。
 */
export async function recordPlanFromMessage(repositories: Repositories, input: {
  workspaceId: string; sessionId: string; messageId: string; plan: PlanBody;
}): Promise<PlanProjection> {
  const existing = await repositories.planGoals.readPlanBySourceMessage(input.sessionId,
    input.messageId);
  if (existing !== undefined) return planProjection(existing);
  const row = await repositories.planGoals.insertPlanVersion({
    id: randomUUID(), workspaceId: input.workspaceId, sessionId: input.sessionId,
    goal: input.plan.goal,
    scope: input.plan.scope.map((item): JsonObject => ({ text: item })),
    steps: input.plan.steps.map((step): JsonObject => ({ title: step.title,
      detail: step.detail })),
    verification: input.plan.verification.map((item): JsonObject => ({
      statement: item.statement, method: item.method })),
    openQuestions: input.plan.open_questions.map((item): JsonObject => ({ text: item })),
    sourceMessageId: input.messageId,
  });
  return planProjection(row);
}
