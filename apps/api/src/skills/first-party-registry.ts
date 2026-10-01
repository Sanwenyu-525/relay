import { createHash } from 'node:crypto';

import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';

export type FirstPartySkillId = 'task-to-execution-contract' | 'project-resume' |
  'verification-plan' | 'goal-to-project-blueprint';
export type SkillOutputKind = 'TASK_DEFINITION_SUGGESTION' | 'PROJECT_RESUME' |
  'VERIFICATION_PLAN_SUGGESTION' | 'PROJECT_BLUEPRINT_SUGGESTION';
export type SkillAvailability = 'CALLABLE_SUGGESTION_ONLY' | 'CALLABLE_READ_ONLY';

export interface RegistryDependency {
  readonly kind: 'CONTEXT_PROFILE' | 'INPUT_CONTRACT' | 'OUTPUT_CONTRACT';
  readonly id: string;
  readonly version: string;
  readonly definition: JsonObject;
}

export interface SkillDefinition {
  readonly id: FirstPartySkillId;
  readonly version: string;
  readonly title: string;
  readonly target: 'TASK' | 'PROJECT';
  readonly output_kind: SkillOutputKind;
  readonly availability: SkillAvailability;
  readonly required_capabilities: readonly [];
  readonly instructions: string;
  readonly dependency_refs: readonly { readonly kind: RegistryDependency['kind'];
    readonly id: string; readonly version: string }[];
}

export interface PackDefinition {
  readonly id: 'thesis-minimal' | 'development-minimal';
  readonly version: string;
  readonly title: string;
  readonly host_contract: 'relay-v1';
  readonly members: readonly { readonly kind: 'SKILL'; readonly id: FirstPartySkillId;
    readonly version: string }[];
}

export interface FrozenDependency {
  readonly kind: RegistryDependency['kind'];
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly definition: JsonObject;
}

export interface FrozenSkill {
  readonly id: FirstPartySkillId;
  readonly version: string;
  readonly sha256: string;
  readonly definition: SkillDefinition;
  readonly dependencies: readonly FrozenDependency[];
}

export interface FrozenPack {
  readonly id: PackDefinition['id'];
  readonly version: string;
  readonly sha256: string;
  readonly title: string;
  readonly host_contract: 'relay-v1';
  readonly availability: 'AVAILABLE' | 'HISTORICAL_ONLY';
  readonly members: readonly { readonly kind: 'SKILL'; readonly id: FirstPartySkillId;
    readonly version: string; readonly sha256: string;
    readonly availability: SkillAvailability; readonly accept_supported: boolean }[];
}

export interface FrozenSkillIdentity {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly target: 'TASK' | 'PROJECT';
  readonly output_kind: SkillOutputKind;
  readonly availability: SkillAvailability;
  readonly required_capabilities: readonly string[];
  readonly missing_capabilities: readonly string[];
  readonly dependencies: readonly { readonly kind: RegistryDependency['kind'];
    readonly id: string; readonly version: string; readonly sha256: string }[];
}

const CONTEXT = { kind: 'CONTEXT_PROFILE', id: 'assist-explicit-sources', version: '1.0.0',
  definition: { history_limit: 20, max_sources: 10, source_max_chars: 16_000,
    skill_input_max_bytes: 65_536, facts_max_bytes: 24_576,
    external_sources_are_untrusted_data: true, mandatory_boundary: true } } as const;
const TASK_INPUT = { kind: 'INPUT_CONTRACT', id: 'task-definition-input', version: '1.0.0',
  definition: { optional_fields: ['desired_result'], max_text_chars: 2_000,
    additional_fields: false } } as const;
const RESUME_INPUT = { kind: 'INPUT_CONTRACT', id: 'project-resume-input', version: '1.0.0',
  definition: { optional_fields: ['focus'], max_text_chars: 2_000,
    comparison_baseline: false, additional_fields: false } } as const;
const PLAN_INPUT = { kind: 'INPUT_CONTRACT', id: 'verification-plan-input', version: '1.0.0',
  definition: { optional_fields: ['risk_focus'], max_text_chars: 2_000,
    additional_fields: false } } as const;
