<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { ArrowRight, Archive, Info, Plus, RotateCcw, Search } from "lucide-vue-next";
import ResponsiveRail from "../components/ResponsiveRail.vue";
import CreateProjectView from "./CreateProjectView.vue";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { phaseLabel, projectTypeLabels } from "../lib/labels";
import { takeCreationFlash } from "../lib/navigationFlash";
import { relayConnection } from "../lib/relayConnection";
import type { FixtureError, ProjectSummary } from "../types";

const route = useRoute();
const router = useRouter();

const projects = ref<ProjectSummary[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);
const selectedId = ref<string | null>(null);
const search = ref("");
const receipt = ref<string | null>(null);
const importStatus = ref<"none" | "SUCCEEDED" | "FAILED">("none");
const actionError = ref<string | null>(null);
const submitting = ref(false);
let requestVersion = 0;
let disposed = false;
let hasLoaded = false;

const mode = computed(() => fixtureModeFromQuery(route.query));
const creating = computed(() => route.query.view === "create");
const archivedTab = computed(() => route.query.archived === "1");
const live = computed(() => relayConnection.mode === "live");
const liveProjectId = ref("");

const activeProjects = computed(() => projects.value.filter((project) => !project.archived));
const archivedProjects = computed(() => projects.value.filter((project) => project.archived));

const visibleProjects = computed(() => {
  const source = archivedTab.value ? archivedProjects.value : activeProjects.value;
  const needle = search.value.trim().toLowerCase();
  return needle === ""
    ? source
    : source.filter((project) => project.title.toLowerCase().includes(needle));
});

const selected = computed<ProjectSummary | null>(
  () => projects.value.find((project) => project.id === selectedId.value) ?? null
);

function toActionError(caught: unknown, fallback: string): string {
  const fixtureError = caught as FixtureError;
  if (caught instanceof Error && "kind" in caught) {
    return fixtureError.message.trim();
  }
  return caught instanceof Error ? caught.message.trim() : fallback;
}

/**
 * 创建成功后由创建页写入本次导航的交接数据；这里读取一次后立即清掉，
 * 避免刷新页面重复显示一条已经失效的回执。
 */
