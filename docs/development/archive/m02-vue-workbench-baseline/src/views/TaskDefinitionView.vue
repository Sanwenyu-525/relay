<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ChevronRight, Info, Pencil, RotateCcw, X } from "lucide-vue-next";
import ResponsiveRail from "../components/ResponsiveRail.vue";
import SourceDetailDialog from "../components/SourceDetailDialog.vue";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import type { FixtureError, ProjectSnapshot, SourceReference, TaskDefinitionDraft } from "../types";

const route = useRoute();
const project = ref<ProjectSnapshot | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const editing = ref(false);
const submitting = ref(false);
const receipt = ref<string | null>(null);
const actionError = ref<{ kind: string; message: string } | null>(null);
const selectedSource = ref<SourceReference | null>(null);
const sourceOpen = ref(false);
const draft = ref<TaskDefinitionDraft>({
  objective: "",
  expectedResult: "",
  acceptanceCriteria: [],
  inputSource: "",
  suggestedMode: "人工执行，按需 AI 辅助"
});
const savedDraft = ref("");
let requestVersion = 0;

const mode = computed(() => fixtureModeFromQuery(route.query));
const taskId = computed(() => String(route.params.id));
const hasUnsavedChanges = computed(() => editing.value && JSON.stringify(draft.value) !== savedDraft.value);

const draftGuard: DraftGuard = {
  hasUnsavedChanges: () => hasUnsavedChanges.value,
  discard: () => abandonEdit()
};

function copyDraft(value: TaskDefinitionDraft): TaskDefinitionDraft {
  return { ...value, acceptanceCriteria: [...value.acceptanceCriteria] };
}

function toActionError(caught: unknown, fallback: string): { kind: string; message: string } {
  const message = caught instanceof Error ? caught.message.trim() : fallback;
  const kind = caught instanceof Error && "kind" in caught ? String((caught as FixtureError).kind) : "unknown";
  return { kind, message };
}

async function load(): Promise<void> {
  const request = ++requestVersion;
  loading.value = true;
  error.value = null;
  receipt.value = null;
  actionError.value = null;
  try {
    const response = await fixtureAdapter.loadTask(taskId.value, mode.value);
    if (request !== requestVersion) {
      return;
    }
    project.value = response;
    if (response) {
      draft.value = copyDraft(response.task.definition);
      savedDraft.value = JSON.stringify(draft.value);
    }
  } catch (caught) {
    if (request === requestVersion) {
      error.value = caught instanceof Error ? caught.message.trim() : "读取任务示例失败。";
    }
  } finally {
    if (request === requestVersion) {
      loading.value = false;
    }
  }
}

watch([taskId, mode], load, { immediate: true });
setDraftGuard(draftGuard);
onBeforeUnmount(() => {
  requestVersion += 1;
  clearDraftGuard(draftGuard);
});

function beginEdit(): void {
  editing.value = true;
  actionError.value = null;
  receipt.value = null;
}

function abandonEdit(): void {
  if (project.value) {
    draft.value = copyDraft(project.value.task.definition);
    savedDraft.value = JSON.stringify(draft.value);
  }
  editing.value = false;
}

async function acceptDefinition(): Promise<void> {
  if (!project.value || submitting.value) {
    return;
  }
  const request = ++requestVersion;
  submitting.value = true;
  actionError.value = null;
  receipt.value = null;
  try {
    const result = await fixtureAdapter.acceptTaskDefinition(taskId.value, copyDraft(draft.value), mode.value);
    if (request !== requestVersion) {
      return;
    }
    const response = await fixtureAdapter.loadTask(taskId.value, mode.value);
    if (request !== requestVersion) {
      return;
    }
    project.value = response;
    savedDraft.value = JSON.stringify(copyDraft(draft.value));
    editing.value = false;
    receipt.value = result.description;
  } catch (caught) {
    if (request === requestVersion) {
      actionError.value = toActionError(caught, "接受任务定义失败。");
    }
  } finally {
    if (request === requestVersion) {
      submitting.value = false;
    }
  }
}

