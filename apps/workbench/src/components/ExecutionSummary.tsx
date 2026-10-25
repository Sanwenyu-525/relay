import type { RelayConversationExecution } from "../api/relayClient";
import "./FolderScope.css";

/**
 * 会话执行摘要（工作台 §43）。
 *
 * 呈现口径 2026-10-20 第二轮按用户反馈重写：这里只说**用户视角**的三件事——在做什么、
 * 卡在哪、要不要他决定。Task/Run/Operation/revision 属于内部执行载体，不再出现在
 * 日常路径上；需要排查时由执行详情与诊断承担。
 *
 * 推进责任在服务端：候选就绪后由 Worker 沿原请求推进，本组件不再提供「确认开始」按钮。
 * 唯一的按钮是「继续原请求」——只在服务端已经写回具体失败原因（缺连接、缺目录、
 * 会话已有在途执行）之后出现，属于修复前置条件后的显式重试，不是重复的开始确认。
 */
const STATUS_LABELS: Record<string, string> = {
  INTERPRETING: "正在整理这次请求",
  DISCUSSED: "按普通讨论继续",
  CLARIFY: "需要你补充一点信息",
  READY: "正在准备执行",
  TASK_PREPARED: "正在准备执行",
  DELEGATED: "正在执行",
  FAILED: "没有继续执行",
};

const FILE_ACTION_LABELS = { CREATE: "新建", MODIFY: "修改", DELETE: "删除" } as const;

/** 可以「继续原请求」的阶段：只有失败，而且是还没产生 Run 的失败。 */
const RESUMABLE_STATUSES = ["FAILED"];

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
  // parse 层对旧服务端已经补了空数组；这里再兜一次，避免旧投影对象让摘要整段渲染失败。
  const fileChanges = request.fileChanges ?? [];
  const failed = RESUMABLE_STATUSES.includes(request.status) && request.runId === null;
  // 服务端把自动推进失败的原因写在原请求的 questions 里（2026-10-20 第二轮）：
  // 用户关掉页面再回来时，这是唯一还能告诉他「缺哪个连接」的地方。
  const failureReason = failed ? (request.questions[0] ?? null) : null;
  return <section className={`execution-summary execution-summary--${request.decision.toLowerCase()}`}
    data-testid="execution-summary" data-decision={request.decision} data-status={request.status}
    data-auto-start={request.autoStart === true ? "true" : "false"} aria-live="polite">
    <p className="execution-summary-stage" data-testid="execution-summary-stage">
      {STATUS_LABELS[request.status] ?? request.status}
    </p>
    {request.decision === "PREPARE" && <>
      <p className="execution-summary-title" data-testid="execution-summary-title">{request.title ?? "原执行请求已保存"}</p>
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
            删除会在执行前单独请你确认。
          </p>}
      </>}
      {(failed || request.taskId !== null) && <div className="form-actions">
        {failed && <button className="secondary-button" type="button"
          data-testid="execution-start" disabled={busy} onClick={() => onApply(request.requestId)}>
          {busy ? "正在继续" : "继续原请求"}</button>}
        {request.taskId !== null && <button className="secondary-button" type="button"
          data-testid="execution-open-task" onClick={() => onOpenTask(request.taskId as string)}>
          查看执行详情</button>}
      </div>}
      {/* 失败原因是**事实**，不是提示：缺哪个连接、哪个目录、哪一步被挡住，原样呈现。 */}
      {failureReason !== null && <p className="action-error" role="alert"
        data-testid="execution-summary-failure">{failureReason}</p>}
      {/* 2026-10-24 用户指令：正常态不再宣告「不需要再确认一次」；只有 DELEGATED 的
          「何时会需要你决定」是用户无从预知的，保留。 */}
      {failureReason === null && !failed && request.status === "DELEGATED" && <p className="helper-text">
        文件内容在读取真实内容后决定；需要你决定时会在这里停下。
      </p>}
    </>}
    {request.decision === "CLARIFY" && <p className="execution-summary-question"
      data-testid="execution-clarify">{request.questions[0] ?? "这次要处理的具体内容是什么？"}</p>}
    {request.decision === "DISCUSS" && <p className="helper-text">这条消息按普通讨论处理，没有创建任务。</p>}
    {error !== null && <p className="action-error" role="alert">{error}</p>}
  </section>;
}
