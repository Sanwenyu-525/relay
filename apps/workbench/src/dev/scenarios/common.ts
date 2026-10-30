import type {
  Scenario, ScenarioCheck, ScenarioConditions, ScenarioInteraction, ScenarioStateKind,
  ScenarioStep, LabHost, ScenarioWorld
} from "../scenarioWorld";
import { emptyWorld } from "../scenarioWorld";
import type { RelaySessionToolCall, RelaySessionToolCalls } from "../../api/dtos/assist";
import { MOCK, assistantMessage, sessionTrace, userMessage } from "../scenarioFixtures";

/**
 * 场景目录的公共零件：选择器、断言工厂与最小场景构造。
 *
 * 断言只写「界面上必须成立的事实」，不写实现细节的偶然形状；同一份数据被
 * 界面运行器与 Playwright 共用，避免「演示里看着对、测试里是另一套」。
 */

/**
 * `RunToolTrajectoryPanel` 折叠时到底显示哪几行（头/省略标记/尾）。
 *
 * 与产品里 `headTailCap` + `[...head, marker, ...tail]` 同规则，因此「折叠态确实把头尾两段
 * 显示出来了」这条可以直接断言，而不是只断言有一句说明文字。改产品那一处时这条会失效。
 */
export function headTailPreview(total: number, maxLines: number, sample: (line: number) => string):
  readonly string[] {
  if (total <= maxLines) {
    return Array.from({ length: total }, (_, index) => sample(index));
  }
  const headLines = Math.ceil(maxLines / 2);
  const tailLines = maxLines - headLines;
  const hidden = total - maxLines;
  return [...Array.from({ length: headLines }, (_, index) => sample(index)),
    `… 省略 ${hidden} 行 …`,
    ...Array.from({ length: tailLines }, (_, index) => sample(total - tailLines + index))];
}

/** 夹具行的身份：与 `sessionCall` / `runCall` 的 `mock-call-NN` / `mock-run-call-NN` 同一规则。 */
export const sessionCallId = (index: number): string => `mock-call-${String(index + 1).padStart(2, "0")}`;
export const runCallId = (index: number): string => `mock-run-call-${String(index + 1).padStart(2, "0")}`;

/** 会话行的可见文本（折叠 + 已挂载的第三层）：用于「同一身份只渲染一行」这类结构检查。 */
export const SESSION_ROW = ".activity-panel-list .activity-item";
/** Run 轨迹面板里的调用卡片。 */
export const RUN_ROW = ".trajectory-call";

/** 一行「看得见」＝已挂载且不在收起的 `<details>` 里；由 `runChecks` 按真实可见性判定。 */
export function visibleRow(label: string, callId: string): ScenarioCheck {
  return { label, kind: "visibleRow", selector: sel.call(callId) };
}

export const tid = (value: string): string => `[data-testid="${value}"]`;

/** 局部行的键：已落账/意图行按调用身份，预览行按模型调用身份 + 序号（与 `localFileDiffRows` 同规则）。 */
export const ledgerKey = (round: number, callId: string, path: string): string =>
  `${round}:${callId}:${path}`;
export const previewKey = (round: number, modelCallId: string, ordinal: number, path: string): string =>
  `${round}:${modelCallId}:${ordinal}:${path}`;

const assistant = MOCK.assistantMessageId;

