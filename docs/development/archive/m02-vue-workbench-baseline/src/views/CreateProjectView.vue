<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Check, FileText, Info, Upload } from "lucide-vue-next";
import ResponsiveRail from "../components/ResponsiveRail.vue";
import {
  createCommandId,
  projectCreationFrom,
  RelayApiError,
  type RelayProjectCreation
} from "../api/relayClient";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { projectTypeLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { setCreationFlash } from "../lib/navigationFlash";
import { liveClient, relayConnection } from "../lib/relayConnection";
import type { CreateProjectDraft, FixtureError, ProjectType } from "../types";

const emit = defineEmits<{ cancel: [] }>();

const route = useRoute();
const router = useRouter();

const mode = computed(() => fixtureModeFromQuery(route.query));
const live = computed(() => relayConnection.mode === "live");

const title = ref("");
const goal = ref("");
const projectType = ref<ProjectType | "">("");
const importFileName = ref<string | null>(null);
const importError = ref<string | null>(null);
const dropActive = ref(false);

const fieldErrors = ref<Partial<Record<"title" | "goal" | "projectType", string>>>({});
const submitting = ref(false);
const actionError = ref<{ kind: string; message: string } | null>(null);
const receipt = ref<string | null>(null);
const commandId = ref<string | null>(null);
const created = ref(false);
const savedDraft = ref("");
let disposed = false;

const projectTypes: ProjectType[] = ["GENERAL", "THESIS", "DEVELOPMENT"];

function draftState(): string {
  return JSON.stringify({
    title: title.value,
    goal: goal.value,
    projectType: projectType.value,
    importFileName: importFileName.value
  });
}

function discardDraft(): void {
  title.value = "";
  goal.value = "";
  projectType.value = "";
  importFileName.value = null;
  importError.value = null;
  fieldErrors.value = {};
  savedDraft.value = draftState();
}

const draftGuard: DraftGuard = {
  hasUnsavedChanges: () => !created.value && draftState() !== savedDraft.value,
  discard: discardDraft
};

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  if (draftGuard.hasUnsavedChanges()) {
    event.preventDefault();
    event.returnValue = "";
  }
}

savedDraft.value = draftState();
setDraftGuard(draftGuard);
onMounted(() => window.addEventListener("beforeunload", warnBeforeUnload));
onBeforeUnmount(() => {
  disposed = true;
  clearDraftGuard(draftGuard);
  window.removeEventListener("beforeunload", warnBeforeUnload);
});

/**
 * 提交尝试后如果修改了表单内容，必须换新的 command ID：
 * 同一个 ID 配不同内容会被服务端判为 409 COMMAND_ID_REUSED。
 */
watch(draftState, () => {
  commandId.value = null;
});

const typeHint = computed(() => {
  if (projectType.value === "THESIS") {
    return "论文项目按选题、文献研究、方法、实验、写作与评审组织阶段。";
  }
  if (projectType.value === "DEVELOPMENT") {
    return "开发项目按探索、设计、实现、验证与发布组织阶段。";
  }
  if (projectType.value === "GENERAL") {
    return "通用项目按规划、执行与评审组织阶段。";
  }
  return "不同类型决定后续阶段词汇、任务模板与工作台默认组合，创建后仍可调整。";
});

function acceptFile(file: File | undefined): void {
  // live 模式下没有资料导入端点：不接受任何文件，也不伪造导入状态。
  if (live.value || !file) {
    return;
  }
  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".md") && !lower.endsWith(".txt")) {
    importFileName.value = null;
    importError.value = "只支持 .md 与 .txt 文本资料；PDF/Office 暂不支持全文提取，因此不会在这里接收。";
    return;
  }
  importError.value = null;
  importFileName.value = file.name;
}

function onFileChange(event: Event): void {
  acceptFile((event.target as HTMLInputElement).files?.[0]);
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dropActive.value = false;
  acceptFile(event.dataTransfer?.files?.[0]);
}

function clearImport(): void {
  importFileName.value = null;
  importError.value = null;
}

function onDragOver(): void {
  if (!live.value) {
    dropActive.value = true;
  }
}

