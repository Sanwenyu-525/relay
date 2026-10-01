import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Plus, RotateCcw } from "lucide-react";
import { RelayApiError, type RelayApiClient, type RelayProjectListItem, type RelayTaskSummary } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

interface Loaded {
  readonly tasks: readonly RelayTaskSummary[];
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly nextCursor: string | null;
  readonly loadedAt: string;
}

/**
 * 全局左栏的「近期工作」分组：直接来自服务端 Task 列表投影，范围是当前工作空间全部任务，
 * 排序是服务端 updated_at 倒序。选中态由 URL（/agent?work=）承担，因此深链接和刷新都能恢复同一工作。
 * 这里不读 Assist 会话列表冒充全部工作，也不自动绑定最新 Run。
 */
export default function RecentWorkRail({ client, currentTaskId, onOpen }: {
  client: RelayApiClient;
  currentTaskId: string | null;
  onOpen?: () => void;
}) {
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagingError, setPagingError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async (cursor: string | null) => {
    const version = ++request.current;
    if (cursor === null) { setLoaded(null); setLoading(true); setError(null); } else setLoadingMore(true);
    setPagingError(null);
    try {
      const [page, projects] = await Promise.all([
        client.getWorkspaceTasksPage(cursor), client.getProjectsPage("active", null)
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
      setLoaded((current) => ({
        tasks: cursor === null ? sorted : [...new Map([...(current?.tasks ?? []), ...sorted].map((task) => [task.id, task])).values()],
        projectTitles: cursor === null ? titles : new Map([...(current?.projectTitles ?? []), ...titles]),
        nextCursor: page.nextCursor, loadedAt: new Date().toISOString()
      }));
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

  const tasks = loaded?.tasks ?? [];
  const groups = new Map<string | null, RelayTaskSummary[]>();
  for (const task of tasks) {
    const group = groups.get(task.projectId) ?? [];
    group.push(task);
    groups.set(task.projectId, group);
  }
  const open = (taskId: string) => { void navigate(`/agent?work=${encodeURIComponent(taskId)}`); onOpen?.(); };

  return <section className="recent-work" aria-label="近期工作" data-testid="recent-work">
    <div className="recent-work-heading">
      <h2>最近的任务</h2>
      <button className="icon-button" type="button" aria-label="刷新近期工作" data-testid="recent-work-refresh"
        onClick={() => void load(null)}><RotateCcw aria-hidden="true" /></button>
    </div>
    <p className="recent-work-scope" title="全部任务 · 按最近变更排序">已加载 {tasks.length} 项{loaded?.nextCursor ? " · 还有更早任务" : ""}</p>
    <div className="recent-work-scroll" role="region" aria-label="近期工作列表" tabIndex={0}>
      {loading && <p className="helper-text" role="status">正在读取…</p>}
      {error && <p className="action-error" role="alert" data-testid="recent-work-error">{error}</p>}
      {!loading && !error && tasks.length === 0 &&
        <p className="helper-text">当前工作空间还没有任务。</p>}
      <div data-testid="recent-work-list">{[...groups].map(([projectId, groupTasks]) => <details
        className="recent-work-group" open key={`${projectId ?? "unassigned"}:${groupTasks.some((task) => task.id === currentTaskId) ? currentTaskId : ""}`}>
        <summary><ChevronDown aria-hidden="true" /><span>{projectId === null ? "未归入项目" : loaded?.projectTitles.get(projectId) ?? "项目标题暂不可读取"}</span></summary>
        <ul className="recent-work-list">{groupTasks.map((task) => {
        const project = task.projectId === null ? null : loaded?.projectTitles.get(task.projectId) ?? null;
        const label = `${task.title} · ${project ?? (task.projectId === null ? "无项目" : "项目标题暂不可读取")}`;
        const active = currentTaskId === task.id;
        return <li key={task.id}><button type="button"
          className={`recent-work-item${active ? " recent-work-item--active" : ""}`}
          aria-label={label} title={label}
          data-testid={`recent-work-${task.id}`} aria-current={active ? "true" : undefined}
          onClick={() => open(task.id)}>
          <span className="recent-work-copy">
            <span className="recent-work-title">{task.title}</span>
          </span>
        </button></li>;
      })}</ul></details>)}</div>
      {pagingError && <p className="action-error" role="alert">{pagingError}</p>}
      {loaded?.nextCursor && <button className="secondary-button" type="button" disabled={loadingMore}
        data-testid="recent-work-more" onClick={() => void load(loaded.nextCursor)}>{loadingMore ? "正在读取" : "更早"}</button>}
    </div>
    <button className="secondary-button" type="button" data-testid="recent-work-new" aria-label="开始一项工作"
      onClick={() => { void navigate("/agent"); onOpen?.(); }}>
      <Plus aria-hidden="true" />开始一项工作</button>
  </section>;
}
