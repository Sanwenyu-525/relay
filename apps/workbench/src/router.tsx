import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from "react-router-dom";
import App from "./App";
import ActivityView from "./views/ActivityView";
import AgentChatView from "./views/AgentChatView";
import ArtifactLineageView from "./views/ArtifactLineageView";
import CompletionRecordView from "./views/CompletionRecordView";
import KnowledgeView from "./views/KnowledgeView";
import ConnectionsView, { ProjectConnectionsView } from "./views/ConnectionsView";
import ProjectSkillView from "./views/ProjectSkillView";
import ProjectTasksView from "./views/ProjectTasksView";
import ProjectWorkbenchView from "./views/ProjectWorkbenchView";
import ProjectWorkbenchEntry from "./views/ProjectWorkbenchEntry";
import ProjectsView from "./views/ProjectsView";
import ReviewsView from "./views/ReviewsView";
import RunView from "./views/RunView";
import SettingsView from "./views/SettingsView";
import TaskSkillView from "./views/TaskSkillView";
import TasksView from "./views/TasksView";
import TodayView from "./views/TodayView";
import UnsupportedView from "./views/UnsupportedView";

/** 与归档 Vue router.ts 的 11 条记录一一对应，query 子页由对应组件处理。 */
export const workbenchRoutes: RouteObject[] = [{
  path: "/",
  element: <App />,
  children: [
    { index: true, element: <Navigate to="/projects" replace /> },
    { path: "today", element: <TodayView /> },
    { path: "inbox", element: <Navigate to="/tasks?tab=inbox" replace /> },
    { path: "activity", element: <ActivityView /> },
    { path: "agent", element: <AgentChatView /> },
    { path: "activities", element: <ActivityView /> },
    { path: "artifact-versions/:id/lineage", element: <ArtifactLineageView /> },
    { path: "completion-records/:id", element: <CompletionRecordView /> },
    { path: "projects", element: <ProjectsView /> },
    { path: "projects/:id/tasks", element: <ProjectTasksView /> },
    { path: "projects/:id/knowledge", element: <KnowledgeView /> },
    { path: "projects/:id/connections", element: <ProjectConnectionsView /> },
    { path: "projects/:id/workbench", element: <ProjectWorkbenchEntry /> },
    { path: "projects/:id/workbench/:kind", element: <ProjectWorkbenchView /> },
    { path: "projects/:id", element: <ProjectSkillView /> },
    { path: "tasks", element: <TasksView /> },
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

export function createWorkbenchRouter(initialEntries?: string[]) {
  return initialEntries
    ? createMemoryRouter(workbenchRoutes, { initialEntries })
    : createBrowserRouter(workbenchRoutes);
}
