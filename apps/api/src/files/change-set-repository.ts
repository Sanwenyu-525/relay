import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  ChangeSetEvidenceSource, ChangeSetFileRow, ChangeSetFileStatus, ChangeSetRow, ChangeSetStatus,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { requireRow } from '../shared/sql-rows.js';

/**
 * 0031 change_sets / change_set_files 的唯一 SQL Owner。
 *
 * 恢复与不可变语义（contracts/04、docs/architecture/tool-adapters.md §2）：
 * * 一次 invocation 至多一份账本（`uq_change_set_invocation`）。核对回到同一行收敛状态，
 *   不因二次核对插入第二份历史，也不新建伪造成功。
 * * 逐文件行写入即固定：应用角色只有 SELECT/INSERT，重复观测按
 *   `ON CONFLICT DO NOTHING` 保留更早的那份证据，不用后到的观测改写历史。
 * * 这里不触碰磁盘，也不自行开事务；调用方是应用用例（gateway-actions），它在结果结算
 *   或恢复核对的同一短事务内传入「已经落盘之后的结果事实」。
 */

/** 账本头的作用域与身份：取自已锁定的 operation/invocation 事实，不接受调用方自造摘要。 */
export interface ChangeSetLedgerHeader {
  readonly workspace_id: string; readonly project_id: string;
  readonly run_id: string; readonly resource_id: string;
  readonly operation_id: string; readonly invocation_id: string;
  readonly action_type: 'APPLY_CHANGESET' | 'WRITE_FILE';
  /** 执行时使用的规范根；相对路径只有在这个根的语境里才可复现。 */
  readonly canonical_root: string;
}

/** 逐文件行：声明侧（path/action/baseline/target）来自冻结输入，观测侧（actual/status/error）来自真实落盘或回读。 */
export interface ChangeSetLedgerFile {
  readonly relative_path: string;
  readonly action: 'CREATE' | 'MODIFY' | 'DELETE';
  readonly baseline_sha256: string | null;
  readonly observed_baseline_sha256: string | null;
  readonly target_sha256: string | null;
  readonly actual_sha256: string | null;
  readonly status: ChangeSetFileStatus;
  readonly error: string | null;
  readonly diff_ref: JsonObject | null;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

/** 只接受真正的 SHA-256（统一小写）。「看起来像 hash」的值不能充当证据。 */
function sha(value: string | null | undefined): string | null {
  return typeof value === 'string' && SHA256_PATTERN.test(value) ? value.toLowerCase() : null;
}

function reason(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
}

/** 账本键：执行与核对都按冻结输入的同一形态归一，避免 './a' 与 'a' 生成两行证据。 */
function ledgerPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

/**
 * 落库前的最后一道证据守卫：状态与摘要必须自洽，否则按「未证实」如实降级记录。
 * 目的是让结算事务不会因为一条可疑的逐文件声明整体失败——账本缺项还能核对，
 * 半途异常会连带丢失 invocation 的结果事实。降级只影响账本表述，不改 Gateway 业务判定。
 */
function guardFile(file: ChangeSetLedgerFile): ChangeSetLedgerFile {
  const baseline = sha(file.baseline_sha256);
  const target = file.action === 'DELETE' ? null : sha(file.target_sha256);
  const actual = file.action === 'DELETE' ? null : sha(file.actual_sha256);
  let status = file.status;
  let error = reason(file.error);
  if (status === 'APPLIED') {
    // 声称成功必须有「实际内容摘要 == 目标摘要」；删除的成功是路径确实不存在。
    const proven = file.action === 'DELETE'
      ? actual === null
      : actual !== null && actual === target;
    if (!proven) {
      status = 'CONFLICT';
      error = error === null ? 'APPLIED_NOT_PROVEN' : `${error} / APPLIED_NOT_PROVEN`;
    }
  }
  if (status !== 'APPLIED' && file.action !== 'CREATE' && baseline === null) {
    // 修改/删除缺可信冻结基线时，该文件从未具备被应用的前提，按输入失败记录。
    status = 'FAILED';
    error = error ?? 'INVALID_FROZEN_BASELINE';
  }
  if (status !== 'APPLIED') error = error ?? 'REASON_NOT_RECORDED';
  return {
    relative_path: ledgerPath(file.relative_path), action: file.action,
    baseline_sha256: baseline, observed_baseline_sha256: sha(file.observed_baseline_sha256),
    target_sha256: target,
    actual_sha256: file.action === 'DELETE' && status === 'APPLIED' ? null : actual,
    status, error, diff_ref: file.diff_ref,
  };
}

export class ChangeSetRepository {
  constructor(private readonly db: DbExecutor) {}

  /** 账本头按 invocation 幂等落位；已存在时只回到同一行更新汇总字段。 */
  private async upsertHeader(header: ChangeSetLedgerHeader, id: string, fileCount: number,
    status: ChangeSetStatus, evidenceSource: ChangeSetEvidenceSource): Promise<string> {
    const result = await sql<{ id: string }>`
      insert into change_sets (id, invocation_id, operation_id, workspace_id, project_id,
        run_id, resource_id, action_type, canonical_root, status, evidence_source, file_count)
      values (${id}, ${header.invocation_id}, ${header.operation_id}, ${header.workspace_id},
        ${header.project_id}, ${header.run_id}, ${header.resource_id}, ${header.action_type},
        ${header.canonical_root}, ${status}, ${evidenceSource}, ${fileCount})
      on conflict (invocation_id) do update
        set status = ${status}, evidence_source = ${evidenceSource}, updated_at = now()
      returning id
    `.execute(this.db);
    return requireRow(result.rows, 'upsert change set').id;
  }

