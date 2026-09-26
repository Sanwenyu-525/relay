import assert from 'node:assert/strict';
import test from 'node:test';

import { FIRST_PARTY_REGISTRY, availableFrozenSkill, createFirstPartyRegistry,
  inspectFrozenSkillSnapshot,
  frozenSkillSnapshot, type PackDefinition } from '../../src/skills/first-party-registry.js';
import { parseSkillOutput } from '../../src/skills/skill-output.js';
import { buildTaskSkillProposal } from '../../src/skills/skill-proposal.js';
import type { SkillBasis } from '../../src/skills/skill-basis.js';

const task = FIRST_PARTY_REGISTRY.skill('task-to-execution-contract', '1.0.0')!;
const taskV11 = FIRST_PARTY_REGISTRY.skill('task-to-execution-contract', '1.1.0')!;
const verification = FIRST_PARTY_REGISTRY.skill('verification-plan', '1.0.0')!;
const verificationV11 = FIRST_PARTY_REGISTRY.skill('verification-plan', '1.1.0')!;
const resume = FIRST_PARTY_REGISTRY.skill('project-resume', '1.0.0')!;
const basis: SkillBasis = { asOf: '2026-09-26T00:00:00.000Z',
  baseline: { task_id: 'task-1', task_revision: '2', acceptance_revision: '1' },
  facts: { registered_checks: [{ criterion_id: 'human', checker_id: 'human-review',
    checker_version: '1.0.0', required: true }], project: { id: 'project-1' },
  tasks: [{ id: 'task-1' }] }, factsSha256: 'a'.repeat(64), section: '' };

test('first-party registry freezes dependency bodies and rejects unknown Pack members', () => {
  const snapshot = frozenSkillSnapshot(task);
  assert.equal(availableFrozenSkill(snapshot)?.sha256, task.sha256);
  const changed = structuredClone(snapshot);
  const dependencies = changed.dependencies as Record<string, unknown>[];
  (dependencies[0]!.definition as Record<string, unknown>).history_limit = 999;
  assert.equal(availableFrozenSkill(changed), null);
  assert.equal(inspectFrozenSkillSnapshot(changed), null);
  assert.equal(availableFrozenSkill({ id: task.id, version: task.version,
    sha256: task.sha256, dependencies: [{}] }), null);

  const deps = FIRST_PARTY_REGISTRY.skills.flatMap((skill) => skill.dependencies);
  const defs = FIRST_PARTY_REGISTRY.skills.map((skill) => skill.definition);
  const invalid: PackDefinition = { id: 'thesis-minimal', version: '1.0.0',
    title: 'invalid', host_contract: 'relay-v1',
    members: [{ kind: 'SKILL', id: 'missing' as typeof task.id, version: '1.0.0' }] };
  assert.throws(() => createFirstPartyRegistry(deps, defs, [invalid]),
    /unknown first-party Pack member/u);
});

test('Task Definition output rejects unbounded or permissive model JSON', () => {
  const valid = { summary: '建议', proposal: { objective: '明确结果',
    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ statement: '人工检查', required: true, method: 'HUMAN' }] } };
  const parsed = parseSkillOutput(task, JSON.stringify(valid), basis)!;
  assert.equal(parsed.kind, 'TASK_DEFINITION_SUGGESTION');
  assert.equal(parsed.status, 'SUGGESTED');
  assert.equal(parsed.target_id, 'task-1');
  assert.equal(parseSkillOutput(task, JSON.stringify({ ...valid,
    proposal: { ...valid.proposal, auto_apply: true } }), basis), null);
  assert.equal(parseSkillOutput(task, JSON.stringify({ ...valid,
    proposal: { ...valid.proposal, criteria: [{ statement: '空条件',
      required: false, method: 'HUMAN' }] } }), basis), null);
  assert.equal(parseSkillOutput(task, JSON.stringify({ ...valid,
    summary: '大'.repeat(9_000) }), basis), null);
});

