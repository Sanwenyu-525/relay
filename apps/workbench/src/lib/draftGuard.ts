/**
 * 局部导航（如 skill 查询切换）不触发路由离开守卫，
 * 同页讨论、编辑与判断可以同时存在，各自注册保护，供页壳统一检查。
 */
export interface DraftGuard {
  hasUnsavedChanges: () => boolean;
  discard: () => void;
  pendingCommandId?: () => string | null;
  /**
   * 用户在守卫弹层明确选择「保留并继续编辑」后，把编辑焦点还给触发保护的编辑器。
   * 实现只允许作用于仍存活、可编辑的目标：编辑器已卸载或不可编辑时退到容器内
   * 仍可聚焦的元素或静默放弃，不聚焦已卸载节点、不抛错、不重试。
   * 没有可续写编辑器的守卫（如纯命令待核对）不必实现，弹层维持默认回焦。
   */
  restoreFocus?: () => void;
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
  },
  restoreFocus: () => {
    // 只把焦点交还给确实拥有未保存内容的守卫：脏的是别的面板（如产物编辑）时，
    // 讨论输入器不抢焦点，维持弹层默认回焦；没有实现恢复回调的守卫照旧跳过。
    for (const guard of guards) {
      if (!guard.hasUnsavedChanges()) continue;
      guard.restoreFocus?.();
    }
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
