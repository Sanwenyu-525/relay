import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { RelayApiError, type RelayActivityFilter, type RelayActivityItem, type RelayProjectListItem } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import PageHeader from "../components/PageHeader";
import "./ActivityView.css";
import { activityActorLabels as actorLabels, activityEventLabel as eventTypeLabel, activityEventSummary as eventSummary, activityRefLabels as refLabels, activityRefLinkLabels as refLinkLabels, activityRefTarget as refTarget, activityEventCategory as eventCategory, activityCategoryMeta as categoryMeta, type ActivityEventCategory } from "../lib/labels";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MANUAL_PROJECT_OPTION = "__manual__";
type EventCategory = ActivityEventCategory;

const categoryFilters: readonly { value: "ALL" | EventCategory; label: string }[] = [
  { value: "ALL", label: "全部" }, { value: "execution", label: "执行" }, { value: "verification", label: "检查" },
  { value: "artifact", label: "产物" }, { value: "approval", label: "决策" }, { value: "completion", label: "完成" },
  { value: "state", label: "项目与任务" }, { value: "unknown", label: "其他" }
];

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
        <span className={`status-chip status-chip--${meta.tone}`}>{meta.chip}</span>
      </div>
      <button className="text-button" type="button" data-testid={`activity-basis-${item.id}`} aria-pressed={selected} onClick={onSelect}>查看依据</button>
    </div>
    <p className="activity-summary">{eventSummary(item)}</p>
    <div className="activity-refs">{item.entityRefs.length ? <ul>{item.entityRefs.map((ref) => {
      const target = refTarget(ref.kind, ref.id);
      return <li key={`${ref.kind}:${ref.id}`}>{target
        ? <Link className="inline-link" to={target}>{refLinkLabels[ref.kind] ?? `打开${refLabels[ref.kind]}`}</Link>
        : <span>{refLabels[ref.kind]}：当前无直达页</span>}
        </li>;
    })}</ul> : <p className="activity-meta">本条未返回可展示的实体引用。</p>}</div>
  </li>;
}

