import type { RelayHttp } from '../core/http';
import { commandEnvelopeFrom } from '../parse/projects';
import { object, string } from '../core/primitives';
import { impactGroupSelectionFrom } from '../parse/impactGroupSelections';

export async function createImpactGroupSelection(http: RelayHttp, input: { groupId: string; commandId: string; candidateIds: readonly string[] }) {
  const envelope = commandEnvelopeFrom(await http.request(http.workspacePath(`/impact-candidate-groups/${encodeURIComponent(input.groupId)}/selections`), {
    method: 'POST', body: JSON.stringify({ command_id: input.commandId, candidate_ids: input.candidateIds }) }, 201));
  const result = object(envelope.result, 'impact group selection');
  if (envelope.commandId !== input.commandId || string(result, 'group_id', 'impact group selection') !== input.groupId) throw new Error('候选选择回执不匹配。');
  return string(result, 'selection_id', 'impact group selection');
}

export async function getImpactGroupSelection(http: RelayHttp, id: string) {
  const result = impactGroupSelectionFrom(await http.request(http.workspacePath(`/impact-group-selections/${encodeURIComponent(id)}`)));
  if (result.id !== id) throw new Error('候选选择身份不匹配。');
  return result;
}