async function load(): Promise<void> {
  const request = ++requestVersion;
  // 首次读取显示整页加载；归档等后续刷新保留已知内容并标识更新。
  if (hasLoaded) {
    refreshing.value = true;
  } else {
    loading.value = true;
  }
  error.value = null;
  try {
    const response = await fixtureAdapter.listProjects(mode.value);
    if (request !== requestVersion) {
      return;
    }
    projects.value = response;
    hasLoaded = true;
    const flash = takeCreationFlash();
    if (flash) {
      receipt.value = flash.receipt;
      importStatus.value = flash.importStatus;
    }
    const preferred =
      (flash && response.some((project) => project.id === flash.projectId) ? flash.projectId : null) ??
      (response.some((project) => project.id === selectedId.value) ? selectedId.value : null) ??
      response.find((project) => !project.archived)?.id ??
      null;
    selectedId.value = preferred;
  } catch (caught) {
    if (request === requestVersion) {
      error.value = toActionError(caught, "读取示例项目时发生未知错误。");
    }
  } finally {
    if (request === requestVersion) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

watch(
  [mode, live],
  () => {
    // live 模式没有项目列表端点：不读取示例数据，避免把示例项目当真实项目展示。
    if (!live.value) {
      void load();
    }
  },
  { immediate: true }
);
onBeforeUnmount(() => {
  disposed = true;
  requestVersion += 1;
});

function selectProject(project: ProjectSummary): void {
  selectedId.value = project.id;
  receipt.value = null;
  importStatus.value = "none";
  actionError.value = null;
}

function openCreate(): void {
  void router.push({ path: "/projects", query: { view: "create" } });
}

function openLiveProject(): void {
  const id = liveProjectId.value.trim();
  if (id === "") {
    return;
  }
  void router.push({ path: `/projects/${encodeURIComponent(id)}/tasks` });
}

function closeCreate(): void {
  void router.push({ path: "/projects" });
}

async function archiveSelected(): Promise<void> {
  const project = selected.value;
  if (!project || submitting.value || project.archiveBlockedReason) {
    return;
  }
  const request = ++requestVersion;
  submitting.value = true;
  actionError.value = null;
  receipt.value = null;
  try {
    const result = await fixtureAdapter.archiveProject(project.id, mode.value);
    if (disposed || request !== requestVersion) {
      return;
    }
    await load();
    if (disposed) {
      return;
    }
    receipt.value = result.description;
  } catch (caught) {
    if (!disposed) {
      actionError.value = toActionError(caught, "归档示例项目时发生未知错误。");
    }
  } finally {
    if (!disposed) {
      submitting.value = false;
    }
  }
}
</script>

<template>
  <section v-if="creating" class="skill-page">
    <CreateProjectView @cancel="closeCreate" />
  </section>

  <section v-else-if="live" class="skill-page">
    <div class="page-layout">
      <div class="page-primary">
        <div class="list-header">
          <div>
            <h1>项目</h1>
            <p class="page-lede">已连接本机 API。真实读取的项目列表端点尚未实现。</p>
          </div>
          <button class="primary-button" type="button" data-testid="project-create-open" @click="openCreate">
            <Plus aria-hidden="true" />新建项目
          </button>
        </div>

        <p class="warning-callout" role="status" data-testid="projects-live-gap">
          <Info aria-hidden="true" />
          真实 API 目前只有 <code>GET /projects/&#123;id&#125;</code> 与 <code>POST /projects</code>，没有项目列表、归档与资料导入端点。
          因此这里既不显示示例项目，也不伪造一个列表；请用项目 ID 打开，或先创建项目。
        </p>

        <form class="create-form" novalidate @submit.prevent="openLiveProject">
          <label class="field">
            <span class="field-label">用项目 ID 打开</span>
            <input v-model="liveProjectId" name="live-project-id" autocomplete="off" placeholder="Project UUID" />
            <span class="field-hint">项目 ID 来自创建回执，或数据库中的 projects.id。</span>
          </label>
          <div class="form-actions">
            <button class="primary-button" type="submit" data-testid="projects-live-open" :disabled="liveProjectId.trim() === ''">
              打开项目任务
            </button>
          </div>
        </form>
      </div>

      <ResponsiveRail label="查看接入边界" title="已接入与未接入">
        <div class="rail-content">
          <h2>已接入与未接入</h2>
          <p class="rail-intro">以下结论来自 2026-09-21 的接入前对齐，不随页面渲染改变。</p>
          <section class="rail-section">
            <h3>已接入真实命令</h3>
            <p>创建项目、创建任务、标记可开始、开始任务、读取项目与项目任务、按 command ID 查询回执。</p>
          </section>
          <section class="rail-section">
            <h3>仍标记为未接入</h3>
            <p>项目列表与归档、资料导入、全空间任务筛选、四项 Skill 的提案与写入、Run 与 Review。</p>
          </section>
        </div>
      </ResponsiveRail>
    </div>
  </section>

  <section v-else-if="loading" class="page-state" aria-live="polite">
    <p class="eyebrow">项目</p>
    <h1>正在读取项目列表</h1>
    <p>示例数据正在加载，页面尚未提交任何变更。</p>
  </section>

  <section v-else-if="error" class="page-state page-state--error" role="alert">
    <p class="eyebrow">项目</p>
    <h1>暂时无法显示项目</h1>
    <p>{{ error }}</p>
    <button class="secondary-button" type="button" @click="load"><RotateCcw aria-hidden="true" />重新读取</button>
  </section>

  <section v-else class="skill-page">
    <div class="page-layout">
      <div class="page-primary">
        <div class="list-header">
          <div>
            <h1>项目</h1>
            <p class="page-lede">每一个长期目标，都有可继续的下一步。</p>
          </div>
          <button class="primary-button" type="button" data-testid="project-create-open" @click="openCreate">
            <Plus aria-hidden="true" />新建项目
          </button>
        </div>

        <nav class="subnav" aria-label="项目范围">
          <RouterLink
            class="subnav-item"
            :class="{ 'subnav-item--active': !archivedTab }"
            :to="{ path: '/projects' }"
            data-testid="projects-tab-active"
            :aria-current="!archivedTab ? 'page' : undefined"
          >
            进行中 ({{ activeProjects.length }})
          </RouterLink>
          <RouterLink
            class="subnav-item"
            :class="{ 'subnav-item--active': archivedTab }"
            :to="{ path: '/projects', query: { archived: '1' } }"
            data-testid="projects-tab-archived"
            :aria-current="archivedTab ? 'page' : undefined"
          >
            已归档 ({{ archivedProjects.length }})
          </RouterLink>
        </nav>

        <div class="list-toolbar">
          <label class="search-field">
            <Search aria-hidden="true" />
            <span class="visually-hidden">按项目名称搜索</span>
            <input v-model="search" type="search" name="project-search" placeholder="搜索项目" />
          </label>
        </div>

        <p v-if="refreshing" class="helper-text" role="status">正在更新项目列表，已显示的内容保持可见。</p>

        <div v-if="visibleProjects.length === 0" class="page-state">
          <p>
            {{
              search.trim()
                ? `当前范围没有匹配“${search.trim()}”的项目。`
                : archivedTab
                  ? "还没有已归档的项目；归档后仍会保留历史事实。"
                  : "还没有进行中的项目。"
            }}
          </p>
          <button v-if="!archivedTab && !search.trim()" class="primary-button" type="button" @click="openCreate">
            <Plus aria-hidden="true" />新建项目
          </button>
          <button v-else class="secondary-button" type="button" @click="search = ''">清除搜索</button>
        </div>

        <div v-else class="table-scroll">
          <div class="data-table">
            <div class="data-row data-row--head data-row--projects" aria-hidden="true">
              <span class="data-cell">项目</span>
              <span class="data-cell">类型</span>
              <span class="data-cell">当前阶段</span>
              <span class="data-cell">下一步</span>
            </div>
            <ul class="data-list">
              <li v-for="project in visibleProjects" :key="project.id">
                <button
                  class="data-row data-row--projects data-row--interactive"
                  :class="{ 'data-row--selected': project.id === selectedId }"
                  type="button"
                  :aria-current="project.id === selectedId ? 'true' : undefined"
                  :data-testid="`project-row-${project.id}`"
                  @click="selectProject(project)"
                >
                  <span class="data-cell">
                    <strong>{{ project.title }}</strong>
                    <small>{{ project.goal }}</small>
                  </span>
                  <span class="data-cell data-cell--meta">{{ projectTypeLabels[project.projectType] }}</span>
                  <span class="data-cell data-cell--meta">{{ phaseLabel(project.phase) }}</span>
                  <span class="data-cell data-cell--meta">{{ project.nextAction ?? "尚未明确" }}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>

        <p class="list-footer-note">
          <Info aria-hidden="true" />
          项目阶段由你显式设置，系统不按任务完成数量自动跳阶段；列表中的下一步来自项目状态。
        </p>
      </div>

      <ResponsiveRail label="查看项目摘要" :title="selected ? selected.title : '项目摘要'">
        <div class="rail-content">
          <h2>{{ selected ? selected.title : "项目摘要" }}</h2>
          <template v-if="selected">
            <p class="project-summary-kicker">当前项目</p>
            <p class="rail-intro">{{ selected.summary }}</p>

            <section class="project-state-summary" aria-label="项目当前状态">
              <span>当前阶段</span>
              <strong>{{ phaseLabel(selected.phase) }}</strong>
              <small>状态修订 v{{ selected.stateRevision }} · 待审 {{ selected.pendingReviewCount }} 项</small>
            </section>

            <section class="rail-section">
              <h3>明确目标</h3>
              <p>{{ selected.goal }}</p>
            </section>

            <p v-if="receipt" class="receipt-message" role="status">{{ receipt }}</p>
            <p v-if="importStatus !== 'none'" class="helper-text" data-testid="project-import-status">
              <Info aria-hidden="true" />
              初始资料导入：{{ importStatus === "SUCCEEDED" ? "已完成登记，导入成功不代表内容已经验证。" : "失败，项目仍然保留，可稍后重新导入。" }}
            </p>
            <p v-if="actionError" class="action-error" role="alert">{{ actionError }}</p>

            <RouterLink
              v-if="!selected.archived"
              class="primary-button primary-button--wide"
              data-testid="project-open"
              :to="`/projects/${selected.id}`"
            >
              打开项目
              <ArrowRight aria-hidden="true" />
            </RouterLink>
            <template v-else>
              <button class="primary-button primary-button--wide" type="button" disabled>打开项目</button>
              <p class="disabled-reason" data-testid="project-archived-reason">
                <Info aria-hidden="true" />已归档项目在本轮交互预览中只读；恢复入口尚未接入。
              </p>
            </template>

            <template v-if="!selected.archived">
              <button
                class="secondary-button secondary-button--wide"
                type="button"
                data-testid="project-archive"
                :disabled="submitting || Boolean(selected.archiveBlockedReason)"
                @click="archiveSelected"
              >
                <Archive aria-hidden="true" />{{ submitting ? "正在归档" : "归档项目" }}
              </button>
              <p v-if="selected.archiveBlockedReason" class="disabled-reason" data-testid="project-archive-reason">
                <Info aria-hidden="true" />{{ selected.archiveBlockedReason }}
              </p>
              <p v-else class="helper-text">归档只改变项目状态并保留历史；不会删除任务、产物或验收记录。</p>
            </template>
          </template>
          <p v-else class="rail-intro">请先在列表中选择一个项目，这里会显示它的目标与当前状态。</p>
        </div>
      </ResponsiveRail>
    </div>
  </section>
</template>
