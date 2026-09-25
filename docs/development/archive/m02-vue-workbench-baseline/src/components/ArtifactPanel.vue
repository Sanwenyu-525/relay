<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Check, FileText, Info, RotateCcw, Save } from "lucide-vue-next";
import SafeMarkdown from "./SafeMarkdown.vue";
import {
  artifactVersionResultFrom,
  completionFrom,
  createCommandId,
  reopenFrom,
  stateMutationFrom,
  type RelayAcceptanceCriterion,
  type RelayArtifactVersionResult,
  type RelayProjectState
} from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { taskStatusLabels } from "../lib/labels";
import { describeLiveError, type LiveActionError } from "../lib/liveErrors";
import { liveClient } from "../lib/relayConnection";
import {
  latestSessionVersion,
  rememberArtifactVersion,
  sessionVersionsFor,
  type SessionArtifactVersion
} from "../lib/sessionArtifacts";
import type { DecimalRevision, TaskStatus } from "../types";

const props = defineProps<{
  taskId: string;
  projectId: string | null;
  taskStatus: TaskStatus;
  taskRevision: DecimalRevision;
  acceptanceRevision: DecimalRevision;
  criteria: readonly RelayAcceptanceCriterion[];
  /** null 表示 fixture 模式（示例数据没有产物事实）。 */
  allowedActions: readonly string[] | null;
}>();

const emit = defineEmits<{ refresh: [] }>();

const MEDIA_TYPE = "text/markdown";
const CONTENT_LIMIT_BYTES = 256 * 1024;

const title = ref("任务产物");
const content = ref("");
const previewing = ref(false);
const saving = ref(false);
const saveReceipt = ref<string | null>(null);
const saveFailure = ref<LiveActionError | null>(null);
const selectedVersionId = ref<string | null>(null);
const state = ref<RelayProjectState | null>(null);
const stateFailure = ref<string | null>(null);
const selecting = ref(false);
const selectReceipt = ref<string | null>(null);
const selectFailure = ref<LiveActionError | null>(null);
const acceptanceStatement = ref("按当前验收标准完成，并接受所选产物版本。");
const acceptanceReason = ref("");
const acceptedCriterionIds = ref<string[]>([]);
const completing = ref(false);
const completionReceipt = ref<string | null>(null);
const completionFailure = ref<LiveActionError | null>(null);
const reopenReason = ref("");
const reopening = ref(false);
const reopenReceipt = ref<string | null>(null);
const reopenFailure = ref<LiveActionError | null>(null);
const disposed = ref(false);
/** 结果未确定前沿用同一个 command ID；重新编辑后换新 ID。 */
let saveCommandId: string | null = null;
let savedContentSnapshot = "";
let selectCommandId: string | null = null;
let completeCommandId: string | null = null;
let reopenCommandId: string | null = null;

const live = computed(() => props.allowedActions !== null);
const versions = computed(() => sessionVersionsFor(props.taskId));
const latest = computed(() => latestSessionVersion(props.taskId));
const selectedVersion = computed<SessionArtifactVersion | null>(
  () => versions.value.find((version) => version.versionId === selectedVersionId.value) ?? null
);
const selectedByProject = computed(
  () => state.value?.selectedArtifactVersionRefs ?? []
);
const contentBytes = computed(() => utf8ByteLength(content.value));
const contentTooLarge = computed(() => contentBytes.value > CONTENT_LIMIT_BYTES);
const canSave = computed(
  () => live.value && props.allowedActions?.includes("SAVE_ARTIFACT_VERSION") === true && content.value.trim() !== "" && !contentTooLarge.value && !saving.value
);
const canComplete = computed(
  () =>
    live.value &&
    props.allowedActions?.includes("COMPLETE") === true &&
    requiredCriteria.value.every((criterion) => acceptedCriterionIds.value.includes(criterion.criterionId)) &&
    acceptanceStatement.value.trim() !== "" &&
    !completing.value
);
const canReopen = computed(
  () => live.value && props.allowedActions?.includes("REOPEN") === true && reopenReason.value.trim() !== "" && !reopening.value
);
const requiredCriteria = computed(() => props.criteria.filter((criterion) => criterion.required));
const done = computed(() => props.taskStatus === "DONE");

