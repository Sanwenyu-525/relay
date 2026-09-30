import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FileText, GitBranch, Play, SquareTerminal, Terminal, X } from "lucide-react";
import type { RelayApiClient, RelayManagedResource, RelayRun, RelayRunGatewayOperation } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./DevToolsPanel.css";

type Tab = "FILES" | "GIT" | "TERMINAL" | "RUNS";

/**
 * 开发工具面板：只承载当前项目/任务的只读事实，不拥有业务状态。
 * 面板打开不执行任何命令，关闭只隐藏；切换项目不会把旧面板重绑到新目录。
 * 右栏页签只列只读工具，命令输出来自底部抽屉，两处互不冒充。
 */
export default function DevToolsPanel({ client, projectId, taskId, run, onClose }: {
  client: RelayApiClient;
  projectId: string;
  taskId: string;
  run: RelayRun | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("FILES");
  const [drawerTab, setDrawerTab] = useState<"OUTPUT" | null>(null);
  const [resources, setResources] = useState<readonly RelayManagedResource[]>([]);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [operations, setOperations] = useState<readonly RelayRunGatewayOperation[]>([]);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const scope = `${projectId}:${taskId}`;

  const loadResources = useCallback(async () => {
    const version = ++request.current;
    setLoading(true); setResourceError(null);
    try {
      const loaded = await client.getManagedResources(projectId);
      if (version !== request.current) return;
      setResources(loaded);
    } catch (caught) {
      if (version !== request.current) return;
      setResources([]); setResourceError(describeLiveError(caught).message);
    } finally { if (version === request.current) setLoading(false); }
  }, [client, projectId]);

  const loadOperations = useCallback(async () => {
    if (!run) { setOperations([]); setOperationError(null); return; }
    const version = ++request.current;
    setOperationError(null);
    try {
      const loaded = await client.getRunGatewayOperations(run.id);
      if (version !== request.current) return;
      setOperations(loaded);
    } catch (caught) {
      if (version !== request.current) return;
      setOperations([]); setOperationError(describeLiveError(caught).message);
    }
  }, [client, run]);

  useEffect(() => {
    request.current++;
    setResources([]); setOperations([]); setResourceError(null); setOperationError(null);
    setTab("FILES"); setDrawerTab(null);
    return () => { request.current++; };
  }, [scope]);

  useEffect(() => { void loadResources(); }, [loadResources]);
  useEffect(() => { if (drawerTab === "OUTPUT") void loadOperations(); }, [drawerTab, loadOperations]);

  const hasOutput = operations.some((operation) => operation.invocations.some((item) => item.commandOutput !== null));

  return <section className="devtools" data-testid="devtools-panel" aria-label="文件与运行工具">
    <div className="devtools-pane">
      <header className="devtools-header">
        <nav className="devtools-tabs" aria-label="工具面板">
          {([["FILES", "文件", FileText], ["GIT", "变更", GitBranch], ["TERMINAL", "终端", SquareTerminal], ["RUNS", "运行记录", Play]] as const)
            .map(([key, label, Icon]) => <button key={key} type="button" data-testid={`devtools-tab-${key}`}
              className={`devtools-tab${tab === key ? " devtools-tab--active" : ""}`} aria-current={tab === key ? "true" : undefined}
              onClick={() => setTab(key)}><Icon aria-hidden="true" />{label}</button>)}
        </nav>
      </header>

      <div className="devtools-body">
        {tab === "FILES" && <section data-testid="devtools-files">
          <h3>受管目录</h3>
          <p className="helper-text">这里只列出该 Project 已登记的受管目录。目录浏览接口尚未接入（待接入），因此不推断本机任意路径可读。</p>
          {loading && <p className="helper-text" role="status">正在读取受管目录…</p>}
          {resourceError && <p className="action-error" role="alert" data-testid="devtools-resource-error">{resourceError}</p>}
          {!loading && !resourceError && resources.length === 0 && <p className="helper-text">当前项目没有登记受管目录；这不是“工作目录干净”的结论。</p>}
          {resources.length > 0 && <ul className="devtools-list">{resources.map((resource) => <li key={resource.id}>
            <span><code className="hash-code">{resource.canonicalRoot}</code>
              <small>状态 {resource.status} · 资源修订 v{resource.revision} · 写身份已绑定：{resource.fileWriteIdentityBound ? "是" : "否"}</small></span>
          </li>)}</ul>}
          <h3>本任务的受管产物</h3>
          <p className="helper-text">受管产物是任务产物版本，工作目录文件是受管目录下的普通文件；两者来源不同，不混成同一版本。产物正文在右侧产物区按确切版本阅读。</p>
          <Link className="text-link" to={`/tasks/${taskId}?tab=artifacts`}>打开任务产物版本</Link>
        </section>}

        {tab === "GIT" && <section data-testid="devtools-git">
          <h3>Git 变更 · 未接入</h3>
          <p className="warning-callout" role="status" data-testid="devtools-git-gap">
            当前没有受管目录的只读 Git 状态或 diff 接口，因此这里不显示分支、暂存/未暂存/未跟踪文件或差异。
          </p>
          <p className="helper-text">非 Git 目录与读取失败都不得显示为“干净”；接受、暂存、提交、推送是四个不同动作，暂存与提交也尚未接入。接入前本面板只声明限制，不提供可点按钮。</p>
          <p className="helper-text">接入要求与边界见《工作台与前端交互设计》第 14.9 节；本页只声明限制，不提供可点按钮。</p>
        </section>}

        {tab === "TERMINAL" && <section data-testid="devtools-terminal">
          <h3>交互终端 · 未接入</h3>
          <p className="warning-callout" role="status" data-testid="devtools-terminal-gap">
            交互终端的受管工作目录、人工执行身份、进程生命周期、权限、审计、资源排他与断连恢复协议尚未确定，因此本页不提供可执行提示符。
          </p>
          <p className="helper-text">人工打开终端不授予 Agent 权限，也不能绕过在途写入与接手保护；缺少协议前不提供可执行入口。<Terminal aria-hidden="true" /></p>
        </section>}

        {tab === "RUNS" && <section data-testid="devtools-runs">
          <h3>运行记录</h3>
          <p className="helper-text">这里只打开已有 Run 事实；它不是启动按钮，执行仍通过显式委托或受控命令入口。</p>
          {run ? <><p className="helper-text">当前 Run：<code className="hash-code">{run.id}</code> · 状态 {run.status} · 修订 v{run.revision}</p>
            <Link className="text-link" to={`/runs/${run.id}`}>打开运行记录（步骤、事件、控制与检查）</Link></>
            : <p className="helper-text">当前任务没有 AI Run；本页不推断历史执行记录。</p>}
        </section>}
      </div>
    </div>

    <div className="devtools-drawer">
      <header className="devtools-drawer-header">
        <nav className="devtools-tabs devtools-tabs--drawer" aria-label="执行输出与交互终端">
          <button type="button" data-testid="devtools-tab-OUTPUT"
            className={`devtools-tab${drawerTab === "OUTPUT" ? " devtools-tab--active" : ""}`}
            aria-current={drawerTab === "OUTPUT" ? "true" : undefined}
            onClick={() => setDrawerTab((current) => current === "OUTPUT" ? null : "OUTPUT")}><Terminal aria-hidden="true" />执行输出</button>
          <span className="devtools-drawer-pending" aria-disabled="true"><SquareTerminal aria-hidden="true" />交互终端 · 待设计</span>
        </nav>
        <button className="icon-button" type="button" aria-label="收起工具面板" data-testid="devtools-close" onClick={onClose}><X aria-hidden="true" /></button>
      </header>

      {drawerTab === "OUTPUT" && <div className="devtools-drawer-body">
        <section data-testid="devtools-output">
          <h3>执行输出</h3>
          {!run && <p className="helper-text">当前任务没有 AI Run，因此没有可归属的命令输出。这里不展示 Trace 或其他记录冒充 stdout。</p>}
          {run && operationError && <p className="action-error" role="alert" data-testid="devtools-output-error">{operationError}</p>}
          {run && !operationError && !hasOutput && <p className="helper-text" data-testid="devtools-output-empty">本次 Run 没有任何已保存的命令输出。打开面板不执行命令；缺少输出与输出为空都如实显示。</p>}
          {run && operations.map((operation) => <article key={operation.id} className="devtools-operation">
            <h4>{operation.actionType} · {operation.status}</h4>
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
          </article>)}
        </section>
      </div>}
    </div>
  </section>;
}
