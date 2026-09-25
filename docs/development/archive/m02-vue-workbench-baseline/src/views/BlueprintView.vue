<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ArrowRight, Check, ChevronRight, ClipboardCheck, FileText, Info, Monitor, Pencil, RotateCcw, X } from "lucide-vue-next";
import AppDialog from "../components/AppDialog.vue";
import ResponsiveRail from "../components/ResponsiveRail.vue";
import SourceDetailDialog from "../components/SourceDetailDialog.vue";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import type { BlueprintDraft, FixtureError, ProjectSnapshot, SourceReference } from "../types";

const route = useRoute();
const project = ref<ProjectSnapshot | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const editing = ref(false);
const submitting = ref(false);
const receipt = ref<string | null>(null);
const actionError = ref<{ kind: string; message: string } | null>(null);
const candidateVersion = ref<number | null>(null);
const candidateReplaces = ref<number | null>(null);
const selectedSource = ref<SourceReference | null>(null);
const sourceOpen = ref(false);
const notConnected = ref<string | null>(null);
const lastCommandId = ref<string | null>(null);
const draft = ref<BlueprintDraft>({ nextAction: "", taskTitles: ["", ""], workbench: "论文" });
const savedDraft = ref("");
let requestVersion = 0;

const mode = computed(() => fixtureModeFromQuery(route.query));
const projectId = computed(() => String(route.params.id));
const hasUnsavedChanges = computed(() => editing.value && JSON.stringify(draft.value) !== savedDraft.value);

const draftGuard: DraftGuard = {
  hasUnsavedChanges: () => hasUnsavedChanges.value,
  discard: () => abandonEdit()
};

function copyDraft(value: BlueprintDraft): BlueprintDraft {
  return { ...value, taskTitles: [...value.taskTitles] };
}

function toActionError(caught: unknown, fallback: string): { kind: string; message: string } {
  const fixtureError = caught as FixtureError;
  const message = caught instanceof Error ? caught.message.trim() : fallback;
  const kind = caught instanceof Error && "kind" in caught ? String(fixtureError.kind) : "unknown";
  return { kind, message };
}

async function load(): Promise<void> {
  const request = ++requestVersion;
  loading.value = true;
  error.value = null;
  receipt.value = null;
  actionError.value = null;
  try {
    const response = await fixtureAdapter.loadProject(projectId.value, mode.value);
    if (request !== requestVersion) {
      return;
    }
    project.value = response;
    if (response) {
      draft.value = copyDraft(response.blueprint.draft);
      savedDraft.value = JSON.stringify(draft.value);
      candidateVersion.value = null;
      candidateReplaces.value = null;
    }
  } catch (caught) {
    if (request === requestVersion) {
      error.value = caught instanceof Error ? caught.message.trim() : "读取示例数据时发生未知错误。";
    }
  } finally {
    if (request === requestVersion) {
      loading.value = false;
    }
  }
}

async function reloadAfterCommand(): Promise<void> {
  const response = await fixtureAdapter.loadProject(projectId.value, mode.value);
  project.value = response;
  if (response) {
    savedDraft.value = JSON.stringify(copyDraft(response.blueprint.draft));
  }
}

watch([projectId, mode], load, { immediate: true });
setDraftGuard(draftGuard);
onBeforeUnmount(() => {
  requestVersion += 1;
  clearDraftGuard(draftGuard);
});

function beginEdit(): void {
  editing.value = true;
  receipt.value = null;
  actionError.value = null;
}

function abandonEdit(): void {
  if (project.value) {
    draft.value = copyDraft(project.value.blueprint.draft);
    savedDraft.value = JSON.stringify(draft.value);
  }
  editing.value = false;
}

async function previewEditedDraft(): Promise<void> {
  if (submitting.value) {
    return;
  }
  const request = ++requestVersion;
  submitting.value = true;
  actionError.value = null;
  try {
    const preview = await fixtureAdapter.previewBlueprint(projectId.value, copyDraft(draft.value), mode.value);
    if (request !== requestVersion) {
      return;
    }
    const previousVersion = project.value?.blueprint.version ?? null;
    const response = await fixtureAdapter.loadProject(projectId.value, mode.value);
    if (request !== requestVersion) {
      return;
    }
    project.value = response;
    candidateVersion.value = preview.version;
    candidateReplaces.value = previousVersion;
    savedDraft.value = JSON.stringify(draft.value);
    editing.value = false;
    receipt.value = `本次演示已形成新候选 v${preview.version}，替代 v${previousVersion ?? 1}；尚未应用到项目。`;
  } catch (caught) {
    if (request === requestVersion) {
      actionError.value = toActionError(caught, "无法生成新的演示预览。");
    }
  } finally {
    if (request === requestVersion) {
      submitting.value = false;
    }
  }
}

