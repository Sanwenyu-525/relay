// Opt-in M04: three bundled Skills through the real Provider and existing Assist/Task Owners.
// Without valid explicit model configuration, no API or model invocation is started.
// Every business fact sent to the Provider is an isolated synthetic fixture.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { editTaskPresentation } from '../../src/application/task-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { canonicalizeJson } from '../../src/receipt/payload-hash.js';
import { FIRST_PARTY_REGISTRY, frozenSkillIdentity, frozenSkillSnapshot } from '../../src/skills/first-party-registry.js';
import { loadSkillBasis } from '../../src/skills/skill-basis.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { MODEL_ERROR_CATEGORIES } from '../../src/workflow/model-error-classification.js';
import { computeModelConfigFingerprint, describeModelPortStatus, readModelPortConfig } from '../../src/workflow/model-port-config.js';
import { OpenAiCompatibleModelPort } from '../../src/workflow/openai-compatible-model-port.js';
import { createGoal } from '../../src/application/create-goal.js';
import { createProject } from '../../src/application/create-project.js';
import { setViewConfiguration } from '../../src/application/view-configuration-commands.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';
const modelReady = describeModelPortStatus(process.env).configured;
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-real-model-skills');
let api;
let assistCommands;
let assistRunner;
let skillProposal;
let checkers;
before(async () => {
    if (!modelReady)
        return;
    // These modules transitively load checkers, whose eager production validation
    // correctly rejects incomplete configuration. Opt-in skip must precede import.
    [assistCommands, assistRunner, skillProposal, checkers] = await Promise.all([
        import('../../src/application/assist-commands.js'),
        import('../../src/application/assist-runner.js'),
        import('../../src/skills/skill-proposal.js'),
        import('../../src/workflow/checkers.js'),
    ]);
    await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
    api = await startTestApi();
});
after(async () => {
    const closed = await Promise.allSettled([api?.stop(), app.close()]);
    const failures = closed.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length)
        throw new AggregateError(failures, 'real Skill cleanup failed');
    if (api) {
        assert.equal(closed[0].status, 'fulfilled');
        if (closed[0].status === 'fulfilled')
            assert.equal(closed[0].value, 0);
        console.log('real_skill_cleanup api_exit=0 temporary_data_removed=true');
    }
});
function object(value) {
    assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
    return value;
}
function records(value) {
    assert.ok(Array.isArray(value));
    return value.map(object);
}
async function command(f, path, body, status) {
    assert.ok(api);
    const commandId = randomUUID();
    return expectCommandAccepted(await api.post(workspacePath(f.workspaceId, path), { ...body, command_id: commandId }), status, commandId);
}
async function get(f, path) {
    assert.ok(api);
    const response = await api.get(workspacePath(f.workspaceId, path));
    assert.equal(response.status, 200);
    return object(response.body);
}
async function fixture() {
    const workspaceId = await createWorkspace(app.db);
    const projectId = randomUUID();
    const taskId = randomUUID();
    // Repository initialization is the existing integration-fixture boundary.
    // Generation and acceptance below use only production Assist/Task entrypoints.
    await withTransaction(app.db, async (r) => {
        await r.projects.insertProject({ id: projectId, workspaceId,
            title: 'Synthetic lunar greenhouse', projectType: 'GENERAL' });
        await r.projects.insertProjectState(projectId, 'PLANNING');
        await r.tasks.insertTask({ id: taskId, workspaceId, projectId,
            title: 'Synthetic greenhouse briefing', status: 'READY', mode: 'ME',
            acceptanceRevision: 1n, executorKind: 'HUMAN', ownershipEpoch: 0n,
            currentCompletionId: null });
        await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
            objective: 'Write a Markdown briefing for a fictional lunar greenhouse. '
                + 'Describe water reuse and lighting as a synthetic example, without claiming real measurements.',
            requiredOutputSpec: { artifacts: ['MARKDOWN_DOCUMENT'],
                description: 'Original synthetic briefing', retention: { policy: 'keep-original' } },
            source: 'CREATE' });
        await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n,
            criterionId: 'human', statement: 'Human confirms that the briefing is explicitly fictional',
            required: true, method: 'HUMAN', targetSpec: {} });
    });
    return { workspaceId, projectId, taskId };
}
async function blueprintFixture() {
    const workspaceId = await createWorkspace(app.db);
    const created = await createProject(app.db, { workspaceId, commandId: randomUUID(),
        title: 'Synthetic lunar greenhouse blueprint', projectType: 'GENERAL' });
    const projectId = created.result.project_id;
    const taskId = randomUUID();
    await withTransaction(app.db, async (r) => {
        await r.tasks.insertTask({ id: taskId, workspaceId, projectId,
            title: 'Synthetic greenhouse briefing', status: 'READY', mode: 'ME',
            acceptanceRevision: 1n, executorKind: 'HUMAN', ownershipEpoch: 0n,
            currentCompletionId: null });
        await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
            objective: 'Write a Markdown briefing for a fictional lunar greenhouse.',
            requiredOutputSpec: { artifacts: ['MARKDOWN_DOCUMENT'],
                description: 'Original synthetic briefing', retention: { policy: 'keep-original' } },
            source: 'CREATE' });
        await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n,
            criterionId: 'human', statement: 'Human confirms that the briefing is explicitly fictional',
            required: true, method: 'HUMAN', targetSpec: {} });
    });
    return { workspaceId, projectId, taskId };
}
async function businessSnapshot(f) {
    const result = await sql `select jsonb_build_object(
    'project', (select to_jsonb(p) from projects p where p.id = ${f.projectId}),
    'state', (select to_jsonb(s) from project_states s where s.project_id = ${f.projectId}),
    'tasks', (select jsonb_agg(to_jsonb(t) order by t.id) from tasks t
      where t.project_id = ${f.projectId}),
    'acceptances', (select jsonb_agg(to_jsonb(a) order by a.task_id, a.acceptance_revision)
      from task_acceptances a join tasks t on t.id = a.task_id where t.project_id = ${f.projectId}),
    'criteria', (select jsonb_agg(to_jsonb(c) order by c.task_id, c.acceptance_revision, c.criterion_id)
      from acceptance_criteria c join tasks t on t.id = c.task_id where t.project_id = ${f.projectId})
    ) as snapshot`.execute(app.db);
    return result.rows[0].snapshot;
}
async function assertNoExecution(f) {
    const result = await sql `select
    (select count(*)::text from runs where workspace_id = ${f.workspaceId}) as runs,
    (select count(*)::text from artifacts where workspace_id = ${f.workspaceId}) as artifacts,
    (select count(*)::text from completion_records c join tasks t on t.id = c.task_id
      where t.workspace_id = ${f.workspaceId}) as completions,
    (select count(*)::text from verification_sessions v join tasks t on t.id = v.task_id
      where t.workspace_id = ${f.workspaceId}) as verifications,
    (select count(*)::text from check_results c join verification_sessions v on v.id = c.session_id
      join tasks t on t.id = v.task_id where t.workspace_id = ${f.workspaceId}) as checks,
    (select count(*)::text from state_completion_refs where project_id = ${f.projectId}) as state_completions
    `.execute(app.db);
    assert.deepEqual(result.rows[0], { runs: '0', artifacts: '0', completions: '0',
        verifications: '0', checks: '0', state_completions: '0' });
}
async function generate(f, skill, content, skillInput) {
    assert.ok(api);
    const config = readModelPortConfig(process.env);
    assert.ok(config);
    const modelPort = new OpenAiCompatibleModelPort(config);
    const registryDto = await get(f, '/skill-definitions/' + skill.id + '/versions/' + skill.version);
    assert.equal(registryDto.call_supported, true);
    // 首批可接受的两条路径：TASK Skill 走 AcceptAssistProposal，蓝图走 ApplyProjectBlueprint；
    // project-resume 是只读摘要，没有接受入口。不要把「非 TASK」一律当成不可接受。
    assert.equal(registryDto.accept_supported, skill.definition.target === 'TASK' || skill.id === 'goal-to-project-blueprint');
    for (const [key, value] of Object.entries(frozenSkillIdentity(skill))) {
        assert.deepEqual(registryDto[key], value);
    }
    const session = await command(f, '/assist-sessions', {
        ...(skill.definition.target === 'TASK' ? { task_id: f.taskId } : { project_id: f.projectId }),
        title: 'Synthetic real Skill ' + skill.id,
    }, 201);
    const sessionId = session.session_id;
    // 基线必须按同一份 skill_input 重算，否则比较的是另一个作用域的事实集。
    const basis = await loadSkillBasis(app.db, f.workspaceId, f.projectId, skill.definition.target === 'TASK' ? f.taskId : null, skill, skillInput ?? null);
    const request = await command(f, '/assist-sessions/' + sessionId + '/messages', {
        content, skill_ref: { id: skill.id, version: skill.version }, source_refs: [],
        ...(skillInput === undefined ? {} : { skill_input: skillInput }),
    }, 202);
    const messageId = request.assistant_message_id;
    const outcome = await assistRunner.runAssistGenerationTick(app.db, {
        workerId: 'real-skill-' + randomUUID(), storage: new ManagedContentStore(api.dataRoot),
        modelPort, leaseMs: 30_000,
    });
    const calls = await sql `select * from model_calls
    where workspace_id = ${f.workspaceId}`.execute(app.db);
    if (outcome?.status !== 'COMPLETED') {
        const knownErrors = new Set([...MODEL_ERROR_CATEGORIES,
            'ModelCallBudgetError', 'ModelScopeBudgetError', 'ModelToolOutputError',
            'ModelSourcePolicyError', 'TypeError', 'Error', 'UNKNOWN']);
        console.log('real_skill_failure_diagnostic ' + JSON.stringify({
            skill: skill.id, outcome_status: outcome?.status ?? null,
            outcome_error_code: outcome?.errorCode ?? null,
            call_count: calls.rows.length,
            ledger: calls.rows.map((call) => ({ status: call.status,
                error_kind: call.error_kind === null || knownErrors.has(call.error_kind)
                    ? call.error_kind : 'OTHER',
                usage_known: { input_tokens: call.usage_input_tokens !== null,
                    output_tokens: call.usage_output_tokens !== null },
                metadata_known: call.provider_request_id !== null,
            })),
        }));
    }
    assert.equal(outcome?.messageId, messageId);
    assert.equal(outcome.status, 'COMPLETED', 'real Skill must satisfy the existing strict output contract');
    assert.equal(outcome.errorCode, null);
    const messages = records((await get(f, '/assist-sessions/' + sessionId + '/messages')).items);
    assert.equal(messages.length, 2);
    const message = messages.find((row) => row.id === messageId);
    assert.ok(message);
    assert.equal(message.role, 'ASSISTANT');
    assert.equal(message.status, 'COMPLETED');
    assert.equal(message.error_code, null);
    assert.equal(message.provider_error_kind, null);
    assert.deepEqual(message.sources, []);
    const identity = object(message.skill);
    for (const [key, value] of Object.entries(frozenSkillIdentity(skill))) {
        assert.deepEqual(identity[key], value);
    }
    assert.equal(identity.definition_availability, 'AVAILABLE');
    assert.equal(identity.output_availability, 'HISTORICAL_SNAPSHOT');
    const output = object(message.skill_output);
    assert.equal(output.kind, skill.definition.output_kind);
    // 只读摘要（project-resume）之外的两项都产出待确认建议；蓝图经 ApplyProjectBlueprint 接受。
    assert.equal(output.status, skill.id === 'project-resume' ? 'READ_ONLY' : 'SUGGESTED');
    assert.equal(output.target_kind, skill.definition.target);
    assert.equal(output.target_id, skill.definition.target === 'TASK' ? f.taskId : f.projectId);
    assert.deepEqual(output.baseline, basis.baseline);
    assert.equal(output.basis_sha256, basis.factsSha256);
    assert.equal(output.payload_sha256, createHash('sha256')
        .update(canonicalizeJson(object(output.payload)), 'utf8').digest('hex'));
    assert.ok(Number.isFinite(Date.parse(output.as_of)));
    const raw = await createRepositories(app.db).assist.readMessage(messageId);
    assert.ok(raw);
    assert.deepEqual(raw.skill_snapshot, frozenSkillSnapshot(skill));
    assert.deepEqual(raw.skill_output, output);
    assert.equal(calls.rows.length, 1, 'one actual Provider attempt for this isolated Skill');
    const call = calls.rows[0];
    assert.equal(call.kind, 'ASSIST');
    assert.equal(call.assist_message_id, messageId);
    assert.equal(call.step_attempt_id, null);
    assert.equal(call.manifest_id, null);
    assert.equal(call.status, 'COMPLETED');
    assert.equal(call.error_kind, null);
    assert.equal(call.provider, 'openai-compatible');
    assert.equal(call.model, config.model);
    assert.equal(call.config_fingerprint, computeModelConfigFingerprint(config));
    assert.equal(call.provider_request_id, message.provider_request_id);
    assert.ok(call.provider_request_id);
    assert.ok(call.usage_input_tokens !== null && call.usage_input_tokens > 0);
    assert.ok(call.usage_output_tokens !== null && call.usage_output_tokens > 0);
    assert.deepEqual(message.usage, { input_tokens: call.usage_input_tokens,
        output_tokens: call.usage_output_tokens,
        cache_read_tokens: call.usage_cache_read_tokens,
        cache_creation_tokens: call.usage_cache_creation_tokens });
    assert.equal(raw.usage_input_tokens, call.usage_input_tokens);
    assert.equal(raw.usage_output_tokens, call.usage_output_tokens);
    // 缓存用量按 Provider 原样透传：报了就有值，没报就保持 null，不补 0。
    assert.equal(raw.usage_cache_read_tokens, call.usage_cache_read_tokens);
    assert.equal(raw.usage_cache_creation_tokens, call.usage_cache_creation_tokens);
    assert.ok(call.settled_at !== null && call.settled_at >= call.started_at);
    return { messageId, sessionId, output, proposalIds: outcome.proposalIds, call };
}
for (const skillId of ['task-to-execution-contract', 'verification-plan']) {
    test('M04 real ' + skillId + '@1.1.0 stays suggested until exact human acceptance', { skip: !modelReady && 'valid RELAY_MODEL_* configuration not ready', timeout: 240_000 }, async () => {
        assert.ok(api);
        const f = await fixture();
        const skill = FIRST_PARTY_REGISTRY.skill(skillId, '1.1.0');
        const before = await businessSnapshot(f);
        const generated = await generate(f, skill, skillId === 'task-to-execution-contract'
            ? '请完善这个虚构任务的 Markdown 期望结果说明，并增加一条必需 HUMAN 条件：人工确认正文明确区分供水与照明。只提出建议，保留原有约束。'
            : '请只追加一条必需 HUMAN 检查：人工确认正文明确区分供水与照明。保留全部原条件，不执行检查，不声称通过。');
        assert.deepEqual(await businessSnapshot(f), before, 'model output cannot change business facts');
        await assertNoExecution(f);
        assert.equal(generated.proposalIds.length, 1);
        const proposalId = generated.proposalIds[0];
        const listed = records((await get(f, '/assist-proposals?session_id=' + generated.sessionId)).items);
        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, proposalId);
        const proposal = await get(f, '/assist-proposals/' + proposalId);
        assert.equal(proposal.message_id, generated.messageId);
        assert.equal(proposal.target_id, f.taskId);
        assert.equal(proposal.target_type, 'TASK');
        assert.equal(proposal.kind, skillId === 'task-to-execution-contract'
            ? 'TASK_CONTRACT_CHANGE' : 'VERIFICATION_PLAN_CHANGE');
        assert.equal(proposal.status, 'PENDING');
        assert.equal(proposal.decision, null);
        assert.equal(proposal.payload_available, true);
        assert.equal(proposal.base_revision, object(generated.output.baseline).task_revision);
        assert.equal(proposal.base_acceptance_revision, object(generated.output.baseline).acceptance_revision);
        assert.equal(proposal.skill_sha256, skill.sha256);
        assert.equal(proposal.skill_output_sha256, skillProposal.skillOutputHash(generated.output));
        const payload = object(proposal.payload);
        assert.equal(proposal.payload_hash, assistCommands.assistPayloadHash(payload));
        const oldCriterion = records(before.criteria)[0];
        const preserved = records(payload.criteria).find((row) => row.criterion_id === oldCriterion.criterion_id);
        assert.ok(preserved);
        for (const key of ['statement', 'required', 'method', 'target_spec']) {
            assert.deepEqual(preserved[key], oldCriterion[key]);
        }
        const oldAcceptance = records(before.acceptances)[0];
        const oldOutputs = object(oldAcceptance.required_output_spec);
        const nextOutputs = object(payload.required_output_spec);
        assert.deepEqual(nextOutputs.artifacts, oldOutputs.artifacts);
        assert.deepEqual(nextOutputs.retention, oldOutputs.retention);
        assert.ok(Array.isArray(payload.added_criterion_ids) && payload.added_criterion_ids.length > 0);
        if (skillId === 'task-to-execution-contract') {
            assert.equal(nextOutputs.description, object(object(generated.output.payload).expected_outputs).description);
        }
        else {
            assert.deepEqual(nextOutputs, oldOutputs);
            assert.equal(payload.objective, oldAcceptance.objective);
            assert.equal(object(generated.output.payload).effective_check_plan, false);
        }
        const commandId = randomUUID();
        const body = { command_id: commandId, expected_task_revision: proposal.base_revision,
            expected_acceptance_revision: proposal.base_acceptance_revision, payload_hash: proposal.payload_hash };
        const path = workspacePath(f.workspaceId, '/assist-proposals/' + proposalId + '/accept');
        const response = await api.post(path, body);
        const accepted = expectCommandAccepted(response, 200, commandId);
        assert.equal(accepted.proposal_id, proposalId);
        assert.equal(accepted.revision, (BigInt(proposal.base_revision) + 1n).toString());
        assert.equal(accepted.acceptance_revision, (BigInt(proposal.base_acceptance_revision) + 1n).toString());
        assert.deepEqual(accepted.required_output_spec, nextOutputs);
        assert.equal(accepted.objective, payload.objective);
        assert.deepEqual(accepted.added_criterion_ids, payload.added_criterion_ids);
        const afterAcceptance = await businessSnapshot(f);
        assert.deepEqual(afterAcceptance.project, before.project);
        assert.deepEqual(afterAcceptance.state, before.state);
        const oldTask = records(before.tasks)[0];
        const task = records(afterAcceptance.tasks)[0];
        assert.equal(String(task.revision), accepted.revision);
        assert.equal(String(task.acceptance_revision), accepted.acceptance_revision);
        for (const key of ['status', 'mode', 'executor_kind', 'executor_run_id',
            'ownership_epoch', 'current_completion_id'])
            assert.deepEqual(task[key], oldTask[key]);
        const savedAcceptances = records(afterAcceptance.acceptances);
        assert.equal(savedAcceptances.length, 2);
        assert.deepEqual(savedAcceptances[0], oldAcceptance);
        assert.equal(savedAcceptances[1].objective, payload.objective);
        assert.deepEqual(savedAcceptances[1].required_output_spec, nextOutputs);
        const savedCriteria = records(afterAcceptance.criteria).filter((row) => String(row.acceptance_revision) === accepted.acceptance_revision);
        assert.equal(savedCriteria.length, records(payload.criteria).length);
        for (const criterion of records(payload.criteria)) {
            const saved = savedCriteria.find((row) => row.criterion_id === criterion.criterion_id);
            assert.ok(saved);
            for (const key of ['statement', 'required', 'method', 'target_spec']) {
                assert.deepEqual(saved[key], criterion[key]);
            }
        }
        const current = await get(f, '/assist-proposals/' + proposalId);
        assert.equal(current.status, 'ACCEPTED');
        assert.equal(object(current.decision).command_id, commandId);
        assert.deepEqual(object(current.decision).result, accepted);
        const replay = await api.post(path, body);
        assert.deepEqual(expectCommandAccepted(replay, 200, commandId), accepted);
        assert.equal(replay.headers['command-replayed'], 'true');
        assert.deepEqual(await businessSnapshot(f), afterAcceptance, 'command replay cannot reapply the contract');
        const audit = await sql `select
        (select count(*)::text from command_receipts where command_id = ${commandId}) as receipts,
        (select count(*)::text from activity_records where command_id = ${commandId}
          and event_type = 'TASK_ACCEPTANCE_CHANGED') as activities`.execute(app.db);
        assert.deepEqual(audit.rows[0], { receipts: '1', activities: '1' });
        const preview = await get(f, '/tasks/' + f.taskId + '/check-plan-preview');
        assert.equal(preview.status, 'AVAILABLE');
        assert.equal(object(preview.sources).acceptance_revision, accepted.acceptance_revision);
        assert.equal(preview.executed, false);
        assert.equal(preview.frozen_run_plan, false);
        for (const entry of records(object(preview.check_plan).entries)) {
            assert.ok(checkers.hasChecker(entry.checker_id, entry.checker_version));
        }
        await assertNoExecution(f);
        assert.deepEqual((await sql `select * from model_calls
        where workspace_id = ${f.workspaceId}`.execute(app.db)).rows, [generated.call]);
        console.log('real_skill_evidence ' + JSON.stringify({ skill: skill.id, version: skill.version,
            skill_sha256: skill.sha256, call_id: generated.call.id,
            config_fingerprint: generated.call.config_fingerprint, output_sha256: skillProposal.skillOutputHash(generated.output),
            payload_sha256: proposal.payload_hash, accepted_proposal: proposalId,
            acceptance_revision: accepted.acceptance_revision, replay_effects: 1, runs: 0, completions: 0, checks: 0 }));
    });
}
test('M04 real project-resume@1.0.0 references fresh facts and remains read-only', { skip: !modelReady && 'valid RELAY_MODEL_* configuration not ready', timeout: 240_000 }, async () => {
    const f = await fixture();
    const skill = FIRST_PARTY_REGISTRY.skill('project-resume', '1.0.0');
    const initialBasis = await loadSkillBasis(app.db, f.workspaceId, f.projectId, null, skill);
    await editTaskPresentation(app.db, { workspaceId: f.workspaceId, taskId: f.taskId,
        commandId: randomUUID(), expectedRevision: '0', title: 'Synthetic greenhouse briefing: current title' });
    const before = await businessSnapshot(f);
    const generated = await generate(f, skill, '请概述这个虚构项目当前的项目事实与唯一 Task；highlights 至少分别引用一次当前 PROJECT 和 TASK 的确切 ID，Task 的 statement 中原样包含当前 Task 标题。只描述当前事实并给出待人工判断的下一步，没有比较基线，不改变状态，不宣称 Task 完成。');
    assert.deepEqual(await businessSnapshot(f), before);
    await assertNoExecution(f);
    assert.deepEqual(generated.proposalIds, []);
    assert.deepEqual((await get(f, '/assist-proposals?session_id=' + generated.sessionId)).items, []);
    const proposals = await sql `select count(*)::text as count from assist_proposals
      where workspace_id = ${f.workspaceId}`.execute(app.db);
    assert.equal(proposals.rows[0].count, '0');
    const payload = object(generated.output.payload);
    assert.equal(payload.read_only, true);
    assert.equal(payload.comparison_baseline, null);
    const baseline = object(generated.output.baseline);
    assert.equal(baseline.project_revision, String(object(before.project).revision));
    assert.equal(baseline.state_revision, String(object(before.state).revision));
    assert.equal(records(baseline.tasks).length, 1);
    assert.equal(records(baseline.tasks)[0].id, f.taskId);
    assert.equal(records(baseline.tasks)[0].revision, '1');
    assert.equal(records(baseline.tasks)[0].acceptance_revision, '1');
    assert.equal(records(baseline.tasks)[0].current_completion_id, null);
    assert.notEqual(generated.output.basis_sha256, initialBasis.factsSha256);
    const highlights = records(payload.highlights);
    assert.ok(highlights.some((entry) => entry.ref_kind === 'PROJECT' && entry.ref_id === f.projectId));
    assert.ok(highlights.some((entry) => entry.ref_kind === 'TASK' && entry.ref_id === f.taskId));
    assert.ok(highlights.some((entry) => entry.ref_kind === 'TASK' && entry.ref_id === f.taskId &&
        typeof entry.statement === 'string' && entry.statement.includes(records(before.tasks)[0].title)));
    for (const entry of highlights) {
        assert.ok(entry.ref_kind === 'PROJECT' && entry.ref_id === f.projectId ||
            entry.ref_kind === 'TASK' && entry.ref_id === f.taskId, 'only current fixture facts may be referenced');
    }
    assert.deepEqual(baseline.decisions, []);
    assert.deepEqual(baseline.verifications, []);
    console.log('real_skill_evidence ' + JSON.stringify({ skill: skill.id, version: skill.version,
        skill_sha256: skill.sha256, call_id: generated.call.id,
        config_fingerprint: generated.call.config_fingerprint, output_sha256: skillProposal.skillOutputHash(generated.output),
        task_revision: '1', read_only: true, comparison_baseline: null, proposals: 0,
        runs: 0, completions: 0, checks: 0 }));
});
test('M04 real goal-to-project-blueprint@1.0.0 freezes source and applies only on explicit human confirm', { skip: !modelReady && 'valid RELAY_MODEL_* configuration not ready', timeout: 240_000 }, async () => {
    assert.ok(api);
    // 蓝图 Skill 的作用域要求项目已有内置 View 行；只有生产建项目命令会种下它，
    // 所以这里用该命令另建一个项目，而不是在共享 fixture 上补写视图行。
    const f = await blueprintFixture();
    const skill = FIRST_PARTY_REGISTRY.skill('goal-to-project-blueprint', '1.0.0');
    const pack = FIRST_PARTY_REGISTRY.pack('development-minimal', '1.3.0');
    assert.equal(pack.availability, 'AVAILABLE');
    // 生成前先存在一个 ACTIVE Goal：蓝图只能关联它，不得凭空创建 Goal。
    const goal = await createGoal(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
        title: 'Synthetic lunar greenhouse programme', description: '' });
    const goalId = goal.result.goal_id;
    // 蓝图 Skill 的作用域要求项目已有内置 View 配置；这里走既有设置命令，不手写视图行。
    const view = await setViewConfiguration(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, commandId: randomUUID(), expectedRevision: '0', kind: 'general' });
    const viewRevision = view.result.revision;
    assert.equal(viewRevision, '1');
    const before = await businessSnapshot(f);
    const generated = await generate(f, skill, '请为这个虚构项目提出项目蓝图：最多三个待办 Task，全部是人工执行的 INBOX 任务，'
        + '并把工作台设为 general。next_action 指向其中一个新建任务的 local_key。'
        + '不要建立 Goal，不要提出 Rule、Workflow 或权限建议。', { desired_outcome: '形成一份虚构月球温室项目的下一步计划',
        goal_id: goalId, pack_ref: { id: 'development-minimal', version: '1.3.0' } });
    const payload = object(generated.output.payload);
    assert.equal(payload.effective_blueprint, false);
    assert.equal(generated.output.status, 'SUGGESTED');
    // 生成只写候选：项目事实、Task、验收、State 一个字节都不能变。
    assert.deepEqual(await businessSnapshot(f), before, 'blueprint generation cannot change business facts');
    await assertNoExecution(f);
    assert.equal(generated.proposalIds.length, 1);
    const proposalId = generated.proposalIds[0];
    // 选择 Pack 只是固定候选来源：不授权、不建连接、不建策略、不启动 Run。
    // 能力按连接归属统计，不能直接数全局 gateway_capabilities——同一测试库还有别的分片。
    const authorization = await sql `select
      (select count(*)::text from gateway_permission_policies
        where project_id = ${f.projectId}) as policies,
      (select count(*)::text from gateway_connections where project_id = ${f.projectId}) as connections,
      (select count(*)::text from gateway_connection_capabilities c
        join gateway_connections k on k.id = c.connection_id
        where k.project_id = ${f.projectId}) as capabilities,
      (select count(*)::text from runs where workspace_id = ${f.workspaceId}) as runs,
      (select count(*)::text from goals where workspace_id = ${f.workspaceId}) as goals`
        .execute(app.db);
    assert.deepEqual(authorization.rows[0], { policies: '0', connections: '0',
        capabilities: '0', runs: '0', goals: '1' });
    const stored = await sql `
      select origin, skill_message_id, status, candidate_sha256, source
      from project_blueprint_proposals where id = ${proposalId}`.execute(app.db);
    const row = stored.rows[0];
    assert.equal(row.origin, 'SKILL');
    assert.equal(row.skill_message_id, generated.messageId);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.source.pack.id, 'development-minimal');
    assert.equal(row.source.pack.version, '1.3.0');
    assert.equal(row.source.pack.sha256, pack.sha256);
    assert.equal(row.source.skill.id, skill.id);
    assert.equal(row.source.skill.version, skill.version);
    assert.equal(row.source.skill.sha256, skill.sha256);
    assert.equal(row.source.skill_output_sha256, skillProposal.skillOutputHash(generated.output));
    // 候选形态受注册与数量上限约束，且只建议 HUMAN/ME/INBOX。
    const draft = object(object(payload.draft));
    const draftTasks = records(draft.tasks);
    assert.ok(draftTasks.length >= 1 && draftTasks.length <= 5);
    for (const task of draftTasks) {
        assert.equal(typeof task.local_key, 'string');
        assert.equal(typeof task.title, 'string');
        assert.equal(typeof task.objective, 'string');
    }
    assert.ok(['general', 'thesis', 'development'].includes(String(draft.view_kind)));
    // 预览与差异走只读投影，不调用动作、不写事实。
    const path = workspacePath(f.workspaceId, '/projects/' + f.projectId +
        '/blueprint-proposals/' + proposalId);
    const preview = await get(f, '/projects/' + f.projectId + '/blueprint-proposals/' + proposalId);
    assert.equal(preview.status, 'PENDING');
    assert.equal(preview.stale, false);
    const diff = object(preview.diff);
    assert.equal(records(diff.new_tasks).length, draftTasks.length);
    assert.deepEqual(await businessSnapshot(f), before, 'preview cannot change business facts');
    await assertNoExecution(f);
    // 未确认前不得有任何业务效果。
    const commandId = randomUUID();
    const applyBody = { command_id: commandId, candidate_sha256: row.candidate_sha256,
        expected_project_revision: '0', expected_state_revision: '0',
        expected_view_revision: viewRevision };
    const staleConfirm = await api.post(workspacePath(f.workspaceId, '/projects/' + f.projectId + '/blueprint-proposals/' + proposalId + '/apply'), { ...applyBody, command_id: randomUUID(), expected_state_revision: '9' });
    assert.equal(staleConfirm.status, 409);
    assert.deepEqual(await businessSnapshot(f), before, 'a rejected confirm cannot leave partial blueprint effects');
    const applied = expectCommandAccepted(await api.post(path + '/apply', applyBody), 200, commandId);
    assert.deepEqual(applied.goal_ids, [goalId], 'only the explicitly referenced Goal is linked');
    assert.equal(applied.task_id_map.length, draftTasks.length);
    assert.equal(applied.next_action_task_id, applied.task_id_map[0].task_id);
    const createdTaskIds = applied.task_id_map.map((entry) => entry.task_id);
    const createdTasks = await sql `select t.title, t.status, t.mode, t.executor_kind
      from tasks t where t.project_id = ${f.projectId}
        and t.id in (${sql.join(createdTaskIds.map((id) => sql `${id}`))})`
        .execute(app.db);
    assert.equal(createdTasks.rows.length, draftTasks.length);
    assert.ok(createdTasks.rows.every((task) => task.status === 'INBOX' &&
        task.mode === 'ME' && task.executor_kind === 'HUMAN'), 'a blueprint may only create human INBOX tasks; it never delegates or marks work ready');
    // 应用后仍不启动任何执行，也不因为选了 Pack 就授权。
    await assertNoExecution(f);
    const afterApply = await businessSnapshot(f);
    assert.notDeepEqual(afterApply, before);
    const proposalsAfter = await sql `select status
      from project_blueprint_proposals where id = ${proposalId}`.execute(app.db);
    assert.equal(proposalsAfter.rows[0].status, 'ACCEPTED');
    const stillNoPolicy = await sql `select count(*)::text as count
      from gateway_permission_policies where project_id = ${f.projectId}`.execute(app.db);
    assert.equal(stillNoPolicy.rows[0].count, '0');
    // 重放同一命令只读回执，不产生第二组效果。
    const replay = await api.post(path + '/apply', applyBody);
    assert.deepEqual(expectCommandAccepted(replay, 200, commandId), applied);
    assert.equal(replay.headers['command-replayed'], 'true');
    assert.deepEqual(await businessSnapshot(f), afterApply, 'replay cannot reapply the blueprint');
    const audit = await sql `select
      (select count(*)::text from command_receipts where command_id = ${commandId}) as receipts,
      (select count(*)::text from activity_records where command_id = ${commandId}
        and event_type = 'PROJECT_BLUEPRINT_APPLIED') as applied`.execute(app.db);
    assert.deepEqual(audit.rows[0], { receipts: '1', applied: '1' });
    // 取消：生成中的消息可持久化取消意图，且取消不产生候选。
    const cancelSession = await command(f, '/assist-sessions', { project_id: f.projectId,
        title: 'Synthetic cancel' }, 201);
    const cancelMessage = await command(f, '/assist-sessions/' + cancelSession.session_id +
        '/messages', { content: '再生成一份蓝图', skill_ref: { id: skill.id, version: skill.version },
        source_refs: [], skill_input: { goal_id: goalId } }, 202);
    // 取消是同步收敛的持久化意图：回执 200 且状态已是 CANCELLED，不进入生成。
    const cancelled = await command(f, '/assist-messages/' +
        String(cancelMessage.assistant_message_id) + '/cancel', {}, 200);
    assert.equal(cancelled.status, 'CANCELLED');
    const cancelOutcome = await assistRunner.runAssistGenerationTick(app.db, {
        workerId: 'real-skill-cancel-' + randomUUID(),
        storage: new ManagedContentStore(api.dataRoot), modelPort: new OpenAiCompatibleModelPort(readModelPortConfig(process.env)), leaseMs: 30_000
    });
    assert.notEqual(cancelOutcome?.status, 'COMPLETED');
    const cancelCandidates = await sql `select count(*)::text as count
      from project_blueprint_proposals where workspace_id = ${f.workspaceId}
        and id <> ${proposalId}`.execute(app.db);
    assert.equal(cancelCandidates.rows[0].count, '0', 'a cancelled generation must not leave a blueprint candidate');
    assert.deepEqual(await businessSnapshot(f), afterApply, 'cancellation cannot change business facts');
    console.log('real_skill_evidence ' + JSON.stringify({ skill: skill.id, version: skill.version,
        skill_sha256: skill.sha256, call_id: generated.call.id,
        config_fingerprint: generated.call.config_fingerprint,
        output_sha256: skillProposal.skillOutputHash(generated.output),
        candidate_sha256: row.candidate_sha256, pack: pack.id + '@' + pack.version,
        pack_sha256: pack.sha256, goal_ids: applied.goal_ids, tasks: applied.task_id_map.length,
        apply_command_id: commandId, replay_effects: 1, policies_after: 0,
        runs: 0, completions: 0, checks: 0 }));
});
