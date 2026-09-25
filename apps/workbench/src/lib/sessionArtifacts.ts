import type { DecimalRevision } from "../types";

/**
 * 会话内的产物记忆：仅 UI 状态，不是业务事实。
 *
 * 旧 UI 测试仍使用这份纯内存状态检查连接切换时的清理。
 * 真实 Task 产物页已改从受权 API 重建版本与当前接受指针，不以此缓存作业务事实。
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

export const sessionArtifacts: SessionArtifactState = { byTask: {} };

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

export function clearSessionArtifacts(): void {
  sessionArtifacts.byTask = {};
}

export const resetSessionArtifactsForTest = clearSessionArtifacts;
