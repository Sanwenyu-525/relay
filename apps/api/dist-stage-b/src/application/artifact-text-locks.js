import { randomUUID } from 'node:crypto';
import { markdownBlocks } from '../artifact/markdown-locks.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { evidenceUnavailable, invalidTransition, revisionConflict, resourceNotFound, validationFailed } from './domain-error.js';
import { lockArtifactInWorkspace, lockTaskInWorkspace, readArtifactInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories } from './unit-of-work.js';
export async function listArtifactTextLocks(db, workspaceId, artifactId) {
    const r = createRepositories(db);
    await readArtifactInWorkspace(r, workspaceId, artifactId);
    return { artifact_id: artifactId, locks: (await r.artifacts.listTextLocks(artifactId)).map(toDto) };
}
function toDto(lock) {
    return { id: lock.id, artifact_id: lock.artifact_id,
        base_version_id: lock.base_version_id, block_kind: lock.block_kind,
        block_index: lock.block_index, text: lock.locked_text, status: lock.status };
}
export async function lockArtifactText(db, storage, input) {
    const expected = requireRevision(input.expectedArtifactRevision, 'expected_artifact_revision');
    if (!Number.isSafeInteger(input.blockIndex) || input.blockIndex < 0) {
        throw validationFailed([{ field: 'block_index', message: 'must be a nonnegative integer' }]);
    }
    return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId, commandType: 'LockArtifactText',
        target: { artifact_id: input.artifactId }, body: {
            expected_artifact_revision: expected.toString(), expected_version_id: input.expectedVersionId,
            block_kind: input.blockKind, block_index: input.blockIndex
        },
        execute: async (r) => {
            const observed = await readArtifactInWorkspace(r, input.workspaceId, input.artifactId);
            await lockTaskInWorkspace(r, input.workspaceId, observed.task_id);
            const artifact = await lockArtifactInWorkspace(r, input.workspaceId, input.artifactId);
            if (artifact.revision !== expected)
                throw revisionConflict({ entityType: 'ARTIFACT',
                    expectedRevision: expected.toString(), actualRevision: artifact.revision.toString() });
            const version = (await r.artifacts.listArtifactVersions(artifact.id)).at(-1);
            if (!version || version.id !== input.expectedVersionId) {
                throw invalidTransition('产物最新版本已变化，请刷新后选择锁定区域。');
            }
            const read = await storage.readWithHashCheck(version.storage_ref, { contentHash: version.content_hash, size: version.size });
            if (read.status !== 'OK')
                throw evidenceUnavailable({ artifactVersionId: version.id,
                    reason: read.status });
            const selected = markdownBlocks(read.content.toString('utf8'), input.blockKind)[input.blockIndex];
            if (!selected || !selected.text)
                throw validationFailed([{ field: 'block_index',
                        message: 'selected block does not exist' }]);
            const locks = await r.artifacts.listTextLocks(artifact.id);
            if (locks.some((lock) => lock.block_kind === input.blockKind &&
                lock.block_index === input.blockIndex)) {
                throw invalidTransition('该章节或段落已经锁定。');
            }
            const created = await r.artifacts.insertTextLock({ id: randomUUID(), artifactId: artifact.id,
                versionId: version.id, kind: input.blockKind, index: input.blockIndex,
                text: selected.text });
            const bumped = await r.artifacts.bumpArtifactRevision(artifact.id, expected);
            if (!bumped)
                throw invalidTransition('锁定期间产物版本已变化。');
            return { artifact_id: artifact.id, artifact_revision: bumped.revision.toString(),
                lock: toDto(created) };
        } });
}
export async function unlockArtifactText(db, input) {
    const expected = requireRevision(input.expectedArtifactRevision, 'expected_artifact_revision');
    return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId, commandType: 'UnlockArtifactText',
        target: { artifact_id: input.artifactId, lock_id: input.lockId },
        body: { expected_artifact_revision: expected.toString() },
        execute: async (r) => {
            const observed = await readArtifactInWorkspace(r, input.workspaceId, input.artifactId);
            await lockTaskInWorkspace(r, input.workspaceId, observed.task_id);
            const artifact = await lockArtifactInWorkspace(r, input.workspaceId, input.artifactId);
            if (artifact.revision !== expected)
                throw revisionConflict({ entityType: 'ARTIFACT',
                    expectedRevision: expected.toString(), actualRevision: artifact.revision.toString() });
            if (!await r.artifacts.deleteTextLock(input.lockId, artifact.id))
                throw resourceNotFound('Text lock');
            const bumped = await r.artifacts.bumpArtifactRevision(artifact.id, expected);
            if (!bumped)
                throw invalidTransition('解锁期间产物版本已变化。');
            return { artifact_id: artifact.id, artifact_revision: bumped.revision.toString(),
                unlocked_lock_id: input.lockId };
        } });
}
