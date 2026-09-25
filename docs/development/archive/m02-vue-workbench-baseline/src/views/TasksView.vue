<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { Info, Plus, RotateCcw, Search } from "lucide-vue-next";
import ResponsiveRail from "../components/ResponsiveRail.vue";
import StatusChip from "../components/StatusChip.vue";
import CreateTaskView from "./CreateTaskView.vue";
import { fixtureAdapter, type TaskListQuery } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import type { FixtureError, InteractionMode, ProjectSummary, TaskStatus, TaskSummary } from "../types";

const route = useRoute();
const router = useRouter();

const tasks = ref<TaskSummary[]>([]);
const projects = ref<ProjectSummary[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);
let requestVersion = 0;
let hasLoaded = false;

const mode = computed(() => fixtureModeFromQuery(route.query));
const creating = computed(() => route.query.view === "create");
const scope = computed<"all" | "inbox">(() => (route.query.tab === "inbox" ? "inbox" : "all"));
const projectFilter = ref<string>("all");
const statusFilter = ref<TaskStatus | "all">("all");
const modeFilter = ref<InteractionMode | "all">("all");
const search = ref("");

const statusOptions = Object.keys(taskStatusLabels) as TaskStatus[];
const modeOptions = Object.keys(interactionModeLabels) as InteractionMode[];

function toActionError(caught: unknown, fallback: string): string {
  const fixtureError = caught as FixtureError;
  if (caught instanceof Error && "kind" in caught) {
    return fixtureError.message.trim();
  }
  return caught instanceof Error ? caught.message.trim() : fallback;
}

