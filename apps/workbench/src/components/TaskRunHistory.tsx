import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient, RelayTaskRunSummary } from "../api/relayClient";
import { RelayApiError } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { runLabels } from "./RunControlPanel";
import { useDisplayPreferences } from "../lib/displayPreferences";
import { Button } from "../ui";

/** TASK-RUN-HISTORY-20261106：分页历史只读，当前执行权仍来自 Task。 */
export default function TaskRunHistory({ client, taskId, currentRunId }: {
  client: RelayApiClient; taskId: string; currentRunId: string | null;
}) {
  const { timeZone } = useDisplayPreferences();
  const [items, setItems] = useState<readonly RelayTaskRunSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  const busy = useRef(false);
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  async function load(after: string | null = null) {
    if (busy.current) return;
    busy.current = true;
    const request = ++version.current;
    setLoading(true); setError(null); setFailedCursor(after);
    if (after === null) { setItems([]); setCursor(null); }
    try {
      const page = await client.getTaskRunsPage(taskId, after);
      if (request !== version.current) return;
      setItems((previous) => after === null ? page.items
        : [...previous, ...page.items.filter((item) => !previous.some((old) => old.id === item.id))]);
      setCursor(page.nextCursor);
    } catch (caught) {
      if (request === version.current) {
        setError(describeLiveError(caught).message);
        if (caught instanceof RelayApiError && [401, 403].includes(caught.problem.status)) {
          setItems([]); setCursor(null); setFailedCursor(null);
        }
      }
    } finally { if (request === version.current) { busy.current = false; setLoading(false); } }
  }
  useEffect(() => { busy.current = false; void load(); return () => { version.current++; }; }, [client, taskId]);
  function time(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "时间不可读取" : new Intl.DateTimeFormat("zh-CN", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(date);
  }
  return <section data-testid="task-run-history" aria-label="任务执行历史">
    <div className="form-actions"><h3>执行历史</h3><button className="text-link" type="button" disabled={loading}
      onClick={() => void load()}>刷新执行历史</button></div>
    <p className="helper-text">按创建时间从新到旧显示；已加载 {items.length} 条{cursor !== null ? "，还有更早记录" : ""}。历史状态不代表当前执行权，执行结束也不等于任务完成。</p>
    {items.length > 0 && <ul className="run-list">{items.map((run) => <li key={run.id}>
      <Link className="text-link" to={`/runs/${run.id}`}>查看执行 {run.id}</Link> · {runLabels[run.status] ?? run.status}
      {run.id === currentRunId && " · 当前 Task 绑定"}
      <p className="helper-text">创建于 <time dateTime={run.createdAt}>{time(run.createdAt)}</time>
        {run.terminalAt && <> · 结束于 <time dateTime={run.terminalAt}>{time(run.terminalAt)}</time></>}
        {run.retryOfRunId && <> · 重试来源 <Link className="text-link" to={`/runs/${run.retryOfRunId}`}>{run.retryOfRunId}</Link></>}</p>
    </li>)}</ul>}
    {loading && <p role="status">正在读取执行历史…</p>}
    {error !== null && <><p className="action-error" role="alert">执行历史读取失败：{error}</p>
      <button className="text-link" type="button" disabled={loading} onClick={() => void load(failedCursor)}>重试读取执行历史</button></>}
    {!loading && error === null && items.length === 0 && <p className="helper-text">该任务尚无 AI 执行记录。</p>}
    {cursor !== null && error === null && <Button variant="secondary" disabled={loading}
      onClick={() => void load(cursor)}>加载更早的执行记录</Button>}
  </section>;
}
