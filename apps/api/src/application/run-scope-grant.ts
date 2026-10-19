import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import type { GatewayCapability, RunScopeGrantRow } from '../infrastructure/database-schema.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { requireRow } from '../shared/sql-rows.js';
import type { CheckTrustBasis } from './check-trust-basis.js';
import { parseCheckTrustBasis, computeCheckTrustBasis, CHECK_TRUST_REASON } from './check-trust-basis.js';
import { invalidTransition } from './domain-error.js';
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
 *
 * 0092: `COMPUTER_INPUT` 是同一纪律下的一个动作类——桌面输入（点击/输入/快捷键等
 * 八种逻辑动作）在授权层合成一类，与 CLI_RUN 同理：授权回答「本次任务是否可以操作
 * 电脑」，不替用户决定每一次点击。读取类（截图/窗口枚举）本就不需要授权。
 */
export const SCOPE_GRANT_ACTIONS: readonly string[] =
  ['WRITE_FILE', 'APPLY_CHANGESET', 'CLI_RUN', 'COMPUTER_INPUT', 'BROWSER_ACTION'];

/** 授权动作 → Gateway 能力。信封里没有对应连接时不能放行该动作。 */
export const SCOPE_GRANT_ACTION_CAPABILITIES: Readonly<Record<string, GatewayCapability>> = {
  WRITE_FILE: 'FILE_WRITE', APPLY_CHANGESET: 'FILE_WRITE', CLI_RUN: 'CLI_RUN',
  COMPUTER_INPUT: 'COMPUTER_INPUT',
  // 0105: 只放行普通网页交互。BROWSER_COMMIT（提交表单、上传文件）**故意不在此表**——
  // 它们是不可逆外部效果，只能逐次单动作批准，任何范围授权都覆盖不到。
  BROWSER_ACTION: 'BROWSER_ACTION',
};

/** 浏览器交互类逻辑动作 → 授权层的同一动作类名。 */
const BROWSER_ACTION_ACTIONS: ReadonlySet<string> = new Set([
  'BROWSER_NEW_PAGE', 'BROWSER_NAVIGATE', 'BROWSER_CLICK',
  'BROWSER_FILL', 'BROWSER_PRESS_KEY', 'BROWSER_CLOSE_PAGE',
]);

/** Computer 输入类逻辑动作 → 授权层的同一动作类名。 */
const COMPUTER_INPUT_ACTIONS: ReadonlySet<string> = new Set([
  'COMPUTER_ACTIVATE_WINDOW', 'COMPUTER_MOVE', 'COMPUTER_CLICK', 'COMPUTER_DOUBLE_CLICK',
  'COMPUTER_SCROLL', 'COMPUTER_DRAG', 'COMPUTER_TYPE', 'COMPUTER_KEYPRESS', 'COMPUTER_HOTKEY',
]);

/**
 * 授权判定用的动作名：Computer 输入动作合成一类，其余原样返回。
 *
 * 收敛到这一个函数，避免 prepare 与 admit 两处各写一份映射而漂移——授权语义
 * 漂移的后果是「授权时放行、派发时退回」，用户看到的行为不可解释。
 */
export function scopeGrantActionFor(actionType: string): string {
  if (COMPUTER_INPUT_ACTIONS.has(actionType)) return 'COMPUTER_INPUT';
  // 0105: 六个交互动作在授权层合成一类，与 COMPUTER_INPUT 同理：授权回答
  // 「本次任务是否可以操作网页」，不替用户决定每一次点击。
  if (BROWSER_ACTION_ACTIONS.has(actionType)) return 'BROWSER_ACTION';
  return actionType;
}

export interface FrozenCheck {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly max_output_bytes?: number;
  /** 可执行程序（或脚本入口）的内容摘要；变化后原授权不再适用。 */
  readonly executable_sha256: string;
  /** 检查入口信任摘要：入口脚本 + 被引用脚本 + 直接决定检查行为的构建/测试配置。 */
  readonly trust_basis?: CheckTrustBasis | undefined;
}

