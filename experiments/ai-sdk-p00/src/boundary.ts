import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { jsonSchema, type ToolSet } from 'ai';

export const writeArtifactInputSchema = Type.Object(
  {
    target: Type.String({ minLength: 1, maxLength: 240 }),
    content: Type.String({ minLength: 1, maxLength: 16_384 }),
  },
  { additionalProperties: false },
);

export type WriteArtifactInput = Static<typeof writeArtifactInputSchema>;

function validateWriteArtifactInput(value: unknown) {
  if (Value.Check(writeArtifactInputSchema, value)) {
    return { success: true as const, value };
  }

  const problem = [...Value.Errors(writeArtifactInputSchema, value)]
    .map(issue => `${issue.path || '/'}: ${issue.message}`)
    .join('; ');

  return {
    success: false as const,
    error: new Error(`write_artifact 参数不合法：${problem}`),
  };
}

/**
 * 此工具刻意不注册 execute。AI SDK 只解析和校验候选；Relay 必须先持久化、审批并经 Gateway 准入。
 */
export const relayBoundaryTools = {
  write_artifact: {
    description: 'Propose immutable managed artifact content for Relay review.',
    inputSchema: jsonSchema<WriteArtifactInput>(writeArtifactInputSchema, {
      validate: validateWriteArtifactInput,
    }),
  },
} as const satisfies ToolSet;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PersistedCandidate = {
  candidateVersion: 1;
  model: {
    provider: string;
    modelId: string;
  };
  response: {
    id: string | null;
    modelId: string | null;
    timestamp: string | null;
  };
  responseMessages: JsonValue;
  toolCall: {
    id: string;
    name: 'write_artifact';
    input: WriteArtifactInput;
  };
};

export type BoundaryOutcome =
  | { kind: 'candidate'; candidate: PersistedCandidate }
  | {
      kind: 'rejected';
      reason:
        | 'invalid_tool_input'
        | 'incomplete_tool_input'
        | 'unexpected_tool'
        | 'multiple_tool_calls';
    }
  | { kind: 'model_failure'; reason: 'cancelled' | 'stream_error'; message: string };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function asJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('模型响应不可序列化为 JSON。');
  }
  return JSON.parse(serialized) as JsonValue;
}

function asNullableString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

export function toCandidateOrRejection({
  toolCalls,
  responseMessages,
  response,
  provider,
  modelId,
}: {
  toolCalls: readonly unknown[];
  responseMessages: unknown;
  response: unknown;
  provider: string;
  modelId: string;
}): Extract<BoundaryOutcome, { kind: 'candidate' | 'rejected' }> {
  if (toolCalls.length === 0) {
    return { kind: 'rejected', reason: 'incomplete_tool_input' };
  }

  if (toolCalls.length !== 1) {
    return { kind: 'rejected', reason: 'multiple_tool_calls' };
  }

  const toolCall = toolCalls[0];
  if (!isRecord(toolCall) || toolCall.toolName !== 'write_artifact') {
    return { kind: 'rejected', reason: 'unexpected_tool' };
  }

  if (toolCall.invalid === true || !Value.Check(writeArtifactInputSchema, toolCall.input)) {
    return { kind: 'rejected', reason: 'invalid_tool_input' };
  }

  if (typeof toolCall.toolCallId !== 'string') {
    return { kind: 'rejected', reason: 'invalid_tool_input' };
  }

  const responseRecord = isRecord(response) ? response : {};
  return {
    kind: 'candidate',
    candidate: {
      candidateVersion: 1,
      model: { provider, modelId },
      response: {
        id: asNullableString(responseRecord.id),
        modelId: asNullableString(responseRecord.modelId),
        timestamp: asNullableString(responseRecord.timestamp),
      },
      responseMessages: asJsonValue(responseMessages),
      toolCall: {
        id: toolCall.toolCallId,
        name: 'write_artifact',
        input: toolCall.input,
      },
    },
  };
}

export function modelFailure(
  error: unknown,
  wasCancelled: boolean,
): Extract<BoundaryOutcome, { kind: 'model_failure' }> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'model_failure',
    reason: wasCancelled ? 'cancelled' : 'stream_error',
    message,
  };
}
