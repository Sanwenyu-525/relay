import { createHash } from 'node:crypto';

import { toDecimalString } from '../shared/decimal.js';
import type {
  AssistMessageRow, AssistSessionRow, LearningConceptRow, LearningEvidenceRow,
  LearningRoundRow,
} from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { httpCommandScopeKey } from './actor.js';
import {
  runIdempotentCommand, type CommandOutcome,
} from './command.js';
import { DomainError, resourceNotFound, validationFailed } from './domain-error.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';

/**
 * 学习记录应用用例（0072，ADR-020）。
 *
 * 这是**个人学习记录的唯一逻辑写入 Owner**：UI、Agent 与查询路径都不能绕过这里
 * 直接写 `learning_*`，也不在 `assist_*` 业务列上维护第二份学习状态。
 *
 * 三条必须可核对的口径（提示词 §5、§8、§9）：
 *   1. 讲解过、用户自述、实际表现、具体缺口分别落成**性质不同**的证据行，
 *      跳过与无实质回答不产生任何升级或降级。
 *   2. 结算只能落在仍 PENDING 且代次未变的轮次上；清除或纠正后旧轮次无写入资格。
 *   3. 「本次不记录」由应用保存与校验，模型返回增量也**不写**；不由模型提示决定。
 */

/** 模型可提出的有限操作。语义见 ADR-020 §4。 */
export type LearningIncrementOp =
  | 'EXPOSE' | 'SELF_REPORT' | 'OBSERVE' | 'GAP' | 'CORRECT' | 'RESOLVE_REVIEW';

const INCREMENT_OPS: readonly LearningIncrementOp[] = [
  'EXPOSE', 'SELF_REPORT', 'OBSERVE', 'GAP', 'CORRECT', 'RESOLVE_REVIEW',
];

/** 一条候选增量。信封里**没有**存储路径、项目命令、SQL 或全量档案替换。 */
export interface LearningIncrement {
  readonly op: LearningIncrementOp;
  readonly topic: string;
  /** 用户可见名，用于解析或新建知识点。 */
  readonly concept: string;
  /** 可选稳定标识；给出时按它精确解析，不匹配不猜。 */
  readonly concept_slug?: string | undefined;
  readonly scenario: string;
  readonly detail: string;
  /**
   * 依据引用（ADR-020 §5.3）：必须指向**本轮**的一条消息。应用校验它存在、属于本轮
   * 且与候选性质相符——不把「模型自称引用了什么」当作依据；缺引用、跨轮、跨会话或
   * 用助手消息冒充用户发言都按类型化原因拒绝。
   */
  readonly source_message_id: string;
}

const MAX_INCREMENTS_PER_ROUND = 12;
const MAX_DETAIL_CHARS = 400;
const MAX_SCENARIO_CHARS = 200;
const MAX_TOPIC_CHARS = 80;
const MAX_CONCEPT_CHARS = 80;
/**
 * 冻结基线里的身份分区键（R4）。轮次开始时既有知识点的 `slug → generation` 存在这个
 * 保留键下；顶层仍是 `concept_id → generation`，与既有读取形状兼容。
 */
const IDENTITY_BASELINE_KEY = '$identities';
/** 依据引用必须是 UUID 形状；不接受「/」或其他任意串充当来源。 */
const SOURCE_MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// ── 类型化错误 ────────────────────────────────────────────────────────────────

function learningError(input: {
  readonly code: string; readonly status: number; readonly type: string;
  readonly title: string; readonly detail: string;
  readonly retryable?: boolean;
  readonly retryAction?: 'NONE' | 'REFRESH_AND_REDECIDE' | 'POLL_RESOURCE' | 'CHECK_RECEIPT_THEN_RETRY';
  readonly conflict?: JsonObject;
}): DomainError {
  return new DomainError({
    code: input.code,
    status: input.status,
    type: input.type,
    title: input.title,
    detail: input.detail,
    retryable: input.retryable ?? false,
    retryAction: input.retryAction ?? 'NONE',
    ...(input.conflict === undefined ? {} : { conflict: input.conflict }),
  });
}

/** 非学习身份提交学习写命令：普通助手与 Agent 会话都不获得这项能力。 */
export function learningSessionRequired(detail: string): DomainError {
  return learningError({ code: 'LEARNING_SESSION_REQUIRED', status: 409,
    type: '/problems/learning-session-required', title: '该会话不是学习身份',
    detail, retryAction: 'REFRESH_AND_REDECIDE' });
}

/** 本轮或该会话已关闭记录：模型仍返回增量时应用拒绝写入。 */
export function learningRecordDisabled(): DomainError {
  return learningError({ code: 'LEARNING_RECORD_DISABLED', status: 409,
    type: '/problems/learning-record-disabled', title: '本次不记录',
    detail: '本轮学习记录已关闭，增量不会写入；如需记录请在界面上重新开启。',
    retryAction: 'REFRESH_AND_REDECIDE' });
}

/** 轮次不存在、已结算或已随清除消失：旧 worker 不再有写入资格。 */
export function learningRoundUnavailable(detail: string): DomainError {
  return learningError({ code: 'LEARNING_ROUND_UNAVAILABLE', status: 409,
    type: '/problems/learning-round-unavailable', title: '该轮次不可结算',
    detail, retryAction: 'CHECK_RECEIPT_THEN_RETRY' });
}

/** 冻结代次落后：清除或纠正使这一轮无写入资格；明确哪些增量未应用。 */
export function learningRoundStale(detail: string, conflict?: JsonObject): DomainError {
  return learningError({ code: 'LEARNING_ROUND_STALE', status: 409,
    type: '/problems/learning-round-stale', title: '这一轮的依据已过期',
    detail, retryAction: 'REFRESH_AND_REDECIDE', ...(conflict === undefined ? {} : { conflict }) });
}

/** 候选不合法：形状、越权字段或依据引用不属于本轮。 */
export function learningIncrementRejected(field: string, detail: string): DomainError {
  return new DomainError({
    code: 'LEARNING_INCREMENT_REJECTED', status: 422,
    type: '/problems/learning-increment-rejected', title: '学习增量未通过校验',
    detail, retryable: false, retryAction: 'NONE',
    fieldErrors: [{ field, message: detail }],
  });
}

/**
 * 依据引用不合法（ADR-020 §12 的 LEARNING_EVIDENCE_REF_INVALID）：
 * 引用缺失/不存在、不属于本轮、与候选性质不符，或本轮没有可依据的真实用户输入。
 */
