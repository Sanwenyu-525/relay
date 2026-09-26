import { createHash } from 'node:crypto';

import type { ProjectType } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { isPhaseOfProjectType } from '../project/project-phase.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { FIRST_PARTY_REGISTRY } from '../skills/first-party-registry.js';
import { isViewKind, resolveViewTemplate, type ViewKind } from '../view/builtin-view.js';
import { validationFailed } from '../application/domain-error.js';
import { requireUuid } from '../application/revisions.js';

export interface BlueprintTaskDraft {
  readonly local_key: string;
  readonly title: string;
  readonly objective: string;
}

export type BlueprintNextAction =
  | { readonly kind: 'NEW_TASK'; readonly local_key: string }
  | { readonly kind: 'EXISTING_TASK'; readonly task_id: string }
  | { readonly kind: 'CLEAR' };

export interface BlueprintDraft {
  readonly intent: string;
  readonly goal_id: string | null;
  readonly phase_key: string | null;
  readonly tasks: readonly BlueprintTaskDraft[];
  readonly next_action: BlueprintNextAction | null;
  readonly view_kind: ViewKind;
  readonly pack_ref: { readonly id: string; readonly version: string } | null;
}

export function normalizeBlueprintDraft(raw: BlueprintDraft,
  projectType: ProjectType): BlueprintDraft {
  const text = (value: unknown, field: string, max: number): string => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
      throw validationFailed([{ field, message: `requires nonempty text up to ${max} characters` }]);
    }
    return value.trim();
  };
  const intent = text(raw.intent, 'intent', 2_000);
  if (raw.goal_id !== null) requireUuid(raw.goal_id, 'goal_id');
  if (raw.phase_key !== null && !isPhaseOfProjectType(projectType, raw.phase_key)) {
    throw validationFailed([{ field: 'phase_key',
      message: 'phase is not registered for the current Project Type' }]);
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length > 5) {
    throw validationFailed([{ field: 'tasks', message: 'at most five new tasks' }]);
  }
  const tasks = raw.tasks.map((task, index) => {
    if (typeof task !== 'object' || task === null ||
        Object.keys(task).some((key) => !['local_key', 'title', 'objective'].includes(key)) ||
        typeof task.local_key !== 'string' ||
        !/^[a-z][a-z0-9_-]{0,31}$/u.test(task.local_key)) {
      throw validationFailed([{ field: `tasks[${index}]`, message: 'invalid local task key' }]);
    }
    return { local_key: task.local_key,
      title: text(task.title, `tasks[${index}].title`, 200),
      objective: text(task.objective, `tasks[${index}].objective`, 2_000) };
  });
  if (new Set(tasks.map((task) => task.local_key)).size !== tasks.length) {
    throw validationFailed([{ field: 'tasks', message: 'duplicate local task key' }]);
  }
  let nextAction: BlueprintNextAction | null = null;
  if (raw.next_action !== null) {
    const action = raw.next_action;
    if (action.kind === 'NEW_TASK' &&
        Object.keys(action).every((key) => ['kind', 'local_key'].includes(key)) &&
        tasks.some((task) => task.local_key === action.local_key)) {
      nextAction = { kind: 'NEW_TASK', local_key: action.local_key };
    } else if (action.kind === 'EXISTING_TASK' &&
        Object.keys(action).every((key) => ['kind', 'task_id'].includes(key))) {
      nextAction = { kind: 'EXISTING_TASK',
        task_id: requireUuid(action.task_id, 'next_action.task_id') };
    } else if (action.kind === 'CLEAR' && Object.keys(action).length === 1) {
      nextAction = { kind: 'CLEAR' };
    } else {
      throw validationFailed([{ field: 'next_action',
        message: 'must name a new local task, an existing Task or CLEAR' }]);
    }
  }
  if (!isViewKind(raw.view_kind)) {
    throw validationFailed([{ field: 'view_kind', message: 'unknown built-in view kind' }]);
  }
  if (raw.pack_ref !== null &&
      (typeof raw.pack_ref !== 'object' ||
       Object.keys(raw.pack_ref).some((key) => !['id', 'version'].includes(key)))) {
    throw validationFailed([{ field: 'pack_ref', message: 'invalid Pack reference' }]);
  }
  return { intent, goal_id: raw.goal_id, phase_key: raw.phase_key,
    tasks, next_action: nextAction, view_kind: raw.view_kind,
    pack_ref: raw.pack_ref };
}

export function resolveBlueprintPack(ref: BlueprintDraft['pack_ref']): JsonObject | null {
  if (ref === null) return null;
  const pack = FIRST_PARTY_REGISTRY.pack(ref.id, ref.version);
  if (pack === undefined || pack.availability !== 'AVAILABLE') {
    throw validationFailed([{ field: 'pack_ref', message: 'Pack version is unavailable' }]);
  }
  return { id: pack.id, version: pack.version, sha256: pack.sha256,
    members: pack.members.map((member) => ({ kind: member.kind,
      id: member.id, version: member.version, sha256: member.sha256 })) };
}

export function buildBlueprintCandidate(draft: BlueprintDraft): JsonObject {
  return { schema_version: '1', intent: draft.intent, goal_id: draft.goal_id,
    phase_key: draft.phase_key,
    tasks: draft.tasks.map((task) => ({ ...task,
      mode: 'ME', status: 'INBOX', executor_kind: 'HUMAN',
      required_output_spec: {},
      criteria: [{ criterion_id: 'human', statement: '结果由人工核对。',
        required: true, method: 'HUMAN', target_spec: {} }] })),
    next_action: draft.next_action,
    view_configuration: resolveViewTemplate(draft.view_kind),
    follow_up_suggestions: [
      { kind: 'RULE', summary: '如需项目规则，请在 Rule 入口另行确认。' },
      { kind: 'WORKFLOW', summary: '执行流程与权限需分别确认，本次不会启动 Run。' },
    ] };
}

export function blueprintHash(candidate: JsonObject, baseline: JsonObject,
  source: JsonObject): string {
  return createHash('sha256').update(canonicalizeJson({ candidate, baseline, source }))
    .digest('hex');
}