const TASK_OUTPUT = { kind: 'OUTPUT_CONTRACT', id: 'task-definition-suggestion', version: '1.0.0',
  definition: { output_kind: 'TASK_DEFINITION_SUGGESTION', max_bytes: 16_384,
    max_criteria: 20, business_write: false } } as const;
const TASK_OUTPUT_V11 = { kind: 'OUTPUT_CONTRACT', id: 'task-definition-suggestion',
  version: '1.1.0', definition: { output_kind: 'TASK_DEFINITION_SUGGESTION',
    max_bytes: 16_384, max_criteria: 20, expected_result_description_max_chars: 2_000,
    existing_output_requirements_preserved: true, business_write: false } } as const;
const RESUME_OUTPUT = { kind: 'OUTPUT_CONTRACT', id: 'project-resume', version: '1.0.0',
  definition: { output_kind: 'PROJECT_RESUME', max_bytes: 16_384,
    comparison_baseline: false, business_write: false } } as const;
const PLAN_OUTPUT = { kind: 'OUTPUT_CONTRACT', id: 'verification-plan-suggestion', version: '1.0.0',
  definition: { output_kind: 'VERIFICATION_PLAN_SUGGESTION', max_bytes: 16_384,
    max_checks: 20, registered_checkers_only: true, business_write: false } } as const;
const PLAN_OUTPUT_V11 = { kind: 'OUTPUT_CONTRACT', id: 'verification-plan-suggestion',
  version: '1.1.0', definition: { output_kind: 'VERIFICATION_PLAN_SUGGESTION',
    max_bytes: 16_384, max_additional_checks: 10, existing_criteria_preserved: true,
    registered_checkers_only: true, business_write: false } } as const;
const BLUEPRINT_INPUT = { kind: 'INPUT_CONTRACT', id: 'project-blueprint-input',
  version: '1.0.0', definition: { optional_fields: ['desired_outcome', 'goal_id',
    'pack_ref'], max_text_chars: 2_000, additional_fields: false } } as const;
const BLUEPRINT_OUTPUT = { kind: 'OUTPUT_CONTRACT', id: 'project-blueprint-suggestion',
  version: '1.0.0', definition: { output_kind: 'PROJECT_BLUEPRINT_SUGGESTION',
    max_bytes: 16_384, max_new_tasks: 5, fixed_view_templates_only: true,
    business_write: false } } as const;

const DEPENDENCIES: readonly RegistryDependency[] = [CONTEXT, TASK_INPUT, RESUME_INPUT,
  PLAN_INPUT, TASK_OUTPUT, TASK_OUTPUT_V11, RESUME_OUTPUT, PLAN_OUTPUT,
  PLAN_OUTPUT_V11, BLUEPRINT_INPUT, BLUEPRINT_OUTPUT];
const ref = (entry: RegistryDependency) => ({ kind: entry.kind, id: entry.id,
  version: entry.version });