/** 会话侧：真实组件已经带稳定 testid，这里只做名字拼接，不新造选择器语言。 */
export const sel = {
  message: (id: string = assistant) => `[data-message-id="${id}"]`,
  role: (role: "USER" | "ASSISTANT") => `.agent-message[data-role="${role}"]`,
  replyFinal: (id: string = assistant) => tid(`assist-reply-final-${id}`),
  replyDraft: (id: string = assistant) => tid(`assist-live-preview-${id}`),
  replyVerify: (id: string = assistant) => tid(`assist-reply-verify-${id}`),
  inflight: (id: string = assistant) => tid(`assist-inflight-${id}`),
  emptyReply: (id: string = assistant) => tid(`assist-empty-reply-${id}`),
  previewError: (id: string = assistant) => tid(`assist-preview-error-${id}`),
  /** 预览失败块里的重读入口：产品那一处没有 testid，只有这一个稳定类名。 */
  previewRetry: () => ".assist-preview-error .text-link",
  copy: (id: string = assistant) => tid(`assist-copy-${id}`),
  usage: (id: string = assistant) => tid(`assist-usage-${id}`),
  sources: (id: string = assistant) => tid(`assist-sources-${id}`),
  elapsed: (id: string = assistant) => tid(`assist-elapsed-${id}`),
  persona: () => tid("assist-persona-label"),
  status: () => ".agent-message-status",
  replyNote: () => ".assist-reply-note",
  replyBlock: () => ".assist-reply",
  /** SafeMarkdown 的根：正文排版类检查都落在这里，不去猜某一段的标签。 */
  markdown: () => tid("markdown-preview"),
  /** 宽表格自己的横向滚动容器（页面级不该跟着一起变宽）。 */
  tableScroll: () => ".markdown-preview__table-scroll",
  /** 代码块外壳与它自带的复制入口：产品这一处没有传 `testId`，只有稳定类名。 */
  codeBlock: () => ".msg-code",
  codeCopy: () => ".msg-code-copy",
  announce: (id: string = assistant) => tid(`assist-reply-announce-${id}`),
  verifyFinal: (id: string = assistant) => tid(`assist-verify-final-${id}`),
  providerError: () => tid("assist-provider-error"),
  recallNote: (recallId: string) => tid(`assist-recall-${recallId}`),
  recallAction: (id: string) => tid(`assist-recall-action-${id}`),
  recallError: (id: string) => tid(`assist-recall-error-${id}`),
  trace: (id: string = assistant) => tid(`session-round-trace-${id}`),
  traceToggle: () => tid("session-round-trace-toggle"),
  traceActivity: () => tid("session-round-trace-activity"),
  traceLoading: () => tid("session-round-trace-loading"),
  traceEmpty: (id: string = assistant) => tid(`session-round-trace-empty-${id}`),
  traceError: (id: string = assistant) => tid(`session-round-trace-error-${id}`),
  traceRetry: (id: string = assistant) => tid(`session-round-trace-retry-${id}`),
  traceRound: (round: number) => tid(`session-round-${round}`),
  traceRoundList: (id: string = assistant) => tid(`session-round-trace-list-${id}`),
  traceMore: (round: number) => tid(`session-round-more-${round}`),
  traceLess: (round: number) => tid(`session-round-less-${round}`),
  traceSpan: () => tid("session-round-trace-span"),
  call: (callId: string) => tid(`session-round-call-${callId}`),
  callToggle: (callId: string) => tid(`session-round-call-${callId}-toggle`),
  callDetail: (callId: string) => tid(`session-round-call-${callId}-detail`),
  /** 行下方常显的风险说明：产品这一处的名字是 `…-call-reason-<id>`，不是 `<id>-reason`。 */
  callReason: (callId: string) => tid(`session-round-call-reason-${callId}`),
  density: (value: "concise" | "standard" | "detailed") => tid(`session-round-trace-density-${value}`),
  detailArgs: (callId: string) => tid(`activity-detail-args-${callId}`),
  detailResult: (callId: string) => tid(`activity-detail-result-${callId}`),
  detailMeta: (callId: string) => tid(`activity-detail-meta-${callId}`),
  // Run 侧
  runPanel: () => tid("run-tool-trajectory"),
  runCounts: () => tid("trajectory-counts"),
  runEmpty: () => tid("trajectory-empty"),
  runError: () => tid("trajectory-error"),
  runLoading: () => tid("trajectory-loading"),
  runNoRun: () => tid("trajectory-no-run"),
  runRefresh: () => tid("trajectory-refresh"),
  runReviewsUnreadable: () => tid("trajectory-reviews-unreadable"),
  runStreamNote: () => tid("trajectory-stream-note"),
  runEvidenceNote: () => tid("trajectory-evidence-note"),
  runSourceRun: () => tid("trajectory-source-run"),
  runSourceUnavailable: () => tid("trajectory-source-unavailable"),
  runRound: (round: number) => tid(`trajectory-round-${round}`),
  runCall: (callId: string) => tid(`trajectory-call-${callId}`),
  runExpand: (callId: string) => tid(`trajectory-expand-${callId}`),
  runArgs: (callId: string) => tid(`trajectory-args-${callId}`),
  runResult: (callId: string) => tid(`trajectory-result-${callId}`),
  runPreview: (callId: string) => tid(`trajectory-preview-${callId}`),
  runHidden: (callId: string) => tid(`trajectory-hidden-${callId}`),
  runExecSummary: (callId: string) => tid(`trajectory-exec-summary-${callId}`),
  runGitNote: (callId: string) => tid(`trajectory-source-${callId}`),
  runTruncated: (callId: string) => tid(`trajectory-truncated-${callId}`),
  runNoResult: (callId: string) => tid(`trajectory-noresult-${callId}`),
  runFailure: (callId: string) => tid(`trajectory-failure-${callId}`),
  runApproval: (callId: string) => tid(`trajectory-approval-${callId}`),
  runUnsettled: (callId: string) => tid(`trajectory-unsettled-at-terminal-${callId}`),
  runReplayConflict: (callId: string) => tid(`trajectory-replay-conflict-${callId}`),
  summary: () => tid("execution-summary"),
  summaryError: () => tid("execution-summary-error"),
  summaryLoading: () => tid("execution-summary-loading"),
  summaryOpen: () => tid("execution-summary-open"),
  summaryActivities: () => tid("execution-activities"),
  /**
   * 摘要区的活动**行**本身。
   *
   * 不用 `[data-testid^="execution-activity-"]` 数行：那一档行的展开按钮叫
   * `execution-activity-<id>-toggle`，前缀选择会把它一起数进去，行数就虚高一倍。
   */
  summaryRows: () => ".execution-activities > .activity-item",
  summaryFailedRows: () => '.execution-activities > .activity-item[data-failed="true"]',
  summaryActivity: (callId: string) => tid(`execution-activity-${callId}`),
  summaryActivityToggle: (callId: string) => tid(`execution-activity-${callId}-toggle`),
  summaryActivityDetail: (callId: string) => tid(`execution-activity-${callId}-detail`),
  summaryReadResults: () => tid("execution-read-results"),
  summaryReadToggle: () => tid("execution-read-results-toggle"),
  summaryReadGroup: (toolName: string) => tid(`execution-read-group-${toolName}`),
  summaryWaitingApproval: () => tid("execution-waiting-approval"),
  summaryWaitingLink: () => tid("execution-waiting-approval-link"),
  summaryRead: (callId: string) => tid(`execution-read-${callId}`),
  diffList: () => ".local-file-diff-list",
  /**
   * 局部行的键原样进 testid：产品那四处（`ChatLocalFileDiff.tsx:98-147`）用的是未清洗的
   * `row.key`（含 `:` 与 `/`），只有 `id` / `aria-controls` 才做 `\w.-` 清洗。
   * 因此这里必须整键放进**带引号**的属性选择器，不做二次清洗——清洗过就选不中真实 DOM。
   */
  diffRow: (key: string) => tid(`local-file-diff-${key}`),
  diffToggle: (key: string) => tid(`local-file-diff-toggle-${key}`),
  diffBody: (key: string) => tid(`local-file-diff-body-${key}`),
  diffReason: (key: string) => tid(`local-file-diff-reason-${key}`),
  diffCapped: () => tid("local-file-diff-capped-note"),
  frozenDiff: () => tid("file-write-frozen-diff"),
  /** 实验室自己的外壳（不是产品 DOM）。 */
  labRoot: () => "[data-scenario-lab]",
  previewRoot: () => "[data-scenario-preview]",
  /** 预览区当前确实挂在某一档主题下（不是「有个开关」，而是「这一档生效了」）。 */
  labTheme: (value: "dark" | "light") => `[data-scenario-preview][data-theme="${value}"]`,
  /** 实验室的明暗开关本身。 */
  labThemeToggle: (value: "dark" | "light") => tid(`scenario-theme-${value}`),
} as const;

