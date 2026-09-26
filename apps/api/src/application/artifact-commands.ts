import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ArtifactRow, TaskRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { checkRequiredText, normalizeText } from '../shared/text.js';
import {
  MAX_MARKDOWN_BYTES,
  ManagedContentStore,
  SUPPORTED_MEDIA_TYPES,
  StorageConflictError,
  StorageUnavailableError,
} from '../storage/managed-content-store.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import {
  contentTooLarge,
  invalidTransition,
  revisionConflict,
  storageUnavailable,
  unsupportedMediaType,
  validationFailed,
} from './domain-error.js';
import {
  lockArtifactInWorkspace,
  lockTaskInWorkspace,
  readArtifactInWorkspace,
} from './guards.js';
import { requireRevision } from './revisions.js';
import type { Repositories } from './unit-of-work.js';

/**
 * Artifact 版本写入（docs/api/http-command-contract.md 第 3 节）。
 *
 * 两个入口都只允许处于 IN_PROGRESS 的人工任务，并且都必须先完整保存内容再登记不可变版本：
 *   暂存 → 完整写入 + hash/size → 刷盘 → 发布到不可变版本目录（禁止覆盖）→ 数据库登记版本行。
 * 内容路径完全由服务端按内部 ID 生成；请求里的任何路径字段都会被严格 schema 拒绝。
 *
 * 失败可留下未引用的孤儿内容（V1 默认保留并提供核对报告），但绝不留下指向未发布文件的版本。
 */

const ARTIFACT_KIND = 'MARKDOWN_DOCUMENT';

export type ArtifactVersionResult = {
  readonly task_id: string;
  readonly artifact_id: string;
  readonly artifact_revision: string;
  readonly version_id: string;
  readonly version_number: string;
  readonly media_type: string;
  readonly sha256: string;
  /** 字节数用十进制字符串，避免客户端整数精度差异。 */
  readonly size: string;
  readonly task_revision: string;
};

export interface CreateArtifactInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly expectedTaskRevision: string;
  readonly title: string;
  readonly mediaType: string;
  readonly content: string;
}

export interface SubmitArtifactVersionInput {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly commandId: string;
  readonly expectedArtifactRevision: string;
  readonly expectedTaskRevision: string;
  readonly mediaType: string;
  readonly content: string;
}

interface NormalizedContent {
  readonly content: Buffer;
}

/** 类型与大小都在进入事务前判定：415/413 不产生任何业务写入。 */
export function normalizeArtifactContent(mediaType: string, content: string): NormalizedContent {
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
    throw unsupportedMediaType(mediaType);
  }

  const encoded = Buffer.from(content, 'utf8');

  if (encoded.byteLength > MAX_MARKDOWN_BYTES) {
    throw contentTooLarge(encoded.byteLength, MAX_MARKDOWN_BYTES);
  }

  return { content: encoded };
}

/**
 * CreateArtifactWithVersion：在必须处于 IN_PROGRESS 的人工 Task 下建立 Artifact 与它的 v1。
 * 同一次命令只产生一个 Artifact 与一个版本；重放返回原回执，不重复发布内容。
 */
export interface PreparedArtifactCreation {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly expectedTaskRevision: bigint;
  readonly title: string;
  readonly mediaType: string;
  readonly content: string;
  readonly contentBytes: Buffer;
}

/** 命令入口校验与规范化；与回执摘要使用同一结果。 */
export function prepareArtifactCreation(input: CreateArtifactInput): PreparedArtifactCreation {
  const expectedTaskRevision = requireRevision(
    input.expectedTaskRevision,
    'expected_task_revision',
  );
  const titleProblem = checkRequiredText(input.title, 'title', 'title');

  if (titleProblem !== undefined) {
    throw validationFailed([titleProblem]);
  }

  const normalized = normalizeArtifactContent(input.mediaType, input.content);
  const title = normalizeText(input.title);

  return {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    commandId: input.commandId,
    expectedTaskRevision,
    title,
    mediaType: input.mediaType,
    content: input.content,
    contentBytes: normalized.content,
  };
}