async function rejectDefinition(): Promise<void> {
  if (!project.value || submitting.value) {
    return;
  }
  const request = ++requestVersion;
  submitting.value = true;
  actionError.value = null;
  try {
    await fixtureAdapter.rejectTaskDefinition(taskId.value);
    if (request !== requestVersion) {
      return;
    }
    const response = await fixtureAdapter.loadTask(taskId.value, mode.value);
    if (request !== requestVersion) {
      return;
    }
    project.value = response;
    receipt.value = "本次演示已暂不采用定义建议；当前任务事实与验收标准保持不变。";
  } catch (caught) {
    if (request === requestVersion) {
      actionError.value = toActionError(caught, "暂不采用定义失败。");
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

const acceptBlockedReason = computed(() => {
  if (!project.value) {
    return null;
  }
  if (project.value.task.proposalStatus === "APPLIED") {
    return `已形成 v${project.value.task.revision} 修订；如需调整，请再次修改建议后接受新的修订。`;
  }
  if (project.value.task.proposalStatus === "REJECTED") {
    return "该提案已被暂不采用；如需继续，请先修改建议再接受。";
  }
  if (editing.value) {
    return "正在编辑中，请在编辑区提交这份定义。";
  }
  return null;
});

const canAccept = computed(() => acceptBlockedReason.value === null && !submitting.value);
const proposalLabel = computed(() => {
  if (!project.value) {
    return "";
  }
  if (project.value.task.proposalStatus === "APPLIED") {
    return `已形成 v${project.value.task.revision} 修订`;
  }
  return project.value.task.proposalStatus === "REJECTED" ? "已暂不采用" : "待确认";
});
</script>

<template>
  <section v-if="loading" class="page-state" aria-live="polite">
    <p class="eyebrow">任务定义</p>
    <h1>正在读取任务定义</h1>
    <p>示例提案尚未被接受或委托。</p>
  </section>
  <section v-else-if="error" class="page-state page-state--error" role="alert">
    <p class="eyebrow">任务定义</p>
    <h1>暂时无法显示任务定义</h1>
    <p>{{ error }}</p>
    <button class="secondary-button" type="button" @click="load"><RotateCcw aria-hidden="true" />重新读取</button>
  </section>
  <section v-else-if="!project" class="page-state">
    <p class="eyebrow">任务定义</p>
    <h1>尚未提供任务定义示例</h1>
    <p>这个路由对象没有对应的 Skill fixture，页面不会回退读取或写入其他任务的定义。</p>
  </section>
  <section v-else class="skill-page">
    <div class="page-layout">
      <div class="page-primary">
        <p class="eyebrow">{{ project.task.title }}</p>
        <p class="page-lede">{{ project.task.description }}</p>
        <h1>先说清楚，怎样才算完成</h1>
        <p class="metadata-row">
          任务状态：{{ taskStatusLabels[project.task.status] }}
          <span aria-hidden="true">|</span>
          执行模式：{{ interactionModeLabels[project.task.mode] }}
          <span aria-hidden="true">|</span>
          当前执行者：{{ executorLabels[project.task.executor] }}
        </p>

        <section class="surface-panel thought-panel" aria-labelledby="original-intent">
          <h2 id="original-intent">你的原始想法</h2>
          <blockquote>{{ project.task.originalIntent }}</blockquote>
        </section>

        <section class="surface-panel definition-panel" aria-labelledby="definition-heading">
          <div class="section-heading-row">
            <h2 id="definition-heading">
              建议的任务定义
              <span class="status-chip" :class="project.task.proposalStatus === 'PENDING' ? 'status-chip--warning' : 'status-chip--neutral'">{{ proposalLabel }}</span>
            </h2>
            <button v-if="!editing" class="text-button" type="button" data-testid="definition-edit" @click="beginEdit">
              <Pencil aria-hidden="true" />修改建议
            </button>
          </div>

          <form v-if="editing" class="edit-form definition-form" data-testid="definition-edit-form" @submit.prevent="acceptDefinition">
            <label>
              任务目标
              <textarea v-model="draft.objective" name="task-objective" rows="3"></textarea>
            </label>
            <label>
              预期结果
              <textarea v-model="draft.expectedResult" name="task-result" rows="3"></textarea>
            </label>
            <fieldset>
              <legend>验收条件</legend>
              <label v-for="(_, index) in draft.acceptanceCriteria" :key="index">
                条件 {{ index + 1 }}
                <input v-model="draft.acceptanceCriteria[index]" :name="`criterion-${index}`" />
              </label>
              <p class="helper-text">验收条件只作文字修改；降低或删除必需条件需要另行变更验收标准。</p>
            </fieldset>
            <label>
              输入资料
              <input v-model="draft.inputSource" name="task-source" />
            </label>
            <div class="form-actions">
              <button class="primary-button" type="submit" :disabled="submitting">{{ submitting ? '正在接受' : '接受这份定义' }}</button>
              <button class="text-button" type="button" :disabled="submitting" @click="abandonEdit">放弃修改</button>
            </div>
          </form>

          <dl v-else class="definition-list">
            <div>
              <dt>任务目标</dt>
              <dd>{{ draft.objective }}</dd>
            </div>
            <div>
              <dt>预期结果</dt>
              <dd>{{ draft.expectedResult }}</dd>
            </div>
            <div>
              <dt>验收条件</dt>
              <dd><ul><li v-for="criterion in draft.acceptanceCriteria" :key="criterion">{{ criterion }}</li></ul></dd>
            </div>
            <div>
              <dt>输入资料</dt>
              <dd><button class="inline-link" type="button" @click="showSource('research-notes-v2')">{{ draft.inputSource }}<ChevronRight aria-hidden="true" /></button></dd>
            </div>
            <div>
              <dt>建议方式</dt>
              <dd>{{ draft.suggestedMode }}</dd>
            </div>
          </dl>
        </section>
      </div>

      <ResponsiveRail label="查看确认区" title="确认任务定义">
        <div class="rail-content">
          <h2>确认任务定义</h2>
          <p class="rail-intro">基于任务 v{{ project.task.revision }}，接受后形成新修订。</p>
          <hr />
          <h3>来源与依据</h3>
          <dl class="rail-definition-list">
            <div><dt>当前任务</dt><dd>v{{ project.task.revision }}</dd></div>
            <div><dt>项目资料</dt><dd><button class="inline-link" type="button" @click="showSource('research-notes-v2')">项目研究笔记 v2</button></dd></div>
          </dl>
          <p v-if="receipt" class="receipt-message" role="status">{{ receipt }}</p>
          <p v-if="actionError" class="action-error" role="alert">{{ actionError.message }}</p>
          <button
            class="primary-button primary-button--wide"
            type="button"
            data-testid="definition-accept"
            :disabled="!canAccept"
            @click="acceptDefinition"
          >
            {{ submitting ? '正在接受' : '接受这份定义' }}
          </button>
          <p v-if="acceptBlockedReason" class="disabled-reason" data-testid="definition-accept-reason">
            <Info aria-hidden="true" />{{ acceptBlockedReason }}
          </p>
          <button class="secondary-button secondary-button--wide" type="button" :disabled="submitting || editing" @click="beginEdit"><Pencil aria-hidden="true" />修改建议</button>
          <button class="text-button text-button--center" type="button" :disabled="submitting" data-testid="definition-reject" @click="rejectDefinition"><X aria-hidden="true" />暂不采用</button>
          <hr />
          <p class="helper-text">接受定义后仍需单独开始任务。AI 委托需要另行确认，接受提案不会改变执行权。</p>
          <RouterLink class="text-link" to="/tasks/task-evaluation-metrics?skill=verification">查看验收方案<ChevronRight aria-hidden="true" /></RouterLink>
        </div>
      </ResponsiveRail>
    </div>
    <SourceDetailDialog v-model="sourceOpen" :source="selectedSource" />
  </section>
</template>