const draftGuard: DraftGuard = {
  hasUnsavedChanges: () => content.value !== savedContentSnapshot,
  discard: () => {
    content.value = savedContentSnapshot;
  }
};

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

onMounted(() => {
  setDraftGuard(draftGuard);
  void loadState();
});
onBeforeUnmount(() => {
  disposed.value = true;
  clearDraftGuard(draftGuard);
});

// 重新编辑内容后必须换新的 command ID，否则同 ID 异内容会被判为 COMMAND_ID_REUSED。
watch(content, () => {
  if (content.value !== savedContentSnapshot) {
    saveCommandId = null;
  }
});

// 默认选中本次会话保存的最新版本，作为“要接受的版本”。
watch(
  latest,
  (version) => {
    if (version !== null && selectedVersionId.value === null) {
      selectedVersionId.value = version.versionId;
    }
  },
  { immediate: true }
);

async function loadState(): Promise<void> {
  const client = liveClient();
  if (client === null || props.projectId === null) {
    state.value = null;
    return;
  }
  try {
    const loaded = await client.getProjectState(props.projectId);
    if (!disposed.value) {
      state.value = loaded;
      stateFailure.value = null;
    }
  } catch (caught) {
    if (!disposed.value) {
      stateFailure.value = describeLiveError(caught).message;
    }
  }
}

function remember(result: RelayArtifactVersionResult): void {
  rememberArtifactVersion(props.taskId, {
    artifactId: result.artifactId,
    artifactRevision: result.artifactRevision,
    versionId: result.versionId,
    versionNumber: result.versionNumber,
    title: title.value.trim(),
    sha256: result.sha256,
    size: result.size,
    savedAt: new Date().toISOString()
  });
  savedContentSnapshot = content.value;
  selectedVersionId.value = result.versionId;
}

/** 服务端没有“列出 Task 产物”的端点：只有本会话已知产物时才续写版本，否则新建产物。 */
async function saveVersion(): Promise<void> {
  const client = liveClient();
  if (client === null || !canSave.value) {
    return;
  }
  saving.value = true;
  saveFailure.value = null;
  saveReceipt.value = null;
  try {
    const known = latest.value;
    saveCommandId ??= createCommandId();
    const result =
      known === null
        ? await client.createArtifactWithVersion({
            taskId: props.taskId,
            commandId: saveCommandId,
            expectedTaskRevision: props.taskRevision,
            title: title.value.trim(),
            mediaType: MEDIA_TYPE,
            content: content.value
          })
        : await client.submitArtifactVersion({
            artifactId: known.artifactId,
            commandId: saveCommandId,
            expectedArtifactRevision: known.artifactRevision,
            expectedTaskRevision: props.taskRevision,
            mediaType: MEDIA_TYPE,
            content: content.value
          });
    if (disposed.value) {
      return;
    }
    saveCommandId = null;
    remember(result);
    saveReceipt.value =
      known === null
        ? `已创建产物并保存 v${result.versionNumber}（sha256 ${result.sha256.slice(0, 12)}…，${result.size} 字节）。旧版本不会被覆盖。`
        : `已保存新版本 v${result.versionNumber}（sha256 ${result.sha256.slice(0, 12)}…，${result.size} 字节）。上一版本保持不变。`;
    emit("refresh");
  } catch (caught) {
    if (disposed.value) {
      return;
    }
    const described = describeLiveError(caught);
    saveFailure.value = described;
    if (described.kind !== "transport") {
      saveCommandId = null;
    }
  } finally {
    if (!disposed.value) {
      saving.value = false;
    }
  }
}

