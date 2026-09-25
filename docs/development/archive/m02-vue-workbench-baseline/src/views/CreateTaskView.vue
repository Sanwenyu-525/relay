<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { Check, Info } from "lucide-vue-next";
import ResponsiveRail from "../components/ResponsiveRail.vue";
import {
  createCommandId,
  RelayApiError,
  taskCreationFrom,
  taskMutationFrom,
  type RelayTaskCreation
} from "../api/relayClient";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, relayConnection } from "../lib/relayConnection";
import type {
  CreateTaskDraft,
  FixtureError,
  InteractionMode,
  ProjectSummary,
  TaskStatus,
  TaskSummary
} from "../types";

const props = defineProps<{ inboxScope: boolean }>();
const emit = defineEmits<{ cancel: [] }>();

const route = useRoute();
const mode = computed(() => fixtureModeFromQuery(route.query));
const live = computed(() => relayConnection.mode === "live");

/** live 提交的步骤：每步各自一个 command ID，用于传输错误后按同一 ID 查回执。 */
type LiveStep = "create" | "dependency" | "ready";

interface DependencyOption {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
}

const title = ref("");
const projectId = ref<string>("");
const expectedResult = ref("");
const acceptanceCriteria = ref("");
const startIntent = ref<InteractionMode>("ME");
const dependencyId = ref<string>("");

const projects = ref<ProjectSummary[]>([]);
const candidates = ref<TaskSummary[]>([]);
const liveCandidates = ref<readonly DependencyOption[]>([]);
const optionsError = ref<string | null>(null);
const optionsLoading = ref(true);

const fieldErrors = ref<Partial<Record<"title" | "expectedResult" | "acceptanceCriteria", string>>>({});
const submitting = ref(false);
const actionError = ref<{ kind: string; message: string } | null>(null);
const receipt = ref<string | null>(null);
const readyBlockedReason = ref<string | null>(null);
const commandId = ref<string | null>(null);
const submittedIntent = ref<"ready" | "inbox" | null>(null);
const createdTaskId = ref<string | null>(null);
const liveCreate = ref<RelayTaskCreation | null>(null);
const savedDraft = ref("");
let disposed = false;
let candidatesVersion = 0;
let pendingStep: { readonly step: LiveStep; readonly commandId: string } | null = null;

const criteriaLimit = 500;

const startIntents: { value: InteractionMode; hint: string }[] = [
  { value: "ME", hint: "由我负责执行任务" },
  { value: "AI_ASSIST", hint: "在我的主导下使用 AI 辅助" },
  { value: "DELEGATE_AI", hint: "将任务委托给 AI 执行" }
];

const dependencyOptions = computed<readonly DependencyOption[]>(() => {
  if (live.value) {
    // live：候选只来自 GET /tasks?project_id=，绝不混入 fixture 候选。
    return liveCandidates.value;
  }
  const scope = projectId.value === "" ? null : projectId.value;
  return candidates.value
    .filter((task) => task.projectId === scope)
    .map((task) => ({ id: task.id, title: task.title, status: task.status }));
});

const acceptanceCount = computed(() => acceptanceCriteria.value.length);

function routeProjectId(): string {
  return typeof route.query.project === "string" && route.query.project !== "" ? route.query.project : "";
}

function draftState(): string {
  return JSON.stringify({
    title: title.value,
    projectId: projectId.value,
    expectedResult: expectedResult.value,
    acceptanceCriteria: acceptanceCriteria.value,
    startIntent: startIntent.value,
    dependencyId: dependencyId.value
  });
}

function resetDraft(): void {
  title.value = "";
  projectId.value = routeProjectId();
  expectedResult.value = "";
  acceptanceCriteria.value = "";
  startIntent.value = "ME";
  dependencyId.value = "";
  fieldErrors.value = {};
  actionError.value = null;
  receipt.value = null;
  readyBlockedReason.value = null;
  commandId.value = null;
  submittedIntent.value = null;
  createdTaskId.value = null;
  liveCreate.value = null;
  pendingStep = null;
  savedDraft.value = draftState();
  if (live.value) {
    void refreshLiveCandidates();
  }
}

