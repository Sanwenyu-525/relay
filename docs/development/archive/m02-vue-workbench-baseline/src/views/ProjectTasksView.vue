<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ChevronRight, FileText, Info, Plus, RotateCcw, Search } from "lucide-vue-next";
import ProjectNav from "../components/ProjectNav.vue";
import ResponsiveRail from "../components/ResponsiveRail.vue";
import StatusChip from "../components/StatusChip.vue";
import { createCommandId, taskMutationFrom, type RelayApiClient, type RelayTaskSummary } from "../api/relayClient";
import { fixtureAdapter, type ProjectTasksResult } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError, type LiveActionError } from "../lib/liveErrors";
import { liveClient, relayConnection } from "../lib/relayConnection";
import type { DecimalRevision, ExecutorKind, FixtureError, InteractionMode, TaskStatus } from "../types";

const route = useRoute();

/** 页面视图模型：fixture 与 live 都映射到这里，模板只按字段是否具备决定渲染。 */
interface ProjectTasksViewResult {
  readonly project: { readonly id: string; readonly title: string; readonly goal: string | null };
  readonly tasks: readonly ProjectTaskRow[];
  readonly dependencies: readonly ProjectTaskDependencyRow[];
  readonly source: "fixture" | "live";
}

interface ProjectTaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly mode: InteractionMode;
  readonly executor: ExecutorKind;
  readonly revision: DecimalRevision;
  readonly dependencyIds: readonly string[];
  /** 仅 live：服务端投影的允许动作，不是客户端授权判断。 */
  readonly allowedActions: readonly string[] | null;
  readonly blockedReason: string | null;
}

interface ProjectTaskDependencyRow {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly executor: ExecutorKind | null;
  readonly reason: string | null;
  readonly downstreamNote: string | null;
}

const result = ref<ProjectTasksViewResult | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);
const search = ref("");
const selectedTaskId = ref<string | null>(null);
const submitting = ref(false);
const receipt = ref<string | null>(null);
const actionError = ref<string | null>(null);
const liveFailure = ref<LiveActionError | null>(null);
const liveDependencies = ref<readonly ProjectTaskDependencyRow[]>([]);
let requestVersion = 0;
let dependencyVersion = 0;
let disposed = false;
let hasLoaded = false;
/** 提交结果不确定时必须沿用同一个 command ID 查询回执。 */
let pendingStart: { readonly taskId: string; readonly commandId: string } | null = null;

const mode = computed(() => fixtureModeFromQuery(route.query));
const projectId = computed(() => String(route.params.id));
const live = computed(() => relayConnection.mode === "live");

const tasks = computed(() => {
  const needle = search.value.trim().toLowerCase();
  const all = result.value?.tasks ?? [];
  return needle === "" ? all : all.filter((task) => task.title.toLowerCase().includes(needle));
});

const selectedTask = computed<ProjectTaskRow | null>(
  () => tasks.value.find((task) => task.id === selectedTaskId.value) ?? null
);

const selectedDependencies = computed(() => {
  const task = selectedTask.value;
  if (!task) {
    return [];
  }
  const notes = result.value?.source === "live" ? liveDependencies.value : (result.value?.dependencies ?? []);
  return notes.filter((note) => task.dependencyIds.includes(note.id));
});

const canStart = computed(() => {
  const task = selectedTask.value;
  if (!task) {
    return false;
  }
  // live 使用服务端 allowed_actions；fixture 使用示例状态，两者都不代表授权凭证。
  return task.allowedActions === null ? task.status === "READY" : task.allowedActions.includes("START");
});

const startBlockedReason = computed(() => {
  const task = selectedTask.value;
  if (!task) {
    return "";
  }
  if (task.allowedActions === null) {
    return `仅“可开始”的任务可以开始；当前状态是${taskStatusLabels[task.status]}。`;
  }
  const reasons: string[] = [`当前状态是${taskStatusLabels[task.status]}`];
  if (task.dependencyIds.length > 0) {
    reasons.push(`有 ${task.dependencyIds.length} 个前置任务尚未完成`);
  }
  if (task.blockedReason !== null) {
    reasons.push(task.blockedReason);
  }
  return `服务端未投影 START 动作：${reasons.join("；")}。`;
});

