<script setup lang="ts">
import { ref, watch } from "vue";
import { PanelRightOpen } from "lucide-vue-next";
import AppDialog from "./AppDialog.vue";
import { dialogStack } from "../lib/dialogStack";

defineProps<{
  label: string;
  title: string;
}>();

const drawerOpen = ref(false);

watch(dialogStack, (stack) => {
  // 抽屉之上又打开了来源详情或草稿确认等对话框时，先关闭抽屉，避免两个浮层叠加。
  if (drawerOpen.value && stack.length > 1) {
    drawerOpen.value = false;
  }
});
</script>

<template>
  <aside class="review-rail desktop-rail" :aria-label="title">
    <slot />
  </aside>
  <button class="rail-trigger secondary-button" type="button" data-testid="rail-trigger" @click="drawerOpen = true">
    <PanelRightOpen aria-hidden="true" />
    {{ label }}
  </button>
  <AppDialog v-model="drawerOpen" :title="title" variant="drawer">
    <slot />
  </AppDialog>
</template>