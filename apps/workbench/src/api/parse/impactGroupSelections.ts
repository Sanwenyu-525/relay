import { array, boolean, decimal, integer, nullableString, object, string, stringArray } from '../core/primitives';
import type { RelayImpactGroupSelection } from '../dtos/artifacts';

export function impactGroupSelectionFrom(value: unknown): RelayImpactGroupSelection {
  const row = object(value, 'impact group selection');
  if (string(row, 'overall_result', 'impact group selection') !== 'NONE') throw new Error('候选选择不能作为整体验收结论。');
  return { id: string(row, 'id', 'impact group selection'), groupId: string(row, 'group_id', 'impact group selection'),
    createdAt: string(row, 'created_at', 'impact group selection'), appliedCount: integer(row, 'applied_count', 'impact group selection'), overallResult: 'NONE',
    items: array(row, 'items', 'impact group selection').map(value => {
      const item = object(value, 'selected candidate');
      return { candidateId: string(item, 'candidate_id', 'selected candidate'), targetArtifactId: string(item, 'target_artifact_id', 'selected candidate'),
        targetVersionId: string(item, 'target_version_id', 'selected candidate'), expectedTargetRevision: decimal(item, 'expected_target_revision', 'selected candidate'),
        dependencyCandidateIds: stringArray(item, 'dependency_candidate_ids', 'selected candidate'), candidateStatus: string(item, 'candidate_status', 'selected candidate'),
        appliedVersionId: nullableString(item, 'applied_version_id', 'selected candidate'), appliedIsCurrent: boolean(item, 'applied_is_current', 'selected candidate'),
        canApply: boolean(item, 'can_apply', 'selected candidate'), reason: nullableString(item, 'reason', 'selected candidate') };
    }) };
}