export function learningEvidenceRefInvalid(field: string, detail: string): DomainError {
  return new DomainError({
    code: 'LEARNING_EVIDENCE_REF_INVALID', status: 422,
    type: '/problems/learning-evidence-ref-invalid', title: '学习增量缺少可核对的依据',
    detail, retryable: false, retryAction: 'NONE',
    fieldErrors: [{ field, message: detail }],
  });
}

/** 领取身份已失效（租约过期/消息被收敛/取消先提交）：本 Worker 无权结算本轮。 */
export function learningRoundControlLost(detail: string, reason: string): DomainError {
  return learningError({ code: 'LEARNING_ROUND_UNAVAILABLE', status: 409,
    type: '/problems/learning-round-unavailable', title: '该轮次不可结算',
    detail, retryAction: 'CHECK_RECEIPT_THEN_RETRY', conflict: { reason } });
}

/** 无法可靠确定同一概念：保留区分或要求澄清，不靠模型猜测合并。 */
export function learningConceptAmbiguous(detail: string): DomainError {
  return learningError({ code: 'LEARNING_CONCEPT_AMBIGUOUS', status: 409,
    type: '/problems/learning-concept-ambiguous', title: '知识点身份不唯一',
    detail, retryAction: 'REFRESH_AND_REDECIDE' });
}

/**
 * 读取学习结算错误携带的控制原因（'LEASE_LOST' / 'LEARNING_ROUND_CANCELLED'）。
 * runner 据此把迟到的生成收敛成 DISCARDED/CANCELLED，而不是当成普通校验失败。
 */
export function learningControlReason(error: unknown): string | null {
  if (!(error instanceof DomainError)) return null;
  if (error.conflict === undefined || error.conflict === null) return null;
  const reason = (error.conflict as Record<string, unknown>)['reason'];
  return typeof reason === 'string' ? reason : null;
}

// ── 知识点解析 ────────────────────────────────────────────────────────────────

/**
 * 稳定标识规范化：确定性、可测试，不做语义近似。
 * 中文不做大小写处理，空白折叠成单个连字符，避免「同一概念两种写法」。
 */
export function normalizeConceptSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/gu, '-');
}

/**
 * 解析或新建知识点。
 *
 * 解析顺序固定：显式 slug → 规范化名 slug → 别名精确命中 → 新建。
 * 显式 slug 未命中、但名称命中了**另一个** slug 的概念时按歧义拒绝——
 * 这比静默合并到错误概念诚实，也比每轮新建一个重复概念正确。
 */
export async function resolveLearningConcept(repositories: Repositories, input: {
  readonly workspaceId: string; readonly topic: string; readonly concept: string;
  readonly conceptSlug?: string | undefined;
  /** false 时只解析已存在的知识点，不新建——避免为「解除待复核」这类操作预建空知识点。 */
  readonly createIfMissing?: boolean | undefined;
}): Promise<LearningConceptRow | undefined> {
  const explicit = input.conceptSlug === undefined ? undefined : normalizeConceptSlug(input.conceptSlug);
  const derived = normalizeConceptSlug(input.concept);

  const byExplicit = explicit === undefined ? undefined
    : await repositories.learning.findConceptBySlug(input.workspaceId, explicit);
  if (byExplicit !== undefined) return byExplicit;

  const byName = await repositories.learning.findConceptBySlug(input.workspaceId, derived);
  if (byName !== undefined) {
    if (explicit !== undefined && explicit !== derived) {
      throw learningConceptAmbiguous(
        `「${input.concept}」按名称命中知识点 ${byName.display_name}，但给出的稳定标识 ${explicit} 对应另一个概念；请先确认要更新哪一个。`);
    }
    return byName;
  }

  const byAlias = await repositories.learning.findConceptByAlias(input.workspaceId, input.concept);
  if (byAlias !== undefined) {
    if (explicit !== undefined && explicit !== byAlias.slug) {
      throw learningConceptAmbiguous(
        `「${input.concept}」命中知识点 ${byAlias.display_name} 的别名，但稳定标识 ${explicit} 与它不一致；请先确认要更新哪一个。`);
    }
    return byAlias;
  }

  if (input.createIfMissing === false) return undefined;

  return repositories.learning.insertConcept({
    workspaceId: input.workspaceId, topic: input.topic,
    slug: explicit ?? derived, displayName: input.concept, aliases: [],
  });
}

// ── 轮次：调用模型前冻结依据 ──────────────────────────────────────────────────

export interface BeginLearningRoundInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly messageId: string;
  /** 本轮是否允许记录（消息级开关 ∧ 会话级开关）；false 时模型返回增量也不写。 */
  readonly recordEnabled: boolean;
}

/**
 * 在**调用模型之前**的 claim 事务内建立本轮结算依据。
 *
 * 冻结内容：当前清除代次，以及本 workspace **全部既有知识点**的代次。范围不能只取
 * 「最近 20 条证据涉及的知识点」——那会把更早的知识点解释成「无限制写入」，删除它们
 * 的证据后旧轮次照样复活（R4）。不在冻结表里的既有知识点说明它产生于本轮开始之后，
 * 结算时对未冻结既有目标保守拒绝；本轮新建的知识点按创建规则独立可核验。
 */
export async function beginLearningRound(db: DbExecutor, input: BeginLearningRoundInput): Promise<void> {
  await withTransaction(db, (repositories) => beginLearningRoundInTransaction(repositories, input));
}

/**
 * 在既有事务内建立本轮结算依据。
 *
 * runner 在**领取消息的同一个事务**里调用它，因此「消息已被领取」与「本轮依据已冻结」
 * 要么一起成立、要么一起不存在——不会出现领到消息却没有依据的中间态。
 */
export async function beginLearningRoundInTransaction(repositories: Repositories,
  input: BeginLearningRoundInput): Promise<void> {
  const existing = await repositories.learning.readRoundByMessage(input.messageId);
  if (existing !== undefined) return;
  const epoch = await repositories.learning.readEpoch(input.workspaceId);
  const concepts = await repositories.learning.listConcepts(input.workspaceId);
  const generations: Record<string, string> = {};
  const identities: Record<string, string> = {};
  for (const concept of concepts) {
    generations[concept.id] = toDecimalString(concept.generation);
    // 同一身份（slug）在轮次开始时是否已存在。冻结它才能把「本轮合法新建」与
    // 「既有知识点被删除后以同名重建」区分开：后者靠新 id 绕过 id→代次比对，
    // 只有身份基线能识别（R4：不能通过新建绕过删除代次）。
    identities[concept.slug] = toDecimalString(concept.generation);
  }
  await repositories.learning.insertRound({
    workspaceId: input.workspaceId, sessionId: input.sessionId, messageId: input.messageId,
    epoch, conceptGenerations: { ...generations, [IDENTITY_BASELINE_KEY]: identities },
    recordEnabled: input.recordEnabled,
  });
}

