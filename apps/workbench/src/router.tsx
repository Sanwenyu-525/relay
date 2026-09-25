import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from "react-router-dom";
import App from "./App";
import KnowledgeView from "./views/KnowledgeView";
import ProjectSkillView from "./views/ProjectSkillView";
import ProjectTasksView from "./views/ProjectTasksView";
import ProjectsView from "./views/ProjectsView";
import ReviewsView from "./views/ReviewsView";
import RunView from "./views/RunView";
import TaskSkillView from "./views/TaskSkillView";
import TasksView from "./views/TasksView";
import UnsupportedView from "./views/UnsupportedView";

/** 与归档 Vue router.ts 的 11 条记录一一对应，query 子页由对应组件处理。 */
export const workbenchRoutes: RouteObject[] = [{
  path: "/",
  element: <App />,
  children: [
    { index: true, element: <Navigate to="/projects" replace /> },
    { path: "projects", element: <ProjectsView /> },
    { path: "projects/:id/tasks", element: <ProjectTasksView /> },
    { path: "projects/:id/knowledge", element: <KnowledgeView /> },
    { path: "projects/:id", element: <ProjectSkillView /> },
    { path: "tasks", element: <TasksView /> },
    { path: "reviews", element: <ReviewsView /> },
    { path: "knowledge", element: <KnowledgeView /> },
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
