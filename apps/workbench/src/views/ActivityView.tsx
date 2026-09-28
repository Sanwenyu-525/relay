import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { RelayApiError, type RelayActivityFilter, type RelayActivityItem, type RelayActivityRefKind } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import "./ActivityView.css";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type ActorKind = RelayActivityItem["actorKind"];
// 单用户本机应用：人工动作以「我」呈现，与服务端 actor_kind=HUMAN 对应；不显示原始 actor_ref。
const actorLabels: Record<ActorKind, string> = { HUMAN: "我", AI: "AI", SYSTEM: "系统" };
const eventTypeLabels: Record<string, string> = {
  PROJECT_CREATED: "创建项目", PROJECT_STATE_UPDATED: "更新项目状态", PROJECT_ARCHIVED: "归档项目",
  TASK_CREATED: "创建任务", TASK_UPDATED: "更新任务", TASK_STARTED: "开始任务", TASK_CANCELLED: "取消任务",
  TASK_COMPLETED: "完成任务", TASK_REOPENED: "重开任务", TASK_READY: "任务进入可执行",
  ARTIFACT_VERSION_SAVED: "保存产物版本", ARTIFACT_VERSION_SELECTED: "选用产物版本",
  DELEGATION_CREATED: "委托 AI 执行", RUN_CREATED: "创建 Run", RUN_FINISHED: "Run 结束",
  REVIEW_DECIDED: "作出审批决定", VERIFICATION_COMPLETED: "验证完成"
};
function eventTypeLabel(eventType: string): string {
  return eventTypeLabels[eventType] ?? eventType;
}
const refLabels: Record<RelayActivityRefKind, string> = {
  PROJECT: "项目", TASK: "任务", RUN: "Run", GOAL: "目标", ARTIFACT_VERSION: "产物版本",
  REVIEW: "Review", COMPLETION: "完成凭据", VERIFICATION_SESSION: "验证会话"
};
const refLinkLabels: Partial<Record<RelayActivityRefKind, string>> = {
  PROJECT: "打开项目", TASK: "打开关联任务", RUN: "查看执行记录", ARTIFACT_VERSION: "查看产物来源链",
  REVIEW: "查看审批请求", COMPLETION: "查看完成凭据"
};

// 事件按业务事实类别分组，用于「批准 / 验证 / 执行」分开显示；类别只依据 event_type，不推断状态。
type EventCategory = "approval" | "verification" | "execution" | "delegation" | "state";
const categoryByEvent: Record<string, EventCategory> = {
  REVIEW_DECIDED: "approval",
  VERIFICATION_COMPLETED: "verification",
  ARTIFACT_VERSION_SAVED: "execution", ARTIFACT_VERSION_SELECTED: "execution", RUN_FINISHED: "execution", TASK_COMPLETED: "execution",
  DELEGATION_CREATED: "delegation", RUN_CREATED: "delegation"
};
const categoryMeta: Record<EventCategory, { chip: string; tone: "neutral" | "warning" | "success"; note: string }> = {
  approval: { chip: "人工决定", tone: "neutral", note: "这是一次人工判断记录。批准只针对当时的具体动作或版本，不代表相关动作已经执行成功，也不等于任务完成。" },
  verification: { chip: "验证结果", tone: "warning", note: "验证结果只表示该版本在既定检查项上的判定。检查通过不等于任务完成，仍需人工验收。" },
  execution: { chip: "动作 / 产物", tone: "success", note: "这是服务端记录的一次实际动作或产物变化，与人工批准、验证判定是分开的独立事实。" },
  delegation: { chip: "委托 / 运行", tone: "neutral", note: "委托只表示执行权已授予 AI 并创建了运行，不表示模型已执行成功或任务已完成。" },
  state: { chip: "状态变更", tone: "neutral", note: "这是项目或任务事实的一次变更，不据此推断执行结果或验收状态。" }
};
function eventCategory(eventType: string): EventCategory {
  return categoryByEvent[eventType] ?? "state";
}

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

