<script setup lang="ts">
import { RouterLink } from "vue-router";

const props = defineProps<{
  projectId: string;
  active: "overview" | "tasks" | "knowledge";
}>();

/**
 * 项目内导航使用真实链接而不是 tablist：这三项对应不同路由，
 * 不给路由伪装同页 Tab 语义。
 */
const items = [
  { key: "overview", label: "总览", path: "" },
  { key: "tasks", label: "任务", path: "/tasks" },
  { key: "knowledge", label: "资料", path: "/knowledge" }
] as const;

function to(path: string): string {
  return `/projects/${props.projectId}${path}`;
}
</script>

<template>
  <nav class="subnav" aria-label="项目内页面">
    <RouterLink
      v-for="item in items"
      :key="item.key"
      class="subnav-item"
      :class="{ 'subnav-item--active': item.key === active }"
      :to="to(item.path)"
      :aria-current="item.key === active ? 'page' : undefined"
    >
      {{ item.label }}
    </RouterLink>
  </nav>
</template>
