import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, ListTree, Play, SquareTerminal, X } from "lucide-react";
import RunToolTrajectoryPanel from "./RunToolTrajectoryPanel";
import GitReadPanel from "./GitReadPanel";
import FileBrowsePanel from "./FileBrowsePanel";
import BrowserPreviewPanel from "./BrowserPreviewPanel";
import type { RelayApiClient, RelayManagedResource, RelayRun, RelayRunGatewayOperation } from "../api/relayClient";
import type { PreviewBridge } from "../lib/previewBridge";
import { describeLiveError } from "../lib/liveErrors";
import { handleTabListKeyDown } from "../lib/tabNavigation";
import "./DevToolsPanel.css";

type Tab = "FILES" | "GIT" | "WEB" | "TERMINAL" | "RUNS" | "TRACE";

/**
 * 页签按「主入口 / 辅助入口」分两层（2026-10-28）：
 * 文件、变更、网页是日常会反复用到的三个入口，只留文字页签，激活态靠字重与一条指示线表达，
 * 不再给整排页签铺底色；终端、运行记录、轨迹是低频入口，用「图标 + 文字」的次级样式，
 * 面板窄到放不下文字时由容器查询只留图标（可访问名称与 title 仍在），六项始终可达。
 * 页签条整体不参与收缩竞争：`flex: 0 0 auto` + 末位溢出滚动，收起键因此永远不会被压住。
 */
const PRIMARY_TABS = [["FILES", "文件"], ["GIT", "变更"], ["WEB", "网页"]] as const;
const SECONDARY_TABS = [
  ["TERMINAL", "终端", SquareTerminal],
  ["RUNS", "运行记录", Play],
  ["TRACE", "轨迹", ListTree]
] as const;

/**
 * 轻量空态：标题 + 一句说明 + 可选辅助边界说明 + 可选操作。
 * 靠上排列、不铺占满侧栏的大卡片——空态是「这里现在没什么」的说明，不是一块内容。
 */
function DevToolsEmpty({ testId, title, detail, note, action }: {
  testId: string;
  title: string;
  detail: string;
  note?: string;
  action?: ReactNode;
}) {
  return <div className="devtools-empty" data-testid={testId}>
    <h3 className="devtools-empty-title">{title}</h3>
    <p className="devtools-empty-detail">{detail}</p>
    {note === undefined ? null : <p className="devtools-empty-note">{note}</p>}
    {action === undefined ? null : <div className="devtools-empty-actions">{action}</div>}
  </div>;
}

/**
 * 右侧工具面板：只承载当前项目/任务的只读事实与人工网页预览，不拥有业务状态。
 * 面板打开不执行命令，Git 读取由明确点击触发；关闭只隐藏，旧请求不会重绑到新目录。
 * 右栏页签只列只读工具，命令输出来自底部抽屉，两处互不冒充。
 *
 * 文件与变更需要 Project 资格；网页预览不需要——普通会话里没有项目也能手动看页面，
 * 但不会为此创建占位 Task，也不伪造 ID。终端仍如实显示「未接入」。
 */
