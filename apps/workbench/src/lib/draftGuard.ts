/**
 * 局部导航（如 skill 查询切换）不触发路由离开守卫，
 * 因此未保存草稿由当前页面注册到全局注册表，供页壳在切换前询问。
 */
export interface DraftGuard {
  hasUnsavedChanges: () => boolean;
  discard: () => void;
}

let activeGuard: DraftGuard | null = null;

export function setDraftGuard(guard: DraftGuard): void {
  activeGuard = guard;
}

export function clearDraftGuard(guard: DraftGuard): void {
  if (activeGuard === guard) {
    activeGuard = null;
  }
}

export function currentDraftGuard(): DraftGuard | null {
  return activeGuard;
}

export function hasUnsavedDraft(): boolean {
  return activeGuard?.hasUnsavedChanges() ?? false;
}