function validate(): boolean {
  const errors: typeof fieldErrors.value = {};
  if (title.value.trim() === "") {
    errors.title = "请填写项目名称，它用于在长期工作中快速定位这个项目。";
  }
  // live：CreateProject 只接受名称与类型，目标不会写入服务端，因此 live 下不作为必填。
  if (!live.value && goal.value.trim() === "") {
    errors.goal = "请用一句话说明你希望通过这个项目达成的目标。";
  }
  if (projectType.value === "") {
    errors.projectType = "请选择项目类型；它决定后续阶段词汇与默认工作台组合。";
  }
  fieldErrors.value = errors;
  return Object.keys(errors).length === 0;
}

async function submit(): Promise<void> {
  if (submitting.value || created.value) {
    return;
  }
  actionError.value = null;
  if (!validate()) {
    return;
  }
  submitting.value = true;
  try {
    if (live.value) {
      await submitLiveProject();
      return;
    }
    const draft: CreateProjectDraft = {
      title: title.value,
      goal: goal.value,
      projectType: projectType.value as ProjectType,
      importFileName: importFileName.value
    };
    commandId.value ??= fixtureAdapter.createCommandId("project");
    const result = await fixtureAdapter.createProject(draft, mode.value, commandId.value);
    receipt.value = result.receipt.description;
    created.value = true;
    // 创建成功后进入项目列表并选中新项目；回执与导入状态随本次导航传递，
    // 因为项目详情页（UI-02）不在本轮范围内，不能落到别的项目数据上。
    setCreationFlash({
      projectId: result.projectId,
      receipt: result.receipt.description,
      importStatus: result.importStatus
    });
    await router.push({ path: "/projects" });
  } catch (caught) {
    if (live.value) {
      const described = describeLiveError(caught);
      actionError.value = { kind: described.kind, message: described.message };
    } else {
      const fixtureError = caught as FixtureError;
      actionError.value = {
        kind: caught instanceof Error && "kind" in caught ? String(fixtureError.kind) : "unknown",
        message: caught instanceof Error ? caught.message.trim() : "创建示例项目时发生未知错误。"
      };
    }
  } finally {
    submitting.value = false;
  }
}

/** 回执里的 result 与首次响应是同一份事实：成功与回执查询共用这段文案。 */
function describeCreation(creation: RelayProjectCreation): string {
  return `项目 ID ${creation.projectId}，revision v${creation.revision}，phase_key ${creation.phaseKey}，state_revision v${creation.stateRevision}`;
}

async function submitLiveProject(): Promise<void> {
  const client = liveClient();
  if (client === null) {
    actionError.value = { kind: "unknown", message: "连接已断开：请重新连接本机 API 后再创建项目。" };
    return;
  }
  // CreateProject 只接受 title 与 project_type：目标与导入资料不参与本次提交。
  commandId.value ??= createCommandId();
  const creation = await client.createProject({
    commandId: commandId.value,
    title: title.value.trim(),
    projectType: projectType.value as ProjectType
  });
  if (disposed) {
    return;
  }
  created.value = true;
  receipt.value = `已创建项目：${describeCreation(creation)}。CreateProject 只写入名称与类型，目标未提交、资料未导入。`;
  // 真实 API 没有项目列表端点（GET /projects 不存在），所以创建后不能回到列表页；
  // 只能进入该项目的任务页，用真实 project_id 继续工作。
  await router.push({ path: `/projects/${encodeURIComponent(creation.projectId)}/tasks` });
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
    if (result.status === "APPLIED" && result.operation === "project" && result.receipt && result.resourceId && result.importStatus) {
      receipt.value = result.receipt.description;
      created.value = true;
      setCreationFlash({
        projectId: result.resourceId,
        receipt: result.receipt.description,
        importStatus: result.importStatus
      });
      await router.push({ path: "/projects" });
      return;
    }
    actionError.value = {
      kind: result.status === "UNKNOWN" ? "timeout" : "not-submitted",
      message:
        result.status === "UNKNOWN"
          ? "本次提交仍未确认；请继续使用同一 command ID 查询回执，不能直接创建第二个项目。"
          : "未找到这次提交的回执；尚未创建项目，可以使用同一 command ID 再次提交。"
    };
  } finally {
    submitting.value = false;
  }
}

