import type { LogicalOperationRow, ReviewRequestRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';

import { computeCheckTrustBasis, parseCheckTrustBasis, type CheckTrustBasis } from './check-trust-basis.js';
import type { Repositories } from './unit-of-work.js';

/**
 * 人工批准与检查材料绑定（docs/architecture/tool-adapters.md §1.6，2026-10-09 实施）。
 *
 * 范围授权退回 ASK 时，`createGatewayReview` 会为这一次动作建一条 `ACTION_APPROVAL`。
 * 2026-10-08 后端独立验收确认的缺口是：那条 Review 的 target 只绑定动作、路径、参数与
 * 连接/策略版本，**没有绑定创建时观察到的检查材料**。于是「Review 创建后改脚本」与
 * 「批准后改脚本」都能凭同一条旧批准真实执行新脚本——材料漂移检查只保护了 AUTO 那条路。
 *
 * 本模块只补这一件事，沿既有 Owner 收口，不另建第二套授权判定：
 *   - **绑定**：prepare 用服务端自己实测到的 `CheckTrustBasis` 写进 Review target，
 *     因此它自动进入 `target_hash` 的完整性校验，也随 target 一起留在历史里可追溯。
 *   - **核对**：批准提交与最终派发准入各核对一次「此刻实测」与「Review 当时绑定」。
 *
 * 摘要的输入全部来自**已持久化的 Operation 事实**——`op.params` 里的 executable/args
 * 与受管资源的 canonical root——而不是调用方自报。因此核对结果不随调用方改变：
 * prepare、批准与派发三个点重算的是同一份依据。
 */

/** Review target 中承载检查材料依据的键名；它落在 target 内，因此受 target_hash 保护。 */
export const APPROVAL_CHECK_MATERIAL_KEY = 'check_trust_basis';

export type ApprovalMaterialVerdict =
  /** 该动作不由 `run_check` 驱动，没有检查材料这层语义（普通 CLI_RUN、文件写、Git 写等）。 */
  | { readonly status: 'NOT_APPLICABLE' }
  /** 此刻实测的材料与 Review 当时绑定的完全一致。 */
  | { readonly status: 'MATCH' }
  /** 材料已变、读不出来，或这条记录根本没有材料依据。 */
  | { readonly status: 'STALE'; readonly reason: string; readonly detail: string };

/** prepare 侧：把实测到的材料依据并入 Review target。算不出就不写——不猜、不补摘要。 */
export function approvalCheckMaterialTarget(basis: CheckTrustBasis | undefined): JsonObject {
  return basis === undefined ? {} : { [APPROVAL_CHECK_MATERIAL_KEY]: basis as unknown as JsonObject };
}

/**
 * 这次动作是否由 `run_check` 驱动。
 *
 * 用持久化的工具请求行判定，而不是看 Review 或 Operation 上有没有某个标志位：
 * `run_check` 是唯一会按冻结清单执行 CLI 的入口，它决定了「检查材料」这层语义是否存在。
 * 直接 Gateway 准备的普通 CLI_RUN（自带连接可执行入口白名单）不落这一行，因此不受影响。
 */
async function isCheckDrivenAction(repositories: Repositories,
  op: LogicalOperationRow): Promise<boolean> {
  if (op.run_id === null || op.capability_key !== 'CLI_RUN') return false;
  const toolCall = await repositories.toolCalls.readByOperation(op.run_id, op.id);
  return toolCall?.tool_name === 'run_check';
}

/** 从 Operation 自身冻结的参数重算材料依据。参数缺失或形状不合法一律按读不到处理。 */
async function observeOperationMaterial(repositories: Repositories,
  op: LogicalOperationRow): Promise<{ readonly ok: true; readonly basis: CheckTrustBasis }
  | { readonly ok: false; readonly detail: string }> {
  if (op.resource_id === null) {
    return { ok: false, detail: '该动作没有受管资源，无法确定检查材料的规范根。' };
  }
  const resource = await repositories.gateway.readResource(op.resource_id);
  if (resource === undefined) {
    return { ok: false, detail: '受管资源已不可读，无法确定检查材料的规范根。' };
  }
  const executable = op.params.executable;
  const args = op.params.args;
  if (typeof executable !== 'string' || executable === '' || !Array.isArray(args) ||
      !args.every((arg) => typeof arg === 'string')) {
    return { ok: false, detail: '动作参数里没有可证明的入口程序与参数，无法重算检查材料。' };
  }
  const observed = await computeCheckTrustBasis({ canonicalRoot: resource.canonical_root,
    executable, args });
  // 读不到就是读不到：材料被删、不可读或形态无法证明时按「依据不成立」处理，
  // 不退化成「没有材料变化」，也不在这里放宽成放行。
  return observed.ok ? { ok: true, basis: observed.basis }
    : { ok: false, detail: observed.detail };
}

/**
 * 批准提交与最终派发准入共用的核对：此刻实测的材料是否仍是 Review 当时绑定的那一份。
 *
 * 保守规则（对应 contracts/03 §5「审批动作参数、目标或内容改变 → 原批准不可用于新动作」）：
 *   - Review 缺材料依据 → STALE。历史记录不猜摘要、不自动升级为有效；合法路径是按领域
 *     入口重新确认，那会生成一条绑定当前材料的新 Review。
 *   - 材料读不出来 → STALE。无法确认与批准时一致就不是「一致」。
 *   - 摘要不同 → STALE。旧批准不能驱动新材料的真实执行。
 *
 * 历史判断本身不被抹去：这条函数只判定「旧批准还能不能驱动执行」，
 * 原 Review、原决定与原 Operation/Invocation 关系都由各自的 Owner 原样保留。
 */
export async function verifyApprovalCheckMaterial(repositories: Repositories,
  op: LogicalOperationRow, review: ReviewRequestRow): Promise<ApprovalMaterialVerdict> {
  if (!(await isCheckDrivenAction(repositories, op))) return { status: 'NOT_APPLICABLE' };
  const bound = parseCheckTrustBasis(review.target[APPROVAL_CHECK_MATERIAL_KEY]);
  if (bound === undefined) {
    return { status: 'STALE', reason: 'REVIEW_CHECK_MATERIAL_ABSENT',
      detail: '这条批准没有绑定检查材料依据，无法确认它审阅的是当前磁盘上的材料；请重新发起确认。' };
  }
  const observed = await observeOperationMaterial(repositories, op);
  if (!observed.ok) {
    return { status: 'STALE', reason: 'REVIEW_CHECK_MATERIAL_UNREADABLE', detail: observed.detail };
  }
  if (observed.basis.digest !== bound.digest) {
    return { status: 'STALE', reason: 'REVIEW_CHECK_MATERIAL_CHANGED',
      detail: '检查材料在批准之后已经改变，原批准不能驱动新的真实执行；请针对当前材料重新确认。' };
  }
  return { status: 'MATCH' };
}
