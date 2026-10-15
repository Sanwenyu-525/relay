import type { DecimalRevision } from "../../types";

/**
 * 返回项目时的顶部接续卡（总纲 §0.8.1、工作台 §18.9）：当前事实、相对上次实际查看的变化、
 * 在途/阻塞/待验收计数持续可见。基线只来自用户确认过的查看进度，不凭时间猜测期间变化。
 */

/** 当前事实投影：所有计数与引用都来自服务端，前端不本地推导。 */
export interface RelayDailyContinuationCurrent {
  readonly stateRevision: DecimalRevision;
  readonly phaseKey: string | null;
  readonly nextActionTaskId: string | null;
  readonly openTaskIds: readonly string[];
  readonly openTaskCount: number;
  /** 任务集合超出租捕范围：新增/关闭无法逐项比对，不得显示成「没有变化」。 */
  readonly openTaskIdsTruncated: boolean;
  readonly waitingTaskCount: number;
  readonly blockedTaskCount: number;
  readonly unresolvedBlockerCount: number;
}

/** 上次已确认的查看进度基线；null 表示该用户对该项目还没有确认过查看。 */
export interface RelayDailyContinuationBaseline {
  readonly presentationId: string;
  readonly viewedStateRevision: DecimalRevision;
  readonly viewedFactRefs: Readonly<Record<string, unknown>>;
  readonly viewedPresentationSeq: DecimalRevision;
  readonly confirmedAt: string;
}

/** 相对基线的变化。字段缺失或基线不存在时整体为 null，前端不得据时间补算。 */
export interface RelayDailyContinuationDelta {
  readonly phaseChanged: boolean;
  readonly phaseBefore: string | null;
  readonly phaseAfter: string | null;
  readonly nextActionChanged: boolean;
  readonly nextActionBefore: string | null;
  readonly nextActionAfter: string | null;
  readonly newOpenTaskIds: readonly string[];
  readonly closedTaskIds: readonly string[];
  readonly unresolvedBlockerCountChanged: boolean;
  /** 任务维度无法逐项比对（任一侧超出租捕范围）：如实表达未知，不显示「无」。 */
  readonly openTasksUnknown: boolean;
}

/**
 * 本次读取的服务端展示身份：序号在同 State revision 下给出可信读取顺序，
 * 确认必须回显它；前端不再自造 presentation_id。
 */
export interface RelayDailyContinuationPresentation {
  readonly presentationId: string;
  readonly presentationSeq: DecimalRevision;
}

/** GET /projects/{id}/daily-continuation 与确认回执共用的投影。 */
export interface RelayDailyContinuation {
  readonly projectId: string;
  readonly current: RelayDailyContinuationCurrent;
  readonly baseline: RelayDailyContinuationBaseline | null;
  readonly delta: RelayDailyContinuationDelta | null;
  readonly presentation: RelayDailyContinuationPresentation;
  readonly revision: DecimalRevision;
}

/** 确认查看进度的命令载荷：viewed_fact_refs 必须回显本次实际展示给用户的内容。 */
export interface RelayDailyViewConfirmationInput {
  readonly commandId: string;
  readonly presentationId: string;
  readonly presentationSeq: DecimalRevision;
  readonly viewedStateRevision: DecimalRevision;
  readonly viewedFactRefs: Readonly<Record<string, unknown>>;
}

/**
 * 返回轻量核对记录（0069 / NLS-05、NLS-08、NLS-09）：
 * 有持久身份的只读核对结论——事实与证据没变由服务端复用同一记录，
 * 核对不启动进程、不伪造 Run、不自动修复。
 */
export interface RelayReturnReview {
  readonly reviewId: string;
  readonly projectId: string;
  readonly status: "APPLICABLE" | "CHANGED";
  readonly fingerprint: string;
  /** true = 这份事实与证据已核对过，本次按原记录复用，不产生第二次核对。 */
  readonly reused: boolean;
  readonly changedDimensions: readonly string[];
  readonly evidence: readonly { readonly taskId: string;
    readonly completionId: string; readonly applicable: boolean }[];
  readonly createdAt: string;
}
