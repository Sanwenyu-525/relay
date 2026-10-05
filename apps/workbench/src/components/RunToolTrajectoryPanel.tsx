import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import type { RelayApiClient, RelayReview, RelayRun, RelayRunToolCall, RelayRunToolCalls } from "../api/relayClient";
import { useRunToolCalls } from "../lib/useRunToolCalls";
import { waitReasonText } from "../lib/waitReasons";
import "./RunToolTrajectoryPanel.css";

/**
 * 工具轨迹（docs/frontend/workbench-design.md §18.8）。
 *
 * 这里只呈现已落库的事实：模型请求了什么、实际拿到了什么。轨迹是只读的，不提供批准、
 * 暂停、取消或重试——控制意图仍走既有 Run 控制路径。
 *
 * 三条不变量：
 *   * 未结算不算发生过。只有 SETTLED 进入计数，REQUESTED/PREPARED 只是「正在执行」。
 *   * 折叠态必须能看出省了多少。head+tail 保留尾部（错误通常在尾部），并给出省略行数；
 *     被截断的结果按服务端给的 truncated/omitted_bytes 如实显示，不呈现为完整。
 *   * 刷新靠 Run 事件提示。协作页原本没有订阅执行事件流，这里自己订阅一条：工具调用推进
 *     不一定改变 Run revision，只等 Run 事实会让轨迹停在旧状态。没有事件流时降级为按
 *     revision 重读，并如实说明「上次读取」时间，不假装实时。
 */

const PREVIEW_MAX_LINES = 8;
const GIT_TOOLS = new Set(["git_status", "git_diff", "git_log"]);

/** head+tail 切分：折叠时保留头尾两半，展开时全部交给渲染层。
 *  行数不超过上限时不切分，调用方据此避免头尾重叠（同一条内容出现两次）。 */
export function headTailCap(total: number, maxLines: number, expanded: boolean):
{ readonly headLines: number; readonly tailLines: number; readonly hiddenLines: number } {
  if (expanded || total <= maxLines) {
    return { headLines: total, tailLines: 0, hiddenLines: 0 };
  }
  const headLines = Math.ceil(maxLines / 2);
  return { headLines, tailLines: maxLines - headLines, hiddenLines: total - maxLines };
}

function statusLabel(call: RelayRunToolCall): string {
  switch (call.status) {
    case "REQUESTED":
    case "PREPARED": return "正在执行";
    case "WAITING_APPROVAL": return "等待你批准";
    case "REJECTED": return "被拒";
    case "ABANDONED": return "已放弃";
    default: return typeof call.resultRef?.reason === "string" ? "已结算但失败" : "已结算";
  }
}

function toolTarget(call: RelayRunToolCall): string {
  const path = call.args.relative_path;
  if (typeof path === "string" && path.length > 0) return path;
  if (typeof call.args.check_id === "string") return String(call.args.check_id);
  if (typeof call.args.query === "string") return String(call.args.query);
  return "";
}

/** 结果正文：优先给出真正的人类可读内容，其余按 JSON 原样展开，不加工也不美化。 */
function resultText(call: RelayRunToolCall): string {
  const result = call.resultRef;
  if (result === null) return "";
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.stdout) === false && typeof result.stdout === "string") return result.stdout;
  return JSON.stringify(result, null, 2);
}

function truncatedNote(call: RelayRunToolCall): string | null {
  const result = call.resultRef;
  if (result === null || result.truncated !== true) return null;
  const omitted = result.omitted_bytes;
  return `结果已被服务端截断${typeof omitted === "number" ? `，省略 ${omitted} 字节` : ""}；这里不是完整内容。`;
}