/* ---------------- 断言工厂 ---------------- */

export function visible(label: string, selector: string): ScenarioCheck {
  return { label, kind: "visible", selector };
}

export function gone(label: string, selector: string): ScenarioCheck {
  return { label, kind: "gone", selector };
}

export function count(label: string, selector: string, equals: number): ScenarioCheck {
  return { label, kind: "count", selector, equals };
}

export function atLeast(label: string, selector: string, equals: number): ScenarioCheck {
  return { label, kind: "atLeast", selector, equals };
}

export function text(label: string, selector: string, contains: string): ScenarioCheck {
  return { label, kind: "text", selector, contains };
}

export function notText(label: string, selector: string, contains: string): ScenarioCheck {
  return { label, kind: "notText", selector, contains };
}

export function attr(label: string, selector: string, name: string, value: string): ScenarioCheck {
  return { label, kind: "attr", selector, name, value };
}

export const noOverflow: ScenarioCheck = {
  label: "阅读列不产生页面级横向溢出", kind: "noOverflow"
};

export const leftEdgeAligned: ScenarioCheck = {
  label: "活动行动作词左缘对齐（同一套骨架）", kind: "leftEdgeAligned"
};

export const noDuplicateRows: ScenarioCheck = {
  label: "没有重复工具行（同一身份只渲染一次）", kind: "noDuplicateRows"
};