// ── 结算 ──────────────────────────────────────────────────────────────────────

export type LearningSettlementResult = {
  readonly round_id: string;
  readonly epoch: string;
  readonly saved: readonly {
    readonly concept_id: string; readonly evidence_id: string; readonly kind: string;
    readonly scenario: string;
  }[];
  readonly skipped: readonly { readonly index: number; readonly reason: string }[];
  readonly concept_generations: Record<string, string>;
};

export interface SettleLearningRoundInput {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly roundId: string;
  readonly increments: readonly LearningIncrement[];
  /**
   * 学习 runner 的执行身份（R2/R3）。给出时结算事务必须核对：轮次对应的消息仍
   * 归本 Worker（RUNNING + worker_id 匹配）且取消意图未持久化；失权或取消先提交的
   * 迟到结果无权写任何证据。直接命令调用（无生成身份）不传。
   */
  readonly workerId?: string | undefined;
}

/**
 * 把本轮候选增量落库。
 *
 * 先做全部校验再写：形状、条数、依据、代次、记录控制。任一条不合法就整单拒绝
 * （不部分写入），保留可读教学回答并如实显示未更新——不用追加模型调用去「修分」。
 */
export async function settleLearningRound(db: DbExecutor,
  input: SettleLearningRoundInput): Promise<CommandOutcome<LearningSettlementResult>> {
  return runIdempotentCommand<LearningSettlementResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SettleLearningRound',
    target: { round_id: input.roundId },
    // 增量进命令体：同 command_id 换载荷重放必须按异载荷拒绝，不产生第二次增量。
    body: { increments: input.increments.map(plainIncrement) },
    execute: async (repositories) => applySettlement(repositories, input),
  });
}

function plainIncrement(increment: LearningIncrement): JsonObject {
  return {
    op: increment.op, topic: increment.topic, concept: increment.concept,
    ...(increment.concept_slug === undefined ? {} : { concept_slug: increment.concept_slug }),
    scenario: increment.scenario, detail: increment.detail,
    source_message_id: increment.source_message_id,
  };
}

/**
 * 把模型信封里的候选转成应用层形状。
 *
 * 只做**形状搬运**，不做补全：缺失字段留成空串（依据引用留 undefined），随后被
 * `validateIncrement` 以类型化原因拒绝。在这里填默认值会把「模型没给场景」悄悄变成
 * 「通用场景」、把「模型没给依据」悄悄变成「已绑定」，那正是要挡住的。
 */
export function learningIncrementFromEnvelope(raw: JsonObject): LearningIncrement {
  return {
    op: raw.op as LearningIncrementOp,
    topic: typeof raw.topic === 'string' ? raw.topic : '',
    concept: typeof raw.concept === 'string' ? raw.concept : '',
    ...(typeof raw.concept_slug === 'string' ? { concept_slug: raw.concept_slug } : {}),
    scenario: typeof raw.scenario === 'string' ? raw.scenario : '',
    detail: typeof raw.detail === 'string' ? raw.detail : '',
    source_message_id: typeof raw.source_message_id === 'string' ? raw.source_message_id : '',
  };
}

/**
 * 由轮次身份派生的确定性命令 ID（UUID 形状）。
 *
 * 同一个轮次的结算尝试用同一个命令 ID，因此重复提交只会拿回原回执；轮次状态 CAS 是第二道闸。
 */
