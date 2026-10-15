import { isUuid } from './revisions.js';
import { resourceNotFound } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';
const unavailableArtifact = {
    availability: 'UNAVAILABLE', artifact_version_id: null, artifact_id: null,
    version_number: null, sha256: null,
};
/** A historical completion is projected from its exact, immutable basis, never from the latest cycle. */
export async function readCompletionEvidence(db, storage, workspaceId, completionId) {
    return db.transaction().setIsolationLevel('repeatable read').execute(async (snapshot) => {
        const r = createRepositories(snapshot);
        const completion = await r.completions.readCompletionRecord(completionId);
        const task = completion === undefined ? undefined : await r.tasks.readTask(completion.task_id);
        if (completion === undefined || task?.workspace_id !== workspaceId) {
            throw resourceNotFound('Completion record');
        }
        const accepted = await r.tasks.readAcceptanceVersion(task.id, completion.acceptance_revision);
        const criteria = accepted === undefined ? [] :
            await r.tasks.listCriteria(task.id, completion.acceptance_revision);
        const acceptedCriteria = criteria.map((criterion) => ({
            criterion_id: criterion.criterion_id, statement: criterion.statement,
            required: criterion.required, method: criterion.method,
            target_spec: criterion.target_spec,
        }));
        const refs = artifactRefs(completion.state_delta);
        const artifactVersions = [];
        if (refs === null)
            artifactVersions.push(unavailableArtifact);
        else {
            for (const ref of refs.slice(0, 100)) {
                artifactVersions.push(await artifactEvidence(r, storage, workspaceId, task.id, ref));
            }
            if (refs.length > 100)
                artifactVersions.push(unavailableArtifact);
        }
        const human = completion.basis_kind === 'HUMAN' && completion.human_acceptance_id !== null
            ? await r.completions.readHumanAcceptance(completion.human_acceptance_id) : undefined;
        const humanValid = human !== undefined && human.task_id === task.id &&
            human.acceptance_revision === completion.acceptance_revision &&
            accepted !== undefined && refs !== null &&
            sameRefs(human.accepted_version_refs, refs) &&
            human.accepted_criterion_ids.every((id) => acceptedCriteria.some((item) => item.criterion_id === id));
        const session = completion.basis_kind === 'AUTO' &&
            completion.verification_session_id !== null
            ? await r.verifications.readSession(completion.verification_session_id) : undefined;
        const run = session === undefined || completion.run_id === null ? undefined :
            await r.runs.readRun(completion.run_id);
        const sessionValid = session !== undefined && run !== undefined &&
            session.task_id === task.id && session.acceptance_revision === completion.acceptance_revision &&
            session.run_id === run.id && run.task_id === task.id && run.workspace_id === workspaceId;
        return {
            completion_id: completion.id, task_id: task.id, basis_kind: completion.basis_kind,
            acceptance_revision: completion.acceptance_revision.toString(),
            is_current: task.current_completion_id === completion.id,
            committed_at: completion.committed_at.toISOString(),
            acceptance: accepted === undefined ? {
                availability: 'UNAVAILABLE', objective: null, expected_outputs: null,
                source: null, created_at: null, criteria: [],
            } : {
                availability: 'AVAILABLE', objective: accepted.objective,
                expected_outputs: accepted.required_output_spec, source: accepted.source,
                created_at: accepted.created_at.toISOString(), criteria: acceptedCriteria,
            },
            human_acceptance: completion.basis_kind !== 'HUMAN' ? null : humanValid ? {
                availability: 'AVAILABLE', id: human.id, actor_kind: human.actor_kind,
                statement: human.statement, accepted_criterion_ids: human.accepted_criterion_ids,
                reason: human.reason, created_at: human.created_at.toISOString(),
            } : {
                availability: 'UNAVAILABLE', id: null, actor_kind: null, statement: null,
                accepted_criterion_ids: [], reason: null, created_at: null,
            },
            verification_session: completion.basis_kind !== 'AUTO' ? null : sessionValid ? {
                availability: 'AVAILABLE', id: session.id, run_id: run.id,
                status: session.status, verdict: session.verdict,
                check_plan_hash: session.check_plan_hash.toString('hex'),
                applicable: await r.verifications.isApplicable(session.id),
            } : {
                availability: 'UNAVAILABLE', id: null, run_id: null,
                status: null, verdict: null, check_plan_hash: null, applicable: null,
            },
            artifact_versions: artifactVersions,
        };
    });
}
function artifactRefs(delta) {
    const refs = delta.artifact_version_ids;
    if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string' || !isUuid(ref))) {
        return null;
    }
    return refs;
}
function sameRefs(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
async function artifactEvidence(r, storage, workspaceId, taskId, versionId) {
    const version = await r.artifacts.readArtifactVersion(versionId);
    const artifact = version === undefined ? undefined : await r.artifacts.readArtifact(version.artifact_id);
    if (version === undefined || artifact?.workspace_id !== workspaceId ||
        artifact.task_id !== taskId)
        return unavailableArtifact;
    const content = await storage.readWithHashCheck(version.storage_ref, { contentHash: version.content_hash, size: version.size });
    if (content.status !== 'OK')
        return unavailableArtifact;
    return { availability: 'AVAILABLE', artifact_version_id: version.id,
        artifact_id: artifact.id, version_number: version.version_number.toString(),
        sha256: version.content_hash.toString('hex') };
}
