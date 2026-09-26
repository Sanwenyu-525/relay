import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { RelayApiClient, RelayProject, RelayReview, RelayRun, RelaySearchItem, RelayTaskDetail } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import AppDialog from "./AppDialog";
import "./CommandPalette.css";

const informationTypes = ["KNOWLEDGE", "MEMORY", "DECISION", "RULE"] as const;

interface CurrentContext {
  readonly project: RelayProject | null;
  readonly task: RelayTaskDetail | null;
  readonly run: RelayRun | null;
  readonly reviews: readonly RelayReview[];
  readonly warning: string | null;
}

async function loadContext(client: RelayApiClient, path: string): Promise<CurrentContext> {
  const projectPath = /^\/projects\/([^/]+)(?:\/|$)/u.exec(path);
  const taskPath = /^\/tasks\/([^/]+)$/u.exec(path);
  const runPath = /^\/runs\/([^/]+)$/u.exec(path);
  const run = runPath ? await client.getRun(decodeURIComponent(runPath[1]!)) : null;
  const task = taskPath ? await client.getTask(decodeURIComponent(taskPath[1]!))
    : run ? await client.getTask(run.taskId) : null;
  const projectId = projectPath ? decodeURIComponent(projectPath[1]!) : task?.projectId ?? null;
  const [projectResult, reviewsResult] = await Promise.allSettled([
    projectId ? client.getProject(projectId) : Promise.resolve(null),
    task ? client.getReviews() : Promise.resolve([])
  ]);
  const project = projectResult.status === "fulfilled" ? projectResult.value : null;
  const reviews = reviewsResult.status === "fulfilled" ? reviewsResult.value : [];
  const warning = [projectResult.status === "rejected" ? `项目：${describeLiveError(projectResult.reason).message}` : null,
    reviewsResult.status === "rejected" ? `待审：${describeLiveError(reviewsResult.reason).message}` : null].filter(Boolean).join("；") || null;
  return { project, task, run, reviews: task ? reviews.filter((review) => review.status === "OPEN" && review.taskId === task.id) : [], warning };
}

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const connection = useRelayConnection();
  const client = connection.mode === "live" ? connection.client : null;
  const [context, setContext] = useState<CurrentContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [projectScope, setProjectScope] = useState(false);
  const [results, setResults] = useState<readonly RelaySearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [knownProjectId, setKnownProjectId] = useState("");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [openingProject, setOpeningProject] = useState(false);
  const contextEpoch = useRef(0);
  const searchEpoch = useRef(0);
  const projectEpoch = useRef(0);
  const currentProjectId = context?.project?.id ?? null;

  useEffect(() => {
    const request = ++contextEpoch.current;
    setContext(null); setContextError(null); setProjectScope(false);
    if (!open || client === null) { setContextLoading(false); return; }
    setContextLoading(true);
    void loadContext(client, location.pathname).then((loaded) => {
      if (request !== contextEpoch.current) return;
      setContext(loaded); setProjectScope(loaded.project !== null);
    }).catch((caught: unknown) => {
      if (request === contextEpoch.current) setContextError(describeLiveError(caught).message);
    }).finally(() => { if (request === contextEpoch.current) setContextLoading(false); });
    return () => { contextEpoch.current++; };
  }, [open, client, location.pathname, connection.epoch]);

  useEffect(() => {
    if (open && client !== null) return;
    projectEpoch.current++;
    setOpeningProject(false); setProjectError(null);
  }, [open, client]);

  useEffect(() => {
    const request = ++searchEpoch.current;
    setResults([]); setNextCursor(null); setSearchError(null);
    const q = query.trim();
    if (!open || client === null || !q) { setSearching(false); return; }
    if (q.length > 200) { setSearchError("搜索词最多 200 个字符。"); setSearching(false); return; }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void client.searchInformation({ q, projectId: projectScope ? currentProjectId : null, types: informationTypes, limit: 20 })
        .then((page) => { if (request === searchEpoch.current) { setResults(page.items); setNextCursor(page.nextCursor); } })
        .catch((caught: unknown) => { if (request === searchEpoch.current) setSearchError(describeLiveError(caught).message); })
        .finally(() => { if (request === searchEpoch.current) setSearching(false); });
    }, 250);
    return () => { window.clearTimeout(timer); searchEpoch.current++; };
  }, [open, client, query, projectScope, currentProjectId]);

  async function loadMore() {
    const cursor = nextCursor;
    if (client === null || cursor === null || searching) return;
    const request = searchEpoch.current;
    setSearching(true); setSearchError(null);
    try {
      const page = await client.searchInformation({ q: query.trim(), projectId: projectScope ? currentProjectId : null,
        types: informationTypes, limit: 20, cursor });
      if (request !== searchEpoch.current) return;
      setResults((old) => [...old, ...page.items]); setNextCursor(page.nextCursor);
    } catch (caught) {
      if (request === searchEpoch.current) setSearchError(describeLiveError(caught).message);
    } finally { if (request === searchEpoch.current) setSearching(false); }
  }

  function go(path: string) {
    onClose();
    void navigate(path);
  }

  async function openKnownProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = knownProjectId.trim();
    if (!client || !id || openingProject) return;
    const request = ++projectEpoch.current;
    setOpeningProject(true); setProjectError(null);
    try {
      const project = await client.getProject(id);
      if (request !== projectEpoch.current) return;
      if (project.id.toLowerCase() !== id.toLowerCase()) throw new Error("项目详情与输入 ID 不匹配。");
      go(`/projects/${encodeURIComponent(project.id)}`);
    } catch (caught) {
      if (request === projectEpoch.current) setProjectError(describeLiveError(caught).message);
    } finally { if (request === projectEpoch.current) setOpeningProject(false); }
  }

  const task = context?.task ?? null;
  const canDelegate = client !== null && task !== null && task.status === "READY" && task.executor === "HUMAN" &&
    task.projectId !== null && task.executorRunId === null && task.allowedActions.includes("START");
  const runId = context?.run?.id ?? task?.executorRunId ?? null;
  const review = context?.reviews[0] ?? null;
  return <AppDialog open={open} title="命令面板" initialFocusSelector="[data-testid='command-search']" onClose={onClose}>
    <div className="command-palette" data-testid="command-palette">
      <p className="helper-text">Ctrl+K / ⌘K 打开；Esc 关闭。导航不提交业务命令，委托与审批仍在目标页确认。</p>
      <label className="field"><span className="field-label">搜索资料</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} placeholder="搜索 Knowledge、Memory、Decision、Rule" data-testid="command-search" /></label>
      {currentProjectId && <label className="command-palette-scope"><input type="checkbox" checked={projectScope} onChange={(event) => setProjectScope(event.target.checked)} />仅搜索当前项目 {context?.project?.title}</label>}
      {client === null ? <p className="helper-text">当前为示例数据；真实资料搜索需要连接本机 API。</p> : <>
        {searching && <p role="status">正在搜索真实资料…</p>}
        {searchError && <p className="action-error" role="alert">{searchError}</p>}
        {results.length > 0 && <ul className="command-palette-results">{results.map((item) => <li key={`${item.type}-${item.id}-${item.version}`}>
          <button type="button" onClick={() => { const params = new URLSearchParams({ kind: item.type, item: item.id, q: query.trim() });
            go(`${item.projectId ? `/projects/${encodeURIComponent(item.projectId)}` : ""}/knowledge?${params}`); }}>
            <strong>{item.title}</strong><span>{item.type} v{item.version} · {item.status}</span><small>{item.snippet}</small>
            <small>来源：{item.sourceRef} · {item.projectId ? `项目 ${item.projectId}` : "工作空间"}</small>
          </button></li>)}</ul>}
        {query.trim() && !searching && !searchError && results.length === 0 && <p className="helper-text">当前搜索范围没有匹配资料。</p>}
        {nextCursor && <button className="secondary-button" type="button" disabled={searching} onClick={() => { void loadMore(); }}>继续加载搜索结果</button>}
      </>}
      <div className="command-palette-actions"><h3>前往</h3>
        <button type="button" onClick={() => go("/projects?view=create")}>新建项目 <small>打开已有真实创建表单</small></button>
        <button type="button" onClick={() => go("/tasks?view=create")}>新建任务 <small>打开已有任务表单</small></button>
        <button type="button" onClick={() => go("/inbox")}>打开收件箱 <small>{client ? "读取真实未归属人工任务" : "查看示例收件箱"}</small></button>
        {contextLoading && <p role="status">正在读取当前项目、任务与待审上下文…</p>}
        {contextError && <p className="action-error" role="alert">当前上下文不可读取：{contextError}</p>}
        {context?.warning && <p className="action-error" role="alert">部分当前上下文不可读取：{context.warning}</p>}
        <button type="button" disabled={!currentProjectId} onClick={() => { if (currentProjectId) go(`/projects/${encodeURIComponent(currentProjectId)}`); }}>
          打开当前项目 <small>{context?.project?.title ?? "先打开真实项目"}</small></button>
        <button type="button" disabled={!canDelegate} onClick={() => { if (task) go(`/tasks/${encodeURIComponent(task.id)}?tab=runs`); }}>
          委托当前任务 <small>{canDelegate ? `${task?.title} · 到任务页确认` : "需真实 READY 任务、人工执行权及 START 准入提示"}</small></button>
        <button type="button" disabled={review === null} onClick={() => { if (review) go(`/reviews?id=${encodeURIComponent(review.id)}`); }}>
          查看当前任务待审 <small>{review ? `${review.kind} · ${review.id}` : "当前读取范围未发现待审请求"}</small></button>
        <button type="button" disabled={runId === null} onClick={() => { if (runId) go(`/runs/${encodeURIComponent(runId)}`); }}>
          查看当前 Run <small>{runId ?? "当前任务没有关联 Run"}</small></button>
        <button type="button" onClick={() => go("/activity")}>打开动态 <small>{client ? "读取真实 Activity 事件" : "查看示例动态"}</small></button>
      </div>
      <form className="command-palette-project" onSubmit={(event) => { void openKnownProject(event); }}>
        <label className="field"><span className="field-label">用明确已知的 Project ID 打开</span><input value={knownProjectId} onChange={(event) => setKnownProjectId(event.target.value)} placeholder="Project UUID" data-testid="command-project-id" /></label>
        <button className="secondary-button" type="submit" disabled={client === null || !knownProjectId.trim() || openingProject}>核对并打开项目</button>
        {projectError && <p className="action-error" role="alert">{projectError}</p>}
        <p className="field-hint">这里仍以明确已知的 Project ID 用 GET /projects/:id 核对；项目列表可在“项目”页查看。</p>
      </form>
    </div>
  </AppDialog>;
}