const DEFINITIONS: readonly SkillDefinition[] = [
  { id: 'task-to-execution-contract', version: '1.0.0', title: '完善任务定义',
    target: 'TASK', output_kind: 'TASK_DEFINITION_SUGGESTION',
    availability: 'CALLABLE_SUGGESTION_ONLY',
    required_capabilities: [],
    instructions: '依据当前 Task 及其验收版本，建议目标、期望结果和可核对条件。不得直接改变任务、执行权或规则。只输出约定的 JSON。',
    dependency_refs: [ref(CONTEXT), ref(TASK_INPUT), ref(TASK_OUTPUT)] },
  { id: 'task-to-execution-contract', version: '1.1.0', title: '完善任务定义与期望结果',
    target: 'TASK', output_kind: 'TASK_DEFINITION_SUGGESTION',
    availability: 'CALLABLE_SUGGESTION_ONLY', required_capabilities: [],
    instructions: '依据当前 Task 与验收版本建议目标、期望结果说明和可核对条件。不得删除已有产物要求或验收条件，不得直接改变任务、执行权或规则。只输出约定的 JSON。',
    dependency_refs: [ref(CONTEXT), ref(TASK_INPUT), ref(TASK_OUTPUT_V11)] },
  { id: 'project-resume', version: '1.0.0', title: '继续这个项目',
    target: 'PROJECT', output_kind: 'PROJECT_RESUME',
    availability: 'CALLABLE_READ_ONLY',
    required_capabilities: [],
    instructions: '仅根据本次给出的当前权威事实和版本引用概述现状、风险与下一步；没有比较基线，不描述自上次以来的变化。不得把验证当业务完成，不得改变项目事实。只输出约定的 JSON。',
    dependency_refs: [ref(CONTEXT), ref(RESUME_INPUT), ref(RESUME_OUTPUT)] },
  { id: 'verification-plan', version: '1.0.0', title: '生成验收方案',
    target: 'TASK', output_kind: 'VERIFICATION_PLAN_SUGGESTION',
    availability: 'CALLABLE_SUGGESTION_ONLY',
    required_capabilities: [],
    instructions: '对当前 Task 验收条件建议检查；不得删除必需条件，检查器只能引用给出的注册映射。建议不是有效 CheckPlan 或 PASS。只输出约定的 JSON。',
    dependency_refs: [ref(CONTEXT), ref(PLAN_INPUT), ref(PLAN_OUTPUT)] },
  { id: 'verification-plan', version: '1.1.0', title: '补充验收检查',
    target: 'TASK', output_kind: 'VERIFICATION_PLAN_SUGGESTION',
    availability: 'CALLABLE_SUGGESTION_ONLY', required_capabilities: [],
    instructions: '基于当前 Task 验收条件提出新增的可核对检查；不得删除或改写既有条件。只输出 additional_checks 数组，method 必须是内置检查方式。建议不是有效 CheckPlan 或 PASS。只输出约定的 JSON。',
    dependency_refs: [ref(CONTEXT), ref(PLAN_INPUT), ref(PLAN_OUTPUT_V11)] },
  { id: 'goal-to-project-blueprint', version: '1.0.0', title: '从目标生成项目蓝图候选',
    target: 'PROJECT', output_kind: 'PROJECT_BLUEPRINT_SUGGESTION',
    availability: 'CALLABLE_SUGGESTION_ONLY', required_capabilities: [],
    instructions: '依据当前 Project、State、Goal、Task 和 View 事实，生成最多五个 HUMAN INBOX Task 的项目蓝图建议。仅可引用输入中 ACTIVE 的同 Workspace Goal、已有 Project Task 与内置 View kind。建议不建立 Goal、不修改 Rule、Workflow 或 Permission；应用仍需人工确认候选摘要和基线。只输出约定的 JSON。',
    dependency_refs: [ref(CONTEXT), ref(BLUEPRINT_INPUT), ref(BLUEPRINT_OUTPUT)] },
];
const PACKS: readonly PackDefinition[] = [
  { id: 'thesis-minimal', version: '1.0.0', title: '论文工作最小组合',
    host_contract: 'relay-v1', members: [DEFINITIONS[0]!, DEFINITIONS[2]!, DEFINITIONS[3]!].map((entry) => ({
      kind: 'SKILL', id: entry.id, version: entry.version })) },
  { id: 'development-minimal', version: '1.0.0', title: '开发工作最小组合',
    host_contract: 'relay-v1', members: [DEFINITIONS[0]!, DEFINITIONS[2]!, DEFINITIONS[3]!].map((entry) => ({
      kind: 'SKILL', id: entry.id, version: entry.version })) },
  { id: 'thesis-minimal', version: '1.1.0', title: '论文工作最小组合',
    host_contract: 'relay-v1', members: [DEFINITIONS[0]!, DEFINITIONS[2]!, DEFINITIONS[4]!]
      .map((entry) => ({ kind: 'SKILL', id: entry.id, version: entry.version })) },
  { id: 'development-minimal', version: '1.1.0', title: '开发工作最小组合',
    host_contract: 'relay-v1', members: [DEFINITIONS[0]!, DEFINITIONS[2]!, DEFINITIONS[4]!]
      .map((entry) => ({ kind: 'SKILL', id: entry.id, version: entry.version })) },
  { id: 'thesis-minimal', version: '1.2.0', title: '论文工作最小组合',
    host_contract: 'relay-v1', members: [DEFINITIONS[1]!, DEFINITIONS[2]!, DEFINITIONS[4]!]
      .map((entry) => ({ kind: 'SKILL', id: entry.id, version: entry.version })) },
  { id: 'development-minimal', version: '1.2.0', title: '开发工作最小组合',
    host_contract: 'relay-v1', members: [DEFINITIONS[1]!, DEFINITIONS[2]!, DEFINITIONS[4]!]
      .map((entry) => ({ kind: 'SKILL', id: entry.id, version: entry.version })) },
  { id: 'thesis-minimal', version: '1.3.0', title: '论文工作最小组合',
    host_contract: 'relay-v1', members: [DEFINITIONS[1]!, DEFINITIONS[2]!,
      DEFINITIONS[4]!, DEFINITIONS[5]!]
      .map((entry) => ({ kind: 'SKILL', id: entry.id, version: entry.version })) },
  { id: 'development-minimal', version: '1.3.0', title: '开发工作最小组合',
    host_contract: 'relay-v1', members: [DEFINITIONS[1]!, DEFINITIONS[2]!,
      DEFINITIONS[4]!, DEFINITIONS[5]!]
      .map((entry) => ({ kind: 'SKILL', id: entry.id, version: entry.version })) },
];

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value as JsonObject), 'utf8').digest('hex');
}

