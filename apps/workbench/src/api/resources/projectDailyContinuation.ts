import { RelayHttp } from "../core/http";
import { commandEnvelopeFrom } from "../parse/projects";
import { dailyContinuationFrom, returnReviewFrom } from "../parse/projectDailyContinuation";
import type { RelayDailyContinuation,
  RelayDailyViewConfirmationInput, RelayReturnReview } from "../dtos/projectDailyContinuation";

/**
 * 返回项目时的顶部接续卡读取：只读投影，不产生任何业务事实。
 * 基线只来自用户显式确认过的查看进度，这里不凭时间或本地记忆补算变化。
 */
export async function getDailyContinuation(http: RelayHttp,
  projectId: string): Promise<RelayDailyContinuation> {
  return dailyContinuationFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(projectId)}/daily-continuation`)));
}

/**
 * 「已查看」确认：只记录阅读进度（一次 presentation_id 确认一次），不是接受候选、
 * 接手或完成。viewed_fact_refs 必须是本次实际展示给用户的那份内容——确认针对这份
 * 已展示结果，不用稍后读取的新状态冒充已看。回执同样按投影核对项目归属。
 */
export async function confirmDailyView(http: RelayHttp, projectId: string,
  input: RelayDailyViewConfirmationInput): Promise<RelayDailyContinuation> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/projects/${encodeURIComponent(projectId)}/daily-view-confirmations`),
    { method: "POST", body: JSON.stringify({ command_id: input.commandId,
      presentation_id: input.presentationId,
      presentation_seq: input.presentationSeq,
      viewed_state_revision: input.viewedStateRevision,
      viewed_fact_refs: input.viewedFactRefs }) }, 200));
  const result = dailyContinuationFrom(envelope.result);
  if (result.projectId !== projectId) {
    throw new Error("查看确认回执与当前项目不匹配。");
  }
  return result;
}

/**
 * 返回轻量核对（NLS-05）：同一份事实与证据由服务端复用同一核对记录（持久身份），
 * 重复打开不产生第二次核对。核对是只读结论——不启动进程、不伪造 Run、不自动修复。
 */
export async function reviewProjectReturn(http: RelayHttp, projectId: string,
  commandId: string): Promise<RelayReturnReview> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/projects/${encodeURIComponent(projectId)}/return-reviews`),
    { method: "POST", body: JSON.stringify({ command_id: commandId }) }, 200));
  const review = returnReviewFrom(envelope.result);
  if (review.projectId !== projectId) {
    throw new Error("返回核对回执与当前项目不匹配。");
  }
  return review;
}