/** 事务内的业务效果；提案接受等协调方在已持有锁的事务里直接复用。 */
export async function applyArtifactCreation(repositories: Repositories,
  storage: ManagedContentStore, prepared: PreparedArtifactCreation,
): Promise<ArtifactVersionResult> {
  const task = await lockTaskInWorkspace(repositories, prepared.workspaceId, prepared.taskId);

  requireRevisionMatch(task, prepared.expectedTaskRevision);
  requireHumanInProgress(task, '保存产物版本');

  const artifactId = randomUUID();
  const versionId = randomUUID();
  const published = await publishContent(storage, {
    artifactId,
    versionId,
    content: prepared.contentBytes,
  });

  const artifact = await repositories.artifacts.insertArtifact({
    id: artifactId,
    workspaceId: prepared.workspaceId,
    projectId: task.project_id,
    taskId: task.id,
    artifactKind: ARTIFACT_KIND,
    title: prepared.title,
  });

  const version = await repositories.artifacts.insertArtifactVersion({
    id: versionId,
    artifactId: artifact.id,
    versionNumber: 1n,
    storageRef: published.storageRef,
    contentHash: published.contentHash,
    size: published.size,
    mediaType: prepared.mediaType,
    sourceKind: 'HUMAN',
    sourceRef: null,
  });

  const updatedTask = await repositories.tasks.bumpTaskRevision(task.id);

  if (updatedTask === undefined) {
    throw invalidTransition('Task 在保存产物版本期间消失。', { taskId: task.id });
  }

  await recordArtifactActivity(repositories, {
    commandId: prepared.commandId,
    task: updatedTask,
    eventType: 'ARTIFACT_VERSION_SAVED',
    artifact,
    versionId: version.id,
    versionNumber: version.version_number,
    contentHash: published.contentHash,
    size: published.size,
    mediaType: prepared.mediaType,
  });

  return {
    task_id: updatedTask.id,
    artifact_id: artifact.id,
    artifact_revision: toDecimalString(artifact.revision),
    version_id: version.id,
    version_number: toDecimalString(version.version_number),
    media_type: version.media_type,
    sha256: published.contentHash.toString('hex'),
    size: toDecimalString(published.size),
    task_revision: toDecimalString(updatedTask.revision),
  };
}

export async function createArtifactWithVersion(
  db: DbExecutor,
  storage: ManagedContentStore,
  input: CreateArtifactInput,
): Promise<CommandOutcome<ArtifactVersionResult>> {
  const prepared = prepareArtifactCreation(input);

  return runIdempotentCommand<ArtifactVersionResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'CreateArtifactWithVersion',
    target: { task_id: input.taskId },
    body: {
      expected_task_revision: toDecimalString(prepared.expectedTaskRevision),
      title: prepared.title,
      media_type: prepared.mediaType,
      content: prepared.content,
    },
    execute: async (repositories) =>
      applyArtifactCreation(repositories, storage, prepared),
  });
}

/**
 * SubmitHumanArtifactVersion：向已有 Artifact 追加一个不可变版本。
 *
 * 旧版本永不覆盖，新版本也不继承任何验收或完成凭据（contracts/03 第 5 节）：
 * 是否被选为验收对象只由完成命令显式给出的确切版本决定。
 */
export async function submitHumanArtifactVersion(
  db: DbExecutor,
  storage: ManagedContentStore,
  input: SubmitArtifactVersionInput,
): Promise<CommandOutcome<ArtifactVersionResult>> {
  const expectedArtifactRevision = requireRevision(
    input.expectedArtifactRevision,
    'expected_artifact_revision',
  );
  const expectedTaskRevision = requireRevision(
    input.expectedTaskRevision,
    'expected_task_revision',
  );
  const normalized = normalizeArtifactContent(input.mediaType, input.content);

  return runIdempotentCommand<ArtifactVersionResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SubmitHumanArtifactVersion',
    target: { artifact_id: input.artifactId },
    body: {
      expected_artifact_revision: toDecimalString(expectedArtifactRevision),
      expected_task_revision: toDecimalString(expectedTaskRevision),
      media_type: input.mediaType,
      content: input.content,
    },
    execute: async (repositories) => {
      // 先按作用域解析 Artifact，再按统一锁序取 Task → Artifact。
      const observed = await readArtifactInWorkspace(
        repositories,
        input.workspaceId,
        input.artifactId,
      );
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, observed.task_id);

      requireRevisionMatch(task, expectedTaskRevision);
      requireHumanInProgress(task, '保存产物版本');

      const artifact = await lockArtifactInWorkspace(
        repositories,
        input.workspaceId,
        input.artifactId,
      );

      if (artifact.revision !== expectedArtifactRevision) {
        throw revisionConflict({
          entityType: 'ARTIFACT',
          expectedRevision: toDecimalString(expectedArtifactRevision),
          actualRevision: toDecimalString(artifact.revision),
        });
      }

      const previousVersion = (await repositories.artifacts.listArtifactVersions(artifact.id)).at(-1);
      const versionNumber = await repositories.artifacts.nextVersionNumber(artifact.id);
      const versionId = randomUUID();
      const published = await publishContent(storage, {
        artifactId: artifact.id,
        versionId,
        content: normalized.content,
      });

      const version = await repositories.artifacts.insertArtifactVersion({
        id: versionId,
        artifactId: artifact.id,
        versionNumber,
        storageRef: published.storageRef,
        contentHash: published.contentHash,
        size: published.size,
        mediaType: input.mediaType,
        sourceKind: 'HUMAN',
        sourceRef: null,
      });
      if (previousVersion !== undefined) {
        await repositories.lineage.insertExactEdge({ workspaceId: input.workspaceId,
          childVersionId: version.id, relation: 'REVISED_FROM',
          parentKind: 'ARTIFACT_VERSION', parentId: previousVersion.id });
      }

      const bumpedArtifact = await repositories.artifacts.bumpArtifactRevision(
        artifact.id,
        expectedArtifactRevision,
      );

      if (bumpedArtifact === undefined) {
        throw revisionConflict({
          entityType: 'ARTIFACT',
          expectedRevision: toDecimalString(expectedArtifactRevision),
          actualRevision: toDecimalString(artifact.revision),
        });
      }

      const updatedTask = await repositories.tasks.bumpTaskRevision(task.id);

      if (updatedTask === undefined) {
        throw invalidTransition('Task 在保存产物版本期间消失。', { taskId: task.id });
      }

      await recordArtifactActivity(repositories, {
        commandId: input.commandId,
        task: updatedTask,
        eventType: 'ARTIFACT_VERSION_SAVED',
        artifact: bumpedArtifact,
        versionId: version.id,
        versionNumber: version.version_number,
        contentHash: published.contentHash,
        size: published.size,
        mediaType: input.mediaType,
      });

      return {
        task_id: updatedTask.id,
        artifact_id: bumpedArtifact.id,
        artifact_revision: toDecimalString(bumpedArtifact.revision),
        version_id: version.id,
        version_number: toDecimalString(version.version_number),
        media_type: version.media_type,
        sha256: published.contentHash.toString('hex'),
        size: toDecimalString(published.size),
        task_revision: toDecimalString(updatedTask.revision),
      };
    },
  });
}