/** 传输错误后按同一 command ID 查回执：已提交就记住版本，未提交才允许重试。 */
async function lookupSaveReceipt(): Promise<void> {
  const client = liveClient();
  const commandId = saveCommandId;
  if (client === null || commandId === null || saving.value) {
    return;
  }
  saving.value = true;
  saveFailure.value = null;
  try {
    const receipt = await client.getCommandReceipt(commandId);
    if (disposed.value) {
      return;
    }
    if (receipt.commandType !== "CreateArtifactWithVersion" && receipt.commandType !== "SubmitHumanArtifactVersion") {
      saveFailure.value = {
        kind: "unknown",
        message: `回执的命令类型是 ${receipt.commandType}，不是本次保存；请核对 command ID。`,
        fieldErrors: []
      };
      return;
    }
    const result = artifactVersionResultFrom(receipt.result);
    saveCommandId = null;
    remember(result);
    saveReceipt.value = `回执确认已提交：产物版本 v${result.versionNumber}（sha256 ${result.sha256.slice(0, 12)}…）。`;
    emit("refresh");
  } catch (caught) {
    if (!disposed.value) {
      saveFailure.value = describeLiveError(caught);
    }
  } finally {
    if (!disposed.value) {
      saving.value = false;
    }
  }
}

async function selectVersion(): Promise<void> {
  const client = liveClient();
  const version = selectedVersion.value;
  const projectId = props.projectId;
  if (client === null || version === null || projectId === null || state.value === null || selecting.value) {
    return;
  }
  selecting.value = true;
  selectFailure.value = null;
  selectReceipt.value = null;
  try {
    selectCommandId ??= createCommandId();
    const result = await client.selectArtifactVersion({
      projectId,
      commandId: selectCommandId,
      expectedRevision: state.value.revision,
      artifactVersionId: version.versionId,
      // 选择依据的来源引用：这是人在工作台里的选择，不是模型提案。
      sourceRef: `human:workbench:task/${props.taskId}`
    });
    if (disposed.value) {
      return;
    }
    selectCommandId = null;
    selectReceipt.value = `项目 State 已选用 v${version.versionNumber}（State revision v${result.revision}）。这是“当前选用”，与“本轮接受”不同。`;
    await loadState();
  } catch (caught) {
    if (disposed.value) {
      return;
    }
    const described = describeLiveError(caught);
    selectFailure.value = described;
    if (described.kind !== "transport") {
      selectCommandId = null;
    }
  } finally {
    if (!disposed.value) {
      selecting.value = false;
    }
  }
}

/** 选择版本与重开的传输错误也要先查回执，不能换 command ID 盲重试。 */
async function lookupSelectReceipt(): Promise<void> {
  const client = liveClient();
  const commandId = selectCommandId;
  if (client === null || commandId === null || selecting.value) {
    return;
  }
  selecting.value = true;
  selectFailure.value = null;
  try {
    const receipt = await client.getCommandReceipt(commandId);
    if (disposed.value) {
      return;
    }
    if (receipt.commandType !== "SetProjectState") {
      selectFailure.value = {
        kind: "unknown",
        message: `回执的命令类型是 ${receipt.commandType}，不是本次选择；请核对 command ID。`,
        fieldErrors: []
      };
      return;
    }
    const result = stateMutationFrom(receipt.result);
    selectCommandId = null;
    selectReceipt.value = `回执确认已提交：项目 State 已选用该版本（State revision v${result.revision}）。`;
    await loadState();
  } catch (caught) {
    if (!disposed.value) {
      selectFailure.value = describeLiveError(caught);
    }
  } finally {
    if (!disposed.value) {
      selecting.value = false;
    }
  }
}

async function lookupReopenReceipt(): Promise<void> {
  const client = liveClient();
  const commandId = reopenCommandId;
  if (client === null || commandId === null || reopening.value) {
    return;
  }
  reopening.value = true;
  reopenFailure.value = null;
  try {
    const receipt = await client.getCommandReceipt(commandId);
    if (disposed.value) {
      return;
    }
    if (receipt.commandType !== "ReopenTask") {
      reopenFailure.value = {
        kind: "unknown",
        message: `回执的命令类型是 ${receipt.commandType}，不是本次重开；请核对 command ID。`,
        fieldErrors: []
      };
      return;
    }
    const result = reopenFrom(receipt.result);
    reopenCommandId = null;
    reopenReceipt.value = `回执确认已重开：回到${result.status}，新验收版本 v${result.acceptanceRevision}。`;
    emit("refresh");
  } catch (caught) {
    if (!disposed.value) {
      reopenFailure.value = describeLiveError(caught);
    }
  } finally {
    if (!disposed.value) {
      reopening.value = false;
    }
  }
}

