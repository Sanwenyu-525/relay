import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, RotateCcw, Search } from "lucide-react";
import { RelayApiError, type RelayApiClient, type RelayProjectListItem, type RelayTaskSummary } from "../api/relayClient";
import { useActiveConversation } from "../lib/activeConversation";
import { describeLiveError } from "../lib/liveErrors";
import { railGroupKey, readCollapsedRailGroups, writeCollapsedRailGroups } from "../lib/railGroupPreferences";
import EmptyState from "./EmptyState";
import TargetPicker, { type TargetPickerSelection } from "./TargetPicker";

interface Loaded {
  readonly tasks: readonly RelayTaskSummary[];
  /** 工作区级会话（task_id 为空）。挂在任务上的会话由那一行任务承担，不在这里重复列。 */
  readonly sessions: readonly { readonly id: string; readonly title: string;
    readonly projectId: string | null; readonly updatedAt: string }[];
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly nextCursor: string | null;
  readonly loadedAt: string;
}

interface Row {
  readonly key: string;
  readonly kind: "task" | "session";
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly updatedAt: string | null;
}

/**
 * 左栏的「近期工作」分组（协作页 §3.1 重塑）。
 *
 * 范围仍是「当前工作空间已加载的任务与会话」，排序仍是服务端时间倒序：
 * 选中态由 URL（`/agent?work=`、`/agent?session=`）承担，因此深链接与刷新都能恢复同一处工作。
 * 这里不读 Assist 会话列表冒充全部工作，也不自动绑定最新 Run。
 */