export function motionCount(label: string, equals: number): ScenarioCheck {
  return { label, kind: "motionCount", equals };
}

/**
 * 用户上滚之后阅读位置是否稳定：读上一次 `scrollUp` 记下的标记，与当前滚动位置比对。
 *
 * 没有先跑 `scrollUp` 时判**失败**——「没测到」不能记成「通过」。
 */
export const scrollStable: ScenarioCheck = {
  label: "上滚后阅读位置稳定：新内容不把我看的那一行顶走", kind: "scrollStable"
};

/** 停在当前帧先看一眼：多帧场景里「中途成立的事实」只能这样钉。 */
export function inspect(label: string, ...checks: readonly ScenarioCheck[]): ScenarioInteraction {
  return { kind: "inspect", label, then: checks };
}

/** 展开/收起的标准两步交互，B/C/D 系列共用。 */
export function toggleRow(callId: string, extra: readonly ScenarioCheck[] = []): readonly ScenarioInteraction[] {
  return [
    { kind: "click", selector: sel.callToggle(callId), label: `展开 ${callId} 的详情`,
      then: [visible("详情已挂载", sel.callDetail(callId)), ...extra] },
    { kind: "click", selector: sel.callToggle(callId), label: `收起 ${callId} 的详情`,
      then: [gone("详情已移除", sel.callDetail(callId)),
        visible("展开后入口仍在（点了不会消失）", sel.call(callId))] }
  ];
}

/** Run 轨迹面板的展开结果：同样验「展开后入口不消失」。 */
export function toggleRunRow(callId: string, extra: readonly ScenarioCheck[] = []): readonly ScenarioInteraction[] {
  return [
    { kind: "click", selector: sel.runExpand(callId), label: `展开 ${callId} 的结果`,
      then: [visible("参数已挂载", sel.runArgs(callId)),
        attr("展开态标记正确", sel.runExpand(callId), "aria-expanded", "true"), ...extra] },
    { kind: "click", selector: sel.runExpand(callId), label: `收起 ${callId} 的结果`,
      then: [gone("参数已移除", sel.runArgs(callId)),
        visible("展开后入口仍在（点了不会消失）", sel.runCall(callId)),
        attr("收起态标记正确", sel.runExpand(callId), "aria-expanded", "false")] }
  ];
}

/**
 * 终态消息的过程面板：默认折叠，**首次展开才读一次**。
 *
 * 因此「行有没有出现」这类断言必须放在这里的 `then` 里，而不是场景级静态断言——
 * 静态断言一个还没被读取的账本，等于要求界面预先长出不存在的内容。
 */
export function openTrace(messageId: string = assistant, extra: readonly ScenarioCheck[] = []):
  readonly ScenarioInteraction[] {
  return [
    { kind: "click", selector: sel.traceToggle(), label: "展开执行过程",
      then: [attr("展开态标记正确", sel.traceToggle(), "aria-expanded", "true"),
        visible("过程面板在场", sel.trace(messageId)), ...extra] },
    { kind: "click", selector: sel.traceToggle(), label: "收起执行过程",
      then: [attr("收起态标记正确", sel.traceToggle(), "aria-expanded", "false"),
        visible("收起后入口仍在（展开过不会让过程消失）", sel.traceToggle())] }
  ];
}

/** 摘要区命令行的展开/收起。 */
export function toggleSummaryRow(callId: string, extra: readonly ScenarioCheck[] = []): readonly ScenarioInteraction[] {
  return [
    { kind: "click", selector: sel.summaryActivityToggle(callId), label: `展开 ${callId} 的回执`,
      then: [visible("回执详情已挂载", sel.summaryActivityDetail(callId)), ...extra] },
    { kind: "click", selector: sel.summaryActivityToggle(callId), label: `收起 ${callId} 的回执`,
      then: [gone("回执详情已移除", sel.summaryActivityDetail(callId)),
        visible("展开后入口仍在（点了不会消失）", sel.summaryActivity(callId))] }
  ];
}

/** 局部增删行展开前后正文：读不到也不显示正文（CD-18）。 */
export function toggleDiffRow(key: string): readonly ScenarioInteraction[] {
  return [
    { kind: "click", selector: sel.diffToggle(key), label: `展开 ${key} 的前后文本`,
      then: [visible("正文区已挂载", sel.diffBody(key))] },
    { kind: "click", selector: sel.diffToggle(key), label: `收起 ${key} 的前后文本`,
      then: [gone("正文区已移除", sel.diffBody(key)),
        visible("展开后入口仍在（点了不会消失）", sel.diffRow(key))] }
  ];
}

