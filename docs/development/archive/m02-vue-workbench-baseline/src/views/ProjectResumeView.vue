<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { CheckCircle2, ChevronRight, Circle, CircleEllipsis, FileText, Info, RotateCcw, TriangleAlert } from "lucide-vue-next";
import ResponsiveRail from "../components/ResponsiveRail.vue";
import SourceDetailDialog from "../components/SourceDetailDialog.vue";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import type { ProjectSnapshot, ResumeProgressItem, ResumeSuggestion, SourceReference } from "../types";

const route = useRoute();
const router = useRouter();
const project = ref<ProjectSnapshot | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);
const selectedSource = ref<SourceReference | null>(null);
const sourceOpen = ref(false);
let requestVersion = 0;

const resumeSourceIds = ["project-state-v4", "task-list-v1", "literature-review-v3", "acceptance-v2", "review-record-v1"];

const mode = computed(() => fixtureModeFromQuery(route.query));
const projectId = computed(() => String(route.params.id));
const resume = computed(() => project.value?.resume ?? null);
const railSources = computed(() =>
  resumeSourceIds
    .map((id) => project.value?.sources.find((source) => source.id === id) ?? null)
    .filter((source): source is SourceReference => source !== null)
);

async function load(): Promise<void> {
  const request = ++requestVersion;
  loading.value = true;
  error.value = null;
  try {
    const response = await fixtureAdapter.loadProject(projectId.value, mode.value);
    if (request !== requestVersion) {
      return;
    }
    project.value = response;
  } catch (caught) {
    if (request === requestVersion) {
      error.value = caught instanceof Error ? caught.message.trim() : "读取恢复摘要失败。";
    }
  } finally {
    if (request === requestVersion) {
      loading.value = false;
    }
  }
}

watch([projectId, mode], load, { immediate: true });
onBeforeUnmount(() => {
  requestVersion += 1;
});

async function refreshSummary(): Promise<void> {
  if (refreshing.value) {
    return;
  }
  const request = ++requestVersion;
  refreshing.value = true;
  error.value = null;
  try {
    const response = await fixtureAdapter.refreshResume(projectId.value, mode.value);
    if (request === requestVersion) {
      project.value = response;
    }
  } catch (caught) {
    if (request === requestVersion) {
      error.value = caught instanceof Error ? caught.message.trim() : "刷新摘要失败。";
    }
  } finally {
    if (request === requestVersion) {
      refreshing.value = false;
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

function progressIcon(item: ResumeProgressItem) {
  return item.state === "completed" ? CheckCircle2 : item.state === "review" ? CircleEllipsis : Circle;
}

function progressLabel(item: ResumeProgressItem): string {
  return item.state === "completed" ? "已完成" : item.state === "review" ? "待你判断" : "可开始";
}

function openTarget(target: ResumeProgressItem["target"]): void {
  if (target.kind === "task") {
    void router.push(`/tasks/${target.taskId}?skill=definition`);
    return;
  }
  showSource(target.sourceId);
}

function openSuggestion(suggestion: ResumeSuggestion): void {
  openTarget(suggestion.target);
}
</script>

<template>
  <section v-if="loading" class="page-state" aria-live="polite">
    <p class="eyebrow">继续这个项目</p>
    <h1>正在读取项目上下文</h1>
    <p>读取只读摘要不会开始或恢复执行，也不会改变当前执行者。</p>
  </section>
  <section v-else-if="error && !project" class="page-state page-state--error" role="alert">
    <p class="eyebrow">继续这个项目</p>
    <h1>暂时无法显示恢复摘要</h1>
    <p>{{ error }}</p>
    <button class="secondary-button" type="button" @click="load"><RotateCcw aria-hidden="true" />重新读取</button>
  </section>
  <section v-else-if="!project || !resume" class="page-state">
    <p class="eyebrow">继续这个项目</p>
    <h1>尚未提供项目恢复摘要示例</h1>
    <p>这个路由对象没有对应的 Skill fixture，页面不会回退读取其他项目的历史或下一步。</p>
  </section>
  <section v-else class="skill-page">
    <div class="page-layout">
      <div class="page-primary">
        <p class="eyebrow">{{ project.name }}</p>
        <h1>从这里，接着往前。</h1>
        <p class="metadata-row">只读摘要 <span aria-hidden="true">·</span> 更新于 {{ resume.updatedAt }}</p>
        <p v-if="error" class="action-error" role="alert">{{ error }}</p>

        <section class="resume-section" aria-labelledby="progress-heading">
          <h2 id="progress-heading">当前进展</h2>
          <div class="progress-list">
            <div v-for="item in resume.progress" :key="item.id" class="progress-row" :class="`progress-row--${item.state}`">
              <component :is="progressIcon(item)" aria-hidden="true" />
              <strong>{{ progressLabel(item) }}</strong>
              <span>{{ item.label }}</span>
              <button class="inline-link" type="button" @click="openTarget(item.target)">{{ item.action }}<ChevronRight aria-hidden="true" /></button>
            </div>
          </div>
        </section>

        <section class="resume-section" aria-labelledby="risk-heading">
          <h2 id="risk-heading">需要留意</h2>
          <div v-for="risk in resume.risks" :key="risk.text" class="warning-callout" role="status">
            <TriangleAlert aria-hidden="true" />
            <p>{{ risk.text }}</p>
            <button class="inline-link" type="button" @click="showSource(risk.sourceId)">查看来源<ChevronRight aria-hidden="true" /></button>
          </div>
        </section>

        <section class="resume-section" aria-labelledby="next-heading">
          <h2 id="next-heading">建议的下一步</h2>
          <div class="suggestion-list">
            <button v-for="(suggestion, index) in resume.suggestions" :key="suggestion.id" class="resume-suggestion" type="button" @click="openSuggestion(suggestion)">
              <span class="suggestion-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <strong>{{ suggestion.text }}</strong>
              <small>{{ suggestion.basis }}</small>
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          <p class="helper-text">以上为建议，尚未执行；摘要不会开始或恢复执行。</p>
        </section>
      </div>

      <ResponsiveRail label="查看项目上下文" title="找回项目上下文">
        <div class="rail-content">
          <h2>找回项目上下文</h2>
          <div class="summary-card summary-card--source-list">
            <button v-for="source in railSources" :key="source.id" class="source-button source-button--row" type="button" @click="showSource(source.id)">
              <FileText aria-hidden="true" />
              <span class="source-button-copy">
                <strong>{{ source.title }} {{ source.version }}</strong>
                <small>{{ source.availability === 'available' ? '查看来源' : '来源不可用' }}</small>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          <hr />
          <p v-if="!resume.hasBaseline" class="helper-text">本次没有可用的上次查看基线，不展示变化对比。</p>
          <button class="primary-button primary-button--wide" type="button" @click="showSource('literature-review-v3')">查看待审产物</button>
          <button class="secondary-button secondary-button--wide" type="button" :disabled="refreshing" @click="refreshSummary">
            <RotateCcw aria-hidden="true" />{{ refreshing ? '正在刷新摘要' : '刷新摘要' }}
          </button>
          <p class="disabled-reason"><Info aria-hidden="true" />摘要不会自动开始任务或恢复执行。</p>
        </div>
      </ResponsiveRail>
    </div>
    <SourceDetailDialog v-model="sourceOpen" :source="selectedSource" />
  </section>
</template>
