<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import AppDialog from "./components/AppDialog.vue";
import AppShell from "./components/AppShell.vue";
import { currentDraftGuard, hasUnsavedDraft } from "./lib/draftGuard";

const route = useRoute();
const router = useRouter();
const leaveDialogOpen = ref(false);
const pendingHref = ref<string | null>(null);
let bypassNextGuard = false;

// 创建页复用列表路由，组件自身不会触发 onBeforeRouteLeave。
// 因此在应用入口统一拦截侧栏、浏览器前后退和 query 变化。
const removeNavigationGuard = router.beforeEach((to) => {
  if (bypassNextGuard) {
    bypassNextGuard = false;
    return true;
  }
  if (!hasUnsavedDraft()) {
    return true;
  }
  pendingHref.value = to.fullPath;
  leaveDialogOpen.value = true;
  return false;
});

function keepEditing(): void {
  leaveDialogOpen.value = false;
  pendingHref.value = null;
}

function discardAndContinue(): void {
  const href = pendingHref.value;
  currentDraftGuard()?.discard();
  leaveDialogOpen.value = false;
  pendingHref.value = null;
  if (href) {
    bypassNextGuard = true;
    void router.push(href);
  }
}

onBeforeUnmount(removeNavigationGuard);
</script>

<template>
  <AppShell>
    <RouterView v-slot="{ Component }">
      <component :is="Component" :key="route.fullPath" />
    </RouterView>
  </AppShell>
  <AppDialog v-model="leaveDialogOpen" title="保留未保存的修改" @close="keepEditing">
    <p>即将离开的页面还有未保存的修改。你可以继续编辑，或丢弃草稿后离开。</p>
    <div class="dialog-actions">
      <button class="secondary-button" type="button" @click="keepEditing">保留并继续编辑</button>
      <button class="danger-button" type="button" @click="discardAndContinue">丢弃草稿并离开</button>
    </div>
  </AppDialog>
</template>
