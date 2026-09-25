<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { AlertTriangle, Circle, CircleEllipsis, FileText, Info, Pencil, RotateCcw, Save } from "lucide-vue-next";
import ResponsiveRail from "../components/ResponsiveRail.vue";
import SourceDetailDialog from "../components/SourceDetailDialog.vue";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { compareDecimalRevisions } from "../lib/decimalRevision";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import type { ProjectSnapshot, SourceReference, VerificationCheck } from "../types";

const route = useRoute();
const project = ref<ProjectSnapshot | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const editing = ref(false);
const saving = ref(false);
const savedMessage = ref<string | null>(null);
const note = ref("");
const savedNote = ref("");
const selectedSource = ref<SourceReference | null>(null);
const sourceOpen = ref(false);
let requestVersion = 0;

const mode = computed(() => fixtureModeFromQuery(route.query));
const taskId = computed(() => String(route.params.id));
const checks = computed(() => project.value?.verification.checks ?? []);
const missingCapability = computed(() => checks.value.some((check) => check.status === "MISSING_CAPABILITY"));
const hasNoteDraft = computed(() => editing.value && note.value !== savedNote.value);
const baselineStale = computed(
  () =>
    project.value !== null &&
    compareDecimalRevisions(project.value.verification.taskRevision, project.value.task.revision) < 0
);

const draftGuard: DraftGuard = {
  hasUnsavedChanges: () => hasNoteDraft.value,
  discard: () => {
    note.value = savedNote.value;
    editing.value = false;
  }
};

const applyReason = computed(() => {
  if (!project.value) {
    return "";
  }
  if (baselineStale.value) {
    return `本方案建议基于任务 v${project.value.verification.taskRevision}，任务已接受 v${project.value.task.revision} 修订；需要按新修订重新生成方案后再应用。`;
  }
  if (missingCapability.value) {
    return "必需检查的执行方式尚未明确：语义核对缺少已登记的可用检查器。";
  }
  return "本轮为交互预览，应用为检查方案的写入口尚未接入；保存建议不会让检查计划生效。";
});