async function applyBlueprint(): Promise<void> {
  if (submitting.value || !project.value) {
    return;
  }
  const request = ++requestVersion;
  submitting.value = true;
  actionError.value = null;
  receipt.value = null;
  try {
    lastCommandId.value = fixtureAdapter.createCommandId("project");
    const result = await fixtureAdapter.applyBlueprint(projectId.value, copyDraft(draft.value), mode.value, lastCommandId.value);
    if (request !== requestVersion) {
      return;
    }
    await reloadAfterCommand();
    if (request !== requestVersion) {
      return;
    }
    receipt.value = result.description;
    editing.value = false;
    candidateVersion.value = null;
    candidateReplaces.value = null;
  } catch (caught) {
    if (request === requestVersion) {
      actionError.value = toActionError(caught, "应用示例蓝图时发生未知错误。");
    }
  } finally {
    if (request === requestVersion) {
      submitting.value = false;
    }
  }
}

async function rejectBlueprint(): Promise<void> {
  if (submitting.value || !project.value) {
    return;
  }
  const request = ++requestVersion;
  submitting.value = true;
  actionError.value = null;
  try {
    await fixtureAdapter.rejectBlueprint(projectId.value);
    if (request !== requestVersion) {
      return;
    }
    await reloadAfterCommand();
    if (request !== requestVersion) {
      return;
    }
    candidateVersion.value = null;
    candidateReplaces.value = null;
    editing.value = false;
    receipt.value = "本次演示已暂不采用蓝图；已创建的项目仍保留，未新增任务或配置。";
  } catch (caught) {
    if (request === requestVersion) {
      actionError.value = toActionError(caught, "暂不采用建议失败。");
    }
  } finally {
    if (request === requestVersion) {
      submitting.value = false;
    }
  }
}

async function lookupReceipt(): Promise<void> {
  if (submitting.value) {
    return;
  }
  const commandId = lastCommandId.value;
  if (!commandId) {
    actionError.value = { kind: "unknown", message: "本页尚无可查询的提交；请先提交一次，不能凭空生成回执。" };
    return;
  }
  const request = ++requestVersion;
  submitting.value = true;
  actionError.value = null;
  try {
    const result = await fixtureAdapter.lookupReceipt(commandId);
    if (request === requestVersion) {
      receipt.value =
        result.status === "APPLIED"
          ? (result.receipt?.description ?? "本次演示已确认应用。")
          : result.status === "UNKNOWN"
            ? "本次提交仍未确认；请继续使用同一 command ID 核对，不能直接重试。"
            : "未找到本次提交的回执；请先核对当前候选。";
    }
  } finally {
    if (request === requestVersion) {
      submitting.value = false;
    }
  }
}

function sourceOf(id: string): SourceReference | null {
  return project.value?.sources.find((candidate) => candidate.id === id) ?? null;
}

function showSource(id: string): void {
  const source = sourceOf(id);
  if (source) {
    selectedSource.value = source;
    sourceOpen.value = true;
  }
}

const applyBlockedReason = computed(() => {
  if (!project.value) {
    return null;
  }
  if (project.value.blueprint.status === "APPLIED") {
    return "这份蓝图已应用；如需调整，请修改建议并重新生成候选。";
  }
  if (editing.value) {
    return "修改尚未形成新候选，请先重新预览再应用。";
  }
  if (project.value.blueprint.status === "REJECTED" && candidateVersion.value === null) {
    return "该候选已被暂不采用；如需继续，请修改建议并重新预览。";
  }
  return null;
});

const canApply = computed(() => applyBlockedReason.value === null && !submitting.value);
const draftPreviewVersion = computed(() => (candidateVersion.value ?? project.value?.blueprint.version ?? 1));
const statusLabel = computed(() => {
  if (!project.value) {
    return "";
  }
  if (candidateVersion.value !== null) {
    return `本轮新候选 v${candidateVersion.value}`;
  }
  if (project.value.blueprint.status === "APPLIED") {
    return "本次演示已应用";
  }
  if (project.value.blueprint.status === "REJECTED") {
    return "已暂不采用";
  }
  return "待确认";
});
</script>

