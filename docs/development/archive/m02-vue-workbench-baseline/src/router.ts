import { createRouter, createWebHistory, type RouterHistory } from "vue-router";
import KnowledgeView from "./views/KnowledgeView.vue";
import ProjectSkillView from "./views/ProjectSkillView.vue";
import ProjectTasksView from "./views/ProjectTasksView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import ReviewsView from "./views/ReviewsView.vue";
import RunView from "./views/RunView.vue";
import TaskSkillView from "./views/TaskSkillView.vue";
import TasksView from "./views/TasksView.vue";
import UnsupportedView from "./views/UnsupportedView.vue";

export function createWorkbenchRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({
    history,
    routes: [
      { path: "/", redirect: "/projects" },
      { path: "/projects", name: "projects", component: ProjectsView },
      { path: "/projects/:id/tasks", name: "project-tasks", component: ProjectTasksView },
      { path: "/projects/:id/knowledge", name: "project-knowledge", component: KnowledgeView },
      { path: "/projects/:id", name: "project-skill", component: ProjectSkillView },
      { path: "/tasks", name: "tasks", component: TasksView },
      { path: "/reviews", name: "reviews", component: ReviewsView },
      { path: "/knowledge", name: "knowledge", component: KnowledgeView },
      { path: "/runs/:id", name: "run", component: RunView },
      { path: "/tasks/:id", name: "task-skill", component: TaskSkillView },
      { path: "/:pathMatch(.*)*", name: "unsupported", component: UnsupportedView }
    ],
    scrollBehavior: () => ({ top: 0 })
  });
}
