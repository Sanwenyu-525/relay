import { RelayHttp } from '../core/http';
import { array, boolean, decimal, nullableString, object, string, stringArray } from '../core/primitives';
import { commandEnvelopeFrom } from '../parse/projects';
import type { RelayHypothesis, RelayHypothesisConclusion, RelayHypothesisCreate, RelayHypothesisDefinition,
  RelayHypothesisMutation, RelayHypothesisObservation, RelayHypothesisResult, RelayHypothesisSuggestion,
  RelayHypothesisVersion } from '../dtos/hypotheses';

const nullable = (row: Record<string, unknown>, key: string) => row[key] === undefined ? null : nullableString(row, key, 'hypothesis');
function resultFrom(value: unknown): RelayHypothesisResult {
  const row = object(value, 'hypothesis result');
  return { hypothesisId: string(row, 'hypothesis_id', 'hypothesis result'), projectId: string(row, 'project_id', 'hypothesis result'),
    revision: decimal(row, 'revision', 'hypothesis result'), version: decimal(row, 'version', 'hypothesis result'),
    suggestionId: nullable(row, 'suggestion_id'), conclusionId: nullable(row, 'conclusion_id'),
    outcome: nullable(row, 'outcome'), recommendation: nullable(row, 'recommendation'),
    decisionReviewCount: row.decision_review_count === undefined ? null : decimal(row, 'decision_review_count', 'hypothesis result'),
    decisionReviewCandidatesRef: nullable(row, 'decision_review_candidates_ref') };
}
function conclusionFrom(value: unknown): RelayHypothesisConclusion {
  const row = object(value, 'hypothesis conclusion');
  const kind = string(row, 'kind', 'hypothesis conclusion');
  const outcome = string(row, 'outcome', 'hypothesis conclusion');
  if (kind !== 'SUGGESTION' && kind !== 'USER_CONFIRMED') throw new Error('无法识别假设建议/用户结论来源。');
  if (outcome !== 'SUPPORTED' && outcome !== 'NOT_SUPPORTED' && outcome !== 'INCONCLUSIVE') throw new Error('无法识别假设判断。');
  return { id: string(row, 'id', 'hypothesis conclusion'), hypothesisVersion: decimal(row, 'hypothesis_version', 'hypothesis conclusion'),
    kind, outcome, rationale: string(row, 'rationale', 'hypothesis conclusion'), evidenceSufficient: boolean(row, 'evidence_sufficient', 'hypothesis conclusion'),
    methodReliable: boolean(row, 'method_reliable', 'hypothesis conclusion'), observationIds: stringArray(row, 'observation_ids', 'hypothesis conclusion'),
    suggestionId: nullable(row, 'suggestion_id'), applicable: boolean(row, 'applicable', 'hypothesis conclusion'),
    recommendation: string(row, 'recommendation', 'hypothesis conclusion'), createdAt: string(row, 'created_at', 'hypothesis conclusion') };
}
function hypothesisFrom(value: unknown): RelayHypothesis {
  const row = object(value, 'hypothesis');
  const base = resultFrom(row);
  const versions: RelayHypothesisVersion[] = array(row, 'versions', 'hypothesis').map((value) => {
    const v = object(value, 'hypothesis version');
    return { id: string(v, 'id', 'hypothesis version'), version: decimal(v, 'version', 'hypothesis version'),
      claim: string(v, 'claim', 'hypothesis version'), method: string(v, 'method', 'hypothesis version'), criterion: string(v, 'criterion', 'hypothesis version'),
      sourceKnowledgeVersionId: nullable(v, 'source_knowledge_version_id'), sourceMessageId: nullable(v, 'source_message_id'),
      sourceStatus: string(v, 'source_status', 'hypothesis version'), createdAt: string(v, 'created_at', 'hypothesis version') };
  });
  const observations: RelayHypothesisObservation[] = array(row, 'observations', 'hypothesis').map((value) => {
    const o = object(value, 'hypothesis observation');
    const evidenceKind = string(o, 'evidence_kind', 'hypothesis observation');
    if (evidenceKind !== 'USER_REPORTED' && evidenceKind !== 'UNVERIFIED_REFERENCE') throw new Error('假设观察不能作为正式通过证据。');
    return { id: string(o, 'id', 'hypothesis observation'), hypothesisVersion: decimal(o, 'hypothesis_version', 'hypothesis observation'),
      summary: string(o, 'summary', 'hypothesis observation'), knowledgeVersionId: nullable(o, 'knowledge_version_id'), evidenceKind,
      sourceStatus: string(o, 'source_status', 'hypothesis observation'), createdAt: string(o, 'created_at', 'hypothesis observation') };
  });
  return { ...base, title: string(row, 'title', 'hypothesis'), createdAt: string(row, 'created_at', 'hypothesis'), versions, observations,
    conclusions: array(row, 'conclusions', 'hypothesis').map(conclusionFrom),
    currentUserConclusion: row.current_user_conclusion === null ? null : conclusionFrom(row.current_user_conclusion) };
}
const path = (http: RelayHttp, id: string) => http.workspacePath(`/hypotheses/${encodeURIComponent(id)}`);
const definitionBody = (input: RelayHypothesisDefinition) => ({ claim: input.claim, method: input.method, criterion: input.criterion,
  ...(input.sourceKnowledgeVersionId === undefined ? {} : { source_knowledge_version_id: input.sourceKnowledgeVersionId }) });
