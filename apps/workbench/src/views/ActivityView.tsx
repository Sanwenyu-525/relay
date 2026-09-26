import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { RelayApiError, type RelayActivityFilter, type RelayActivityItem, type RelayActivityRefKind } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import "./ActivityView.css";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const actorLabels = { HUMAN: "人工", AI: "AI", SYSTEM: "系统" } as const;
const refLabels: Record<RelayActivityRefKind, string> = {
  PROJECT: "项目", TASK: "任务", RUN: "Run", GOAL: "目标", ARTIFACT_VERSION: "产物版本",
  REVIEW: "Review", COMPLETION: "完成凭据", VERIFICATION_SESSION: "验证会话"
};

function localInput(utc: string): string {
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function filterFromSearch(search: string): RelayActivityFilter {
  const query = new URLSearchParams(search);
  return { projectId: query.get("project_id") || undefined, taskId: query.get("task_id") || undefined,
    runId: query.get("run_id") || undefined, from: query.get("from") || undefined, to: query.get("to") || undefined };
}

function refTarget(kind: RelayActivityRefKind, id: string): string | null {
  if (kind === "PROJECT") return `/projects/${id}`;
  if (kind === "TASK") return `/tasks/${id}`;
  if (kind === "RUN") return `/runs/${id}`;
  if (kind === "REVIEW") return `/reviews?id=${id}`;
  if (kind === "ARTIFACT_VERSION") return `/artifact-versions/${id}/lineage`;
  if (kind === "COMPLETION") return `/completion-records/${id}`;
  return null;
}

function ActivityRow({ item }: { item: RelayActivityItem }) {
  return <li className="activity-row"><div className="activity-row-heading"><strong>{item.summary}</strong><time dateTime={item.createdAt}>{item.createdAt}</time></div>
    <p className="activity-meta">{actorLabels[item.actorKind]} · {item.eventType} · Activity ID {item.id}</p>
    {item.commandId && <p className="activity-meta">原 command_id：{item.commandId}</p>}
    <div className="activity-refs"><strong>已核实引用</strong>{item.entityRefs.length ? <ul>{item.entityRefs.map((ref) => {
      const target = refTarget(ref.kind, ref.id);
      return <li key={`${ref.kind}:${ref.id}`}>{target
        ? <Link className="inline-link" to={target}>{refLabels[ref.kind]} {ref.id}</Link>
        : <span>{refLabels[ref.kind]} {ref.id}（当前无直达页）</span>}</li>;
    })}</ul> : <p>本条未返回可展示的实体引用。</p>}</div>
  </li>;
}

export default function ActivityView() {
  const location = useLocation();
  const navigate = useNavigate();
  const connection = useRelayConnection();
  const client = connection.mode === "live" ? connection.client : null;
  const active = filterFromSearch(location.search);
  const filterKey = location.search;
  const [projectId, setProjectId] = useState(active.projectId ?? "");
  const [taskId, setTaskId] = useState(active.taskId ?? "");
  const [runId, setRunId] = useState(active.runId ?? "");
  const [from, setFrom] = useState(active.from ? localInput(active.from) : "");
  const [to, setTo] = useState(active.to ? localInput(active.to) : "");
  const [formError, setFormError] = useState<string | null>(null);
  const [items, setItems] = useState<readonly RelayActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const requestVersion = useRef(0);
  const keyRef = useRef(filterKey);
  keyRef.current = filterKey;

  useEffect(() => {
    setProjectId(active.projectId ?? ""); setTaskId(active.taskId ?? ""); setRunId(active.runId ?? "");
    setFrom(active.from ? localInput(active.from) : ""); setTo(active.to ? localInput(active.to) : "");
  }, [filterKey]);

  useEffect(() => {
    const request = ++requestVersion.current;
    setItems([]); setNextCursor(null); setLoading(client !== null); setError(null); setMoreError(null);
    if (client === null) return;
    void client.getActivities(active).then((page) => {
      if (request === requestVersion.current && keyRef.current === filterKey) {
        setItems(page.items); setNextCursor(page.nextCursor);
      }
    }).catch((caught: unknown) => {
      if (request === requestVersion.current && keyRef.current === filterKey) {
        setError(caught instanceof RelayApiError && [403, 404].includes(caught.problem.status)
          ? "筛选目标当前不可见或无权读取；已清除旧列表，请核对作用域。" : describeLiveError(caught).message);
      }
    }).finally(() => { if (request === requestVersion.current && keyRef.current === filterKey) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [client, filterKey, reload]);

  async function loadMore() {
    if (client === null || !nextCursor || loading || loadingMore) return;
    const request = requestVersion.current;
    const key = filterKey;
    setLoadingMore(true); setMoreError(null);
    try {
      const page = await client.getActivities({ ...active, cursor: nextCursor });
      if (request !== requestVersion.current || keyRef.current !== key) return;
      setItems((previous) => [...previous, ...page.items.filter((item) => !previous.some((seen) => seen.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (request === requestVersion.current && keyRef.current === key) setMoreError(describeLiveError(caught).message);
    } finally { if (request === requestVersion.current && keyRef.current === key) setLoadingMore(false); }
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError(null);
    const ids = [projectId.trim(), taskId.trim(), runId.trim()];
    if (ids.some((id) => id && !uuid.test(id))) { setFormError("项目、任务和 Run 筛选需要完整 UUID。"); return; }
    const fromUtc = from ? new Date(from).toISOString() : null;
    const toUtc = to ? new Date(to).toISOString() : null;
    if (fromUtc && toUtc && fromUtc >= toUtc) { setFormError("结束时间须晚于起始时间；结束边界不包含在结果内。"); return; }
    const query = new URLSearchParams();
    if (ids[0]) query.set("project_id", ids[0]);
    if (ids[1]) query.set("task_id", ids[1]);
    if (ids[2]) query.set("run_id", ids[2]);
    if (fromUtc) query.set("from", fromUtc);
    if (toUtc) query.set("to", toUtc);
    const path = `/activity${query.size ? `?${query.toString()}` : ""}`;
    if (`${location.pathname}${location.search}` === path) setReload((value) => value + 1);
    else navigate(path);
  }

  return <section className="activity-page"><p className="eyebrow">动态</p><h1>Activity</h1>
    <p className="page-lede">按服务端业务审计记录查看发生过的动作。摘要与已核实引用可导航；审批决定和实际效果仍须分别查看。</p>
    {client === null ? <p className="warning-callout" role="status">当前是示例数据预览，没有真实 Activity 记录。<Link to="/projects">打开项目</Link> 继续人工工作。</p> : <>
      <form className="surface-panel activity-filter" onSubmit={apply}>
        <label>Project ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="可选 UUID" /></label>
        <label>Task ID<input value={taskId} onChange={(event) => setTaskId(event.target.value)} placeholder="可选 UUID" /></label>
        <label>Run ID<input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="可选 UUID" /></label>
        <label>起始时间（本机时区，包含）<input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>结束时间（本机时区，不包含）<input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <button className="primary-button" type="submit">应用筛选</button>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => setReload((value) => value + 1)}>刷新当前范围</button>
        {formError && <p className="action-error" role="alert">{formError}</p>}
      </form>
      <p className="helper-text">时间按本机时区输入，发送为 UTC；每页由服务端最多返回 30 条，按时间与 ID 倒序。</p>
      {loading && <p role="status">正在读取当前筛选范围的 Activity…</p>}
      {error && <p className="action-error" role="alert">{error}</p>}
      {!loading && !error && <><p className="helper-text">当前已读取 {items.length} 条{nextCursor ? "；还有后续页" : "；本次查询没有后续游标"}。不把本页数量当作历史总数。</p>
        {items.length ? <ol className="activity-list">{items.map((item) => <ActivityRow key={item.id} item={item} />)}</ol>
          : <p className="helper-text">当前筛选范围没有返回 Activity。可调整项目、任务、Run 或时间条件后重查。</p>}
        {moreError && <p className="action-error" role="alert">续页失败：{moreError}</p>}
        {nextCursor && <button className="secondary-button" type="button" disabled={loadingMore} onClick={() => { void loadMore(); }}>{loadingMore ? "正在读取后续页" : "继续加载"}</button>}
      </>}
    </>}
  </section>;
}