const draftGuard: DraftGuard = {
  hasUnsavedChanges: () => createdTaskId.value === null && draftState() !== savedDraft.value,
  discard: resetDraft
};

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  if (draftGuard.hasUnsavedChanges()) {
    event.preventDefault();
    event.returnValue = "";
  }
}

function toActionError(caught: unknown, fallback: string): { kind: string; message: string } {
  const fixtureError = caught as FixtureError;
  return {
    kind: caught instanceof Error && "kind" in caught ? String(fixtureError.kind) : "unknown",
    message: caught instanceof Error ? caught.message.trim() : fallback
  };
}

async function loadOptions(): Promise<void> {
  if (live.value) {
    // live 不读取示例项目/任务；依赖候选来自真实端点，随项目 ID 变化单独加载。
    optionsLoading.value = false;
    if (projectId.value === "" && routeProjectId() !== "") {
      projectId.value = routeProjectId();
    }
    savedDraft.value = draftState();
    await refreshLiveCandidates();
    return;
  }
  optionsLoading.value = true;
  optionsError.value = null;
  try {
    const options = await fixtureAdapter.loadTaskOptions(mode.value);
    projects.value = options.projects;
    candidates.value = options.candidates;
    if (projectId.value === "" && routeProjectId() !== "" && options.projects.some((project) => project.id === routeProjectId())) {
      projectId.value = routeProjectId();
    }
    savedDraft.value = draftState();
  } catch (caught) {
    optionsError.value = caught instanceof Error ? caught.message.trim() : "读取示例项目时发生未知错误。";
  } finally {
    optionsLoading.value = false;
  }
}

/**
 * live：依赖候选来自 GET /tasks?project_id=。
 * 失败时给出可读提示并允许不选依赖继续创建，不把 fixture 候选混进来。
 */
async function refreshLiveCandidates(): Promise<void> {
  if (!live.value) {
    return;
  }
  const token = ++candidatesVersion;
  const client = liveClient();
  const id = projectId.value.trim();
  liveCandidates.value = [];
  if (client === null) {
    optionsError.value = "连接已断开：无法读取该项目的依赖候选。";
    return;
  }
  if (id === "") {
    optionsError.value = null;
    return;
  }
  optionsLoading.value = true;
  try {
    const tasks = await client.getProjectTasks(id);
    if (token !== candidatesVersion || disposed) {
      return;
    }
    liveCandidates.value = tasks.map((task) => ({ id: task.id, title: task.title, status: task.status }));
    optionsError.value = null;
  } catch (caught) {
    if (token !== candidatesVersion || disposed) {
      return;
    }
    liveCandidates.value = [];
    optionsError.value = `无法读取该项目的依赖候选：${describeLiveError(caught).message}。可以不选依赖继续创建。`;
  } finally {
    if (token === candidatesVersion && !disposed) {
      optionsLoading.value = false;
    }
  }
}

onMounted(loadOptions);
setDraftGuard(draftGuard);
onMounted(() => window.addEventListener("beforeunload", warnBeforeUnload));
onBeforeUnmount(() => {
  disposed = true;
  candidatesVersion += 1;
  clearDraftGuard(draftGuard);
  window.removeEventListener("beforeunload", warnBeforeUnload);
});

watch(projectId, () => {
  // live 的依赖候选按项目重新加载，切换项目必须清掉上一个项目的依赖选择。
  if (live.value) {
    dependencyId.value = "";
    return;
  }
  if (dependencyId.value !== "" && !dependencyOptions.value.some((task) => task.id === dependencyId.value)) {
    dependencyId.value = "";
  }
});

watch(
  () => route.query.project,
  () => {
    if (createdTaskId.value === null && projectId.value === "") {
      projectId.value = routeProjectId();
      if (live.value) {
        void refreshLiveCandidates();
      }
    }
  }
);