  /** 逐文件行只补记缺失路径；更早的那份观测保持不变（该表也没有 UPDATE 权限）。 */
  private async insertMissingFiles(changeSetId: string, invocationId: string,
    files: readonly ChangeSetLedgerFile[]): Promise<void> {
    for (const file of files.map(guardFile)) {
      await sql`
        insert into change_set_files (change_set_id, invocation_id, relative_path, action,
          baseline_sha256, observed_baseline_sha256, target_sha256, actual_sha256, status, error, diff_ref)
        values (${changeSetId}, ${invocationId}, ${file.relative_path}, ${file.action},
          ${file.baseline_sha256}, ${file.observed_baseline_sha256}, ${file.target_sha256},
          ${file.actual_sha256}, ${file.status}, ${file.error},
          ${file.diff_ref === null ? null : JSON.stringify(file.diff_ref)}::jsonb)
        on conflict (change_set_id, relative_path) do nothing
      `.execute(this.db);
    }
  }

  private async unappliedFileCount(changeSetId: string): Promise<bigint> {
    const result = await sql<{ count: bigint }>`
      select count(*)::bigint as count from change_set_files
      where change_set_id = ${changeSetId} and status <> 'APPLIED'
    `.execute(this.db);
    return result.rows[0]?.count ?? 0n;
  }

  /**
   * 执行结算：把 executeFileChangeset 的逐文件结果固化为账本。
   * 整体状态由用例决定——全部落盘 SUCCEEDED、存在冲突/失败 PARTIAL（部分应用不整体成功）、
   * 结果无法归属本次调用时 UNKNOWN。
   */
  async recordExecution(header: ChangeSetLedgerHeader, id: string,
    files: readonly ChangeSetLedgerFile[], status: ChangeSetStatus): Promise<ChangeSetRow> {
    const changeSetId = await this.upsertHeader(header, id, files.length, status, 'EXECUTION');
    await this.insertMissingFiles(changeSetId, header.invocation_id, files);
    const changeSet = await this.readById(changeSetId);
    if (changeSet === undefined) throw new Error('change set row missing after execution settle');
    return changeSet;
  }

  /**
   * 恢复核对：按 invocation 回到同一份账本（崩溃于结算之前则由此处新建），补记执行阶段
   * 缺失的逐文件观测，并把整体状态收敛为 SUCCEEDED 或保持 UNKNOWN。
   * `confirmed` 是用例按真实内容与目标 hash 逐项比对的结果；只要还有一条未确认，或账本里
   * 存在执行阶段记录的冲突/失败，就不写成功。
   */
  async recordReconciliation(header: ChangeSetLedgerHeader, id: string,
    files: readonly ChangeSetLedgerFile[], confirmed: boolean): Promise<ChangeSetRow> {
    const changeSetId = await this.upsertHeader(header, id, files.length, 'UNKNOWN', 'RECONCILIATION');
    await this.insertMissingFiles(changeSetId, header.invocation_id, files);
    const status: ChangeSetStatus =
      confirmed && (await this.unappliedFileCount(changeSetId)) === 0n ? 'SUCCEEDED' : 'UNKNOWN';
    const result = await sql<ChangeSetRow>`
      update change_sets set status = ${status}, evidence_source = 'RECONCILIATION',
        file_count = ${files.length}, updated_at = now() where id = ${changeSetId} returning *
    `.execute(this.db);
    return requireRow(result.rows, 'settle reconciled change set');
  }

  async readById(id: string): Promise<ChangeSetRow | undefined> {
    return (await sql<ChangeSetRow>`select * from change_sets where id = ${id}`.execute(this.db)).rows[0];
  }

  async readByInvocation(invocationId: string): Promise<ChangeSetRow | undefined> {
    return (await sql<ChangeSetRow>`select * from change_sets where invocation_id = ${invocationId}`
      .execute(this.db)).rows[0];
  }

  async listByOperation(operationId: string): Promise<readonly ChangeSetRow[]> {
    return (await sql<ChangeSetRow>`select * from change_sets where operation_id = ${operationId}
      order by created_at, id`.execute(this.db)).rows;
  }

  async listFiles(changeSetId: string): Promise<readonly ChangeSetFileRow[]> {
    return (await sql<ChangeSetFileRow>`select * from change_set_files where change_set_id = ${changeSetId}
      order by relative_path`.execute(this.db)).rows;
  }

  /** 按 invocation 读回账本及其逐文件行（恢复核对与后续 UI 的同一入口）。 */
  async readLedgerByInvocation(invocationId: string): Promise<{
    readonly changeSet: ChangeSetRow; readonly files: readonly ChangeSetFileRow[];
  } | undefined> {
    const changeSet = await this.readByInvocation(invocationId);
    if (changeSet === undefined) return undefined;
    return { changeSet, files: await this.listFiles(changeSet.id) };
  }

  /** 幂等断言用：同一 invocation 至多一份账本头。 */
  async countByInvocation(invocationId: string): Promise<number> {
    const result = await sql<{ count: bigint }>`
      select count(*)::bigint as count from change_sets where invocation_id = ${invocationId}
    `.execute(this.db);
    return Number(result.rows[0]?.count ?? 0n);
  }
}
