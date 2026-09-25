import { ref } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { currentDraftGuard, hasUnsavedDraft } from "./draftGuard";

/**
 * 局部导航（skill 查询切换）与路由离开共用同一套未保存草稿处理：
 * 保留编辑则留在原地，丢弃草稿才继续目标导航。
 */
export function useSkillNavigation() {
  const route = useRoute();
  const router = useRouter();
  const leaveDialogOpen = ref(false);
  const pendingHref = ref<string | null>(null);
  let leaveResolver: ((allow: boolean) => void) | null = null;

  function tabHref(key: string): string {
    return router.resolve({ path: route.path, query: { ...route.query, skill: key } }).href;
  }

  function onTabClick(event: MouseEvent, key: string, activeKey: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    if (key === activeKey) {
      return;
    }
    const href = tabHref(key);
    if (!hasUnsavedDraft()) {
      void router.push(href);
      return;
    }
    pendingHref.value = href;
    leaveDialogOpen.value = true;
  }

  function keepEditing(): void {
    leaveDialogOpen.value = false;
    pendingHref.value = null;
    leaveResolver?.(false);
    leaveResolver = null;
  }

  function discardAndContinue(): void {
    currentDraftGuard()?.discard();
    leaveDialogOpen.value = false;
    const href = pendingHref.value;
    pendingHref.value = null;
    if (leaveResolver) {
      const resolve = leaveResolver;
      leaveResolver = null;
      resolve(true);
      return;
    }
    if (href) {
      void router.push(href);
    }
  }

  onBeforeRouteLeave(() => {
    if (!hasUnsavedDraft()) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      pendingHref.value = null;
      leaveResolver = resolve;
      leaveDialogOpen.value = true;
    });
  });

  return { leaveDialogOpen, tabHref, onTabClick, keepEditing, discardAndContinue };
}