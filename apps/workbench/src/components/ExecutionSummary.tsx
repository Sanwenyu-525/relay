import type { RelayConversationExecution } from "../api/relayClient";
import "./FolderScope.css";

/**
 * 工作台 §18.2 的紧凑执行摘要：本次要做什么、当前目录、准备中 / 执行中 / 等待处理。
 *
 * 摘要不是固定确认门，也不是授权来源；授权永远来自那条原用户消息。
 * Task READY 或 Run CREATED 都不会在这里被显示成「正在写文件」。
 */
const STATUS_LABELS: Record<string, string> = {
  INTERPRETING: "正在整理这次请求",
  DISCUSSED: "按普通讨论继续",
  CLARIFY: "需要你补充一点信息",
  READY: "候选已就绪，准备建立任务",
  TASK_PREPARED: "任务已建立，等待进入执行",
  DELEGATED: "已进入执行",
  FAILED: "准备失败",
};

/** 可以直接启动、还没有 Run、且此前没有报错的阶段。 */
const STARTABLE = ["READY", "TASK_PREPARED", "FAILED"];

export default function ExecutionSummary({ execution, busy, onApply, onOpenTask, error }: {
  execution: RelayConversationExecution | null;
  busy: boolean;
  onApply: (requestId: string) => void;
  onOpenTask: (taskId: string) => void;
  error: string | null;
}) {
  if (execution === null && error === null) return null;
  if (execution === null) return <section className="execution-summary execution-summary--error"
    data-testid="execution-summary" role="alert">
    <p className="action-error">{error}</p></section>;
  const request = execution;
  const startable = STARTABLE.includes(request.status) &&
    request.candidateStatus === "READY" && request.runId === null;
  // 服务端已判定为明确只读执行请求时，按 ADR-016 §18.2 直接沿既有入口启动，不再要求
  // 固定一次「按这个目标执行」；自动启动失败时按钮才作为人工恢复入口出现。
  // 写意图的请求仍保留这次确认（§18.4.1），两者不由本组件判断。
  const autoStart = request.autoStart === true;
  const showStart = startable && (!autoStart || error !== null);
  return <section className={`execution-summary execution-summary--${request.decision.toLowerCase()}`}
    data-testid="execution-summary" data-decision={request.decision} data-status={request.status}
    data-auto-start={autoStart ? "true" : "false"} aria-live="polite">
    <p className="execution-summary-stage" data-testid="execution-summary-stage">
      {STATUS_LABELS[request.status] ?? request.status}
    </p>
    {request.decision === "PREPARE" && <>
      <p className="execution-summary-title" data-testid="execution-summary-title">{request.title ?? "原执行目标已保存"}</p>
      {request.objective != null && <p className="helper-text">{request.objective}</p>}
      <p className="helper-text" data-testid="execution-summary-root">当前目录：{request.rootPath}</p>
      <div className="form-actions">
        {showStart && <button className="primary-button" type="button"
          data-testid="execution-start" disabled={busy} onClick={() => onApply(request.requestId)}>
          {busy ? "正在核对并接续" : request.status === "READY" ? "按这个目标执行" : "继续原请求执行"}</button>}
        {request.taskId !== null && <button className="secondary-button" type="button"
          data-testid="execution-open-task" onClick={() => onOpenTask(request.taskId as string)}>
          查看任务 {request.taskId.slice(0, 8)}</button>}
      </div>
      <p className="helper-text">现在确认的是目标与范围：文件内容会在执行时读取后决定。开始执行不代表已完成；动作按现有权限与本次范围授权准入，必要判断沿原审批入口处理。</p>
    </>}
    {request.decision === "CLARIFY" && <p className="execution-summary-question"
      data-testid="execution-clarify">{request.questions[0] ?? "这次要处理的具体内容是什么？"}</p>}
    {request.decision === "DISCUSS" && <p className="helper-text">这条消息按普通讨论处理，没有创建任务。</p>}
    {error !== null && <p className="action-error" role="alert">{error}</p>}
  </section>;
}
