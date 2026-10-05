import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Bell, BookOpen, FolderKanban, House, Inbox, Link2, ListChecks, ListTree, Menu, Settings, SquarePen } from "lucide-react";
import AppDialog from "./AppDialog";
import CommandPalette from "./CommandPalette";
import RecentWorkRail from "./RecentWorkRail";
import SidebarResizeHandle, { clampSidebarWidth } from "./SidebarResizeHandle";
import WorkbenchActions from "./WorkbenchActions";
import { dialogCount } from "../lib/dialogStack";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { useRelayConnection } from "../lib/relayConnection";

// 可拖拽列宽是纯展示偏好，不是业务事实；localStorage 只保存这一个数值，读写失败时本次会话仍可调整。
// 2026-10-02 共享壳栏位分离后，这个键归属「近期工作」栏；沿用同一键与同一钳制区间，
// 旧组合侧栏留下的 160–320px 宽度对新的单栏仍然成立，不需要迁移或清空。
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
    { label: "工作台", to: "/agent", icon: House, count: "" },
    { label: "项目", to: "/projects", icon: FolderKanban, count: "" },
    { label: "待处理", to: "/reviews", icon: Bell, count: connection.mode === "live" ? "" : String(chrome.pendingReviewCount) },
    { label: "资料", to: "/knowledge", icon: BookOpen, count: "" }
  ];
  /** 次级入口保留路由可达性；侧栏高度足够，四条常驻显示，不再折叠，也不与主导航争抢分隔线以外的注意力。 */
  const secondaryWorkNavigation = [
    { label: "今日", to: "/today", icon: House, count: "" },
    { label: "全部任务", to: "/tasks", icon: ListChecks, count: "" },
    { label: "动态", to: "/activity", icon: ListTree, count: "" },
    { label: "收件箱", to: "/inbox", icon: Inbox, count: "" }
  ];
  const query = new URLSearchParams(location.search);
  const path = location.pathname;
  const currentWorkId = path === "/agent" ? query.get("work") : null;
  const secondaryNavigation = [
    { label: "设置", to: "/settings", icon: Settings },
    { label: "连接与同步", to: "/connections", icon: Link2 }
  ];
  const breadcrumb = (() => {
    if (path === "/today") return ["工作空间", "今日"];
    if (path === "/activity" || path === "/activities") return ["工作空间", "动态"];
    // 工作台页不显示面包屑：那一行与页头重复，且页头标题本身就是返回确切任务的入口。
    if (path === "/agent") return [];
    if (/^\/artifact-versions\/[^/]+\/lineage$/u.test(path)) return ["产物版本", "来源"];
    if (path === "/projects") return ["工作空间", query.get("view") === "create" ? "新建项目" : "项目"];
    if (path === "/tasks") return query.get("view") === "create"
      ? ["工作空间", "新建任务与执行准备"]
      : query.get("tab") === "inbox" ? ["工作空间", "任务", "收件箱"] : ["工作空间", "任务"];
    if (path === "/reviews") return ["工作空间", "待处理"];
    if (path === "/knowledge") return ["工作空间", "资料"];
    if (path === "/settings") return ["工作空间", "设置"];
    if (path === "/connections" || path === "/settings/connections") return ["工作空间", "连接与同步"];
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

  return <>
    <div className={`app-frame${path === "/agent" ? " app-frame--collaboration" : ""}`} style={frameStyle}>
      {/* 2026-10-02 共享壳栏位分离：图标导航只承担定位，近期工作与主导航各有各的滚动 Owner 和宽度偏好。 */}
      <aside className="app-navrail" aria-label="应用导航">
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
      <aside className="app-context-rail" aria-label="近期工作上下文" data-testid="app-context-rail">
        <div className="context-rail-head">
          <p className="context-rail-brand">Relay</p>
          {/* 新对话仍由协作页持有会话草稿与目录入口，这里只回到那条既有路径，不新建第二套会话状态。 */}
          <Link className="icon-button context-rail-new" to={`/agent?new=${encodeURIComponent(location.key)}`} data-testid="context-new-conversation"
            aria-label="新对话" title="新对话"><SquarePen aria-hidden="true" /><span className="visually-hidden">新对话</span></Link>
        </div>
        {connection.mode === "live" && connection.client
          ? <RecentWorkRail key={connection.epoch} client={connection.client} currentTaskId={currentWorkId} />
          : <p className="helper-text context-rail-placeholder">示例数据没有真实近期工作；连接本机 API 后这里按项目分组显示。</p>}
      </aside>
      <div className="app-content">
        {/* 标题带承担窗口与状态；常用操作就近放在内容区，复用同一命令面板与路由保护。 */}
        <header className="app-topbar">
          <button className="mobile-menu-button icon-button" type="button" aria-label="打开导航" onClick={() => setNavigationOpen(true)}><Menu aria-hidden="true" /></button>
          <WorkbenchActions onSearch={onCommandOpen} />
          {breadcrumb.length > 0 && <nav className="breadcrumbs" aria-label="面包屑">{breadcrumb.map((item, index) => <span key={`${index}-${item}`} className="breadcrumb-item">
            {index > 0 && <span className="breadcrumb-separator" aria-hidden="true">/</span>}<span>{item}</span>
          </span>)}</nav>}
        </header>
        {desktopStatus === "connecting" && <p className="helper-text desktop-bootstrap-status" role="status">正在连接桌面本机服务…</p>}
        {desktopStatus === "error" && <p className="action-error desktop-bootstrap-status" role="alert" data-testid="desktop-bootstrap-error">桌面本机服务未就绪。当前仍为示例数据；请检查连接与服务状态。</p>}
        <main id="main-content" className="app-main" tabIndex={-1}>{children}</main>
      </div>
      {/* 分隔条放在内容之后：Tab 顺序为导航 → 内容 → 调宽；视觉位置由 CSS 绝对定位决定。 */}
      <SidebarResizeHandle width={sidebarWidth} onWidthChange={changeSidebarWidth} />
    </div>
    {/* 连接状态入口已随数据来源按钮移入共享标题带，弹层由 DesktopTitleBar 持有。 */}
    {connection.mode !== "live" && <p className="demo-notice">交互预览 · 示例数据，刷新后重置</p>}
    <CommandPalette open={commandOpen} onClose={onCommandClose} />
    <AppDialog open={navigationOpen} title="导航" variant="drawer" onClose={() => setNavigationOpen(false)}>
      <div className="mobile-navigation">
      {connection.mode === "live" && connection.client && <RecentWorkRail key={connection.epoch}
        client={connection.client} currentTaskId={currentWorkId} onOpen={() => setNavigationOpen(false)} />}
      <nav className="mobile-navigation-list" aria-label="完整导航">
        {[...primaryNavigation, ...secondaryWorkNavigation, ...secondaryNavigation].map((item) => <NavLink key={item.label} to={item.to} className="mobile-navigation-item" onClick={() => setNavigationOpen(false)}>
          <item.icon aria-hidden="true" /><span>{item.label}</span>
        </NavLink>)}
      </nav>
      </div>
    </AppDialog>
  </>;
}
