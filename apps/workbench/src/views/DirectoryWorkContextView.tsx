import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FolderOpen, RotateCcw } from "lucide-react";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ResponsiveRail from "../components/ResponsiveRail";
import type { RelayApiClient, RelayDirectoryWorkContext } from "../api/relayClient";
import { goalStatusLabels, projectTypeLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";

/**
 * 普通受管目录的只读工作上下文。
 *
 * 会话只来自 `working_resource_id` 精确等于该目录、且 `task_id IS NULL` 的普通会话；
 * 同一 Project 的其他目录或未绑定目录的会话不会混入。这里只做导航，不创建或重绑 Session，
 * 也不授予文件、工具或执行权限。
 */
export default function DirectoryWorkContextView() {
  const { id = "" } = useParams();
  const connection = useRelayConnection();
  return connection.client
    ? <LiveDirectoryContext key={`${connection.epoch}:${id}`} id={id} client={connection.client} />
    : <section className="page-state" data-testid="directory-context-fixture-gap">
      <p className="eyebrow"><FolderOpen aria-hidden="true" />目录</p>
      <h1>示例模式没有目录工作上下文</h1>
      <p>目录与普通会话来自本机 API 的受管资源事实；示例模式不生成目录或会话。</p>
      <Link className="secondary-button" to="/projects">返回项目</Link>
    </section>;
}

function LiveDirectoryContext({ id, client }: { id: string; client: RelayApiClient }) {
  const [facts, setFacts] = useState<RelayDirectoryWorkContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const version = useRef(0);

  useEffect(() => {
    const request = ++version.current;
    setLoading(true); setError(null); setFacts(null);
    void client.getDirectoryWorkContext(id, "ALL")
      .then((next) => { if (request === version.current) setFacts(next); })
      .catch((caught: unknown) => {
        if (request === version.current) setError(describeLiveError(caught).message);
      })
      .finally(() => { if (request === version.current) setLoading(false); });
    return () => { version.current++; };
  }, [client, id, reload]);

  if (loading) return <section className="page-state" role="status">
    <p className="eyebrow">目录</p><h1>正在读取目录工作上下文</h1>
    <p>只读查询目录、所属项目、关联 Goal 与会话，不会创建或重绑会话。</p></section>;
  if (error || facts === null) return <section className="page-state page-state--error" role="alert">
    <p className="eyebrow">目录</p><h1>暂时无法读取目录</h1>
    <p>{error ?? "目录事实不可用。"}</p>
    <button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}>
      <RotateCcw aria-hidden="true" />重新读取</button>
  </section>;

  const { directory, linkedGoals, sessions } = facts;
  const project = directory.project;

  return <section className="skill-page project-overview pv-page" data-testid="directory-context-live">
    <div className="page-layout"><div className="page-primary">
      <p className="metadata-row"><Link className="inline-link" to={`/projects/${project.id}`}>← 打开所属项目</Link></p>
      <PageHeader testId="directory-context-head" title={directory.canonicalRoot}
        meta={`${projectTypeLabels[project.projectType as keyof typeof projectTypeLabels] ?? project.projectType} · ${project.title} · 目录 v${directory.revision}`}
        status={<span className={`status-chip ${directory.status === "ACTIVE" ? "status-chip--success" : "status-chip--neutral"}`}>
          {directory.status === "ACTIVE" ? "目录可用" : "目录已停用"}</span>}
        lede="这里只汇集精确绑定到该目录的普通会话；切换入口不会改变 Session ID、Project 绑定或历史。"
        actions={<button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}>
          <RotateCcw aria-hidden="true" />刷新</button>} />
      {project.archiveStatus === "ARCHIVED" && <p className="warning-callout" role="status">
        所属项目已归档：目录与会话只读；归档不会删除原有历史。
      </p>}
      <section className="resume-section" data-testid="directory-context-project">
        <h2>所属项目</h2>
        <dl className="rail-definition-list">
          <div><dt>项目</dt><dd><Link className="inline-link" to={`/projects/${project.id}`}>{project.title}</Link></dd></div>
          <div><dt>状态</dt><dd>{project.archiveStatus === "ARCHIVED" ? "已归档" : "进行中"} · Project v{project.revision}</dd></div>
          <div><dt>目录</dt><dd>{directory.canonicalRoot} · v{directory.revision}</dd></div>
        </dl>
      </section>
      <section className="resume-section" data-testid="directory-context-goals">
        <h2>关联 Goal</h2>
        <p className="helper-text">来自所属 Project 当前的 Goal 关联；Goal 关联不代表任何 Task 显式对齐该 Goal。</p>
        {linkedGoals.length === 0
          ? <p className="helper-text">所属项目当前没有关联 Goal。</p>
          : <ul className="run-list">{linkedGoals.map((goal) => <li key={goal.id}>
            <Link className="inline-link" to={`/goals/${goal.id}`}>{goal.title}</Link>
            {" · "}{goalStatusLabels[goal.status] ?? goal.status} · v{goal.revision}</li>)}</ul>}
      </section>
      <section className="resume-section" data-testid="directory-context-sessions">
        <h2>这个目录的普通会话</h2>
        {sessions.length === 0
          ? <EmptyState size="compact" icon={FolderOpen} title="这个目录还没有普通会话"
            description="只显示 working_resource_id 精确等于本目录的会话；项目其他目录或未绑定目录的会话不会出现在这里。" />
          : <ul className="run-list">{sessions.map((session) => <li key={session.id}
            data-testid={`directory-session-${session.id}`}>
            <Link className="inline-link" data-testid={`directory-session-open-${session.id}`}
              to={`/agent?session=${encodeURIComponent(session.id)}&project=${encodeURIComponent(session.projectId)}`}>
              {session.title}</Link>
            {" · "}{goalStatusLabels[session.status] ?? session.status} · Session v{session.revision}
            <small>原 Session ID：{session.id}</small>
          </li>)}</ul>}
      </section>
      <details className="page-explanation"><summary>范围与权限说明</summary>
        <p className="helper-text">这里只投影现存事实：不创建会话、不重绑目录、不修改 Project 或 Goal。
          打开会话仍沿用原会话的权限与执行契约；能看到会话不等于获得文件或工具执行授权。</p>
      </details>
    </div><ResponsiveRail label="查看目录入口" title="入口"><div className="rail-content">
      <h2>入口</h2>
      <Link className="secondary-button secondary-button--wide" to={`/projects/${project.id}`}>项目总览</Link>
      <Link className="secondary-button secondary-button--wide" to="/projects">全部项目</Link>
      <Link className="secondary-button secondary-button--wide" to="/goals">全部目标</Link>
    </div></ResponsiveRail></div>
  </section>;
}
