import { afterEach, expect, it, vi } from "vitest";
import { clearDraftGuard, currentDraftGuard, hasUnsavedDraft, setDraftGuard, type DraftGuard } from "../src/lib/draftGuard";

const registered: DraftGuard[] = [];
afterEach(() => { registered.forEach(clearDraftGuard); registered.length = 0; });
const register = (guard: DraftGuard) => { registered.push(guard); setDraftGuard(guard); return guard; };

it("同页判断不会覆盖讨论草稿，任一未决命令都阻止丢弃全部草稿", () => {
  let draft = "尚未发送的修改意见";
  let pending: string | null = "original-review-command";
  const discardDraft = vi.fn(() => { draft = ""; });
  const discardReview = vi.fn();
  register({ hasUnsavedChanges: () => draft.length > 0, discard: discardDraft });
  const review = register({ hasUnsavedChanges: () => false, pendingCommandId: () => pending, discard: discardReview });
  expect(hasUnsavedDraft()).toBe(true);
  expect(currentDraftGuard()?.pendingCommandId?.()).toBe("original-review-command");
  currentDraftGuard()?.discard();
  expect(discardDraft).not.toHaveBeenCalled();
  expect(discardReview).not.toHaveBeenCalled();
  pending = null;
  clearDraftGuard(review);
  expect(hasUnsavedDraft()).toBe(true);
  expect(currentDraftGuard()?.pendingCommandId?.()).toBeNull();
  currentDraftGuard()?.discard();
  expect(discardDraft).toHaveBeenCalledOnce();
  expect(hasUnsavedDraft()).toBe(false);
});

it("多个未决Owner按各自生命周期移除，清一项不会解除另一项保护", () => {
  const first = register({ hasUnsavedChanges: () => false, discard: vi.fn(), pendingCommandId: () => "first-command" });
  const second = register({ hasUnsavedChanges: () => false, discard: vi.fn(), pendingCommandId: () => "second-command" });
  clearDraftGuard(first);
  expect(currentDraftGuard()?.pendingCommandId?.()).toBe("second-command");
  expect(hasUnsavedDraft()).toBe(true);
  clearDraftGuard(second);
  expect(currentDraftGuard()).toBeNull();
  expect(hasUnsavedDraft()).toBe(false);
});
