import { createHash } from 'node:crypto';

import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import type { FrozenSkill } from './first-party-registry.js';
import type { SkillBasis } from './skill-basis.js';
import { normalizeBlueprintDraft, type BlueprintDraft } from '../blueprint/blueprint-candidate.js';
import type { ProjectType } from '../infrastructure/database-schema.js';

const MAX_OUTPUT_BYTES = 16 * 1024;
const METHODS = new Set(['HUMAN', 'MARKDOWN_STRUCTURE', 'CITATION_EXISTS', 'SEMANTIC']);

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exact(value: Record<string, unknown>, required: readonly string[],
  optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) return null;
  return value.trim();
}

/** Strict first-party output contracts. Invalid model JSON produces no business effect. */
export function parseSkillOutput(skill: FrozenSkill, raw: string,
  basis: SkillBasis, skillInput: JsonObject | null = null): JsonObject | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_OUTPUT_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const value = object(parsed);
  if (value === null || !exact(value, ['summary', 'proposal'])) return null;
  const summary = bounded(value.summary, 1_000);
  const proposal = object(value.proposal);
  if (summary === null || proposal === null) return null;
  let payload: JsonObject;
  if (skill.id === 'task-to-execution-contract') {
    if (!exact(proposal, ['objective', 'expected_outputs', 'criteria'], ['suggested_mode'])) {
      return null;
    }
    const objective = bounded(proposal.objective, 2_000);
    const outputs = object(proposal.expected_outputs);
    if (objective === null || outputs === null ||
        !exact(outputs, skill.version === '1.1.0'
          ? ['kind', 'description'] : ['kind']) ||
        outputs.kind !== 'MARKDOWN_DOCUMENT' || !Array.isArray(proposal.criteria) ||
        proposal.criteria.length < 1 || proposal.criteria.length > 20 ||
        proposal.suggested_mode !== undefined && proposal.suggested_mode !== 'ME' &&
          proposal.suggested_mode !== 'DELEGATE') return null;
    const criteria: JsonObject[] = [];
    for (const rawCriterion of proposal.criteria) {
      const criterion = object(rawCriterion);
      if (criterion === null || !exact(criterion,
        ['statement', 'required', 'method'])) return null;
      const statement = bounded(criterion.statement, 500);
      if (statement === null || typeof criterion.required !== 'boolean' ||
          typeof criterion.method !== 'string' || !METHODS.has(criterion.method)) return null;
      criteria.push({ statement, required: criterion.required, method: criterion.method });
    }
    if (!criteria.some((criterion) => criterion.required === true)) return null;
    const description = skill.version === '1.1.0'
      ? bounded(outputs.description, 2_000) : null;
    if (skill.version === '1.1.0' && description === null) return null;
    payload = { objective, expected_outputs: { kind: 'MARKDOWN_DOCUMENT',
      ...(description === null ? {} : { description }) }, criteria,
      suggested_mode: proposal.suggested_mode ?? 'ME' };
  } else if (skill.id === 'verification-plan') {
    if (skill.version === '1.1.0') {
      if (!exact(proposal, ['additional_checks']) ||
          !Array.isArray(proposal.additional_checks) ||
          proposal.additional_checks.length < 1 ||
          proposal.additional_checks.length > 10) return null;
      const checks: JsonObject[] = [];
      for (const rawCheck of proposal.additional_checks) {
        const check = object(rawCheck);
        if (check === null || !exact(check, ['statement', 'required', 'method'])) return null;
        const statement = bounded(check.statement, 500);
        if (statement === null || typeof check.required !== 'boolean' ||
            typeof check.method !== 'string' || !METHODS.has(check.method)) return null;
        checks.push({ statement, required: check.required, method: check.method });
      }
      payload = { additional_checks: checks, effective_check_plan: false };
    } else {
    if (!exact(proposal, ['checks']) || !Array.isArray(proposal.checks) ||
        proposal.checks.length > 20) return null;
    const registered = Array.isArray(basis.facts.registered_checks)
      ? basis.facts.registered_checks.map(object).filter((item) => item !== null) : [];
    if (registered.length !== proposal.checks.length) return null;
    const byId = new Map(registered.map((entry) => [entry.criterion_id, entry]));
    const seen = new Set<string>();
    const checks: JsonObject[] = [];
    for (const rawCheck of proposal.checks) {
      const check = object(rawCheck);
      if (check === null || !exact(check, ['criterion_id', 'checker_id', 'required']) ||
          typeof check.criterion_id !== 'string' || seen.has(check.criterion_id)) return null;
      const registeredCheck = byId.get(check.criterion_id);
      if (registeredCheck === undefined || check.checker_id !== registeredCheck.checker_id ||
          check.required !== registeredCheck.required ||
          typeof check.checker_id !== 'string' ||
          typeof registeredCheck.checker_version !== 'string' ||
          typeof check.required !== 'boolean') return null;
      seen.add(check.criterion_id);
      checks.push({ criterion_id: check.criterion_id, checker_id: check.checker_id,
        checker_version: registeredCheck.checker_version, required: check.required });
    }
    payload = { checks, effective_check_plan: false };
    }
  } else if (skill.id === 'goal-to-project-blueprint') {
    if (!exact(proposal, ['intent', 'goal_id', 'phase_key', 'tasks',
      'next_action', 'view_kind']) || !Array.isArray(proposal.tasks) ||
        proposal.tasks.length < 1 || proposal.tasks.length > 5 ||
        proposal.tasks.some((entry) => {
          const task = object(entry);
          return task === null || !exact(task, ['local_key', 'title', 'objective']);
        })) return null;
    const next = object(proposal.next_action);
    if (next !== null && !(
      next.kind === 'NEW_TASK' && exact(next, ['kind', 'local_key']) ||
      next.kind === 'EXISTING_TASK' && exact(next, ['kind', 'task_id']) ||
      next.kind === 'CLEAR' && exact(next, ['kind']))) return null;
    const project = object(basis.facts.project);
    if (project === null || typeof project.project_type !== 'string') return null;
    const availableGoals = Array.isArray(basis.facts.available_goals)
      ? basis.facts.available_goals.map(object).filter((item) => item !== null) : [];
    if (proposal.goal_id !== null &&
        !availableGoals.some((goal) => goal.id === proposal.goal_id &&
          goal.status === 'ACTIVE')) return null;
    if (skillInput?.goal_id !== null && skillInput?.goal_id !== undefined &&
        skillInput.goal_id !== proposal.goal_id) return null;
    const tasks = Array.isArray(basis.facts.tasks) ? basis.facts.tasks : [];
    if (next?.kind === 'EXISTING_TASK' &&
        !tasks.some((entry) => object(entry)?.id === next.task_id)) return null;
    try {
      const draft = normalizeBlueprintDraft({ ...proposal,
        pack_ref: (skillInput?.pack_ref ?? null) as BlueprintDraft['pack_ref'],
      } as unknown as BlueprintDraft, project.project_type as ProjectType);
      payload = { summary, draft: draft as unknown as JsonObject,
        effective_blueprint: false };
    } catch { return null; }
  } else {
    if (!exact(proposal, ['highlights', 'next_steps']) ||
        !Array.isArray(proposal.highlights) || proposal.highlights.length > 8 ||
        !Array.isArray(proposal.next_steps) || proposal.next_steps.length > 5) return null;
    const facts = basis.facts;
    const known = new Set<string>();
    const project = object(facts.project);
    if (typeof project?.id === 'string') known.add(`PROJECT:${project.id}`);
    for (const [key, kind] of [['tasks', 'TASK'], ['active_decisions', 'DECISION'],
      ['current_verifications', 'VERIFICATION'], ['open_reviews', 'REVIEW']] as const) {
      const values = Array.isArray(facts[key]) ? facts[key] : [];
      for (const entry of values) {
        const record = object(entry);
        if (typeof record?.id === 'string') known.add(`${kind}:${record.id}`);
      }
    }
    const highlights: JsonObject[] = [];
    for (const rawHighlight of proposal.highlights) {
      const highlight = object(rawHighlight);
      if (highlight === null || !exact(highlight, ['statement', 'ref_kind', 'ref_id'])) return null;
      const statement = bounded(highlight.statement, 500);
      if (statement === null || typeof highlight.ref_kind !== 'string' ||
          typeof highlight.ref_id !== 'string' ||
          !known.has(`${highlight.ref_kind}:${highlight.ref_id}`)) return null;
      highlights.push({ statement, ref_kind: highlight.ref_kind, ref_id: highlight.ref_id });
    }
    const nextSteps = proposal.next_steps.map((item) => bounded(item, 500));
    if (nextSteps.some((item) => item === null)) return null;
    payload = { summary, highlights, next_steps: nextSteps as string[],
      comparison_baseline: null, read_only: true };
  }
  if (skill.id !== 'project-resume') payload = { summary, ...payload };
  const targetId = skill.definition.target === 'TASK' ? basis.baseline.task_id :
    basis.baseline.project_id;
  if (typeof targetId !== 'string') return null;
  const payloadSha256 = createHash('sha256').update(canonicalizeJson(payload)).digest('hex');
  return { kind: skill.definition.output_kind, status: skill.id === 'project-resume'
    ? 'READ_ONLY' : 'SUGGESTED', target_kind: skill.definition.target,
  target_id: targetId, as_of: basis.asOf, baseline: basis.baseline,
  basis_sha256: basis.factsSha256, payload_sha256: payloadSha256, payload };
}
