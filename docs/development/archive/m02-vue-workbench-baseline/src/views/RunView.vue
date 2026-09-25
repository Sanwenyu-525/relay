<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { RotateCcw } from "lucide-vue-next";
import RunSourcesPanel from "../components/RunSourcesPanel.vue";
import {
  createCommandId,
  RelayApiError,
  RelayTransportError,
  type RelayControlRequest,
  type RelayControlType,
  type RelayContextBuild,
  type RelayContextManifestDetail,
  type RelayContextManifestSummary,
  type RelayReview,
  type RelayRun,
  type RelayTaskDetail
} from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { executorLabels, taskStatusLabels } from "../lib/labels";
import { liveClient, relayConnection } from "../lib/relayConnection";

const route = useRoute();
const runId = computed(() => String(route.params.id));
const live = computed(() => relayConnection.mode === "live");
const run = ref<RelayRun | null>(null);
const task = ref<RelayTaskDetail | null>(null);
const reviews = ref<readonly RelayReview[]>([]);
const controlRecord = ref<RelayControlRequest | null>(null);
const acceptedControl = ref<{ id: string; type: RelayControlType } | null>(null);
const pendingCommand = ref<{ id: string; kind: "control" | "resume"; type?: RelayControlType } | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const submitting = ref(false);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const actionMessage = ref<string | null>(null);
const sourceBuild = ref<RelayContextBuild | null>(null);
const sourceManifests = ref<readonly RelayContextManifestSummary[]>([]);
const sourceSelectedId = ref<string | null>(null);
const sourceDetail = ref<RelayContextManifestDetail | null>(null);
const sourceLoading = ref(false);
const sourceDetailLoading = ref(false);
const sourceError = ref<string | null>(null);
let requestVersion = 0;
let targetVersion = 0;
let sourceRequestVersion = 0;
let sourceDetailVersion = 0;

const controlLabels: Record<RelayControlType, string> = {
  PAUSE: "请求暂停 Run",
  CANCEL: "请求停止 Run",
  HANDOFF: "请求交接给人工",
  CANCEL_TASK: "请求取消任务"
};
const runLabels: Record<string, string> = {
  CREATED: "待启动",
  CONTEXT_BUILDING: "构建上下文",
  PLANNING: "规划中",
  RUNNING: "执行中",
  WAITING_APPROVAL: "等待人工判断",
  VERIFYING: "验证中",
  RETRYING: "修正中",
  PAUSED: "已暂停",
  COMPLETED: "已完成",
  FAILED: "失败",
  CANCELLED: "已停止"
};
const stepLabels: Record<string, string> = {
  BUILD_CONTEXT: "构建上下文",
  DRAFT: "生成草稿",
  PERSIST_CANDIDATE: "保存候选产物",
  VERIFY: "验证",
  COMPLETE: "提交完成"
};
const activeRun = computed(() => run.value !== null && task.value?.executor === "AI" && task.value.executorRunId === run.value.id);
const terminal = computed(() => run.value !== null && ["COMPLETED", "FAILED", "CANCELLED"].includes(run.value.status));
const canControl = computed(() => live.value && activeRun.value && !terminal.value && run.value?.pendingControlRequest === null && pendingCommand.value === null && !submitting.value);
const openReviews = computed(() => reviews.value.filter((item) => item.status === "OPEN"));