export default function DevToolsPanel({ client, projectId, taskId, run, previewBridge, previewScope, onClose }: {
  client: RelayApiClient;
  /** null＝当前会话没有关联项目：文件与变更按资格显示为不可用，不推断任意路径可读。 */
  projectId: string | null;
  taskId: string | null;
  run: RelayRun | null;
  /** null＝非桌面宿主，网页页签如实说明原生容器不可用。 */
  previewBridge: PreviewBridge | null;
  /** 网页关联作用域（workspace + conversation）；切作用域会释放旧实例。 */
  previewScope: string;
  onClose: () => void;
}) {
  const hasProject = projectId !== null;
  // 没有关联项目时文件与变更都只有说明，落在这两个页签上等于开局看空态；
  // 先给当前真的能用的「网页」。用户主动选过别的页签后不会被拉回——重置只在作用域变化时发生。
  const [tab, setTab] = useState<Tab>(() => (hasProject ? "FILES" : "WEB"));
  const tabId = useId();
  const [drawerTab, setDrawerTab] = useState<"OUTPUT" | null>(null);
  const [resources, setResources] = useState<readonly RelayManagedResource[]>([]);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [operations, setOperations] = useState<readonly RelayRunGatewayOperation[]>([]);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const resourceRequest = useRef(0);
  const operationRequest = useRef(0);
  const scope = `${projectId ?? "no-project"}:${taskId ?? "no-task"}`;

  const loadResources = useCallback(async () => {
    if (projectId === null) { setResources([]); setResourceError(null); setLoading(false); return; }
    const version = ++resourceRequest.current;
    setLoading(true); setResourceError(null);
    try {
      const loaded = await client.getManagedResources(projectId);
      if (version !== resourceRequest.current) return;
      setResources(loaded);
    } catch (caught) {
      if (version !== resourceRequest.current) return;
      setResources([]); setResourceError(describeLiveError(caught).message);
    } finally { if (version === resourceRequest.current) setLoading(false); }
  }, [client, projectId]);

  const loadOperations = useCallback(async () => {
    if (!run) { setOperations([]); setOperationError(null); return; }
    const version = ++operationRequest.current;
    setOperationError(null);
    try {
      const loaded = await client.getRunGatewayOperations(run.id);
      if (version !== operationRequest.current) return;
      setOperations(loaded);
    } catch (caught) {
      if (version !== operationRequest.current) return;
      setOperations([]); setOperationError(describeLiveError(caught).message);
    }
  }, [client, run]);

  useEffect(() => {
    resourceRequest.current++; operationRequest.current++;
    setResources([]); setOperations([]); setResourceError(null); setOperationError(null);
    setTab(hasProject ? "FILES" : "WEB"); setDrawerTab(null);
    return () => { resourceRequest.current++; operationRequest.current++; };
  }, [scope, hasProject]);

  useEffect(() => { void loadResources(); }, [loadResources, scope]);
  useEffect(() => { if (drawerTab === "OUTPUT") void loadOperations(); }, [drawerTab, loadOperations]);

  const hasOutput = operations.some((operation) => operation.invocations.some((item) => item.commandOutput !== null));
  const switchToPreview = <button type="button" className="secondary-button secondary-button--compact"
    data-testid="devtools-empty-open-web" onClick={() => setTab("WEB")}>切换到网页预览</button>;

  return <section className="devtools" data-testid="devtools-panel" data-tab={tab} aria-label="文件、网页与运行工具">
    <div className="devtools-pane">
      <header className="devtools-header">
        <nav className="devtools-tabs" role="tablist" aria-label="工具面板" onKeyDown={handleTabListKeyDown}>
          {PRIMARY_TABS.map(([key, label]) => <button key={key} type="button" data-testid={`devtools-tab-${key}`}
            className={`devtools-tab${tab === key ? " devtools-tab--active" : ""}`}
            role="tab" id={`${tabId}-tab-${key}`} aria-controls={`${tabId}-panel`} aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1}
            title={!hasProject && (key === "FILES" || key === "GIT") ? "需要先关联项目" : undefined}
            onClick={() => setTab(key)}><span className="devtools-tab-label">{label}</span></button>)}
          {SECONDARY_TABS.map(([key, label, Icon], index) => <button key={key} type="button"
            data-testid={`devtools-tab-${key}`}
            className={`devtools-tab devtools-tab--secondary${index === 0 ? " devtools-tab--group-start" : ""}${tab === key ? " devtools-tab--active" : ""}`}
            role="tab" id={`${tabId}-tab-${key}`} aria-controls={`${tabId}-panel`} aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1} aria-label={label} title={label}
            onClick={() => setTab(key)}><Icon aria-hidden="true" /><span className="devtools-tab-label">{label}</span></button>)}
        </nav>
        {/* 收起入口只留这一颗，放在页签条右端：与底部「执行输出」抽屉无关，避免两颗同义键。 */}
        <button className="icon-button devtools-close" type="button" aria-label="收起工具面板"
          title="收起工具面板" data-testid="devtools-close" onClick={onClose}><X aria-hidden="true" /></button>
      </header>

      <div className="devtools-body" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-tab-${tab}`}
        tabIndex={0} data-tab={tab}>
        {tab === "FILES" && <section data-testid="devtools-files">
          {!hasProject
            ? <DevToolsEmpty testId="devtools-files-unavailable" title="尚未关联项目"
              detail="关联项目后，可查看其受管文件与 Git 变更。"
              note="读取只限项目已登记的受管目录，不推断本机任意路径。"
              action={switchToPreview} />
            : <>
              <h3>受管目录</h3>
              <p className="helper-text">这里只列出该 Project 已登记的受管目录；目录浏览与文件读取走下方「目录浏览」的显式只读动作，不推断本机任意路径。</p>
              <p className="helper-text">下面是一次读取时的快照，不是实时监视：目录在窗口打开前后被停用、归档或以同一路径重新登记，
                都要重新读取才知道；Git 读取也会把服务端的拒绝原样呈现。</p>
              {loading && <p className="helper-text" role="status">正在读取受管目录…</p>}
              {resourceError && <p className="action-error" role="alert" data-testid="devtools-resource-error">{resourceError}</p>}
              {!loading && !resourceError && resources.length === 0 && <p className="helper-text">当前项目没有登记受管目录；这不是“工作目录干净”的结论。</p>}
              {resources.length > 0 && <ul className="devtools-list">{resources.map((resource) => <li key={resource.id}>
                <span><code className="hash-code">{resource.canonicalRoot}</code>
                  <small>状态 {resource.status} · 资源修订 v{resource.revision} · 写身份已绑定：{resource.fileWriteIdentityBound ? "是" : "否"}</small></span>
              </li>)}</ul>}
              <button className="secondary-button secondary-button--compact" type="button" data-testid="devtools-reload-resources"
                disabled={loading} onClick={() => void loadResources()}>重新读取受管目录</button>
              <FileBrowsePanel client={client} projectId={projectId} resources={resources}
                resourceLoading={loading} resourceError={resourceError} />
              <h3>本任务的受管产物</h3>
              <p className="helper-text">受管产物是任务产物版本，工作目录文件是受管目录下的普通文件；两者来源不同，不混成同一版本。产物正文在右侧产物区按确切版本阅读。</p>
              {taskId === null
                ? <p className="helper-text">当前没有关联任务，因此没有任务产物版本可读。</p>
                : <Link className="text-link" to={`/tasks/${taskId}?tab=artifacts`}>打开任务产物版本</Link>}
            </>}
        </section>}

        {/* 变更面板保持挂载：切走再切回不丢已读到的目录与拒绝原因。 */}
        <div hidden={tab !== "GIT"}>{hasProject
          ? <GitReadPanel key={`${scope}:${client.baseUrl}:${client.workspaceId}`} client={client}
            projectId={projectId} resources={resources} resourceLoading={loading} resourceError={resourceError} />
          : <DevToolsEmpty testId="devtools-git-unavailable" title="尚未关联项目"
            detail="变更读取绑定项目的受管目录，当前没有可核对的目录基线。"
            note="这不是「工作目录干净」的结论。"
            action={switchToPreview} />}</div>

        {/* 网页页签常驻挂载：切走再切回不重建标签，也不重新加载页面。 */}
        <div hidden={tab !== "WEB"}>
          <BrowserPreviewPanel bridge={previewBridge} scope={previewScope} active={tab === "WEB"} />
        </div>

        {tab === "TERMINAL" && <section data-testid="devtools-terminal">
          <h3>交互终端 · 未接入</h3>
          <p className="warning-callout" role="status" data-testid="devtools-terminal-gap">
            交互终端的受管工作目录、人工执行身份、进程生命周期、权限、审计、资源排他与断连恢复协议尚未确定，因此本页不提供可执行提示符。
          </p>
          <p className="helper-text">人工打开终端不授予 Agent 权限，也不能绕过在途写入与接手保护；缺少协议前不提供可执行入口。</p>
        </section>}

        {tab === "TRACE" && <RunToolTrajectoryPanel client={client} run={run} />}

        {tab === "RUNS" && <section data-testid="devtools-runs">
          <h3>运行记录</h3>
          <p className="helper-text">这里只打开已有 Run 事实；它不是启动按钮，执行仍通过显式委托或受控命令入口。</p>
          {run ? <><p className="helper-text">当前 Run：<code className="hash-code">{run.id}</code> · 状态 {run.status} · 修订 v{run.revision}</p>
            <Link className="text-link" to={`/runs/${run.id}`}>打开运行记录（步骤、事件、控制与检查）</Link></>
            : <p className="helper-text">当前任务没有 AI Run；本页不推断历史执行记录。</p>}
        </section>}
      </div>
    </div>

    {/* 底部抽屉：收起时只留一行 32px 的开关，展开后自己滚动，不遮挡上方页签与网页预览。
        抽屉只读服务端保存的命令输出；交互终端仍是「待设计」声明，不做成可点入口。 */}
    <div className="devtools-drawer" data-open={drawerTab === "OUTPUT" ? "true" : undefined}>
      <div className="devtools-drawer-bar">
        <button type="button" className="devtools-drawer-toggle" data-testid="devtools-tab-OUTPUT"
          id={`${tabId}-output-toggle`} aria-expanded={drawerTab === "OUTPUT"} aria-controls={`${tabId}-output`}
          onClick={() => setDrawerTab((current) => current === "OUTPUT" ? null : "OUTPUT")}>
          <ChevronRight className="devtools-drawer-chevron" aria-hidden="true" />
          <span>执行输出</span>
        </button>
        <span className="devtools-drawer-pending">交互终端 · 待设计</span>
      </div>

      <div className="devtools-drawer-body" id={`${tabId}-output`} role="region" aria-labelledby={`${tabId}-output-toggle`} hidden={drawerTab !== "OUTPUT"}>
        {drawerTab === "OUTPUT" && <section data-testid="devtools-output">
          {!run && <p className="helper-text" data-testid="devtools-output-empty">当前任务没有 AI Run，因此没有可归属的命令输出；Trace 不冒充 stdout。</p>}
          {run && operationError && <p className="action-error" role="alert" data-testid="devtools-output-error">{operationError}</p>}
          {run && !operationError && !hasOutput && <p className="helper-text" data-testid="devtools-output-empty">本次 Run 没有任何已保存的命令输出。打开面板不执行命令。</p>}
          {run && operations.map((operation) => <details key={operation.id} className="devtools-operation">
            <summary>{operation.actionType} · {operation.status} · {operation.normalizedTarget} · {operation.invocations.length} 次调用</summary>
            <p className="helper-text">原 operation_id：<code className="hash-code">{operation.id}</code> · 目标 {operation.normalizedTarget} · 来源 Run <code className="hash-code">{run.id}</code></p>
            {operation.invocations.map((invocation) => <div key={invocation.id ?? invocation.status} className="devtools-invocation">
              <p className="helper-text">Invocation {invocation.id ?? "服务端未返回标识"} · 状态 {invocation.status}
                {invocation.resolvedAt ? ` · 结束于 ${invocation.resolvedAt}` : " · 尚未结束"}</p>
              {invocation.commandOutput === null
                ? <p className="helper-text">这次调用没有保存 stdout/stderr；不能据此推断命令成功或失败。</p>
                : <div className="devtools-output">
                    <p className="helper-text">退出码 {invocation.commandOutput.exitCode ?? "未记录"}
                      {invocation.commandOutput.outcome ? ` · 结果 ${invocation.commandOutput.outcome}` : ""}
                      {invocation.commandOutput.durationMs !== null ? ` · 耗时 ${invocation.commandOutput.durationMs}ms` : ""}
                      {invocation.commandOutput.truncated ? " · 输出已截断" : ""}
                      {invocation.commandOutput.invocationId ? ` · 原 Invocation ${invocation.commandOutput.invocationId}` : " · 原 Invocation 标识未返回"}</p>
                  {invocation.commandOutput.stdout && <pre data-testid={`devtools-stdout-${invocation.commandOutput.invocationId ?? "unknown"}`}>{invocation.commandOutput.stdout}</pre>}
                  {invocation.commandOutput.stderr && <pre className="devtools-stderr" data-testid={`devtools-stderr-${invocation.commandOutput.invocationId ?? "unknown"}`}>{invocation.commandOutput.stderr}</pre>}
                  {!invocation.commandOutput.stdout && !invocation.commandOutput.stderr && <p className="helper-text">命令没有产生标准输出或错误输出。</p>}
                </div>}
            </div>)}
          </details>)}
        </section>}
      </div>
    </div>
  </section>;
}