test('Verification Plan output must match registered checks and Resume refs must be current', () => {
  const valid = { summary: '方案', proposal: { checks: [
    { criterion_id: 'human', checker_id: 'human-review', required: true }] } };
  assert.equal(parseSkillOutput(verification, JSON.stringify(valid), basis)?.kind,
    'VERIFICATION_PLAN_SUGGESTION');
  assert.equal(parseSkillOutput(verification, JSON.stringify({ ...valid,
    proposal: { checks: [{ criterion_id: 'human', checker_id: 'shell', required: true }] } }),
  basis), null);
  const projectBasis: SkillBasis = { ...basis, baseline: { project_id: 'project-1' } };
  const current = { summary: '当前事实', proposal: { highlights: [
    { statement: '项目可见', ref_kind: 'PROJECT', ref_id: 'project-1' }],
    next_steps: ['建议人工查看'] } };
  const output = parseSkillOutput(resume, JSON.stringify(current), projectBasis)!;
  assert.equal(output.kind, 'PROJECT_RESUME');
  assert.equal((output.payload as Record<string, unknown>).comparison_baseline, null);
  assert.equal(parseSkillOutput(resume, JSON.stringify({ ...current,
    proposal: { ...current.proposal, highlights: [{ statement: '旧记录',
      ref_kind: 'TASK', ref_id: 'unknown' }] } }), projectBasis), null);
});

test('v1.1 Verification Plan only appends checks; objective-only Task Definition remains reviewable', () => {
  const taskBasis: SkillBasis = { ...basis, facts: { ...basis.facts,
    acceptance: { objective: '原目标', required_output_spec: {
      artifacts: ['MARKDOWN_DOCUMENT'] }, criteria: [{ criterion_id: 'human',
      statement: '人工验收', required: true, method: 'HUMAN', target_spec: {} }] } } };
  const old = { summary: '改变目标', proposal: { objective: '新目标',
    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ statement: '人工验收', required: true, method: 'HUMAN' }] } };
  const parsed = parseSkillOutput(task, JSON.stringify(old), taskBasis)!;
  const merged = buildTaskSkillProposal(task, taskBasis, parsed,
    '11111111-1111-4111-8111-111111111111')!;
  assert.equal(merged.objective, '新目标');
  assert.deepEqual(merged.added_criterion_ids, []);
  assert.equal((merged.criteria as { criterion_id: string }[])[0]!.criterion_id, 'human');
  const proposed = { summary: '补充检查', proposal: { additional_checks: [
    { statement: '包含结论', required: true, method: 'MARKDOWN_STRUCTURE' }] } };
  const v11 = parseSkillOutput(verificationV11, JSON.stringify(proposed), taskBasis)!;
  assert.equal(v11.kind, 'VERIFICATION_PLAN_SUGGESTION');
  assert.equal((v11.payload as { effective_check_plan: boolean }).effective_check_plan,
    false);
  assert.equal(parseSkillOutput(verificationV11, JSON.stringify({ ...proposed,
    proposal: { checks: [] } }), taskBasis), null);
});

test('Task Definition v1.1 changes only Expected Result description and keeps other constraints', () => {
  const taskBasis: SkillBasis = { ...basis, facts: { ...basis.facts,
    acceptance: { objective: '原目标', required_output_spec: {
      artifacts: ['MARKDOWN_DOCUMENT'], description: '原说明',
      retention: { policy: 'original' } }, criteria: [{ criterion_id: 'human',
      statement: '人工验收', required: true, method: 'HUMAN', target_spec: {} }] } } };
  const candidate = { summary: '仅修订结果说明', proposal: { objective: '原目标',
    expected_outputs: { kind: 'MARKDOWN_DOCUMENT', description: '新版交付结果说明' },
    criteria: [{ statement: '人工验收', required: true, method: 'HUMAN' }] } };
  const parsed = parseSkillOutput(taskV11, JSON.stringify(candidate), taskBasis)!;
  const merged = buildTaskSkillProposal(taskV11, taskBasis, parsed,
    '11111111-1111-4111-8111-111111111111')!;
  assert.deepEqual(merged.required_output_spec, {
    artifacts: ['MARKDOWN_DOCUMENT'], description: '新版交付结果说明',
    retention: { policy: 'original' } });
  assert.deepEqual(merged.added_criterion_ids, []);
  assert.equal(parseSkillOutput(taskV11, JSON.stringify({ ...candidate,
    proposal: { ...candidate.proposal,
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' } } }), taskBasis), null);
  assert.equal(parseSkillOutput(task, JSON.stringify(candidate), taskBasis), null);
});