function toggleCriterion(criterionId: string, checked: boolean): void {
  acceptedCriterionIds.value = checked
    ? [...acceptedCriterionIds.value, criterionId]
    : acceptedCriterionIds.value.filter((id) => id !== criterionId);
}

async function completeTask(): Promise<void> {
  const client = liveClient();
  if (client === null || !canComplete.value) {
    return;
  }
  completing.value = true;
  completionFailure.value = null;
  completionReceipt.value = null;
  try {
    completeCommandId ??= createCommandId();
    const result = await client.completeHumanTask({
      taskId: props.taskId,
      commandId: completeCommandId,
      expectedRevision: props.taskRevision,
      acceptanceRevision: props.acceptanceRevision,
      artifactVersionIds: selectedVersion.value === null ? [] : [selectedVersion.value.versionId],
      statement: acceptanceStatement.value.trim(),
      acceptedCriterionIds: acceptedCriterionIds.value,
      reason: acceptanceReason.value.trim() === "" ? null : acceptanceReason.value.trim()
    });
    if (disposed.value) {
      return;
    }
    completeCommandId = null;
    completionReceipt.value = `已完成本轮：完成凭据 ${result.completionId}，任务修订 v${result.revision}，验收版本 v${result.acceptanceRevision}${
      result.stateRevision === null ? "" : `，项目 State 修订 v${result.stateRevision}`
    }。历史凭据保留；再次编辑需要重开。`;
    emit("refresh");
  } catch (caught) {
    if (disposed.value) {
      return;
    }
    const described = describeLiveError(caught);
    completionFailure.value = described;
    if (described.kind !== "transport") {
      completeCommandId = null;
    }
  } finally {
    if (!disposed.value) {
      completing.value = false;
    }
  }
}

async function lookupCompleteReceipt(): Promise<void> {
  const client = liveClient();
  const commandId = completeCommandId;
  if (client === null || commandId === null || completing.value) {
    return;
  }
  completing.value = true;
  completionFailure.value = null;
  try {
    const receipt = await client.getCommandReceipt(commandId);
    if (disposed.value) {
      return;
    }
    if (receipt.commandType !== "CompleteHumanTask") {
      completionFailure.value = {
        kind: "unknown",
        message: `回执的命令类型是 ${receipt.commandType}，不是本次完成；请核对 command ID。`,
        fieldErrors: []
      };
      return;
    }
    const result = completionFrom(receipt.result);
    completeCommandId = null;
    completionReceipt.value = `回执确认已完成：完成凭据 ${result.completionId}，任务修订 v${result.revision}。`;
    emit("refresh");
  } catch (caught) {
    if (!disposed.value) {
      completionFailure.value = describeLiveError(caught);
    }
  } finally {
    if (!disposed.value) {
      completing.value = false;
    }
  }
}

async function reopenTask(): Promise<void> {
  const client = liveClient();
  if (client === null || !canReopen.value) {
    return;
  }
  reopening.value = true;
  reopenFailure.value = null;
  reopenReceipt.value = null;
  try {
    reopenCommandId ??= createCommandId();
    const result = await client.reopenTask({
      taskId: props.taskId,
      commandId: reopenCommandId,
      expectedRevision: props.taskRevision,
      reason: reopenReason.value.trim()
    });
    if (disposed.value) {
      return;
    }
    reopenCommandId = null;
    reopenReceipt.value = `已重开：回到${result.status}，新验收版本 v${result.acceptanceRevision}（原 v${result.previousAcceptanceRevision} 的历史凭据仍保留）。编辑前需要重新开始任务。`;
    acceptedCriterionIds.value = [];
    reopenReason.value = "";
    emit("refresh");
  } catch (caught) {
    if (disposed.value) {
      return;
    }
    const described = describeLiveError(caught);
    reopenFailure.value = described;
    if (described.kind !== "transport") {
      reopenCommandId = null;
    }
  } finally {
    if (!disposed.value) {
      reopening.value = false;
    }
  }
}
</script>

