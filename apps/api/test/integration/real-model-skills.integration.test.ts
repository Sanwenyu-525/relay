// Opt-in M04: three bundled Skills through the real Provider and existing Assist/Task Owners.
// Without valid explicit model configuration, no API or model invocation is started.
// Every business fact sent to the Provider is an isolated synthetic fixture.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { editTaskPresentation } from '../../src/application/task-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import type { ModelCallRow } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { canonicalizeJson } from '../../src/receipt/payload-hash.js';
import { FIRST_PARTY_REGISTRY, frozenSkillIdentity, frozenSkillSnapshot,
  type FrozenSkill } from '../../src/skills/first-party-registry.js';
import { loadSkillBasis } from '../../src/skills/skill-basis.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { MODEL_ERROR_CATEGORIES } from '../../src/workflow/model-error-classification.js';
import { computeModelConfigFingerprint, describeModelPortStatus, readModelPortConfig }
  from '../../src/workflow/model-port-config.js';
import { OpenAiCompatibleModelPort } from '../../src/workflow/openai-compatible-model-port.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath,
  type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

const modelReady = describeModelPortStatus(process.env).configured;
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-real-model-skills');
let api: TestApi | undefined;
let assistCommands: typeof import('../../src/application/assist-commands.js');
let assistRunner: typeof import('../../src/application/assist-runner.js');
let skillProposal: typeof import('../../src/skills/skill-proposal.js');
let checkers: typeof import('../../src/workflow/checkers.js');

before(async () => {
  if (!modelReady) return;
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
  if (failures.length) throw new AggregateError(failures, 'real Skill cleanup failed');
  if (api) {
    assert.equal(closed[0]!.status, 'fulfilled');
    if (closed[0]!.status === 'fulfilled') assert.equal(closed[0]!.value, 0);
    console.log('real_skill_cleanup api_exit=0 temporary_data_removed=true');
  }
});

interface Fixture {
  workspaceId: string;
  projectId: string;
  taskId: string;
}

function object(value: unknown): JsonObject {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as JsonObject;
}

function records(value: unknown): JsonObject[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}

async function command(f: Fixture, path: string, body: object,
  status: 200 | 201 | 202): Promise<Record<string, unknown>> {
  assert.ok(api);
  const commandId = randomUUID();
  return expectCommandAccepted(await api.post(workspacePath(f.workspaceId, path),
    { ...body, command_id: commandId }), status, commandId);
}

async function get(f: Fixture, path: string): Promise<JsonObject> {
  assert.ok(api);
  const response = await api.get(workspacePath(f.workspaceId, path));
  assert.equal(response.status, 200);
  return object(response.body);
}