export function learningSettlementCommandId(roundId: string): string {
  const bytes = Buffer.from(createHash('sha256')
    .update(`learning-settle:${roundId}`, 'utf8').digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function applySettlement(repositories: Repositories,
  input: SettleLearningRoundInput): Promise<LearningSettlementResult> {
  // 锁顺序纪律：先取 workspace 级 epoch 事务锁，再碰轮次行。全清同序，因此
  // 「结算 ↔ 全清」要么结算先提交（随后全清清掉新证据），要么全清先提交（结算读到
  // 新 epoch → LEARNING_ROUND_STALE），不存在旧 epoch 证据残留为当前内容的窗口（R6）。
  await repositories.learning.lockRecordEpoch(input.workspaceId);
  const round = await repositories.learning.readRound(input.roundId, true);
  if (round === undefined || round.workspace_id !== input.workspaceId) {
    throw learningRoundUnavailable('这一轮的结算依据不存在；旧轮次不恢复已清记录。');
  }
  // runner 的执行身份核对与证据写入在**同一事务**：迟到的失权 Worker 连校验这关都
  // 过不去（R2）；取消意图先持久化时，未结算增量零新增（R3）。
  // 注意：这里抛出的错误会随命令事务整体回滚，轮次终态由调用方（runner）按
  // conflict.reason 另行收口，与 REJECTED/STALE 的既有收敛路径一致。
  if (input.workerId !== undefined) {
    const message = await repositories.assist.readMessage(round.message_id, true);
    if (message === undefined || message.status !== 'RUNNING' ||
        message.worker_id !== input.workerId) {
      throw learningRoundControlLost(
        '这一轮的生成身份已失效（租约过期或消息已被收敛），迟到结果无权结算学习增量。',
        'LEASE_LOST');
    }
    if (message.cancel_requested) {
      throw learningRoundControlLost(
        '这一轮已按停止意图收口，未结算增量不再写入；已提交的事实保持原样。',
        'LEARNING_ROUND_CANCELLED');
    }
  }
  // 代次先于状态核对：清除后旧轮次应当得到「依据已过期」这一可核对原因，
  // 而不是笼统的「已结算」。
  const currentEpoch = await repositories.learning.readEpoch(input.workspaceId);
  if (currentEpoch !== round.epoch) {
    await repositories.learning.settleRound(round.id, 'REJECTED', 'LEARNING_ROUND_STALE');
    throw learningRoundStale('这一轮开始时冻结的记录代次已经变化（发生过清除），本轮增量不再写入。',
      { frozen_epoch: toDecimalString(round.epoch), current_epoch: toDecimalString(currentEpoch) });
  }
  if (round.status !== 'PENDING') {
    throw learningRoundUnavailable(`这一轮已按 ${round.status} 结算，不重复写入。`);
  }
  if (!round.record_enabled) throw learningRecordDisabled();
  if (input.increments.length > MAX_INCREMENTS_PER_ROUND) {
    throw learningIncrementRejected('increments',
      `一轮最多写入 ${MAX_INCREMENTS_PER_ROUND} 条增量，本次收到 ${input.increments.length} 条。`);
  }

  const frozen = frozenGenerations(round.concept_generations);
  const frozenIdentities = identityBaseline(round.concept_generations);
  // 本轮两条消息的身份：用户消息（seq-1）与助手消息（轮次自身）。依据引用只能落在这里。
  const roundMessages = await roundMessageIdentities(repositories, round);
  const saved: LearningSettlementResult['saved'][number][] = [];
  const generations: Record<string, string> = {};
  // 本轮首次接触某概念时它当时的代次。同一轮内因为 CORRECT 造成的代次递增**不应**
  // 反过来把本轮自己的后续增量判成过期；只有本轮开始后的外部变化才使轮次失效。
  const roundStartGenerations = new Map<string, bigint>();

  for (const [index, increment] of input.increments.entries()) {
    const validated = validateIncrement(increment, index);
    const kind = evidenceKindFor(validated.op);
    // 依据绑定先于概念解析：引用本身不合法时整单拒绝，不落下半个概念。
    const basis = await resolveIncrementBasis(repositories, round, roundMessages,
      validated, kind, index);
    const concept = await resolveLearningConcept(repositories, {
      workspaceId: input.workspaceId, topic: validated.topic, concept: validated.concept,
      ...(validated.concept_slug === undefined ? {} : { conceptSlug: validated.concept_slug }),
      // 「解除待复核」只作用于已存在的知识点，不为它预建空知识点。
      ...(kind === null ? { createIfMissing: false } : {}),
    });
    if (concept === undefined) {
      // 解除待复核时知识点不存在：没有待复核项可解除，静默跳过而不是造一个空知识点。
      continue;
    }
    // 冻结基线之外：只有「本轮新建、且身份在轮次开始时不存在」才是合法新知识点。
    // 既有知识点被删除后以同名重建会拿到新 id，必须靠身份基线识别并拒绝——不能靠
    // 新建绕过删除代次（R4）。合法新概念没有可复活的既有事实，照常写入。
    const frozenGeneration = frozen[concept.id];
    const startGeneration = roundStartGenerations.get(concept.id) ?? concept.generation;
    if (frozenGeneration === undefined) {
      if (frozenIdentities[concept.slug] !== undefined) {
        await repositories.learning.settleRound(round.id, 'REJECTED', 'LEARNING_ROUND_STALE');
        throw learningRoundStale(
          `知识点「${concept.display_name}」在本轮开始后被删除并以同一身份重建，本轮增量不再写入。`,
          { concept_id: concept.id, slug: concept.slug });
      }
    } else if (frozenGeneration !== toDecimalString(startGeneration)) {
      await repositories.learning.settleRound(round.id, 'REJECTED', 'LEARNING_ROUND_STALE');
      throw learningRoundStale(
        `知识点「${concept.display_name}」在本轮开始后被纠正或删除，本轮增量不再写入。`,
        { concept_id: concept.id, frozen_generation: frozenGeneration,
          current_generation: toDecimalString(startGeneration) });
    }
    roundStartGenerations.set(concept.id, startGeneration);

    if (kind === null) {
      // RESOLVE_REVIEW：只解除待复核，不新增证据。
      for (const row of await repositories.learning.listEvidenceByConcept(concept.id)) {
        if (row.disposition === 'PENDING_REVIEW') {
          await repositories.learning.updateEvidenceDisposition(row.id, 'SUPERSEDED');
        }
      }
      generations[concept.id] = toDecimalString(startGeneration);
      continue;
    }

    // 期望代次随写语句进入同一临界区（insertEvidence 内 for update 重读），
    // 校验之后发生的人工提交无法越过这道闸（R7）。
    const evidence = await repositories.learning.insertEvidence({
      workspaceId: input.workspaceId, conceptId: concept.id, kind,
      scenario: validated.scenario, detail: validated.detail,
      disposition: kind === 'GAP' ? 'PENDING_REVIEW' : 'ACTIVE',
      sourceKind: 'LEARNING_MESSAGE', sourceMessageId: basis.messageId,
      sessionId: round.session_id, observedAt: new Date(), epoch: round.epoch,
      expectedGeneration: frozenGeneration,
    });
    if (evidence === undefined) {
      // 概念行已消失或代次在临界区内被推进：这一轮整单作废，不写半条证据。
      await repositories.learning.settleRound(round.id, 'REJECTED', 'LEARNING_ROUND_STALE');
      throw learningRoundStale(
        `知识点「${concept.display_name}」在写入前被纠正、删除或清除，本轮增量不再写入。`,
        { concept_id: concept.id, frozen_generation: frozenGeneration ?? null });
    }
    // 用户明确纠正（CORRECT）是自述：它使同概念的在途旧轮次失去写入资格，
    // 但**不**删除旧证据，也不影响其他概念的并发轮次（提示词 §9.1）。
    const generation = validated.op === 'CORRECT'
      ? await repositories.learning.bumpConceptGeneration(concept.id) ?? startGeneration
      : startGeneration;
    generations[concept.id] = toDecimalString(generation);
    saved.push({ concept_id: concept.id, evidence_id: evidence.id,
      kind: evidence.kind, scenario: evidence.scenario });
  }

  if (!await repositories.learning.settleRound(round.id, 'SETTLED', null)) {
    throw learningRoundUnavailable('这一轮已被其他结算抢先处理，本次不重复写入。');
  }
  return {
    round_id: round.id, epoch: toDecimalString(currentEpoch), saved, skipped: [],
    concept_generations: generations,
  };
}

function validateIncrement(increment: LearningIncrement, index: number): LearningIncrement {
  validateIncrementText(increment, index);
  if (typeof increment.source_message_id !== 'string' ||
      !SOURCE_MESSAGE_ID_PATTERN.test(increment.source_message_id)) {
    throw learningEvidenceRefInvalid(`increments[${index}].source_message_id`,
      '每条增量都必须给出本轮依据消息的引用（source_message_id）；没有依据的候选不写入。');
  }
  return increment;
}

function validateIncrementText(increment: LearningIncrement, index: number): LearningIncrement {
  const field = (name: string): string => `increments[${index}].${name}`;
  if (!INCREMENT_OPS.includes(increment.op)) {
    throw learningIncrementRejected(field('op'), `未知操作 ${String(increment.op)}。`);
  }
  if (typeof increment.topic !== 'string' || increment.topic.trim() === '' ||
      increment.topic.length > MAX_TOPIC_CHARS) {
    throw learningIncrementRejected(field('topic'), `主题必须是 1–${MAX_TOPIC_CHARS} 字的非空文本。`);
  }
  if (typeof increment.concept !== 'string' || increment.concept.trim() === '' ||
      increment.concept.length > MAX_CONCEPT_CHARS) {
    throw learningIncrementRejected(field('concept'), `知识点名必须是 1–${MAX_CONCEPT_CHARS} 字的非空文本。`);
  }
  if (typeof increment.scenario !== 'string' || increment.scenario.trim() === '' ||
      increment.scenario.length > MAX_SCENARIO_CHARS) {
    throw learningIncrementRejected(field('scenario'),
      `具体场景必须是 1–${MAX_SCENARIO_CHARS} 字的非空文本；不接受笼统的「通用」。`);
  }
  if (typeof increment.detail !== 'string' || increment.detail.trim() === '' ||
      increment.detail.length > MAX_DETAIL_CHARS) {
    throw learningIncrementRejected(field('detail'),
      `具体能力或缺口描述必须是 1–${MAX_DETAIL_CHARS} 字的非空文本。`);
  }
  return increment;
}

// ── 依据绑定（ADR-020 §5.3，整改 R8） ─────────────────────────────────────────

/** 本轮两条消息的身份：user 消息是本轮真实输入，assistant 消息是本轮教学。 */
interface RoundMessageIdentities {
  readonly userMessage: AssistMessageRow | undefined;
  readonly assistantMessageId: string;
}

async function roundMessageIdentities(repositories: Repositories,
  round: LearningRoundRow): Promise<RoundMessageIdentities> {
  const assistant = await repositories.assist.readMessage(round.message_id);
  // user 消息与 assistant 消息在发送命令里成对写入（seq、seq+1）；seq-1 即本轮输入。
  const userMessage = assistant === undefined ? undefined
    : await repositories.assist.readMessageAtSeq(assistant.session_id, assistant.seq - 1n);
  return { userMessage, assistantMessageId: round.message_id };
}

/** 用户输入只是「跳过」时不产生任何用户侧证据——不升级也不降级。 */
const SKIP_REPLIES: readonly string[] = ['跳过', '先跳过', '略过', '跳过这个', '跳过这个问题',
  '跳过此题', '跳过一下', 'skip', '不会', '不知道', '不懂', '答不上来', '回答不上来',
  '不回答', '不想回答', '没什么想说的', '无'];

/** 用户输入只是自述理解时，不能拿它当「实际表现」的依据（自述 ≠ 验证）。 */
const SELF_REPORT_ONLY_REPLIES: readonly string[] = ['我懂了', '我明白了', '明白了',
  '理解了', '我理解了', '学会了', '我学会了', '我会了', '懂了', '清楚了', '我清楚了',
  '懂了谢谢', '明白了谢谢', '理解了谢谢', '懂', '明白'];

function normalizeReply(content: string): string {
  return content.trim().toLowerCase().replace(/[\s！？。，、；：,.!?;:~～…"'（）()【】\[\]]/gu, '');
}

function isUserSideOp(op: LearningIncrementOp): boolean {
  return op === 'SELF_REPORT' || op === 'OBSERVE' || op === 'GAP' || op === 'CORRECT' ||
    op === 'RESOLVE_REVIEW';
}

/**
 * 解析并校验候选的依据引用：存在、属于本轮、性质相符。
 *
 * 性质规则（可测试，不需要额外模型调用）：
 *   * 讲解过（EXPOSURE）→ 依据是本轮助手消息（教学确实发生在这一条回答里）；
 *   * 自述 / 表现 / 缺口（SELF_REPORT / OBSERVE / GAP / CORRECT / RESOLVE_REVIEW）
 *     → 依据是本轮用户消息，助手消息冒充用户发言一律拒绝。
 */
async function resolveIncrementBasis(repositories: Repositories, round: LearningRoundRow,
  identities: RoundMessageIdentities, increment: LearningIncrement,
  kind: LearningEvidenceRow['kind'] | null, index: number) {
  const field = (name: string): string => `increments[${index}].${name}`;
  const reference = increment.source_message_id;
  const userSide = isUserSideOp(increment.op);
  const expectedId = userSide ? identities.userMessage?.id : identities.assistantMessageId;
  const expectedKind = userSide ? '用户消息' : '助手消息';
  if (expectedId === undefined || reference !== expectedId) {
    // 不存在、跨轮、跨会话、或把助手消息当用户发言：都按依据引用不合法拒绝。
    throw learningEvidenceRefInvalid(field('source_message_id'),
      `依据 ${reference} 不是本轮${expectedKind}；增量只引用本轮真实发生的输入或教学。`);
  }
  if (!userSide) {
    // 讲解过的依据是本轮教学本身；用户是否跳过不影响「讲过」这个事实。
    return { messageId: expectedId, userId: null as string | null };
  }
  const userReply = identities.userMessage!.content ?? '';
  const normalized = normalizeReply(userReply);
  if (normalized === '') {
    throw learningEvidenceRefInvalid(field('source_message_id'),
      '本轮没有真实用户输入，不能从这一轮得出用户侧证据。');
  }
  if (SKIP_REPLIES.includes(normalized)) {
    throw learningEvidenceRefInvalid(field('source_message_id'),
      '本轮用户选择跳过，不产生接触、自述、表现或缺口证据。');
  }
  if ((kind === 'OBSERVED' || kind === 'GAP') &&
      SELF_REPORT_ONLY_REPLIES.includes(normalized)) {
    throw learningEvidenceRefInvalid(field('source_message_id'),
      kind === 'OBSERVED'
        ? '本轮用户只是自述理解，不能据此记录为实际表现。'
        : '本轮用户只是自述理解，不能据此记录为缺口。');
  }
  return { messageId: expectedId, userId: identities.userMessage!.id };
}

/** 操作 → 证据性质。RESOLVE_REVIEW 不新增证据，返回 null。 */
function evidenceKindFor(op: LearningIncrementOp): LearningEvidenceRow['kind'] | null {
  switch (op) {
    case 'EXPOSE': return 'EXPOSURE';
    case 'SELF_REPORT': return 'SELF_REPORT';
    case 'OBSERVE': return 'OBSERVED';
    case 'GAP': return 'GAP';
    case 'CORRECT': return 'SELF_REPORT';
    case 'RESOLVE_REVIEW': return null;
  }
}

function frozenGenerations(value: JsonObject): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

/** 冻结基线里的身份分区（`slug → generation`）；旧轮次没有这一段时返回空表。 */
function identityBaseline(value: JsonObject): Record<string, string> {
  const raw = value[IDENTITY_BASELINE_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

// ── 用户控制 ──────────────────────────────────────────────────────────────────

export interface CorrectLearningRecordInput {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly sessionId: string;
  /** 聊天纠正绑定已完成的用户消息；明确 UI 命令可省略，不虚构消息依据。 */
  readonly sourceMessageId?: string | undefined;
  readonly conceptId: string;
  readonly scenario: string;
  readonly detail: string;
}

/**
 * 用户明确纠正：来自可信原用户消息或明确 UI 操作，及时进入同一 Owner。
 * 纠正使该概念的在途旧轮次失去写入资格，但保留旧证据——不凭一次口误全面降级。
 */
export async function correctLearningRecord(db: DbExecutor,
  input: CorrectLearningRecordInput): Promise<CommandOutcome<{ evidence_id: string;
    concept_id: string; generation: string }>> {
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'CorrectLearningRecord',
    target: { concept_id: input.conceptId },
    body: { session_id: input.sessionId, source_message_id: input.sourceMessageId ?? null,
      scenario: input.scenario, detail: input.detail },
    execute: async (repositories) => {
      const session = await repositories.assist.readSession(input.sessionId);
      if (session === undefined || session.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist session');
      }
      if (session.conversation_mode !== 'LEARNING') {
        throw learningSessionRequired('学习记录只能由学习会话维护。');
      }
      if (input.sourceMessageId !== undefined) {
        await requireLearningUserMessage(repositories, input.workspaceId,
          input.sessionId, input.sourceMessageId);
      }
      const concept = await repositories.learning.findConceptById(input.conceptId);
      if (concept === undefined || concept.workspace_id !== input.workspaceId) {
        throw resourceNotFound('知识点');
      }
      // UI 纠正由用户命令本身提供依据，不虚构一条聊天消息；模型增量仍必需本轮引用。
      const validated = validateIncrementText({
        op: 'CORRECT', topic: concept.topic, concept: concept.display_name,
        scenario: input.scenario, detail: input.detail,
        source_message_id: input.sourceMessageId ?? '' }, 0);
      const evidence = await repositories.learning.insertEvidence({
        workspaceId: input.workspaceId, conceptId: concept.id, kind: 'SELF_REPORT',
        scenario: validated.scenario, detail: validated.detail, disposition: 'ACTIVE',
        sourceKind: 'USER_CONTROL', sourceMessageId: null, sessionId: session.id,
        observedAt: new Date(), epoch: await repositories.learning.readEpoch(input.workspaceId),
      });
      if (evidence === undefined) throw resourceNotFound('知识点');
      const generation = await repositories.learning.bumpConceptGeneration(concept.id)
        ?? concept.generation;
      return { evidence_id: evidence.id, concept_id: concept.id,
        generation: toDecimalString(generation) };
    },
  });
}

export interface DeleteLearningEvidenceInput {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly evidenceId: string;
  /** 期望的概念代次；落后即冲突，不用最后写入覆盖。 */
  readonly expectedGeneration?: string | undefined;
}

/** 单项删除：清掉该证据并递增概念代次，使旧轮次不能复活它。 */
export async function deleteLearningEvidence(db: DbExecutor,
  input: DeleteLearningEvidenceInput): Promise<CommandOutcome<{ deleted: true; concept_id: string;
    generation: string }>> {
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'DeleteLearningEvidence',
    target: { evidence_id: input.evidenceId },
    body: { expected_generation: input.expectedGeneration ?? null },
    execute: async (repositories) => {
      const evidence = await repositories.learning.readEvidence(input.evidenceId, true);
      if (evidence === undefined || evidence.workspace_id !== input.workspaceId) {
        throw resourceNotFound('学习记录');
      }
      const concept = await repositories.learning.findConceptById(evidence.concept_id);
      const expectedGeneration = input.expectedGeneration;
      if (concept !== undefined && expectedGeneration !== undefined &&
          toDecimalString(concept.generation) !== expectedGeneration) {
        throw new DomainError({
          code: 'REVISION_CONFLICT', status: 409, type: '/problems/revision-conflict',
          title: '资源版本已变化',
          detail: '该知识点已被其他操作更新，请刷新后重新决定。',
          retryable: false, retryAction: 'REFRESH_AND_REDECIDE',
          conflict: { entityType: 'LEARNING_CONCEPT',
            expectedRevision: expectedGeneration,
            actualRevision: toDecimalString(concept.generation) },
        });
      }
      await repositories.learning.deleteEvidence(evidence.id);
      const generation = concept === undefined ? 0n
        : await repositories.learning.bumpConceptGeneration(concept.id) ?? concept.generation;
      return { deleted: true, concept_id: evidence.concept_id,
        generation: toDecimalString(generation) };
    },
  });
}

/** 全清：清掉本 workspace 的全部学习派生内容并递增代次，旧轮次不得复活。 */
export async function clearLearningRecords(db: DbExecutor, input: {
  readonly workspaceId: string; readonly commandId: string;
}): Promise<CommandOutcome<{ epoch: string; cleared_evidence: number; cleared_concepts: number;
  cancelled_rounds: number }>> {
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'ClearLearningRecords',
    target: { workspace_id: input.workspaceId },
    body: {},
    execute: async (repositories) => {
      // 清除顺序：先取 workspace 级 epoch 事务锁，再推进代次、失活在途轮次、删评估
      // 内容。与结算同序（结算也是先取这把锁再碰轮次行），因此「清除 ↔ 结算」只有两种
      // 合法结果：清除先提交 → 旧轮次读到新 epoch 判 STALE；结算先提交 → 清除随后把
      // 新证据一并清掉。清除回执重放走命令幂等，不重复推进 epoch（R6）。
      await repositories.learning.lockRecordEpoch(input.workspaceId);
      const epoch = await repositories.learning.bumpEpoch(input.workspaceId, input.commandId);
      const cancelledRounds = await repositories.learning.cancelWorkspaceRounds(input.workspaceId);
      const clearedEvidence = await repositories.learning.deleteEvidenceByWorkspace(input.workspaceId);
      const clearedConcepts = await repositories.learning.deleteConcepts(input.workspaceId);
      // 清除范围是**学习记录**：原聊天、Provider 历史与项目事实都不在这里，也不声称已删除。
      return { epoch: toDecimalString(epoch), cleared_evidence: clearedEvidence,
        cleared_concepts: clearedConcepts, cancelled_rounds: cancelledRounds };
    },
  });
}

