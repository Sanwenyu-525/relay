<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { Info, RotateCcw } from "lucide-vue-next";
import ArtifactPanel from "../components/ArtifactPanel.vue";
import StatusChip from "../components/StatusChip.vue";
import type { RelayAcceptanceCriterion, RelayApiClient } from "../api/relayClient";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, relayConnection } from "../lib/relayConnection";
import type { DecimalRevision, ExecutorKind, FixtureError, InteractionMode, TaskStatus } from "../types";

const route = useRoute();

/** 页面视图模型：fixture 与 live 都映射到这里；缺失字段显示为未提供，不编造。 */
interface TaskDetailResult {
  readonly source: "fixture" | "live";
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly status: TaskStatus;
    readonly mode: InteractionMode;
    readonly executor: ExecutorKind;
    readonly revision: DecimalRevision;
    readonly acceptanceRevision: DecimalRevision;
    readonly currentCompletionId: string | null;
    readonly projectId: string | null;
    readonly runId: string | null;
    /** 仅 live：服务端投影的允许动作。 */
    readonly allowedActions: readonly string[] | null;
  };
  readonly objective: string | null;
  readonly criteria: readonly RelayAcceptanceCriterion[];
  readonly criteriaNote: string;
  readonly dependencies: readonly { readonly id: string; readonly title: string; readonly status: TaskStatus }[];
}

const result = ref<TaskDetailResult | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const tab = ref<"overview" | "artifacts" | "runs">("overview");
const refreshing = ref(false);
let requestVersion = 0;
let disposed = false;

const taskId = computed(() => String(route.params.id));
const mode = computed(() => fixtureModeFromQuery(route.query));
const live = computed(() => relayConnection.mode === "live");
const tabs = [
  { key: "overview", label: "概览" },
  { key: "artifacts", label: "产物" },
  { key: "runs", label: "执行记录" }
] as const;