function validate(): boolean {
  const errors: typeof fieldErrors.value = {};
  if (title.value.trim() === "") {
    errors.title = "请填写任务名称，用简洁明确的语言描述要完成的工作。";
  }
  if (expectedResult.value.trim() === "") {
    errors.expectedResult = "请说明任务完成后应得到的具体成果或交付物。";
  }
  if (acceptanceCriteria.value.split("\n").map((line) => line.trim()).filter(Boolean).length === 0) {
    errors.acceptanceCriteria = "请至少写一条可判断的验收标准；空标准不能作为完成依据。";
  }
  fieldErrors.value = errors;
  return Object.keys(errors).length === 0;
}

async function submit(intent: "ready" | "inbox"): Promise<void> {
  if (submitting.value || createdTaskId.value !== null) {
    return;
  }
  if (submittedIntent.value !== null && submittedIntent.value !== intent) {
    actionError.value = { kind: "conflict", message: "这次创建已经使用另一种保存意图提交；请先查询原 command ID 的回执。" };
    return;
  }
  // 上一步结果未确定时先查回执，不允许用新的 command ID 盲目重试。
  if (live.value && pendingStep !== null) {
    actionError.value = {
      kind: "conflict",
      message: "上一次请求的结果尚未确定：请先查询本次回执，不要用新的 command ID 重复创建任务。"
    };
    return;
  }
  actionError.value = null;
  readyBlockedReason.value = null;
  if (intent === "ready") {
    if (!validate()) {
      return;
    }
  } else {
    const errors: typeof fieldErrors.value = {};
    if (title.value.trim() === "") {
      errors.title = "暂存也需要一个任务名称，便于之后重新整理。";
    }
    // live 契约要求 objective 非空，因此暂存也必须填写预期结果。
    if (live.value && expectedResult.value.trim() === "") {
      errors.expectedResult = "真实契约要求预期结果（objective）非空，暂存也需要填写。";
    }
    if (Object.keys(errors).length > 0) {
      fieldErrors.value = errors;
      return;
    }
  }
  submitting.value = true;
  submittedIntent.value = intent;
  try {
    if (live.value) {
      await submitLive(intent);
      return;
    }
    const draft: CreateTaskDraft = {
      title: title.value,
      projectId: projectId.value === "" ? null : projectId.value,
      expectedResult: expectedResult.value,
      acceptanceCriteria: acceptanceCriteria.value,
      startIntent: startIntent.value,
      dependencyId: dependencyId.value === "" ? null : dependencyId.value
    };
    commandId.value ??= fixtureAdapter.createCommandId("task");
    const result = await fixtureAdapter.createTask(draft, mode.value, intent, commandId.value);
    receipt.value = result.receipt.description;
    readyBlockedReason.value = result.readyBlockedReason;
    fieldErrors.value = {};
    createdTaskId.value = result.taskId;
    savedDraft.value = draftState();
  } catch (caught) {
    if (live.value) {
      handleLiveFailure(caught);
    } else {
      actionError.value = toActionError(caught, "创建示例任务时发生未知错误。");
    }
  } finally {
    submitting.value = false;
  }
}

/**
 * live 提交：每一步用各自的 command ID，步骤之间用上一步返回的 revision 作为 expected_revision。
 *  1. CreateTask（objective 取“预期结果”；expected_outputs 不发送，契约允许缺省）
 *  2. AddTaskDependency（可选）
 *  3. MarkTaskReady（仅“保存任务”意图）
 */
