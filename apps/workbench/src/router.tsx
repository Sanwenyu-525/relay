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

/** 与归档 Vue router.ts 的 11 条记录一一对应，query 子页由对应组件处理。 */
export const workbenchRoutes: RouteObject[] = [{
  path: "/",
  element: <App />,
  // 根级兜底：任何视图的渲染错误先落这里，不再摔到 React Router 的英文默认错误页。
  errorElement: <RouteErrorBoundary />,
  children: [
    { index: true, element: <Navigate to="/projects" replace /> },
    { path: "today", element: <TodayView /> },
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
    { path: "projects/:id/knowledge", element: <KnowledgeView /> },
    { path: "projects/:id/connections", element: <ProjectConnectionsView /> },
    { path: "projects/:id/workbench", element: <ProjectWorkbenchEntry /> },
    { path: "projects/:id/workbench/:kind", element: <ProjectWorkbenchView /> },
    { path: "projects/:id", element: <ProjectSkillView /> },
    { path: "tasks", element: <TasksView /> },
    // 新建定时任务走同一个路由的 query 子页，与 /tasks?view=create 的既有约定一致。
    { path: "scheduled-tasks", element: <ScheduledTasksRoute /> },
    { path: "scheduled-tasks/:id", element: <ScheduledTaskDetailView /> },
    { path: "reviews", element: <ReviewsView /> },
    { path: "knowledge", element: <KnowledgeView /> },
    { path: "connections", element: <ConnectionsView /> },
    { path: "settings", element: <SettingsView /> },
    { path: "settings/connections", element: <ConnectionsView /> },
    { path: "runs/:id", element: <RunView /> },
    { path: "tasks/:id", element: <TaskSkillView /> },
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
