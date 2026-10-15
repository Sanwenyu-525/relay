import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { requireRow } from '../shared/sql-rows.js';
import { parseCheckTrustBasis } from './check-trust-basis.js';
import { canonicalResourceIdentity } from './gateway-configuration.js';
/**
 * 本次任务范围授权（docs/architecture/tool-adapters.md §1.2）。
 *
 * 授权与单动作 ACTION_APPROVAL 是两个对象：授权只回答「本次 Run 内这类动作是否可 AUTO」，
 * 批准仍然绑定确切动作与参数。因此本模块只做一件事——按当前数据库事实判断某个
 * 具体动作是否被**当前有效**的授权覆盖；判断依据完全来自持久化的授权行，
 * 模型、工具参数和 UI 都不参与。
 *
 * 授权失效条件全部在这里收口，且 prepare 与 admit 调用的是同一个函数：
 * 已撤销、已过期、Run 已终止、根身份已变、动作不在集合内、检查配置摘要已变——
 * 任一条成立都不放行，回落到既有 Permission 判定（ASK/DENY）。
 */
/**
 * 首批免单动作审批的动作。删除与 Git 写入按产品规则不在其中。
 *
 * 检查统一用 `CLI_RUN` 而不是 `RUN_TEST` / `RUN_BUILD`：工具循环里模型只能按 check_id
 * 点名冻结清单中的某一次检查，「测什么、构建什么」的粒度已经由那份清单本身决定，
 * 授权再按动作名区分只会造出模型无法对应、也无法核对的口径。
 */
export const SCOPE_GRANT_ACTIONS = ['WRITE_FILE', 'APPLY_CHANGESET', 'CLI_RUN'];
/** 授权动作 → Gateway 能力。信封里没有对应连接时不能放行该动作。 */
export const SCOPE_GRANT_ACTION_CAPABILITIES = {
    WRITE_FILE: 'FILE_WRITE', APPLY_CHANGESET: 'FILE_WRITE', CLI_RUN: 'CLI_RUN',
};
/** run_scope_grants 的唯一 SQL Owner；授权边界写入后不可改写，只有撤销可推进。 */
export class RunScopeGrantRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insert(input, db = this.db) {
        const checks = input.checks;
        const boundaryDigest = createHash('sha256').update(canonicalizeJson({
            resource_id: input.resourceId,
            root_identity: canonicalResourceIdentity(input.canonicalRoot),
            allowed_actions: [...input.allowedActions],
            checks: input.checks.map((check) => ({ ...check, args: [...check.args] })),
        }), 'utf8').digest('hex');
        const result = await sql `
      insert into run_scope_grants
        (id, workspace_id, project_id, run_id, task_id, resource_id, version, root_identity,
         allowed_actions, checks, boundary_digest, expires_at, survives_run_terminal)
      values (${randomUUID()}, ${input.workspaceId}, ${input.projectId}, ${input.runId},
        ${input.taskId}, ${input.resourceId}, 1,
        ${canonicalResourceIdentity(input.canonicalRoot)}, ${input.allowedActions},
        ${JSON.stringify(checks)}::jsonb, ${boundaryDigest},
        ${input.expiresAt ?? null}, ${input.survivesRunTerminal === true})
      returning *
    `.execute(db);
        return requireRow(result.rows, 'insert run scope grant');
    }
    async readByRun(runId, db = this.db) {
        return (await sql `select * from run_scope_grants
      where run_id = ${runId}`.execute(db)).rows[0];
    }
    /** 撤销是审计事实：只推进撤销时间与原因，不触碰任何边界列。 */
    async revoke(runId, reason, db = this.db) {
        const result = await sql `update run_scope_grants
      set revoked_at = clock_timestamp(), revoked_reason = ${reason},
          revision = revision + 1, updated_at = clock_timestamp()
      where run_id = ${runId} and revoked_at is null
      returning id`.execute(db);
        return result.rows.length === 1;
    }
}
/**
 * 判断一次具体动作是否被当前有效授权覆盖。
 *
 * 明确不做的事：不看模型说了什么，不看 UI 传了什么，也不改全局
 * `approvalPassthrough`。判定只用授权行与当前实际事实，因此 prepare 与 admit
 * 调用它必然得到同一结论——除非期间事实真的变了（撤销、过期、根被换、脚本被改），
 * 那本来就应当重新判定。
 */