/** 原 Delegate 与任务链共用检查冻结；已有信任依据只核对，不静默换成新脚本。 */
export async function freezeScopeChecks(canonicalRoot: string, checks: readonly FrozenCheck[],
  taskId: string): Promise<readonly FrozenCheck[]> {
  const ids = new Set<string>();
  const enriched: FrozenCheck[] = [];
  for (const check of checks) {
    if (check.id === '' || ids.has(check.id) || check.executable === '' ||
        !/^[0-9a-f]{64}$/.test(check.executable_sha256) ||
        check.max_output_bytes !== undefined &&
          (check.max_output_bytes < 1 || check.max_output_bytes > 1048576)) {
      throw invalidTransition(`scope_grant 的已配置检查 ${check.id || '(空)'} 不合法。`, { taskId });
    }
    ids.add(check.id);
    const trust = await computeCheckTrustBasis({ canonicalRoot,
      executable: check.executable, args: check.args });
    if (!trust.ok) {
      const hint = trust.reason === CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED
        ? '它用了内联求值、shell 组合或通配符，无法证明执行范围，请改成对单一脚本文件的直接调用。'
        : '请确认入口脚本与参数引用的脚本都在磁盘上可读。';
      throw invalidTransition(`无法冻结检查 ${check.id} 的可信依据（${trust.reason}）：${trust.detail}${hint}`, { taskId });
    }
    if (check.trust_basis !== undefined && check.trust_basis.digest !== trust.basis.digest) {
      throw invalidTransition(`检查 ${check.id} 的材料已变化，请重新圈定。`, { taskId });
    }
    enriched.push({ ...check, trust_basis: trust.basis });
  }
  return enriched;
}

export interface CreateScopeGrantInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly resourceId: string;
  readonly canonicalRoot: string;
  readonly allowedActions: readonly string[];
  readonly checks: readonly FrozenCheck[];
  readonly expiresAt?: Date | null;
  readonly survivesRunTerminal?: boolean;
}

export interface ScopeGrantDecision {
  readonly covered: boolean;
  /** 不放行时的稳定原因，便于 UI 与审计区分「撤销 / 过期 / 根已变 / 动作不在授权内」。 */
  readonly reason?: string;
}

/** run_scope_grants 的唯一 SQL Owner；授权边界写入后不可改写，只有撤销可推进。 */
export class RunScopeGrantRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(input: CreateScopeGrantInput, db: DbExecutor = this.db): Promise<RunScopeGrantRow> {
    const checks = input.checks as unknown as JsonValue;
    const boundaryDigest = createHash('sha256').update(canonicalizeJson({
      resource_id: input.resourceId,
      root_identity: canonicalResourceIdentity(input.canonicalRoot),
      allowed_actions: [...input.allowedActions],
      checks: input.checks.map((check) => ({ ...check, args: [...check.args] })),
    } as unknown as JsonObject), 'utf8').digest('hex');
    const result = await sql<RunScopeGrantRow>`
      insert into run_scope_grants
        (id, workspace_id, project_id, run_id, task_id, resource_id, version, root_identity,
         allowed_actions, checks, boundary_digest, expires_at, survives_run_terminal)
      values (${randomUUID()}, ${input.workspaceId}, ${input.projectId}, ${input.runId},
        ${input.taskId}, ${input.resourceId}, 1,
        ${canonicalResourceIdentity(input.canonicalRoot)}, ${input.allowedActions as never},
        ${JSON.stringify(checks)}::jsonb, ${boundaryDigest},
        ${input.expiresAt ?? null}, ${input.survivesRunTerminal === true})
      returning *
    `.execute(db);
    return requireRow(result.rows, 'insert run scope grant');
  }

  async readByRun(runId: string, db: DbExecutor = this.db): Promise<RunScopeGrantRow | undefined> {
    return (await sql<RunScopeGrantRow>`select * from run_scope_grants
      where run_id = ${runId}`.execute(db)).rows[0];
  }

  /** 撤销是审计事实：只推进撤销时间与原因，不触碰任何边界列。 */
  async revoke(runId: string, reason: string, db: DbExecutor = this.db): Promise<boolean> {
    const result = await sql<{ id: string }>`update run_scope_grants
      set revoked_at = clock_timestamp(), revoked_reason = ${reason},
          revision = revision + 1, updated_at = clock_timestamp()
      where run_id = ${runId} and revoked_at is null
      returning id`.execute(db);
    return result.rows.length === 1;
  }
}