/** 列表的“依赖”列：live 只有选中任务取到标题，其余按数量说明。 */
function dependencyLabel(task: ProjectTaskRow): string {
  if (task.dependencyIds.length === 0) {
    return "无";
  }
  const notes = result.value?.source === "live" ? liveDependencies.value : (result.value?.dependencies ?? []);
  const title = notes.find((note) => note.id === task.dependencyIds[0])?.title;
  if (title !== undefined) {
    return title;
  }
  return task.dependencyIds.length === 1 ? "1 个前置任务" : `${task.dependencyIds.length} 个前置任务`;
}

async function load(): Promise<void> {
  const request = ++requestVersion;
  // 首次读取显示整页加载；开始任务后的刷新保留已知内容并标识更新。
  if (hasLoaded) {
    refreshing.value = true;
  } else {
    loading.value = true;
  }
  error.value = null;
  liveFailure.value = null;
  try {
    const client = liveClient();
    const response =
      client === null
        ? fromFixture(await fixtureAdapter.loadProjectTasks(projectId.value, mode.value))
        : await loadLive(client, projectId.value);
    if (request !== requestVersion) {
      return;
    }
    result.value = response;
    liveDependencies.value = [];
    hasLoaded = true;
    selectedTaskId.value =
      response?.tasks.find((task) => task.blockedReason !== null)?.id ?? response?.tasks[0]?.id ?? null;
    if (selectedTaskId.value !== null) {
      await loadSelectedDependencies(selectedTaskId.value);
    }
  } catch (caught) {
    if (request !== requestVersion) {
      return;
    }
    if (live.value) {
      const described = describeLiveError(caught);
      liveFailure.value = described;
      error.value = described.message;
    } else {
      const fixtureError = caught as FixtureError;
      error.value =
        caught instanceof Error && "kind" in caught
          ? fixtureError.message.trim()
          : caught instanceof Error
            ? caught.message.trim()
            : "读取示例项目任务时发生未知错误。";
    }
  } finally {
    if (request === requestVersion) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

function fromFixture(response: ProjectTasksResult | null): ProjectTasksViewResult | null {
  if (response === null) {
    return null;
  }
  return {
    project: { id: response.project.id, title: response.project.title, goal: response.project.goal },
    tasks: response.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      mode: task.mode,
      executor: task.executor,
      revision: task.revision,
      dependencyIds: [...task.dependencyIds],
      allowedActions: null,
      blockedReason: task.blockedReason
    })),
    dependencies: response.dependencies.map((note) => ({
      id: note.id,
      title: note.title,
      status: note.status,
      executor: note.executor,
      reason: note.reason,
      downstreamNote: note.downstreamNote
    })),
    source: "fixture"
  };
}

async function loadLive(client: RelayApiClient, id: string): Promise<ProjectTasksViewResult> {
  const [project, tasks] = await Promise.all([client.getProject(id), client.getProjectTasks(id)]);
  return {
    // 真实 Project 没有 goal 字段：不编造目标文案，模板据此隐藏该行。
    project: { id: project.id, title: project.title, goal: null },
    tasks: tasks.map((task) => liveTaskRow(task)),
    dependencies: [],
    source: "live"
  };
}

function liveTaskRow(task: RelayTaskSummary): ProjectTaskRow {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    mode: task.mode,
    executor: task.executor,
    revision: task.revision,
    dependencyIds: [...task.blockingTaskIds],
    allowedActions: [...task.allowedActions],
    blockedReason: liveBlockedReason(task)
  };
}

/** 阻塞说明只复述服务端投影的事实，不自行推断权限或可执行性。 */
function liveBlockedReason(task: RelayTaskSummary): string | null {
  if (task.unresolvedBlockerIds.length > 0) {
    return `存在 ${task.unresolvedBlockerIds.length} 个未解除的阻塞项，服务端未投影 START 动作。`;
  }
  if (task.blockingTaskIds.length > 0) {
    return `前置任务尚未完成，服务端未投影 START 动作。`;
  }
  return null;
}

