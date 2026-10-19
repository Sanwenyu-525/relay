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

const FILE_ACTION_LABELS = { CREATE: "新建", MODIFY: "修改", DELETE: "删除" } as const;

export default function ExecutionSummary({ execution, busy, onApply, onOpenTask, error, manualConfirm = false }: {
  execution: RelayConversationExecution | null;
  busy: boolean;
  onApply: (requestId: string) => void;
  onOpenTask: (taskId: string) => void;
  error: string | null;
  /**
   * 本设备选择了「生成计划后需要人工确认」。
   *
   * 服务端的 auto_start 只回答「候选就绪且可进入原应用入口」；是否自动启动由本设备
   * 偏好决定。为 true 时这次确认永远保留，按钮不因服务端标记而隐藏——同一个请求
   * 在两台设备上呈现不同入口，权限与准入判定不变。
   */
  manualConfirm?: boolean;
}) {
  if (execution === null && error === null) return null;
  if (execution === null) return <section className="execution-summary execution-summary--error"
    data-testid="execution-summary" role="alert">
    <p className="action-error">{error}</p></section>;
  const request = execution;
  // parse 层对旧服务端已经补了空数组；这里再兜一次，避免旧投影对象让摘要整段渲染失败。
  const fileChanges = request.fileChanges ?? [];
  const startable = STARTABLE.includes(request.status) &&
    request.candidateStatus === "READY" && request.runId === null;
  // 服务端已判定候选就绪时，按工作台 §18.2 可沿既有入口直接启动，不固定再点一次开始；
  // 本设备选择人工确认（或自动启动失败）时，按钮才作为确认 / 恢复入口出现。
  const autoStart = request.autoStart === true && !manualConfirm;
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
      {fileChanges.length > 0 && <>
        <ul className="execution-read-results" data-testid="execution-summary-files">
          {fileChanges.map((change) => <li key={`${change.action}:${change.path}`}
            data-testid="execution-summary-file">
            {FILE_ACTION_LABELS[change.action]} · {change.path}</li>)}
        </ul>
        {fileChanges.some((change) => change.action === "DELETE") &&
          <p className="helper-text" data-testid="execution-summary-delete-note">
            删除会在 Run 内按现有审批规则处理，需要确认时会在批准前停住。
          </p>}
      </>}
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