async function load(): Promise<void> {
  const request = ++requestVersion;
  // 首次读取显示整页加载；后续筛选或搜索保留已知内容并标识更新。
  if (hasLoaded) {
    refreshing.value = true;
  } else {
    loading.value = true;
  }
  error.value = null;
  try {
    const query: TaskListQuery = {
      projectId: scope.value === "inbox" ? "inbox" : projectFilter.value === "all" ? "all" : projectFilter.value,
      status: statusFilter.value,
      mode: modeFilter.value,
      query: search.value
    };
    const [list, options] = await Promise.all([
      fixtureAdapter.listTasks(query, mode.value),
      fixtureAdapter.loadTaskOptions(mode.value)
    ]);
    if (request !== requestVersion) {
      return;
    }
    tasks.value = list;
    projects.value = options.projects;
    hasLoaded = true;
  } catch (caught) {
    if (request === requestVersion) {
      error.value = toActionError(caught, "读取示例任务时发生未知错误。");
    }
  } finally {
    if (request === requestVersion) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

watch([mode, scope, projectFilter, statusFilter, modeFilter, search], load, { immediate: true });
onBeforeUnmount(() => {
  requestVersion += 1;
});

const hasFilters = computed(
  () =>
    projectFilter.value !== "all" || statusFilter.value !== "all" || modeFilter.value !== "all" || search.value !== ""
);

const anyFilterActive = computed(() => hasFilters.value || scope.value === "inbox");

function clearFilters(): void {
  projectFilter.value = "all";
  statusFilter.value = "all";
  modeFilter.value = "all";
  search.value = "";
}

function projectTitle(projectId: string | null): string {
  if (projectId === null) {
    return "未归属项目";
  }
  return projects.value.find((project) => project.id === projectId)?.title ?? projectId;
}

function openCreate(): void {
  void router.push({ path: "/tasks", query: { view: "create", ...(scope.value === "inbox" ? { tab: "inbox" } : {}) } });
}

function closeCreate(): void {
  void router.push({ path: "/tasks", query: scope.value === "inbox" ? { tab: "inbox" } : {} });
}
</script>

<template>
  <section v-if="creating" class="skill-page">
    <CreateTaskView :inbox-scope="scope === 'inbox'" @cancel="closeCreate" />
  </section>

  <section v-else-if="loading" class="page-state" aria-live="polite">
    <p class="eyebrow">任务</p>
    <h1>正在读取任务列表</h1>
    <p>示例数据正在加载，页面尚未提交任何变更。</p>
  </section>

  <section v-else-if="error" class="page-state page-state--error" role="alert">
    <p class="eyebrow">任务</p>
    <h1>暂时无法显示任务</h1>
    <p>{{ error }}</p>
    <button class="secondary-button" type="button" @click="load"><RotateCcw aria-hidden="true" />重新读取</button>
  </section>

  <section v-else class="skill-page">
    <div class="page-layout">
      <div class="page-primary">
        <div class="list-header">
          <div>
            <h1>任务</h1>
            <p class="page-lede">将研究目标拆解为可执行的任务，明确状态、执行模式与责任人，并以产物和验收作为完成依据。</p>
          </div>
          <button class="primary-button" type="button" data-testid="task-create-open" @click="openCreate">
            <Plus aria-hidden="true" />新建任务
          </button>
        </div>

        <nav class="subnav" aria-label="任务范围">
          <RouterLink
            class="subnav-item"
            :class="{ 'subnav-item--active': scope === 'all' }"
            :to="{ path: '/tasks' }"
            data-testid="tasks-tab-all"
            :aria-current="scope === 'all' ? 'page' : undefined"
          >
            全部
          </RouterLink>
          <RouterLink
            class="subnav-item"
            :class="{ 'subnav-item--active': scope === 'inbox' }"
            :to="{ path: '/tasks', query: { tab: 'inbox' } }"
            data-testid="tasks-tab-inbox"
            :aria-current="scope === 'inbox' ? 'page' : undefined"
          >
            收件箱
          </RouterLink>
        </nav>

        <div class="list-toolbar">
          <label class="filter-field">
            项目
            <select v-model="projectFilter" name="task-filter-project" :disabled="scope === 'inbox'">
              <option value="all">全部</option>
              <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.title }}</option>
              <option value="inbox">未归属项目</option>
            </select>
          </label>
          <label class="filter-field">
            状态
            <select v-model="statusFilter" name="task-filter-status">
              <option value="all">全部</option>
              <option v-for="status in statusOptions" :key="status" :value="status">{{ taskStatusLabels[status] }}</option>
            </select>
          </label>
          <label class="filter-field">
            执行模式
            <select v-model="modeFilter" name="task-filter-mode">
              <option value="all">全部</option>
              <option v-for="item in modeOptions" :key="item" :value="item">{{ interactionModeLabels[item] }}</option>
            </select>
          </label>
          <label class="search-field">
            <Search aria-hidden="true" />
            <span class="visually-hidden">按任务名称搜索</span>
            <input v-model="search" type="search" name="task-search" placeholder="搜索任务" />
          </label>
        </div>

        <p v-if="refreshing" class="helper-text" role="status" data-testid="tasks-refreshing">正在按当前筛选更新列表，已显示的内容保持可见。</p>

        <div v-if="tasks.length === 0" class="page-state">
          <p>
            {{
              anyFilterActive
                ? "当前筛选没有匹配的任务；清除筛选后可以看到全部任务。"
                : "还没有任务。可以先新建一项任务，或从项目页创建项目内任务。"
            }}
          </p>
          <button v-if="anyFilterActive" class="secondary-button" type="button" data-testid="task-clear-filters" @click="clearFilters">
            清除筛选
          </button>
          <button v-else class="primary-button" type="button" @click="openCreate"><Plus aria-hidden="true" />新建任务</button>
        </div>

        <div v-else class="table-scroll">
          <div class="data-table">
            <div class="data-row data-row--head data-row--tasks" aria-hidden="true">
              <span class="data-cell">任务</span>
              <span class="data-cell">项目</span>
              <span class="data-cell">工作状态</span>
              <span class="data-cell">执行模式</span>
              <span class="data-cell">当前执行者</span>
            </div>
            <ul class="data-list">
              <li v-for="task in tasks" :key="task.id">
                <RouterLink
                  class="data-row data-row--tasks data-row--interactive"
                  :to="`/tasks/${task.id}`"
                  :data-testid="`task-row-${task.id}`"
                >
                  <span class="data-cell">
                    <strong>{{ task.title }}</strong>
                    <small>任务修订 v{{ task.revision }}</small>
                  </span>
                  <span class="data-cell data-cell--meta">{{ projectTitle(task.projectId) }}</span>
                  <span class="data-cell">
                    <StatusChip :status="task.status" />
                    <small v-if="task.waitingReason ?? task.blockedReason">
                      {{ task.waitingReason ?? task.blockedReason }}
                    </small>
                  </span>
                  <span class="data-cell data-cell--meta">{{ interactionModeLabels[task.mode] }}</span>
                  <span class="data-cell data-cell--meta">{{ executorLabels[task.executor] }}</span>
                </RouterLink>
              </li>
            </ul>
          </div>
        </div>

        <p class="list-footer-note">
          <Info aria-hidden="true" />
          完成依据来自产物、验收与提交；工作状态、执行模式与当前执行者是三个独立事实，不能用一枚标签合并。
        </p>
      </div>

      <ResponsiveRail label="查看范围说明" title="当前范围">
        <div class="rail-content">
          <h2>当前范围</h2>
          <p class="rail-intro">
            {{ scope === "inbox" ? "收件箱只包含未归属项目的人工任务。" : "这里是整个工作空间的任务，不限定在某个项目内。" }}
          </p>
          <section class="rail-section">
            <h3>筛选保持作用域</h3>
            <p>
              项目、状态与执行模式的筛选只作用于当前列表；切换“全部/收件箱”会重置项目筛选，避免把上一个范围的条件带到新范围。
            </p>
          </section>
          <section class="rail-section">
            <h3>未归属任务</h3>
            <p>未归属项目的任务只允许人工事项；把它们关联到项目需要显式操作，不会自动创建 Project。</p>
            <RouterLink class="secondary-button secondary-button--wide" to="/tasks?tab=inbox">查看收件箱任务</RouterLink>
          </section>
          <section class="rail-section">
            <h3>委托前确认</h3>
            <p>AI 委托是执行意图，不是当前状态；只有满足执行条件后，单独的委托流程才能确认执行者。</p>
          </section>
        </div>
      </ResponsiveRail>
    </div>
  </section>
</template>