function BasisPanel({ item }: { item: RelayActivityItem }) {
  const meta = categoryMeta[eventCategory(item.eventType)];
  return <div className="rail-content activity-basis" data-testid="activity-basis-panel">
    <p className="eyebrow">事件依据</p>
    <h2>{eventTypeLabel(item.eventType)}</h2>
    <span className={`status-chip status-chip--${meta.tone}`}>{meta.chip}</span>
    <p className="activity-basis-summary">{eventSummary(item)}</p>
    <p className="activity-basis-note" role="note">{meta.note}</p>
    <dl className="rail-definition-list">
      <div><dt>事件类型</dt><dd>{item.eventType}</dd></div>
      <div><dt>服务端摘要</dt><dd>{item.summary}</dd></div>
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
        : <span className="activity-meta">{refLabels[ref.kind]}：当前无直达页</span>}
        <code className="activity-ref-id">{ref.id}</code></li>;
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
  const hasActiveFilter = Object.values(active).some(Boolean);
  const filterKey = location.search;
  const [projectId, setProjectId] = useState(active.projectId ?? "");
  const [taskId, setTaskId] = useState(active.taskId ?? "");
  const [runId, setRunId] = useState(active.runId ?? "");
  const [from, setFrom] = useState(active.from ? localInput(active.from) : "");
  const [to, setTo] = useState(active.to ? localInput(active.to) : "");
  const [actorFilter, setActorFilter] = useState<"ALL" | RelayActivityItem["actorKind"]>("ALL");
  const [categoryFilter, setCategoryFilter] = useState<"ALL" | EventCategory>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [items, setItems] = useState<readonly RelayActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [projectOptions, setProjectOptions] = useState<readonly RelayProjectListItem[]>([]);
  const [projectListState, setProjectListState] = useState<"loading" | "ready" | "error">("loading");
  const [projectManual, setProjectManual] = useState(false);
  const projectListScope = useRef(0);
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
    // 续页状态与当前查询同代（#132）：刷新开始新一轮首页查询时，旧续页的在途 Loading
    // 必须就地收口。旧 loadMore 的 finally 只认它出发时的 request 版本，刷新把版本递增后
    // 它不再负责清理，若这里也不重置，按钮会永远停在「正在读取后续页」。
    setLoadingMore(false);
    if (client === null) return;
    void client.getActivities(active).then((page) => {
      if (request === requestVersion.current && keyRef.current === filterKey) {
        setItems(page.items); setNextCursor(page.nextCursor);
      }
    }).catch((caught: unknown) => {
      if (request === requestVersion.current && keyRef.current === filterKey) {
        setError(caught instanceof RelayApiError && [403, 404].includes(caught.problem.status)
          ? "筛选对象当前不可见或无权读取；已清除旧列表，请核对作用域。" : describeLiveError(caught).message);
      }
    }).finally(() => { if (request === requestVersion.current && keyRef.current === filterKey) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [client, filterKey, reload]);

  // 项目下拉候选来自真实的项目列表查询；读取失败时下拉只剩「全部项目 + 手动输入」，不伪造选项。
  useEffect(() => {
    if (client === null) return;
    const scope = ++projectListScope.current;
    setProjectListState("loading");
    void (async () => {
      try {
        const collected: RelayProjectListItem[] = [];
        let cursor: string | null = null;
        do {
          const page = await client.getProjectsPage("active", cursor);
          if (scope !== projectListScope.current) return;
          collected.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== null);
        if (scope !== projectListScope.current) return;
        setProjectOptions(collected);
        setProjectListState("ready");
      } catch {
        if (scope !== projectListScope.current) return;
        setProjectOptions([]);
        setProjectListState("error");
      }
    })();
    return () => { projectListScope.current++; };
  }, [client, connection.epoch]);

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
    if (ids.some((id) => id && !uuid.test(id))) {
      setFormError("项目、任务和 Run 筛选需要完整 UUID；项目可从下拉选择，其余请粘贴完整 ID。");
      return;
    }
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
  const visibleItems = useMemo(() => items.filter((item) =>
    (actorFilter === "ALL" || item.actorKind === actorFilter) &&
    (categoryFilter === "ALL" || eventCategory(item.eventType) === categoryFilter)), [items, actorFilter, categoryFilter]);
  useEffect(() => { setSelectedId(null); }, [actorFilter, categoryFilter]);
  const projectInOptions = projectOptions.some((project) => project.id === projectId);
  const projectManualMode = projectManual || (projectId !== "" && projectListState === "ready" && !projectInOptions);
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
  const selected = selectedId !== null ? visibleItems.find((item) => item.id === selectedId) ?? null : null;

  return <section className="activity-page pv-page">
    <PageHeader testId="activity-page-head" title="动态" overline="Activity" meta="工作空间"
      lede="完整记录工具调用、命令执行、文件变更和重要决定，可按项目、任务、Run 或时间筛选。" />
    {client === null ? <p className="warning-callout" role="status">当前是示例数据预览，没有真实 Activity 记录。<Link to="/projects">打开项目</Link> 继续人工工作。</p> : <>
      <details className="activity-advanced-filter" data-testid="activity-advanced-filter" open={hasActiveFilter}>
        <summary>按项目、任务与时间筛选{hasActiveFilter ? " · 已应用范围" : ""}</summary>
      <form className="surface-panel activity-filter" onSubmit={apply}>
        <label>项目
          <select data-testid="activity-project-filter" value={projectManualMode ? MANUAL_PROJECT_OPTION : projectId}
            disabled={projectListState === "loading"}
            onChange={(event) => { const next = event.target.value; setProjectManual(next === MANUAL_PROJECT_OPTION); if (next !== MANUAL_PROJECT_OPTION) setProjectId(next); }}>
            <option value="">全部项目</option>
            {projectOptions.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
            <option value={MANUAL_PROJECT_OPTION}>手动输入 ID…</option>
          </select>
        </label>
        {projectManualMode && <label>项目 ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="完整 UUID" aria-label="项目 ID" /></label>}
        {projectListState === "error" && <p className="helper-text" role="status">项目列表读取失败，筛选暂只能手动输入完整项目 ID；其余筛选不受影响，可稍后重连后重试。</p>}
        <label>任务 ID<input value={taskId} onChange={(event) => setTaskId(event.target.value)} placeholder="可选 UUID" /></label>
        <label>Run ID<input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="可选 UUID" /></label>
        <label>起始时间（本机时区，包含）<input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>结束时间（本机时区，不包含）<input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <button className="primary-button" type="submit">应用筛选</button>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => setReload((value) => value + 1)}>刷新当前范围</button>
        {formError && <p className="action-error" role="alert">{formError}</p>}
      </form>
      </details>
      <nav className="activity-categories" aria-label="按事件类别筛选（仅已加载项）">
        {categoryFilters.map((option) => <button key={option.value} type="button" className="text-button"
          aria-pressed={categoryFilter === option.value} onClick={() => setCategoryFilter(option.value)}>{option.label}</button>)}
      </nav>
      <div className="activity-toolbar">
        <div className="segmented" role="group" aria-label="按执行方筛选（仅已加载项）">
          {(["ALL", "HUMAN", "AI", "SYSTEM"] as const).map((option) => <button key={option} type="button"
            className={`segmented-option${actorFilter === option ? " segmented-option--selected" : ""}`}
            aria-pressed={actorFilter === option} onClick={() => setActorFilter(option)}>
            {option === "ALL" ? "全部" : actorLabels[option]}</button>)}
        </div>
        <details className="activity-filter-scope">
          <summary>类别与执行方仅筛选已加载的 {items.length} 条 · 范围说明</summary>
          <p className="helper-text">时间按本机时区输入，发送为 UTC；每页由服务端最多返回 30 条，按时间与 ID 倒序。类别与执行方筛选只作用于已加载的 {items.length} 条，服务端暂不支持按执行方分页筛选（待接入）。类别筛选同样不改变服务端范围与游标，可继续加载后续记录。</p>
        </details>
      </div>
      <div className="activity-layout">
        <div className="activity-main">
          {loading && <p className="loading-text" role="status">正在读取当前筛选范围的 Activity…</p>}
          {error && <p className="action-error" role="alert">{error}</p>}
          {!loading && !error && <>
            <p className="helper-text">当前已读取 {items.length} 条{nextCursor ? "；还有后续页" : "；本次查询没有后续游标"}。不把本页数量当作历史总数。</p>
            {visibleItems.length ? <div className="activity-groups">{groups.map((group) => <section key={`${group.key ?? "unknown"}-${group.items[0]!.id}`} className="activity-group">
              <h2 className="activity-day">{group.label}</h2>
              <ol className="activity-list">{group.items.map((item) => <ActivityRow key={item.id} item={item} selected={item.id === selectedId} onSelect={() => setSelectedId((current) => current === item.id ? null : item.id)} />)}</ol>
            </section>)}</div>
              : <p className="helper-text">{items.length ? "当前筛选在已加载项内没有匹配记录；调整类别、执行方或继续加载后重查。" : "当前筛选范围没有返回 Activity。可调整项目、任务、Run 或时间条件后重查。"}</p>}
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