export async function evaluateScopeGrant(db, input) {
    const grant = await new RunScopeGrantRepository(db).readByRun(input.runId);
    if (grant === undefined)
        return { covered: false, reason: 'SCOPE_GRANT_ABSENT' };
    if (grant.revoked_at !== null)
        return { covered: false, reason: 'SCOPE_GRANT_REVOKED' };
    if (grant.expires_at !== null && grant.expires_at.getTime() <= Date.now()) {
        return { covered: false, reason: 'SCOPE_GRANT_EXPIRED' };
    }
    if (input.runTerminal && !grant.survives_run_terminal) {
        return { covered: false, reason: 'SCOPE_GRANT_RUN_TERMINAL' };
    }
    // 根身份按物理规范值比对：路径相同但已被整体替换时不再适用。
    if (grant.root_identity !== canonicalResourceIdentity(input.canonicalRoot)) {
        return { covered: false, reason: 'SCOPE_GRANT_ROOT_CHANGED' };
    }
    if (!grant.allowed_actions.includes(input.actionType)) {
        return { covered: false, reason: 'SCOPE_GRANT_ACTION_NOT_ALLOWED' };
    }
    // 删除不可被一次授权带走：即使 APPLY_CHANGESET 已放行，含删除的声明仍退回单动作确认。
    if (input.containsDelete === true) {
        return { covered: false, reason: 'SCOPE_GRANT_DELETE_REQUIRES_APPROVAL' };
    }
    if (input.capability === 'CLI_RUN') {
        if (input.check === undefined)
            return { covered: false, reason: 'SCOPE_GRANT_CHECK_UNKNOWN' };
        if (input.check.executable_sha256 !== input.observedExecutableSha256) {
            // 脚本或构建配置在授权之后被改过：原信任依据不成立，退回人工判断。
            return { covered: false, reason: 'SCOPE_GRANT_CHECK_CHANGED' };
        }
        const frozenTrust = input.check.trust_basis;
        if (frozenTrust === undefined) {
            // 历史授权只冻结了入口摘要，没有材料依据：无法确认当前材料与批准时一致，
            // 按「依据不完整」退回人工确认，而不是当成摘要相同放行。
            return { covered: false, reason: 'SCOPE_GRANT_CHECK_CHANGED' };
        }
        if (frozenTrust.digest !== input.observedTrustDigest) {
            // 入口未变，但被参数引用的检查脚本或构建/测试配置变了：同一 check_id 不能沿用原批准。
            return { covered: false, reason: 'SCOPE_GRANT_CHECK_CHANGED' };
        }
    }
    return { covered: true };
}
/** 解析冻结检查清单：模型只能按 id 点名，不能自带 executable/args。 */
export function resolveFrozenCheck(grant, checkId) {
    if (grant === undefined || !Array.isArray(grant.checks))
        return undefined;
    const found = grant.checks.find((entry) => typeof entry === 'object' && entry !== null &&
        !Array.isArray(entry) && entry.id === checkId);
    if (found === undefined)
        return undefined;
    const check = found;
    if (typeof check.executable !== 'string' || check.executable === '' ||
        typeof check.executable_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(check.executable_sha256) ||
        !Array.isArray(check.args) || !check.args.every((arg) => typeof arg === 'string')) {
        return undefined;
    }
    const trustBasis = check.trust_basis === undefined
        ? undefined : parseCheckTrustBasis(check.trust_basis);
    // 形状不合法的信任摘要不能被当成「没有摘要」静默忽略：那份检查直接判为不可解析。
    if (check.trust_basis !== undefined && trustBasis === undefined)
        return undefined;
    return { id: checkId, executable: check.executable, args: check.args,
        executable_sha256: check.executable_sha256,
        ...(trustBasis === undefined ? {} : { trust_basis: trustBasis }),
        ...(typeof check.max_output_bytes === 'number' ? { max_output_bytes: check.max_output_bytes } : {}) };
}