async function load(): Promise<void> {
  const request = ++requestVersion;
  loading.value = true;
  error.value = null;
  savedMessage.value = null;
  try {
    const response = await fixtureAdapter.loadTask(taskId.value, mode.value);
    if (request !== requestVersion) {
      return;
    }
    project.value = response;
    note.value = response?.verification.savedNote ?? "";
    savedNote.value = note.value;
    editing.value = false;
  } catch (caught) {
    if (request === requestVersion) {
      error.value = caught instanceof Error ? caught.message.trim() : "读取验收方案失败。";
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

function statusText(check: VerificationCheck): string {
  if (check.status === "MISSING_CAPABILITY") {
    return "缺少可用检查器";
  }
  if (check.status === "HUMAN_PENDING") {
    return "待人工检查";
  }
  return "未运行";
}

function statusClass(check: VerificationCheck): string {
  return check.status === "MISSING_CAPABILITY" ? "warning" : "neutral";
}

function beginEdit(): void {
  editing.value = true;
  savedMessage.value = null;
}

function cancelEdit(): void {
  editing.value = false;
  savedMessage.value = "已保留待确认说明草稿，尚未保存为建议。";
}

async function saveSuggestion(): Promise<void> {
  if (saving.value) {
    return;
  }
  const request = ++requestVersion;
  saving.value = true;
  savedMessage.value = null;
  try {
    const receipt = await fixtureAdapter.saveVerificationSuggestion(taskId.value, note.value.trim());
    if (request !== requestVersion) {
      return;
    }
    const response = await fixtureAdapter.loadTask(taskId.value, mode.value);
    if (request !== requestVersion) {
      return;
    }
    project.value = response;
    note.value = response?.verification.savedNote ?? note.value;
    savedNote.value = note.value;
    editing.value = false;
    savedMessage.value = receipt.description;
  } catch (caught) {
    if (request === requestVersion) {
      error.value = caught instanceof Error ? caught.message.trim() : "保存建议失败。";
    }
  } finally {
    if (request === requestVersion) {
      saving.value = false;
    }
  }
}

function saveOrEdit(): void {
  if (editing.value) {
    void saveSuggestion();
    return;
  }
  beginEdit();
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
</script>

<template>
  <section v-if="loading" class="page-state" aria-live="polite">
    <p class="eyebrow">验收方案</p>
    <h1>正在读取检查建议</h1>
    <p>尚未运行任何检查，也没有形成有效 CheckPlan。</p>
  </section>
  <section v-else-if="error" class="page-state page-state--error" role="alert">
    <p class="eyebrow">验收方案</p>
    <h1>暂时无法显示检查建议</h1>
    <p>{{ error }}</p>
    <button class="secondary-button" type="button" @click="load"><RotateCcw aria-hidden="true" />重新读取</button>
  </section>
  <section v-else-if="!project" class="page-state">
    <p class="eyebrow">验收方案</p>
    <h1>尚未提供验收方案示例</h1>
    <p>这个路由对象没有对应的 Skill fixture，页面不会回退读取或写入其他任务的检查建议。</p>
  </section>
  <section v-else class="skill-page">
    <div class="page-layout">
      <div class="page-primary">
        <p class="eyebrow">生成验收方案</p>
        <h1>把完成标准，变成可核对的依据。</h1>
        <p class="page-lede">基于验收标准，梳理检查项与检查方式，便于后续实施与审查。</p>
        <p class="metadata-row">
          任务：v{{ project.verification.taskRevision }}
          <span aria-hidden="true">|</span>
          验收标准：v{{ project.verification.acceptanceRevision }}
          <span aria-hidden="true">|</span>
          方案建议：v{{ project.verification.proposalVersion }}
          <span aria-hidden="true">|</span>
          状态：<span class="status-chip status-chip--warning">{{ baselineStale ? '基线已过期' : '待确认' }}</span>
        </p>
        <div v-if="baselineStale" class="warning-callout" role="status" data-testid="verification-stale">
          <AlertTriangle aria-hidden="true" />
          <p>
            本方案建议基于任务 v{{ project.verification.taskRevision }}，当前任务已接受 v{{ project.task.revision }} 修订；
            需要按新修订重新生成方案，旧建议不能直接应用。
          </p>
        </div>

        <section class="verification-section" aria-labelledby="verification-checks">
          <h2 id="verification-checks">建议检查项</h2>
          <p>根据验收标准与任务目标，建议以下检查项及其检查方式。确认后才能应用为检查方案。</p>
          <div class="check-table" role="table" aria-label="建议的检查项">
            <div class="check-table-row check-table-row--head" role="row">
              <span role="columnheader">检查项</span><span role="columnheader">方式</span><span role="columnheader">当前状态</span>
            </div>
            <div v-for="check in checks" :key="check.id" class="check-table-row" role="row">
              <strong role="cell">{{ check.title }}</strong>
              <span role="cell">{{ check.method }}</span>
              <span role="cell" class="check-status" :class="`check-status--${statusClass(check)}`">
                <AlertTriangle v-if="check.status === 'MISSING_CAPABILITY'" aria-hidden="true" />
                <CircleEllipsis v-else-if="check.status === 'HUMAN_PENDING'" aria-hidden="true" />
                <Circle v-else aria-hidden="true" />
                {{ statusText(check) }}
              </span>
            </div>
          </div>
          <p class="helper-text">“方式”是建议的检查方式，“当前状态”是检查结果状态；缺少检查器和待人工检查都不等于通过。</p>
          <div v-if="missingCapability" class="warning-callout" role="status" data-testid="verification-warning">
            <AlertTriangle aria-hidden="true" />
            <p>语义核对缺少可用检查器，需要补齐能力或另行确认合规的检查方式。不得跳过必需检查。</p>
          </div>
        </section>

        <section v-if="editing" class="surface-panel verification-edit" aria-labelledby="edit-plan">
          <h2 id="edit-plan">修改检查建议</h2>
          <p>必需检查项不可删除或降级，验收标准保持 v{{ project.verification.acceptanceRevision }} 不变；此处只能补充「待确认说明」。</p>
          <label>
            待确认说明
            <textarea v-model="note" name="verification-note" rows="4" placeholder="例如：等待登记语义核对检查器后重新预览。"></textarea>
          </label>
          <div class="form-actions">
            <button class="primary-button" type="button" data-testid="verification-save" :disabled="saving" @click="saveSuggestion">
              <Save aria-hidden="true" />{{ saving ? '正在保存' : '保存为待确认建议' }}
            </button>
            <button class="text-button" type="button" :disabled="saving" @click="cancelEdit">取消</button>
          </div>
        </section>
      </div>

      <ResponsiveRail label="查看确认区" title="先确认检查方式">
        <div class="rail-content">
          <h2>先确认检查方式</h2>
          <p class="rail-intro">验收标准 v{{ project.verification.acceptanceRevision }} 保持不变，请确认各检查项的检查方式。</p>
          <hr />
          <h3>相关来源</h3>
          <button class="source-button" type="button" @click="showSource('result-definition-v2')"><FileText aria-hidden="true" />结果定义 v2</button>
          <button class="source-button" type="button" @click="showSource('acceptance-v2')"><FileText aria-hidden="true" />验收标准 v2</button>
          <button class="source-button" type="button" @click="showSource('checker-registry-v1')"><FileText aria-hidden="true" />当前可用检查器 v1</button>
          <button class="primary-button primary-button--wide" type="button" :disabled="saving" @click="beginEdit"><Pencil aria-hidden="true" />修改检查方案</button>
          <button class="secondary-button secondary-button--wide" type="button" data-testid="verification-save-rail" :disabled="saving" @click="saveOrEdit">
            <Save aria-hidden="true" />{{ saving ? '正在保存' : '保存为待确认建议' }}
          </button>
          <button class="primary-button primary-button--wide" type="button" data-testid="verification-apply" disabled :aria-describedby="'verification-disabled-reason'">应用为检查方案</button>
          <p id="verification-disabled-reason" class="disabled-reason" data-testid="verification-apply-reason">
            <Info aria-hidden="true" />{{ applyReason }}
          </p>
          <p v-if="savedMessage" class="receipt-message" role="status">{{ savedMessage }}</p>
          <hr />
          <p class="helper-text">检查方案不是检查结果，检查通过也不等于任务完成。</p>
        </div>
      </ResponsiveRail>
    </div>
    <SourceDetailDialog v-model="sourceOpen" :source="selectedSource" />
  </section>
</template>