<template>
  <section v-if="!live" class="surface-panel" data-testid="artifact-fixture-gap">
    <h2>产物与完成</h2>
    <p class="helper-text">
      示例数据没有产物事实，因此这里不展示任何产物、版本或完成凭据，也不提供可点的保存按钮。
      连接本机 API 后，产物版本、选择接受与人工完成会写入真实 PostgreSQL。
    </p>
    <p class="helper-text">
      <Info aria-hidden="true" />
      真实 API 目前也还没有“列出某个任务的产物”的读取端点，因此刷新页面后无法列出已有版本；这一点在接入真实数据后仍会显示。
    </p>
  </section>

  <template v-else>
    <section class="surface-panel" data-testid="artifact-editor">
      <h2>人工编辑与保存版本</h2>
      <p class="helper-text">
        保存会创建不可变版本：旧版本不会被覆盖，新版本不继承任何验收凭据。草稿只是本地输入，保存成功前不算已发布产物。
      </p>

      <p v-if="done" class="warning-callout" role="status" data-testid="artifact-editor-locked">
        <Info aria-hidden="true" />该任务本轮已完成：编辑入口已关闭，请先在下方重开任务再保存新版本。
      </p>
      <p v-else-if="!allowedActions?.includes('SAVE_ARTIFACT_VERSION')" class="disabled-reason" data-testid="artifact-editor-reason">
        <Info aria-hidden="true" />服务端未投影 SAVE_ARTIFACT_VERSION：当前状态是{{ taskStatusLabels[taskStatus] }}，只有进行中的人工任务可以保存产物。
      </p>

      <label class="field">
        <span class="field-label">产物名称</span>
        <input v-model="title" name="artifact-title" :disabled="latest !== null || done" />
        <span class="field-hint">
          {{
            latest === null
              ? "本次会话还没有已知产物，保存会新建一个产物；之后保存会续写同一个产物的新版本。"
              : "已在本会话创建过该任务的产物，这里保存的是同一个产物的新版本。"
          }}
        </span>
      </label>

      <div class="editor-toolbar">
        <span class="field-label">Markdown 内容</span>
        <div class="segmented">
          <label class="segmented-option" :class="{ 'segmented-option--selected': !previewing }">
            <input v-model="previewing" class="visually-hidden" type="radio" name="artifact-view" :value="false" />
            编辑
          </label>
          <label class="segmented-option" :class="{ 'segmented-option--selected': previewing }">
            <input v-model="previewing" class="visually-hidden" type="radio" name="artifact-view" :value="true" />
            预览
          </label>
        </div>
      </div>

      <textarea
        v-if="!previewing"
        v-model="content"
        class="markdown-editor"
        name="artifact-content"
        rows="12"
        :disabled="done"
        placeholder="用 Markdown 写这一轮的成果；标题、列表、粗体、行内代码与 http/https 链接会被安全渲染。"
      ></textarea>
      <SafeMarkdown v-else :source="content" />

      <p class="field-counter">{{ contentBytes }} / {{ CONTENT_LIMIT_BYTES }} 字节</p>
      <p v-if="contentTooLarge" class="field-error" role="alert">
        <Info aria-hidden="true" />正文超过 256 KiB（按 UTF-8 字节判定），服务端会返回 413；请拆分后再保存。
      </p>

      <div class="form-actions">
        <button
          class="primary-button"
          type="button"
          data-testid="artifact-save"
          :disabled="!canSave"
          @click="saveVersion"
        >
          <Save aria-hidden="true" />{{ saving ? "正在保存" : "保存新版本" }}
        </button>
      </div>

      <p v-if="saveReceipt" class="receipt-message" role="status" data-testid="artifact-save-receipt">{{ saveReceipt }}</p>
      <p v-if="saveFailure" class="action-error" role="alert">{{ saveFailure.message }}</p>
      <p v-if="saveFailure?.kind === 'conflict'" class="helper-text">
        草稿保留在编辑器里，没有被覆盖；请先重新读取任务事实，再决定是否用新版本提交。
      </p>
      <button
        v-if="saveFailure?.kind === 'transport'"
        class="secondary-button"
        type="button"
        data-testid="artifact-save-receipt-query"
        :disabled="saving"
        @click="lookupSaveReceipt"
      >
        查询本次保存回执
      </button>
    </section>

    <section class="surface-panel" data-testid="artifact-versions">
      <h2>版本与接受</h2>
      <p class="helper-text">
        服务端没有“列出任务产物”的读取端点（待接入），因此这里只列出<strong>本次会话</strong>保存过的版本。
        刷新页面后列表会为空，但数据库里的版本仍然存在。
      </p>

      <div v-if="versions.length === 0" class="page-state">
        <p>本次会话还没有保存过版本。保存后可以在这里选择要接受的版本。</p>
      </div>
      <ul v-else class="version-list">
        <li v-for="version in versions" :key="version.versionId" class="version-row">
          <label class="version-choice">
            <input
              v-model="selectedVersionId"
              type="radio"
              name="artifact-version"
              :value="version.versionId"
              :data-testid="`artifact-version-${version.versionNumber}`"
            />
            <span class="version-copy">
              <strong>v{{ version.versionNumber }} · {{ version.title }}</strong>
              <small>sha256 {{ version.sha256.slice(0, 12) }}… · {{ version.size }} 字节</small>
            </span>
          </label>
          <span class="version-tags">
            <span v-if="latest?.versionId === version.versionId" class="status-chip">最新</span>
            <span v-if="selectedByProject.some((ref) => ref.artifactVersionId === version.versionId)" class="status-chip status-chip--neutral">
              当前选用
            </span>
          </span>
        </li>
      </ul>

      <section class="rail-section">
        <h3>当前选用（来自项目 State）</h3>
        <p v-if="stateFailure !== null" class="action-error" role="alert">{{ stateFailure }}</p>
        <p v-else-if="projectId === null" class="helper-text">该任务未归属项目：选择要接受的版本是 Project State 命令，因此不可用。</p>
        <ul v-else-if="selectedByProject.length === 0" class="helper-text">项目 State 还没有选用任何产物版本。</ul>
        <ul v-else class="version-list">
          <li v-for="ref in selectedByProject" :key="ref.artifactVersionId" class="version-row">
            <span class="version-copy">
              <strong>v{{ ref.versionNumber }}</strong>
              <small>来源：{{ ref.sourceRef }}</small>
            </span>
          </li>
        </ul>

        <button
          class="secondary-button"
          type="button"
          data-testid="artifact-select-version"
          :disabled="selecting || selectedVersion === null || projectId === null || state === null"
          @click="selectVersion"
        >
          {{ selecting ? "正在提交" : "选择这个版本为当前选用" }}
        </button>
        <p class="helper-text">
          “当前选用”是项目级事实，只影响后续 Context 与工作台视图；它不等于“本轮接受”，完成凭据里的版本以完成命令为准。
        </p>
        <p v-if="selectReceipt" class="receipt-message" role="status">{{ selectReceipt }}</p>
        <p v-if="selectFailure" class="action-error" role="alert">{{ selectFailure.message }}</p>
        <button
          v-if="selectFailure?.kind === 'transport'"
          class="secondary-button"
          type="button"
          :disabled="selecting"
          @click="lookupSelectReceipt"
        >
          查询本次选择回执
        </button>
      </section>
    </section>

    <section class="surface-panel" data-testid="task-completion">
      <h2>检查与完成</h2>
      <p class="helper-text">
        完成是一次短事务：任务状态、完成凭据与项目 State 一起提交。检查通过不等于完成，完成也不等于执行成功。
      </p>

      <fieldset class="field" :disabled="done || !allowedActions?.includes('COMPLETE')">
        <legend class="field-label">必需验收条件（全部勾选才能完成）</legend>
        <p v-if="requiredCriteria.length === 0" class="field-hint">当前验收版本没有必需条件。</p>
        <label v-for="criterion in requiredCriteria" :key="criterion.criterionId" class="choice-option">
          <input
            type="checkbox"
            :checked="acceptedCriterionIds.includes(criterion.criterionId)"
            :data-testid="`criterion-${criterion.criterionId}`"
            @change="toggleCriterion(criterion.criterionId, ($event.target as HTMLInputElement).checked)"
          />
          <span>
            {{ criterion.statement }}
            <small>方式：{{ criterion.method }}</small>
          </span>
        </label>
      </fieldset>

      <label class="field">
        <span class="field-label">接受说明</span>
        <input v-model="acceptanceStatement" name="completion-statement" :disabled="done" />
      </label>
      <label class="field">
        <span class="field-label">补充理由（可选）</span>
        <input v-model="acceptanceReason" name="completion-reason" :disabled="done" />
      </label>

      <p class="helper-text">
        将随完成提交的产物版本：{{ selectedVersion === null ? "无（该任务未声明产物要求时允许为空集合）" : `v${selectedVersion.versionNumber}` }}
      </p>

      <div class="form-actions">
        <button
          class="primary-button"
          type="button"
          data-testid="task-complete"
          :disabled="!canComplete"
          @click="completeTask"
        >
          <Check aria-hidden="true" />{{ completing ? "正在提交" : "完成本轮" }}
        </button>
      </div>
      <p v-if="!done && !allowedActions?.includes('COMPLETE')" class="disabled-reason" data-testid="task-complete-reason">
        <Info aria-hidden="true" />服务端未投影 COMPLETE：只有进行中的人工任务可以完成。
      </p>
      <p v-if="done" class="disabled-reason" data-testid="task-complete-done">
        <Info aria-hidden="true" />该任务当前已完成；需要再次编辑请先重开。
      </p>

      <p v-if="completionReceipt" class="receipt-message" role="status" data-testid="task-complete-receipt">{{ completionReceipt }}</p>
      <p v-if="completionFailure" class="action-error" role="alert">{{ completionFailure.message }}</p>
      <button
        v-if="completionFailure?.kind === 'transport'"
        class="secondary-button"
        type="button"
        :disabled="completing"
        @click="lookupCompleteReceipt"
      >
        查询本次完成回执
      </button>
    </section>

    <!-- 重开后任务不再是 DONE，但结果说明要留在页面上，不能让回执随按钮一起消失。 -->
    <section v-if="done || allowedActions?.includes('REOPEN') || reopenReceipt !== null" class="surface-panel" data-testid="task-reopen">
      <h2>重开任务</h2>
      <p class="helper-text">
        重开会建立新的验收版本并回到可开始；旧完成凭据与历史版本都保留，不会被删除或改写。
      </p>
      <label class="field">
        <span class="field-label">重开原因<span class="field-required" aria-hidden="true">*</span></span>
        <input v-model="reopenReason" name="reopen-reason" />
      </label>
      <div class="form-actions">
        <button class="secondary-button" type="button" data-testid="task-reopen-submit" :disabled="!canReopen" @click="reopenTask">
          <RotateCcw aria-hidden="true" />{{ reopening ? "正在重开" : "重开任务" }}
        </button>
      </div>
      <p v-if="reopenReceipt" class="receipt-message" role="status" data-testid="task-reopen-receipt">{{ reopenReceipt }}</p>
      <p v-if="reopenFailure" class="action-error" role="alert">{{ reopenFailure.message }}</p>
      <button
        v-if="reopenFailure?.kind === 'transport'"
        class="secondary-button"
        type="button"
        :disabled="reopening"
        @click="lookupReopenReceipt"
      >
        查询本次重开回执
      </button>
    </section>

    <p class="helper-text">
      <FileText aria-hidden="true" />
      执行记录（Run/Trace）属于 P15，尚未实现，因此这里不展示任何执行历史，也不伪造步骤结果。
    </p>
  </template>
</template>
