/**
 * 局部导航（如 skill 查询切换）不触发路由离开守卫，
 * 同页讨论、编辑与判断可以同时存在，各自注册保护，供页壳统一检查。
 */
export interface DraftGuard {
  hasUnsavedChanges: () => boolean;
  /** 可由用户明确丢弃的普通草稿；pending 命令不是草稿。未提供时，仅在本守卫没有 pending 时回落到 hasUnsavedChanges。 */
  hasDraftChanges?: () => boolean;
  discard: () => void;
  /** 在用户明确选择保留 pending 并离开时，仅丢弃普通草稿，不能解除任何命令保护。 */
  discardDrafts?: () => void;
  pendingCommandId?: () => string | null;
  pendingCommandIds?: () => readonly string[];
  /**
   * 待核对命令已按 API/Workspace 作用域持久化、回到本页（或本页的恢复区）仍能继续
   * 核对时为 true。App 守卫弹层据此提供「离开并保留待核对」出口；默认 false：
   * 没有恢复途径的守卫维持只拦不放（#20），避免离页即丢命令身份后换 ID 重发。
   */
  pendingRecoversAfterLeave?: () => boolean;
  /** 待核对命令在窗口关闭后仍可从本机恢复。 */
  pendingRecoversAfterRestart?: () => boolean;
  /**
   * 用户在守卫弹层明确选择「保留并继续编辑」后，把编辑焦点还给触发保护的编辑器。
   * 实现只允许作用于仍存活、可编辑的目标：编辑器已卸载或不可编辑时退到容器内
   * 仍可聚焦的元素或静默放弃，不聚焦已卸载节点、不抛错、不重试。
   * 没有可续写编辑器的守卫（如纯命令待核对）不必实现，弹层维持默认回焦。
   */
  restoreFocus?: () => void;
}

const guards = new Set<DraftGuard>();
function hasDraftChanges(guard: DraftGuard): boolean {
  return guard.hasDraftChanges?.() ?? (guard.pendingCommandId?.() == null && guard.hasUnsavedChanges());
}

const combinedGuard: DraftGuard = {
  hasUnsavedChanges: () => [...guards].some((guard) => guard.hasUnsavedChanges() || guard.pendingCommandId?.() != null),
  hasDraftChanges: () => [...guards].some(hasDraftChanges),
  discard: () => {
    if ([...guards].some((guard) => guard.pendingCommandId?.() != null)) return;
    for (const guard of guards) if (hasDraftChanges(guard)) guard.discard();
  },
  discardDrafts: () => {
    for (const guard of guards) if (hasDraftChanges(guard)) {
      (guard.discardDrafts ?? guard.discard)();
    }
  },
  pendingCommandId: () => {
    for (const guard of guards) {
      const commandId = guard.pendingCommandId?.();
      if (commandId) return commandId;
    }
    return null;
  },
  pendingCommandIds: () => [...new Set([...guards].flatMap((guard) => {
    const ids = guard.pendingCommandIds?.() ?? [guard.pendingCommandId?.() ?? null];
    return ids.filter((id): id is string => id !== null && id !== "");
  }))],
  // 离开出口只对「所有在拦的待核对命令都能在离开后继续核对」的情况开放：
  // 任一守卫没有恢复途径，就保持整体只拦不放。
  pendingRecoversAfterLeave: () => {
    const pending = [...guards].filter((guard) => guard.pendingCommandId?.() != null);
    return pending.length > 0 && pending.every((guard) => guard.pendingRecoversAfterLeave?.() ?? false);
  },
  pendingRecoversAfterRestart: () => {
    const pending = [...guards].filter((guard) => guard.pendingCommandId?.() != null);
    return pending.length > 0 && pending.every((guard) => guard.pendingRecoversAfterRestart?.() ?? false);
  },
  restoreFocus: () => {
    // 只把焦点交还给确实拥有未保存内容的守卫：脏的是别的面板（如产物编辑）时，
    // 讨论输入器不抢焦点，维持弹层默认回焦；没有实现恢复回调的守卫照旧跳过。
    for (const guard of guards) {
      if (!hasDraftChanges(guard)) continue;
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
