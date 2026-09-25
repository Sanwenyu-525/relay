import { Type, type Static } from '@sinclair/typebox';

const strict = { additionalProperties: false } as const;

export const FieldErrorSchema = Type.Object(
  {
    field: Type.String(),
    message: Type.String(),
  },
  strict,
);

/**
 * 冲突明细（契约第 7 节）：值按 code 取其中相关字段，因此是字符串或字符串数组。
 * 没有冲突明细时不返回该键。
 */
export const ConflictSchema = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Array(Type.String())]),
);

export const ProblemDetailsSchema = Type.Object(
  {
    type: Type.String(),
    title: Type.String(),
    status: Type.Integer(),
    detail: Type.String(),
    instance: Type.String(),
    code: Type.String(),
    request_id: Type.String(),
    field_errors: Type.Optional(Type.Array(FieldErrorSchema)),
    command_id: Type.Optional(Type.String()),
    conflict: Type.Optional(ConflictSchema),
    retryable: Type.Boolean(),
    retry_action: Type.Union([
      Type.Literal('NONE'),
      Type.Literal('REFRESH_AND_REDECIDE'),
      Type.Literal('POLL_RESOURCE'),
      Type.Literal('CHECK_RECEIPT_THEN_RETRY'),
    ]),
  },
  strict,
);

export const LivenessSchema = Type.Object(
  {
    status: Type.Literal('alive'),
  },
  strict,
);

export const ReadinessComponentsSchema = Type.Object(
  {
    database: Type.Object(
      {
        status: Type.Union([Type.Literal('up'), Type.Literal('down')]),
      },
      strict,
    ),
    schema: Type.Object(
      {
        status: Type.Union([
          Type.Literal('up'),
          Type.Literal('down'),
          Type.Literal('unknown'),
        ]),
      },
      strict,
    ),
  },
  strict,
);

export const ReadinessReadySchema = Type.Object(
  {
    status: Type.Literal('ready'),
    components: ReadinessComponentsSchema,
  },
  strict,
);

export const ReadinessNotReadySchema = Type.Composite([
  ProblemDetailsSchema,
  Type.Object({ components: ReadinessComponentsSchema }, strict),
]);

export type ProblemDetailsBody = Static<typeof ProblemDetailsSchema>;
export type LivenessBody = Static<typeof LivenessSchema>;
export type ReadinessReadyBody = Static<typeof ReadinessReadySchema>;
export type ReadinessNotReadyBody = Static<typeof ReadinessNotReadySchema>;