/** Finite, bundled definitions. No paths, remote schemas, code loading or resolution at runtime. */
export function createFirstPartyRegistry(dependencies = DEPENDENCIES,
  definitions = DEFINITIONS, packs = PACKS) {
  if (dependencies.length > 32 || definitions.length > 16 || packs.length > 8) {
    throw new Error('first-party registry exceeds its fixed size budget');
  }
  const dependencyMap = new Map<string, FrozenDependency>();
  for (const entry of dependencies) {
    const key = `${entry.kind}:${entry.id}@${entry.version}`;
    const frozen = { ...entry, sha256: hash(entry.definition) };
    const previous = dependencyMap.get(key);
    if (previous !== undefined && previous.sha256 !== frozen.sha256) {
      throw new Error(`conflicting first-party dependency: ${key}`);
    }
    dependencyMap.set(key, frozen);
  }
  const skillMap = new Map<string, FrozenSkill>();
  for (const definition of definitions) {
    const key = `${definition.id}@${definition.version}`;
    const resolved = definition.dependency_refs.map((entry) => {
      const dep = dependencyMap.get(`${entry.kind}:${entry.id}@${entry.version}`);
      if (dep === undefined) throw new Error(`unknown first-party dependency: ${entry.id}`);
      return dep;
    });
    if (new Set(resolved.map((entry) => `${entry.kind}:${entry.id}`)).size !== resolved.length) {
      throw new Error(`conflicting first-party dependencies: ${key}`);
    }
    const frozen = { id: definition.id, version: definition.version, definition,
      dependencies: resolved, sha256: hash({ definition, dependencies: resolved.map((entry) => ({
        kind: entry.kind, id: entry.id, version: entry.version, sha256: entry.sha256 })) }) };
    const previous = skillMap.get(key);
    if (previous !== undefined && previous.sha256 !== frozen.sha256) {
      throw new Error(`conflicting first-party Skill definition: ${key}`);
    }
    skillMap.set(key, frozen);
  }
  const packMap = new Map<string, FrozenPack>();
  for (const definition of packs) {
    if (definition.host_contract !== 'relay-v1' || definition.members.length > 8) {
      throw new Error(`incompatible first-party Pack: ${definition.id}`);
    }
    const members = definition.members.map((member) => {
      const skill = skillMap.get(`${member.id}@${member.version}`);
      if (member.kind !== 'SKILL' || skill === undefined) {
        throw new Error(`unknown first-party Pack member: ${member.id}`);
      }
      return { kind: 'SKILL' as const, id: skill.id, version: skill.version,
        sha256: skill.sha256, availability: skill.definition.availability,
        target: skill.definition.target, required_capabilities: [],
        missing_capabilities: [], accept_supported: definition.version !== '1.0.0' &&
          (skill.definition.target === 'TASK' ||
           skill.id === 'goal-to-project-blueprint') };
    });
    if (new Set(members.map((entry) => entry.id)).size !== members.length) {
      throw new Error(`conflicting first-party Pack members: ${definition.id}`);
    }
    const frozen = { id: definition.id, version: definition.version, title: definition.title,
      host_contract: definition.host_contract,
      availability: definition.version === '1.0.0' || definition.version === '1.1.0'
        ? 'HISTORICAL_ONLY' as const : 'AVAILABLE' as const, members,
      sha256: hash({ definition, members }) };
    const key = `${frozen.id}@${frozen.version}`;
    const previous = packMap.get(key);
    if (previous !== undefined && previous.sha256 !== frozen.sha256) {
      throw new Error(`conflicting first-party Pack definition: ${key}`);
    }
    packMap.set(key, frozen);
  }
  return { skills: [...skillMap.values()], packs: [...packMap.values()],
    skill: (id: string, version: string): FrozenSkill | undefined =>
      skillMap.get(`${id}@${version}`),
    pack: (id: string, version: string): FrozenPack | undefined =>
      packMap.get(`${id}@${version}`) };
}

