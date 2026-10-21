import type { RelayHttp } from "../core/http";
import { array, boolean, decimal, integer, nullableString, object, string, stringArray } from "../core/primitives";
import type { RelayChatMode } from "../dtos/assist";
import { commandEnvelopeFrom } from "../parse/projects";

/**
 * 聊天 `/plan` 与 `/goal` 的客户端（HTTP 契约 §10.108）。
 *
 * 三条边界写在类型里：
 *   * 读投影只含服务端事实，客户端**不**自己推断「能不能暂停」——`actions` 由服务端给；
 *   * 四条控制命令只提交意图，回执里的状态才是真状态（`PAUSING` 不等于已暂停）；
 *   * 计划版本号按服务端给的值使用，客户端从不按标题或时间匹配版本。
 */

export type RelayPlanStep = { readonly title: string; readonly detail: string | null };
export type RelayPlanVerification = { readonly statement: string; readonly method: string };

export type RelayAssistPlan = {
  readonly planId: string;
  readonly sessionId: string;
  readonly version: number;
  readonly status: "CURRENT" | "SUPERSEDED";
  readonly goal: string;
  readonly scope: readonly string[];
  readonly steps: readonly RelayPlanStep[];
  readonly verification: readonly RelayPlanVerification[];
  readonly openQuestions: readonly string[];
  readonly sourceMessageId: string;
  readonly createdAt: string;
};

export type RelayPlanView = {
  readonly latest: RelayAssistPlan | null;
  readonly versions: readonly RelayAssistPlan[];
};

export type RelayGoalStatus = "ACTIVE" | "PAUSING" | "PAUSED" | "CANCELLING" | "CANCELLED"
  | "WAITING_USER" | "BLOCKED" | "BUDGET_EXHAUSTED" | "AWAITING_ACCEPTANCE" | "COMPLETED" | "FAILED";

export type RelayGoalCriterion = {
  readonly key: string;
  readonly statement: string;
  readonly status: "MET" | "UNMET" | "PENDING";
  readonly evidence: string | null;
  readonly required: boolean;
};

export type RelayGoalStep = { readonly title: string; readonly status: "PENDING" | "DOING" | "DONE" };

export type RelayGoalStopReason = {
  readonly code: string;
  readonly detail: string;
  readonly questions: readonly string[];
  readonly resumable: boolean;
};

export type RelayAssistGoal = {
  readonly goalId: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly status: RelayGoalStatus;
  readonly currentStep: string | null;
  readonly progress: string | null;
  readonly stopReason: RelayGoalStopReason | null;
  readonly criteria: readonly RelayGoalCriterion[];
  readonly steps: readonly RelayGoalStep[];
  readonly roundCount: number;
  readonly noProgressRounds: number;
  readonly planVersionId: string | null;
  readonly planVersion: number | null;
  readonly lastRoundAt: string | null;
  readonly actions: { readonly pause: boolean; readonly cancel: boolean;
    readonly resume: boolean; readonly confirmCompletion: boolean };
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RelayGoalRound = { readonly roundIndex: number; readonly outcome: string;
  readonly note: string | null; readonly createdAt: string };

export type RelayGoalView = {
  readonly goal: RelayAssistGoal | null;
  readonly rounds: readonly RelayGoalRound[];
};

export type RelayChatModeTransition = {
  readonly sessionId: string;
  readonly chatMode: RelayChatMode;
  readonly revision: string;
  /** 有活动目标时切走：控制意图已保存，在途轮次还在安全停下。 */
  readonly goalStopping: boolean;
};

function objectList(value: unknown, key: string, label: string): Record<string, unknown>[] {
  return array(object(value, label), key, label)
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => object(item, label));
}

function planFrom(value: unknown): RelayAssistPlan {
  const row = object(value, "assist plan");
  const status = string(row, "status", "assist plan");
  if (status !== "CURRENT" && status !== "SUPERSEDED") throw new Error("计划状态无效。");
  return {
    planId: string(row, "plan_id", "assist plan"),
    sessionId: string(row, "session_id", "assist plan"),
    version: integer(row, "version", "assist plan"),
    status,
    goal: string(row, "goal", "assist plan"),
    scope: stringArray(row, "scope", "assist plan"),
    steps: objectList(row, "steps", "assist plan").map((step) => ({
      title: string(step, "title", "plan step"),
      detail: nullableString(step, "detail", "plan step") })),
    verification: objectList(row, "verification", "assist plan").map((item) => ({
      statement: string(item, "statement", "plan verification"),
      method: string(item, "method", "plan verification") })),
    openQuestions: stringArray(row, "open_questions", "assist plan"),
    sourceMessageId: string(row, "source_message_id", "assist plan"),
    createdAt: string(row, "created_at", "assist plan"),
  };
}

const GOAL_STATUSES: readonly string[] = ["ACTIVE", "PAUSING", "PAUSED", "CANCELLING",
  "CANCELLED", "WAITING_USER", "BLOCKED", "BUDGET_EXHAUSTED", "AWAITING_ACCEPTANCE",
  "COMPLETED", "FAILED"];

