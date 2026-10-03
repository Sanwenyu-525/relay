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
  return <section className={`execution-summary execution-summary--${request.decision.toLowerCase()}`}
    data-testid="execution-summary" data-decision={request.decision} data-status={request.status}
    aria-live="polite">
    <p className="execution-summary-stage" data-testid="execution-summary-stage">
      {STATUS_LABELS[request.status] ?? request.status}
    </p>
    {request.decision === "PREPARE" && <>
      <p className="execution-summary-title" data-testid="execution-summary-title">{request.title}</p>
      <p className="helper-text">{request.objective}</p>
      <p className="helper-text" data-testid="execution-summary-root">当前目录：{request.rootPath}</p>
      <div className="form-actions">
        {request.status === "READY" && <button className="primary-button" type="button"
          data-testid="execution-start" disabled={busy} onClick={() => onApply(request.requestId)}>
          {busy ? "正在建立任务" : "按这个执行"}</button>}
        {request.taskId !== null && <button className="secondary-button" type="button"
          data-testid="execution-open-task" onClick={() => onOpenTask(request.taskId as string)}>
          查看任务 {request.taskId.slice(0, 8)}</button>}
      </div>
      <p className="helper-text">开始执行不代表已完成：写入文件与运行检查仍会各自请求一次批准。</p>
    </>}
    {request.decision === "CLARIFY" && <p className="execution-summary-question"
      data-testid="execution-clarify">{request.questions[0] ?? "这次要处理的具体内容是什么？"}</p>}
    {request.decision === "DISCUSS" && <p className="helper-text">这条消息按普通讨论处理，没有创建任务。</p>}
    {error !== null && <p className="action-error" role="alert">{error}</p>}
  </section>;
}
