import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import type { RelayApiClient, RelayReview, RelayRun, RelayRunToolCall, RelayRunToolCalls } from "../api/relayClient";
import { useRunToolCalls } from "../lib/useRunToolCalls";
import { waitReasonText } from "../lib/waitReasons";
import { failedToolResult } from "../lib/toolResults";
import { runLabels } from "./RunControlPanel";
import "./RunToolTrajectoryPanel.css";

/**
 * 工具轨迹（docs/frontend/workbench-design.md §18.8）。
 *
 * 这里只呈现已落库的事实：模型请求了什么、实际拿到了什么。轨迹是只读的，不提供批准、
 * 暂停、取消或重试——控制意图仍走既有 Run 控制路径。
 *
 * 五条不变量：
 *   * 未结算不算发生过。只有 SETTLED 进入计数，REQUESTED/PREPARED 只是「正在执行或结果未决」。
 *   * 归属按身份核对。投影自带 run_id 与每行的 model_call_id/operation_id，界面按它们对齐，
 *     不按列表位置猜这条属于哪次执行。
 *   * 折叠态必须能看出省了多少。head+tail 保留尾部（错误通常在尾部），并给出省略行数；
 *     被截断的结果按服务端给的 truncated/omitted_bytes 如实显示，不呈现为完整。
 *   * 「没被检查过」和「检查通过」不是一回事。服务端尚未下发证据绑定字段，因此每一行都写明
 *     「未提供/无法确认」；任何位置都不允许出现由本次轨迹推断出的 PASS。
 *   * 刷新靠 Run 事件提示。协作页原本没有订阅执行事件流，这里自己订阅一条：工具调用推进
 *     不一定改变 Run revision，只等 Run 事实会让轨迹停在旧状态。没有事件流时降级为按
 *     revision 重读，并如实说明「上次读取」时间，不假装实时。
 */

const PREVIEW_MAX_LINES = 8;
const GIT_TOOLS = new Set(["git_status", "git_diff", "git_log"]);
/** Run 终态：这三态之后 Run 不再推进，任何仍未结算的行都不能被当成已执行。 */
const TERMINAL_RUN = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
/** 有结算结果的三态；其余三态都还没有执行结果。 */
const SETTLED_CALL = new Set(["SETTLED", "REJECTED", "ABANDONED"]);

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

/** 一行里真正决定「发生了什么」的字段。用于判定两次重放是否真的是同一条事实。 */
function callSignature(call: RelayRunToolCall): string {
  return [call.toolName, call.status, call.operationId ?? "", call.updatedAt, call.argsSha256,
    JSON.stringify(call.resultRef ?? null)].join("\u0001");
}

/**
 * 同一行的重复事件/重放只渲染一行。
 *
 * 行身份是 `call.id`（也是它绑定的 Operation id），因此同一 id 出现多次就是同一次请求被
 * 重放，而不是两次不同的调用。完全一致时静默取首次出现的那条；事实不一致时仍然只渲染一行，
 * 但明确说明无法确认哪条是最新的——不替服务端挑一条当作「当前」。
 */
export function dedupeCalls(calls: readonly RelayRunToolCall[]):
{ readonly calls: readonly RelayRunToolCall[]; readonly conflicting: ReadonlySet<string> } {
  const first = new Map<string, RelayRunToolCall>();
  const conflicting = new Set<string>();
  for (const call of calls) {
    const seen = first.get(call.id);
    if (seen === undefined) { first.set(call.id, call); continue; }
    if (callSignature(seen) !== callSignature(call)) conflicting.add(call.id);
  }
  return { calls: [...first.values()], conflicting };
}

