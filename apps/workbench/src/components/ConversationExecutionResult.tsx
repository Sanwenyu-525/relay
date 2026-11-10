import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient, RelayCompletionEvidence, RelayRun, RelayTaskDetail } from "../api/relayClient";
import { RelayContractError } from "../api/core/errors";
import { describeLiveError } from "../lib/liveErrors";

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const labels: Record<string, string> = { CREATED: "正在准备执行", CONTEXT_BUILDING: "正在准备上下文",
  PLANNING: "正在整理执行步骤", RUNNING: "正在执行", VERIFYING: "正在核对成果",
  RETRYING: "正在修正成果", WAITING_APPROVAL: "等待人工验收或批准", PAUSED: "执行已暂停",
  FAILED: "执行失败，请查看执行记录", CANCELLED: "执行已取消", COMPLETED: "执行已结束，任务完成结果待核对" };

/** CHAT-EXECUTION-RESULT-20261105：只读原 Task/Run/完成凭据，不用助手回复状态代替业务完成。 */
export default function ConversationExecutionResult({ client, taskId, runId }: {
  client: RelayApiClient; taskId: string; runId: string;
}) {
  const [result, setResult] = useState<{ run: RelayRun; task: RelayTaskDetail;
    completion: RelayCompletionEvidence | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResult(null); setError(null);
    async function read() {
      try {
        const [run, task] = await Promise.all([client.getRun(runId), client.getTask(taskId)]);
        if (!active) return;
        if (run.id !== runId || run.taskId !== taskId || task.id !== taskId) {
          throw new RelayContractError("执行结果与原任务不匹配，请重新核对。");
        }
        // CHAT-REOPEN-HISTORY-20261105：历史身份从原 Run 读取，不追随 Task 的下一轮完成指针。
        const completionId = run.completionId ?? (task.status === "DONE" ? task.currentCompletionId : null);
        const completion = completionId ? await client.getCompletionEvidence(completionId) : null;
        if (!active) return;
        if (completion !== null && (completion.completionId !== completionId ||
            completion.taskId !== taskId || completion.verificationSession?.runId !== runId ||
            (completion.isCurrent && (task.status !== "DONE" || task.currentCompletionId !== completionId)) ||
            (!completion.isCurrent && run.completionId !== completionId))) {
          throw new RelayContractError("完成凭据与这次执行不一致，请查看原任务核对。");
        }
        setResult({ run, task, completion }); setError(null);
        if (!terminal.has(run.status)) timer = setTimeout(() => void read(), 1500);
      } catch (caught) {
        if (active) { setResult(null); setError(describeLiveError(caught).message); }
      }
    }
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [client, taskId, runId, retry]);
  return <section className="execution-summary" data-testid={`conversation-execution-result-${runId}`}
    data-run-id={runId} data-task-id={taskId} data-status={result?.task.status}
    data-completion-id={result?.completion?.completionId}
    data-completion-current={result?.completion?.isCurrent} aria-live="polite">
    {error !== null ? <><p className="action-error" role="alert">{error}</p>
      <button className="text-link" type="button" onClick={() => setRetry((value) => value + 1)}>重新读取执行结果</button></>
      : <p className="execution-summary-stage" role="status">{result === null ? "正在读取执行结果…"
        : result.completion !== null ? result.completion.isCurrent ? "任务已完成，成果与完成凭据已保存"
          : result.task.status === "DONE" ? "本次执行已完成；任务已有新的完成凭据"
            : "本次执行已完成；任务已重开，历史凭据仍保留"
          : labels[result.run.status] ?? result.run.status}</p>}
    <div className="form-actions">
      <Link className="text-link" to={`/tasks/${taskId}?tab=artifacts`}>查看成果</Link>
      <Link className="text-link" to={`/runs/${runId}`}>查看执行</Link>
      {/* TASK-ACCEPTANCE-SHORTCUT-20261106：只定位原 Run 返回的确切请求，不让用户在全局队列寻找。 */}
      {result?.run.status === "WAITING_APPROVAL" && result.run.blockingReviewIds.map((reviewId, index) =>
        <Link className="text-link" key={reviewId} to={`/reviews?id=${encodeURIComponent(reviewId)}`}>
          处理本次待办{result.run.blockingReviewIds.length > 1 ? ` ${index + 1}` : ""}</Link>)}
      {result?.completion && <Link className="text-link"
        to={`/completion-records/${result.completion.completionId}`}>{result.completion.isCurrent
          ? "查看完成凭据" : "查看历史完成凭据"}</Link>}
    </div>
  </section>;
}
