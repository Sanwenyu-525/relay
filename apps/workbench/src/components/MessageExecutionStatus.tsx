import { useEffect, useState } from "react";

import type { RelayActivityItem, RelayExecutionActivityMessage } from "../api/dtos/assist";
import "./MessageExecutionStatus.css";

function elapsedLabel(since: string | null, now: number): string {
  if (since === null) return "";
  const started = Date.parse(since);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function activityLabel(activity: RelayActivityItem): string {
  if (activity.kind === "MODEL_CALL") {
    if (activity.view === "RECEIVING_TEXT") return "模型调用 · 正在接收回复";
    if (activity.view === "WAITING_TEXT") return "模型调用 · 已响应，等待文本";
    if (activity.view === "WAITING_RESPONSE") return "模型调用 · 等待响应";
    if (activity.view === "COMPLETED") return "模型调用 · 已完成";
    if (activity.view === "FAILED") return "模型调用 · 失败";
    return "模型调用";
  }
  if (activity.kind === "DELEGATION") {
    const role = activity.delegationRole === "REVIEW" ? "独立审查" : "调查";
    return `子 Agent · ${role} · ${activity.view === "SUCCEEDED" ? "已完成"
      : activity.view === "FAILED" ? "失败" : activity.view === "RUNNING" ? "运行中" : "排队"}`;
  }
  if (activity.kind === "TODO_WRITE") return "更新待办清单";
  if (activity.kind === "TOOL_CALL") {
    const name = activity.toolName ?? "工具";
    if (activity.recovery?.disposition === "CONFIRMED_SUCCESS") return `${name} · 已确认成功`;
    if (activity.recovery?.disposition === "CONFIRMED_FAILURE") return `${name} · 已确认失败`;
    if (activity.recovery?.disposition === "CONFIRMED_NOT_EXECUTED") return `${name} · 未执行`;
    if (activity.recovery?.disposition === "UNRESOLVED_OPEN") {
      // 在途动作只是还没关闭：PREPARED / WAITING_APPROVAL / 派发中都不是结论。
      if (activity.recovery.operationStatus === "WAITING_APPROVAL") return `${name} · 等待审批`;
      return activity.terminal ? `${name} · 动作未关闭，结果未决` : `${name} · 正在执行`;
    }
    if (activity.recovery?.disposition === "NO_OPERATION") return `${name} · 未执行`;
    return `${name} · 结果待核对`;
  }
  return activity.kind;
}

function activityTone(activity: RelayActivityItem): "active" | "wait" | "success" | "error" | "neutral" {
  if (activity.recovery?.disposition === "CONFIRMED_SUCCESS") return "success";
  if (activity.recovery?.disposition === "CONFIRMED_FAILURE") return "error";
  if (activity.recovery?.disposition === "CONFIRMED_NOT_EXECUTED" ||
      activity.recovery?.disposition === "NO_OPERATION") return "neutral";
  // 正常在途的未关闭动作不是「待核对」，只有终态仍留着的才升级为警告。
  if (activity.recovery?.disposition === "UNRESOLVED_OPEN") {
    return activity.terminal ? "wait" : "active";
  }
  if (activity.view === "FAILED") return "error";
  if (activity.view === "SUCCEEDED") return "success";
  if (activity.view === "UNKNOWN" || activity.recovery?.reconcileRequired === true) return "wait";
  return activity.terminal ? "neutral" : "active";
}

/**
 * ENG-OBS-02 P0-C：消息级的真实执行状态与可展开过程。
 *
 * 所有文字只来自服务端 activity 快照：phase、activities、recovery 和 gaps。
 * 没有可确认 phase 时不渲染；不编造“正在读取某文件”。
 */
export function MessageExecutionStatus({ activity, animate = true }: {
  activity: RelayExecutionActivityMessage;
  /** 同一消息的另一块（工具轨迹）已接手主进度动效时，这里只保留静态状态点。 */
  animate?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const active = activity.status === "PENDING" || activity.status === "RUNNING";
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const items = activity.activities ?? [];
  const unresolved = activity.gaps.length;
  const phaseTone = activity.phase.tone;
  return <section className="message-execution-status" data-testid="message-execution-status"
    data-tone={phaseTone} data-view={activity.phase.view} data-active={active}
    data-animate={animate}>
    <p className="message-execution-status__phase">
      <span className="message-execution-status__dot" aria-hidden="true" />
      <span>{activity.phase.detail}</span>
      {active && activity.phase.since !== null &&
        <span className="message-execution-status__elapsed">{elapsedLabel(activity.phase.since, now)}</span>}
      {unresolved > 0 && <span className="message-execution-status__gap">{unresolved} 项待核对</span>}
    </p>
    {(items.length > 0 || activity.runSummary !== null) &&
      <details className="message-execution-status__details">
      <summary>
        查看执行过程（{items.length + (activity.runSummary === null ? 0 : 1)} 项）
        <span className="message-execution-status__counts">
          模型 {activity.activityCounts.modelCalls} · 工具 {activity.activityCounts.toolCalls}
          {activity.activityCounts.todoWrites > 0 ? ` · 待办 ${activity.activityCounts.todoWrites}` : ""}
          {activity.activityCounts.delegations > 0 ? ` · 子 Agent ${activity.activityCounts.delegations}` : ""}
        </span>
      </summary>
      <ol className="message-execution-status__list">
        {activity.runSummary !== null && <li data-kind="RUN" data-tone="neutral">
          <span>执行 Run · {activity.runSummary.status}</span>
          {activity.runSummary.currentStepKind !== null &&
            <code>{activity.runSummary.currentStepKind}</code>}
          {activity.runSummary.waitReason !== null &&
            <span>等待 {activity.runSummary.waitReason}</span>}
        </li>}
        {items.map((item) => <li key={item.activityId} data-tone={activityTone(item)}
          data-kind={item.kind}>
          <span>{activityLabel(item)}</span>
          {item.toolName !== undefined && <code>{item.toolName}</code>}
        </li>)}
      </ol>
    </details>}
    {activity.processEvidence === "UNKNOWN" &&
      <p className="message-execution-status__evidence">历史数据没有可核对的过程记录。</p>}
  </section>;
}
