import type { DecimalRevision } from "../../types";

/**
 * 自然语言状态维护（总纲 §0.8.1）：一条原用户消息对应一次状态维护请求，
 * 请求下挂若干条类型化变更。这里只是回执投影，不复制业务事实：
 * 目标、知识、决策、任务、计划、阻塞仍各归原 Owner，授权来源永远是原用户消息。
 */

/** 逐条类型化变更：每条自带固定 command_id 与变更前后引用，撤回按逆序补偿。 */
export interface RelayStateMaintenanceChange {
  readonly ordinal: number;
  readonly changeKind: string;
  readonly commandId: string;
  readonly status: string;
  readonly beforeRef: Readonly<Record<string, unknown>> | null;
  readonly afterRef: Readonly<Record<string, unknown>> | null;
  readonly error: Readonly<Record<string, unknown>> | null;
}

/** 需要用户决定的连带承诺：非空时不得自动应用，必须先取得人的决定。 */
export interface RelayStateMaintenanceDecisionRequired {
  readonly summary: string;
  readonly question: string;
  readonly affected: readonly string[];
  /** null = 整组都在等；数组 = 只有这些序号在等，独立修改照常生效。 */
  readonly blockedChanges: readonly number[] | null;
}

/**
 * 状态维护请求投影。
 * decision / status / candidateStatus 等枚举服务端开放扩展，解析层不校验词表、
 * 保留原串；中文化由展示层按 labels 回退处理。
 */
export interface RelayStateMaintenanceRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly sourceMessageId: string;
  readonly projectId: string;
  readonly decision: string;
  readonly status: string;
  readonly candidateStatus: string;
  readonly questions: readonly string[];
  readonly changes: readonly RelayStateMaintenanceChange[] | null;
  readonly decisionRequired: RelayStateMaintenanceDecisionRequired | null;
  /** 请求行固化的撤回命令身份：撤回只接受它，客户端不新造身份。 */
  readonly undoCommandId: string;
  readonly revision: DecimalRevision;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 应用/撤回的结果：与请求投影同源；changes 为 null 表示该组没有逐条事实可展示。 */
export interface RelayStateMaintenanceApplyResult {
  readonly requestId: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly changes: readonly RelayStateMaintenanceChange[] | null;
  readonly undoCommandId: string;
}

/** 撤回事前预检的一条补偿计划项：能不能撤、为什么、撤回后会保留什么。 */
export interface RelayUndoPlanItem {
  readonly changeId: string;
  readonly ordinal: number;
  readonly changeKind: string;
  readonly commandId: string;
  readonly withdrawable: boolean;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly impact: string | null;
}

/**
 * 撤回事前预检方案（只读）：整组里有不可撤回项时，服务端一项都不执行，
 * 先把具体范围、原因和影响交回用户；plan_digest 绑定原变更与当前依赖，
 * 确认范围时回传，事实变化即失效。
 */
export interface RelayUndoPlan {
  readonly requestId: string;
  readonly undoCommandId: string;
  readonly planDigest: string;
  readonly fullyWithdrawable: boolean;
  readonly blockedCount: number;
  readonly stateRevision: DecimalRevision;
  readonly items: readonly RelayUndoPlanItem[];
}
