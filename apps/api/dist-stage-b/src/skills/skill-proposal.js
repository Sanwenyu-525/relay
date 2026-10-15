import { createHash } from 'node:crypto';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { buildCheckPlan } from '../workflow/check-plan.js';
import { hasChecker } from '../workflow/checkers.js';
import { WORKFLOW_KEY, WORKFLOW_VERSION } from '../workflow/markdown-deliverable.js';
const MAX_ACCEPTANCE_CRITERIA = 30;
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value : null;
}
/** Build the exact human-reviewable Task effect; model JSON never becomes a CheckPlan. */
export function buildTaskSkillProposal(skill, basis, output, proposalId) {
    if (skill.definition.target !== 'TASK' || skill.id === 'verification-plan' &&
        skill.version !== '1.1.0')
        return null;
    const acceptance = object(basis.facts.acceptance);
    const suggested = object(output.payload);
    if (acceptance === null || suggested === null ||
        !Array.isArray(acceptance.criteria))
        return null;
    const existing = acceptance.criteria.map(object);
    if (existing.some((criterion) => criterion === null))
        return null;
    if (existing.some((criterion) => typeof criterion.criterion_id !== 'string' ||
        typeof criterion.statement !== 'string' ||
        typeof criterion.required !== 'boolean' ||
        typeof criterion.method !== 'string' ||
        object(criterion.target_spec) === null))
        return null;
    const criteria = existing.map((criterion) => ({
        criterion_id: criterion.criterion_id,
        statement: criterion.statement,
        required: criterion.required,
        method: criterion.method,
        target_spec: criterion.target_spec,
        source: 'PRESERVED',
    }));
    const source = skill.id === 'task-to-execution-contract'
        ? suggested.criteria : suggested.additional_checks;
    if (!Array.isArray(source))
        return null;
    const addedIds = [];
    for (const item of source) {
        const check = object(item);
        if (check === null || typeof check.statement !== 'string' ||
            typeof check.method !== 'string' || typeof check.required !== 'boolean')
            return null;
        if (criteria.some((entry) => entry.statement === check.statement))
            continue;
        const criterionId = `skill_${proposalId.replaceAll('-', '')}_${addedIds.length + 1}`;
        const planned = buildCheckPlan({ workflowKey: WORKFLOW_KEY,
            workflowVersion: WORKFLOW_VERSION,
            criteria: [{ criterionId, statement: check.statement,
                    required: check.required, method: check.method, targetSpec: {} }] });
        if (!planned.entries.every((entry) => hasChecker(entry.checkerId, entry.checkerVersion)))
            return null;
        criteria.push({ criterion_id: criterionId, statement: check.statement,
            required: check.required, method: check.method, target_spec: {},
            source: 'SUGGESTED' });
        addedIds.push(criterionId);
    }
    if (criteria.length > MAX_ACCEPTANCE_CRITERIA ||
        skill.id === 'verification-plan' && addedIds.length === 0)
        return null;
    const existingOutputs = object(acceptance.required_output_spec);
    if (existingOutputs === null)
        return null;
    const objective = skill.id === 'task-to-execution-contract'
        ? suggested.objective : acceptance.objective;
    const expected = object(suggested.expected_outputs);
    const requiredOutputSpec = skill.id !== 'task-to-execution-contract'
        ? existingOutputs : {
        ...existingOutputs,
        ...(Object.keys(existingOutputs).length === 0
            ? { artifacts: ['MARKDOWN_DOCUMENT'] } : {}),
        ...(skill.version === '1.1.0' && typeof expected?.description === 'string'
            ? { description: expected.description } : {}),
    };
    if (typeof objective !== 'string' || object(requiredOutputSpec) === null ||
        addedIds.length === 0 && objective === acceptance.objective &&
            canonicalizeJson(requiredOutputSpec) ===
                canonicalizeJson(existingOutputs))
        return null;
    return {
        objective,
        required_output_spec: requiredOutputSpec,
        criteria,
        added_criterion_ids: addedIds,
        preserved_criterion_ids: existing.map((criterion) => criterion.criterion_id),
        suggested_mode: skill.id === 'task-to-execution-contract'
            ? suggested.suggested_mode ?? null : null,
    };
}
export function skillOutputHash(output) {
    return createHash('sha256').update(canonicalizeJson(output), 'utf8').digest('hex');
}
