import { Bell, BookOpen, CalendarClock, FlaskConical, FolderKanban, House, Inbox, LineChart, ListChecks, Settings } from "lucide-react";

/**
 * 工作台导航的唯一数据源（UI-NAV-01 双导航布局）。
 *
 * 左侧图标导航栏（AppShell）与标题栏横向导航（DesktopTitleBar → TitlebarNavigation）
 * 消费同一份入口定义与同一条当前页匹配规则；两种布局只改变导航的展示位置，
 * 不拥有第二套路由、图标、计数或高亮语义。新增全局入口只改这里。
 */

/** 侧栏一条目的地：`title` 是悬停提示（入口名与提示可以不同，如「开发工具」→ 实验室全名），
 *  `state` 只用于把「进入前所在页」交给实验室，让「返回工作台」能回到原处而不是固定回某一页。 */
export interface WorkbenchNavEntry {
  readonly label: string;
  readonly to: string;
  readonly icon: typeof House;
  readonly count?: string;
  readonly title?: string;
  readonly state?: { readonly from: string };
}

/** 导航目的地的当前页匹配：/tasks 与 /inbox 按 tab 参数互斥高亮，定时任务含详情子路径。 */
export function workbenchNavTargetActive(path: string, inboxTab: boolean, to: string): boolean {
  return to === "/inbox" ? inboxTab
    : to === "/tasks" ? path === "/tasks" && !inboxTab
    : to === "/scheduled-tasks" ? path === "/scheduled-tasks" || path.startsWith("/scheduled-tasks/")
    : path === to;
}

/** 主导航：工作台、项目、待处理、资料。待处理计数只在示例数据下展示真实条数。 */
export function primaryWorkbenchNavigation(options: { readonly pendingReviewCount: string }):
  readonly WorkbenchNavEntry[] {
  return [
    { label: "工作台", to: "/agent", icon: House, count: "" },
    { label: "项目", to: "/projects", icon: FolderKanban, count: "" },
    { label: "待处理", to: "/reviews", icon: Bell, count: options.pendingReviewCount },
    { label: "资料", to: "/knowledge", icon: BookOpen, count: "" }
  ];
}

/** 次级入口保留路由可达性；侧栏高度足够，全部常驻显示，不再折叠，也不与主导航争抢分隔线以外的注意力。 */
export function secondaryWorkNavigation(): readonly WorkbenchNavEntry[] {
  return [
    { label: "今日", to: "/today", icon: House, count: "" },
    { label: "任务", to: "/tasks", icon: ListChecks, count: "" },
    { label: "动态", to: "/activity", icon: LineChart, count: "" },
    { label: "收件箱", to: "/inbox", icon: Inbox, count: "" },
    { label: "定时任务", to: "/scheduled-tasks", icon: CalendarClock, count: "" }
  ];
}

/**
 * 开发工具入口的 `location.state`：实验室的「返回工作台」按它回去（`location.state` 不跨刷新；
 * 刷新后的回退由实验室自己记录的 `sessionStorage` 承担，这里不写第二份来源）。
 * 已经在实验室里再点一次时原样保留现有来源（传空 state 会把它清掉，返回就只剩默认页），
 * 免返回时原地打转；不在实验室时带上进入前的 path+search。
 */
export function devToolsNavState(path: string, search: string, state: unknown):
  { readonly from: string } | undefined {
  if (path.startsWith("/__dev/")) return state === null ? undefined : (state as { readonly from: string });
  return { from: `${path}${search}` };
}

/** 辅助导航：开发工具（仅开发构建）与设置。
 *  开发工具放在这一组的第一位：侧栏里辅助导航整块 `margin-top: auto` 贴底，默认窗口高（780px）下
 *  图标栏内容高过可视区，最后一条会落到折叠线以下——放末位就得先滚动才点得到。 */
export function bottomWorkbenchNavigation(options: { readonly includeDevTools: boolean;
  readonly devToolsState?: { readonly from: string } }): readonly WorkbenchNavEntry[] {
  return [
    // 开发工具入口只在开发构建里存在：路由本身是构建期隔离的，这里少一条入口只是不让它藏在侧栏外面。
    // 悬停提示写实验室全名，入口名仍是一个不占宽度的「开发工具」。
    ...(options.includeDevTools ? [{
      label: "开发工具", to: "/__dev/assist-scenarios", icon: FlaskConical, title: "AI 回复场景实验室",
      ...(options.devToolsState === undefined ? {} : { state: options.devToolsState })
    }] : []),
    { label: "设置", to: "/settings", icon: Settings }
  ];
}
