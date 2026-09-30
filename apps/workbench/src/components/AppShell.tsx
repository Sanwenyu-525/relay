import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Bell, BookOpen, FolderKanban, House, Inbox, Link2, ListChecks, ListTree, Menu, Search, Settings } from "lucide-react";
import AppDialog from "./AppDialog";
import CommandPalette from "./CommandPalette";
import RelayConnectionDialog from "./RelayConnectionDialog";
import InterventionNotifications from "./InterventionNotifications";
import RecentWorkRail from "./RecentWorkRail";
import SidebarResizeHandle, { clampSidebarWidth } from "./SidebarResizeHandle";
import { dialogCount } from "../lib/dialogStack";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { useRelayConnection } from "../lib/relayConnection";

// 侧栏宽度是纯展示偏好，不是业务事实；localStorage 只保存这一个数值，读写失败时本次会话仍可调整。
const SIDEBAR_WIDTH_STORAGE_KEY = "relay.workbench.sidebarWidthPx";
function readStoredSidebarWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : null;
  } catch { return null; }
}

const skillPageNames: Record<string, string> = {
  overview: "总览", blueprint: "蓝图预览", resume: "继续项目", assist: "Assist", definition: "完善定义", verification: "验收方案"
};

export default function AppShell({ children, desktopStatus, commandOpen, onCommandOpen, onCommandClose }: {
  children: ReactNode;
  desktopStatus: "idle" | "connecting" | "error";
  commandOpen: boolean;
  onCommandOpen: () => void;
  onCommandClose: () => void;
}) {
  const location = useLocation();
  const connection = useRelayConnection();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(readStoredSidebarWidth);
  const changeSidebarWidth = useCallback((next: number | null, commit: boolean) => {
    setSidebarWidth(next);
    if (!commit) return;
    try {
      if (next === null) window.localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
      else window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
    } catch { /* 存储不可写时仅本次会话生效 */ }
  }, []);
  const frameStyle = sidebarWidth === null ? undefined
    : { "--relay-sidebar-user-width": `${sidebarWidth}px` } as CSSProperties;
  const chrome = useMemo(() => fixtureAdapter.getNavigationLabels(), [location.key]);
  const dataSourceLabel = connection.mode === "live" ? "已连接本机 API" : "示例数据";
  useEffect(() => {
    const openCommand = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || event.key.toLowerCase() !== "k") return;
      if (commandOpen || dialogCount() > 0) { event.preventDefault(); return; }
      event.preventDefault(); onCommandOpen();
    };
    document.addEventListener("keydown", openCommand);
    return () => document.removeEventListener("keydown", openCommand);
  }, [commandOpen, onCommandOpen]);
  useEffect(() => { onCommandClose(); }, [location.pathname, location.search]);
  const primaryNavigation = [
    { label: "项目", to: "/projects", icon: FolderKanban, count: "" },
    { label: "全部任务", to: "/tasks", icon: ListChecks, count: "" },
    { label: "知识", to: "/knowledge", icon: BookOpen, count: "" }
  ];
  /** 次级入口保留路由可达性，收在折叠区，不与主要定位入口争夺首屏注意力。 */
  const secondaryWorkNavigation = [
    { label: "今日", to: "/today", icon: House, count: "" },
    { label: "动态", to: "/activity", icon: ListTree, count: "" },
    { label: "待审", to: "/reviews", icon: Bell, count: connection.mode === "live" ? "" : String(chrome.pendingReviewCount) }
  ];
  const query = new URLSearchParams(location.search);
  const path = location.pathname;
  const currentWorkId = path === "/agent" ? query.get("work") : null;
  const secondaryNavigation = [
    { label: "连接", to: "/connections", icon: Link2 },
    { label: "设置", to: "/settings", icon: Settings }
  ];
  // 面包屑只读确切 Project/Task 标题；读不到时回退到通用称谓，不用客户端缓存或推测标题。
  const [workTrail, setWorkTrail] = useState<readonly string[]>([]);
  useEffect(() => {
    const client = connection.mode === "live" ? connection.client : null;
    if (!client || currentWorkId === null) { setWorkTrail([]); return; }
    let active = true;
    void client.getTask(currentWorkId).then(async (task) => {
      const names = ["项目", "当前项目", "任务", task.title];
      if (task.projectId === null) {
        if (active) setWorkTrail(["任务", task.title]);
        return;
      }
      if (active) setWorkTrail(names);
      const project = await client.getProject(task.projectId);
      if (!active) return;
      setWorkTrail(["项目", project.title, "任务", task.title]);
    }).catch(() => { if (active) setWorkTrail(["任务", "当前工作"]); });
    return () => { active = false; };
  }, [connection.mode, connection.client, currentWorkId]);
  const breadcrumb = (() => {
    if (path === "/today") return ["工作空间", "今日"];
    if (path === "/activity" || path === "/activities") return ["工作空间", "动态"];
    if (path === "/agent") return workTrail.length > 0 ? [...workTrail] : ["工作空间", "近期工作"];
    if (/^\/artifact-versions\/[^/]+\/lineage$/u.test(path)) return ["产物版本", "来源"];
    if (path === "/projects") return ["工作空间", query.get("view") === "create" ? "新建项目" : "项目"];
    if (path === "/tasks") return query.get("view") === "create"
      ? ["工作空间", "新建任务与执行准备"]
      : query.get("tab") === "inbox" ? ["工作空间", "任务", "收件箱"] : ["工作空间", "任务"];
    if (path === "/reviews") return ["工作空间", "待审"];
    if (path === "/knowledge") return ["工作空间", "知识"];
    if (path === "/connections" || path === "/settings/connections") return ["工作空间", "连接"];
    const workbench = /^\/projects\/([^/]+)\/workbench\/(general|thesis|development)$/u.exec(path);
    if (workbench) {
      const title = connection.mode === "live" ? null : fixtureAdapter.getProjectTitle(workbench[1] ?? "");
      const kind = workbench[2] === "thesis" ? "论文工作台" : workbench[2] === "development" ? "开发工作台" : "通用工作台";
      return ["项目", title ?? "当前项目", kind];
    }
    const project = /^\/projects\/([^/]+)(?:\/(tasks|knowledge|connections))?$/u.exec(path);
    if (project) {
      const title = connection.mode === "live" ? null : fixtureAdapter.getProjectTitle(project[1] ?? "");
      const requested = query.get("skill");
      const skill = requested === "blueprint" || requested === "resume" || requested === "assist" ? requested : "overview";
      const suffix = project[2] === "tasks" ? "任务" : project[2] === "knowledge" ? "资料" : project[2] === "connections" ? "连接" : skillPageNames[skill];
      return ["项目", title ?? "当前项目", suffix];
    }
    const task = /^\/tasks\/([^/]+)$/u.exec(path);
    if (task) {
      const title = connection.mode === "live" ? null : fixtureAdapter.getTaskTitle(task[1] ?? "");
      const skill = query.get("skill");
      const suffix = skill === "definition" || skill === "verification" || skill === "assist" ? skillPageNames[skill] : "任务详情";
      return ["任务", title ?? "当前任务", suffix];
    }
    return ["工作空间"];
  })();
  const now = new Date();
  const date = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now).replaceAll("/", "-");
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now);

  return <>
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>跳到主要内容</a>
    <div className="app-frame" style={frameStyle}>
      <aside className="app-sidebar">
        <div className="brand" title="示例品牌标识，最终产品显示名待确认">Workflow OS</div>
        {connection.mode === "live" && connection.client && path === "/agent" &&
          <RecentWorkRail client={connection.client} currentTaskId={currentWorkId} />}
        <nav className="navigation-list" aria-label="主导航">
          {primaryNavigation.map((item) => <NavLink key={item.label} to={item.to} end className={({ isActive }) => `navigation-item${isActive ? " navigation-item--active" : ""}`}>
            {({ isActive }) => <><item.icon aria-hidden="true" /><span className="navigation-label">{item.label}</span>
              {item.count && <span className="navigation-count" aria-label={`${item.label} ${item.count} 项`}>{item.count}</span>}
              {isActive && <span className="visually-hidden">当前页</span>}
            </>}
          </NavLink>)}
        </nav>
        <nav className="navigation-list navigation-list--secondary" aria-label="次级导航">
          {secondaryWorkNavigation.map((item) => <NavLink key={item.label} to={item.to} end className={({ isActive }) => `navigation-item${isActive ? " navigation-item--active" : ""}`}>
            {({ isActive }) => <><item.icon aria-hidden="true" /><span className="navigation-label">{item.label}</span>
              {item.count && <span className="navigation-count" aria-label={`${item.label} ${item.count} 项`}>{item.count}</span>}
              {isActive && <span className="visually-hidden">当前页</span>}
            </>}
          </NavLink>)}
        </nav>
        <nav className="navigation-list navigation-list--bottom" aria-label="辅助导航">
          {secondaryNavigation.map((item) => <NavLink key={item.label} to={item.to} end className={({ isActive }) => `navigation-item${isActive ? " navigation-item--active" : ""}`}>
            <item.icon aria-hidden="true" /><span className="navigation-label">{item.label}</span>
          </NavLink>)}
        </nav>
      </aside>
      <div className="app-content">
        <header className="app-topbar">
          <button className="mobile-menu-button icon-button" type="button" aria-label="打开导航" onClick={() => setNavigationOpen(true)}><Menu aria-hidden="true" /></button>
          <nav className="breadcrumbs" aria-label="面包屑">{breadcrumb.map((item, index) => <span key={`${index}-${item}`} className="breadcrumb-item">
            {index > 0 && <span className="breadcrumb-separator" aria-hidden="true">›</span>}<span>{item}</span>
          </span>)}</nav>
          <time className="topbar-date">{date}　{weekday}</time>
          <Link className="icon-button" to="/inbox" aria-label="打开任务收件箱" title="任务收件箱"
            data-testid="inbox-open"><Inbox aria-hidden="true" /></Link>
          <button className="icon-button app-topbar__command-open" type="button" aria-label="打开命令面板，快捷键 Ctrl+K" data-testid="command-open" onClick={onCommandOpen}><Search aria-hidden="true" /></button>
          <button className={`data-source-button${connection.mode === "live" ? " data-source-button--live" : ""}`} type="button" data-testid="relay-connection-open" aria-label={`数据来源：${dataSourceLabel}，打开连接设置`} onClick={() => setConnectionOpen(true)}>
            <Link2 aria-hidden="true" /><span>{dataSourceLabel}</span>
          </button>
        </header>
        {connection.mode === "live" && connection.client && <InterventionNotifications
          key={connection.epoch} client={connection.client} />}
        {desktopStatus === "connecting" && <p className="helper-text desktop-bootstrap-status" role="status">正在连接桌面本机服务…</p>}
        {desktopStatus === "error" && <p className="action-error desktop-bootstrap-status" role="alert" data-testid="desktop-bootstrap-error">桌面本机服务未就绪。当前仍为示例数据；请检查连接与服务状态。</p>}
        <main id="main-content" className="app-main" tabIndex={-1}>{children}</main>
      </div>
      {/* 分隔条放在内容之后：Tab 顺序为导航 → 内容 → 调宽；视觉位置由 CSS 绝对定位决定。 */}
      <SidebarResizeHandle width={sidebarWidth} onWidthChange={changeSidebarWidth} />
    </div>
    {/* 连接状态只在顶栏保留一个主入口；底部示例标识仅用于非 live 模式（连接详情里有“写入真实 PostgreSQL”说明）。 */}
    {connection.mode !== "live" && <p className="demo-notice">交互预览 · 示例数据，刷新后重置</p>}
    <RelayConnectionDialog open={connectionOpen} onClose={() => setConnectionOpen(false)} />
    <CommandPalette open={commandOpen} onClose={onCommandClose} />
    <AppDialog open={navigationOpen} title="导航" variant="drawer" onClose={() => setNavigationOpen(false)}>
      <nav className="mobile-navigation-list" aria-label="完整导航">
        {[...primaryNavigation, ...secondaryWorkNavigation, ...secondaryNavigation].map((item) => <NavLink key={item.label} to={item.to} className="mobile-navigation-item" onClick={() => setNavigationOpen(false)}>
          <item.icon aria-hidden="true" /><span>{item.label}</span>
        </NavLink>)}
      </nav>
    </AppDialog>
  </>;
}