async function fixture(): Promise<Fixture> {
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

async function businessSnapshot(f: Fixture): Promise<JsonObject> {
  const result = await sql<{ snapshot: JsonObject }>`select jsonb_build_object(
    'project', (select to_jsonb(p) from projects p where p.id = ${f.projectId}),
    'state', (select to_jsonb(s) from project_states s where s.project_id = ${f.projectId}),
    'tasks', (select jsonb_agg(to_jsonb(t) order by t.id) from tasks t
      where t.project_id = ${f.projectId}),
    'acceptances', (select jsonb_agg(to_jsonb(a) order by a.task_id, a.acceptance_revision)
      from task_acceptances a join tasks t on t.id = a.task_id where t.project_id = ${f.projectId}),
    'criteria', (select jsonb_agg(to_jsonb(c) order by c.task_id, c.acceptance_revision, c.criterion_id)
      from acceptance_criteria c join tasks t on t.id = c.task_id where t.project_id = ${f.projectId})
    ) as snapshot`.execute(app.db);
  return result.rows[0]!.snapshot;
}

async function assertNoExecution(f: Fixture): Promise<void> {
  const result = await sql<{ runs: string; artifacts: string; completions: string;
    verifications: string; checks: string; state_completions: string }>`select
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

async function generate(f: Fixture, skill: FrozenSkill, content: string): Promise<{
  messageId: string; sessionId: string; output: JsonObject; proposalIds: readonly string[];
  call: ModelCallRow;
}> {
  assert.ok(api);
  const config = readModelPortConfig(process.env);
  assert.ok(config);
  const modelPort = new OpenAiCompatibleModelPort(config);
  const registryDto = await get(f, '/skill-definitions/' + skill.id + '/versions/' + skill.version);
  assert.equal(registryDto.call_supported, true);
  assert.equal(registryDto.accept_supported, skill.definition.target === 'TASK');
  for (const [key, value] of Object.entries(frozenSkillIdentity(skill))) {
    assert.deepEqual(registryDto[key], value);
  }
  const session = await command(f, '/assist-sessions', {
    ...(skill.definition.target === 'TASK' ? { task_id: f.taskId } : { project_id: f.projectId }),
    title: 'Synthetic real Skill ' + skill.id,
  }, 201);
  const sessionId = session.session_id as string;
  const basis = await loadSkillBasis(app.db, f.workspaceId, f.projectId,
    skill.definition.target === 'TASK' ? f.taskId : null, skill);
  const request = await command(f, '/assist-sessions/' + sessionId + '/messages', {
    content, skill_ref: { id: skill.id, version: skill.version }, source_refs: [],
  }, 202);
  const messageId = request.assistant_message_id as string;
  const outcome = await assistRunner.runAssistGenerationTick(app.db, {
    workerId: 'real-skill-' + randomUUID(), storage: new ManagedContentStore(api.dataRoot),
    modelPort, leaseMs: 30_000,
  });
  const calls = await sql<ModelCallRow>`select * from model_calls
    where workspace_id = ${f.workspaceId}`.execute(app.db);
  if (outcome?.status !== 'COMPLETED') {
    const knownErrors = new Set<string>([...MODEL_ERROR_CATEGORIES,
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
  const message = messages.find((row) => row.id === messageId)!;
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
  assert.equal(output.status, skill.definition.target === 'TASK' ? 'SUGGESTED' : 'READ_ONLY');
  assert.equal(output.target_kind, skill.definition.target);
  assert.equal(output.target_id, skill.definition.target === 'TASK' ? f.taskId : f.projectId);
  assert.deepEqual(output.baseline, basis.baseline);
  assert.equal(output.basis_sha256, basis.factsSha256);
  assert.equal(output.payload_sha256, createHash('sha256')
    .update(canonicalizeJson(object(output.payload)), 'utf8').digest('hex'));
  assert.ok(Number.isFinite(Date.parse(output.as_of as string)));
  const raw = await createRepositories(app.db).assist.readMessage(messageId);
  assert.ok(raw);
  assert.deepEqual(raw.skill_snapshot, frozenSkillSnapshot(skill));
  assert.deepEqual(raw.skill_output, output);
  assert.equal(calls.rows.length, 1, 'one actual Provider attempt for this isolated Skill');
  const call = calls.rows[0]!;
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
    output_tokens: call.usage_output_tokens });
  assert.equal(raw.usage_input_tokens, call.usage_input_tokens);
  assert.equal(raw.usage_output_tokens, call.usage_output_tokens);
  assert.ok(call.settled_at !== null && call.settled_at >= call.started_at);
  return { messageId, sessionId, output, proposalIds: outcome.proposalIds, call };
}

for (const skillId of ['task-to-execution-contract', 'verification-plan'] as const) {
  test('M04 real ' + skillId + '@1.1.0 stays suggested until exact human acceptance',
    { skip: !modelReady && 'valid RELAY_MODEL_* configuration not ready', timeout: 240_000 }, async () => {
      assert.ok(api);
      const f = await fixture();
      const skill = FIRST_PARTY_REGISTRY.skill(skillId, '1.1.0')!;
      const before = await businessSnapshot(f);
      const generated = await generate(f, skill, skillId === 'task-to-execution-contract'
        ? '请完善这个虚构任务的 Markdown 期望结果说明，并增加一条必需 HUMAN 条件：人工确认正文明确区分供水与照明。只提出建议，保留原有约束。'
        : '请只追加一条必需 HUMAN 检查：人工确认正文明确区分供水与照明。保留全部原条件，不执行检查，不声称通过。');
      assert.deepEqual(await businessSnapshot(f), before, 'model output cannot change business facts');
      await assertNoExecution(f);
      assert.equal(generated.proposalIds.length, 1);
      const proposalId = generated.proposalIds[0]!;
      const listed = records((await get(f, '/assist-proposals?session_id=' + generated.sessionId)).items);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.id, proposalId);
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
      const oldCriterion = records(before.criteria)[0]!;
      const preserved = records(payload.criteria).find((row) => row.criterion_id === oldCriterion.criterion_id)!;
      assert.ok(preserved);
      for (const key of ['statement', 'required', 'method', 'target_spec']) {
        assert.deepEqual(preserved[key], oldCriterion[key]);
      }
      const oldAcceptance = records(before.acceptances)[0]!;
      const oldOutputs = object(oldAcceptance.required_output_spec);
      const nextOutputs = object(payload.required_output_spec);
      assert.deepEqual(nextOutputs.artifacts, oldOutputs.artifacts);
      assert.deepEqual(nextOutputs.retention, oldOutputs.retention);
      assert.ok(Array.isArray(payload.added_criterion_ids) && payload.added_criterion_ids.length > 0);
      if (skillId === 'task-to-execution-contract') {
        assert.equal(nextOutputs.description, object(object(generated.output.payload).expected_outputs).description);
      } else {
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
      assert.equal(accepted.revision, (BigInt(proposal.base_revision as string) + 1n).toString());
      assert.equal(accepted.acceptance_revision,
        (BigInt(proposal.base_acceptance_revision as string) + 1n).toString());
      assert.deepEqual(accepted.required_output_spec, nextOutputs);
      assert.equal(accepted.objective, payload.objective);
      assert.deepEqual(accepted.added_criterion_ids, payload.added_criterion_ids);
      const afterAcceptance = await businessSnapshot(f);
      assert.deepEqual(afterAcceptance.project, before.project);
      assert.deepEqual(afterAcceptance.state, before.state);
      const oldTask = records(before.tasks)[0]!;
      const task = records(afterAcceptance.tasks)[0]!;
      assert.equal(String(task.revision), accepted.revision);
      assert.equal(String(task.acceptance_revision), accepted.acceptance_revision);
      for (const key of ['status', 'mode', 'executor_kind', 'executor_run_id',
        'ownership_epoch', 'current_completion_id']) assert.deepEqual(task[key], oldTask[key]);
      const savedAcceptances = records(afterAcceptance.acceptances);
      assert.equal(savedAcceptances.length, 2);
      assert.deepEqual(savedAcceptances[0], oldAcceptance);
      assert.equal(savedAcceptances[1]!.objective, payload.objective);
      assert.deepEqual(savedAcceptances[1]!.required_output_spec, nextOutputs);
      const savedCriteria = records(afterAcceptance.criteria).filter((row) =>
        String(row.acceptance_revision) === accepted.acceptance_revision);
      assert.equal(savedCriteria.length, records(payload.criteria).length);
      for (const criterion of records(payload.criteria)) {
        const saved = savedCriteria.find((row) => row.criterion_id === criterion.criterion_id)!;
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
      const audit = await sql<{ receipts: string; activities: string }>`select
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
        assert.ok(checkers.hasChecker(entry.checker_id as string, entry.checker_version as string));
      }
      await assertNoExecution(f);
      assert.deepEqual((await sql<ModelCallRow>`select * from model_calls
        where workspace_id = ${f.workspaceId}`.execute(app.db)).rows, [generated.call]);
      console.log('real_skill_evidence ' + JSON.stringify({ skill: skill.id, version: skill.version,
        skill_sha256: skill.sha256, call_id: generated.call.id,
        config_fingerprint: generated.call.config_fingerprint, output_sha256: skillProposal.skillOutputHash(generated.output),
        payload_sha256: proposal.payload_hash, accepted_proposal: proposalId,
        acceptance_revision: accepted.acceptance_revision, replay_effects: 1, runs: 0, completions: 0, checks: 0 }));
    });
}

