import type {
  RelayRunToolCall,
  RelayRunToolCallFileChange,
  RelayRunToolCalls,
  RelaySessionToolCall,
  RelaySessionToolCalls,
} from "../api/dtos/assist";
import { failedToolResult } from "./toolResults";

/**
 * AI 活动的统一展示模型（2026-10-29「AI Response Experience V2」阶段 A）。
 *
 * 这个文件只做一件事：把两套本来就不同的业务事实——会话侧 `session_tool_calls` 与
 * Run 侧 `run_tool_calls`——投影成**同一种展示行**，让界面不必再为两个来源各写一套
 * 条件分支。它不合并两张表，也不合并两个状态机：
 *
 *   * 事实 Owner 不变。会话轮次的 Owner 仍是会话消息，Run 轨迹的 Owner 仍是 Run；
 *     `ActivityOwner` 只用来标注「这一行属于谁」，不参与任何写入。
 *   * 状态词表保持原样。会话侧有 `UNKNOWN`（结果未知），Run 侧有 `PREPARED` /
 *     `WAITING_APPROVAL`；这里不把它们归一成 running/success/error，`state` 原样透出，
 *     另给一个纯视觉用的 `tone`。
 *   * 不推断。`SETTLED` 不等于成功（可能 `outcome: FAILED`），`REJECTED` 不是执行失败，
 *     `ABANDONED` / `UNKNOWN` 永远不能显示成完成，`WAITING_APPROVAL` 是待决而不是在跑。
 *   * 身份唯一。行身份就是 `call.id`；重放与重复事件按 id 去重，绝不按列表位置归属。
 *   * 没有模型私有推理。本模型不产生任何「思考内容」，只有工具账本与时间。
 */

/** 活动类别：只用于选图标与分组，不承载业务语义。 */
export type ActivityCategory =
  | "READ"
  | "LIST"
  | "SEARCH"
  | "GIT"
  | "COMMAND"
  | "WRITE"
  | "DESKTOP"
  | "BROWSER"
  | "OTHER";

/** 这一行事实属于谁。只标注归属，不改变任何写入 Owner。 */
export type ActivityOwner =
  | { readonly kind: "SESSION_MESSAGE"; readonly sessionId: string; readonly messageId: string }
  | { readonly kind: "RUN"; readonly runId: string };

export type ActivitySource = "SESSION_TOOL_CALL" | "RUN_TOOL_CALL";

/** 两套词表的并集，原样保留，不做归一。 */
export type ActivityState =
  | "REQUESTED"
  | "PREPARED"
  | "WAITING_APPROVAL"
  | "SETTLED"
  | "REJECTED"
  | "ABANDONED"
  | "UNKNOWN";

/**
 * 视觉档。它是**唯一**允许被界面用来决定颜色的东西：
 *   * active    —— 已请求但还没结算（在跑）。
 *   * attention —— 等用户动手（审批），不是「正在执行」。
 *   * negative  —— 没有执行、已放弃或结果未知，不能给成功样式。
 *   * neutral   —— 已结算；是否成功另看 `detail.failed`。
 */
export type ActivityTone = "active" | "attention" | "negative" | "neutral";

export interface ActivityDetail {
  /** 服务端原样透出的参数；会话侧与 Run 侧同一份取值口径。 */
  readonly args: Readonly<Record<string, unknown>> | null;
  /** 已结算结果正文：优先人类可读内容，其余按 JSON 原样展开，不加工。 */
  readonly resultText: string | null;
  readonly resultTruncated: boolean;
  readonly omittedBytes: number | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** 工具自己的回执说了失败。它只描述这次调用，不代表整轮任务失败。 */
  readonly failed: boolean;
  readonly reason: string | null;
  readonly rejectionReason: string | null;
  readonly rejectionDetail: string | null;
  readonly operationId: string | null;
  readonly fileChanges: readonly RelayRunToolCallFileChange[];
  readonly resultDigest: string | null;
}

