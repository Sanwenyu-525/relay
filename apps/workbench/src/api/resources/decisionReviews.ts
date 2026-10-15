import { RelayHttp } from '../core/http';
import { array, boolean, decimal, integer, nullableString, object, string } from '../core/primitives';
import { commandEnvelopeFrom } from '../parse/projects';
import type { RelayDecisionPremise, RelayDecisionPremiseInput, RelayDecisionReview, RelayDecisionReviewResolution } from '../dtos/decisionReviews';

export async function registerDecisionPremise(http: RelayHttp, input: RelayDecisionPremiseInput) {
  const envelope = commandEnvelopeFrom(await http.request(http.workspacePath(`/decisions/${encodeURIComponent(input.decisionId)}/premises`), {
    method: 'POST', body: JSON.stringify({ command_id: input.commandId, expected_decision_revision: input.expectedDecisionRevision,
      confirmed: input.confirmed, statement: input.statement,
      ...(input.knowledgeVersionId === undefined ? {} : { knowledge_version_id: input.knowledgeVersionId }),
      ...(input.hypothesisId === undefined ? {} : { hypothesis_id: input.hypothesisId }),
      ...(input.expectedHypothesisRevision === undefined ? {} : { expected_hypothesis_revision: input.expectedHypothesisRevision }) }) }, 200));
  const row = envelope.result;
  const result = { premiseId: string(row, 'premise_id', 'premise result'), decisionId: string(row, 'decision_id', 'premise result'),
    projectId: string(row, 'project_id', 'premise result'), revision: decimal(row, 'revision', 'premise result') };
  if (envelope.commandId !== input.commandId || result.decisionId !== input.decisionId) throw new Error('前提登记回执与原命令/决定不匹配。');
  return result;
}
export async function getDecisionPremises(http: RelayHttp, decisionId: string) {
  const row = object(await http.request(http.workspacePath(`/decisions/${encodeURIComponent(decisionId)}/premises`)), 'decision premises');
  const items: RelayDecisionPremise[] = array(row, 'items', 'decision premises').map((value) => {
    const p = object(value, 'decision premise');
    return { id: string(p, 'id', 'decision premise'), decisionId: string(p, 'decision_id', 'decision premise'), projectId: string(p, 'project_id', 'decision premise'),
      decisionRevision: decimal(p, 'decision_revision', 'decision premise'), statement: string(p, 'statement', 'decision premise'),
      knowledgeId: nullableString(p, 'knowledge_id', 'decision premise'), hypothesisId: nullableString(p, 'hypothesis_id', 'decision premise'),
      baselineRef: object(p.baseline_ref, 'decision premise baseline'), revision: decimal(p, 'revision', 'decision premise'), createdAt: string(p, 'created_at', 'decision premise') };
  });
  if (row.decision_id !== decisionId || items.some((item) => item.decisionId !== decisionId)) throw new Error('前提读回与原决定不匹配。');
  return { decisionId, items };
}
function reviewFrom(value: unknown): RelayDecisionReview {
  const row = object(value, 'decision review');
  const status = string(row, 'status', 'decision review');
  if (status !== 'PENDING' && status !== 'KEPT' && status !== 'DISMISSED') throw new Error('无法识别决定复审状态。');
  return { id: string(row, 'id', 'decision review'), premiseId: string(row, 'premise_id', 'decision review'),
    decisionId: string(row, 'decision_id', 'decision review'), decisionTitle: nullableString(row, 'decision_title', 'decision review'),
    statement: string(row, 'statement', 'decision review'), decisionRevision: decimal(row, 'decision_revision', 'decision review'),
    premiseRevision: decimal(row, 'premise_revision', 'decision review'), fingerprint: string(row, 'fingerprint', 'decision review'),
    causeCommandId: string(row, 'cause_command_id', 'decision review'), beforeRef: object(row.before_ref, 'review before'), afterRef: object(row.after_ref, 'review after'),
    status, revision: decimal(row, 'revision', 'decision review'), reason: nullableString(row, 'reason', 'decision review'),
    applicable: boolean(row, 'applicable', 'decision review'), question: string(row, 'question', 'decision review'),
    createdAt: string(row, 'created_at', 'decision review'), resolvedAt: nullableString(row, 'resolved_at', 'decision review') };
}
export async function getProjectDecisionReviews(http: RelayHttp, projectId: string) {
  const row = object(await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/decision-reviews`)), 'decision reviews');
  if (row.project_id !== projectId) throw new Error('复审读回与原项目不匹配。');
  return { projectId, pendingCount: integer(row, 'pending_count', 'decision reviews'), items: array(row, 'items', 'decision reviews').map(reviewFrom) };
}
export async function resolveDecisionReview(http: RelayHttp, input: RelayDecisionReviewResolution) {
  const envelope = commandEnvelopeFrom(await http.request(http.workspacePath(`/decision-reviews/${encodeURIComponent(input.candidateId)}/resolutions`), {
    method: 'POST', body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision, action: input.action, reason: input.reason }) }, 200));
  const row = envelope.result;
  const status = string(row, 'status', 'review result');
  if (status !== 'KEPT' && status !== 'DISMISSED') throw new Error('复审处理未返回已登记状态。');
  const result = { candidateId: string(row, 'candidate_id', 'review result'), projectId: string(row, 'project_id', 'review result'),
    status, revision: decimal(row, 'revision', 'review result') };
  if (envelope.commandId !== input.commandId || result.candidateId !== input.candidateId) throw new Error('复审处理回执与原命令/候选不匹配。');
  return result;
}
