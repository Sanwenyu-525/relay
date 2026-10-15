import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Bell, BookOpen, FolderKanban, House, Inbox, Link2, ListChecks, ListTree, Menu, Settings, Sparkles, SquarePen } from "lucide-react";
import AppDialog from "./AppDialog";
import CommandPalette from "./CommandPalette";
import RecentWorkRail from "./RecentWorkRail";
import SidebarResizeHandle, { clampSidebarWidth } from "./SidebarResizeHandle";
import { dialogCount } from "../lib/dialogStack";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { useRelayConnection } from "../lib/relayConnection";
import "./AppShell.css";

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
  const query = new URLSearchParams(location.search);
  const path = location.pathname;
  const inboxActive = path === "/tasks" && query.get("tab") === "inbox";
  const isNavigationItemActive = (to: string) => to === "/inbox" ? inboxActive
    : to === "/tasks" ? path === "/tasks" && !inboxActive : path === to;
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
  const currentWorkId = path === "/agent" ? query.get("work") : null;
  /**
   * 全局「新对话」只有一个 URL 入口意图：每次不同的 `/agent?new=…`。
   * 协作页按这个键打开空白输入，不恢复最近会话、不沿用当前目录或任务；
   * 会话草稿、目录作用域与首条发送仍然只有协作页一个 Owner（工作台 §17.12.1）。
   * 两个宿主共用这一条 href：宽窗在近期工作栏头部，窄窗（该栏 display:none）在导航抽屉里。
   * 这不是第二套会话状态，也不复用会话列表里的「新建会话」——那会保留当前目标与目录。
   */
  const newConversationHref = `/agent?new=${encodeURIComponent(location.key)}`;
  const secondaryNavigation = [
    { label: "设置", to: "/settings", icon: Settings },
    { label: "连接与同步", to: "/connections", icon: Link2 }
  ];
  // 面包屑父级可点：只有存在语义上级路由的层级才带 to（任务链回任务列表与任务详情，项目链回项目列表与项目页）；
  // 末级保持纯文本，没有对应页面的层级（工作空间、产物版本）不硬造入口。链接复用全局 text-link 样式。
  const breadcrumb = ((): { label: string; to?: string }[] => {
    if (path === "/today") return [{ label: "工作空间" }, { label: "今日" }];
    if (path === "/activity" || path === "/activities") return [{ label: "工作空间" }, { label: "动态" }];
    // 工作台页不显示面包屑：那一行与页头重复，且页头标题本身就是返回确切任务的入口。
    if (path === "/agent") return [];
    if (/^\/artifact-versions\/[^/]+\/lineage$/u.test(path)) return [{ label: "产物版本" }, { label: "来源" }];
    if (path === "/projects") return [{ label: "工作空间" }, { label: query.get("view") === "create" ? "新建项目" : "项目" }];
    if (path === "/tasks") return query.get("view") === "create"
      ? [{ label: "工作空间" }, { label: "新建任务与执行准备" }]
      : query.get("tab") === "inbox" ? [{ label: "工作空间" }, { label: "任务", to: "/tasks" }, { label: "收件箱" }] : [{ label: "工作空间" }, { label: "任务" }];
    if (path === "/reviews") return [{ label: "工作空间" }, { label: "待处理" }];
    if (path === "/knowledge") return [{ label: "工作空间" }, { label: "资料" }];
    if (path === "/settings") return [{ label: "工作空间" }, { label: "设置" }];
    if (path === "/connections" || path === "/settings/connections") return [{ label: "工作空间" }, { label: "连接与同步" }];
    const workbench = /^\/projects\/([^/]+)\/workbench\/(general|thesis|development)$/u.exec(path);
    if (workbench) {
      const title = connection.mode === "live" ? null : fixtureAdapter.getProjectTitle(workbench[1] ?? "");
      const kind = workbench[2] === "thesis" ? "论文工作台" : workbench[2] === "development" ? "开发工作台" : "通用工作台";
      return [{ label: "项目", to: "/projects" }, { label: title ?? "当前项目", to: `/projects/${workbench[1] ?? ""}` }, { label: kind }];
    }
    const project = /^\/projects\/([^/]+)(?:\/(tasks|knowledge|connections))?$/u.exec(path);
    if (project) {
      const title = connection.mode === "live" ? null : fixtureAdapter.getProjectTitle(project[1] ?? "");
      const requested = query.get("skill");
      const skill = requested === "blueprint" || requested === "resume" || requested === "assist" ? requested : "overview";
      const suffix = project[2] === "tasks" ? "任务" : project[2] === "knowledge" ? "资料" : project[2] === "connections" ? "连接" : skillPageNames[skill];
      return [{ label: "项目", to: "/projects" }, { label: title ?? "当前项目", to: `/projects/${project[1] ?? ""}` }, { label: suffix }];
    }
    const task = /^\/tasks\/([^/]+)$/u.exec(path);
    if (task) {
      const title = connection.mode === "live" ? null : fixtureAdapter.getTaskTitle(task[1] ?? "");
      const skill = query.get("skill");
      const suffix = skill === "definition" || skill === "verification" || skill === "assist" ? skillPageNames[skill] : "任务详情";
      return [{ label: "任务", to: "/tasks" }, { label: title ?? "当前任务", to: `/tasks/${task[1] ?? ""}` }, { label: suffix }];
    }
    return [{ label: "工作空间" }];
  })();

  return <>
    <div className={`app-frame${path === "/agent" ? " app-frame--collaboration" : ""}`} style={frameStyle}>
      {/* 2026-10-02 共享壳栏位分离：图标导航只承担定位，近期工作与主导航各有各的滚动 Owner 和宽度偏好。 */}
      <aside className="app-navrail" aria-label="应用导航">
        {/* 品牌标记：V4.2 原型在图标导航顶端放了一枚方形标识，让这一栏读起来是「应用」
            而不是一条纯图标条。纯装饰，不承载任何导航或状态，因此对辅助技术隐藏。 */}
        <div className="navrail-brand" aria-hidden="true"><Sparkles /></div>
        <nav className="navigation-list" aria-label="主导航">
          {primaryNavigation.map((item) => {
            const isActive = isNavigationItemActive(item.to);
            return <Link key={item.label} to={item.to} aria-current={isActive ? "page" : undefined} className={`navigation-item${isActive ? " navigation-item--active" : ""}`}>
            {isActive && <span className="visually-hidden">当前页</span>}<item.icon aria-hidden="true" /><span className="navigation-label">{item.label}</span>
              {item.count && <span className="navigation-count" aria-label={`${item.label} ${item.count} 项`}>{item.count}</span>}
            </Link>;
          })}
        </nav>
        <nav className="navigation-list navigation-list--secondary" aria-label="次级导航">
          {secondaryWorkNavigation.map((item) => {
            const isActive = isNavigationItemActive(item.to);
            return <Link key={item.label} to={item.to} aria-current={isActive ? "page" : undefined} className={`navigation-item${isActive ? " navigation-item--active" : ""}`}>
            {isActive && <span className="visually-hidden">当前页</span>}<item.icon aria-hidden="true" /><span className="navigation-label">{item.label}</span>
              {item.count && <span className="navigation-count" aria-label={`${item.label} ${item.count} 项`}>{item.count}</span>}
            </Link>;
          })}
        </nav>
        <nav className="navigation-list navigation-list--bottom" aria-label="辅助导航">
          {secondaryNavigation.map((item) => {
            const isActive = isNavigationItemActive(item.to);
            return <Link key={item.label} to={item.to} aria-current={isActive ? "page" : undefined} className={`navigation-item${isActive ? " navigation-item--active" : ""}`}>
            <item.icon aria-hidden="true" /><span className="navigation-label">{item.label}</span>
            </Link>;
          })}
        </nav>
      </aside>
      <aside className="app-context-rail" aria-label="近期工作上下文" data-testid="app-context-rail">
        <div className="context-rail-head">
          <p className="context-rail-brand">Relay</p>
          {/* 新对话仍由协作页持有会话草稿与目录入口，这里只回到那条既有路径，不新建第二套会话状态。
              2026-10-10 协作页 §3.1：从只有图标的入口升为带文字的置顶主操作，尺寸取 control.height。 */}
          <Link className="primary-button context-rail-new" to={newConversationHref} data-testid="context-new-conversation"
            title="新对话"><SquarePen aria-hidden="true" /><span>新对话</span></Link>
        </div>
        {connection.mode === "live" && connection.client
          ? <RecentWorkRail key={connection.epoch} client={connection.client} currentTaskId={currentWorkId} />
          : <p className="helper-text context-rail-placeholder">示例数据没有真实近期工作；连接本机 API 后这里按项目分组显示。</p>}
      </aside>
      <div className="app-content">
        {/* 标题带承担窗口、状态与常用操作；应用顶栏只剩窄屏导航入口与面包屑。 */}
        <header className="app-topbar">
          <button className="mobile-menu-button icon-button" type="button" aria-label="打开导航" onClick={() => setNavigationOpen(true)}><Menu aria-hidden="true" /></button>
          {breadcrumb.length > 0 && <nav className="breadcrumbs" aria-label="面包屑">{breadcrumb.map((item, index) => <span key={`${index}-${item.label}`} className="breadcrumb-item">
            {index > 0 && <span className="breadcrumb-separator" aria-hidden="true">/</span>}{item.to
              ? <Link className="text-link" to={item.to}>{item.label}</Link>
              : <span>{item.label}</span>}
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
      {/* 窄窗下 .app-context-rail 整体 display:none，栏头部那条入口随之消失。
          抽屉顶部承载同一个 href：这是窄窗唯一一处「新对话」，不与栏内或其他区域重复堆主按钮，
          也不要求先展开工作台的「选择文件夹」。抽屉关闭后焦点由 AppDialog 交还给打开按钮。 */}
      <div className="mobile-navigation-actions">
        <Link className="mobile-navigation-action" to={newConversationHref} data-testid="mobile-new-conversation"
          onClick={() => setNavigationOpen(false)}>
          <SquarePen aria-hidden="true" /><span>新对话</span></Link>
      </div>
      {connection.mode === "live" && connection.client && <RecentWorkRail key={connection.epoch}
        client={connection.client} currentTaskId={currentWorkId} onOpen={() => setNavigationOpen(false)} />}
      <nav className="mobile-navigation-list" aria-label="完整导航">
        {[...primaryNavigation, ...secondaryWorkNavigation, ...secondaryNavigation].map((item) => {
          const isActive = isNavigationItemActive(item.to);
          return <Link key={item.label} to={item.to} aria-current={isActive ? "page" : undefined} className={`mobile-navigation-item${isActive ? " mobile-navigation-item--active" : ""}`} onClick={() => setNavigationOpen(false)}>
          <item.icon aria-hidden="true" /><span>{item.label}</span>{isActive && <span className="visually-hidden">当前页</span>}
          </Link>;
        })}
      </nav>
      </div>
    </AppDialog>
  </>;
}