/** 人工保存与人工完成共用的执行权判定（契约第 3 节）。 */
export function requireHumanInProgress(task: TaskRow, action: string): void {
  if (task.status === 'DONE') {
    throw invalidTransition(`已完成的 Task 不能${action}：必须先重开，才能继续新周期的工作。`, {
      taskId: task.id,
      acceptanceRevision: toDecimalString(task.acceptance_revision),
      ...(task.current_completion_id === null
        ? {}
        : { currentCompletionId: task.current_completion_id }),
    });
  }

  if (task.status !== 'IN_PROGRESS') {
    throw invalidTransition(
      `只有 IN_PROGRESS 的 Task 可以${action}（当前为 ${task.status}）。`,
      { taskId: task.id },
    );
  }

  if (task.executor_kind !== 'HUMAN') {
    throw invalidTransition(`当前 Task 的执行权不在本机人工用户手上，不能${action}。`, {
      taskId: task.id,
    });
  }
}

function requireRevisionMatch(task: TaskRow, expectedRevision: bigint): void {
  if (task.revision !== expectedRevision) {
    throw revisionConflict({
      entityType: 'TASK',
      expectedRevision: toDecimalString(expectedRevision),
      actualRevision: toDecimalString(task.revision),
    });
  }
}

async function publishContent(
  storage: ManagedContentStore,
  input: { readonly artifactId: string; readonly versionId: string; readonly content: Buffer },
): Promise<{ readonly storageRef: string; readonly contentHash: Buffer; readonly size: bigint }> {
  try {
    return await storage.publish(input);
  } catch (error) {
    if (error instanceof StorageConflictError || error instanceof StorageUnavailableError) {
      throw storageUnavailable();
    }

    throw error;
  }
}

async function recordArtifactActivity(
  repositories: Repositories,
  input: {
    readonly commandId: string;
    readonly task: TaskRow;
    readonly eventType: string;
    readonly artifact: ArtifactRow;
    readonly versionId: string;
    readonly versionNumber: bigint;
    readonly contentHash: Buffer;
    readonly size: bigint;
    readonly mediaType: string;
  },
): Promise<void> {
  const factRefs: JsonObject = {
    artifact_id: input.artifact.id,
    artifact_version_id: input.versionId,
    version_number: toDecimalString(input.versionNumber),
    media_type: input.mediaType,
    sha256: input.contentHash.toString('hex'),
    size: toDecimalString(input.size),
    artifact_revision: toDecimalString(input.artifact.revision),
  };

  await repositories.activities.insertActivityRecord({
    id: randomUUID(),
    workspaceId: input.task.workspace_id,
    actorKind: 'HUMAN',
    actorRef: LOCAL_ACTOR_REF,
    commandId: input.commandId,
    projectId: input.task.project_id,
    taskId: input.task.id,
    eventType: input.eventType,
    factRefs,
  });
}
