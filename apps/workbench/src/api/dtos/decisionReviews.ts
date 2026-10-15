export interface RelayDecisionPremiseInput {
  decisionId: string; commandId: string; expectedDecisionRevision: string; confirmed: true; statement: string;
  knowledgeVersionId?: string; hypothesisId?: string; expectedHypothesisRevision?: string;
}
export interface RelayDecisionPremise {
  id: string; decisionId: string; projectId: string; decisionRevision: string; statement: string;
  knowledgeId: string | null; hypothesisId: string | null; baselineRef: Readonly<Record<string, unknown>>; revision: string; createdAt: string;
}
export interface RelayDecisionReview {
  id: string; premiseId: string; decisionId: string; decisionTitle: string | null; statement: string;
  decisionRevision: string; premiseRevision: string; fingerprint: string; causeCommandId: string;
  beforeRef: Readonly<Record<string, unknown>>; afterRef: Readonly<Record<string, unknown>>;
  status: 'PENDING' | 'KEPT' | 'DISMISSED'; revision: string; reason: string | null;
  applicable: boolean; question: string; createdAt: string; resolvedAt: string | null;
}
export interface RelayDecisionReviewResolution {
  candidateId: string; commandId: string; expectedRevision: string; action: 'KEEP_DECISION' | 'DISMISS'; reason: string;
}
