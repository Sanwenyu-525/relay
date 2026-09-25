import type { WorkspaceExecutionAuthorityRow } from '../infrastructure/database-schema.js';
import { DomainError } from './domain-error.js';
import type { Repositories } from './unit-of-work.js';

/** 0004–0008 的旧 Run 无字段，等同规则版本 0；任何规则变更使其失效。 */
export async function requireCurrentRuleSnapshot(repositories: Repositories, runId: string,
  authority: WorkspaceExecutionAuthorityRow): Promise<void> {
  const contract = await repositories.runs.readContract(runId);
  const frozen = contract?.frozen_snapshot.rule_revision;
  const frozenRevision = typeof frozen === 'string' ? frozen : '0';
  if (contract === undefined || frozenRevision !== authority.rule_revision.toString()) {
    throw new DomainError({ code: 'RULE_SNAPSHOT_STALE', status: 409,
      type: '/problems/rule-snapshot-stale', title: '执行规则快照已变化',
      detail: 'Run 冻结后适用规则发生变化；需结束旧 Run 并按当前 Rule 重新 Delegate。',
      retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
  }
}