export function goalFrom(value: unknown): RelayAssistGoal {
  const row = object(value, "assist goal");
  const status = string(row, "status", "assist goal");
  if (!GOAL_STATUSES.includes(status)) throw new Error("目标状态无效。");
  const stopRaw = row.stop_reason;
  const stop = stopRaw === null || stopRaw === undefined ? null
    : (() => {
      const reason = object(stopRaw, "goal stop reason");
      return { code: string(reason, "code", "goal stop reason"),
        detail: string(reason, "detail", "goal stop reason"),
        questions: stringArray(reason, "questions", "goal stop reason"),
        resumable: boolean(reason, "resumable", "goal stop reason") };
    })();
  const actions = object(row.actions, "goal actions");
  return {
    goalId: string(row, "goal_id", "assist goal"),
    sessionId: string(row, "session_id", "assist goal"),
    objective: string(row, "objective", "assist goal"),
    status: status as RelayGoalStatus,
    currentStep: nullableString(row, "current_step", "assist goal"),
    progress: nullableString(row, "progress", "assist goal"),
    stopReason: stop,
    criteria: objectList(row, "criteria", "assist goal").map((item) => {
      const criterionStatus = string(item, "status", "goal criterion");
      return {
        key: string(item, "key", "goal criterion"),
        statement: string(item, "statement", "goal criterion"),
        status: (criterionStatus === "MET" || criterionStatus === "UNMET"
          ? criterionStatus : "PENDING") as RelayGoalCriterion["status"],
        evidence: nullableString(item, "evidence", "goal criterion"),
        required: boolean(item, "required", "goal criterion"),
      };
    }),
    steps: objectList(row, "steps", "assist goal").map((item) => {
      const stepStatus = string(item, "status", "goal step");
      return { title: string(item, "title", "goal step"),
        status: (stepStatus === "DOING" || stepStatus === "DONE"
          ? stepStatus : "PENDING") as RelayGoalStep["status"] };
    }),
    roundCount: integer(row, "round_count", "assist goal"),
    noProgressRounds: integer(row, "no_progress_rounds", "assist goal"),
    planVersionId: nullableString(row, "plan_version_id", "assist goal"),
    planVersion: row.plan_version === null || row.plan_version === undefined ? null
      : integer(row, "plan_version", "assist goal"),
    lastRoundAt: nullableString(row, "last_round_at", "assist goal"),
    actions: { pause: boolean(actions, "pause", "goal actions"),
      cancel: boolean(actions, "cancel", "goal actions"),
      resume: boolean(actions, "resume", "goal actions"),
      confirmCompletion: boolean(actions, "confirm_completion", "goal actions") },
    revision: decimal(row, "revision", "assist goal"),
    createdAt: string(row, "created_at", "assist goal"),
    updatedAt: string(row, "updated_at", "assist goal"),
  };
}

export async function getSessionPlans(http: RelayHttp, sessionId: string): Promise<RelayPlanView> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(sessionId)}/plans`));
  const row = object(body, "assist plans");
  return { latest: row.latest === null || row.latest === undefined ? null : planFrom(row.latest),
    versions: array(row, "versions", "assist plans").map(planFrom) };
}

export async function getSessionGoal(http: RelayHttp, sessionId: string): Promise<RelayGoalView> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(sessionId)}/goal`));
  const row = object(body, "assist goal view");
  return { goal: row.goal === null || row.goal === undefined ? null : goalFrom(row.goal),
    rounds: array(row, "rounds", "assist goal view").map((value) => {
      const round = object(value, "goal round");
      return { roundIndex: integer(round, "round_index", "goal round"),
        outcome: string(round, "outcome", "goal round"),
        note: nullableString(round, "note", "goal round"),
        createdAt: string(round, "created_at", "goal round") };
    }) };
}

/**
 * 切换行为模式（`POST …/chat-mode`）。
 *
 * 只改模式，**不**启动执行：切到 `/goal` 之后仍需要一条目标内容或「按此计划执行」。
 * 回执里的 `chat_mode` 是服务端真值；界面不得先改本地状态再等回执。
 */
export async function setChatMode(http: RelayHttp, input: {
  sessionId: string; commandId: string; mode: RelayChatMode; expectedRevision?: string;
}): Promise<RelayChatModeTransition> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/chat-mode`), {
    method: "POST",
    body: JSON.stringify({ command_id: input.commandId, mode: input.mode,
      ...(input.expectedRevision === undefined ? {}
        : { expected_revision: input.expectedRevision }) }),
  }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    const row = object(envelope.result, "chat mode result");
    const mode = string(row, "chat_mode", "chat mode result");
    if (mode !== "CHAT" && mode !== "PLAN" && mode !== "GOAL") throw new Error("mode invalid");
    return { sessionId: string(row, "session_id", "chat mode result"), chatMode: mode,
      revision: decimal(row, "revision", "chat mode result"),
      goalStopping: boolean(row, "goal_stopping", "chat mode result") };
  } catch { throw new Error("会话模式回执无法核对，请刷新后重试。"); }
}

/** 「按此计划执行」：绑定确切的一版计划启动目标。 */
export async function startGoalFromPlan(http: RelayHttp, input: {
  sessionId: string; commandId: string; planId: string; allowSuperseded?: boolean;
}): Promise<RelayAssistGoal | null> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/goals`), {
    method: "POST",
    body: JSON.stringify({ command_id: input.commandId, plan_id: input.planId,
      ...(input.allowSuperseded === true ? { allow_superseded: true } : {}) }),
  }, 200);
  const envelope = commandEnvelopeFrom(body);
  if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
  const goal = object(envelope.result, "goal command result").goal;
  return goal === null || goal === undefined ? null : goalFrom(goal);
}

type GoalControl = "pause" | "cancel" | "resume" | "complete";

/** 四条控制命令只提交意图；返回的是服务端当前状态（可能仍是 PAUSING）。 */
export async function controlGoal(http: RelayHttp, input: {
  goalId: string; commandId: string; action: GoalControl;
}): Promise<RelayAssistGoal | null> {
  const body = await http.request(http.workspacePath(
    `/assist-goals/${encodeURIComponent(input.goalId)}/${input.action}`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId }),
  }, 200);
  const envelope = commandEnvelopeFrom(body);
  if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
  const goal = object(envelope.result, "goal command result").goal;
  return goal === null || goal === undefined ? null : goalFrom(goal);
}
