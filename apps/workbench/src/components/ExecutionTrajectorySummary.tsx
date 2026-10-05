import { useRunToolCalls } from "../lib/useRunToolCalls";
import { waitReasonText } from "../lib/waitReasons";
import type { RelayApiClient, RelayRunToolCalls } from "../api/relayClient";

/**
 * 执行请求的一行摘要（docs/frontend/workbench-design.md §18.8）。
 *
 * 只算已结算的调用：REQUESTED/PREPARED 是「正在执行」，不是「已经读过/改过」。把在途算进
 * 计数会让用户以为模型已经动过磁盘。读类聚合成一项，写与检查各自成项，失败数单列。
 *
 * 摘要是从工具轨迹派生的展示，不是新的事实源：同一个只读投影在右栏逐轮展开，这里只压成一行。
 * 有 Run 等待原因时一并显示，不把等待说成完成。
 */

const READ_TOOLS = new Set(["read_file", "list_directory", "find_paths", "search_text"]);
const WRITE_TOOLS = new Set(["apply_changeset"]);
const CHECK_TOOLS = new Set(["run_check"]);

interface Counts {
  readonly reads: number;
  readonly writes: number;
  readonly checks: number;
  readonly failed: number;
  readonly running: number;
  readonly waiting: number;
}

function count(projection: RelayRunToolCalls): Counts {
  const counts = { reads: 0, writes: 0, checks: 0, failed: 0, running: 0, waiting: 0 };
  for (const round of projection.rounds) {
    for (const call of round.calls) {
      // 先分流未结算与被拒的状态：把它们算进「进行中」会让用户以为模型还在动，
      // 把被拒算作成功则更糟——两者都必须在计数之前判定。
      if (call.status === "REJECTED" || call.status === "ABANDONED") { counts.failed += 1; continue; }
      if (call.status === "WAITING_APPROVAL") { counts.waiting += 1; continue; }
      if (call.status !== "SETTLED") { counts.running += 1; continue; }
      if (READ_TOOLS.has(call.toolName)) counts.reads += 1;
      else if (WRITE_TOOLS.has(call.toolName)) counts.writes += 1;
      else if (CHECK_TOOLS.has(call.toolName)) counts.checks += 1;
      if (typeof call.resultRef?.reason === "string") counts.failed += 1;
    }
  }
  return counts;
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
  if (counts.reads > 0) parts.push(`读了 ${counts.reads} 个文件`);
  if (counts.writes > 0) parts.push(`改了 ${counts.writes} 处`);
  if (counts.checks > 0) parts.push(`检查 ${counts.checks} 次`);
  if (counts.failed > 0) parts.push(`${counts.failed} 项失败`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} 项等待你批准`);
  if (parts.length === 0 && counts.running > 0) parts.push(`${counts.running} 项进行中`);
  if (parts.length === 0) parts.push("这次执行没有调用工具");

  return <p className="execution-summary" data-testid="execution-summary">
    <span>{parts.join(" · ")}</span>
    {projection.waitReason !== null && <span className="helper-text"> · Run 等待原因 {waitReasonText(projection.waitReason)}</span>}
    {onOpenTrajectory !== undefined && <button className="text-link" type="button"
      data-testid="execution-summary-open" onClick={onOpenTrajectory}>查看逐步轨迹</button>}
  </p>;
}