export interface SetLearningRecordControlInput {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly sessionId: string;
  readonly recordsEnabled: boolean;
  readonly expectedRevision?: string | undefined;
}

/**
 * 会话级「后续不记录」。范围与生效时间持久；在途轮次按关闭命令与保存事务的排序处理：
 * 关闭前已提交的如实保留，关闭后未提交的旧轮次不再有写入资格。
 */
export async function setLearningRecordControl(db: DbExecutor,
  input: SetLearningRecordControlInput): Promise<CommandOutcome<{ session_id: string;
    records_enabled: boolean; revision: string }>> {
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SetLearningRecordControl',
    target: { session_id: input.sessionId },
    body: { records_enabled: input.recordsEnabled,
      expected_revision: input.expectedRevision ?? null },
    execute: async (repositories) => {
      const session = await repositories.assist.readSession(input.sessionId);
      if (session === undefined || session.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist session');
      }
      if (session.conversation_mode !== 'LEARNING') {
        throw learningSessionRequired('只有学习会话有学习记录开关；普通助手与 Agent 会话不记录学习状态。');
      }
      const expectedRevision = input.expectedRevision;
      const expected = expectedRevision === undefined ? undefined : BigInt(expectedRevision);
      const row = await repositories.learning.upsertSessionControl({
        sessionId: input.sessionId, workspaceId: input.workspaceId,
        recordsEnabled: input.recordsEnabled, updatedByMessageId: null,
        expectedRevision: expected,
      });
      if (row === undefined) {
        const actual = (await repositories.learning.readSessionControl(input.sessionId))?.revision ?? 0n;
        throw new DomainError({
          code: 'REVISION_CONFLICT', status: 409, type: '/problems/revision-conflict',
          title: '资源版本已变化',
          detail: '该会话的记录开关已被其他操作更新，请刷新后重新决定。',
          retryable: false, retryAction: 'REFRESH_AND_REDECIDE',
          conflict: {
            entityType: 'LEARNING_SESSION_CONTROL',
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            actualRevision: toDecimalString(actual),
          },
        });
      }
      if (!input.recordsEnabled) {
        // 关闭记录后，在途轮次不再有写入资格；已提交的保持原样，不声称被删除。
        await repositories.learning.cancelPendingRounds(input.sessionId);
      }
      return { session_id: input.sessionId, records_enabled: row.records_enabled,
        revision: toDecimalString(row.revision) };
    },
  });
}

