import { reviewReasonText } from "./labels";

/**
 * 任务「等待中 / 阻塞」的原因读法（2026-11-15 任务页专项）。
 *
 * 数据来源只有一个：任务列表投影里的 `waiting_reason`（服务端写的是 Run 的 `wait_reason`）
 * 与 `blocking_task_ids` / `unresolved_blocker_ids`。这里只做展示投影，不推断执行状态、
 * 不把等待说成阻塞，也不把阻塞说成验收待办。
 *
 * 取值清单按 API 源码里**确实写入** wait_reason 的位置整理（2026-11-15 核验）：
 * - control-requests.ts：暂停写 PAUSED_BY_USER；终态控制（CANCEL/HANDOFF/CANCEL_TASK）
 *   写的是 `pending.type`，但那一刻 Run 已是 CANCELLED、Task 已离开 WAITING，不会作为等待原因出现；
 * - request-review.ts / gateway-actions：动作审批 ACTION_APPROVAL_REQUIRED；
 * - run-steps.ts：工具循环停在等待点 HUMAN_TOOL（工具适配需人工）与 REPEATED_FAILURE（预算用尽）；
 * - verify-run.ts：HUMAN 判定点 AWAITING_HUMAN_EVIDENCE、CHECKER_UNAVAILABLE、
 *   CORRECTION_BUDGET_EXHAUSTED、UNCERTAIN_REQUIRES_HUMAN。
 * contracts/02 里写的 USER_PAUSED、WAITING_CONNECTION、RECONCILIATION_REQUIRED 在实现中从未写入：
 * 前者与实现命名不一致（实现写 PAUSED_BY_USER），后两者属未实现的目标状态，故不凭契约造文案。
 *
 * 认不出的值不静默丢弃，也不编中文：行内保留原始码并明说「界面尚无对应说明」；
 * 详情里的完整句子同时带出原始码供核对。
 */

interface WaitingReasonReading {
  /** 表格里的短读法：一行内说得清「在等谁做什么」。 */
  readonly short: string;
  /** 详情里的完整句子；缺省时复用验收原因的统一文案。 */
  readonly detail?: string;
}

const waitingReasons: Readonly<Record<string, WaitingReasonReading>> = {
  ACTION_APPROVAL_REQUIRED: {
    short: "等待你批准动作",
    detail: "AI 请求了一次需要你批准的动作（例如文件写入、外部提交）。批准只授权这一次动作，"
      + "执行结果仍需另行核对。"
  },
  HUMAN_TOOL: {
    short: "工具需人工处理",
    detail: "工具适配需要你处理：更换工具、补齐输入或改走人工。执行停在这个步骤，处理后可继续。"
  },
  REPEATED_FAILURE: {
    short: "工具循环预算用尽",
    detail: "工具调用预算或轮次已用尽，这一步没有再可派发的请求。执行停在这个步骤，"
      + "等你决定是否换一种做法、接手或停止。"
  },
  PAUSED_BY_USER: {
    short: "你已暂停执行",
    detail: "你暂停了这次执行，Run 停在当前步骤。恢复后回到原来的等待点，原审批身份仍保留。"
  },
  AWAITING_HUMAN_EVIDENCE: { short: "等你补充验收证据" },
  CHECKER_UNAVAILABLE: { short: "检查器不可用" },
  CORRECTION_BUDGET_EXHAUSTED: { short: "修正预算已用尽" },
  UNCERTAIN_REQUIRES_HUMAN: { short: "检查结果不确定" }
};

/** 只有验收类原因共用 labels.ts 里同一份说明，避免同一码在两页写两套中文。 */
const reviewReasonCodes: ReadonlySet<string> = new Set([
  "AWAITING_HUMAN_EVIDENCE", "CHECKER_UNAVAILABLE", "CORRECTION_BUDGET_EXHAUSTED", "UNCERTAIN_REQUIRES_HUMAN"
]);

export function isKnownWaitingReason(code: string): boolean {
  return Object.hasOwn(waitingReasons, code);
}

/**
 * 表格行内的短读法。null 表示服务端没有记录原因（由调用方决定怎样如实说明），
 * 未知码返回带原始码的读法，不显示空白也不冒充成已知原因。
 */
export function waitingReasonShort(code: string | null): string | null {
  if (code === null) return null;
  const known = waitingReasons[code];
  return known === undefined ? `等待原因未识别（${code}）` : known.short;
}