export const FIRST_PARTY_REGISTRY = createFirstPartyRegistry();

export interface FirstPartyRegistryArchive {
  readonly skills: readonly FrozenSkill[];
  readonly packs: readonly { readonly definition: PackDefinition;
    readonly sha256: string; readonly members: readonly FrozenSkill[] }[];
}

/** Export this package's complete definitions, including retired versions, without mutable aliases. */
export function exportFirstPartyRegistryArchive(): FirstPartyRegistryArchive {
  return structuredClone({ skills: FIRST_PARTY_REGISTRY.skills,
    packs: PACKS.map((definition) => ({ definition,
      sha256: FIRST_PARTY_REGISTRY.pack(definition.id, definition.version)!.sha256,
      members: definition.members.map((member) =>
        FIRST_PARTY_REGISTRY.skill(member.id, member.version)!) })) });
}

/** A frozen v1.0 verification output remains readable but has no new-call/apply contract. */
export function isCallableSkill(skill: FrozenSkill): boolean {
  return !(skill.id === 'verification-plan' && skill.version === '1.0.0');
}

export function normalizeSkillInput(skill: FrozenSkill,
  input: unknown): JsonObject | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (skill.id === 'goal-to-project-blueprint') {
    if (Object.keys(value).some((key) => !['desired_outcome', 'goal_id',
      'pack_ref'].includes(key))) return null;
    if (value.desired_outcome !== undefined &&
        (typeof value.desired_outcome !== 'string' ||
         value.desired_outcome.trim() === '' || value.desired_outcome.length > 2_000)) return null;
    if (value.goal_id !== undefined && value.goal_id !== null &&
        (typeof value.goal_id !== 'string' ||
         !/^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/u
           .test(value.goal_id))) return null;
    const pack = object(value.pack_ref);
    if (value.pack_ref !== undefined && value.pack_ref !== null &&
        (pack === null || Object.keys(pack).some((key) => !['id', 'version'].includes(key)) ||
         typeof pack.id !== 'string' || typeof pack.version !== 'string' ||
         FIRST_PARTY_REGISTRY.pack(pack.id, pack.version)?.availability !==
           'AVAILABLE')) return null;
    return { ...(value.desired_outcome === undefined ? {} : {
      desired_outcome: (value.desired_outcome as string).trim() }),
    goal_id: value.goal_id ?? null,
    pack_ref: pack === null ? null : { id: pack.id as string,
      version: pack.version as string } };
  }
  const field = skill.id === 'task-to-execution-contract' ? 'desired_result'
    : skill.id === 'project-resume' ? 'focus' : 'risk_focus';
  if (Object.keys(value).some((key) => key !== field)) return null;
  if (value[field] === undefined) return {};
  if (typeof value[field] !== 'string' || value[field].trim() === '' ||
      value[field].length > 2_000) return null;
  return { [field]: value[field].trim() };
}

