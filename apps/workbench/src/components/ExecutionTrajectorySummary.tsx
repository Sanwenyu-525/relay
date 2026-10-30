import { useEffect, useState } from "react";
import ChatLocalFileDiff from "./ChatLocalFileDiff";
import MessageCodeBlock from "./MessageCodeBlock";
import { useRunToolCalls } from "../lib/useRunToolCalls";
import { useRunToolCallPreviews } from "../lib/useRunToolCallPreviews";
import { localFileDiffRows } from "../lib/localFileDiffRows";
import { waitReasonText } from "../lib/waitReasons";
import { failedToolResult } from "../lib/toolResults";
import {
  READ_TOOLS, activityItemsFromRunProjection, summarizeRunToolCalls, waitingOperationIds,
} from "../lib/activityPresentation";
import ActivityDetail from "./ActivityDetail";
import ActivityRow from "./ActivityRow";
import type { RelayApiClient, RelayRunToolCall, RelayRunToolCalls } from "../api/relayClient";

/**
 * 执行请求的一行摘要（docs/frontend/workbench-design.md §18.8）。
 *
 * 只算已结算的调用：REQUESTED/PREPARED 是「正在执行或结果未决」，不是「已经读过/改过」。把在途算进
 * 计数会让用户以为模型已经动过磁盘。读类聚合成一项，写与检查各自成项，失败数单列。
 *
 * 摘要是从工具轨迹派生的展示，不是新的事实源：同一个只读投影在右栏逐轮展开，这里只压成一行。
 * 有 Run 等待原因时一并显示，不把等待说成完成。
 *
 * 归属靠 run_id 核对：摘要自己不判断「这条消息对应哪次执行」，那由上游按 sourceMessageId 解析出的
 * runId 决定，这里再核对投影自己声明的 run_id 是否就是它。对不上就整份不显示。
 *
 * 折叠区里的读取结果逐字节来自同一份 `result_ref`（模型当时实际消费的那一份），不是另一次读取、
 * 也不是模型复述的目录清单。用户因此不必离开原会话去找唯一结果，右栏轨迹仍是逐轮全量视图。
 *
 * 2026-10-29：分类计数与等待动作身份移到 `lib/activityPresentation`（与聊天区的会话轮次共用
 * 同一套展示模型）。这里只保留「Run 侧摘要怎么排」——计数口径、词表与去重规则一个字没改。
 */

const TERMINAL_RUN = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
/** 折叠区最多逐字展示的正文行数；超出只算「还有更多」，不截断后冒充完整内容。 */
const INLINE_MAX_LINES = 40;
/** 读取结果超过这个项数后，平铺列表改按工具名聚成组行（页面原型 V5.26「轻量分组行」）：
    组行默认收起，展开才逐项回执；阈值内维持既有平铺，常见短轮次不受影响。 */
const READ_GROUP_THRESHOLD = 8;
/** 读取结果超过这个项数后，折叠区整体限高、框内滚动（V5.26「文件列表限高滚动」）。 */
const READ_CAP_THRESHOLD = 12;
/** 找不到精确 Review 或读取失败时的审批入口：仍是原审批页，由面板自己列出待决项。 */
const APPROVAL_FALLBACK_HREF = "/reviews?kind=ACTION_APPROVAL";

/** 结果正文：与右栏轨迹同一套取值——优先人类可读内容，其余按 JSON 原样展开，不加工。 */
function resultText(call: RelayRunToolCall): string {
  const result = call.resultRef;
  if (result === null) return "";
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.stdout) === false && typeof result.stdout === "string") return result.stdout;
  return JSON.stringify(result, null, 2);
}

/** 调用目标：优先读类工具的真实参数，其余退回工具名本身，不编造路径。 */
function callTarget(call: RelayRunToolCall): string {
  const relative = call.args.relative_path ?? call.args.path;
  return typeof relative === "string" && relative !== "" ? relative : call.toolName;
}

/** 已结算的读取调用；未结算与被拒的行不在这里冒充「已经读到」。 */
function settledReads(projection: RelayRunToolCalls): readonly RelayRunToolCall[] {
  const seen = new Set<string>();
  const reads: RelayRunToolCall[] = [];
  for (const round of projection.rounds) {
    for (const call of round.calls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      if (call.status !== "SETTLED" || call.resultRef === null) continue;
      if (!READ_TOOLS.has(call.toolName)) continue;
      if (failedToolResult(call.resultRef)) continue;
      reads.push(call);
    }
  }
  return reads;
}