test('M04 real project-resume@1.0.0 references fresh facts and remains read-only',
  { skip: !modelReady && 'valid RELAY_MODEL_* configuration not ready', timeout: 240_000 }, async () => {
    const f = await fixture();
    const skill = FIRST_PARTY_REGISTRY.skill('project-resume', '1.0.0')!;
    const initialBasis = await loadSkillBasis(app.db, f.workspaceId, f.projectId, null, skill);
    await editTaskPresentation(app.db, { workspaceId: f.workspaceId, taskId: f.taskId,
      commandId: randomUUID(), expectedRevision: '0', title: 'Synthetic greenhouse briefing: current title' });
    const before = await businessSnapshot(f);
    const generated = await generate(f, skill,
      '请概述这个虚构项目当前的项目事实与唯一 Task；highlights 至少分别引用一次当前 PROJECT 和 TASK 的确切 ID，Task 的 statement 中原样包含当前 Task 标题。只描述当前事实并给出待人工判断的下一步，没有比较基线，不改变状态，不宣称 Task 完成。');
    assert.deepEqual(await businessSnapshot(f), before);
    await assertNoExecution(f);
    assert.deepEqual(generated.proposalIds, []);
    assert.deepEqual((await get(f, '/assist-proposals?session_id=' + generated.sessionId)).items, []);
    const proposals = await sql<{ count: string }>`select count(*)::text as count from assist_proposals
      where workspace_id = ${f.workspaceId}`.execute(app.db);
    assert.equal(proposals.rows[0]!.count, '0');
    const payload = object(generated.output.payload);
    assert.equal(payload.read_only, true);
    assert.equal(payload.comparison_baseline, null);
    const baseline = object(generated.output.baseline);
    assert.equal(baseline.project_revision, String(object(before.project).revision));
    assert.equal(baseline.state_revision, String(object(before.state).revision));
    assert.equal(records(baseline.tasks).length, 1);
    assert.equal(records(baseline.tasks)[0]!.id, f.taskId);
    assert.equal(records(baseline.tasks)[0]!.revision, '1');
    assert.equal(records(baseline.tasks)[0]!.acceptance_revision, '1');
    assert.equal(records(baseline.tasks)[0]!.current_completion_id, null);
    assert.notEqual(generated.output.basis_sha256, initialBasis.factsSha256);
    const highlights = records(payload.highlights);
    assert.ok(highlights.some((entry) => entry.ref_kind === 'PROJECT' && entry.ref_id === f.projectId));
    assert.ok(highlights.some((entry) => entry.ref_kind === 'TASK' && entry.ref_id === f.taskId));
    assert.ok(highlights.some((entry) => entry.ref_kind === 'TASK' && entry.ref_id === f.taskId &&
      typeof entry.statement === 'string' && entry.statement.includes(records(before.tasks)[0]!.title as string)));
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
