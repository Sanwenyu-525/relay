import { createElement, lazy, Suspense, type ComponentType } from "react";
import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from "react-router-dom";
import App from "./App";
import RouteErrorBoundary from "./components/RouteErrorBoundary";
import ActivityView from "./views/ActivityView";
import CollaborationView from "./views/CollaborationView";
import ArtifactLineageView from "./views/ArtifactLineageView";
import CompletionRecordView from "./views/CompletionRecordView";
import KnowledgeView from "./views/KnowledgeView";
import ConnectionsView, { ProjectConnectionsView } from "./views/ConnectionsView";
import ProjectSkillView from "./views/ProjectSkillView";
import ProjectTasksView from "./views/ProjectTasksView";
import ProjectWorkbenchView from "./views/ProjectWorkbenchView";
import ProjectPlanningView from "./views/ProjectPlanningView";
import ProjectTaskChainsView from "./views/ProjectTaskChainsView";
import ProjectWorkbenchEntry from "./views/ProjectWorkbenchEntry";
import ProjectsView from "./views/ProjectsView";
import GoalListView from "./views/GoalListView";
import GoalDetailView from "./views/GoalDetailView";
import DirectoryWorkContextView from "./views/DirectoryWorkContextView";
import ReviewsView from "./views/ReviewsView";
import RunView from "./views/RunView";
import SettingsView from "./views/SettingsView";
import TaskSkillView from "./views/TaskSkillView";
import TasksView from "./views/TasksView";
import TodayView from "./views/TodayView";
import ScheduledTasksView from "./views/ScheduledTasksView";
import CreateScheduledTaskView from "./views/CreateScheduledTaskView";
import ScheduledTaskDetailView from "./views/ScheduledTaskDetailView";
import { useSearchParams } from "react-router-dom";
import UnsupportedView from "./views/UnsupportedView";

/**
 * 场景实验室只在开发构建里存在。
 *
 * 隔离靠的是构建期，而不是运行时的判断：`import.meta.env.DEV` 在生产构建里是字面量 `false`，
 * 这一条路由连同它对 `./dev/ScenarioLabView` 的动态 import 一起被摇掉，
 * 因此生产产物里没有这条路径、也没有可点进去的入口。
 *
 * `lazy()` 必须写在这个条件里，不能提成顶层常量：实测 Rolldown 不摇顶层那次调用，
 * 路由字符串确实没了，但整个 `ScenarioLabView` chunk 仍被生产产物带着（由
 * `scripts/check-scenario-lab-isolation.mjs` 对生产构建逐串搜出来）。
 */
const ScenarioLabView: ComponentType = import.meta.env.DEV
  ? lazy(() => import("./dev/ScenarioLabView"))
  : () => null;

/** 与归档 Vue router.ts 的 11 条记录一一对应，query 子页由对应组件处理。 */
export const workbenchRoutes: RouteObject[] = [{
  path: "/",
  element: <App />,
  // 根级兜底：任何视图的渲染错误先落这里，不再摔到 React Router 的英文默认错误页。
  errorElement: <RouteErrorBoundary />,
  children: [
    { index: true, element: <Navigate to="/projects" replace /> },    { path: "today", element: <TodayView /> },
    { path: "inbox", element: <Navigate to="/tasks?tab=inbox" replace /> },
    { path: "activity", element: <ActivityView /> },
    { path: "agent", element: <CollaborationView /> },
    { path: "activities", element: <ActivityView /> },
    { path: "artifact-versions/:id/lineage", element: <ArtifactLineageView /> },
    { path: "completion-records/:id", element: <CompletionRecordView /> },
    { path: "projects", element: <ProjectsView /> },
    { path: "goals", element: <GoalListView /> },
    { path: "goals/:id", element: <GoalDetailView /> },
    { path: "working-directories/:id", element: <DirectoryWorkContextView /> },
    { path: "projects/:id/tasks", element: <ProjectTasksView /> },
    { path: "projects/:id/planning", element: <ProjectPlanningView /> },
    { path: "projects/:id/task-chains", element: <ProjectTaskChainsView /> },
    { path: "projects/:id/knowledge", element: <KnowledgeView /> },
    { path: "projects/:id/connections", element: <ProjectConnectionsView /> },
    { path: "projects/:id/workbench", element: <ProjectWorkbenchEntry /> },
    { path: "projects/:id/workbench/:kind", element: <ProjectWorkbenchView /> },
    { path: "projects/:id", element: <ProjectSkillView /> },
    { path: "tasks", element: <TasksView /> },
    // 新建定时任务走同一个路由的 query 子页，与 /tasks?view=create 的既有约定一致。
    { path: "scheduled-tasks", element: <ScheduledTasksRoute /> },
    { path: "scheduled-tasks/:id", element: <ScheduledTaskDetailView /> },
    { path: "scheduled-tasks/:id/edit", element: <CreateScheduledTaskView /> },
    { path: "reviews", element: <ReviewsView /> },
    { path: "knowledge", element: <KnowledgeView /> },
    { path: "connections", element: <ConnectionsView /> },
    { path: "settings", element: <SettingsView /> },
    { path: "settings/connections", element: <ConnectionsView /> },
    { path: "runs/:id", element: <RunView /> },
    { path: "tasks/:id", element: <TaskSkillView /> },
    ...(import.meta.env.DEV ? [{ path: "__dev/assist-scenarios", element: <Suspense
      fallback={createElement("p", { className: "loading-text", role: "status" }, "正在载入场景实验室…")}>
      <ScenarioLabView /></Suspense> }] : []),
    { path: "*", element: <UnsupportedView /> }
  ]
}];

/** 列表与新建共用一个路径，避免侧栏出现两个入口。 */
function ScheduledTasksRoute() {
  const [query] = useSearchParams();
  return query.get("view") === "create" ? <CreateScheduledTaskView /> : <ScheduledTasksView />;
}

export function createWorkbenchRouter(initialEntries?: string[]) {
  return initialEntries
    ? createMemoryRouter(workbenchRoutes, { initialEntries })
    : createBrowserRouter(workbenchRoutes);
}