async function submitLive(intent: "ready" | "inbox"): Promise<void> {
  const client = liveClient();
  if (client === null) {
    actionError.value = { kind: "unknown", message: "连接已断开：请重新连接本机 API 后再创建任务。" };
    return;
  }

  const criteria = acceptanceCriteria.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const projectIdValue = projectId.value.trim();
  const liveMode: InteractionMode = startIntent.value === "AI_ASSIST" ? "AI_ASSIST" : "ME";

  const createCommand = createCommandId();
  pendingStep = { step: "create", commandId: createCommand };
  const created = await client.createTask({
    commandId: createCommand,
    projectId: projectIdValue === "" ? null : projectIdValue,
    title: title.value.trim(),
    objective: expectedResult.value.trim(),
    mode: liveMode,
    criteria
  });
  if (disposed) {
    return;
  }
  pendingStep = null;
  liveCreate.value = created;
  createdTaskId.value = created.taskId;
  savedDraft.value = draftState();

  let status: TaskStatus = created.status;
  let revision = created.revision;
  const notes: string[] = [
    `已创建任务 ${created.taskId}：状态${taskStatusLabels[created.status]}，任务修订 v${created.revision}，验收版本 v${created.acceptanceRevision}`
  ];

  if (dependencyId.value !== "") {
    const dependencyCommand = createCommandId();
    pendingStep = { step: "dependency", commandId: dependencyCommand };
    const dependency = await client.addTaskDependency({
      taskId: created.taskId,
      commandId: dependencyCommand,
      expectedRevision: revision,
      dependsOnTaskId: dependencyId.value,
      dependencyKind: "BLOCKS"
    });
    if (disposed) {
      return;
    }
    pendingStep = null;
    status = dependency.status;
    revision = dependency.revision;
    notes.push(`已登记前置依赖，任务修订 v${dependency.revision}`);
  }

  if (intent === "ready") {
    const readyCommand = createCommandId();
    pendingStep = { step: "ready", commandId: readyCommand };
    const ready = await client.markTaskReady({
      taskId: created.taskId,
      commandId: readyCommand,
      expectedRevision: revision
    });
    if (disposed) {
      return;
    }
    pendingStep = null;
    status = ready.status;
    revision = ready.revision;
    notes.push(`已标记为${taskStatusLabels[ready.status]}，任务修订 v${ready.revision}`);
  } else {
    notes.push("按你的选择暂存为待整理，未尝试转为可开始");
  }

  liveCreate.value = { ...created, status, revision };
  receipt.value = `${notes.join("；")}。尚未开始执行；开始不等于完成。`;
}

function stepLabel(step: LiveStep | null): string {
  if (step === "create") {
    return "创建任务";
  }
  if (step === "dependency") {
    return "登记依赖";
  }
  if (step === "ready") {
    return "标记可开始";
  }
  return "本次请求";
}

/** live 明确失败：停止后续步骤，说明哪一步失败并保留已创建的任务。 */
function handleLiveFailure(caught: unknown): void {
  const described = describeLiveError(caught);
  const step = pendingStep?.step ?? null;
  const label = stepLabel(step);

  if (described.kind === "transport") {
    // 传输错误：保留该步 command ID 供查询回执，绝不换 ID 盲目重试。
    actionError.value = {
      kind: "transport",
      message: `${label}请求没有得到服务端响应，这一步是否已提交尚未确定。请用同一个 command ID 查询回执，不要换 ID 重新提交。`
    };
    return;
  }

  // 服务端已明确拒绝这一步：可以丢弃该步 command ID。
  pendingStep = null;
  if (createdTaskId.value !== null && step === "ready") {
    actionError.value = {
      kind: described.kind,
      message: `任务已创建（${createdTaskId.value}），但标记可开始失败：${described.message}任务仍保留为待整理，没有被重复创建。`
    };
    return;
  }
  if (createdTaskId.value !== null && step === "dependency") {
    actionError.value = {
      kind: described.kind,
      message: `任务已创建（${createdTaskId.value}），但登记依赖失败：${described.message}任务已保留，可稍后单独处理依赖。`
    };
    return;
  }
  actionError.value = { kind: described.kind, message: `${label}失败：${described.message}` };
}