export interface EvaluateScopeGrantInput {
  readonly runId: string;
  readonly actionType: string;
  readonly capability: GatewayCapability;
  readonly canonicalRoot: string;
  /** RUN 状态；终态 Run 不再放行自动动作，除非授权显式声明跨终态有效。 */
  readonly runTerminal: boolean;
  /** RUN_TEST / RUN_BUILD 解析出的冻结检查；用于比对程序与配置摘要。 */
  readonly check?: FrozenCheck | undefined;
  /** 派发时实测到的可执行程序摘要；与冻结值不同即视为配置已变。 */
  readonly observedExecutableSha256?: string | undefined;
  /** 派发时实测到的信任摘要；与冻结值不同即视为检查材料已变。 */
  readonly observedTrustDigest?: string | undefined;
  /** 本次变化集是否含删除。删除永远需要单动作确认，授权不能豁免。 */
  readonly containsDelete?: boolean | undefined;
}

/**
 * 判断一次具体动作是否被当前有效授权覆盖。
 *
 * 明确不做的事：不看模型说了什么，不看 UI 传了什么，也不改全局
 * `approvalPassthrough`。判定只用授权行与当前实际事实，因此 prepare 与 admit
 * 调用它必然得到同一结论——除非期间事实真的变了（撤销、过期、根被换、脚本被改），
 * 那本来就应当重新判定。
 */
export async function evaluateScopeGrant(db: DbExecutor,
  input: EvaluateScopeGrantInput): Promise<ScopeGrantDecision> {
  const grant = await new RunScopeGrantRepository(db).readByRun(input.runId);
  if (grant === undefined) return { covered: false, reason: 'SCOPE_GRANT_ABSENT' };
  if (grant.revoked_at !== null) return { covered: false, reason: 'SCOPE_GRANT_REVOKED' };
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
    if (input.check === undefined) return { covered: false, reason: 'SCOPE_GRANT_CHECK_UNKNOWN' };
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
export function resolveFrozenCheck(grant: RunScopeGrantRow | undefined,
  checkId: string): FrozenCheck | undefined {
  if (grant === undefined || !Array.isArray(grant.checks)) return undefined;
  const found = grant.checks.find((entry) => typeof entry === 'object' && entry !== null &&
    !Array.isArray(entry) && (entry as JsonObject).id === checkId);
  if (found === undefined) return undefined;
  const check = found as JsonObject;
  if (typeof check.executable !== 'string' || check.executable === '' ||
      typeof check.executable_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(check.executable_sha256) ||
      !Array.isArray(check.args) || !check.args.every((arg) => typeof arg === 'string')) {
    return undefined;
  }
  const trustBasis = check.trust_basis === undefined
    ? undefined : parseCheckTrustBasis(check.trust_basis);
  // 形状不合法的信任摘要不能被当成「没有摘要」静默忽略：那份检查直接判为不可解析。
  if (check.trust_basis !== undefined && trustBasis === undefined) return undefined;
  return { id: checkId, executable: check.executable, args: check.args as readonly string[],
    executable_sha256: check.executable_sha256,
    ...(trustBasis === undefined ? {} : { trust_basis: trustBasis }),
    ...(typeof check.max_output_bytes === 'number' ? { max_output_bytes: check.max_output_bytes } : {}) };
}