function localTime(utc: string): string {
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime())) return utc;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function fullLocalTime(utc: string): string {
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime())) return utc;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

// 按本机日历日分组：今天 / 昨天 / 完整日期。分组只影响展示，不改变服务端顺序。
function dayStart(utc: string): number | null {
  const date = new Date(utc);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
function dayLabel(dayKey: number | null): string {
  if (dayKey === null) return "未知日期";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.round((today - dayKey) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  const date = new Date(dayKey);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function ActivityRow({ item, selected, onSelect }: { item: RelayActivityItem; selected: boolean; onSelect: () => void }) {
  const category = eventCategory(item.eventType);
  const meta = categoryMeta[category];
  return <li className={`activity-row${selected ? " activity-row--selected" : ""}`}>
    <div className="activity-row-heading">
      <div className="activity-row-lead">
        <time dateTime={item.createdAt}>{localTime(item.createdAt)}</time>
        <span className={`activity-actor activity-actor--${item.actorKind}`} aria-hidden="true" />
        <span className="activity-actor-label">{actorLabels[item.actorKind]}</span>
        <span className={`status-chip status-chip--${meta.tone}`}>{eventTypeLabel(item.eventType)}</span>
      </div>
      <button className="text-button" type="button" data-testid={`activity-basis-${item.id}`} aria-pressed={selected} onClick={onSelect}>查看依据</button>
    </div>
    <p className="activity-summary">{item.summary}</p>
    <div className="activity-refs">{item.entityRefs.length ? <ul>{item.entityRefs.map((ref) => {
      const target = refTarget(ref.kind, ref.id);
      return <li key={`${ref.kind}:${ref.id}`}>{target
        ? <Link className="inline-link" to={target}>{refLabels[ref.kind]} {ref.id}</Link>
        : <span>{refLabels[ref.kind]} {ref.id}（当前无直达页）</span>}</li>;
    })}</ul> : <p className="activity-meta">本条未返回可展示的实体引用。</p>}</div>
  </li>;
}

function BasisPanel({ item }: { item: RelayActivityItem }) {
  const meta = categoryMeta[eventCategory(item.eventType)];
  return <div className="rail-content activity-basis" data-testid="activity-basis-panel">
    <p className="eyebrow">事件依据</p>
    <h2>{eventTypeLabel(item.eventType)}</h2>
    <span className={`status-chip status-chip--${meta.tone}`}>{meta.chip}</span>
    <p className="activity-basis-summary">{item.summary}</p>
    <p className="activity-basis-note" role="note">{meta.note}</p>
    <dl className="rail-definition-list">
      <div><dt>事件类型</dt><dd>{item.eventType}</dd></div>
      <div><dt>发生时间</dt><dd>{fullLocalTime(item.createdAt)}（本机）</dd></div>
      <div><dt>执行方</dt><dd>{actorLabels[item.actorKind]}</dd></div>
      {item.commandId && <div><dt>原 command_id</dt><dd><code className="hash-code">{item.commandId}</code></dd></div>}
      <div><dt>Activity ID</dt><dd><code className="hash-code">{item.id}</code></dd></div>
    </dl>
    <h3>关联对象</h3>
    {item.entityRefs.length ? <ul className="activity-basis-refs">{item.entityRefs.map((ref) => {
      const target = refTarget(ref.kind, ref.id);
      return <li key={`${ref.kind}:${ref.id}`}>{target
        ? <Link className="inline-link" to={target}>{refLinkLabels[ref.kind] ?? `打开${refLabels[ref.kind]}`}</Link>
        : <span className="activity-meta">{refLabels[ref.kind]}：当前无直达页</span>}</li>;
    })}</ul> : <p className="activity-meta">本条未返回可展示的实体引用；不推断关联对象。</p>}
    <p className="activity-basis-footer">本页面不展示 AI 的原始推理过程；以上摘要、时间与引用均来自服务端已记录的事实。</p>
  </div>;
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
  const [actorFilter, setActorFilter] = useState<"ALL" | ActorKind>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    setItems([]); setNextCursor(null); setLoading(client !== null); setError(null); setMoreError(null); setSelectedId(null);
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
      // 续页失败保留已加载前页，只就地提示，不清空已有结果。
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

  // 服务端不支持按执行方分页筛选，这里只对「已加载项」做本地筛选，并如实标注范围。
  const visibleItems = useMemo(() => (actorFilter === "ALL" ? items : items.filter((item) => item.actorKind === actorFilter)), [items, actorFilter]);
  const groups = useMemo(() => {
    const buckets: { key: number | null; label: string; items: RelayActivityItem[] }[] = [];
    for (const item of visibleItems) {
      const key = dayStart(item.createdAt);
      const last = buckets[buckets.length - 1];
      if (last && last.key === key) last.items.push(item);
      else buckets.push({ key, label: dayLabel(key), items: [item] });
    }
    return buckets;
  }, [visibleItems]);
  const selected = selectedId !== null ? items.find((item) => item.id === selectedId) ?? null : null;

  return <section className="activity-page"><p className="eyebrow">工作空间</p><h1>动态</h1>
    <p className="page-lede">这里按时间记录项目里真实发生过的动作，可以按项目、任务、Run 或时间筛选，并直达相关对象。每一次改变都能找到依据。</p>
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
      <div className="activity-toolbar">
        <div className="segmented" role="group" aria-label="按执行方筛选（仅已加载项）">
          {(["ALL", "HUMAN", "AI", "SYSTEM"] as const).map((option) => <button key={option} type="button"
            className={`segmented-option${actorFilter === option ? " segmented-option--selected" : ""}`}
            aria-pressed={actorFilter === option} onClick={() => setActorFilter(option)}>
            {option === "ALL" ? "全部" : actorLabels[option]}</button>)}
        </div>
        <p className="helper-text">时间按本机时区输入，发送为 UTC；每页由服务端最多返回 30 条，按时间与 ID 倒序。执行方筛选只作用于已加载的 {items.length} 条，服务端暂不支持按执行方分页筛选（待接入）。</p>
      </div>
      <div className="activity-layout">
        <div className="activity-main">
          {loading && <p role="status">正在读取当前筛选范围的 Activity…</p>}
          {error && <p className="action-error" role="alert">{error}</p>}
          {!loading && !error && <>
            <p className="helper-text">当前已读取 {items.length} 条{nextCursor ? "；还有后续页" : "；本次查询没有后续游标"}。不把本页数量当作历史总数。</p>
            {visibleItems.length ? <div className="activity-groups">{groups.map((group) => <section key={`${group.key ?? "unknown"}-${group.items[0]!.id}`} className="activity-group">
              <h2 className="activity-day">{group.label}</h2>
              <ol className="activity-list">{group.items.map((item) => <ActivityRow key={item.id} item={item} selected={item.id === selectedId} onSelect={() => setSelectedId((current) => current === item.id ? null : item.id)} />)}</ol>
            </section>)}</div>
              : <p className="helper-text">{items.length ? "当前执行方筛选在已加载项内没有匹配记录；调整筛选或继续加载后重查。" : "当前筛选范围没有返回 Activity。可调整项目、任务、Run 或时间条件后重查。"}</p>}
            {moreError && <p className="action-error" role="alert">续页失败：{moreError}；已保留前面加载的结果。</p>}
            {nextCursor && <button className="secondary-button" type="button" disabled={loadingMore} onClick={() => { void loadMore(); }}>{loadingMore ? "正在读取后续页" : "继续加载"}</button>}
          </>}
        </div>
        <aside className="activity-aside" aria-label="所选事件依据">
          {selected ? <BasisPanel item={selected} />
            : <div className="rail-content activity-basis-empty" role="status"><p className="eyebrow">事件依据</p><p className="helper-text">选择一条动态查看它绑定的时间、执行方、关联对象与判断说明。批准、验证与执行结果是分开的独立事实。</p></div>}
        </aside>
      </div>
    </>}
  </section>;
}
