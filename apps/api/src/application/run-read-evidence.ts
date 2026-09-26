import { createHash } from 'node:crypto';

import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import type { Repositories } from './unit-of-work.js';
import { readFileReadAction, readWebFetchAction } from '../workflow/execution-contract.js';

// A Gateway result can be larger than a useful model input. The captured
// result stays immutable in Invocation history; only this bounded excerpt is
// sent to the model, with hashes for both the full text and the excerpt.
export const MAX_MODEL_READ_BYTES = 16 * 1024;

export class ReadInputBudgetError extends Error {
  override readonly name = 'ReadInputBudgetError';
}

export interface RunReadEvidence {
  readonly operationId: string;
  readonly invocationId: string;
  readonly input: JsonObject;
}

export async function loadRunReadEvidence(repositories: Repositories,
  runId: string): Promise<RunReadEvidence | undefined> {
  const contract = await repositories.runs.readContract(runId);
  if (contract === undefined) throw new Error('Run has no frozen contract');
  const file = readFileReadAction(contract.frozen_snapshot);
  const web = readWebFetchAction(contract.frozen_snapshot);
  if (file === undefined && web === undefined) return undefined;
  if (file !== undefined && web !== undefined) throw new Error('Run has two frozen read intents');

  const operationId = (file ?? web)!.operation_id;
  const operation = await repositories.gateway.readOperation(operationId);
  const built = await repositories.runs.readStepByKind(runId, 'BUILD_CONTEXT');
  const draft = await repositories.runs.readStepByKind(runId, 'DRAFT');
  if (operation?.run_id !== runId || operation.status !== 'SUCCEEDED' ||
      operation.capability_key !== (file === undefined ? 'WEB_FETCH' : 'FILE_READ') ||
      (operation.step_id !== built?.id && operation.step_id !== draft?.id)) {
    throw new Error('DRAFT read evidence is not a succeeded frozen Run action');
  }
  const invocation = await repositories.gateway.lastInvocation(operationId);
  const result = operation.result_ref;
  if (invocation?.status !== 'SUCCEEDED' || invocation.result_ref === null || result === null ||
      canonicalizeJson(invocation.result_ref) !== canonicalizeJson(result) ||
      result.operation_id !== operationId || result.invocation_id !== invocation.id ||
      typeof result.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(result.sha256)) {
    throw new Error('DRAFT read evidence has no matching successful Invocation');
  }
  if (file !== undefined && (result.target !== operation.normalized_target ||
      typeof result.content !== 'string')) {
    throw new Error('DRAFT file-read evidence has no matching target or text');
  }
  if (web !== undefined && (result.url !== operation.normalized_target ||
      (typeof result.content !== 'string' &&
        !(result.content === null && result.text_available === false)))) {
    throw new Error('DRAFT web-read evidence has no matching URL or text status');
  }

  const content = typeof result.content === 'string' ? result.content : '';
  const fullBytes = Buffer.from(content, 'utf8');
  const included = prefixUtf8(content, MAX_MODEL_READ_BYTES);
  const input: JsonObject = {
    kind: file === undefined ? 'WEB_FETCH' : 'FILE_READ',
    trust: 'UNTRUSTED_DATA',
    operation_id: operationId,
    invocation_id: invocation.id,
    target: operation.normalized_target,
    source_sha256: result.sha256,
    content_sha256: sha256(content),
    included_sha256: sha256(included),
    content_bytes: fullBytes.length,
    included_bytes: Buffer.byteLength(included, 'utf8'),
    input_truncated: fullBytes.length > MAX_MODEL_READ_BYTES,
    adapter_truncated: result.text_truncated === true,
    text_available: result.text_available !== false,
    content: included,
    ...(web === undefined ? {} : {
      final_url: typeof result.final_url === 'string' ? result.final_url : operation.normalized_target,
      extractor: typeof result.extractor === 'string' ? result.extractor : null,
    }),
  };
  return { operationId, invocationId: invocation.id, input };
}

export function draftInputHash(manifest: JsonObject, outputSchema: string): string {
  return sha256(canonicalizeJson({ format: 'draft-input-v1', manifest,
    output_schema: outputSchema }));
}

/** The read excerpt has step-specific priority, but must fit the same Context
 * estimate and reserved output budget as the immutable BUILD_CONTEXT Manifest.
 * Its own content is reduced first; the mandatory Manifest is never trimmed. */
export function attachReadEvidenceWithinBudget(manifest: JsonObject,
  read: RunReadEvidence): JsonObject {
  const budget = manifest.budget;
  if (typeof budget !== 'object' || budget === null || Array.isArray(budget)) {
    throw new ReadInputBudgetError('Context Manifest has no valid model input budget');
  }
  const values = budget as JsonObject;
  if (!Number.isInteger(values.limit_tokens) || !Number.isInteger(values.reserved_tokens)) {
    throw new ReadInputBudgetError('Context Manifest has no valid model input budget');
  }
  const limit = values.limit_tokens as number;
  const reserved = values.reserved_tokens as number;
  const fits = (input: JsonObject): boolean =>
    Math.ceil(Buffer.byteLength(canonicalizeJson(input), 'utf8') / 3) + reserved <= limit;
  const full = { ...manifest, tool_read: read.input };
  if (fits(full)) return full;
  const content = read.input.content as string;
  const characters = Array.from(content);
  let low = 0;
  let high = characters.length;
  let chosen: JsonObject | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const excerpt = characters.slice(0, middle).join('');
    const candidate = { ...manifest, tool_read: { ...read.input, content: excerpt,
      included_bytes: Buffer.byteLength(excerpt, 'utf8'),
      included_sha256: sha256(excerpt), input_truncated: true } };
    if (fits(candidate)) { chosen = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  if (chosen === undefined) {
    throw new ReadInputBudgetError('Gateway read metadata exceeds the Context model input budget');
  }
  return chosen;
}

function prefixUtf8(value: string, maxBytes: number): string {
  const characters: string[] = [];
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > maxBytes) break;
    used += size;
    characters.push(character);
  }
  return characters.join('');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
