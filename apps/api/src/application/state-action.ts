import type { JsonObject } from '../infrastructure/json.js';
import type { FieldError } from '../shared/field-error.js';
import { checkRequiredText, normalizeText, type TextLimit } from '../shared/text.js';
import { requiredInputMissing, validationFailed } from './domain-error.js';
import { requireUuid } from './revisions.js';

/**
 * Project State 的类型化 action（docs/api/http-command-contract.md 第 5 节）。
 *
 * 客户端不能任意替换 ProjectState JSON：每个 action 有固定的参数结构与允许字段集合，
 * 这里在做任何数据库读写之前完成结构校验与规范化，并产出用于命令摘要的规范 body。
 * 只登记契约已定义、且 V001 事实支持写入的动作；未定义动作不建占位分支。
 */

export const STATE_ACTIONS = [
  'SET_PHASE',
  'SET_NEXT_ACTION',
  'SELECT_ARTIFACT_VERSION',
  'ADD_CONFIRMED_RISK',
  'RESOLVE_BLOCKER',
] as const;

export type StateAction = (typeof STATE_ACTIONS)[number];

const ALLOWED_PARAMS: Readonly<Record<StateAction, readonly string[]>> = {
  SET_PHASE: ['phase_key'],
  SET_NEXT_ACTION: ['next_action_task_id'],
  SELECT_ARTIFACT_VERSION: ['artifact_version_id', 'source_ref'],
  ADD_CONFIRMED_RISK: ['statement', 'source_ref', 'confirmation_ref'],
  RESOLVE_BLOCKER: ['blocker_id'],
};

export type NormalizedStateAction =
  | { readonly action: 'SET_PHASE'; readonly body: JsonObject; readonly phaseKey: string }
  | {
      readonly action: 'SET_NEXT_ACTION';
      readonly body: JsonObject;
      readonly nextActionTaskId: string | null;
    }
  | {
      readonly action: 'SELECT_ARTIFACT_VERSION';
      readonly body: JsonObject;
      readonly artifactVersionId: string;
      readonly sourceRef: string;
    }
  | {
      readonly action: 'ADD_CONFIRMED_RISK';
      readonly body: JsonObject;
      readonly statement: string;
      readonly sourceRef: string;
      readonly confirmationRef: string;
    }
  | { readonly action: 'RESOLVE_BLOCKER'; readonly body: JsonObject; readonly blockerId: string };

export function isStateAction(value: string): value is StateAction {
  return (STATE_ACTIONS as readonly string[]).includes(value);
}

export function normalizeStateAction(
  action: string,
  params: Readonly<Record<string, unknown>>,
): NormalizedStateAction {
  if (!isStateAction(action)) {
    throw validationFailed([
      { field: 'action', message: `must be one of ${STATE_ACTIONS.join(', ')}` },
    ]);
  }

  requireOnlyAllowedParams(action, params);

  switch (action) {
    case 'SET_PHASE': {
      const phaseKey = requireTextParam(params, 'phase_key', 'phaseKey');

      return { action, phaseKey, body: { action, phase_key: phaseKey } };
    }
    case 'SET_NEXT_ACTION': {
      const nextActionTaskId = requireNullableUuidParam(params, 'next_action_task_id');

      return {
        action,
        nextActionTaskId,
        body: { action, next_action_task_id: nextActionTaskId },
      };
    }
    case 'SELECT_ARTIFACT_VERSION': {
      const artifactVersionId = requireUuidParam(params, 'artifact_version_id');
      const sourceRef = requireTextParam(params, 'source_ref', 'sourceRef');

      return {
        action,
        artifactVersionId,
        sourceRef,
        body: { action, artifact_version_id: artifactVersionId, source_ref: sourceRef },
      };
    }
    case 'ADD_CONFIRMED_RISK': {
      const statement = requireTextParam(params, 'statement', 'riskStatement');
      const sourceRef = requireTextParam(params, 'source_ref', 'sourceRef');
      const confirmationRef = requireTextParam(params, 'confirmation_ref', 'confirmationRef');

      return {
        action,
        statement,
        sourceRef,
        confirmationRef,
        body: {
          action,
          statement,
          source_ref: sourceRef,
          confirmation_ref: confirmationRef,
        },
      };
    }
    case 'RESOLVE_BLOCKER': {
      const blockerId = requireUuidParam(params, 'blocker_id');

      return { action, blockerId, body: { action, blocker_id: blockerId } };
    }
  }
}

function requireOnlyAllowedParams(
  action: StateAction,
  params: Readonly<Record<string, unknown>>,
): void {
  const allowed = new Set(ALLOWED_PARAMS[action]);
  const rejected: FieldError[] = [];

  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      rejected.push({ field: key, message: `is not a parameter of action ${action}` });
    }
  }

  if (rejected.length > 0) {
    throw validationFailed(rejected);
  }
}

function requireTextParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
  limit: TextLimit,
): string {
  const value = params[key];

  if (typeof value !== 'string') {
    throw requiredInputMissing([{ field: key, message: 'is required and must be a string' }]);
  }

  const problem = checkRequiredText(value, key, limit);

  if (problem !== undefined) {
    throw validationFailed([problem]);
  }

  return normalizeText(value);
}

function requireUuidParam(params: Readonly<Record<string, unknown>>, key: string): string {
  const value = params[key];

  if (typeof value !== 'string') {
    throw requiredInputMissing([{ field: key, message: 'is required and must be a UUID string' }]);
  }

  return requireUuid(value, key);
}

function requireNullableUuidParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = params[key];

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw requiredInputMissing([
      { field: key, message: 'is required and must be a UUID string or null' },
    ]);
  }

  return requireUuid(value, key);
}