export interface RelayHypothesisDefinition { claim: string; method: string; criterion: string; sourceKnowledgeVersionId?: string }
export interface RelayHypothesisMutation { hypothesisId: string; commandId: string; expectedRevision: string }
export interface RelayHypothesisResult {
  hypothesisId: string; projectId: string; revision: string; version: string;
  suggestionId: string | null; conclusionId: string | null; outcome: string | null; recommendation: string | null;
  decisionReviewCount: string | null; decisionReviewCandidatesRef: string | null;
}
export interface RelayHypothesisVersion {
  id: string; version: string; claim: string; method: string; criterion: string;
  sourceKnowledgeVersionId: string | null; sourceMessageId: string | null; sourceStatus: string; createdAt: string;
}
export interface RelayHypothesisObservation {
  id: string; hypothesisVersion: string; summary: string; knowledgeVersionId: string | null;
  evidenceKind: 'USER_REPORTED' | 'UNVERIFIED_REFERENCE'; sourceStatus: string; createdAt: string;
}
export interface RelayHypothesisConclusion {
  id: string; hypothesisVersion: string; kind: 'SUGGESTION' | 'USER_CONFIRMED';
  outcome: 'SUPPORTED' | 'NOT_SUPPORTED' | 'INCONCLUSIVE'; rationale: string;
  evidenceSufficient: boolean; methodReliable: boolean; observationIds: readonly string[];
  suggestionId: string | null; applicable: boolean; recommendation: string; createdAt: string;
}
export interface RelayHypothesis {
  hypothesisId: string; projectId: string; title: string; revision: string; version: string; createdAt: string;
  versions: RelayHypothesisVersion[]; observations: RelayHypothesisObservation[];
  conclusions: RelayHypothesisConclusion[]; currentUserConclusion: RelayHypothesisConclusion | null;
}
export interface RelayHypothesisCreate extends RelayHypothesisDefinition {
  projectId: string; commandId: string; title: string; confirmed: true;
}
export interface RelayHypothesisSuggestion extends RelayHypothesisMutation {
  outcome: RelayHypothesisConclusion['outcome']; rationale: string; evidenceSufficient: boolean; methodReliable: boolean;
}
