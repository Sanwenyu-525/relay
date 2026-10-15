import type { DecimalRevision } from '../../types';

export interface RelayAcceptanceMaterialInput {
  taskId: string; commandId: string; expectedAcceptanceRevision: DecimalRevision;
  knowledgeId: string; knowledgeVersion: DecimalRevision; criterionId?: string | null;
  testedArtifactVersionId?: string | null; sourceLabel?: string | null; note?: string | null;
}

export interface RelayAcceptanceMaterialResult {
  materialId: string; taskId: string; status: 'ACTIVE' | 'WITHDRAWN'; revision: DecimalRevision;
}

export interface RelayAcceptanceMaterial extends RelayAcceptanceMaterialResult {
  acceptanceRevision: DecimalRevision; criterionId: string | null;
  knowledgeId: string | null; knowledgeVersion: DecimalRevision | null; knowledgeVersionId: string;
  title: string | null; sha256: string | null; materialAvailability: 'AVAILABLE' | 'UNAVAILABLE';
  testedArtifactVersionId: string | null; acceptanceMatches: boolean; testedArtifactIsCurrent: boolean | null;
  evidenceKind: 'UNVERIFIED_REFERENCE'; sourceLabel: string | null; note: string | null;
  missingFields: readonly string[]; createdAt: string; withdrawnAt: string | null;
}

export interface RelayAcceptanceMaterials {
  taskId: string; acceptanceRevision: DecimalRevision; items: readonly RelayAcceptanceMaterial[];
}

export interface RelayAcceptanceMaterialImport extends Omit<RelayAcceptanceMaterialInput, 'knowledgeId' | 'knowledgeVersion'> {
  projectId: string; importCommandId: string; title: string; text: string;
  mediaType: 'text/plain' | 'text/markdown';
}
