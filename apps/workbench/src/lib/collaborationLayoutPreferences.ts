import { resolvedTokenValue } from "./tokens";

export type CollaborationLayoutMode = "split" | "chat" | "result";

/** 仅保存本设备的展示布局，不承载 Task、Run、Review 或命令身份。 */
export interface CollaborationLayoutPreferences {
  readonly mode: CollaborationLayoutMode;
  readonly chatRatio: number;
}

export const COLLABORATION_LAYOUT_STORAGE_KEY = "relay.workbench.collaborationLayoutPreferences";
export const COLLABORATION_CHAT_RATIO_MIN = 0.32;
export const COLLABORATION_CHAT_RATIO_MAX = 0.68;
export const DEFAULT_COLLABORATION_LAYOUT: CollaborationLayoutPreferences = { mode: "split", chatRatio: Number(resolvedTokenValue("layout.collaboration.chatRatio")) };

function valid(value: unknown): value is CollaborationLayoutPreferences {
  if (value === null || typeof value !== "object") return false;
  const stored = value as Record<string, unknown>;
  return typeof stored.mode === "string" && ["split", "chat", "result"].includes(stored.mode) &&
    typeof stored.chatRatio === "number" && Number.isFinite(stored.chatRatio) &&
    stored.chatRatio >= COLLABORATION_CHAT_RATIO_MIN && stored.chatRatio <= COLLABORATION_CHAT_RATIO_MAX;
}

export function clampCollaborationChatRatio(value: number): number {
  return Math.round(Math.min(COLLABORATION_CHAT_RATIO_MAX, Math.max(COLLABORATION_CHAT_RATIO_MIN, value)) * 10000) / 10000;
}

export function readCollaborationLayoutPreferences(): CollaborationLayoutPreferences {
  try {
    const raw = window.localStorage.getItem(COLLABORATION_LAYOUT_STORAGE_KEY);
    if (raw === null) return DEFAULT_COLLABORATION_LAYOUT;
    const value: unknown = JSON.parse(raw);
    if (!valid(value) || !("version" in value) || value.version !== 1) return DEFAULT_COLLABORATION_LAYOUT;
    return { mode: value.mode, chatRatio: value.chatRatio };
  } catch { return DEFAULT_COLLABORATION_LAYOUT; }
}

/** 无效或不可写时回退默认，不阻止业务输入与原命令核对。 */
export function saveCollaborationLayoutPreferences(value: CollaborationLayoutPreferences): CollaborationLayoutPreferences {
  if (!valid(value)) return DEFAULT_COLLABORATION_LAYOUT;
  try {
    window.localStorage.setItem(COLLABORATION_LAYOUT_STORAGE_KEY, JSON.stringify({ version: 1, ...value }));
    return value;
  } catch { return DEFAULT_COLLABORATION_LAYOUT; }
}