/** 详情/提示里的完整句子；未知码明确说明「界面还没有对应说明」并保留原始码。 */
export function waitingReasonDetail(code: string): string {
  const known = waitingReasons[code];
  if (known === undefined) {
    return `服务端记录的等待原因是「${code}」，当前界面还没有对应说明，需按原始码核对。`;
  }
  if (reviewReasonCodes.has(code)) return reviewReasonText(code);
  return known.detail ?? known.short;
}

/**
 * BLOCKED 行的原因摘要：分别说清「前置任务未完成」与「存在未解除的阻塞」。
 *
 * `blocking_task_ids` 是未完成的前置任务 ID，`unresolved_blocker_ids` 是 blocker 记录 ID，
 * 两者语义不同，不能合并成一个「依赖未完成」。两个都为空时说明服务端没有登记依据——
 * 只确认「服务端没给原因」，不推断为「没有阻塞」。
 */
export function blockedReasonSummary(blockingTaskIds: readonly string[], unresolvedBlockerIds: readonly string[]): string {
  const blocking = blockingTaskIds.length;
  const blockers = unresolvedBlockerIds.length;
  if (blocking === 0 && blockers === 0) return "服务端未登记阻塞依据";
  const parts: string[] = [];
  if (blocking > 0) parts.push(`${blocking} 个前置任务未完成`);
  if (blockers > 0) parts.push(`${blockers} 个阻塞未解除`);
  return parts.join(" · ");
}

/** BLOCKED 的完整解释：说清两类事实各自的状态，以及处理完才能开始。 */
export function blockedReasonDetail(blockingTaskIds: readonly string[], unresolvedBlockerIds: readonly string[]): string {
  const blocking = blockingTaskIds.length;
  const blockers = unresolvedBlockerIds.length;
  if (blocking === 0 && blockers === 0) {
    return "服务端把任务标为阻塞，但没有登记前置任务或阻塞记录；需要打开任务详情核对，不能当作没有阻塞。";
  }
  if (blocking > 0 && blockers > 0) {
    return `${blocking} 个前置任务尚未完成，另有 ${blockers} 个阻塞原因未解除；两类都处理完才具备开始条件。`;
  }
  return blocking > 0
    ? `${blocking} 个前置任务尚未完成；依赖完成前任务不能开始。`
    : `有 ${blockers} 个阻塞原因未解除；解除前任务不能开始。`;
}

/** 状态与原因的组合语义：只有 WAITING / BLOCKED 才带原因，其余状态不显示原因格。 */
export function taskRowReason(task: {
  readonly status: string;
  readonly waitingReason: string | null;
  readonly blockingTaskIds?: readonly string[];
  readonly unresolvedBlockerIds?: readonly string[];
}): { readonly short: string; readonly detail: string } | null {
  if (task.status === "WAITING") {
    const short = waitingReasonShort(task.waitingReason);
    return short === null
      ? { short: "等待原因尚未登记", detail: "服务端把任务标为等待中，但没有记录等待原因，需按任务详情里的 Run 核对。" }
      : { short, detail: task.waitingReason !== null ? waitingReasonDetail(task.waitingReason) : short };
  }
  if (task.status === "BLOCKED") {
    return {
      short: blockedReasonSummary(task.blockingTaskIds ?? [], task.unresolvedBlockerIds ?? []),
      detail: blockedReasonDetail(task.blockingTaskIds ?? [], task.unresolvedBlockerIds ?? [])
    };
  }
  return null;
}

/**
 * 示例数据的原句：fixture 里的等待/阻塞原因本来就是可读说明（不是枚举码），直接呈现；
 * 缺省时仍按状态给出确切兜底，不把空格当成「没有原因」。
 */
export function sampleReason(status: string, waitingReason: string | null, blockedReason: string | null): {
  readonly short: string; readonly detail: string } | null {
  if (status === "WAITING") {
    return { short: waitingReason ?? "等待原因尚未登记", detail: waitingReason ?? "示例数据没有登记这条任务的等待原因。" };
  }
  if (status === "BLOCKED") {
    return { short: blockedReason ?? "示例未提供阻塞依据", detail: blockedReason ?? "示例数据没有登记这条任务的阻塞依据。" };
  }
  return null;
}