/** 前置依赖的标题与状态只在 GET /tasks/{id} 里；迟到的响应不能覆盖新的选择。 */
async function loadSelectedDependencies(taskId: string): Promise<void> {
  const client = liveClient();
  if (client === null) {
    return;
  }
  const token = ++dependencyVersion;
  try {
    const detail = await client.getTask(taskId);
    if (token !== dependencyVersion || selectedTaskId.value !== taskId || disposed) {
      return;
    }
    liveDependencies.value = detail.dependencies.map((dependency) => ({
      id: dependency.taskId,
      title: dependency.title,
      status: dependency.status,
      executor: null,
      reason: null,
      downstreamNote: null
    }));
  } catch {
    // 依赖读取失败不覆盖已知任务事实，也不伪造前置信息。
    if (token === dependencyVersion) {
      liveDependencies.value = [];
    }
  }
}

// live 也是依赖项：在当前页面连接（或断开）后必须重新读取，不能让示例数据留在屏幕上。
watch([projectId, mode, live], load, { immediate: true });
watch(
  () => (live.value ? selectedTaskId.value : null),
  (taskId) => {
    if (taskId !== null) {
      void loadSelectedDependencies(taskId);
    }
  }
);
onBeforeUnmount(() => {
  disposed = true;
  requestVersion += 1;
  dependencyVersion += 1;
});

function selectTask(task: ProjectTaskRow): void {
  selectedTaskId.value = task.id;
  receipt.value = null;
  actionError.value = null;
}

async function startSelected(): Promise<void> {
  const task = selectedTask.value;
  const client = liveClient();
  if (!task || submitting.value || !canStart.value) {
    return;
  }
  submitting.value = true;
  actionError.value = null;
  liveFailure.value = null;
  receipt.value = null;
  try {
    if (client === null) {
      const command = await fixtureAdapter.startTask(task.id, mode.value);
      if (disposed) {
        return;
      }
      await load();
      if (disposed) {
        return;
      }
      selectedTaskId.value = task.id;
      receipt.value = command.description;
      return;
    }

    const commandId = pendingStart?.taskId === task.id ? pendingStart.commandId : createCommandId();
    pendingStart = { taskId: task.id, commandId };
    const mutation = await client.startHumanTask({
      taskId: task.id,
      commandId,
      expectedRevision: task.revision
    });
    if (disposed) {
      return;
    }
    pendingStart = null;
    await load();
    if (disposed) {
      return;
    }
    selectedTaskId.value = task.id;
    receipt.value = `已开始：任务状态为${taskStatusLabels[mutation.status]}，任务修订 v${mutation.revision}。开始不等于完成。`;
  } catch (caught) {
    if (disposed) {
      return;
    }
    const described = describeLiveError(caught);
    liveFailure.value = described;
    actionError.value = described.message;
    // 只有服务端给出明确结果时才能丢弃 command ID；传输错误必须保留它用于核对。
    if (described.kind !== "transport") {
      pendingStart = null;
    }
  } finally {
    if (!disposed) {
      submitting.value = false;
    }
  }
}

/** 提交结果不确定时按同一 command ID 查询回执，不换 ID 重试。 */
async function lookupStartReceipt(): Promise<void> {
  const client = liveClient();
  const pending = pendingStart;
  if (client === null || pending === null || submitting.value) {
    return;
  }
  submitting.value = true;
  actionError.value = null;
  liveFailure.value = null;
  try {
    const receiptBody = await client.getCommandReceipt(pending.commandId);
    if (disposed) {
      return;
    }
    const mutation = taskMutationFrom(receiptBody.result);
    pendingStart = null;
    await load();
    if (disposed) {
      return;
    }
    selectedTaskId.value = pending.taskId;
    receipt.value = `回执确认已提交：任务状态为${taskStatusLabels[mutation.status]}，任务修订 v${mutation.revision}。开始不等于完成。`;
  } catch (caught) {
    if (disposed) {
      return;
    }
    const described = describeLiveError(caught);
    liveFailure.value = described;
    actionError.value =
      described.kind === "unknown" && described.message === "服务端返回 HTTP 404。"
        ? "没有找到这次提交的回执：该命令尚未提交，可以用同一个 command ID 重新提交。"
        : described.message;
  } finally {
    if (!disposed) {
      submitting.value = false;
    }
  }
}
</script>