function durationText(call: RelayRunToolCall): string | null {
  const started = Date.parse(call.createdAt);
  const ended = Date.parse(call.updatedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return `${ended - started}ms`;
}

/** 审批四态：等待批准 / 已批准 / 被拒 / 已取消。
 *  数据来自既有 ACTION_APPROVAL Review，按 operation_id 对齐；轨迹不自己渲染第二份参数。 */
function approvalText(review: RelayReview | undefined): string | null {
  if (review === undefined) return null;
  if (review.status === "OPEN") return "等待你批准";
  if (review.status === "EXPIRED") return "审批已过期，未执行";
  return review.target["decision"] === "DENY" || review.reason.includes("DENY") ? "被拒" : "已批准";
}

function countBy(projection: RelayRunToolCalls): { settled: number; waiting: number; rejected: number; running: number } {
  const counts = { settled: 0, waiting: 0, rejected: 0, running: 0 };
  for (const round of projection.rounds) {
    for (const call of round.calls) {
      if (call.status === "REJECTED" || call.status === "ABANDONED") counts.rejected += 1;
      else if (call.status === "WAITING_APPROVAL") counts.waiting += 1;
      else if (call.status !== "SETTLED") counts.running += 1;
      else counts.settled += 1;
    }
  }
  return counts;
}

export default function RunToolTrajectoryPanel({ client, run }: {
  client: RelayApiClient;
  run: RelayRun | null;
}) {
  const { projection, loading, error, readAt, streaming, reload } =
    useRunToolCalls(client, run?.id ?? null, run?.revision ?? null);
  const [reviews, setReviews] = useState<ReadonlyMap<string, RelayReview>>(() => new Map());
  const runId = run?.id ?? null;

  // 审批四态按 operation_id 对齐既有 ACTION_APPROVAL Review：轨迹不推断是否获批。
  useEffect(() => {
    let active = true;
    if (runId === null) { setReviews(new Map()); return () => { active = false; }; }
    void client.getRunReviews(runId).then((list) => {
      if (!active) return;
      const byOperation = new Map<string, RelayReview>();
      for (const review of list) {
        if (review.kind === "ACTION_APPROVAL" && review.operationId !== null) {
          byOperation.set(review.operationId, review);
        }
      }
      setReviews(byOperation);
    }).catch(() => { if (active) setReviews(new Map()); });
    return () => { active = false; };
  }, [client, runId]);

  const counts = useMemo(() => projection === null ? null : countBy(projection), [projection]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return <section className="trajectory" data-testid="run-tool-trajectory" aria-label="工具轨迹">
    <header className="trajectory-heading">
      <div>
        <h3>工具轨迹</h3>
        <p className="helper-text">这里只呈现模型本轮实际请求与实际拿到的内容。只读：批准、暂停与取消仍在 Run 控制里。</p>
      </div>
      <button className="secondary-button" type="button" data-testid="trajectory-refresh"
        disabled={loading} onClick={reload}>
        <RefreshCw aria-hidden="true" />刷新
      </button>
    </header>

    {loading && <p role="status" data-testid="trajectory-loading">正在读取工具轨迹…</p>}
    {error && <p className="action-error" role="alert" data-testid="trajectory-error">{error}</p>}
    {!streaming && !error && <p className="helper-text" data-testid="trajectory-stream-note">
      执行事件流当前不可用，轨迹只在 Run 事实变化时更新
      {readAt === null ? "" : `；上次读取 ${readAt}`}。
    </p>}

    {projection !== null && counts !== null && <>
      <p className="helper-text" data-testid="trajectory-counts">
        已结算 {counts.settled} · 正在执行 {counts.running} · 等待批准 {counts.waiting} · 被拒或已放弃 {counts.rejected}
        {projection.waitReason === null ? "" : ` · Run 等待原因 ${waitReasonText(projection.waitReason)}`}
      </p>

      {projection.rounds.length === 0 && <p className="helper-text" data-testid="trajectory-empty">
        本次 Run 没有工具请求。这是事实，不代表模型已经完成工作。
      </p>}

      {projection.rounds.map((round) => <section key={round.round} className="trajectory-round"
        data-testid={`trajectory-round-${round.round}`}>
        <h4>第 {round.round} 轮</h4>
        {round.calls.map((call) => {
          const open = expanded.has(call.id);
          const text = resultText(call);
          const lines = text === "" ? [] : text.split("\n");
          const cap = headTailCap(lines.length, PREVIEW_MAX_LINES, open);
          // 折叠态真的把头尾两段显示出来：文案说「只显示头 N 行与尾 M 行」时，
          // 那两段就必须在这里，而不是只存在于一个没有被渲染的数组里。
          const head = lines.slice(0, cap.headLines);
          const tail = cap.hiddenLines > 0 ? lines.slice(lines.length - cap.tailLines) : [];
          const note = truncatedNote(call);
          return <article key={call.id} className="trajectory-call"
            data-testid={`trajectory-call-${call.id}`}>
            <p className="trajectory-call-head">
              <strong>{call.toolName}</strong>
              {toolTarget(call) !== "" && <code className="hash-code">{toolTarget(call)}</code>}
              <span className="trajectory-status" data-status={call.status}>{statusLabel(call)}</span>
            </p>
            {GIT_TOOLS.has(call.toolName) && <p className="helper-text" data-testid={`trajectory-source-${call.id}`}>
              这是本次由模型调用产生的 Git 结果，不是可由你点开的 Git 入口。
            </p>}
            <button className="text-link" type="button" data-testid={`trajectory-expand-${call.id}`}
              aria-expanded={open} onClick={() => toggle(call.id)}>
              {open ? "收起结果" : `展开结果（${lines.length} 行）`}
            </button>
            {!open && cap.hiddenLines > 0 && <p className="helper-text" data-testid={`trajectory-hidden-${call.id}`}>
              省略 {cap.hiddenLines} 行（只显示头 {cap.headLines} 行与尾 {cap.tailLines} 行）
            </p>}
            {!open && (head.length > 0 || tail.length > 0) &&
              <pre data-testid={`trajectory-preview-${call.id}`}>{[...head,
                ...(cap.hiddenLines > 0 ? [`… 省略 ${cap.hiddenLines} 行 …`] : []), ...tail].join("\n")}</pre>}
            {note !== null && <p className="warning-callout" data-testid={`trajectory-truncated-${call.id}`}>{note}</p>}
            {typeof call.resultRef?.reason === "string" && <p className="warning-callout"
              data-testid={`trajectory-reason-${call.id}`}>
              {String(call.resultRef.reason)}：{String(call.resultRef.detail ?? "")}
            </p>}
            {approvalText(call.operationId === null ? undefined : reviews.get(call.operationId)) !== null && <p
              className="trajectory-approval"
              data-testid={`trajectory-approval-${call.id}`}>
              审批：{approvalText(call.operationId === null ? undefined : reviews.get(call.operationId))}
              {call.operationId !== null && reviews.get(call.operationId) !== undefined &&
                <> · <Link className="inline-link"
                  to={`/reviews?id=${reviews.get(call.operationId)!.id}`}>查看待审</Link></>}
            </p>}
            {open && <>
              <p className="helper-text">参数</p>
              <pre data-testid={`trajectory-args-${call.id}`}>{JSON.stringify(call.args, null, 2)}</pre>
              <p className="helper-text">结果</p>
              {(typeof call.resultRef?.exit_code === "number" || durationText(call) !== null) &&
                <p className="helper-text" data-testid={`trajectory-exit-${call.id}`}>
                  {typeof call.resultRef?.exit_code === "number" ? `退出码 ${String(call.resultRef.exit_code)}` : ""}
                  {durationText(call) === null ? "" : ` · 耗时 ${durationText(call) as string}`}
                </p>}
              {lines.length === 0
                ? <p className="helper-text" data-testid={`trajectory-noresult-${call.id}`}>这次调用没有结果内容；不能据此推断成功或失败。</p>
                : <pre data-testid={`trajectory-result-${call.id}`}>{lines.join("\n")}</pre>}
              {call.operationId !== null && <p className="helper-text">
                动作身份 <code className="hash-code">{call.operationId}</code>
                {call.toolName === "apply_changeset" && " · 文件变化集与差异在该 Run 的运行记录里按这个动作身份核对"}
              </p>}
            </>}
          </article>;
        })}
      </section>)}
    </>}
  </section>;
}