async function submit(http: RelayHttp, url: string, commandId: string, body: Record<string, unknown>, status: 200 | 201, id?: string) {
  const envelope = commandEnvelopeFrom(await http.request(url, { method: 'POST', body: JSON.stringify({ command_id: commandId, ...body }) }, status));
  const result = resultFrom(envelope.result);
  if (envelope.commandId !== commandId || (id !== undefined && result.hypothesisId !== id)) throw new Error('假设回执与原命令、对象不匹配。');
  return result;
}
export async function createHypothesis(http: RelayHttp, input: RelayHypothesisCreate) {
  const result = await submit(http, http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/hypotheses`), input.commandId,
    { ...definitionBody(input), title: input.title, confirmed: input.confirmed }, 201);
  if (result.projectId !== input.projectId) throw new Error('假设建档回执与原项目不匹配。');
  return result;
}
export function versionHypothesis(http: RelayHttp, input: RelayHypothesisMutation & RelayHypothesisDefinition) {
  return submit(http, `${path(http, input.hypothesisId)}/versions`, input.commandId,
    { ...definitionBody(input), expected_revision: input.expectedRevision }, 200, input.hypothesisId);
}
export function observeHypothesis(http: RelayHttp, input: RelayHypothesisMutation & { summary: string; knowledgeVersionId?: string }) {
  return submit(http, `${path(http, input.hypothesisId)}/observations`, input.commandId, { expected_revision: input.expectedRevision,
    summary: input.summary, ...(input.knowledgeVersionId === undefined ? {} : { knowledge_version_id: input.knowledgeVersionId }) }, 200, input.hypothesisId);
}
export function suggestHypothesisConclusion(http: RelayHttp, input: RelayHypothesisSuggestion) {
  return submit(http, `${path(http, input.hypothesisId)}/suggestions`, input.commandId, { expected_revision: input.expectedRevision,
    outcome: input.outcome, rationale: input.rationale, evidence_sufficient: input.evidenceSufficient, method_reliable: input.methodReliable }, 200, input.hypothesisId);
}
export function confirmHypothesisConclusion(http: RelayHttp, input: RelayHypothesisMutation & { suggestionId: string; confirmed: true }) {
  return submit(http, `${path(http, input.hypothesisId)}/confirmations`, input.commandId,
    { expected_revision: input.expectedRevision, suggestion_id: input.suggestionId, confirmed: input.confirmed }, 200, input.hypothesisId);
}
export async function getHypothesis(http: RelayHttp, id: string) {
  const result = hypothesisFrom(await http.request(path(http, id)));
  if (result.hypothesisId !== id) throw new Error('假设读回对象不匹配。');
  return result;
}
export async function getProjectHypotheses(http: RelayHttp, projectId: string) {
  const row = object(await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/hypotheses`)), 'project hypotheses');
  const items = array(row, 'items', 'project hypotheses').map(hypothesisFrom);
  if (row.project_id !== projectId || items.some((item) => item.projectId !== projectId)) throw new Error('假设列表与原项目不匹配。');
  return { projectId, items };
}