async function requireLearningUserMessage(repositories: Repositories, workspaceId: string,
  sessionId: string, messageId: string): Promise<AssistMessageRow> {
  const session = await repositories.assist.readSession(sessionId);
  if (session === undefined || session.workspace_id !== workspaceId) {
    throw resourceNotFound('Assist session');
  }
  if (session.conversation_mode !== 'LEARNING') {
    throw learningSessionRequired('学习记录只能由学习会话维护。');
  }
  const message = await repositories.assist.readMessage(messageId);
  if (message === undefined || message.session_id !== sessionId || message.role !== 'USER' ||
      message.status !== 'COMPLETED') {
    throw validationFailed([{ field: 'source_message_id',
      message: '纠正只能绑定该会话中一条已完成的用户消息。' }]);
  }
  return message;
}

/** 会话级记录控制的有效值：缺行等价于「记录开启」。 */
export async function learningRecordEnabled(repositories: Repositories,
  session: AssistSessionRow, message: AssistMessageRow): Promise<boolean> {
  if (message.learning_record_disabled) return false;
  const control = await repositories.learning.readSessionControl(session.id);
  return control?.records_enabled ?? true;
}

// ── 查询 ──────────────────────────────────────────────────────────────────────

/** 页面刷新后重读控制与轮次终态；不保留候选正文或从回执复原已删记录。 */
export async function readLearningSessionState(db: DbExecutor,
  input: { readonly workspaceId: string; readonly sessionId: string }) {
  return withTransaction(db, async (repositories) => {
    const session = await repositories.assist.readSession(input.sessionId);
    if (session === undefined || session.workspace_id !== input.workspaceId) {
      throw resourceNotFound('Assist session');
    }
    if (session.conversation_mode !== 'LEARNING') {
      throw learningSessionRequired('只有学习会话有学习记录控制与轮次。');
    }
    const control = await repositories.learning.readSessionControl(session.id);
    const rounds = await repositories.learning.listSessionRounds(session.id);
    return { session_id: session.id, records_enabled: control?.records_enabled ?? true,
      revision: toDecimalString(control?.revision ?? 0n),
      rounds: rounds.map((round) => ({ message_id: round.message_id,
        status: round.status, rejection_reason: round.rejection_reason,
        record_enabled: round.record_enabled })) };
  });
}

