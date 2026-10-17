/**
 * 会话净 diff 的应用协调（工作台 §34.3 / §34.4）。
 *
 * 应用层是会话基线的唯一协调入口：建立、读取与失效都在此处，存储职责留在 repository。
 * 模型参数流只提供可丢弃的显示预览（见 changeset-preview），实际写仍走原 Gateway；
 * 这里的总数只采用「已落盘」的当前目录内容，不把尚未执行的生成预览混进来。
 *
 * 基线身份绑定 Workspace / Session / 受管资源 / 根路径；一次原子发布只产生一个有效起点，
 * 目录切换/返回旧目录都按新根路径产生独立段（不跨段求和）。失败/重启/重复请求都不发布
 * 两个起点，也不越过原实际目录资源排他。
 */

import type { Repositories } from '../application/unit-of-work.js';
import { resourceNotFound } from '../application/domain-error.js';
import {
  captureBaseline,
  captureCurrentState,
  NotAGitRepositoryError,
} from './baseline-capture.js';
import {
  computeSnapshotDiff,
  computeAlignedDiff,
  type BaselineFile,
  type ConversationDiff,
  type CurrentFile,
  type DiffRow,
  type FileAction,
} from './diff-engine.js';
import { canonicalRelativePath } from '../files/file-changeset.js';
import {
  type StoredBaseline,
  type StoredBaselineFile,
} from './conversation-diff-repository.js';

export interface EstablishBaselineInput {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface EstablishBaselineResult {
  readonly established: boolean;
  readonly reason: string;
  readonly baseline: StoredBaseline | null;
  /** true 表示命中已存在的基线（幂等），false 表示本次新建。 */
  readonly reused: boolean;
}

export interface ReadDiffInput {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export type ReadDiffResult =
  | { readonly available: true; readonly diff: ConversationDiff }
  | {
      readonly available: false;
      readonly reason: 'NO_RESOURCE' | 'NO_BASELINE' | 'ROOT_NOT_GIT' | 'RESOURCE_UNAVAILABLE';
    };

/**
 * 在「首条消息开始处理、任何写入前」建立会话基线（幂等）。
 *
 * 上层（requestAssistMessage）在拿到 session、加完项目锁之后调用本函数；此时尚没有
 * 本次消息驱动的写，因此基线反映真实会话起点。若会话已有资源且存在基线，直接复用。
 * 采集失败（非 Git 根、失权、超限）不抛错，由调用方决定如何呈现，不破坏原消息流程。
 */
export async function establishConversationDiffBaseline(repositories: Repositories,
  input: EstablishBaselineInput): Promise<EstablishBaselineResult> {
  const session = await repositories.assist.readSession(input.sessionId, true);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    return { established: false, reason: 'SESSION_NOT_FOUND', baseline: null, reused: false };
  }
  if (session.status !== 'ACTIVE') {
    return { established: false, reason: 'SESSION_NOT_ACTIVE', baseline: null, reused: false };
  }
  const resourceId = session.working_resource_id;
  if (resourceId === null) {
    // 纯聊天尚无目录：不做全盘扫描，绑定后由后续调用建立真实统计起点。
    return { established: false, reason: 'NO_RESOURCE', baseline: null, reused: false };
  }
  const resource = await repositories.gateway.readResource(resourceId);
  if (resource === undefined || resource.workspace_id !== input.workspaceId ||
      resource.status !== 'ACTIVE' ||
      (session.project_id !== null && resource.project_id !== session.project_id)) {
    return { established: false, reason: 'RESOURCE_UNAVAILABLE', baseline: null, reused: false };
  }

  const rootPath = resource.canonical_root;
  const existing = await repositories.conversationDiff.readLatestBaseline(
    input.workspaceId, input.sessionId, resourceId, rootPath);
  if (existing !== undefined) {
    return { established: true, reason: 'REUSED', baseline: existing, reused: true };
  }

  let snapshot;
  try {
    snapshot = await captureBaseline(rootPath);
  } catch (error) {
    if (error instanceof NotAGitRepositoryError) {
      return { established: false, reason: 'NOT_GIT_ROOT', baseline: null, reused: false };
    }
    return { established: false,
      reason: error instanceof Error ? error.message : 'CAPTURE_FAILED', baseline: null, reused: false };
  }

  const baseline = await repositories.conversationDiff.saveBaseline({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    resourceId,
    rootPath,
    files: snapshot.files,
    incomplete: snapshot.incomplete,
    captureReason: snapshot.captureReason,
  });
  return { established: true, reason: 'CREATED', baseline, reused: false };
}

/** 读取会话净 diff：基线快照 → 当前已落盘内容。 */
export async function readConversationDiff(repositories: Repositories,
  input: ReadDiffInput): Promise<ReadDiffResult> {
  const session = await repositories.assist.readSession(input.sessionId, true);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist session');
  }
  const resourceId = session.working_resource_id;
  if (resourceId === null) {
    return { available: false, reason: 'NO_RESOURCE' };
  }
  const resource = await repositories.gateway.readResource(resourceId);
  if (resource === undefined || resource.workspace_id !== input.workspaceId ||
      resource.status !== 'ACTIVE') {
    return { available: false, reason: 'RESOURCE_UNAVAILABLE' };
  }
  const rootPath = resource.canonical_root;
  const baseline = await repositories.conversationDiff.readLatestBaseline(
    input.workspaceId, input.sessionId, resourceId, rootPath);
  if (baseline === undefined) {
    return { available: false, reason: 'NO_BASELINE' };
  }

