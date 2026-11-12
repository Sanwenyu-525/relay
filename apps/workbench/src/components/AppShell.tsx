import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, PanelLeft, PanelLeftClose, SquarePen } from "lucide-react";
import AppDialog from "./AppDialog";
import CommandPalette from "./CommandPalette";
import { FeedbackHost } from "./Feedback";
import RecentWorkRail from "./RecentWorkRail";
import SidebarResizeHandle, { clampSidebarWidth } from "./SidebarResizeHandle";
import { dialogCount } from "../lib/dialogStack";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { useRelayConnection } from "../lib/relayConnection";
import { useActiveConversation } from "../lib/activeConversation";
import { useNavigationPlacement } from "../lib/navigationPreferences";
import { bottomWorkbenchNavigation, devToolsNavState, primaryWorkbenchNavigation,
  secondaryWorkNavigation, workbenchNavTargetActive, type WorkbenchNavEntry } from "../lib/workbenchNavigation";
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

// 近期工作栏的收起/折叠是外壳偏好（与列宽同类），只保存一个布尔；沿用原型 toggle-side 的单一入口。
const CONTEXT_COLLAPSED_STORAGE_KEY = "relay.workbench.contextRailCollapsed";
function readStoredContextCollapsed(): boolean {
  try { return window.localStorage.getItem(CONTEXT_COLLAPSED_STORAGE_KEY) === "1"; } catch { return false; }
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
  // 场景实验室是开发者的全屏工作区：同样让出近期工作栏，把宽度交给预览；
  // 只是不渲染该栏，不改用户的收起偏好与列宽，返回普通页时原样恢复。
  const pageFocused = ["/projects", "/reviews", "/activity", "/activities"].includes(path)
    || (import.meta.env.DEV && path === "/__dev/assist-scenarios");
  const inboxActive = path === "/tasks" && query.get("tab") === "inbox";
  // 导航栏位置是本设备展示偏好（navigationPreferences.ts 唯一读写入口）：
  // 两种布局消费同一份入口数据，切换不换路由、不重建页面状态。
  const placement = useNavigationPlacement();
  const titlebarNavigation = placement === "titlebar";
  const isNavigationItemActive = (to: string) => workbenchNavTargetActive(path, inboxActive, to);
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
  // 收起/折叠近期工作栏：外壳单入口，与列宽同为纯展示偏好；读写失败时本次会话仍可切换。
  const [contextCollapsed, setContextCollapsed] = useState(readStoredContextCollapsed);
  const toggleContextCollapsed = useCallback(() => {
    setContextCollapsed((current) => {
      const next = !current;
      try { window.localStorage.setItem(CONTEXT_COLLAPSED_STORAGE_KEY, next ? "1" : "0"); } catch { /* 存储不可写时仅本次会话生效 */ }
      return next;
    });
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
  const primaryNavigation: readonly WorkbenchNavEntry[] = primaryWorkbenchNavigation({
    pendingReviewCount: connection.mode === "live" ? "" : String(chrome.pendingReviewCount)
  });
  const secondaryWorkNavigationEntries: readonly WorkbenchNavEntry[] = secondaryWorkNavigation();
  const currentWorkId = path === "/agent" ? query.get("work") : null;
  /**
   * 全局「新对话」只有一个 URL 入口意图：每次不同的 `/agent?new=…`。
   * 协作页按这个键打开空白输入，不恢复最近会话、不继承任务上下文；目录沿用本机最近一次
   * 打开的工作目录（2026-10-25 用户指令，由协作页按同一条 openFolder 打开并核对）；
   * 会话草稿、目录作用域与首条发送仍然只有协作页一个 Owner（工作台 §17.12.1）。
   * 两个宿主共用这一条 href：宽窗在近期工作栏头部，窄窗（该栏 display:none）在导航抽屉里。
   * 这不是第二套会话状态，也不复用会话列表里的「新建会话」——那会保留当前工作对象与目录。
   */
  /*
   * 0145：新对话继承**跳转前所在会话**的上下文档位。
   *
   * 左栏「新对话」是一条跨组件的链接（外壳 ↔ 协作页是兄弟），当前会话 id 只在
   * 「当前会话」登记器里；因此把它写进 URL 的 `source_session`，由协作页在建会话时
   * 交给服务端。没有当前会话就不带这个键——那种情况按缺省 256K 建，不猜来源。
   */
  const activeConversation = useActiveConversation();
  /**
   * 0145 复审（P0-B）：空白会话的键要**每点一次「新对话」都不一样**，又能随 URL 刷新恢复。
   * 原来用 `location.key`：新标签页第一次导航的值都是 "default"，两条不同的空白会话
   * 会共用一份档位草稿。这里每个 location 现取一个随机键——同一屏反复渲染不变，换一次
   * 导航就换一个；键写进 URL，刷新后读回来的是同一份草稿。
   */
  const newConversationKey = useMemo(() => crypto.randomUUID(),
    [location.key, activeConversation.sessionId]);
  /**
   * 0145 收口反例（场景 C，2026-10-31）：来源只认**非空字符串**会话 id。
   * 登记器类型上是 string | null，但「未定义身份」的反例要求连防御性的 undefined / 空串
   * 都不得写成 `source_session=undefined`——那会在建会话时被服务端当畸形 UUID 拒掉。
   */
  const activeSessionId = activeConversation.sessionId;
  const newConversationHref = `/agent?new=${encodeURIComponent(newConversationKey)}${
    typeof activeSessionId === "string" && activeSessionId !== ""
      ? `&source_session=${encodeURIComponent(activeSessionId)}` : ""}`;
  const secondaryNavigation: readonly WorkbenchNavEntry[] = bottomWorkbenchNavigation({
    includeDevTools: import.meta.env.DEV,
    devToolsState: devToolsNavState(path, location.search, location.state)
  });
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
    // 目标/目录/完成凭据/Run 此前落到兜底只剩「工作空间」一级，与同层页面（资料、动态、今日）不一致。
    // 只补有语义上级的层级：目标详情回目标列表，完成凭据与 Run 回任务列表，末级保持纯文本。
    if (path === "/goals") return [{ label: "工作空间" }, { label: "目标" }];
    if (/^\/goals\/[^/]+$/u.test(path)) return [{ label: "目标", to: "/goals" }, { label: "目标详情" }];
    if (/^\/working-directories\/[^/]+$/u.test(path)) return [{ label: "工作空间" }, { label: "工作目录" }];
    if (/^\/completion-records\/[^/]+$/u.test(path)) return [{ label: "任务", to: "/tasks" }, { label: "完成凭据" }];
    if (/^\/runs\/[^/]+$/u.test(path)) return [{ label: "任务", to: "/tasks" }, { label: "执行记录" }];
    if (path === "/settings") return [{ label: "工作空间" }, { label: "设置" }];
    if (path === "/scheduled-tasks") return query.get("view") === "create"
      ? [{ label: "工作空间" }, { label: "定时任务", to: "/scheduled-tasks" }, { label: "新建定时任务" }]
      : [{ label: "工作空间" }, { label: "定时任务" }];
    if (/^\/scheduled-tasks\/[^/]+$/u.test(path)) return [{ label: "工作空间" }, { label: "定时任务", to: "/scheduled-tasks" }, { label: "定时任务详情" }];
    if (path === "/connections") return [{ label: "工作空间" }, { label: "连接与同步" }];
    // 设置内的连接页从「设置」进入：面包屑跟随入口，避免与工作空间级 /connections 完全相同。
    if (path === "/settings/connections") return [{ label: "设置", to: "/settings" }, { label: "连接与同步" }];
    // 开发工具的面包屑跟着路由一起只在开发构建里存在：不加这道折叠，生产产物里会留着
    // 一条指向不存在入口的「AI 回复场景实验室」（产物串搜由 scripts/check-ui-conventions.mjs 跑）。
    // 2026-11-12：/__dev/ui 是组件库检查页，不能共用场景实验室的面包屑——两页层级不同，
    // 读成同一个页面会让「我在哪」失效。
    if (import.meta.env.DEV && path === "/__dev/ui") return [{ label: "工作空间" }, { label: "开发工具" }, { label: "UI Playground" }];
    if (import.meta.env.DEV && path.startsWith("/__dev/")) return [{ label: "工作空间" }, { label: "开发工具" }, { label: "AI 回复场景实验室" }];
    const workbench = /^\/projects\/([^/]+)\/workbench\/(general|thesis|development)$/u.exec(path);
    if (workbench) {
      const title = connection.mode === "live" ? null : fixtureAdapter.getProjectTitle(workbench[1] ?? "");
      const kind = workbench[2] === "thesis" ? "论文工作台" : workbench[2] === "development" ? "开发工作台" : "通用工作台";
      return [{ label: "项目", to: "/projects" }, { label: title ?? "当前项目", to: `/projects/${workbench[1] ?? ""}` }, { label: kind }];
    }
    const project = /^\/projects\/([^/]+)(?:\/(tasks|knowledge|connections|planning|task-chains))?$/u.exec(path);
    if (project) {
      const title = connection.mode === "live" ? null : fixtureAdapter.getProjectTitle(project[1] ?? "");
      const requested = query.get("skill");
      const skill = requested === "blueprint" || requested === "resume" || requested === "assist" ? requested : "overview";
      const suffix = project[2] === "tasks" ? "任务" : project[2] === "knowledge" ? "资料" : project[2] === "connections" ? "连接"
        : project[2] === "planning" ? "下一段工作" : project[2] === "task-chains" ? "任务链" : skillPageNames[skill];
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
    <div className={`app-frame${path === "/agent" ? " app-frame--collaboration" : ""}${pageFocused ? " app-frame--page-focused" : ""}`} data-context-collapsed={contextCollapsed ? "true" : "false"} data-navigation-placement={placement} style={frameStyle}>
      {/* 2026-10-02 共享壳栏位分离：图标导航只承担定位，近期工作与主导航各有各的滚动 Owner 和宽度偏好。
          UI-NAV-01：标题栏布局下全局导航由 DesktopTitleBar 的横向导航承担，这里不渲染图标栏；
          近期工作栏与主内容照旧，近期工作栏不跟随导航布局移动。 */}
      {!titlebarNavigation && <aside className="app-navrail" aria-label="应用导航">
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
          {secondaryWorkNavigationEntries.map((item) => {
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
            return <Link key={item.label} to={item.to} aria-current={isActive ? "page" : undefined}
              className={`navigation-item${isActive ? " navigation-item--active" : ""}`}
              title={item.title} state={item.state}>
            <item.icon aria-hidden="true" /><span className="navigation-label">{item.label}</span>
            </Link>;
          })}
        </nav>
      </aside>}
      <aside className="app-context-rail" aria-label="近期工作上下文" data-testid="app-context-rail">
        <div className="context-rail-head">
          <p className="context-rail-brand">Relay<span className="context-rail-brand-tag">工作空间</span></p>
          <div className="context-rail-head-actions">
            {/* 收起/折叠近期工作栏（原型 toggle-side）：外壳单入口，收起后本按钮仍在，作为再展开的把手。 */}
            <button className="icon-button context-rail-collapse" type="button" aria-expanded={!contextCollapsed}
              data-testid="context-rail-collapse"
              aria-label={contextCollapsed ? "展开近期工作栏" : "收起近期工作栏"}
              title={contextCollapsed ? "展开近期工作栏" : "收起近期工作栏"}
              onClick={toggleContextCollapsed}>
              {contextCollapsed ? <PanelLeft aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
            </button>
          </div>
        </div>
        {/* 新对话仍由协作页持有会话草稿与目录入口，这里只回到那条既有路径，不新建第二套会话状态。
            2026-10-15 对齐 V4.3 原型：从品牌行内的紧凑按钮改为独占一行的主操作，品牌行只留标识与折叠把手。
            窄窗（该栏 display:none）在导航抽屉里另有同一 href 的一份入口。 */}
        <Link className="primary-button context-rail-new" to={newConversationHref} data-testid="context-new-conversation"
          title="新对话"><SquarePen aria-hidden="true" /><span>新对话</span></Link>
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
    {/* 连接状态入口与其弹层由 DesktopTitleBar 持有。示例数据标注留在正文列末：
        近期工作栏可以折叠、窄窗整体隐藏，数据来源这件事不能跟着消失。 */}
    {connection.mode !== "live" && <p className="demo-notice">交互预览 · 示例数据，刷新后重置</p>}
    <CommandPalette open={commandOpen} onClose={onCommandClose} />
    {/* 浮层反馈栈只挂一次：各页的 Toast／Snackbar／Notice 组件只往栈里放条目，自己不进文档流。 */}
    <FeedbackHost />
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
        client={connection.client} currentTaskId={currentWorkId}
        onOpen={() => setNavigationOpen(false)} />}
      <nav className="mobile-navigation-list" aria-label="完整导航">
        {[...primaryNavigation, ...secondaryWorkNavigationEntries, ...secondaryNavigation].map((item) => {
          const isActive = isNavigationItemActive(item.to);
          return <Link key={item.label} to={item.to} aria-current={isActive ? "page" : undefined}
            className={`mobile-navigation-item${isActive ? " mobile-navigation-item--active" : ""}`}
            title={item.title} state={item.state} onClick={() => setNavigationOpen(false)}>
          <item.icon aria-hidden="true" /><span>{item.label}</span>{isActive && <span className="visually-hidden">当前页</span>}
          </Link>;
        })}
      </nav>
      </div>
    </AppDialog>
  </>;
}