export interface LearningEvidenceView {
  readonly evidence_id: string;
  readonly kind: string;
  readonly scenario: string;
  readonly detail: string;
  readonly disposition: string;
  readonly source_kind: string;
  readonly source_message_id: string | null;
  readonly session_id: string | null;
  readonly observed_at: string;
}

export interface LearningConceptView {
  readonly concept_id: string;
  readonly topic: string;
  readonly display_name: string;
  readonly generation: string;
  readonly revision: string;
  readonly evidence: readonly LearningEvidenceView[];
}

export interface LearningRecordsView {
  readonly epoch: string;
  readonly cleared_at: string | null;
  readonly concepts: readonly LearningConceptView[];
}

/**
 * 轻量查看：直接读应用保存的同一记录，**不**请求模型重新生成进度总结。
 * 默认返回摘要所需的最小字段，展开所需的具体缺口与依据也在这里。
 */
export async function readLearningRecords(db: DbExecutor,
  input: { readonly workspaceId: string }): Promise<LearningRecordsView> {
  return withTransaction(db, async (repositories) => {
    const epochRow = await repositories.learning.readEpochRow(input.workspaceId);
    const concepts = await repositories.learning.listConcepts(input.workspaceId);
    const evidence = await repositories.learning.listEvidenceByWorkspace(input.workspaceId);
    const byConcept = new Map<string, LearningEvidenceRow[]>();
    for (const row of evidence) {
      const list = byConcept.get(row.concept_id) ?? [];
      list.push(row);
      byConcept.set(row.concept_id, list);
    }
    return {
      epoch: toDecimalString(epochRow?.epoch ?? 0n),
      cleared_at: epochRow?.cleared_at?.toISOString() ?? null,
      concepts: concepts.map((concept) => ({
        concept_id: concept.id, topic: concept.topic, display_name: concept.display_name,
        generation: toDecimalString(concept.generation),
        revision: toDecimalString(concept.revision),
        evidence: (byConcept.get(concept.id) ?? []).map(toEvidenceView),
      })),
    };
  });
}