export default function RecentWorkRail({ client, currentTaskId, onOpen }: {
  client: RelayApiClient;
  currentTaskId: string | null;
  onOpen?: () => void;
}) {
  const navigate = useNavigate();
  const active = useActiveConversation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [pagingError, setPagingError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<readonly string[]>(readCollapsedRailGroups);
  const [pickerOpen, setPickerOpen] = useState(false);
  const request = useRef(0);
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (cursor: string | null) => {
    const version = ++request.current;
    if (cursor === null) { setLoaded(null); setLoading(true); setError(null); } else setLoadingMore(true);
    setPagingError(null);
    if (cursor === null) setSessionsError(null);
    try {
      // 会话与任务同时发起（保持左栏「先任务、再项目、再会话」的固定读取顺序），
      // 但会话的失败被就地吸收：它读不到不能把已经读到的任务列表一起清掉，
      // 也不能假装「没有会话」——失败原因如实显示在列表下方，任务行照常可用。
      const [page, projects, sessionResult] = await Promise.all([
        client.getWorkspaceTasksPage(cursor), client.getProjectsPage("active", null),
        client.getAssistSessions().then((items) => ({ items, error: null as string | null }),
          (caught: unknown) => ({ items: [], error: describeLiveError(caught).message }))
      ]);
      if (version !== request.current) return;
      const titles = new Map(projects.items.map((project: RelayProjectListItem) => [project.id, project.title]));
      const sorted = [...page.items].sort((a, b) => {
        // 服务端没给 updated_at 的排在有时间的之后，不用客户端时间补齐。
        if (a.updatedAt === null && b.updatedAt === null) return 0;
        if (a.updatedAt === null) return 1;
        if (b.updatedAt === null) return -1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
      const workspaceSessions = sessionResult.items.filter((session) => session.taskId === null)
        .map((session) => ({ id: session.id, title: session.title,
          projectId: session.projectId, updatedAt: session.updatedAt }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setLoaded((current) => ({
        tasks: cursor === null ? sorted : [...new Map([...(current?.tasks ?? []), ...sorted].map((task) => [task.id, task])).values()],
        // 续页时若会话这次没读到，保留上一次的结果，不用一次失败把已有行清掉。
        sessions: cursor === null || sessionResult.error === null ? workspaceSessions : current?.sessions ?? [],
        projectTitles: cursor === null ? titles : new Map([...(current?.projectTitles ?? []), ...titles]),
        nextCursor: page.nextCursor, loadedAt: new Date().toISOString()
      }));
      if (cursor === null) setSessionsError(sessionResult.error);
    } catch (caught) {
      if (version !== request.current) return;
      const described = describeLiveError(caught);
      const message = described.kind === "transport" ? "近期工作暂时无法读取，请刷新重试。" : described.message;
      if (cursor === null || caught instanceof RelayApiError && [401, 403, 404].includes(caught.problem.status)) {
        setLoaded(null); setError(message);
      } else setPagingError(message);
    } finally {
      if (version === request.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [client]);

  useEffect(() => {
    void load(null);
    return () => { request.current++; };
  }, [load]);

  // 会话创建/切换由协作页发布确切身份；只读回这一条，不重置已经加载的任务分页。
  useEffect(() => {
    if (active.taskId !== null || active.sessionId === null) return;
    const sessionId = active.sessionId;
    let current = true;
    void client.getAssistSession(sessionId).then((session) => {
      if (!current || session.id !== sessionId || session.taskId !== null) return;
      setLoaded((previous) => previous === null ? previous : { ...previous,
        sessions: [{ id: session.id, title: session.title, projectId: session.projectId,
          updatedAt: session.updatedAt }, ...previous.sessions.filter((item) => item.id !== session.id)] });
    }).catch(() => {
      if (current) setSessionsError("当前会话暂未能在近期工作中核对，请刷新重试。");
    });
    return () => { current = false; };
  }, [client, active.taskId, active.sessionId]);

  const tasks = loaded?.tasks ?? [];
  const sessions = loaded?.sessions ?? [];
  // 未归入项目时组标题与副行用同一句话：同一列里出现两种说法会读成两个不同的状态。
  const projectName = useCallback((projectId: string | null) => projectId === null ? "未归入项目"
    : loaded?.projectTitles.get(projectId) ?? "项目标题暂不可读取", [loaded]);
  // 只在已加载范围内筛，不替服务端承诺全量搜索：命中数与已加载数必须同时可读。
  const needle = query.trim().toLowerCase();
  const hit = (text: string) => needle === "" || text.toLowerCase().includes(needle);
  const visibleTasks = tasks.filter((task) => hit(`${task.title} ${loaded?.projectTitles.get(task.projectId ?? "") ?? ""}`));
  const visibleSessions = sessions.filter((session) => hit(`${session.title} ${loaded?.projectTitles.get(session.projectId ?? "") ?? ""}`));
  const loadedCount = tasks.length + sessions.length;

  const rows: readonly Row[] = [
    ...visibleTasks.map((task): Row => ({ key: `task:${task.id}`, kind: "task", id: task.id,
      title: task.title, projectId: task.projectId, updatedAt: task.updatedAt })),
    ...visibleSessions.map((session): Row => ({ key: `session:${session.id}`, kind: "session", id: session.id,
      title: session.title, projectId: session.projectId, updatedAt: session.updatedAt }))
  ];
  const groups = new Map<string | null, Row[]>();
  for (const row of rows) {
    const group = groups.get(row.projectId) ?? [];
    group.push(row);
    groups.set(row.projectId, group);
  }
  const isActiveRow = (row: Row) => row.kind === "task"
    ? currentTaskId === row.id
    : active.taskId === null && active.sessionId === row.id;

  function openRow(row: Row) {
    void navigate(row.kind === "task"
      ? `/agent?work=${encodeURIComponent(row.id)}`
      : `/agent?session=${encodeURIComponent(row.id)}`);
    onOpen?.();
  }
  function openSelection(next: TargetPickerSelection) {
    if (next.taskId !== null) {
      const session = next.sessionId === null ? "" : `&session=${encodeURIComponent(next.sessionId)}`;
      void navigate(`/agent?work=${encodeURIComponent(next.taskId)}${session}`);
    } else if (next.sessionId !== null) void navigate(`/agent?session=${encodeURIComponent(next.sessionId)}`);
    setPickerOpen(false); onOpen?.();
  }
  function toggleGroup(key: string, open: boolean) {
    setCollapsed((current) => {
      const next = open ? current.filter((item) => item !== key) : current.includes(key) ? current : [...current, key];
      writeCollapsedRailGroups(next);
      return next;
    });
  }

  return <section className="recent-work" aria-label="近期工作" data-testid="recent-work">
    <label className="search-field recent-work-search">
      <Search aria-hidden="true" />
      <span className="visually-hidden">在已加载的近期任务与会话中搜索</span>
      <input type="search" value={query} placeholder="搜索已加载的项目或任务…"
        data-testid="recent-work-search" onChange={(event) => setQuery(event.target.value)} />
    </label>
    <div className="recent-work-heading">
      {/* 已加载数量与后续页属于范围说明：与标题同排，不另占一行，但仍能直接读到。 */}
      <h2 title="全部任务与会话 · 按最近变更排序">近期的任务</h2>
      {loadedCount > 0 && <p className="recent-work-count" data-testid="recent-work-scope"
        title={loaded?.nextCursor ? "还有更早任务，可继续分页读取" : "已读到最后一页"}>已加载 {loadedCount} 项</p>}
      <button className="icon-button" type="button" aria-label="刷新近期工作" data-testid="recent-work-refresh"
        onClick={() => void load(null)}><RotateCcw aria-hidden="true" /></button>
    </div>
    <div className="recent-work-scroll" role="region" aria-label="近期工作列表" tabIndex={0}>
      {loading && <p className="helper-text" role="status">正在读取…</p>}
      {error && <p className="action-error" role="alert" data-testid="recent-work-error">{error}</p>}
      {/* 首装与搜索无匹配是两件事：前者说明工作空间还没有任何任务或会话，后者只说明已加载范围内没有命中。
          这里用紧凑空态、不放主操作——侧栏只是定位入口，新建任务的主决策区在任务页。 */}
      {!loading && !error && loadedCount === 0 &&
        <EmptyState size="compact" title="还没有任务"
          description="当前工作空间还没有任何任务或会话。项目、任务与产物版本都只从本机服务端读取，不会从别处自动出现。"
          testId="recent-work-empty"
          actions={<button className="text-button" type="button"
            onClick={() => { void navigate("/tasks?view=create"); onOpen?.(); }}>新建任务</button>} />}
      {!loading && !error && loadedCount > 0 && rows.length === 0 &&
        <EmptyState size="compact" title="没有匹配项"
          description={`已加载的 ${loadedCount} 项里没有匹配项；搜索只覆盖已加载范围，可继续读取更早任务。`}
          testId="recent-work-no-match" />}
      <div data-testid="recent-work-list">{[...groups].map(([projectId, groupRows]) => {
        const key = railGroupKey(projectId);
        // 当前所在项所在的分组总是展开：否则高亮落在折叠体里，用户看不到自己在哪。
        const open = !collapsed.includes(key) || groupRows.some(isActiveRow);
        return <details className="recent-work-group" open={open} key={key}
          onToggle={(event) => { if (event.currentTarget.open !== open) toggleGroup(key, event.currentTarget.open); }}>
          <summary><ChevronDown aria-hidden="true" /><span className="recent-work-group-title">
            {projectName(projectId)}</span>
            <span className="recent-work-group-count">{groupRows.length}</span></summary>
          <ul className="recent-work-list">{groupRows.map((row) => {
            const isActive = isActiveRow(row);
            // 组标题已经说明「属于谁」，行内不再重复项目名：可访问名称仍带完整「标题 · 项目」。
            const label = `${row.kind === "session" ? "会话 · " : ""}${row.title} · ${projectName(row.projectId)}`;
            return <li key={row.key}><button type="button"
              className={`recent-work-item${isActive ? " recent-work-item--active" : ""}`}
              aria-label={label} title={label}
              data-testid={`recent-work-${row.id}`} aria-current={isActive ? "true" : undefined}
              onClick={() => openRow(row)}>
              <span className="recent-work-copy">
                <span className="recent-work-title">{row.title}</span>
                {/* 归属由组标题承担，这里只留不重复的信息：类型与「什么时候动过」。 */}
                <span className="recent-work-sub">
                  {row.kind === "session" && <span className="recent-work-kind">会话</span>}
                  {row.updatedAt !== null && <span className="recent-work-time">{formatRailTime(row.updatedAt)}</span>}
                </span>
              </span>
            </button></li>;
          })}</ul></details>;
      })}</div>
      {pagingError && <p className="action-error" role="alert">{pagingError}</p>}
      {loaded?.nextCursor && <button className="secondary-button" type="button" disabled={loadingMore}
        title={`已加载 ${tasks.length} 项任务，继续读取更早任务`} data-testid="recent-work-more"
        onClick={() => void load(loaded.nextCursor)}>{loadingMore ? "正在读取" : `更早的任务（已加载 ${tasks.length} 项）`}</button>}
    </div>
    {/* 「查找更多」在专栏底部就地展开：不再弹对话框，因此焦点、Esc 与「收起」都在这一列内闭合。 */}
    {sessionsError !== null && <p className="helper-text" role="status" data-testid="recent-work-sessions-error">
      会话列表暂时读不到：{sessionsError} 任务列表仍按已加载范围显示。</p>}
    <div className="recent-work-more">
      <button className="text-button recent-work-more-trigger" type="button" ref={pickerTriggerRef}
        aria-expanded={pickerOpen} aria-controls="recent-work-picker"
        data-testid="recent-work-find-more"
        onClick={() => setPickerOpen((open) => !open)}>查找更多任务 / 会话</button>
      {pickerOpen && <div id="recent-work-picker">
        <TargetPicker client={client} onOpen={openSelection}
          onClose={() => { setPickerOpen(false); pickerTriggerRef.current?.focus(); }} /></div>}
    </div>
  </section>;
}

/** 侧栏只表达「什么时候动过」：同年不写年份，避免 14rem 栏宽里出现无信息量的重复。 */
function formatRailTime(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const sameYear = at.getFullYear() === new Date().getFullYear();
  return at.toLocaleString("zh-CN", { ...(sameYear ? {} : { year: "numeric" }),
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