async function load(): Promise<void> {
  const version = ++requestVersion;
  // 每次重读先移除旧片段；服务端可能已经撤销读取权。
  sourceRequestVersion += 1;
  sourceDetailVersion += 1;
  sourceDetail.value = null;
  sourceManifests.value = [];
  sourceBuild.value = null;
  sourceError.value = null;
  sourceLoading.value = true;
  sourceDetailLoading.value = false;
  if (run.value === null) loading.value = true;
  else refreshing.value = true;
  error.value = null;
  try {
    const client = liveClient();
    if (client === null) {
      run.value = null;
      task.value = null;
      reviews.value = [];
      return;
    }
    const loadedRun = await client.getRun(runId.value);
    const [loadedTask, loadedReviews] = await Promise.all([
      client.getTask(loadedRun.taskId),
      client.getRunReviews(loadedRun.id)
    ]);
    if (version !== requestVersion) return;
    run.value = loadedRun;
    task.value = loadedTask;
    reviews.value = loadedReviews;
    void loadSources(loadedRun.id);
    const controlId = loadedRun.pendingControlRequest?.id ?? acceptedControl.value?.id;
    if (controlId !== undefined) {
      const loadedControl = await client.getControlRequest(loadedRun.id, controlId);
      if (version !== requestVersion) return;
      controlRecord.value = loadedControl;
    } else {
      controlRecord.value = null;
    }
  } catch (caught) {
    if (version === requestVersion) error.value = describeLiveError(caught).message;
  } finally {
    if (version === requestVersion) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

async function loadSources(id: string): Promise<void> {
  const client = liveClient();
  if (client === null) return;
  const version = ++sourceRequestVersion;
  const context = targetVersion;
  const preferredId = sourceSelectedId.value;
  sourceDetailVersion += 1;
  sourceDetail.value = null;
  sourceManifests.value = [];
  sourceBuild.value = null;
  sourceError.value = null;
  sourceLoading.value = true;
  sourceDetailLoading.value = false;
  try {
    const result = await client.getRunContextManifests(id);
    if (version !== sourceRequestVersion || context !== targetVersion || run.value?.id !== id) return;
    sourceBuild.value = result.build;
    sourceManifests.value = result.items;
    const chosenId = result.items.some((item) => item.id === preferredId)
      ? preferredId : result.items[0]?.id ?? null;
    sourceSelectedId.value = chosenId;
    sourceLoading.value = false;
    if (chosenId !== null) await selectSource(chosenId);
  } catch (caught) {
    if (version !== sourceRequestVersion || context !== targetVersion) return;
    sourceError.value = sourceReadError(caught);
  } finally {
    if (version === sourceRequestVersion && context === targetVersion) sourceLoading.value = false;
  }
}

async function selectSource(manifestId: string): Promise<void> {
  const client = liveClient();
  const id = run.value?.id;
  if (client === null || id === undefined || !sourceManifests.value.some((item) => item.id === manifestId)) return;
  const version = ++sourceDetailVersion;
  const context = targetVersion;
  sourceSelectedId.value = manifestId;
  sourceDetail.value = null;
  sourceError.value = null;
  sourceDetailLoading.value = true;
  try {
    const detail = await client.getRunContextManifest(id, manifestId);
    if (version !== sourceDetailVersion || context !== targetVersion || run.value?.id !== id) return;
    sourceDetail.value = detail;
  } catch (caught) {
    if (version === sourceDetailVersion && context === targetVersion) sourceError.value = sourceReadError(caught);
  } finally {
    if (version === sourceDetailVersion && context === targetVersion) sourceDetailLoading.value = false;
  }
}

function sourceReadError(caught: unknown): string {
  if (caught instanceof RelayApiError && [403, 404].includes(caught.problem.status)) {
    return "来源已不可读取或当前范围无权查看。旧片段已清除，请重新核对权限。";
  }
  return describeLiveError(caught).message;
}

watch([runId, () => relayConnection.client], () => {
  targetVersion += 1;
  requestVersion += 1;
  run.value = null;
  task.value = null;
  reviews.value = [];
  controlRecord.value = null;
  acceptedControl.value = null;
  pendingCommand.value = null;
  sourceRequestVersion += 1;
  sourceDetailVersion += 1;
  sourceBuild.value = null;
  sourceManifests.value = [];
  sourceSelectedId.value = null;
  sourceDetail.value = null;
  sourceLoading.value = false;
  sourceDetailLoading.value = false;
  sourceError.value = null;
  submitting.value = false;
  actionError.value = null;
  actionMessage.value = null;
  void load();
}, { immediate: true });
onBeforeUnmount(() => { targetVersion += 1; requestVersion += 1; sourceRequestVersion += 1; sourceDetailVersion += 1; });

async function submitControl(type: RelayControlType): Promise<void> {
  const client = liveClient();
  const currentRun = run.value;
  const currentTask = task.value;
  if (client === null || currentRun === null || currentTask === null || !canControl.value || (type === "PAUSE" && currentRun.status === "PAUSED")) return;
  const id = createCommandId();
  const contextVersion = targetVersion;
  pendingCommand.value = { id, kind: "control", type };
  submitting.value = true;
  actionError.value = null;
  actionMessage.value = null;
  try {
    const result = await client.requestRunControl({
      runId: currentRun.id,
      commandId: id,
      expectedTaskRevision: currentTask.revision,
      expectedRunRevision: currentRun.revision,
      type
    });
    if (contextVersion !== targetVersion) return;
    if (result.taskId !== currentTask.id) {
      throw new RelayTransportError("控制回执的任务与当前 Run 不匹配。");
    }
    pendingCommand.value = null;
    acceptedControl.value = { id: result.controlRequestId, type };
    actionMessage.value = `${controlLabels[type]}提交回执为 202 / PENDING；下方 Run 与控制请求状态是随后查询的当前事实。`;
    await load();
  } catch (caught) {
    if (contextVersion !== targetVersion) return;
    if (caught instanceof RelayTransportError) {
      actionError.value = "响应丢失或无法核对，控制请求是否入库尚未确定。请查询原 command_id 回执，不能换 ID 再提交。";
    } else {
      pendingCommand.value = null;
      actionError.value = describeLiveError(caught).message;
      if (caught instanceof RelayApiError && ["REVISION_CONFLICT", "CONTROL_CONFLICT", "INVALID_TRANSITION", "RUN_TERMINAL", "UNKNOWN_ACTION_BLOCKED"].includes(caught.problem.code)) await load();
    }
  } finally {
    if (contextVersion === targetVersion) submitting.value = false;
  }
}

async function resume(): Promise<void> {
  const client = liveClient();
  const currentRun = run.value;
  const currentTask = task.value;
  if (client === null || currentRun === null || currentTask === null || !canControl.value || currentRun.status !== "PAUSED") return;
  const id = createCommandId();
  const contextVersion = targetVersion;
  pendingCommand.value = { id, kind: "resume" };
  submitting.value = true;
  actionError.value = null;
  actionMessage.value = null;
  try {
    await client.resumeRun({
      runId: currentRun.id,
      commandId: id,
      expectedTaskRevision: currentTask.revision,
      expectedRunRevision: currentRun.revision
    });
    if (contextVersion !== targetVersion) return;
    pendingCommand.value = null;
    actionMessage.value = "恢复命令已受理（202）。已重新读取 Run；实际状态以服务端查询为准。";
    await load();
  } catch (caught) {
    if (contextVersion !== targetVersion) return;
    if (caught instanceof RelayTransportError) {
      actionError.value = "响应丢失或无法核对，恢复是否受理尚未确定。请查询原 command_id 回执，不能换 ID 再提交。";
    } else {
      pendingCommand.value = null;
      actionError.value = describeLiveError(caught).message;
      if (caught instanceof RelayApiError && ["REVISION_CONFLICT", "CONTROL_CONFLICT", "INVALID_TRANSITION", "UNKNOWN_ACTION_BLOCKED"].includes(caught.problem.code)) await load();
    }
  } finally {
    if (contextVersion === targetVersion) submitting.value = false;
  }
}

async function checkReceipt(): Promise<void> {
  const pending = pendingCommand.value;
  const client = liveClient();
  if (pending === null || client === null || submitting.value) return;
  const contextVersion = targetVersion;
  submitting.value = true;
  try {
    const receipt = await client.getCommandReceipt(pending.id);
    if (contextVersion !== targetVersion) return;
    const result = receipt.result;
    const matchesRun = receipt.commandId === pending.id && result.run_id === runId.value;
    const matchesCommand = pending.kind === "control"
      ? receipt.commandType === "RequestRunControl" && result.task_id === task.value?.id &&
        result.type === pending.type && result.status === "PENDING" &&
        typeof result.control_request_id === "string" && result.control_request_id.length > 0
      : receipt.commandType === "ResumeRun" && typeof result.status === "string" && result.status.length > 0;
    if (!matchesRun || !matchesCommand || typeof result.run_revision !== "string" || !/^\d+$/.test(result.run_revision)) {
      actionError.value = "原命令回执与当前 Run 或命令类型不匹配，结果仍未确定。请保留原 command_id 核对。";
      return;
    }
    if (pending.kind === "control") {
      acceptedControl.value = { id: result.control_request_id as string, type: pending.type as RelayControlType };
    }
    pendingCommand.value = null;
    actionError.value = null;
    actionMessage.value = "已找到原命令回执；正在核对 Run 与控制请求的最新状态。";
    await load();
  } catch (caught) {
    if (contextVersion !== targetVersion) return;
    actionError.value = caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
      ? "暂未找到原命令回执，结果仍未确定。请稍后继续用同一个 command_id 核对。"
      : describeLiveError(caught).message;
  } finally {
    if (contextVersion === targetVersion) submitting.value = false;
  }
}
</script>

<template>
  <section v-if="loading" class="page-state" aria-live="polite"><p class="eyebrow">Run</p><h1>正在读取执行记录</h1></section>
  <section v-else-if="!live" class="page-state" data-testid="run-fixture-gap">
    <p class="eyebrow">Run</p><h1>示例模式没有真实 Run</h1>
    <p>连接本机 API 后才能读取步骤、未决请求和控制状态。示例数据不生成执行记录。</p>
    <RouterLink class="text-link" to="/tasks">返回任务列表</RouterLink>
  </section>
  <section v-else-if="error" class="page-state page-state--error" role="alert">
    <p class="eyebrow">Run</p><h1>暂时无法读取执行记录</h1><p>{{ error }}</p>
    <button class="secondary-button" type="button" @click="load"><RotateCcw aria-hidden="true" />重新读取</button>
  </section>
  <section v-else-if="run && task" class="skill-page" data-testid="run-detail">
    <div class="page-layout"><div class="page-primary">
      <p class="eyebrow">真实 Run · {{ run.id }}</p>
      <h1>{{ task.title }}</h1>
      <p class="page-lede">{{ runLabels[run.status] ?? run.status }} · Run 修订 v{{ run.revision }} · 任务修订 v{{ task.revision }}</p>
      <p class="helper-text">任务状态：{{ taskStatusLabels[task.status] }} · 当前执行者：{{ executorLabels[task.executor] }}</p>
      <RouterLink class="text-link" :to="`/tasks/${run.taskId}`">返回关联任务</RouterLink>
      <p v-if="refreshing" class="helper-text" role="status">正在读取最新执行事实。</p>
      <p v-if="!activeRun" class="helper-text">这是历史 Run，任务当前执行权已变化；本页只保留查询。</p>
      <p v-if="run.waitReason" class="helper-text">等待原因：{{ run.waitReason }}</p>

      <section v-if="run.unresolvedOperationIds.length > 0" class="surface-panel" data-testid="run-unknown">
        <h2>执行结果尚未确认</h2>
        <p class="helper-text">以下动作仍需核对。控制和恢复不能代替外部效果核对；本页没有强制标记成功的入口。</p>
        <ul class="run-list"><li v-for="id in run.unresolvedOperationIds" :key="id">未决动作 {{ id }}</li></ul>
      </section>

      <section class="surface-panel" data-testid="run-control">
        <h2>控制请求</h2>
        <p class="helper-text">控制提交回执表示 PENDING；安全点可能随后处理请求。Run、任务执行者与控制状态以重新查询为准。</p>
        <p v-if="run.pendingControlRequest" class="receipt-message" role="status">
          {{ controlLabels[run.pendingControlRequest.type] }}：{{ run.pendingControlRequest.status }}。等待安全点处理；请求 {{ run.pendingControlRequest.id }}。
        </p>
        <p v-if="controlRecord" class="helper-text" data-testid="run-control-status">
          控制请求 {{ controlRecord.id }}：{{ controlRecord.status }}<template v-if="controlRecord.decidedAt"> · 处理时间 {{ controlRecord.decidedAt }}</template>
        </p>
        <p v-if="actionError" class="action-error" role="alert">{{ actionError }}</p>
        <p v-if="actionMessage" class="receipt-message" role="status">{{ actionMessage }}</p>
        <p v-if="pendingCommand" class="helper-text">原 command_id：{{ pendingCommand.id }}</p>
        <div class="run-actions">
          <button v-if="pendingCommand" class="secondary-button" type="button" data-testid="run-check-receipt" :disabled="submitting" @click="checkReceipt">核对原命令回执</button>
          <template v-else>
            <button v-if="run.status === 'PAUSED'" class="primary-button" type="button" data-testid="run-resume" :disabled="!canControl" @click="resume">恢复 Run</button>
            <button v-else class="secondary-button" type="button" data-testid="run-control-PAUSE" :disabled="!canControl" @click="submitControl('PAUSE')">{{ controlLabels.PAUSE }}</button>
            <button class="secondary-button" type="button" data-testid="run-control-CANCEL" :disabled="!canControl" @click="submitControl('CANCEL')">{{ controlLabels.CANCEL }}</button>
            <button class="secondary-button" type="button" data-testid="run-control-HANDOFF" :disabled="!canControl" @click="submitControl('HANDOFF')">{{ controlLabels.HANDOFF }}</button>
            <button class="danger-button" type="button" data-testid="run-control-CANCEL_TASK" :disabled="!canControl" @click="submitControl('CANCEL_TASK')">{{ controlLabels.CANCEL_TASK }}</button>
          </template>
          <button class="secondary-button" type="button" data-testid="run-refresh" :disabled="refreshing || submitting" @click="load">刷新状态</button>
        </div>
      </section>

      <section class="surface-panel" data-testid="run-steps">
        <h2>步骤与最近尝试</h2>
        <p v-if="run.steps.length === 0" class="helper-text">尚无步骤记录。</p>
        <ol v-else class="run-list">
          <li v-for="step in run.steps" :key="step.id">
            <strong>{{ step.index + 1 }}. {{ stepLabels[step.kind] ?? step.kind }}</strong> · {{ step.status }}
            <span v-if="step.id === run.currentStepId"> · 当前步骤</span>
          </li>
        </ol>
        <p v-if="run.recentAttempts.length > 0" class="helper-text">最近尝试</p>
        <ul v-if="run.recentAttempts.length > 0" class="run-list">
          <li v-for="attempt in run.recentAttempts" :key="attempt.id">{{ stepLabels[attempt.stepKind] ?? attempt.stepKind }} · 第 {{ attempt.number }} 次 · {{ attempt.status }}</li>
        </ul>
      </section>

      <RunSourcesPanel :loading="sourceLoading" :detail-loading="sourceDetailLoading" :error="sourceError"
        :build="sourceBuild" :manifests="sourceManifests" :selected-id="sourceSelectedId" :detail="sourceDetail"
        @refresh="loadSources(run.id)" @select="selectSource" />

      <section class="surface-panel" data-testid="run-reviews">
        <h2>未决 Review</h2>
        <p v-if="openReviews.length === 0" class="helper-text">当前没有未决 Review。</p>
        <ul v-else class="run-list">
          <li v-for="review in openReviews" :key="review.id">
            {{ review.reason }} · <RouterLink class="text-link" :to="`/reviews?id=${review.id}`">查看请求与判断依据</RouterLink>
          </li>
        </ul>
      </section>
    </div></div>
  </section>
</template>

<style scoped>
.run-actions { display: flex; flex-wrap: wrap; gap: var(--relay-space-3); margin-top: var(--relay-space-5); }
.run-list { margin: var(--relay-space-3) 0 0; padding-left: var(--relay-space-6); }
.run-list li { padding: var(--relay-space-2) 0; overflow-wrap: anywhere; }
</style>