export function frozenSkillSnapshot(skill: FrozenSkill): JsonObject {
  return JSON.parse(JSON.stringify(skill)) as JsonObject;
}

function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject : null;
}

/** A stored definition can remain readable after its bundled version is retired. */
export function inspectFrozenSkillSnapshot(snapshot: JsonObject): FrozenSkillIdentity | null {
  const definition = object(snapshot.definition);
  if (typeof snapshot.id !== 'string' || !/^[a-z0-9-]{1,100}$/u.test(snapshot.id) ||
      typeof snapshot.version !== 'string' ||
      !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(snapshot.version) ||
      typeof snapshot.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(snapshot.sha256) ||
      definition === null || definition.id !== snapshot.id ||
      definition.version !== snapshot.version ||
      (definition.target !== 'TASK' && definition.target !== 'PROJECT') ||
      (definition.output_kind !== 'TASK_DEFINITION_SUGGESTION' &&
       definition.output_kind !== 'PROJECT_RESUME' &&
       definition.output_kind !== 'VERIFICATION_PLAN_SUGGESTION' &&
       definition.output_kind !== 'PROJECT_BLUEPRINT_SUGGESTION') ||
      (definition.availability !== 'CALLABLE_SUGGESTION_ONLY' &&
       definition.availability !== 'CALLABLE_READ_ONLY') ||
      !Array.isArray(definition.required_capabilities) ||
      !definition.required_capabilities.every((capability) => typeof capability === 'string') ||
      !Array.isArray(snapshot.dependencies) || snapshot.dependencies.length > 32 ||
      Object.keys(snapshot).some((key) => !['id', 'version', 'sha256',
        'definition', 'dependencies'].includes(key))) return null;
  try {
    const dependencies: FrozenSkillIdentity['dependencies'][number][] = [];
    for (const entry of snapshot.dependencies) {
      const value = object(entry);
      if (value === null || (value.kind !== 'CONTEXT_PROFILE' &&
          value.kind !== 'INPUT_CONTRACT' && value.kind !== 'OUTPUT_CONTRACT') ||
          typeof value.id !== 'string' || typeof value.version !== 'string' ||
          typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256) ||
          object(value.definition) === null ||
          hash(value.definition) !== value.sha256 ||
          Object.keys(value).some((key) => !['kind', 'id', 'version',
            'sha256', 'definition'].includes(key))) return null;
      dependencies.push({ kind: value.kind as RegistryDependency['kind'], id: value.id,
        version: value.version, sha256: value.sha256 });
    }
    if (hash({ definition, dependencies }) !== snapshot.sha256) return null;
    return { id: snapshot.id, version: snapshot.version,
      sha256: snapshot.sha256, target: definition.target,
      output_kind: definition.output_kind, availability: definition.availability,
      required_capabilities: definition.required_capabilities,
      missing_capabilities: [], dependencies };
  } catch { return null; }
}

export function availableFrozenSkill(snapshot: JsonObject): FrozenSkill | null {
  const inspected = inspectFrozenSkillSnapshot(snapshot);
  if (inspected === null) return null;
  const current = FIRST_PARTY_REGISTRY.skill(inspected.id, inspected.version);
  return current?.sha256 === inspected.sha256 ? current : null;
}

export function frozenSkillIdentity(skill: FrozenSkill) {
  return { id: skill.id, version: skill.version, sha256: skill.sha256,
    target: skill.definition.target, output_kind: skill.definition.output_kind,
    availability: skill.definition.availability,
    required_capabilities: skill.definition.required_capabilities,
    missing_capabilities: [],
    dependencies: skill.dependencies.map((dependency) => ({ kind: dependency.kind,
      id: dependency.id, version: dependency.version, sha256: dependency.sha256 })) };
}