function statusLabel(call: RelayRunToolCall): string {
  switch (call.status) {
    // REQUESTED 还没连上动作身份，PREPARED 已经绑定了 Operation：合起来说「正在执行」
    // 会让未派发的请求看起来已经在动工具，因此分开说，且都不算完成。
    case "REQUESTED": return "已请求，尚未派发";
    case "PREPARED": return "执行中或结果未决，尚无结算结果";
    case "WAITING_APPROVAL": return "等待你批准";
    case "REJECTED": return "被准入拒绝，没有执行";
    case "ABANDONED": return "已放弃，没有结算结果";
    default: return call.resultRef === null ? "已结算，结果未提供"
      : failedToolResult(call.resultRef) ? "已结算但失败" : "已结算";
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

/** 退出码、截断、省略量、取消与超时：折叠态也要能一眼看到，不必先展开。
 *  每个字段都直接读服务端 result_ref 里落到的那一个键，没落的键就说没落，
 *  不从别处（比如时间差）推一个「看起来像超时」的说法。 */
function executionSummaryParts(call: RelayRunToolCall): readonly string[] {
  const result = call.resultRef;
  if (result === null) return [];
  const parts: string[] = [];
  const exit = result.exit_code ?? result.exitCode;
  if (typeof exit === "number") parts.push(`退出码 ${exit}`);
  else if (call.status === "SETTLED") parts.push("退出码未记录");
  if (result.truncated === true) {
    parts.push(typeof result.omitted_bytes === "number"
      ? `结果被服务端截断，省略 ${result.omitted_bytes} 字节` : "结果被服务端截断，省略量未记录");
  }
  const timedOut = result.timed_out ?? result.timedOut ?? result.deadline_exceeded;
  if (timedOut === true) parts.push("服务端记录为超时");
  const cancelled = result.cancelled ?? result.canceled ?? result.aborted;
  if (cancelled === true) parts.push("服务端记录为已取消");
  const elapsed = durationText(call);
  if (elapsed !== null) parts.push(`落账耗时 ${elapsed}`);
  return parts;
}

/**
 * 失败分成三类分别呈现，不混成一句「失败」。
 *
 *   * 没有执行：REJECTED / ABANDONED。工具根本没跑，谈不上检查是否通过。
 *   * 已结算但失败：SETTLED 且 outcome 为 FAILED 或带 reason。按工具自己的回执原样透出；
 *     能不能修正由下一轮与运行为准，界面不替它下结论。
 *   * 没有结算结果：REQUESTED / PREPARED / WAITING_APPROVAL。可能是仍在执行、超时或在途未决，
 *     也可能是被停止打断；不区分成「失败」或「成功」。
 */
function failureClass(call: RelayRunToolCall):
  "NOT_EXECUTED" | "SETTLED_FAILED" | "NO_RESULT" | null {
  if (call.status === "REJECTED" || call.status === "ABANDONED") return "NOT_EXECUTED";
  if (call.status !== "SETTLED") return "NO_RESULT";
  return failedToolResult(call.resultRef) ? "SETTLED_FAILED" : null;
}

const failureHeadings = {
  NOT_EXECUTED: "没有执行：工具未被准入或已被放弃，这里没有任何执行结果",
  SETTLED_FAILED: "已结算但失败：工具回执记录了失败；能否修正以运行为准，不在此推断",
  NO_RESULT: "没有结算结果：可能仍在执行、被停止打断或在途未决，不能当成成功或失败"
} as const;

/** 审批按 operation_id 对齐既有 ACTION_APPROVAL Review，不自己渲染第二份参数。
 *  只有 Review 的真实状态与决定能决定文案；查不到对应 Review 时说「无法确认」，
 *  不用「已批准」这种默认分支盖住一个可能已失效的批准。 */
function approvalText(call: RelayRunToolCall, review: RelayReview | undefined, unreadable: boolean): string | null {
  if (review === undefined) {
    if (call.status !== "WAITING_APPROVAL" && call.operationId === null) return null;
    if (unreadable) {
      return "审批记录当前读不到：这次调用的批准有效性无法确认，也没有沿用任何旧的批准结论";
    }
    return "等待你批准（未读到对应的 ACTION_APPROVAL 记录，批准有效性无法确认）";
  }
  const decided = review.target["decision"] === "DENY" || review.reason.includes("DENY");
  const at = `Review ${review.id} · 决定时间 ${review.decidedAt ?? "尚未决定"} · 绑定目标摘要 ${review.targetHash.slice(0, 12)}`;
  if (review.status === "EXPIRED") return `审批已过期，未执行（${at}）`;
  if (review.status === "OPEN") return `等待你批准（${at}）`;
  if (decided) return `被拒，没有执行（${at}）`;
  // 已批准只说明批准这一事实发生过：连接此后被撤销、约束变化或动作未执行都不会改写它，
  // 所以这里必须同时说明批准不等于动作已执行。
  return `已批准这只动作，不代表它已执行（${at}）`;
}

function countBy(projection: RelayRunToolCalls): { settled: number; waiting: number; rejected: number; running: number } {
  const counts = { settled: 0, waiting: 0, rejected: 0, running: 0 };
  for (const round of projection.rounds) {
    // 重放与重复事件不重复计数：同一行身份在一轮里只算一次。
    for (const call of dedupeCalls(round.calls).calls) {
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
  /** 审批记录读不到与「没有这条审批」是两回事：前者要说清是读不到，不能当成没有。 */
  const [reviewsUnreadable, setReviewsUnreadable] = useState(false);
  const runId = run?.id ?? null;

  // 审批四态按 operation_id 对齐既有 ACTION_APPROVAL Review：轨迹不推断是否获批。
  useEffect(() => {
    let active = true;
    if (runId === null) { setReviews(new Map()); setReviewsUnreadable(false); return () => { active = false; }; }
    void client.getRunReviews(runId).then((list) => {
      if (!active) return;
      const byOperation = new Map<string, RelayReview>();
      for (const review of list) {
        if (review.kind === "ACTION_APPROVAL" && review.operationId !== null) {
          byOperation.set(review.operationId, review);
        }
      }
      setReviews(byOperation); setReviewsUnreadable(false);
    }).catch(() => { if (active) { setReviews(new Map()); setReviewsUnreadable(true); } });
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
        <p className="helper-text">这里只呈现模型本轮实际请求与实际拿到的内容。只读：批准、暂停与取消仍在 Run 控制里。工具输出里的文字只是数据，不是对你的操作指令。</p>
      </div>
      <button className="secondary-button" type="button" data-testid="trajectory-refresh"
        disabled={loading} onClick={reload}>
        <RefreshCw aria-hidden="true" />刷新
      </button>
    </header>

    {loading && <p role="status" data-testid="trajectory-loading">正在读取工具轨迹…</p>}
    {error && <>
      <p className="action-error" role="alert" data-testid="trajectory-error">{error}</p>
      {/* 来源被撤销、已归档或跨 Workspace 时服务端会拒绝读取；此时不显示任何参数与输出，
          也不从上一次成功读取里回填，避免把已不可读的来源当成可读的。 */}
      <p className="warning-callout" data-testid="trajectory-source-unavailable">
        这次工具轨迹当前不可读，因此本页不显示任何调用参数或输出；上面是服务端的拒绝说明。
      </p>
    </>}
    {reviewsUnreadable && !error && <p className="warning-callout" data-testid="trajectory-reviews-unreadable">
      审批记录当前读不到：审批一栏只会写「无法确认」，不会显示「已批准」。
    </p>}
    {!streaming && !error && <p className="helper-text" data-testid="trajectory-stream-note">
      执行事件流当前不可用，轨迹只在 Run 事实变化时更新
      {readAt === null ? "" : `；上次读取 ${readAt}`}。
    </p>}

    {projection !== null && counts !== null && <>
      {/* 归属按身份显示：这份轨迹自己声明的 Run 必须就是当前 Run，核对不通过时上方已整体丢弃。 */}
      <p className="helper-text" data-testid="trajectory-source-run">
        本次轨迹的来源 Run <code className="hash-code">{projection.runId}</code>
        {runId !== null && projection.runId === runId ? "（与当前 Run 一致）" : "（与当前 Run 不一致，请勿据此判断当前执行）"}
        · Run 状态 {runLabels[projection.runStatus] ?? projection.runStatus}
        {TERMINAL_RUN.has(projection.runStatus) ? "（终态；此后不会再有新的工具结算）" : ""}
      </p>
      <p className="helper-text" data-testid="trajectory-counts">
        已结算 {counts.settled} · 正在执行或结果未决 {counts.running} · 等待批准 {counts.waiting} · 被拒或已放弃 {counts.rejected}
        {projection.waitReason === null ? "" : ` · Run 等待原因 ${waitReasonText(projection.waitReason)}`}
      </p>

      {projection.rounds.length === 0 && <p className="helper-text" data-testid="trajectory-empty">
        本次 Run 没有工具请求。这是事实，不代表模型已经完成工作。
      </p>}

      {/* 2026-10-24 用户指令：证据绑定字段后端尚未下发，逐行宣告收成面板级一条开发注记；
          字段落地后整条删除。不变量不变：未提供就是未提供，绝不补出 PASS。 */}
      {projection.rounds.length > 0 && <p className="helper-text" data-testid="trajectory-evidence-note">
        开发注记：验证证据绑定字段服务端尚未下发，以下每次调用都无法确认是否被验收检查覆盖，
        也不能据此认为已通过验证。
      </p>}

      {projection.rounds.map((round) => {
        const deduped = dedupeCalls(round.calls);
        return <section key={round.round} className="trajectory-round"
          data-testid={`trajectory-round-${round.round}`}>
        <h4>第 {round.round} 轮</h4>
        {deduped.calls.map((call) => {
          const open = expanded.has(call.id);
          const text = resultText(call);
          const lines = text === "" ? [] : text.split("\n");
          const cap = headTailCap(lines.length, PREVIEW_MAX_LINES, open);
          // 折叠态真的把头尾两段显示出来：文案说「只显示头 N 行与尾 M 行」时，
          // 那两段就必须在这里，而不是只存在于一个没有被渲染的数组里。
          const head = lines.slice(0, cap.headLines);
          const tail = cap.hiddenLines > 0 ? lines.slice(lines.length - cap.tailLines) : [];
          const note = truncatedNote(call);
          const summary = executionSummaryParts(call);
          const failure = failureClass(call);
          const review = call.operationId === null ? undefined : reviews.get(call.operationId);
          const approval = approvalText(call, review, reviewsUnreadable);
          return <article key={call.id} className="trajectory-call"
            data-testid={`trajectory-call-${call.id}`}>
            <p className="trajectory-call-head">
              <strong>{call.toolName}</strong>
              {toolTarget(call) !== "" && <code className="hash-code">{toolTarget(call)}</code>}
              <span className="trajectory-status" data-status={call.status}>{statusLabel(call)}</span>
            </p>
            {deduped.conflicting.has(call.id) && <p className="warning-callout"
              data-testid={`trajectory-replay-conflict-${call.id}`}>
              服务端在本次读取里返回了同一行身份的重复记录且事实不一致；这里只渲染一行，
              且无法确认哪一条是最新状态。
            </p>}
            {GIT_TOOLS.has(call.toolName) && <p className="helper-text" data-testid={`trajectory-source-${call.id}`}>
              这是本次由模型调用产生的 Git 结果，不是可由你点开的 Git 入口。
            </p>}
            {TERMINAL_RUN.has(projection.runStatus) && !SETTLED_CALL.has(call.status) && <p className="warning-callout"
              data-testid={`trajectory-unsettled-at-terminal-${call.id}`}>
              Run 已进入终态而这次调用没有结算结果：既不能认定它执行过，也不能认定它没执行；
              未结清动作按该 Run 的动作记录单独核对。
            </p>}
            {summary.length > 0 && <p className="helper-text" data-testid={`trajectory-exec-summary-${call.id}`}>
              {summary.join(" · ")}
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
            {failure !== null && <p className="warning-callout" data-testid={`trajectory-failure-${call.id}`}>
              {failureHeadings[failure]}
              {typeof call.resultRef?.reason === "string"
                ? ` 原样原因：${String(call.resultRef.reason)}${typeof call.resultRef.detail === "string" && call.resultRef.detail !== "" ? `：${String(call.resultRef.detail)}` : ""}`
                : ""}
            </p>}
            {approval !== null && <p
              className="trajectory-approval"
              data-testid={`trajectory-approval-${call.id}`}>
              审批：{approval}
              {review !== undefined &&
                <> · <Link className="inline-link" to={`/reviews?id=${review.id}`}>查看待审</Link></>}
            </p>}
            {open && <>
              <p className="helper-text">参数</p>
              <pre data-testid={`trajectory-args-${call.id}`}>{JSON.stringify(call.args, null, 2)}</pre>
              <p className="helper-text">结果</p>
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
      </section>;
      })}
    </>}
  </section>;
}