/** 传输错误后按同一 command ID 查询回执，判断这次创建是否已提交。 */
async function lookupLiveReceipt(): Promise<void> {
  const client = liveClient();
  const pendingId = commandId.value;
  if (client === null || pendingId === null || submitting.value) {
    return;
  }
  submitting.value = true;
  actionError.value = null;
  try {
    const receiptBody = await client.getCommandReceipt(pendingId);
    if (disposed) {
      return;
    }
    if (receiptBody.commandType !== "CreateProject") {
      actionError.value = {
        kind: "unknown",
        message: `回执的命令类型是 ${receiptBody.commandType}，不是本次创建项目的命令；请核对 command ID。`
      };
      return;
    }
    const creation = projectCreationFrom(receiptBody.result);
    created.value = true;
    receipt.value = `回执确认已提交：${describeCreation(creation)}。CreateProject 只写入名称与类型，目标未提交、资料未导入。`;
    await router.push({ path: `/projects/${encodeURIComponent(creation.projectId)}/tasks` });
  } catch (caught) {
    if (disposed) {
      return;
    }
    if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
      actionError.value = {
        kind: "not-submitted",
        message: "没有找到这次提交的回执：该命令尚未提交，可以用同一个 command ID 重新提交。"
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
</script>

<template>
  <div class="page-layout">
    <div class="page-primary">
      <h1>开始一个长期项目</h1>
      <p class="page-lede">定义项目的基本信息，稍后可逐步完善。创建后即可开始规划任务、整理资料与开展工作。</p>

      <form class="create-form" novalidate @submit.prevent="submit">
        <label class="field" :class="{ 'field--invalid': fieldErrors.title }">
          <span class="field-label">项目名称<span class="field-required" aria-hidden="true">*</span></span>
          <input
            v-model="title"
            name="project-title"
            required
            :aria-invalid="fieldErrors.title ? 'true' : undefined"
            :aria-describedby="fieldErrors.title ? 'project-title-error' : 'project-title-hint'"
            @input="fieldErrors.title = undefined"
          />
          <span v-if="fieldErrors.title" id="project-title-error" class="field-error" role="alert">
            <Info aria-hidden="true" />{{ fieldErrors.title }}
          </span>
          <span v-else id="project-title-hint" class="field-hint">一个清晰的名称有助于你在长期工作中快速识别和定位该项目。</span>
        </label>

        <label class="field" :class="{ 'field--invalid': fieldErrors.goal }">
          <span class="field-label">项目目标<span v-if="!live" class="field-required" aria-hidden="true">*</span></span>
          <textarea
            v-model="goal"
            name="project-goal"
            rows="3"
            :required="!live"
            :aria-invalid="fieldErrors.goal ? 'true' : undefined"
            :aria-describedby="fieldErrors.goal ? 'project-goal-error' : 'project-goal-hint'"
            @input="fieldErrors.goal = undefined"
          ></textarea>
          <span v-if="fieldErrors.goal" id="project-goal-error" class="field-error" role="alert">
            <Info aria-hidden="true" />{{ fieldErrors.goal }}
          </span>
          <span v-else id="project-goal-hint" class="field-hint">
            {{
              live
                ? "未接入：CreateProject 只接受名称与类型，目标不会写入服务端；这里输入的内容不会被保存。"
                : "简要描述你希望通过这个项目达成的目标、预期成果或解决的主要问题。"
            }}
          </span>
        </label>

        <fieldset class="field" :class="{ 'field--invalid': fieldErrors.projectType }">
          <legend class="field-label">项目类型<span class="field-required" aria-hidden="true">*</span></legend>
          <div class="segmented">
            <label
              v-for="type in projectTypes"
              :key="type"
              class="segmented-option"
              :class="{ 'segmented-option--selected': projectType === type }"
            >
              <input
                v-model="projectType"
                class="visually-hidden"
                type="radio"
                name="project-type"
                :value="type"
                @change="fieldErrors.projectType = undefined"
              />
              {{ projectTypeLabels[type] }}
            </label>
          </div>
          <span v-if="fieldErrors.projectType" class="field-error" role="alert">
            <Info aria-hidden="true" />{{ fieldErrors.projectType }}
          </span>
          <span v-else class="field-hint">{{ typeHint }}</span>
        </fieldset>

        <div class="field">
          <span class="field-label">导入初始资料（可选）</span>
          <label
            class="file-drop"
            :class="{ 'file-drop--filled': importFileName !== null, 'file-drop--active': dropActive, 'file-drop--invalid': importError !== null }"
            @dragover.prevent="onDragOver"
            @dragleave="dropActive = false"
            @drop="onDrop"
          >
            <input
              class="visually-hidden"
              type="file"
              accept=".md,.txt"
              name="project-import"
              :disabled="live"
              @change="onFileChange"
            />
            <Upload aria-hidden="true" />
            <strong>{{ live ? "资料导入尚未接入" : (importFileName ?? "点击选择文件或拖拽到此处") }}</strong>
            <small>{{ live ? "live 模式下不会上传任何文件" : "支持 .md / .txt 格式的文档" }}</small>
          </label>
          <span v-if="live" class="field-hint">
            资料导入端点尚未实现：CreateProject 只写入项目名称与类型，初始资料不会上传到服务端。
          </span>
          <span v-else-if="importError" class="field-error" role="alert"><Info aria-hidden="true" />{{ importError }}</span>
          <span v-else-if="importFileName" class="field-hint">
            已选择「{{ importFileName }}」。导入是独立的长任务：失败不会撤销已创建的项目。
            <button class="text-button" type="button" @click="clearImport">取消导入</button>
          </span>
          <span v-else class="field-hint">上传与本项目相关的已有资料，例如研究笔记、文档大纲、参考文献等。</span>
        </div>

        <div class="form-actions">
          <button class="primary-button" type="submit" data-testid="project-create-submit" :disabled="submitting">
            {{ submitting ? "正在创建" : "创建项目" }}
          </button>
          <button class="secondary-button" type="button" :disabled="submitting" @click="emit('cancel')">返回列表</button>
        </div>

        <p v-if="receipt" class="receipt-message" role="status">{{ receipt }}</p>
        <p v-if="actionError" class="action-error" role="alert">{{ actionError.message }}</p>
        <button
          v-if="actionError?.kind === 'timeout' || actionError?.kind === 'transport'"
          class="secondary-button"
          type="button"
          data-testid="project-create-receipt"
          :disabled="submitting"
          @click="lookupReceipt"
        >
          查询本次回执
        </button>
        <p v-if="actionError?.kind === 'timeout'" class="helper-text">
          提交结果暂不明确时先查回执，不要直接再点创建；重复点击不会创建两个项目。
        </p>
        <p v-if="actionError?.kind === 'transport'" class="helper-text">
          提交结果不确定时先查回执，不要换 command ID 重新提交。
        </p>
      </form>
    </div>

    <ResponsiveRail label="查看创建说明" title="从最少的信息开始">
      <div class="rail-content">
        <h2>从最少的信息开始</h2>
        <p class="rail-intro">你可以先填写基本信息，创建后再逐步完善项目的详细内容。</p>
        <div class="suggestion-row">
          <Check aria-hidden="true" />
          <span class="suggestion-copy">
            <strong>创建后可人工维护项目状态</strong>
            <small>项目创建后，你可以随时补充目标、调整范围、更新任务与资料。</small>
          </span>
        </div>
        <div class="suggestion-row">
          <Check aria-hidden="true" />
          <span class="suggestion-copy">
            <strong>未连接模型也能开始</strong>
            <small>不需要配置任何模型或服务，你可以在任何时候开始，专注于自己的思考与规划。</small>
          </span>
        </div>
        <div class="suggestion-row">
          <Check aria-hidden="true" />
          <span class="suggestion-copy">
            <strong>AI 建议需你确认后应用</strong>
            <small>后续在项目中，AI 可能提供分析与建议，但所有关键内容都需要你审查并确认后才会被应用。</small>
          </span>
        </div>
        <p class="helper-text">
          <FileText aria-hidden="true" />
          本轮交互预览未连接模型：创建后不会自动生成初始状态或蓝图建议，也不会自动启动任何执行。
        </p>
      </div>
    </ResponsiveRail>
  </div>
</template>