async function load(): Promise<void> {
  const request = ++requestVersion;
  if (result.value !== null) {
    refreshing.value = true;
  } else {
    loading.value = true;
  }
  error.value = null;
  try {
    const client = liveClient();
    const loaded =
      client === null ? await loadFixture() : await loadLive(client, taskId.value);
    if (request !== requestVersion) {
      return;
    }
    result.value = loaded;
  } catch (caught) {
    if (request !== requestVersion) {
      return;
    }
    error.value = live.value
      ? describeLiveError(caught).message
      : caught instanceof Error && "kind" in caught
        ? (caught as FixtureError).message.trim()
        : caught instanceof Error
          ? caught.message.trim()
          : "读取示例任务时发生未知错误。";
  } finally {
    if (request === requestVersion) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

async function loadFixture(): Promise<TaskDetailResult | null> {
  const snapshot = await fixtureAdapter.loadTask(taskId.value, mode.value);
  if (snapshot === null) {
    return null;
  }
  const record = snapshot.task;
  return {
    source: "fixture",
    task: {
      id: record.id,
      title: record.title,
      status: record.status,
      mode: record.mode,
      executor: record.executor,
      revision: record.revision,
      acceptanceRevision: snapshot.verification.acceptanceRevision,
      currentCompletionId: null,
      projectId: snapshot.id,
      runId: null,
      allowedActions: null
    },
    objective: record.definition.objective,
    criteria: snapshot.verification.checks.map((check) => ({
      criterionId: check.id,
      statement: check.title,
      required: check.required,
      method: check.method
    })),
    criteriaNote: "示例验收方案，不代表服务端当前验收版本。",
    dependencies: []
  };
}

async function loadLive(client: RelayApiClient, id: string): Promise<TaskDetailResult> {
  const task = await client.getTask(id);
  return {
    source: "live",
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      mode: task.mode,
      executor: task.executor,
      revision: task.revision,
      acceptanceRevision: task.acceptance.acceptanceRevision,
      currentCompletionId: task.currentCompletionId,
      projectId: task.projectId,
      runId: task.executorRunId,
      allowedActions: task.allowedActions
    },
    objective: task.acceptance.objective === "" ? null : task.acceptance.objective,
    criteria: task.acceptance.criteria,
    criteriaNote: `来源：${task.acceptance.source}；验收版本 v${task.acceptance.acceptanceRevision}。`,
    dependencies: task.dependencies.map((dependency) => ({
      id: dependency.taskId,
      title: dependency.title,
      status: dependency.status
    }))
  };
}

watch([taskId, mode, live], load, { immediate: true });
onBeforeUnmount(() => {
  disposed = true;
  requestVersion += 1;
});

function onRefreshed(): void {
  if (!disposed) {
    void load();
  }
}
</script>

<template>
  <section v-if="loading" class="page-state" aria-live="polite">
    <p class="eyebrow">任务详情</p>
    <h1>正在读取任务</h1>
    <p>{{ live ? "正在从本机 API 读取真实任务事实。" : "示例数据正在加载。" }}</p>
  </section>

  <section v-else-if="error" class="page-state page-state--error" role="alert">
    <p class="eyebrow">任务详情</p>
    <h1>暂时无法读取这个任务</h1>
    <p>{{ error }}</p>
    <button class="secondary-button" type="button" @click="load"><RotateCcw aria-hidden="true" />重新读取</button>
  </section>

  <section v-else-if="!result" class="page-state">
    <p class="eyebrow">任务详情</p>
    <h1>{{ live ? "服务端没有返回这个任务" : "示例数据没有这个任务" }}</h1>
    <p>
      {{
        live
          ? "跨作用域或已删除的任务按不可见处理；页面不会据此创建任务。"
          : "示例数据里只有“确定实验评价指标”这一个任务，其他任务不显示示例内容。"
      }}
    </p>
    <RouterLink class="text-link" to="/tasks">返回任务列表</RouterLink>
  </section>

  <section v-else class="skill-page" data-testid="task-detail">
    <div class="page-layout">
      <div class="page-primary">
        <p class="eyebrow">{{ live ? "真实任务" : "示例任务" }}</p>
        <h1>{{ result.task.title }}</h1>
        <p v-if="result.objective !== null" class="page-lede">{{ result.objective }}</p>
        <p v-if="refreshing" class="helper-text" role="status">正在更新任务事实，已显示的内容保持可见。</p>

        <section class="rail-section">
          <h3>三个独立事实</h3>
          <dl class="rail-definition-list">
            <div>
              <dt>工作状态</dt>
              <dd><StatusChip :status="result.task.status" /></dd>
            </div>
            <div>
              <dt>执行模式</dt>
              <dd>{{ interactionModeLabels[result.task.mode] }}</dd>
            </div>
            <div>
              <dt>当前执行者</dt>
              <dd>{{ executorLabels[result.task.executor] }}</dd>
            </div>
            <div>
              <dt>任务修订</dt>
              <dd>v{{ result.task.revision }}</dd>
            </div>
            <div>
              <dt>验收版本</dt>
              <dd>v{{ result.task.acceptanceRevision }}</dd>
            </div>
          </dl>
        </section>

        <nav class="skill-tabs" aria-label="任务详情页签">
          <button
            v-for="item in tabs"
            :key="item.key"
            class="skill-tab"
            :class="{ 'skill-tab--active': tab === item.key }"
            type="button"
            :aria-current="tab === item.key ? 'page' : undefined"
            :data-testid="`task-detail-tab-${item.key}`"
            @click="tab = item.key"
          >
            {{ item.label }}
          </button>
        </nav>

        <template v-if="tab === 'overview'">
          <section class="surface-panel">
            <h2>验收标准</h2>
            <p class="helper-text">{{ result.criteriaNote }}</p>
            <div v-if="result.criteria.length === 0" class="page-state">
              <p>当前验收版本没有条件。</p>
            </div>
            <ul v-else class="criteria-list">
              <li v-for="criterion in result.criteria" :key="criterion.criterionId" class="criteria-row">
                <span class="criteria-copy">
                  <strong>{{ criterion.statement }}</strong>
                  <small>
                    标识 {{ criterion.criterionId }} · 验证方式 {{ criterion.method }}
                    <template v-if="criterion.required"> · 必需</template>
                    <template v-else> · 可选</template>
                  </small>
                </span>
                <span v-if="criterion.required" class="status-chip">必需</span>
              </li>
            </ul>
            <p class="helper-text">
              <Info aria-hidden="true" />
              修改验收标准需要专用命令，当前 API 还没有该入口（待接入）；本页只读取，不在这里改写验收。
            </p>
          </section>

          <section class="surface-panel">
            <h2>前置依赖</h2>
            <p v-if="result.source === 'fixture'" class="helper-text">
              示例数据没有提供该任务的依赖事实；项目任务页展示的依赖来自示例项目范围。
            </p>
            <div v-else-if="result.dependencies.length === 0" class="helper-text">没有前置依赖。</div>
            <ul v-else class="criteria-list">
              <li v-for="dependency in result.dependencies" :key="dependency.id" class="criteria-row">
                <span class="criteria-copy">
                  <strong>{{ dependency.title }}</strong>
                  <small>状态：{{ taskStatusLabels[dependency.status] }}</small>
                </span>
                <RouterLink class="text-link" :to="`/tasks/${dependency.id}`">打开</RouterLink>
              </li>
            </ul>
          </section>

          <section class="surface-panel">
            <h2>编辑入口</h2>
            <p class="helper-text">
              <template v-if="result.task.status === 'DONE'">
                该任务本轮已完成：编辑前需要先重开，界面不会悄悄改旧版本。
              </template>
              <template v-else>
                完善定义与验收方案沿用已有的 Skill 页面；产物编辑在“产物”页签里进行。
              </template>
            </p>
            <div class="form-actions">
              <RouterLink class="secondary-button" :to="`/tasks/${result.task.id}?skill=definition`">完善任务定义</RouterLink>
              <RouterLink class="secondary-button" :to="`/tasks/${result.task.id}?skill=verification`">验收方案</RouterLink>
            </div>
          </section>
        </template>

        <ArtifactPanel
          v-else-if="tab === 'artifacts'"
          :task-id="result.task.id"
          :project-id="result.task.projectId"
          :task-status="result.task.status"
          :task-revision="result.task.revision"
          :acceptance-revision="result.task.acceptanceRevision"
          :criteria="result.criteria"
          :allowed-actions="result.task.allowedActions"
          @refresh="onRefreshed"
        />

        <section v-else class="surface-panel" data-testid="task-runs">
          <h2>执行记录</h2>
          <template v-if="result.source === 'live' && result.task.runId !== null">
            <p class="helper-text">当前 AI 执行记录：{{ result.task.runId }}</p>
            <RouterLink class="secondary-button" :to="`/runs/${result.task.runId}`">查看 Run 步骤与控制</RouterLink>
          </template>
          <p v-else class="helper-text">{{ result.source === 'fixture' ? '示例数据不提供真实 Run。' : '当前任务没有 AI Run；本页不推断历史执行记录。' }}</p>
          <p v-if="result.task.currentCompletionId !== null" class="helper-text">
            当前完成凭据：{{ result.task.currentCompletionId }}（历史凭据在重开后仍保留）。
          </p>
        </section>
      </div>
    </div>
  </section>
</template>