  let current: Map<string, CurrentFile>;
  try {
    current = await captureCurrentState(rootPath);
  } catch (error) {
    if (error instanceof NotAGitRepositoryError) {
      return { available: false, reason: 'ROOT_NOT_GIT' };
    }
    throw error;
  }

  const baselineMap = new Map<string, BaselineFile>();
  for (const file of baseline.files) {
    baselineMap.set(file.path, storedToBaselineFile(file));
  }

  const diff = computeSnapshotDiff({
    rootPath,
    resourceId,
    baselineCapturedAt: baseline.capturedAt.toISOString(),
    baselineRevision: baseline.revision,
    incomplete: baseline.incomplete,
    baseline: baselineMap,
    current,
  });
  return { available: true, diff };
}

function storedToBaselineFile(file: StoredBaselineFile): BaselineFile {
  return {
    path: file.path,
    sha256: file.sha256,
    text: file.text,
    lineCount: file.line_count,
    sizeBytes: file.size_bytes,
    unavailableReason: file.unavailable_reason,
  };
}

export interface ReadDiffFileInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** 根内相对路径；越界/不存在一律不可用，不构成读取越权。 */
  readonly path: string;
}

export type DiffFileUnavailableReason = 'NO_RESOURCE' | 'NO_BASELINE' | 'ROOT_NOT_GIT' |
  'RESOURCE_UNAVAILABLE' | 'PATH_NOT_FOUND';

/** 展开阅读可用时的正文：行数与总数同源（同一份基线修订 + 同一份当前快照）。 */
export interface ConversationFileDetail {
  readonly path: string;
  readonly action: FileAction;
  readonly added: number;
  readonly removed: number;
  readonly unavailableReason: string | null;
  /** 对齐行；规模超出对齐上限时为 null（调用方显示不可展开原因）。 */
  readonly rows: readonly DiffRow[] | null;
  readonly rowsTruncated: boolean;
  readonly rowsUnavailableReason: string | null;
}

export type ReadDiffFileResult =
  | { readonly available: true; readonly file: ConversationFileDetail }
  | { readonly available: false; readonly reason: DiffFileUnavailableReason };

/**
 * 单文件完整 diff 正文（工作台 §34.2「展开标题…展示完整 diff」）。
 *
 * 与总数读同一条路径、同一份修订：基线最新一段 + 读时当前快照，再对单个路径求净差异。
 * 这样展开行数与总数不会出现两套口径；行数不可统计时正文也不编造。
 */
export async function readConversationDiffFile(repositories: Repositories,
  input: ReadDiffFileInput): Promise<ReadDiffFileResult> {
  const session = await repositories.assist.readSession(input.sessionId, true);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist session');
  }
  const resourceId = session.working_resource_id;
  if (resourceId === null) return { available: false, reason: 'NO_RESOURCE' };
  const resource = await repositories.gateway.readResource(resourceId);
  if (resource === undefined || resource.workspace_id !== input.workspaceId ||
      resource.status !== 'ACTIVE') {
    return { available: false, reason: 'RESOURCE_UNAVAILABLE' };
  }
  const rootPath = resource.canonical_root;
  const baseline = await repositories.conversationDiff.readLatestBaseline(
    input.workspaceId, input.sessionId, resourceId, rootPath);
  if (baseline === undefined) return { available: false, reason: 'NO_BASELINE' };

  let current: Map<string, CurrentFile>;
  try {
    current = await captureCurrentState(rootPath);
  } catch (error) {
    if (error instanceof NotAGitRepositoryError) return { available: false, reason: 'ROOT_NOT_GIT' };
    throw error;
  }

  let canonical: string;
  try {
    canonical = canonicalRelativePath(rootPath, input.path);
  } catch {
    return { available: false, reason: 'PATH_NOT_FOUND' };
  }
  const baselineFile = baseline.files.find((file) => file.path === canonical);
  const currentFile = current.get(canonical);
  if (baselineFile === undefined && currentFile === undefined) {
    return { available: false, reason: 'PATH_NOT_FOUND' };
  }

  // 行数与总数走同一个纯函数：只喂该路径的两端，口径不会再分叉。
  const single = computeSnapshotDiff({
    rootPath,
    resourceId,
    baselineCapturedAt: baseline.capturedAt.toISOString(),
    baselineRevision: baseline.revision,
    incomplete: baseline.incomplete,
    baseline: baselineFile === undefined ? new Map()
      : new Map([[canonical, storedToBaselineFile(baselineFile)]]),
    current: currentFile === undefined ? new Map() : new Map([[canonical, currentFile]]),
  });
  const file = single.files.find((entry) => entry.path === canonical);
  if (file === undefined) {
    // 两端摘要相同：没有变化就没有正文，这不是读取失败。
    return { available: true, file: { path: canonical, action: 'SAME', added: 0, removed: 0,
      unavailableReason: null, rows: [], rowsTruncated: false, rowsUnavailableReason: null } };
  }

  let rows: readonly DiffRow[] | null = null;
  let rowsTruncated = false;
  let rowsUnavailableReason: string | null = null;
  if (file.unavailableReason !== null) {
    rowsUnavailableReason = file.unavailableReason;
  } else {
    const before = baselineFile?.text ?? '';
    const after = currentFile?.text ?? '';
    const aligned = computeAlignedDiff(before, after);
    if (aligned === null) rowsUnavailableReason = 'DIFF_TOO_LARGE';
    else { rows = aligned.rows; rowsTruncated = aligned.truncated; }
  }

  return { available: true, file: { path: file.path, action: file.action, added: file.added,
    removed: file.removed, unavailableReason: file.unavailableReason, rows, rowsTruncated,
    rowsUnavailableReason } };
}