<template>
  <section v-if="loading" class="page-state" aria-live="polite">
    <p class="eyebrow">项目任务</p>
    <h1>正在读取项目任务</h1>
    <p>{{ live ? "正在从本机 API 读取真实数据，页面尚未提交任何变更。" : "示例数据正在加载，页面尚未提交任何变更。" }}</p>
  </section>

  <section v-else-if="error" class="page-state page-state--error" role="alert">
    <p class="eyebrow">项目任务</p>
    <h1>{{ live ? "暂时无法读取这个项目" : "暂时无法显示项目任务" }}</h1>
    <p>{{ error }}</p>
    <button class="secondary-button" type="button" @click="load"><RotateCcw aria-hidden="true" />重新读取</button>
  </section>

  <section v-else-if="!result" class="page-state">
    <p class="eyebrow">项目任务</p>
    <h1>{{ live ? "服务端没有返回这个项目" : "没有这个示例项目" }}</h1>
    <p>
      {{
        live
          ? "跨作用域或已删除的项目按不可见处理；工作台不会据此创建项目或任务。"
          : "示例数据里没有该项目的任务，页面不会据此创建项目或任务。"
      }}
    </p>
    <RouterLink class="text-link" to="/projects">返回项目列表</RouterLink>
  </section>

  <section v-else class="skill-page">
    <div class="page-layout">
      <div class="page-primary">
        <p class="eyebrow">{{ result.project.title }}</p>
        <p v-if="result.project.goal !== null" class="page-lede">{{ result.project.goal }}</p>
        <h1>项目任务</h1>

        <ProjectNav :project-id="projectId" active="tasks" />

        <div class="list-toolbar">
          <label class="search-field">
            <Search aria-hidden="true" />
            <span class="visually-hidden">搜索任务（标题、状态、执行者）</span>
            <input v-model="search" type="search" name="project-task-search" placeholder="搜索任务（标题、状态、执行者）" />
          </label>
          <RouterLink class="primary-button" :to="`/tasks?view=create&project=${projectId}`">
            <Plus aria-hidden="true" />新建任务
          </RouterLink>
        </div>

        <p v-if="refreshing" class="helper-text" role="status">正在更新项目任务，已显示的内容保持可见。</p>

        <div v-if="tasks.length === 0" class="page-state">
          <p>{{ search.trim() ? "当前项目没有匹配该关键词的任务。" : live ? "这个项目还没有任务。" : "这个示例项目还没有任务。" }}</p>
          <button v-if="search.trim()" class="secondary-button" type="button" @click="search = ''">清除搜索</button>
        </div>

        <div v-else class="table-scroll">
          <div class="data-table">
            <div class="data-row data-row--head data-row--project-tasks" aria-hidden="true">
              <span class="data-cell">任务</span>
              <span class="data-cell">状态</span>
              <span class="data-cell">执行模式</span>
              <span class="data-cell">依赖</span>
            </div>
            <ul class="data-list">
              <li v-for="task in tasks" :key="task.id">
                <button
                  class="data-row data-row--project-tasks data-row--interactive"
                  :class="{ 'data-row--selected': task.id === selectedTaskId }"
                  type="button"
                  :aria-current="task.id === selectedTaskId ? 'true' : undefined"
                  :data-testid="`project-task-row-${task.id}`"
                  @click="selectTask(task)"
                >
                  <span class="data-cell">
                    <strong>{{ task.title }}</strong>
                    <small>任务修订 v{{ task.revision }}</small>
                  </span>
                  <span class="data-cell"><StatusChip :status="task.status" /></span>
                  <span class="data-cell data-cell--meta">{{ interactionModeLabels[task.mode] }}</span>
                  <span class="data-cell data-cell--meta">
                    {{ dependencyLabel(task) }}
                  </span>
                </button>
              </li>
            </ul>
          </div>
        </div>

        <p class="list-footer-note">
          <Info aria-hidden="true" />
          {{
            live
              ? "该页面固定在当前项目范围内；可开始性来自服务端 allowed_actions，界面不自行推断授权。"
              : "该页面固定在当前项目范围内；依赖是否成环由服务端判断，界面不自行推断。"
          }}
        </p>
      </div>

      <ResponsiveRail label="查看任务判断" title="任务判断">
        <div class="rail-content">
          <template v-if="selectedTask">
            <h2>{{ selectedTask.title }}</h2>
            <p class="rail-intro">任务修订 v{{ selectedTask.revision }}</p>

            <section class="rail-section">
              <h3>三个独立事实</h3>
              <dl class="rail-definition-list">
                <div>
                  <dt>任务状态</dt>
                  <dd><StatusChip :status="selectedTask.status" /></dd>
                </div>
                <div>
                  <dt>执行模式</dt>
                  <dd>{{ interactionModeLabels[selectedTask.mode] }}</dd>
                </div>
                <div>
                  <dt>当前执行者</dt>
                  <dd>{{ executorLabels[selectedTask.executor] }}</dd>
                </div>
              </dl>
            </section>

            <section v-if="selectedTask.blockedReason !== null" class="rail-section">
              <h3>为什么暂不能开始</h3>
              <p>{{ selectedTask.blockedReason }}</p>
            </section>

            <section v-if="selectedDependencies.length > 0" class="rail-section">
              <h3>前置依赖</h3>
              <p>完成以下前置任务后，方可开始本任务。</p>
              <RouterLink
                v-for="note in selectedDependencies"
                :key="note.id"
                class="dependency-card"
                :to="`/tasks/${note.id}`"
              >
                <FileText aria-hidden="true" />
                <span class="dependency-card-copy">
                  <strong>{{ note.title }}</strong>
                  <small>
                    状态：{{ taskStatusLabels[note.status] }}
                    <template v-if="note.executor !== null"> · 执行者：{{ executorLabels[note.executor] }}</template>
                  </small>
                </span>
                <ChevronRight aria-hidden="true" />
              </RouterLink>
              <p v-if="selectedDependencies[0].reason !== null" class="helper-text">{{ selectedDependencies[0].reason }}</p>
            </section>

            <section v-if="selectedDependencies.length > 0 && selectedDependencies[0].downstreamNote !== null" class="rail-section">
              <h3>后续影响</h3>
              <p>{{ selectedDependencies[0].downstreamNote }}</p>
            </section>

            <p v-if="receipt" class="receipt-message" role="status">{{ receipt }}</p>
            <p v-if="actionError" class="action-error" role="alert">{{ actionError }}</p>
            <button
              v-if="liveFailure?.kind === 'transport'"
              class="secondary-button secondary-button--wide"
              type="button"
              data-testid="project-task-receipt"
              :disabled="submitting"
              @click="lookupStartReceipt"
            >
              查询本次回执
            </button>
            <p v-if="liveFailure?.kind === 'transport'" class="helper-text">
              提交结果不确定时先查回执，不要换 command ID 重新提交。
            </p>

            <button
              class="primary-button primary-button--wide"
              type="button"
              data-testid="project-task-start"
              :disabled="submitting || !canStart"
              @click="startSelected"
            >
              {{ submitting ? "正在开始" : "开始任务" }}
            </button>
            <p v-if="!canStart" class="disabled-reason" data-testid="project-task-start-reason">
              <Info aria-hidden="true" />
              {{ startBlockedReason }}
            </p>

            <RouterLink
              v-for="note in selectedDependencies"
              :key="`link-${note.id}`"
              class="secondary-button secondary-button--wide"
              :to="`/tasks/${note.id}`"
            >
              查看前置任务
            </RouterLink>
            <RouterLink
              v-if="selectedDependencies.length === 0"
              class="secondary-button secondary-button--wide"
              :to="`/tasks/${selectedTask.id}`"
            >
              打开任务详情
            </RouterLink>
          </template>
          <p v-else class="rail-intro">请先在列表中选择一个任务，这里会显示它的依赖与阻塞原因。</p>
        </div>
      </ResponsiveRail>
    </div>
  </section>
</template>
