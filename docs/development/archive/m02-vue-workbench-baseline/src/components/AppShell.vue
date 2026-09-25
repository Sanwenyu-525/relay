<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import {
  Bell,
  BookOpen,
  FolderKanban,
  House,
  Link2,
  ListChecks,
  ListTree,
  Menu,
  Settings
} from "lucide-vue-next";
import AppDialog from "./AppDialog.vue";
import RelayConnectionDialog from "./RelayConnectionDialog.vue";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { relayConnection } from "../lib/relayConnection";

const route = useRoute();
const navigationOpen = ref(false);
const connectionOpen = ref(false);
const chrome = ref(fixtureAdapter.getNavigationLabels());

const dataSourceLabel = computed(() =>
  relayConnection.mode === "live" ? "已连接本机 API" : "示例数据"
);

watch(route, () => {
  chrome.value = fixtureAdapter.getNavigationLabels();
});

const primaryNavigation = computed(() => [
  { label: "今日", to: "/today", icon: House, count: "" },
  { label: "项目", to: "/projects", icon: FolderKanban, count: "" },
  { label: "任务", to: "/tasks", icon: ListChecks, count: "" },
  { label: "知识", to: "/knowledge", icon: BookOpen, count: "" },
  { label: "动态", to: "/activity", icon: ListTree, count: "" },
  { label: "待审", to: "/reviews", icon: Bell, count: relayConnection.mode === "live" ? "" : String(chrome.value.pendingReviewCount) }
]);

const secondaryNavigation = [
  { label: "连接", to: "/connections", icon: Link2 },
  { label: "设置", to: "/settings", icon: Settings }
];

const skillPageNames: Record<string, string> = {
  blueprint: "蓝图预览",
  resume: "继续项目",
  definition: "完善定义",
  verification: "验收方案"
};

/**
 * 面包屑跟随页面真实上下文：全局页使用“工作空间”，
 * 项目/任务页才使用项目名或任务名，避免全局页误用项目上下文。
 */
const breadcrumb = computed(() => {
  const path = route.path;
  if (path === "/projects") {
    return ["工作空间", route.query.view === "create" ? "新建项目" : "项目"];
  }
  if (path === "/tasks") {
    return ["工作空间", route.query.view === "create" ? "新建任务与执行准备" : "任务"];
  }
  if (path === "/reviews") {
    return ["工作空间", "待审"];
  }
  if (path === "/knowledge") {
    return ["工作空间", "知识"];
  }
  if (path.startsWith("/projects/") && route.params.id) {
    // live 模式不使用示例标题，避免把 fixture 名称当成真实对象名。
    const projectTitle =
      relayConnection.mode === "live" ? null : fixtureAdapter.getProjectTitle(String(route.params.id));
    if (path.endsWith("/tasks")) {
      return ["项目", projectTitle ?? "当前项目", "任务"];
    }
    if (path.endsWith("/knowledge")) {
      return ["项目", projectTitle ?? "当前项目", "资料"];
    }
    const skill = String(route.query.skill ?? "");
    return ["项目", projectTitle ?? "当前项目", skillPageNames[skill] ?? skillPageNames.blueprint];
  }
  if (path.startsWith("/tasks/") && route.params.id) {
    const taskTitle =
      relayConnection.mode === "live" ? null : fixtureAdapter.getTaskTitle(String(route.params.id));
    const skill = String(route.query.skill ?? "");
    if (skill === "") {
      return ["任务", taskTitle ?? "当前任务", "任务详情"];
    }
    return ["任务", taskTitle ?? "当前任务", skillPageNames[skill] ?? skillPageNames.definition];
  }
  return ["工作空间"];
});

const todayLabel = computed(() => {
  const now = new Date();
  const date = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now)
    .replaceAll("/", "-");
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now);
  return `${date}　${weekday}`;
});
</script>

<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <div class="app-frame">
    <aside class="app-sidebar">
      <div class="brand" title="示例品牌标识，最终产品显示名待确认">Workflow OS</div>
      <nav class="navigation-list" aria-label="主导航">
        <RouterLink
          v-for="item in primaryNavigation"
          :key="item.label"
          v-slot="{ href, navigate, isActive }"
          :to="item.to"
          custom
        >
          <a :href="href" class="navigation-item" :class="{ 'navigation-item--active': isActive }" :aria-current="isActive ? 'page' : undefined" @click="navigate">
            <component :is="item.icon" aria-hidden="true" />
            <span class="navigation-label">{{ item.label }}</span>
            <span v-if="item.count" class="navigation-count" :aria-label="`${item.label} ${item.count} 项`">{{ item.count }}</span>
          </a>
        </RouterLink>
      </nav>
      <nav class="navigation-list navigation-list--bottom" aria-label="辅助导航">
        <RouterLink
          v-for="item in secondaryNavigation"
          :key="item.label"
          v-slot="{ href, navigate, isActive }"
          :to="item.to"
          custom
        >
          <a :href="href" class="navigation-item" :class="{ 'navigation-item--active': isActive }" :aria-current="isActive ? 'page' : undefined" @click="navigate">
            <component :is="item.icon" aria-hidden="true" />
            <span class="navigation-label">{{ item.label }}</span>
          </a>
        </RouterLink>
      </nav>
    </aside>

    <div class="app-content">
      <header class="app-topbar">
        <button class="mobile-menu-button icon-button" type="button" aria-label="打开导航" @click="navigationOpen = true">
          <Menu aria-hidden="true" />
        </button>
        <nav class="breadcrumbs" aria-label="面包屑">
          <span v-for="(item, index) in breadcrumb" :key="`${index}-${item}`" class="breadcrumb-item">
            <span v-if="index > 0" class="breadcrumb-separator" aria-hidden="true">›</span>
            <span>{{ item }}</span>
          </span>
        </nav>
        <time class="topbar-date">{{ todayLabel }}</time>
        <button
          class="data-source-button"
          type="button"
          data-testid="relay-connection-open"
          :aria-label="`数据来源：${dataSourceLabel}，打开连接设置`"
          @click="connectionOpen = true"
        >
          <Link2 aria-hidden="true" />
          <span>{{ dataSourceLabel }}</span>
        </button>
      </header>
      <main id="main-content" class="app-main" tabindex="-1">
        <slot />
      </main>
    </div>
  </div>

  <p v-if="relayConnection.mode === 'live'" class="demo-notice">
    已连接本机 API · 写入真实 PostgreSQL
  </p>
  <p v-else class="demo-notice">交互预览 · 示例数据，刷新后重置</p>

  <RelayConnectionDialog v-model="connectionOpen" />

  <AppDialog v-model="navigationOpen" title="导航" variant="drawer">
    <nav class="mobile-navigation-list" aria-label="完整导航">
      <RouterLink
        v-for="item in [...primaryNavigation, ...secondaryNavigation]"
        :key="item.label"
        :to="item.to"
        class="mobile-navigation-item"
        @click="navigationOpen = false"
      >
        <component :is="item.icon" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>
  </AppDialog>
</template>