async function lookupReceipt(): Promise<void> {
  if (live.value) {
    await lookupLiveReceipt();
    return;
  }
  if (submitting.value || !commandId.value) {
    return;
  }
  submitting.value = true;
  actionError.value = null;
  try {
    const result = await fixtureAdapter.lookupReceipt(commandId.value);
    if (result.status === "APPLIED" && result.operation === "task" && result.receipt && result.resourceId && result.taskStatus) {
      receipt.value = result.receipt.description;
      readyBlockedReason.value = result.readyBlockedReason ?? null;
      createdTaskId.value = result.resourceId;
      savedDraft.value = draftState();
      return;
    }
    actionError.value = {
      kind: result.status === "UNKNOWN" ? "timeout" : "not-submitted",
      message:
        result.status === "UNKNOWN"
          ? "本次提交仍未确认；请继续使用同一 command ID 查询回执，不能直接创建第二个任务。"
          : "未找到这次提交的回执；尚未创建任务，可以使用同一 command ID 再次提交。"
    };
  } finally {
    submitting.value = false;
  }
}

/** 传输错误后按该步的 command ID 查询回执，用 command_type 区分是哪一步已提交。 */
async function lookupLiveReceipt(): Promise<void> {
  const client = liveClient();
  const pending = pendingStep;
  if (client === null || pending === null || submitting.value) {
    return;
  }
  submitting.value = true;
  actionError.value = null;
  try {
    const receiptBody = await client.getCommandReceipt(pending.commandId);
    if (disposed) {
      return;
    }
    if (pending.step === "create" && receiptBody.commandType === "CreateTask") {
      const creation = taskCreationFrom(receiptBody.result);
      pendingStep = null;
      liveCreate.value = creation;
      createdTaskId.value = creation.taskId;
      savedDraft.value = draftState();
      receipt.value = `回执确认已创建任务 ${creation.taskId}：状态${taskStatusLabels[creation.status]}，任务修订 v${creation.revision}，验收版本 v${creation.acceptanceRevision}。尚未开始执行；开始不等于完成。`;
      return;
    }
    if (pending.step === "dependency" && receiptBody.commandType === "AddTaskDependency") {
      const mutation = taskMutationFrom(receiptBody.result);
      pendingStep = null;
      applyLiveMutation(mutation.status, mutation.revision);
      receipt.value = `回执确认已登记前置依赖：任务 ${mutation.taskId}，任务修订 v${mutation.revision}。`;
      return;
    }
    if (pending.step === "ready" && receiptBody.commandType === "MarkTaskReady") {
      const mutation = taskMutationFrom(receiptBody.result);
      pendingStep = null;
      applyLiveMutation(mutation.status, mutation.revision);
      receipt.value = `回执确认已标记为${taskStatusLabels[mutation.status]}：任务 ${mutation.taskId}，任务修订 v${mutation.revision}。尚未开始执行；开始不等于完成。`;
      return;
    }
    actionError.value = {
      kind: "unknown",
      message: `回执的命令类型是 ${receiptBody.commandType}，与本次步骤不匹配；请核对 command ID。`
    };
  } catch (caught) {
    if (disposed) {
      return;
    }
    if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
      // 回执不存在说明该步尚未提交：解除阻塞，允许重新提交。
      pendingStep = null;
      actionError.value = {
        kind: "not-submitted",
        message: "没有找到这次提交的回执：该步骤尚未提交，可以重新提交。"
      };
      return;
    }
    const described = describeLiveError(caught);
    actionError.value = { kind: described.kind, message: described.message };
  } finally {
    if (!disposed) {
      submitting.value = false;
    }
  }
}

function applyLiveMutation(status: TaskStatus, revision: string): void {
  if (liveCreate.value !== null) {
    liveCreate.value = { ...liveCreate.value, status, revision };
  }
}
</script>

