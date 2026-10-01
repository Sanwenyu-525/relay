/**
 * 局部导航（如 skill 查询切换）不触发路由离开守卫，
 * 同页讨论、编辑与判断可以同时存在，各自注册保护，供页壳统一检查。
 */
export interface DraftGuard {
  hasUnsavedChanges: () => boolean;
  discard: () => void;
  pendingCommandId?: () => string | null;
}

const guards = new Set<DraftGuard>();
const combinedGuard: DraftGuard = {
  hasUnsavedChanges: () => [...guards].some((guard) => guard.hasUnsavedChanges() || guard.pendingCommandId?.() != null),
  discard: () => {
    if (combinedGuard.pendingCommandId?.()) return;
    for (const guard of guards) guard.discard();
  },
  pendingCommandId: () => {
    for (const guard of guards) {
      const commandId = guard.pendingCommandId?.();
      if (commandId) return commandId;
    }
    return null;
  }
};

export function setDraftGuard(guard: DraftGuard): void {
  guards.add(guard);
}

export function clearDraftGuard(guard: DraftGuard): void {
  guards.delete(guard);
}

export function currentDraftGuard(): DraftGuard | null {
  return guards.size > 0 ? combinedGuard : null;
}

export function hasUnsavedDraft(): boolean {
  return guards.size > 0 && combinedGuard.hasUnsavedChanges();
}
