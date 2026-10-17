import { useState } from "react";
import ChatLocalFileDiff from "./ChatLocalFileDiff";
import { useRunToolCalls } from "../lib/useRunToolCalls";
import { useRunToolCallPreviews } from "../lib/useRunToolCallPreviews";
import { localFileDiffRows } from "../lib/localFileDiffRows";
import { waitReasonText } from "../lib/waitReasons";
import { failedToolResult } from "../lib/toolResults";
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
 */

const READ_TOOLS = new Set(["read_file", "list_directory", "find_paths", "search_text"]);
const WRITE_TOOLS = new Set(["apply_changeset"]);
const CHECK_TOOLS = new Set(["run_check"]);
/** Run 终态后不再有生成中预览，轮询到此为止（与轨迹页签同一词表）。 */
const TERMINAL_RUN = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
/** 折叠区最多逐字展示的正文行数；超出只算「还有更多」，不截断后冒充完整内容。 */
const INLINE_MAX_LINES = 40;

interface Counts {
  readonly reads: number;
  readonly writes: number;
  readonly checks: number;
  readonly failed: number;
  readonly running: number;
  readonly waiting: number;
  readonly unavailable: number;
}

function count(projection: RelayRunToolCalls): Counts {
  const counts = { reads: 0, writes: 0, checks: 0, failed: 0, running: 0, waiting: 0, unavailable: 0 };
  for (const round of projection.rounds) {
    // 同一行身份的重复事件/重放只算一次：摘要被重放撑大就等于把一次调用说成多次。
    const seen = new Set<string>();
    for (const call of round.calls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      // 先分流未结算与被拒的状态：把它们算进「进行中」会让用户以为模型还在动，
      // 把被拒算作成功则更糟——两者都必须在计数之前判定。
      if (call.status === "REJECTED" || call.status === "ABANDONED") { counts.failed += 1; continue; }
      if (call.status === "WAITING_APPROVAL") { counts.waiting += 1; continue; }
      if (call.status !== "SETTLED") { counts.running += 1; continue; }
      if (call.resultRef === null) { counts.unavailable += 1; continue; }
      if (CHECK_TOOLS.has(call.toolName)) counts.checks += 1;
      if (failedToolResult(call.resultRef)) { counts.failed += 1; continue; }
      if (READ_TOOLS.has(call.toolName)) counts.reads += 1;
      else if (WRITE_TOOLS.has(call.toolName)) counts.writes += 1;
    }
  }
  return counts;
}

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
  // 局部 diff 的行：数字来自同一份工具账本（已落盘）与生成中的临时预览（不落总数）。
  // 预览只在 Run 非终态时轮询，Run 结束或切换后整份清空，迟到的片段不会复活「正在生成」。
  const { previews } = useRunToolCallPreviews(client, runId,
    projection !== null && TERMINAL_RUN.has(projection.runStatus) === false);
  const localRows = localFileDiffRows(projection, previews);

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
  const counts = count(projection);
  const parts: string[] = [];
  if (counts.reads > 0) parts.push(`读取/检索 ${counts.reads} 次`);
  if (counts.writes > 0) parts.push(`写入 ${counts.writes} 次`);
  if (counts.checks > 0) parts.push(`检查 ${counts.checks} 次`);
  if (counts.failed > 0) parts.push(`${counts.failed} 项失败或未执行`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} 项等待你批准`);
  if (counts.running > 0) parts.push(`${counts.running} 项进行中或结果未决`);
  if (counts.unavailable > 0) parts.push(`${counts.unavailable} 项结果未提供`);
  if (parts.length === 0) parts.push("这次执行没有调用工具");
  const reads = settledReads(projection);

  return <div className="execution-summary" data-testid="execution-summary">
    <p className="helper-text">
      <span>{parts.join(" · ")}</span>
      {projection.waitReason !== null && <span className="helper-text"> · Run 等待原因 {waitReasonText(projection.waitReason)}</span>}
    </p>
    {/* 局部 diff：逐文件一行，紧邻这次编辑的摘要。同一文件被改多次留下多条，
        生成中的行只说「预览」，落账后才换成实际数并可以写「已修改」。 */}
    <ChatLocalFileDiff client={client} rows={localRows} />
    {reads.length > 0 && <>
      <button className="text-link" type="button" data-testid="execution-read-results-toggle"
        aria-expanded={open} onClick={() => setOpen((previous) => !previous)}>
        {open ? "收起本次读取结果" : `展开本次读取结果（${reads.length} 项，来自实际工具回执）`}
      </button>
      {open && <ul className="execution-read-results" data-testid="execution-read-results">
        {reads.map((call) => {
          const lines = resultText(call).split("\n");
          const shown = lines.slice(0, INLINE_MAX_LINES);
          return <li key={call.id} data-testid={`execution-read-${call.id}`}>
            <p className="helper-text">{call.toolName} · {callTarget(call)}</p>
            <pre className="trajectory-preview">{shown.join("\n")}</pre>
            {lines.length > shown.length &&
              <p className="helper-text">还有 {lines.length - shown.length} 行未在此展开；完整内容见工具轨迹。</p>}
          </li>;
        })}
      </ul>}
    </>}
    {onOpenTrajectory !== undefined && <button className="text-link" type="button"
      data-testid="execution-summary-open" onClick={onOpenTrajectory}>查看逐步轨迹</button>}
  </div>;
}
