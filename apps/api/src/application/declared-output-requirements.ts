import type { ArtifactKind, TaskRow } from '../infrastructure/database-schema.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { invalidTransition } from './domain-error.js';

/** 本阶段能由受管产物与固定 Workflow 判定的种类。 */
const KNOWN_ARTIFACT_KINDS: readonly ArtifactKind[] = ['MARKDOWN_DOCUMENT'];

export type DeclaredOutputsCheck =
  | { readonly status: 'SATISFIED'; readonly declaredKinds: readonly ArtifactKind[] }
  | { readonly status: 'INVALID_SHAPE' }
  | { readonly status: 'UNSUPPORTED_KIND'; readonly artifactKinds: readonly string[] }
  | { readonly status: 'MISSING_ARTIFACT_KINDS'; readonly artifactKinds: readonly ArtifactKind[] };

/**
 * 对冻结或当前验收版本的产物要求做纯业务核对。
 *
 * 未提供 `providedArtifactKinds` 时只验证声明形态，供 Delegate 在创建 Run 前拒绝固定
 * Workflow 无法判定的要求；提供时同时核对确切版本集合，供人工完成与自动完成 Gate 复用。
 */
export function checkDeclaredOutputs(input: {
  readonly requiredOutputSpec: JsonObject;
  readonly providedArtifactKinds?: readonly ArtifactKind[] | undefined;
}): DeclaredOutputsCheck {
  const raw = input.requiredOutputSpec.artifacts;

  if (raw === undefined) {
    return { status: 'SATISFIED', declaredKinds: [] };
  }

  if (!Array.isArray(raw)) {
    return { status: 'INVALID_SHAPE' };
  }

  const declared: ArtifactKind[] = [];
  const unsupported: string[] = [];

  for (const item of raw) {
    const kind = KNOWN_ARTIFACT_KINDS.find((candidate) => candidate === item);

    if (kind === undefined) {
      unsupported.push(stringifyArtifactKind(item));
      continue;
    }

    if (!declared.includes(kind)) {
      declared.push(kind);
    }
  }

  if (unsupported.length > 0) {
    return { status: 'UNSUPPORTED_KIND', artifactKinds: unsupported.sort() };
  }

  const declaredKinds = declared.sort();

  if (input.providedArtifactKinds === undefined) {
    return { status: 'SATISFIED', declaredKinds };
  }

  const provided = new Set(input.providedArtifactKinds);
  const missing = declaredKinds.filter((kind) => !provided.has(kind));

  return missing.length === 0
    ? { status: 'SATISFIED', declaredKinds }
    : { status: 'MISSING_ARTIFACT_KINDS', artifactKinds: missing };
}

/** Delegate 与人工完成的失败语义：非法或不完整声明都不能静默放行。 */
export function requireDeclaredOutputs(input: {
  readonly task: TaskRow;
  readonly acceptanceRevision: bigint;
  readonly requiredOutputSpec: JsonObject;
  readonly providedArtifactKinds?: readonly ArtifactKind[] | undefined;
}): readonly ArtifactKind[] {
  const check = checkDeclaredOutputs({
    requiredOutputSpec: input.requiredOutputSpec,
    ...(input.providedArtifactKinds === undefined
      ? {}
      : { providedArtifactKinds: input.providedArtifactKinds }),
  });

  if (check.status === 'SATISFIED') {
    return check.declaredKinds;
  }

  if (check.status === 'INVALID_SHAPE') {
    throw invalidTransition(
      '当前验收版本的 required_output_spec.artifacts 不是受支持的形态，无法判定产物要求。',
      { taskId: input.task.id, acceptanceRevision: toDecimalString(input.acceptanceRevision) },
    );
  }

  if (check.status === 'UNSUPPORTED_KIND') {
    throw invalidTransition(
      '当前验收版本声明了不受支持的产物种类，不能判定产物要求是否满足。',
      {
        taskId: input.task.id,
        acceptanceRevision: toDecimalString(input.acceptanceRevision),
        artifactKinds: check.artifactKinds,
      },
    );
  }

  throw invalidTransition(
    '当前验收版本要求产出受管产物，提交的 artifact_version_ids 未覆盖要求的种类。',
    {
      taskId: input.task.id,
      acceptanceRevision: toDecimalString(input.acceptanceRevision),
      artifactKinds: check.artifactKinds,
    },
  );
}

function stringifyArtifactKind(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