export interface ActivityItem {
  /** 行身份（`call.id`）。重放去重与 React key 都只认它。 */
  readonly id: string;
  readonly owner: ActivityOwner;
  readonly source: ActivitySource;
  readonly round: number;
  readonly ordinal: number;
  readonly toolName: string;
  readonly category: ActivityCategory;
  /** 人话动作词，如「读取文件」。取不到时回退工具名——宁可露英文名，也不编动作。 */
  readonly verb: string;
  /** 主要对象（路径、查询、检查名…）；取不到就是空串，不猜。 */
  readonly target: string;
  readonly state: ActivityState;
  readonly tone: ActivityTone;
  readonly stateText: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly elapsedMs: number | null;
  readonly detail: ActivityDetail;
}

/**
 * 工具名 → 用户能读懂的活动词。这是纯展示映射，不新增业务含义。
 * 取不到就原样显示工具名：露出一个英文名比编一个不存在的动作安全。
 */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  read_file: "读取文件",
  list_directory: "列目录",
  find_paths: "查找文件",
  search_text: "搜索内容",
  git_status: "查看 Git 状态",
  git_diff: "查看改动",
  git_log: "查看提交记录",
  run_check: "运行检查",
  apply_changeset: "修改文件",
  read_change_set: "读取变更集",
  computer_screenshot: "截屏",
  computer_get_windows: "枚举窗口",
  github_repo_view: "查询仓库",
  github_pr_list: "列出 PR",
  github_pr_view: "查看 PR",
  github_issue_list: "列出 Issue",
  github_issue_view: "查看 Issue",
  browser_list_pages: "列出页面",
  browser_read_page: "读取网页",
  browser_screenshot: "网页截图",
  browser_wait_for: "等待页面",
};

const CATEGORY_OF_TOOL: Readonly<Record<string, ActivityCategory>> = {
  read_file: "READ",
  read_change_set: "READ",
  list_directory: "LIST",
  find_paths: "SEARCH",
  search_text: "SEARCH",
  git_status: "GIT",
  git_diff: "GIT",
  git_log: "GIT",
  run_check: "COMMAND",
  apply_changeset: "WRITE",
  computer_screenshot: "DESKTOP",
  computer_get_windows: "DESKTOP",
  browser_list_pages: "BROWSER",
  browser_read_page: "BROWSER",
  browser_screenshot: "BROWSER",
  browser_wait_for: "BROWSER",
};

/** 折叠行点名对象：只取参数里那个真正说明「动的是哪里」的键，取不到就不猜。 */
const TARGET_KEYS = ["relative_path", "path", "pattern", "query", "check_id", "command",
  "operation_id"] as const;

export const READ_TOOLS: ReadonlySet<string> = new Set(["read_file", "list_directory", "find_paths", "search_text"]);
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["apply_changeset"]);
export const CHECK_TOOLS: ReadonlySet<string> = new Set(["run_check"]);

export function activityVerb(toolName: string): string {
  const known = TOOL_VERBS[toolName];
  if (known !== undefined) return known;
  if (toolName.startsWith("computer_")) return "桌面操作";
  if (toolName.startsWith("browser_")) return "浏览器操作";
  if (toolName.startsWith("github_")) return "查询 GitHub";
  return toolName;
}

export function activityCategory(toolName: string): ActivityCategory {
  const known = CATEGORY_OF_TOOL[toolName];
  if (known !== undefined) return known;
  if (toolName.startsWith("computer_")) return "DESKTOP";
  if (toolName.startsWith("browser_")) return "BROWSER";
  if (toolName.startsWith("github_")) return "OTHER";
  return "OTHER";
}

