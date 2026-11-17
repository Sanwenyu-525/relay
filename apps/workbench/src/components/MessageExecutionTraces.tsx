import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";

import type { RelayAssistMemoryCaptureStatus, RelayAssistMessage,
  RelayAssistSkillInvocationStatus } from "../api/dtos/assist";

const captureLabels: Record<RelayAssistMemoryCaptureStatus, string> = {
  PENDING: "记忆待处理",
  RUNNING: "正在整理记忆",
  SUCCEEDED: "已保存记忆",
  EMPTY: "无需保存",
  FAILED: "记忆保存失败",
  CANCELLED: "记忆捕获已取消",
};

const skillLabels: Record<RelayAssistSkillInvocationStatus, string> = {
  REQUESTED: "等待执行",
  RUNNING: "执行中",
  SUCCEEDED: "执行成功",
  FAILED: "执行失败",
  CANCELLED: "已取消",
};

function timeLabel(value: string | null): string {
  if (value === null) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit" }).format(date);
}

function captureSummary(saved: number, failed: number, taskCount: number): string | null {
  if (saved > 0 && failed > 0) return `部分保存：${saved} 条已保存，${failed} 条失败`;
  if (saved > 1) return `已保存 ${saved} 条记忆`;
  if (taskCount > 1) return `${taskCount} 个捕获任务`;
  return null;
}

/**
 * 聊天消息下的执行轨迹（2026-11-15 P1）。
 *
 * 两类事实都来自服务端持久化账本，不猜助手正文：
 * - 长期记忆捕获任务（`memory_capture_tasks` 聚合后的单状态）；
 * - 第一方 Skill 的真实执行事件（0169），普通工具调用不会出现在这里。
 * 默认折叠，避免每条消息挂一排状态；没有对应事实时整块不渲染。
 */
export function MessageExecutionTraces({ message }: { readonly message: RelayAssistMessage }) {
  if (message.role !== "ASSISTANT") return null;
  const capture = message.memoryCapture ?? null;
  const invocations = message.skillInvocations ?? [];
  if (capture === null && invocations.length === 0) return null;
  return <div className="assist-execution-traces">
    {capture !== null && <details className="tech-details chat-disclosure assist-capture-trace"
      data-status={capture.status}
      data-testid={`assist-memory-capture-${message.id}`}>
      <summary>
        <span className="chat-disclosure-chevron" aria-hidden="true"><ChevronRight /></span>
        <span>长期记忆</span>
        <span className="assist-trace-status" data-status={capture.status}>
          {captureLabels[capture.status]}
        </span>
        {capture.status === "FAILED" && <span className="assist-trace-hint">可在记忆管理页查看失败原因</span>}
      </summary>
      <div className="assist-trace-body">
        {captureSummary(capture.savedCount, capture.failedCount, capture.taskCount) !== null &&
          <p className="helper-text">{captureSummary(capture.savedCount, capture.failedCount,
            capture.taskCount)}</p>}
        <ul className="assist-trace-list">
          {capture.tasks.map((task) => <li key={task.id} data-status={task.status}>
            <span className="assist-trace-kind">{task.kind === "EXPLICIT" ? "明确记住" : "自动提取"}</span>
            <span className="assist-trace-status" data-status={task.status}>{captureLabels[task.status]}</span>
            <span className="assist-trace-meta">尝试 {task.attempts}/{task.maxAttempts}</span>
            {task.completedAt !== null && <span className="assist-trace-meta">完成于 {timeLabel(task.completedAt)}</span>}
            {task.errorKind !== null && <span className="assist-trace-error">
              {task.errorKind}{task.lastError === null ? "" : ` · ${task.lastError}`}</span>}
          </li>)}
        </ul>
        {(capture.status === "FAILED" || capture.status === "SUCCEEDED") &&
          <Link className="inline-link" to="/memory">打开记忆管理页</Link>}
      </div>
    </details>}
    {invocations.length > 0 && <div className="assist-skill-traces" data-testid={`assist-skill-traces-${message.id}`}>
      {invocations.map((invocation) => <details key={invocation.id}
        className="tech-details chat-disclosure assist-skill-trace" data-status={invocation.status}>
        <summary>
          <span className="chat-disclosure-chevron" aria-hidden="true"><ChevronRight /></span>
          <span>调用 Skill · {invocation.skillId}</span>
          <span className="assist-trace-status" data-status={invocation.status}>
            {skillLabels[invocation.status]}
          </span>
        </summary>
        <div className="assist-trace-body">
          <p className="helper-text">版本 {invocation.skillVersion} · 摘要 {invocation.skillSha256.slice(0, 12)}</p>
          <p className="helper-text">调用时间 {timeLabel(invocation.requestedAt)} · 开始 {timeLabel(invocation.startedAt)}</p>
          {invocation.inputSummary !== null && <p className="helper-text">输入摘要：{invocation.inputSummary}</p>}
          {invocation.outputSummary !== null && <p className="helper-text">输出摘要：{invocation.outputSummary}</p>}
          {invocation.errorKind !== null && <p className="assist-trace-error" role="alert">
            失败原因：{invocation.errorKind}{invocation.errorDetail === null ? "" : ` · ${invocation.errorDetail}`}</p>}
        </div>
      </details>)}
    </div>}
  </div>;
}
