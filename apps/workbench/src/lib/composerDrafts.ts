/**
 * 会话输入器的未发送草稿（本机偏好，不是业务事实）。
 *
 * 2026-10-19 用户指令：切换工作区不再弹「未发送的内容」确认框——那个弹窗拦住的
 * 只是本机还没发出去的文本，却把切换本身卡在两次点击上。改为按作用域把草稿留在本机：
 * 离开不会丢内容，回到原作用域时原样恢复，因此不需要离开保护。
 *
 * 只保存输入框文本。已选资料、技能与判断说明仍是「本次请求的候选输入」，
 * 发送时服务端会重新复核，不能靠本机草稿假装它们已被确认。
 */
const PREFIX = "relay.workbench.composerDraft";
const VERSION = 1;
/** 与输入框 maxLength 一致：超限的旧值按同一上限截断，不把超大文本塞进本机存储。 */
const MAX_LENGTH = 32768;

function storageKey(workspaceId: string, scope: string): string {
  return `${PREFIX}:${VERSION}:${workspaceId}:${scope}`;
}

export function readComposerDraft(workspaceId: string, scope: string): string {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(storageKey(workspaceId, scope)) ?? "null");
    if (typeof raw !== "object" || raw === null) return "";
    const text = (raw as { text?: unknown }).text;
    return typeof text === "string" ? text.slice(0, MAX_LENGTH) : "";
  } catch { return ""; }
}

/**
 * 写入一条作用域草稿。空文本（含只有空白）即删除：没有内容的草稿不值得占位，
 * 也不会让下次进入时误以为「上次留了什么」。
 */
export function writeComposerDraft(workspaceId: string, scope: string, text: string): void {
  try {
    if (text.trim() === "") { window.localStorage.removeItem(storageKey(workspaceId, scope)); return; }
    window.localStorage.setItem(storageKey(workspaceId, scope), JSON.stringify({ text: text.slice(0, MAX_LENGTH) }));
  } catch { /* 本机存储不可写时输入本身不受影响，草稿只是不跨作用域保留。 */ }
}

export function clearComposerDraft(workspaceId: string, scope: string): void {
  try { window.localStorage.removeItem(storageKey(workspaceId, scope)); } catch { /* 同上。 */ }
}
