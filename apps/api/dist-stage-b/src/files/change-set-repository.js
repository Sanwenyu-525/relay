import { sql } from 'kysely';
import { canonicalRelativePath } from './file-changeset.js';
import { requireRow } from '../shared/sql-rows.js';
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
/** 只接受真正的 SHA-256（统一小写）。「看起来像 hash」的值不能充当证据。 */
function sha(value) {
    return typeof value === 'string' && SHA256_PATTERN.test(value) ? value.toLowerCase() : null;
}
function reason(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed === '' ? null : trimmed;
}
/**
 * 落库前的最后一道证据守卫：状态与摘要必须自洽，否则按「未证实」如实降级记录。
 * 目的是让结算事务不会因为一条可疑的逐文件声明整体失败——账本缺项还能核对，
 * 半途异常会连带丢失 invocation 的结果事实。降级只影响账本表述，不改 Gateway 业务判定。
 */
function guardFile(root, file) {
    const baseline = sha(file.baseline_sha256);
    const target = file.action === 'DELETE' ? null : sha(file.target_sha256);
    const actual = sha(file.actual_sha256);
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
    if (status !== 'APPLIED')
        error = error ?? 'REASON_NOT_RECORDED';
    return {
        relative_path: canonicalRelativePath(root, file.relative_path), action: file.action,
        baseline_sha256: baseline, observed_baseline_sha256: sha(file.observed_baseline_sha256),
        target_sha256: target,
        actual_sha256: file.action === 'DELETE' && status === 'APPLIED' ? null : actual,
        status, error, diff_ref: file.diff_ref,
    };
}
export class ChangeSetRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    /** 账本头按 invocation 幂等落位；已存在时只回到同一行更新汇总字段。 */
    async upsertHeader(header, id, fileCount, status, evidenceSource) {
        const result = await sql `
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
    async insertMissingFiles(changeSetId, invocationId, canonicalRoot, files) {
        for (const file of files.map((item) => guardFile(canonicalRoot, item))) {
            await sql `
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
    async fileSummary(changeSetId) {
        const result = await sql `
      select count(*)::integer as total,
        count(*) filter (where status <> 'APPLIED')::integer as unapplied
      from change_set_files where change_set_id = ${changeSetId}
    `.execute(this.db);
        return result.rows[0] ?? { total: 0, unapplied: 0 };
    }
    /**
     * 执行结算：把 executeFileChangeset 的逐文件结果固化为账本。
     * 整体状态由用例决定——全部落盘 SUCCEEDED、存在冲突/失败 PARTIAL（部分应用不整体成功）、
     * 结果无法归属本次调用时 UNKNOWN。
     */
    async recordExecution(header, id, files, status) {
        const changeSetId = await this.upsertHeader(header, id, files.length, status, 'EXECUTION');
        await this.insertMissingFiles(changeSetId, header.invocation_id, header.canonical_root, files);
        const summary = await this.fileSummary(changeSetId);
        const changeSet = await this.readById(changeSetId);
        if (changeSet === undefined)
            throw new Error('change set row missing after execution settle');
        const proven = summary.total === files.length && summary.total === changeSet.file_count && summary.unapplied === 0;
        const finalStatus = status === 'SUCCEEDED' && !proven ? 'PARTIAL' : status;
        if (finalStatus === changeSet.status)
            return changeSet;
        const result = await sql `
      update change_sets set status = ${finalStatus}, updated_at = now()
      where id = ${changeSetId} returning *
    `.execute(this.db);
        return requireRow(result.rows, 'settle executed change set');
    }
    /**
     * 恢复核对：按 invocation 回到同一份账本（崩溃于结算之前则由此处新建），补记执行阶段
     * 缺失的逐文件观测，并把整体状态收敛为 SUCCEEDED、已证实的 PARTIAL 或 UNKNOWN。
     * 完整成功要求逐项匹配；首次建账的 PARTIAL 还要求原执行回执中的已应用项和冲突项
     * 均与回读一致。已有 UNKNOWN 逐文件行不可改写，不靠后到观察升级汇总状态。
     */
    async recordReconciliation(header, id, files, confirmed, confirmedPartial) {
        const previous = await this.readByInvocation(header.invocation_id);
        // A complete execution report already fixed the per-file PARTIAL facts.
        // Later disk observations cannot rewrite that historical outcome to UNKNOWN.
        if (previous?.status === 'PARTIAL')
            return previous;
        const changeSetId = await this.upsertHeader(header, id, files.length, 'UNKNOWN', 'RECONCILIATION');
        await this.insertMissingFiles(changeSetId, header.invocation_id, header.canonical_root, files);
        const summary = await this.fileSummary(changeSetId);
        const changeSet = await this.readById(changeSetId);
        if (changeSet === undefined)
            throw new Error('change set row missing after reconciliation settle');
        const complete = summary.total === files.length && summary.total === changeSet.file_count;
        // A durable partial adapter receipt plus matching rereads may establish the
        // first ledger. Existing UNKNOWN rows remain immutable and cannot be upgraded
        // by changing only the header after a later observation.
        const status = confirmed && complete && summary.unapplied === 0
            ? 'SUCCEEDED'
            : confirmedPartial && previous === undefined && complete && summary.unapplied > 0 &&
                summary.unapplied < summary.total ? 'PARTIAL' : 'UNKNOWN';
        const result = await sql `
      update change_sets set status = ${status}, evidence_source = 'RECONCILIATION',
        updated_at = now() where id = ${changeSetId} returning *
    `.execute(this.db);
        return requireRow(result.rows, 'settle reconciled change set');
    }
    async readById(id) {
        return (await sql `select * from change_sets where id = ${id}`.execute(this.db)).rows[0];
    }
    async readByInvocation(invocationId) {
        return (await sql `select * from change_sets where invocation_id = ${invocationId}`
            .execute(this.db)).rows[0];
    }
    async listByOperation(operationId) {
        return (await sql `select * from change_sets where operation_id = ${operationId}
      order by created_at, id`.execute(this.db)).rows;
    }
    async listFiles(changeSetId) {
        return (await sql `select * from change_set_files where change_set_id = ${changeSetId}
      order by relative_path`.execute(this.db)).rows;
    }
    /** 按 invocation 读回账本及其逐文件行（恢复核对与后续 UI 的同一入口）。 */
    async readLedgerByInvocation(invocationId) {
        const changeSet = await this.readByInvocation(invocationId);
        if (changeSet === undefined)
            return undefined;
        return { changeSet, files: await this.listFiles(changeSet.id) };
    }
    /** 幂等断言用：同一 invocation 至多一份账本头。 */
    async countByInvocation(invocationId) {
        const result = await sql `
      select count(*)::bigint as count from change_sets where invocation_id = ${invocationId}
    `.execute(this.db);
        return Number(result.rows[0]?.count ?? 0n);
    }
}