<template>
  <div class="page-layout">
    <div class="page-primary">
      <p class="eyebrow">新建任务与执行准备</p>
      <p class="page-lede">清晰定义任务目标、预期结果与验收标准，为后续执行做好准备。</p>
      <h1>把想做的事，变成可完成的任务</h1>

      <form v-if="createdTaskId === null" class="create-form" novalidate @submit.prevent="submit('ready')">
        <label class="field" :class="{ 'field--invalid': fieldErrors.title }">
          <span class="field-label">任务名称<span class="field-required" aria-hidden="true">*</span></span>
          <input
            v-model="title"
            name="task-title"
            required
            :aria-invalid="fieldErrors.title ? 'true' : undefined"
            :aria-describedby="fieldErrors.title ? 'task-title-error' : 'task-title-hint'"
            @input="fieldErrors.title = undefined"
          />
          <span v-if="fieldErrors.title" id="task-title-error" class="field-error" role="alert">
            <Info aria-hidden="true" />{{ fieldErrors.title }}
          </span>
          <span v-else id="task-title-hint" class="field-hint">用简洁明确的语言描述这项任务要完成的工作。</span>
        </label>

        <label v-if="live" class="field">
          <span class="field-label">所属项目（可选）</span>
          <input
            v-model="projectId"
            name="task-project-id"
            autocomplete="off"
            placeholder="Project UUID，留空表示未归属项目"
            @change="refreshLiveCandidates"
          />
          <span class="field-hint">
            真实 API 没有项目列表端点，这里填写项目 ID（来自创建回执或路由 query）。留空表示未归属项目（Me Inbox），
            未归属任务只能登记人工事项，依赖候选也需要项目 ID。
          </span>
        </label>
        <label v-else class="field">
          <span class="field-label">所属项目（可选）</span>
          <select v-model="projectId" name="task-project" :disabled="optionsLoading">
            <option value="">未归属项目</option>
            <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.title }}</option>
          </select>
          <span class="field-hint">
            选择任务所属的项目，或暂不归属。未归属项目的任务只允许人工事项，不会自动创建项目。
          </span>
        </label>

        <label class="field" :class="{ 'field--invalid': fieldErrors.expectedResult }">
          <span class="field-label">预期结果<span class="field-required" aria-hidden="true">*</span></span>
          <input
            v-model="expectedResult"
            name="task-expected-result"
            required
            :aria-invalid="fieldErrors.expectedResult ? 'true' : undefined"
            :aria-describedby="fieldErrors.expectedResult ? 'task-result-error' : 'task-result-hint'"
            @input="fieldErrors.expectedResult = undefined"
          />
          <span v-if="fieldErrors.expectedResult" id="task-result-error" class="field-error" role="alert">
            <Info aria-hidden="true" />{{ fieldErrors.expectedResult }}
          </span>
          <span v-else id="task-result-hint" class="field-hint">说明这项任务完成后应得到的具体成果或交付物。</span>
        </label>

        <label class="field" :class="{ 'field--invalid': fieldErrors.acceptanceCriteria }">
          <span class="field-label">验收标准<span class="field-required" aria-hidden="true">*</span></span>
          <textarea
            v-model="acceptanceCriteria"
            name="task-acceptance"
            rows="4"
            required
            :maxlength="criteriaLimit"
            :aria-invalid="fieldErrors.acceptanceCriteria ? 'true' : undefined"
            :aria-describedby="fieldErrors.acceptanceCriteria ? 'task-acceptance-error' : 'task-acceptance-hint'"
            @input="fieldErrors.acceptanceCriteria = undefined"
          ></textarea>
          <span v-if="fieldErrors.acceptanceCriteria" id="task-acceptance-error" class="field-error" role="alert">
            <Info aria-hidden="true" />{{ fieldErrors.acceptanceCriteria }}
          </span>
          <span v-else id="task-acceptance-hint" class="field-hint">
            每行一条，写下明确、可判断的验收条件；检查通过不等于任务完成。
          </span>
          <span class="field-counter">{{ acceptanceCount }} / {{ criteriaLimit }}</span>
        </label>

        <fieldset class="field">
          <legend class="field-label">开始方式<span class="field-required" aria-hidden="true">*</span></legend>
          <div class="choice-list">
            <label v-for="intent in startIntents" :key="intent.value" class="choice-option">
              <input
                v-model="startIntent"
                type="radio"
                name="task-intent"
                :value="intent.value"
                :disabled="live && intent.value === 'DELEGATE_AI'"
              />
              <span>
                {{ interactionModeLabels[intent.value] }}
                <small>{{ intent.hint }}</small>
              </span>
            </label>
          </div>
          <span v-if="live" class="field-hint">
            live 模式下只支持人工执行与 AI 辅助；AI 委托会返回 CAPABILITY_DISABLED，Delegate 未开放。
          </span>
          <span v-else class="field-hint">委托将在任务就绪后单独确认范围；这里只记录你的意图，不会直接设置执行者。</span>
        </fieldset>

        <label class="field">
          <span class="field-label">依赖任务（可选）</span>
          <select v-model="dependencyId" name="task-dependency" :disabled="optionsLoading || dependencyOptions.length === 0">
            <option value="">无</option>
            <option v-for="task in dependencyOptions" :key="task.id" :value="task.id">
              {{ task.title }}（{{ taskStatusLabels[task.status] }}）
            </option>
          </select>
          <span v-if="live" class="field-hint">
            {{
              projectId.trim() === ""
                ? "live 模式下依赖候选来自真实项目任务：请先填写项目 ID。"
                : dependencyOptions.length === 0
                  ? "该项目暂时没有可选的前置任务，可以不选依赖继续创建。"
                  : "依赖候选来自 GET /tasks?project_id=，只包含该项目的真实任务。"
            }}
          </span>
          <span v-else class="field-hint">
            {{
              dependencyOptions.length === 0
                ? "当前项目范围内没有可选的前置任务。"
                : "如需先完成其他任务，请选择依赖的任务；依赖未完成时不能转为可开始。"
            }}
          </span>
        </label>

        <div class="form-actions">
          <button class="primary-button" type="submit" data-testid="task-create-save" :disabled="submitting">
            {{ submitting ? "正在保存" : "保存任务" }}
          </button>
          <button
            class="secondary-button"
            type="button"
            data-testid="task-create-inbox"
            :disabled="submitting"
            @click="submit('inbox')"
          >
            暂存待整理
          </button>
          <button class="text-button" type="button" :disabled="submitting" @click="emit('cancel')">返回列表</button>
        </div>

        <p v-if="receipt" class="receipt-message" role="status">{{ receipt }}</p>
        <p v-if="readyBlockedReason" class="warning-callout" role="status" data-testid="task-ready-blocked">
          <Info aria-hidden="true" />{{ readyBlockedReason }}
        </p>
        <p v-if="actionError" class="action-error" role="alert">{{ actionError.message }}</p>
        <button
          v-if="actionError?.kind === 'timeout' || actionError?.kind === 'transport'"
          class="secondary-button"
          type="button"
          data-testid="task-create-receipt"
          :disabled="submitting"
          @click="lookupReceipt"
        >
          查询本次回执
        </button>
        <p v-if="actionError?.kind === 'timeout'" class="helper-text">提交结果暂不明确时先查回执，不要直接重复创建。</p>
        <p v-if="actionError?.kind === 'transport'" class="helper-text">这一步结果不确定时先查回执，不要换 command ID 重新提交。</p>
        <p v-if="actionError?.kind === 'conflict'" class="helper-text">冲突时草稿仍然保留，修改后可以重新提交。</p>
        <p v-if="optionsError" class="helper-text">{{ optionsError }}</p>
      </form>
      <section
        v-else-if="live"
        class="surface-panel"
        aria-label="任务创建结果"
        data-testid="task-created-result"
      >
        <p class="eyebrow">已完成本次创建</p>
        <h2>任务已创建</h2>
        <dl class="rail-definition-list">
          <div>
            <dt>任务 ID</dt>
            <dd>{{ createdTaskId }}</dd>
          </div>
          <template v-if="liveCreate">
            <div>
              <dt>状态</dt>
              <dd>{{ taskStatusLabels[liveCreate.status] }}</dd>
            </div>
            <div>
              <dt>任务修订</dt>
              <dd>v{{ liveCreate.revision }}</dd>
            </div>
            <div>
              <dt>验收版本</dt>
              <dd>v{{ liveCreate.acceptanceRevision }}</dd>
            </div>
          </template>
        </dl>
        <p v-if="receipt" class="receipt-message" role="status">{{ receipt }}</p>
        <p v-if="actionError" class="action-error" role="alert">{{ actionError.message }}</p>
        <button
          v-if="actionError?.kind === 'transport'"
          class="secondary-button secondary-button--wide"
          type="button"
          data-testid="task-create-receipt"
          :disabled="submitting"
          @click="lookupReceipt"
        >
          查询本次回执
        </button>
        <p v-if="actionError?.kind === 'transport'" class="helper-text">
          这一步结果不确定时先查回执，不要换 command ID 重新提交。
        </p>
        <p class="helper-text">任务已写入真实 PostgreSQL；开始不等于完成，创建后不会自动开始执行。</p>
        <div class="form-actions">
          <button class="primary-button" type="button" @click="emit('cancel')">返回任务入口</button>
          <button class="secondary-button" type="button" data-testid="task-create-another" @click="resetDraft">新建另一项任务</button>
        </div>
      </section>
      <section v-else class="surface-panel" aria-label="任务创建结果" data-testid="task-created-result">
        <p class="eyebrow">已完成本次创建</p>
        <h2>任务已创建，等待后续处理</h2>
        <p>示例任务 ID：{{ createdTaskId }}。同一创建意图已关闭，不能再次保存而产生重复任务。</p>
        <p v-if="receipt" class="receipt-message" role="status">{{ receipt }}</p>
        <p v-if="readyBlockedReason" class="warning-callout" role="status" data-testid="task-ready-blocked">
          <Info aria-hidden="true" />{{ readyBlockedReason }}
        </p>
        <div class="form-actions">
          <button class="primary-button" type="button" @click="emit('cancel')">查看任务列表</button>
          <button class="secondary-button" type="button" data-testid="task-create-another" @click="resetDraft">新建另一项任务</button>
        </div>
      </section>
    </div>

    <ResponsiveRail label="查看完成标准说明" title="完成标准要可判断">
      <div class="rail-content">
        <h2>完成标准要可判断</h2>
        <p class="rail-intro">三条明确的验收标准，比一句“写得更好”更有用。</p>

        <section class="rail-section">
          <h3>好的验收标准通常具备</h3>
          <div class="suggestion-row">
            <Check aria-hidden="true" />
            <span class="suggestion-copy">
              <strong>具体明确</strong>
              <small>说明要达到什么结果，而不是模糊的描述。</small>
            </span>
          </div>
          <div class="suggestion-row">
            <Check aria-hidden="true" />
            <span class="suggestion-copy">
              <strong>可验证</strong>
              <small>有客观的判断依据或检验方法。</small>
            </span>
          </div>
          <div class="suggestion-row">
            <Check aria-hidden="true" />
            <span class="suggestion-copy">
              <strong>可追溯</strong>
              <small>成果能关联到相应的过程与原始记录。</small>
            </span>
          </div>
        </section>

        <section class="rail-section">
          <h3>示例</h3>
          <div class="summary-card summary-card--source-list">
            <p>指标计算方式明确</p>
            <p>基线步骤可复现</p>
            <p>结果可追溯到原始记录</p>
          </div>
          <p class="helper-text">示例只说明写法，不构成这个任务的必需条件，也不限制条件数量。</p>
        </section>

        <section class="rail-section">
          <h3>保存后的状态</h3>
          <p>
            任务会先保存为“待整理”，由我执行。选择“保存任务”后，系统会核对目标、验收条件与前置依赖；
            条件满足时才会显示为“可开始”，且不会自动开始执行。
          </p>
          <p v-if="props.inboxScope" class="helper-text">
            当前从收件箱范围进入：默认不归属项目，任务会出现在收件箱列表中。
          </p>
        </section>
      </div>
    </ResponsiveRail>
  </div>
</template>
