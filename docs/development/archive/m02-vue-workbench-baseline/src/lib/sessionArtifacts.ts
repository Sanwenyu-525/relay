import { reactive } from "vue";
import type { DecimalRevision } from "../types";

/**
 * 会话内的产物记忆：仅 UI 状态，不是业务事实。
 *
 * 服务端目前没有“列出某个 Task 的产物/版本”的读取端点（待接入），因此本轮闭环只能在
 * 当前页面会话里记住刚刚保存的版本，用它继续“选择要接受的版本 / 完成”。
 * 刷新页面会清空这份记忆；“当前选用”等事实仍以服务端 Project State 为准。
 */
export interface SessionArtifactVersion {
  readonly artifactId: string;
  readonly artifactRevision: DecimalRevision;
  readonly versionId: string;
  readonly versionNumber: DecimalRevision;
  readonly title: string;
  readonly sha256: string;
  readonly size: DecimalRevision;
  readonly savedAt: string;
}

interface SessionArtifactState {
  byTask: Record<string, SessionArtifactVersion[]>;
}

export const sessionArtifacts = reactive<SessionArtifactState>({ byTask: {} });

export function rememberArtifactVersion(taskId: string, version: SessionArtifactVersion): void {
  const existing = sessionArtifacts.byTask[taskId] ?? [];
  sessionArtifacts.byTask[taskId] = [...existing, version];
}

export function sessionVersionsFor(taskId: string): readonly SessionArtifactVersion[] {
  return sessionArtifacts.byTask[taskId] ?? [];
}

/** 同一 Task 已知的最新产物版本；用于把新版本续写到同一个产物上。 */
export function latestSessionVersion(taskId: string): SessionArtifactVersion | null {
  return sessionVersionsFor(taskId).at(-1) ?? null;
}

export function resetSessionArtifactsForTest(): void {
  sessionArtifacts.byTask = {};
}