function toEvidenceView(row: LearningEvidenceRow): LearningEvidenceView {
  return {
    evidence_id: row.id, kind: row.kind, scenario: row.scenario, detail: row.detail,
    disposition: row.disposition, source_kind: row.source_kind,
    source_message_id: row.source_message_id, session_id: row.session_id,
    observed_at: row.observed_at.toISOString(),
  };
}

export interface LearningContinuationView {  readonly session_id: string;
  readonly goal: string;
  readonly last_observed_at: string | null;
  readonly topics: readonly { readonly topic: string; readonly concepts: number }[];
  /** 具体缺口与待复核项：这是接续要接着处理的东西，不是掌握度分数。 */
  readonly open_items: readonly { readonly concept_id: string; readonly display_name: string;
    readonly kind: string; readonly disposition: string; readonly detail: string;
    readonly scenario: string }[];
}

/**
 * 返回接续：只读当前记录与本次会话的证据，不重新评分历史。
 * 「很久没有新互动」只说明最后依据时间，**不**自动降级，也不启动后台复习。
 */
export async function readLearningContinuation(db: DbExecutor,
  input: { readonly workspaceId: string; readonly sessionId: string }):
Promise<LearningContinuationView> {
  return withTransaction(db, async (repositories) => {
    const session = await repositories.assist.readSession(input.sessionId);
    if (session === undefined || session.workspace_id !== input.workspaceId) {
      throw resourceNotFound('Assist session');
    }
    if (session.conversation_mode !== 'LEARNING') {
      throw learningSessionRequired('只有学习会话有返回接续。');
    }
    const concepts = await repositories.learning.listConcepts(input.workspaceId);
    const byId = new Map(concepts.map((concept) => [concept.id, concept]));
    const evidence = await repositories.learning.listEvidenceByWorkspace(input.workspaceId);
    const topics = new Map<string, number>();
    let lastObserved: Date | null = null;
    const openItems: LearningContinuationView['open_items'][number][] = [];
    for (const row of evidence) {
      const concept = byId.get(row.concept_id);
      if (concept === undefined) continue;
      topics.set(concept.topic, (topics.get(concept.topic) ?? 0) + 1);
      if (lastObserved === null || row.observed_at > lastObserved) lastObserved = row.observed_at;
      // 未决项以**当前处置状态**为准：SUPERSEDED/WITHDRAWN 的 GAP 保留为可追溯历史，
      // 但不再是「还没处理完的事」（R5）。仍待复核的照常可见。
      if (row.disposition === 'PENDING_REVIEW') {
        openItems.push({ concept_id: concept.id, display_name: concept.display_name,
          kind: row.kind, disposition: row.disposition, detail: row.detail,
          scenario: row.scenario });
      }
    }
    return {
      session_id: session.id,
      goal: session.title,
      last_observed_at: lastObserved?.toISOString() ?? null,
      topics: [...topics.entries()].map(([topic, count]) => ({ topic, concepts: count })),
      open_items: openItems,
    };
  });
}

/**
 * 进入教学轮次的**相关短状态**。
 *
 * 选择规则是可测试的应用规则，不新增「选知识点」的模型调用：当前目标（会话标题）→
 * 主题归组 → 具体缺口/待复核 → 最近 N 条证据。不加载全部跨项目状态、全部旧证据，
 * 也不重放整段历史。个人状态跨项目共用，但这里只带短状态，不带他项目正文。
 */
export async function readLearningRoundState(db: DbExecutor, input: {
  readonly workspaceId: string; readonly sessionId: string; readonly limit?: number | undefined;
}): Promise<JsonObject> {
  const limit = input.limit ?? 12;
  return withTransaction(db, async (repositories) => {
    const session = await repositories.assist.readSession(input.sessionId);
    if (session === undefined || session.workspace_id !== input.workspaceId) {
      throw resourceNotFound('Assist session');
    }
    const concepts = await repositories.learning.listConcepts(input.workspaceId);
    const byId = new Map(concepts.map((concept) => [concept.id, concept]));
    const evidence = await repositories.learning.listEvidenceByWorkspace(input.workspaceId, limit);
    const topics = new Map<string, number>();
    const recent: JsonObject[] = [];
    const openItems: JsonObject[] = [];
    for (const row of evidence) {
      const concept = byId.get(row.concept_id);
      if (concept === undefined) continue;
      topics.set(concept.topic, (topics.get(concept.topic) ?? 0) + 1);
      recent.push({ topic: concept.topic, concept: concept.display_name, kind: row.kind,
        scenario: row.scenario, disposition: row.disposition,
        observed_at: row.observed_at.toISOString() });
      // 与接续读取同一规则：已解除（SUPERSEDED/WITHDRAWN）的缺口不再作为未决项进入
      // 下一轮教学上下文，只留在 recent 历史里可核对（R5）。
      if (row.disposition === 'PENDING_REVIEW') {
        openItems.push({ concept: concept.display_name, kind: row.kind,
          disposition: row.disposition, scenario: row.scenario, detail: row.detail });
      }
    }
    return {
      goal: session.title,
      topics: [...topics.entries()].map(([topic, count]) => ({ topic, concepts: count })),
      open_items: openItems,
      recent,
    };
  });
}