/** 从参数里取主要对象；只认已知键，取不到返回空串。 */
export function activityTargetOf(args: Readonly<Record<string, unknown>> | null): string {
  if (args === null) return "";
  for (const key of TARGET_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/**
 * 状态词。两侧词表不同，因此按来源分支；分支里只做翻译，不改判定。
 * 调用方不得把这里的文案改写成「成功」——已结算只是「有结算结果」。
 */
export function activityStateText(state: ActivityState, source: ActivitySource,
  detail: Pick<ActivityDetail, "failed" | "resultText" | "reason">): string {
  switch (state) {
    case "REQUESTED": return source === "RUN_TOOL_CALL" ? "已请求，尚未派发" : "已请求，尚未结算";
    case "PREPARED": return "执行中或结果未决，尚无结算结果";
    case "WAITING_APPROVAL": return "等待你批准";
    case "REJECTED": return "被拒绝，没有执行";
    case "ABANDONED": return "已放弃，没有结算结果";
    case "UNKNOWN": return "结果未知，需核对";
    default:
      if (source === "SESSION_TOOL_CALL") return "已结算";
      if (detail.resultText === null && detail.reason === null) return "已结算，结果未提供";
      return detail.failed ? "已结算但失败" : "已结算";
  }
}

/** 视觉档：只有这一处把状态折成颜色。 */
export function activityTone(state: ActivityState): ActivityTone {
  if (state === "WAITING_APPROVAL") return "attention";
  if (state === "REJECTED" || state === "ABANDONED" || state === "UNKNOWN") return "negative";
  if (state === "SETTLED") return "neutral";
  return "active";
}

/** 结算结果正文：与右栏轨迹同一套取值——优先人类可读内容，其余按 JSON 原样展开。 */
function resultTextOf(result: Readonly<Record<string, unknown>> | null): string | null {
  if (result === null) return null;
  if (typeof result.content === "string") return result.content;
  if (typeof result.stdout === "string") return result.stdout;
  const json = JSON.stringify(result, null, 2);
  return json === "{}" ? null : json;
}

function numberField(result: Readonly<Record<string, unknown>> | null, keys: readonly string[]): number | null {
  if (result === null) return null;
  for (const key of keys) {
    const value = result[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function flagField(result: Readonly<Record<string, unknown>> | null, keys: readonly string[]): boolean {
  if (result === null) return false;
  return keys.some((key) => result[key] === true);
}

function stringField(result: Readonly<Record<string, unknown>> | null, key: string): string | null {
  if (result === null) return null;
  const value = result[key];
  return typeof value === "string" ? value : null;
}

function elapsedBetween(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return to - from;
}

function build(source: ActivitySource, owner: ActivityOwner, call: {
  id: string; round: number; ordinal: number; toolName: string; status: ActivityState;
  args: Readonly<Record<string, unknown>>; detail: ActivityDetail;
  startedAt: string | null; endedAt: string | null;
}): ActivityItem {
  const tone = activityTone(call.status);
  return {
    id: call.id,
    owner,
    source,
    round: call.round,
    ordinal: call.ordinal,
    toolName: call.toolName,
    category: activityCategory(call.toolName),
    verb: activityVerb(call.toolName),
    target: activityTargetOf(call.args),
    state: call.status,
    tone,
    stateText: activityStateText(call.status, source, call.detail),
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    elapsedMs: elapsedBetween(call.startedAt, call.endedAt),
    detail: call.detail,
  };
}

const EMPTY_DETAIL: ActivityDetail = {
  args: null, resultText: null, resultTruncated: false, omittedBytes: null, exitCode: null,
  timedOut: false, cancelled: false, failed: false, reason: null, rejectionReason: null,
  rejectionDetail: null, operationId: null, fileChanges: [], resultDigest: null,
};

/**
 * 会话侧投影。会话轮次没有结果正文（该表不存），所以 `detail.resultText` 恒为 null：
 * 界面因此不会为一条会话行编出一段「读取结果」。
 */
export function sessionActivityItem(call: RelaySessionToolCall,
  owner: ActivityOwner): ActivityItem {
  return build("SESSION_TOOL_CALL", owner, {
    id: call.id, round: call.round, ordinal: call.ordinal, toolName: call.toolName,
    status: call.status, args: call.args,
    startedAt: call.requestedAt, endedAt: call.settledAt,
    detail: {
      ...EMPTY_DETAIL,
      args: call.args,
      reason: call.rejectionReason,
      rejectionReason: call.rejectionReason,
      rejectionDetail: call.rejectionDetail,
    },
  });
}

export function activityItemsFromSessionTrace(trace: RelaySessionToolCalls): readonly ActivityItem[] {
  return sessionActivityRounds(trace).flat();
}

/**
 * 按**服务端给的轮次分组**投影，而不是按 `call.round` 字段自己分组。
 *
 * 轮次的权威边界是 `rounds[i]` 这一层；`call.round` 只是行上的一个冗余读数，
 * 服务端在个别历史数据里可能与外层分组不一致。用外层分组渲染，才不会把两轮的行
 * 挤进同一轮（或让某一轮整段消失）。跨轮重复出现的行身份仍然只算一次。
 */
export function sessionActivityRounds(
  trace: RelaySessionToolCalls): readonly (readonly ActivityItem[])[] {
  const owner: ActivityOwner = {
    kind: "SESSION_MESSAGE", sessionId: trace.sessionId, messageId: trace.messageId,
  };
  const seen = new Set<string>();
  return trace.rounds.map((round) => round.calls.flatMap((call) => {
    // 同一行身份只出现一次：重放把一次调用说成两次就等于虚报步数。
    if (seen.has(call.id)) return [];
    seen.add(call.id);
    return [sessionActivityItem(call, owner)];
  }));
}

/** Run 侧投影。`fileChanges` 是写类工具的逐文件结算账本，原样带进第三层。 */
export function runActivityItem(call: RelayRunToolCall, owner: ActivityOwner): ActivityItem {
  const result = call.resultRef;
  return build("RUN_TOOL_CALL", owner, {
    id: call.id, round: call.round, ordinal: call.ordinal, toolName: call.toolName,
    status: call.status, args: call.args,
    startedAt: call.createdAt, endedAt: call.status === "SETTLED" ? call.updatedAt : null,
    detail: {
      args: call.args,
      resultText: resultTextOf(result),
      resultTruncated: result?.truncated === true,
      omittedBytes: numberField(result, ["omitted_bytes", "omittedBytes"]),
      exitCode: numberField(result, ["exit_code", "exitCode"]),
      timedOut: flagField(result, ["timed_out", "timedOut", "deadline_exceeded"]),
      cancelled: flagField(result, ["cancelled", "canceled", "aborted"]),
      failed: failedToolResult(result),
      reason: stringField(result, "reason"),
      rejectionReason: null,
      rejectionDetail: null,
      operationId: call.operationId,
      fileChanges: call.fileChanges,
      resultDigest: null,
    },
  });
}

export function activityItemsFromRunProjection(projection: RelayRunToolCalls): readonly ActivityItem[] {
  const owner: ActivityOwner = { kind: "RUN", runId: projection.runId };
  const seen = new Set<string>();
  const items: ActivityItem[] = [];
  for (const round of projection.rounds) {
    for (const call of round.calls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      items.push(runActivityItem(call, owner));
    }
  }
  return items;
}

export interface ActivitySummary {
  readonly total: number;
  /** 已请求/已准备，还没结算。 */
  readonly active: number;
  /** 等用户动手，不是「正在执行」。 */
  readonly waiting: number;
  /** 被拒或已放弃：工具根本没跑。 */
  readonly rejected: number;
  /** 结果未知，需要核对。 */
  readonly unknown: number;
  readonly settled: number;
  /** 已结算且回执说失败；它与「未执行」是两回事。 */
  readonly failed: number;
  /** 按动作词聚合的出现顺序与次数。 */
  readonly verbs: readonly (readonly [verb: string, count: number])[];
}

export function summarizeActivity(items: readonly ActivityItem[]): ActivitySummary {
  let active = 0; let waiting = 0; let rejected = 0; let unknown = 0;
  let settled = 0; let failed = 0;
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.state === "WAITING_APPROVAL") waiting += 1;
    else if (item.state === "REJECTED" || item.state === "ABANDONED") rejected += 1;
    else if (item.state === "UNKNOWN") unknown += 1;
    else if (item.state === "SETTLED") { settled += 1; if (item.detail.failed) failed += 1; }
    else active += 1;
    if (!counts.has(item.verb)) order.push(item.verb);
    counts.set(item.verb, (counts.get(item.verb) ?? 0) + 1);
  }
  return {
    total: items.length, active, waiting, rejected, unknown, settled, failed,
    verbs: order.map((verb) => [verb, counts.get(verb) ?? 0] as const),
  };
}

/** 折叠行的人话摘要：按出现顺序列出做过的事，同名动作合并成次数；超过三类只报类数。 */
export function activitySummaryText(verbs: ActivitySummary["verbs"]): string {
  const parts = verbs.slice(0, 3).map(([verb, count]) => `${verb} ${count} 次`);
  if (verbs.length > 3) parts.push(`等 ${verbs.length} 类`);
  return parts.join("、");
}

/**
 * 活动标题行的取值（第一层）。它只说「现在在做什么 / 这一轮做了什么」，不含耗时——
 * 耗时由消息 meta 行承担，两处同时报一个钟会让读者以为是两件事。
 *
 * 没有任何工具时：在途说「正在处理」，已提交未领取说「等待处理」；
 * 已确认没有轮次时返回空串，由调用方整块收起。
 */
export function activityHeadline(input: {
  readonly summary: ActivitySummary;
  readonly inFlight: boolean;
  /** PENDING：已提交、Worker 尚未领取。它还不是「正在处理」。 */
  readonly awaitingWorker: boolean;
  /** 最后一条仍在途的活动的动作词；没有就不报具体动作。 */
  readonly currentVerb?: string;
}): string {
  const { summary, inFlight, awaitingWorker, currentVerb } = input;
  if (inFlight) {
    if (awaitingWorker) return "等待处理";
    if (currentVerb === undefined || currentVerb === "") return "正在处理";
    // 「正在读取文件」来自**仍在途**的那一行，不是从已完成步骤里挑一个动词猜出来的。
    return `正在${currentVerb}`;
  }
  if (summary.total === 0) return "";
  return activitySummaryText(summary.verbs);
}

/** 次数文案：`3 项` / `2 步`。调用方决定用哪个量词。 */
export function activityCountText(summary: ActivitySummary, unit = "步"): string {
  return summary.total > 0 ? `${summary.total} ${unit}` : "";
}

/**
 * Run 侧的分类计数（沿用 `ExecutionTrajectorySummary` 既有口径，逐字保持输出）：
 * 检查先计数再判失败，因此「失败的检查」同时进 checks 与 failed 两栏——
 * 这不是重复计数，而是两个不同问题的答案：「跑过几次检查」「几项没成」。
 */
export interface RunActivityCounts {
  readonly reads: number;
  readonly writes: number;
  readonly checks: number;
  readonly failed: number;
  readonly running: number;
  readonly waiting: number;
  readonly unavailable: number;
}

export function summarizeRunToolCalls(projection: RelayRunToolCalls): RunActivityCounts {
  const counts = { reads: 0, writes: 0, checks: 0, failed: 0, running: 0, waiting: 0, unavailable: 0 };
  for (const round of projection.rounds) {
    const seen = new Set<string>();
    for (const call of round.calls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      if (call.status === "REJECTED" || call.status === "ABANDONED") { counts.failed += 1; continue; }
      if (call.status === "WAITING_APPROVAL") { counts.waiting += 1; continue; }
      if (call.status !== "SETTLED") { counts.running += 1; continue; }
      if (call.resultRef === null) { counts.unavailable += 1; continue; }
      if (CHECK_TOOLS.has(call.toolName)) counts.checks += 1;
      if (failedToolResult(call.resultRef)) { counts.failed += 1; continue; }
      if (READ_TOOLS.has(call.toolName)) counts.reads += 1;
      else if (WRITE_TOOLS.has(call.toolName)) counts.writes += 1;
    }
  }
  return counts;
}

/** 等待批准的动作身份；审批按 operation_id 与 ACTION_APPROVAL Review 对齐。 */
export function waitingOperationIds(projection: RelayRunToolCalls): string {
  const ids = new Set<string>();
  for (const round of projection.rounds) {
    for (const call of round.calls) {
      if (call.status === "WAITING_APPROVAL" && call.operationId !== null) ids.add(call.operationId);
    }
  }
  return [...ids].sort().join(",");
}

/** 毫秒 → 人话时长。不足一秒报毫秒，超过一分钟不再展开秒。 */
export function formatActivityDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/**
 * 执行过程标题行的相位（2026-10-29 V3）。
 *
 * 相位只描述**可验证的聚合状态**，不描述未来：没有总数就不报 `2/5`，没有剩余时间就不报
 * 「预计还需」。图标、颜色、文案三处都由它派生，因此不存在「图标说完成、文字说进行中」。
 */
export type ActivityPhase =
  /** 读取失败：入口仍在，给原因与重读。 */
  | "ERROR"
  /** 还没读到、也不是在跑：只说「展开查看」，不预判有没有工具。 */
  | "IDLE"
  /**
   * 消息已经结束，且确认这一轮没有调用任何工具。
   *
   * 只有在 `inFlight === false` 时才成立：在途且零记录不是「没有调用工具」，
   * 而是「还没开始调」——这两件事混成一个相位，就会在刚开始生成时宣布一个
   * 尚未成立的结论（V3 首版的真实缺陷）。
   */
  | "EMPTY"
  /** 在途，且尚未有任何工具记录。不是 EMPTY：模型随时可能开始调用。 */
  | "RUNNING_NO_TOOLS"
  /** 在途，且已有工具记录。 */
  | "RUNNING"
  /** 有调用在等用户批准——待决，不是正在执行。 */
  | "WAITING"
  /** 已结算且回执说失败。 */
  | "FAILED"
  /** 被准入拒绝或已放弃：工具根本没跑。 */
  | "REJECTED"
  /** 结果未知：既不能算成功也不能算失败。 */
  | "UNKNOWN"
  /** 消息已结束但仍有未结算的调用（REQUESTED / PREPARED）：不能说全部结清。 */
  | "UNSETTLED"
  /**
   * 全部结算且无例外。
   *
   * 它只说明「这一轮的工具都结清了」，**不是**「任务成功」「验证通过」。
   * 因此它单独占一个 `settled` 档，而不是复用 `success`。
   */
  | "SETTLED";

/**
 * 视觉档。`success` 目前没有任何相位使用：会话账本里没有验证证据，
 * 谁都不能凭「工具结算了」宣布成功。留这个档位是为了将来真有证据绑定时不必改类型。
 */
export type ActivityPhaseTone = "running" | "attention" | "danger" | "settled" | "success" | "neutral";

export interface ActivityHeaderState {
  readonly phase: ActivityPhase;
  readonly tone: ActivityPhaseTone;
  /** 标题固定为「执行过程」；相位不改变标题，只改变右侧的规模与状态。 */
  readonly title: string;
  /** 规模 + 状态，例如「3 项操作 · 已结束」。 */
  readonly meta: string;
}

const PHASE_TONE: Readonly<Record<ActivityPhase, ActivityPhaseTone>> = {
  ERROR: "danger",
  IDLE: "neutral",
  EMPTY: "neutral",
  RUNNING_NO_TOOLS: "running",
  RUNNING: "running",
  WAITING: "attention",
  FAILED: "danger",
  REJECTED: "danger",
  UNKNOWN: "attention",
  UNSETTLED: "attention",
  // 不是 success：结清 ≠ 成功。见 ActivityPhaseTone 的注释。
  SETTLED: "settled",
};

/** 例外优先于「已结束」：一轮里有一条没执行或结果不明，就不能只说已结束。 */
export function activityHeaderState(input: {
  readonly loaded: boolean;
  readonly error: boolean;
  readonly inFlight: boolean;
  /** PENDING：已提交、Worker 尚未领取。它比「正在执行」更早一档。 */
  readonly awaitingWorker?: boolean;
  readonly summary: ActivitySummary;
}): ActivityHeaderState {
  const { loaded, error, inFlight, awaitingWorker = false, summary } = input;
  const title = "执行过程";
  const phase = (value: ActivityPhase): ActivityHeaderState =>
    ({ phase: value, tone: PHASE_TONE[value], title, meta: metaOf(value, summary, awaitingWorker) });
  if (error) return phase("ERROR");
  if (!loaded) return phase(inFlight ? "RUNNING_NO_TOOLS" : "IDLE");
  // 在途压过一切：零记录不等于「没有调用工具」，异常也还没定论——整轮并没有结束。
  // 顺序很重要：这一条必须在 EMPTY 之前，否则刚开始生成时会宣布一个尚未成立的结论。
  if (inFlight) return phase(summary.total === 0 ? "RUNNING_NO_TOOLS" : "RUNNING");
  // 到这里消息已经结束：此刻「读到了零条」才是真的「这一轮没有调用工具」。
  if (summary.total === 0) return phase("EMPTY");
  if (summary.waiting > 0) return phase("WAITING");
  if (summary.failed > 0) return phase("FAILED");
  if (summary.rejected > 0) return phase("REJECTED");
  if (summary.unknown > 0) return phase("UNKNOWN");
  // X03：消息终态不等于工具账本终态。仍有 REQUESTED / PREPARED 无结算结果时，“已结束”会被读成全部结清。
  if (summary.active > 0) return phase("UNSETTLED");
  return phase("SETTLED");
}

function metaOf(phase: ActivityPhase, summary: ActivitySummary, awaitingWorker: boolean): string {
  const size = `${summary.total} 项操作`;
  switch (phase) {
    // 还没读到就报数字等于编数字；没读到也不知道有没有工具。
    case "ERROR": return "过程读取失败";
    case "IDLE": return "展开查看";
    case "EMPTY": return "本轮没有调用工具";
    // 在途且零记录：只报「还在跑」，不报规模——规模此刻就是 0，说出来会被读成结论。
    case "RUNNING_NO_TOOLS": return awaitingWorker ? "等待处理" : "正在执行";
    case "RUNNING":
      // 总数未知（未来还会不会有调用由模型决定），因此不报 2/5，只报已结算多少。
      return summary.settled > 0 ? `已结算 ${summary.settled} 项 · 正在执行` : "正在执行";
    case "WAITING": return `${size} · ${summary.waiting} 项等待你的批准`;
    case "FAILED": return `${size} · ${summary.failed} 项失败`;
    case "REJECTED": return `${size} · ${summary.rejected} 项未执行`;
    case "UNKNOWN": return `${size} · ${summary.unknown} 项待核对`;
    case "UNSETTLED": return `${size} · 仍有 ${summary.active} 项未结算`;
    default: return `${size} · 已结束`;
  }
}

/**
 * 这一轮实际占用的时间：最早一次请求到最晚一次结算。
 * 只要还有一行没有结算时刻就不报——半个区间会被读成「已经跑完了」。
 */
export function activitySpanMs(items: readonly ActivityItem[]): number | null {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (item.startedAt === null || item.endedAt === null) return null;
    const start = Date.parse(item.startedAt);
    const end = Date.parse(item.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    from = Math.min(from, start);
    to = Math.max(to, end);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return to - from;
}

/** 秒级人话时长：与消息 meta 行同一口径，避免同一个时长出现两种写法。 */
export function formatSpan(ms: number | null): string {
  if (ms === null) return "";
  const total = Math.max(0, Math.floor(ms / 1_000));
  if (total < 1) return "不到 1 秒";
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${String(total % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
}

