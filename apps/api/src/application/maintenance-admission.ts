import type { RuntimeAdmissionGateRow } from '../infrastructure/database-schema.js';
import { RuntimeAdmissionUnavailableError } from '../runtime/runtime-admission-repository.js';
import { DomainError } from './domain-error.js';
import type { Repositories } from './unit-of-work.js';

export function maintenanceUnavailable(): DomainError {
  return new DomainError({ code: 'MAINTENANCE_UNAVAILABLE', status: 503,
    type: '/problems/maintenance-unavailable', title: '维护准入状态不可用',
    detail: '未能核对数据库的维护准入状态，本次操作未获准入。',
    retryable: true, retryAction: 'CHECK_RECEIPT_THEN_RETRY' });
}

export async function readAdmission(repositories: Repositories, lock?: 'share' | 'update'):
  Promise<RuntimeAdmissionGateRow> {
  try { return await repositories.admission.read(lock); }
  catch (error) {
    if (error instanceof RuntimeAdmissionUnavailableError) throw maintenanceUnavailable();
    throw error;
  }
}

export function requireNormalAdmission(gate: RuntimeAdmissionGateRow): void {
  if (gate.mode !== 'NORMAL') {
    throw new DomainError({ code: 'MAINTENANCE_DRAINING', status: 503,
      type: '/problems/maintenance-draining', title: '正在排空现有工作',
      detail: '数据库已停止新工作准入；可继续读取、核对原回执和停止现有工作。',
      retryable: true, retryAction: 'CHECK_RECEIPT_THEN_RETRY' });
  }
}

/** Fixed internal command types; no HTTP input can add an admission bypass. */
export function isDrainControlCommand(commandType: string): boolean {
  return commandType === 'RequestRunControl' || commandType === 'CancelTask' ||
    commandType === 'CancelAssistMessage' || commandType === 'ClosePartialFileWrite';
}