/* ---------------- 世界补丁 ---------------- */

/**
 * 会话侧开局（在途）：一问一答 + 给定会话调用行。
 *
 * 在途消息默认展开并自动轮询，因此行级断言可以直接作为静态检查跑。
 */
export function liveWorld(...calls: readonly RelaySessionToolCall[]): Partial<ScenarioWorld> {
  const message = assistantMessage({ status: "RUNNING", content: null });
  return { messages: [userMessage("把这一次的过程说清楚"), message],
    traces: { [message.id]: sessionTrace([calls]) } };
}

/**
 * 会话侧开局（终态）：正文已落定，过程账本**首次展开才读一次**。
 *
 * 因此这一族的行级断言必须放在展开交互里；放在静态检查里等于要求界面预先长出不存在的内容。
 */
export function closedWorld(...calls: readonly RelaySessionToolCall[]): Partial<ScenarioWorld> {
  const message = assistantMessage({ status: "COMPLETED",
    content: "这一轮的过程结论已经写进正文。" });
  return { messages: [userMessage("把这一次的过程说清楚"), message],
    traces: { [message.id]: sessionTrace([calls]) } };
}

/** 一步只改需要的字段：`patch({ preview: livePreview({...}) })`。 */
export function patch(next: Partial<ScenarioWorld>): (world: ScenarioWorld) => ScenarioWorld {
  return (world) => ({ ...world, ...next });
}

/** 追加/替换某条助手消息的工具轮次账本（不动其它消息的账本）。 */
export function withTrace(trace: RelaySessionToolCalls,
  messageId: string = MOCK.assistantMessageId): (world: ScenarioWorld) => ScenarioWorld {
  return (world) => ({ ...world, traces: { ...world.traces, [messageId]: trace } });
}

/** 一步里要串多个变换：`chain(patch({ messages: … }), withTrace(trace))`。 */
export function chain(...sets: ((world: ScenarioWorld) => ScenarioWorld)[]):
  (world: ScenarioWorld) => ScenarioWorld {
  return (world) => sets.reduce((current, set) => set(current), world);
}

/** 带补丁的 step 简写：省去每处手写 `(world) => ({...world, …})`。 */
export function at(atMs: number, label: string, next: Partial<ScenarioWorld>): ScenarioStep {
  return { at: atMs, label, set: patch(next) };
}

/** 带补丁的单帧终态场景写法。 */
export function frame(label: string, next: Partial<ScenarioWorld>): ScenarioStep[] {
  return [{ at: 0, label, set: patch(next) }];
}

/* ---------------- 场景最小构造 ---------------- */

export interface ScenarioInput {
  readonly id: string;
  readonly title: string;
  readonly host: LabHost;
  readonly stateKind: ScenarioStateKind;
  readonly component: string;
  readonly note?: string;
  readonly uncovered?: string;
  readonly steps: readonly ScenarioStep[];
  readonly checks?: readonly ScenarioCheck[];
  readonly interactions?: readonly ScenarioInteraction[];
  readonly conditions?: ScenarioConditions;
}

/** 每个场景无条件补的三条底线检查：溢出、重复行、左缘对齐只在真有活动行时有意义。 */
const ALWAYS: readonly ScenarioCheck[] = [noOverflow];

export function make(input: ScenarioInput): Scenario {
  const checks: ScenarioCheck[] = [...(input.checks ?? []), ...ALWAYS];
  // 单步场景也必须能「看到初始状态」：至少一帧。
  const steps = input.steps.length > 0 ? input.steps : [step0(input.host)];
  return {
    id: input.id, title: input.title, host: input.host, stateKind: input.stateKind,
    component: input.component, note: input.note, uncovered: input.uncovered,
    steps, checks, interactions: input.interactions ?? [], conditions: input.conditions
  };
}

function step0(host: LabHost): ScenarioStep {
  return { at: 0, label: "初始状态", set: () => emptyWorld(host) };
}

export const sessionComponent = "AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow";
export const runPanelComponent = "RunToolTrajectoryPanel（Run 侧逐轮全量轨迹）";
export const runSummaryComponent = "ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行）";
export const diffComponent = "FileWriteFrozenDiffPanel（冻结计划文本差异）";
/**
 * 关联视图按产品自己的挂法组合两处真实出口（`AssistView.tsx:5426-5449`：消息行紧跟它那条
 * 用户消息的执行摘要），不新造第三种呈现。
 */
export const linkedComponent = "AssistMessageRow + ExecutionTrajectorySummary（会话侧与 Run 侧同一轮的两处投影）";