/** 超过阈值后按工具名聚组（保持首次出现顺序）：同类的多次读取压成一行组行，
    组内仍是原来的逐项回执；这是呈现层聚合，不改变计数与「逐字来自 result_ref」的取值。 */
function groupReadsByTool(reads: readonly RelayRunToolCall[]):
readonly (readonly [toolName: string, calls: readonly RelayRunToolCall[]])[] {
  const groups = new Map<string, RelayRunToolCall[]>();
  for (const call of reads) {
    const bucket = groups.get(call.toolName);
    if (bucket === undefined) groups.set(call.toolName, [call]);
    else bucket.push(call);
  }
  return [...groups.entries()].map(([toolName, calls]) => [toolName, calls] as const);
}

export default function ExecutionTrajectorySummary({ client, runId, revision = null, onOpenTrajectory }: {
  client: RelayApiClient;
  runId: string;
  /** Run 的事实修订；变化时重读，让摘要在同一次会话里跟上结算结果。 */
  revision?: string | null;
  onOpenTrajectory?: () => void;
}) {
  // 与右栏轨迹页签共用同一个读取入口：两处各读一次会出现两条可能不同步的事实来源。
  const { projection, loading, error } = useRunToolCalls(client, runId, revision);
  const [open, setOpen] = useState(false);
  /** 命令/其它工具行的详情开合；用户手动开合优先，事件更新不会收回。 */
  const [activityOpen, setActivityOpen] = useState<ReadonlySet<string>>(() => new Set());
  // 局部 diff 的行：数字来自同一份工具账本（已落盘）与生成中的临时预览（不落总数）。
  // 预览只在 Run 非终态时轮询，Run 结束或切换后整份清空，迟到的片段不会复活「正在生成」。
  const { previews } = useRunToolCallPreviews(client, runId,
    projection !== null && TERMINAL_RUN.has(projection.runStatus) === false);
  const localRows = localFileDiffRows(projection, previews);
  // 等待批准时给出通往原 Review 决定入口的链接。这里只定位审批，不复制审批面板：
  // 读取失败或找不到精确匹配也会退回原审批页，绝不把「读不到」呈现成「没有审批」。
  const waitingKey = projection === null ? "" : waitingOperationIds(projection);
  const [approvalHref, setApprovalHref] = useState<string | null>(null);
  useEffect(() => {
    if (waitingKey === "") {
      setApprovalHref(null);
      return;
    }
    let cancelled = false;
    const waiting = new Set(waitingKey.split(","));
    void client.getRunReviews(runId).then((reviews) => {
      if (cancelled) return;
      const match = reviews.find((review) => review.kind === "ACTION_APPROVAL" &&
        review.status === "OPEN" && review.operationId !== null && waiting.has(review.operationId));
      setApprovalHref(match === undefined ? APPROVAL_FALLBACK_HREF
        : `/reviews?id=${encodeURIComponent(match.id)}`);
    }).catch(() => {
      if (!cancelled) setApprovalHref(APPROVAL_FALLBACK_HREF);
    });
    return () => { cancelled = true; };
  }, [client, runId, waitingKey]);

  if (error !== null) {
    return <p className="helper-text" data-testid="execution-summary-error">
      这次执行的工具轨迹当前读不到；Run 与成果事实不受影响。
    </p>;
  }
  if (projection === null) {
    return <p className="helper-text" role="status" data-testid="execution-summary-loading">
      {loading ? "正在读取这次执行的工具轨迹…" : "这次执行还没有可显示的工具轨迹。"}
    </p>;
  }
  const counts = summarizeRunToolCalls(projection);
  // 命令与其它工具的活动行（2026-10-30）：读取走「本次读取结果」清单、写入走逐文件 diff，
  // 只有命令（run_check 等）此前在聊天区完全没有出口——它的 stdout 与退出码只存在于右栏。
  // 这里按同一套行 anatomy 补上，详情用共享的 ActivityDetail 渲染真实回执。
  const activities = activityItemsFromRunProjection(projection).filter((item) =>
    item.category === "COMMAND" || item.category === "OTHER");
  // 统计标签按类别一枚一枚排；「等待你批准」是唯一需要用户动手的一类，
  // 单独标 attention 档（琥珀细线），不与普通计数混在同一个视觉层。
  const parts: { readonly text: string; readonly attention?: boolean }[] = [];
  if (counts.reads > 0) parts.push({ text: `读取/检索 ${counts.reads} 次` });
  if (counts.writes > 0) parts.push({ text: `写入 ${counts.writes} 次` });
  if (counts.checks > 0) parts.push({ text: `检查 ${counts.checks} 次` });
  if (counts.failed > 0) parts.push({ text: `${counts.failed} 项失败或未执行` });
  if (counts.waiting > 0) parts.push({ text: `${counts.waiting} 项等待你批准`, attention: true });
  if (counts.running > 0) parts.push({ text: `${counts.running} 项进行中或结果未决` });
  if (counts.unavailable > 0) parts.push({ text: `${counts.unavailable} 项结果未提供` });
  if (parts.length === 0) parts.push({ text: "这次执行没有调用工具" });
  const reads = settledReads(projection);

  return <div className="execution-summary execution-trajectory" data-testid="execution-summary">
    {/* 调用统计按类别各占一枚标签（§37.1）：一类一件事，扫读时不用在一串「·」里数项；
        等待原因跟在标签行下方，不与计数抢同一行。 */}
    <ul className="execution-counts" aria-label="本次执行的调用统计">
      {parts.map((part, index) => <li key={index} className="execution-count"
        data-tone={part.attention ? "attention" : undefined}>{part.text}</li>)}
    </ul>
    {projection.waitReason !== null &&
      <p className="helper-text">Run 等待原因 {waitReasonText(projection.waitReason)}</p>}
    {counts.waiting > 0 && <p className="execution-waiting" data-testid="execution-waiting-approval">
      <a className="inline-link" data-testid="execution-waiting-approval-link"
        href={approvalHref ?? APPROVAL_FALLBACK_HREF}>打开审批入口批准或拒绝这次动作</a>
    </p>}
    {/* 局部 diff：逐文件一行，紧邻这次编辑的摘要。同一文件被改多次留下多条，
        生成中的行只说「预览」，落账后才换成实际数并可以写「已修改」。 */}
    <ChatLocalFileDiff client={client} rows={localRows} />
    {activities.length > 0 && <ul className="execution-activities" data-testid="execution-activities">
      {activities.map((item) => <ActivityRow key={item.id} item={item}
        testId={`execution-activity-${item.id}`}
        current={item.tone === "active"}
        expanded={activityOpen.has(item.id)}
        detail={<ActivityDetail item={item} />}
        onToggle={() => setActivityOpen((previous) => {
          const next = new Set(previous);
          if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
          return next;
        })} />)}
    </ul>}
    {reads.length > 0 && <>
      <button className="text-link" type="button" data-testid="execution-read-results-toggle"
        aria-expanded={open} onClick={() => setOpen((previous) => !previous)}>
        {open ? "收起本次读取结果" : `展开本次读取结果（${reads.length} 项，来自实际工具回执）`}
      </button>
      {open && (() => {
        // 单项回执的呈现平铺与分组共用：组内每一项仍是完整可复制块，聚合只发生在组行这一层。
        const readItem = (call: RelayRunToolCall) => {
          const lines = resultText(call).split("\n");
          const shown = lines.slice(0, INLINE_MAX_LINES);
          return <li key={call.id} data-testid={`execution-read-${call.id}`}>
            {/* 工具回执与消息里的代码 fence 同一档可复制文本块（§37.1）：顶行是「工具 · 目标」，
                正文逐字来自 result_ref，超限只在块内滚动并另行说明，不截断后冒充完整。 */}
            <MessageCodeBlock label={`${call.toolName} · ${callTarget(call)}`} text={shown.join("\n")}
              copyLabel="复制这段工具回执" />
            {lines.length > shown.length &&
              <p className="helper-text">还有 {lines.length - shown.length} 行未在此展开；完整内容见工具轨迹。</p>}
          </li>;
        };
        const groups = reads.length > READ_GROUP_THRESHOLD ? groupReadsByTool(reads) : null;
        const capped = reads.length > READ_CAP_THRESHOLD;
        return <ul className="execution-read-results" data-testid="execution-read-results"
          data-grouped={groups !== null ? "true" : undefined}
          data-capped={capped ? "true" : undefined}
          tabIndex={capped ? 0 : undefined}>
          {groups !== null
            ? groups.map(([toolName, calls]) => <li key={toolName} className="execution-read-group">
              {/* 组行是「工具 · N 项」的一行概览，默认收起；计数与上方统计标签同源。 */}
              <details data-testid={`execution-read-group-${toolName}`}>
                <summary>{toolName} · {calls.length} 项</summary>
                <ul className="execution-read-group-items">{calls.map(readItem)}</ul>
              </details>
            </li>)
            : reads.map(readItem)}
        </ul>;
      })()}
    </>}
    {onOpenTrajectory !== undefined && <button className="text-link" type="button"
      data-testid="execution-summary-open" onClick={onOpenTrajectory}>查看逐步轨迹</button>}
  </div>;
}