<template>
  <section v-if="loading" class="page-state" aria-live="polite">
    <p class="eyebrow">项目蓝图</p>
    <h1>正在读取蓝图预览</h1>
    <p>示例数据正在加载，页面仍未提交任何变更。</p>
  </section>
  <section v-else-if="error" class="page-state page-state--error" role="alert">
    <p class="eyebrow">项目蓝图</p>
    <h1>暂时无法显示蓝图</h1>
    <p>{{ error }}</p>
    <button class="secondary-button" type="button" @click="load"><RotateCcw aria-hidden="true" />重新读取</button>
  </section>
  <section v-else-if="!project" class="page-state">
    <p class="eyebrow">项目蓝图</p>
    <h1>尚未提供项目蓝图示例</h1>
    <p>这个路由对象没有对应的 Skill fixture，页面不会回退读取或写入其他项目的蓝图。</p>
  </section>
  <section v-else class="skill-page">
    <div class="page-layout">
      <div class="page-primary">
        <p class="eyebrow">{{ project.name }}</p>
        <p class="page-lede">项目已创建，以下建议等待你确认。</p>
        <h1>让目标，有一条清晰的路径</h1>
        <p class="metadata-row">
          蓝图建议 v{{ draftPreviewVersion }}
          <span aria-hidden="true">·</span>
          基于项目状态 v{{ project.blueprint.baseRevision }}
          <span aria-hidden="true">·</span>
          {{ statusLabel }}
        </p>

        <section class="surface-panel blueprint-panel" aria-labelledby="blueprint-changes">
          <div class="section-heading-row">
            <h2 id="blueprint-changes">本次蓝图变更</h2>
            <button
              v-if="!editing && project.blueprint.status !== 'APPLIED'"
              class="text-button"
              type="button"
              data-testid="blueprint-edit"
              @click="beginEdit"
            >
              <Pencil aria-hidden="true" />修改建议
            </button>
          </div>

          <form v-if="editing" class="edit-form" data-testid="blueprint-edit-form" @submit.prevent="previewEditedDraft">
            <label>
              下一步
              <input v-model="draft.nextAction" name="blueprint-next-action" />
            </label>
            <label>
              新任务一
              <input v-model="draft.taskTitles[0]" name="blueprint-task-one" />
            </label>
            <label>
              新任务二
              <input v-model="draft.taskTitles[1]" name="blueprint-task-two" />
            </label>
            <fieldset>
              <legend>工作台建议</legend>
              <label class="radio-option"><input v-model="draft.workbench" type="radio" value="通用" />通用</label>
              <label class="radio-option"><input v-model="draft.workbench" type="radio" value="论文" />论文</label>
            </fieldset>
            <div class="form-actions">
              <button class="primary-button" type="submit" :disabled="submitting">{{ submitting ? '正在重新预览' : '重新预览建议' }}</button>
              <button class="text-button" type="button" :disabled="submitting" @click="abandonEdit">放弃修改</button>
            </div>
          </form>

          <div v-else class="blueprint-diff" aria-label="当前与建议的蓝图差异">
            <div class="diff-heading">
              <span aria-hidden="true"></span><strong>当前</strong><strong>建议</strong>
            </div>
            <div class="diff-row">
              <span class="diff-icon"><ArrowRight aria-hidden="true" /></span>
              <span><strong>下一步</strong><small>{{ project.nextAction ?? '尚未明确' }}</small></span>
              <span class="diff-arrow-cell"><ArrowRight aria-hidden="true" /></span>
              <span class="suggested-value">{{ draft.nextAction || '（未填写）' }}</span>
            </div>
            <div class="diff-row">
              <span class="diff-icon"><ClipboardCheck aria-hidden="true" /></span>
              <span><strong>任务</strong><small>{{ project.tasks.length ? `${project.tasks.length} 项已创建` : '暂无任务' }}</small></span>
              <span class="diff-arrow-cell"><ArrowRight aria-hidden="true" /></span>
              <span class="suggested-value">
                {{ draft.taskTitles.filter(Boolean).join('、') || '（无新任务）' }}
                <small>新任务进入收件箱，由我执行；不会自动开始。</small>
              </span>
            </div>
            <div class="diff-row">
              <span class="diff-icon"><Monitor aria-hidden="true" /></span>
              <span><strong>工作台</strong><small>{{ project.workbench }}</small></span>
              <span class="diff-arrow-cell"><ArrowRight aria-hidden="true" /></span>
              <span class="suggested-value">{{ draft.workbench }}</span>
            </div>
          </div>

          <div class="follow-up-section">
            <h2>后续配置建议</h2>
            <p>以下内容可按需单独确认，不随本次蓝图应用。</p>
            <div class="suggestion-row">
              <FileText aria-hidden="true" />
              <span class="suggestion-copy"><strong>引用核对规则</strong><small>建议配置文献引用的核对规则，提升内容可靠性。</small></span>
              <button class="text-button" type="button" @click="notConnected = 'rules'">单独确认<ChevronRight aria-hidden="true" /></button>
            </div>
            <div class="suggestion-row">
              <ClipboardCheck aria-hidden="true" />
              <span class="suggestion-copy"><strong>验证配置</strong><small>建议配置结果验证方式，用于后续成果的质量检查。</small></span>
              <button class="text-button" type="button" @click="notConnected = 'verification'">单独确认<ChevronRight aria-hidden="true" /></button>
            </div>
          </div>
        </section>
      </div>

      <ResponsiveRail label="查看确认区" title="确认这次变化">
        <div class="rail-content">
          <h2>确认这次变化</h2>
          <p class="rail-intro">请查看蓝图建议，确认后应用到项目中。</p>
          <div class="summary-card">
            <p><Check aria-hidden="true" /><strong>{{ draft.taskTitles.filter(Boolean).length }} 项新任务</strong></p>
            <p><ArrowRight aria-hidden="true" /><strong>1 项下一步</strong></p>
            <p><Monitor aria-hidden="true" /><strong>{{ draft.workbench }}工作台</strong></p>
            <hr />
            <h3>已选来源</h3>
            <button class="source-button" type="button" @click="showSource('goal-v1')">
              <FileText aria-hidden="true" />项目目标 v1
            </button>
            <button class="source-button" type="button" @click="showSource('research-notes-v2')">
              <FileText aria-hidden="true" />项目研究笔记 v2
            </button>
          </div>
          <p v-if="receipt" class="receipt-message" role="status">{{ receipt }}</p>
          <p v-if="actionError" class="action-error" role="alert">{{ actionError.message }}</p>
          <button
            class="primary-button primary-button--wide"
            type="button"
            data-testid="blueprint-apply"
            :disabled="!canApply"
            @click="applyBlueprint"
          >
            {{ submitting ? '正在应用' : project.blueprint.status === 'APPLIED' ? '蓝图已应用' : '应用这份蓝图' }}
          </button>
          <p v-if="applyBlockedReason" class="disabled-reason" data-testid="blueprint-apply-reason">
            <Info aria-hidden="true" />{{ applyBlockedReason }}
          </p>
          <button v-if="actionError?.kind === 'timeout'" class="secondary-button secondary-button--wide" type="button" :disabled="submitting" @click="lookupReceipt">查询本次回执</button>
          <button v-if="actionError?.kind === 'conflict'" class="secondary-button secondary-button--wide" type="button" :disabled="submitting" @click="previewEditedDraft">按当前草稿重新核对</button>
          <div v-if="project.blueprint.status !== 'APPLIED'" class="rail-inline-actions">
            <button class="text-button" type="button" :disabled="submitting" @click="beginEdit">修改建议</button>
            <span aria-hidden="true"></span>
            <button class="text-button" type="button" :disabled="submitting" data-testid="blueprint-reject" @click="rejectBlueprint"><X aria-hidden="true" />暂不采用</button>
          </div>
          <p class="helper-text">暂不采用会保留已创建的项目。本次不会开始任务或应用后续配置。</p>
        </div>
      </ResponsiveRail>
    </div>
    <SourceDetailDialog v-model="sourceOpen" :source="selectedSource" />
    <AppDialog :model-value="notConnected !== null" title="该入口尚未接入" @update:model-value="notConnected = null">
      <p v-if="notConnected === 'rules'">
        引用核对规则需要在规则入口单独确认；本轮交互预览未接入规则写入，因此不会随蓝图应用，也不会在此处生成规则。
      </p>
      <p v-else>
        验证配置需要在验证入口单独确认；本轮交互预览未接入配置写入。你可以在任务的验收方案中预览检查建议。
      </p>
      <RouterLink class="text-link" to="/tasks/task-evaluation-metrics?skill=verification">
        前往任务的验收方案
        <ChevronRight aria-hidden="true" />
      </RouterLink>
    </AppDialog>
  </section>
</template>
