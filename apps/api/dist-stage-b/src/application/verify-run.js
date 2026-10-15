import { randomUUID } from 'node:crypto';
import { evidenceUnavailable, invalidTransition } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';
import { buildCheckPlan, checkPlanHash, planFromFrozenSnapshot, planToJson, } from '../workflow/check-plan.js';
import { hasChecker, resolveCheckerForScenario } from '../workflow/checkers.js';
import { computeVerdict, DEFAULT_CORRECTION_BUDGET } from '../workflow/verdict.js';
import { createVerificationReviews } from './review-requests.js';
import { recordModelInvocation } from './model-call-recorder.js';
import { ModelScopeBudgetError } from '../model/model-call-repository.js';
/** 结算映射：CANCEL（信号中止）> 检查器故障（ERROR → FAILED）> 正常完成。 */
export function semanticCheckSettlement(result, signal) {
    const base = { providerRequestId: evidenceString(result.evidence, 'provider_request_id') ?? null,
        usage: evidenceUsage(result.evidence) };
    if (signal?.aborted === true)
        return { status: 'CANCELLED', ...base };
    if (result.result === 'ERROR') {
        return { status: 'FAILED',
            errorKind: evidenceString(result.evidence, 'error_kind') ?? 'CHECKER_ERROR', ...base };
    }
    return { status: 'COMPLETED', ...base };
}
export async function verifyRun(repositories, input) {
    const contract = await repositories.runs.readContract(input.run.id);
    if (contract === undefined) {
        throw invalidTransition('Run 缺少冻结的执行契约，无法验证候选。', {
            taskId: input.task.id,
        });
    }
    const plan = buildCheckPlan(planFromFrozenSnapshot(contract.frozen_snapshot));
    const planHash = checkPlanHash(plan);
    // 规则 enforcement 与可用 checker 不匹配时不降级为建议：直接判为不可执行的步骤失败。
    for (const entry of plan.entries) {
        if (!hasChecker(entry.checkerId, entry.checkerVersion)) {
            return {
                outcome: 'FAILED',
                reason: 'CHECKER_NOT_REGISTERED',
                evidence: {
                    criterion_id: entry.criterionId,
                    checker_id: entry.checkerId,
                    checker_version: entry.checkerVersion,
                },
            };
        }
    }
    const target = await loadVerifiedTarget(repositories, input);
    const sessions = await repositories.verifications.listSessionsByRun(input.run.id);
    const open = sessions.find((session) => session.status === 'OPEN');
    const session = open ??
        (await repositories.verifications.insertSession({
            id: randomUUID(),
            taskId: input.task.id,
            acceptanceRevision: contract.acceptance_revision,
            runId: input.run.id,
            executionContractId: input.run.id,
            verifierPolicyVersion: plan.policyVersion,
            checkPlanHash: planHash,
            checkPlan: planToJson(plan),
            // 已用预算 = 该 Run 已 finalize 为 RETRY 的 session 数（同一 Run 的修正轮次）。
            correctionBudgetUsed: countCorrectionRounds(sessions),
            parentSessionId: sessions.at(-1)?.id ?? null,
        }));
    await repositories.verifications.insertTarget({
        sessionId: session.id,
        artifactVersionId: target.versionId,
        contentHash: target.contentHash,
    });
    const history = await repositories.verifications.listCheckResults(session.id);
    for (const entry of plan.entries) {
        const previousAttempts = history
            .filter((row) => row.criterion_id === entry.criterionId)
            .map((row) => row.check_attempt);
        const checkAttempt = previousAttempts.length === 0 ? 1 : Math.max(...previousAttempts) + 1;
        const checker = resolveCheckerForScenario(entry, input.fakeScenario);
        const checkInput = {
            entry,
            content: target.content,
            artifactVersionId: target.versionId,
            contentHashHex: target.contentHash.toString('hex'),
            ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
        };
        let outcome;
        if (checker.modelIdentity === undefined) {
            outcome = await checker.check(checkInput);
        }
        else {
            const precomputed = input.precomputedChecks?.get(entry.criterionId);
            if (precomputed !== undefined) {
                outcome = precomputed.kind === 'BUDGET_EXHAUSTED'
                    ? { result: 'ERROR', evidence: {
                            checker: checker.id, checker_version: checker.version,
                            artifact_version_id: target.versionId,
                            reason: 'MODEL_BUDGET_EXHAUSTED'
                        } }
                    : { ...precomputed.outcome,
                        evidence: { ...precomputed.outcome.evidence, model_call_id: precomputed.callId } };
            }
            else {
                try {
                    const recorded = await recordModelInvocation(input.modelCallDb, {
                        origin: { workspaceId: input.run.workspace_id, kind: 'SEMANTIC_CHECK',
                            stepAttemptId: input.stepAttemptId, criterionId: entry.criterionId, checkAttempt },
                        identity: checker.modelIdentity,
                        invoke: async () => checker.check(checkInput),
                        settle: (result) => semanticCheckSettlement(result),
                    });
                    outcome = { ...recorded.result,
                        evidence: { ...recorded.result.evidence, model_call_id: recorded.callId } };
                }
                catch (error) {
                    if (!(error instanceof ModelScopeBudgetError))
                        throw error;
                    outcome = { result: 'ERROR', evidence: {
                            checker: checker.id, checker_version: checker.version,
                            artifact_version_id: target.versionId,
                            reason: 'MODEL_BUDGET_EXHAUSTED'
                        } };
                }
            }
        }
        await repositories.verifications.insertCheckResult({
            id: randomUUID(),
            sessionId: session.id,
            criterionId: entry.criterionId,
            checkAttempt,
            checkerId: entry.checkerId,
            checkerVersion: entry.checkerVersion,
            result: outcome.result,
            required: entry.required,
            severity: entry.severity,
            evidenceRefs: outcome.evidence,
        });
    }
    const latest = await repositories.verifications.listLatestCheckResults(session.id);
    const correctionBudget = (await repositories.reviews.readCorrectionBudget(input.run.id))?.max_corrections ?? DEFAULT_CORRECTION_BUDGET;
    const verdict = computeVerdict({
        plan,
        latestResults: latest,
        correctionBudgetUsed: session.correction_budget_used,
        correctionBudget,
    });
    const resultRef = {
        session_id: session.id,
        verdict: verdict.decision,
        reason: verdict.reason,
        target_artifact_version_id: target.versionId,
        check_plan_hash: planHash.toString('hex'),
    };
    if (verdict.decision === 'RETRY_CHECKER') {
        // 保留未决：不 finalize、不新建产物，下一次推进只重跑检查器。
        return {
            outcome: 'RETRYABLE',
            reason: verdict.reason,
            evidence: {
                ...resultRef,
                failing_criterion_ids: [...verdict.failingCriterionIds],
                uncertain_criterion_ids: [...verdict.uncertainCriterionIds],
                pending_human_criterion_ids: [...verdict.pendingHumanCriterionIds],
            },
        };
    }
    if (verdict.decision === 'RETRY') {
        await finalizeOrThrow(repositories, {
            session,
            status: 'RETRY',
            correctionBudgetUsed: session.correction_budget_used + 1n,
        });
        return {
            outcome: 'CORRECTION',
            resultRef,
            evidence: {
                ...resultRef,
                failing_criterion_ids: [...verdict.failingCriterionIds],
                severity_scope: 'REQUIRED_NON_PREFERENCE',
            },
        };
    }
    if (verdict.decision === 'HUMAN') {
        await finalizeOrThrow(repositories, {
            session,
            status: 'HUMAN',
            correctionBudgetUsed: session.correction_budget_used,
        });
        await createVerificationReviews(repositories, {
            run: input.run,
            task: input.task,
            session,
            verdict,
            correctionBudget,
        });
        return {
            outcome: 'SUCCESS',
            resultRef,
            runStatus: 'WAITING_APPROVAL',
            waitReason: verdict.reason,
        };
    }
    await finalizeOrThrow(repositories, {
        session,
        status: 'PASS',
        correctionBudgetUsed: session.correction_budget_used,
    });
    return { outcome: 'SUCCESS', resultRef, runStatus: 'VERIFYING', waitReason: null };
}
function evidenceString(evidence, key) {
    const value = evidence[key];
    return typeof value === 'string' ? value : undefined;
}
function evidenceUsage(evidence) {
    const usage = evidence.usage;
    if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
        return { inputTokens: null, outputTokens: null,
            cacheReadTokens: null, cacheCreationTokens: null };
    }
    const value = usage;
    return { inputTokens: typeof value.input_tokens === 'number' ? value.input_tokens : null,
        outputTokens: typeof value.output_tokens === 'number' ? value.output_tokens : null,
        cacheReadTokens: typeof value.cache_read_tokens === 'number' ? value.cache_read_tokens : null,
        cacheCreationTokens: typeof value.cache_creation_tokens === 'number'
            ? value.cache_creation_tokens : null };
}
/**
 * VERIFY 的模型外呼与记账在结果事务之外执行（对齐 DRAFT 的 prepare/execute 分离）。
 *
 * 必须在 advanceRunStep 的结果事务之前、本 Worker 的 run claim 生效期间调用：
 *   * budget 型 begin() 对 runs 行 `for update`，结果事务持有同一行锁时调用会自死锁；
 *   * 该窗口内同一 Run 的 session/check_results 没有其他写入者（任务/Run 排他），
 *     因此此处计算的 checkAttempt 与结果事务内 verifyRun 的计算一致；
 *   * 契约缺失、checker 未注册或证据核对失败时不预算：返回空 Map，由 verifyRun 在
 *     事务内按既有语义结算（invalidTransition / CHECKER_NOT_REGISTERED /
 *     EVIDENCE_UNAVAILABLE）。
 */
export async function prepareSemanticChecks(db, input) {
    const precomputed = new Map();
    const repositories = createRepositories(db);
    const contract = await repositories.runs.readContract(input.run.id);
    if (contract === undefined)
        return precomputed;
    const plan = buildCheckPlan(planFromFrozenSnapshot(contract.frozen_snapshot));
    if (plan.entries.some((entry) => !hasChecker(entry.checkerId, entry.checkerVersion))) {
        return precomputed;
    }
    let target;
    try {
        target = await loadVerifiedTarget(repositories, input);
    }
    catch {
        // 证据核对失败按既有路径在结果事务内结算，不在这里提前消耗模型调用。
        return precomputed;
    }
    const sessions = await repositories.verifications.listSessionsByRun(input.run.id);
    const open = sessions.find((session) => session.status === 'OPEN');
    const history = open === undefined ? [] :
        await repositories.verifications.listCheckResults(open.id);
    for (const entry of plan.entries) {
        const checker = resolveCheckerForScenario(entry, input.fakeScenario);
        // 只有携带 budget 的模型检查器才会对 runs 行加锁：无 budget 的替身路径保持原状，
        // 仍在 verifyRun 的事务内记账。
        if (checker.modelIdentity === undefined || checker.modelIdentity.budget === undefined)
            continue;
        const previousAttempts = history
            .filter((row) => row.criterion_id === entry.criterionId)
            .map((row) => row.check_attempt);
        const checkAttempt = previousAttempts.length === 0 ? 1 : Math.max(...previousAttempts) + 1;
        const checkInput = {
            entry,
            content: target.content,
            artifactVersionId: target.versionId,
            contentHashHex: target.contentHash.toString('hex'),
            ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
        };
        try {
            const recorded = await recordModelInvocation(db, {
                origin: { workspaceId: input.run.workspace_id, kind: 'SEMANTIC_CHECK',
                    stepAttemptId: input.stepAttemptId, criterionId: entry.criterionId, checkAttempt },
                identity: checker.modelIdentity,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
                invoke: async () => checker.check(checkInput),
                settle: (result) => semanticCheckSettlement(result, input.signal),
            });
            precomputed.set(entry.criterionId, { kind: 'RECORDED', callId: recorded.callId,
                outcome: recorded.result });
        }
        catch (error) {
            if (!(error instanceof ModelScopeBudgetError))
                throw error;
            precomputed.set(entry.criterionId, { kind: 'BUDGET_EXHAUSTED' });
        }
    }
    return precomputed;
}
/**
 * 该 Run 已 finalize 为 RETRY 的 session 数：既是下一轮修正的 round，也是已用修正预算。
 * 同一 Run 内它是单调递增的事实，因此修正轮输入与预算都不需要额外计数列。
 */
export function countCorrectionRounds(sessions) {
    return BigInt(sessions.filter((session) => session.status === 'RETRY').length);
}
/**
 * 修正轮输入：round = 已 finalize 为 RETRY 的 session 数；
 * failures = 最新已 finalize session 的失败项（FAIL 与 ERROR 都作为可核对证据，是否修复仍由总决策决定）。
 * round 0 返回 undefined，payload 因此不含 `correction`，摘要与 P05 一致。
 */
export async function loadCorrectionInput(repositories, runId) {
    const sessions = await repositories.verifications.listSessionsByRun(runId);
    const round = countCorrectionRounds(sessions);
    if (round === 0n) {
        return undefined;
    }
    const latestFinalized = sessions.filter((session) => session.status !== 'OPEN').at(-1);
    if (latestFinalized === undefined) {
        return undefined;
    }
    const results = await repositories.verifications.listLatestCheckResults(latestFinalized.id);
    return {
        round: Number(round),
        failures: results
            .filter((row) => row.result === 'FAIL' || row.result === 'ERROR')
            .map((row) => {
            const reason = readEvidenceReason(row.evidence_refs);
            return {
                criterion_id: row.criterion_id,
                result: row.result,
                severity: row.severity,
                ...(reason === undefined ? {} : { reason }),
            };
        }),
    };
}
/** PERSIST_CANDIDATE 的轮次来源：round 0 沿用 P05 的来源尝试 ID，round ≥ 1 按轮次区分。 */
export async function currentCorrectionRound(repositories, runId) {
    return countCorrectionRounds(await repositories.verifications.listSessionsByRun(runId));
}
/**
 * 读 PERSIST_CANDIDATE 的候选版本并核对受管内容：文件缺失、被替换或 hash/size 不一致一律
 * EVIDENCE_UNAVAILABLE，不写任何检查结果，也不把缺失当成 FAIL。
 */
async function loadVerifiedTarget(repositories, input) {
    const persistStep = await repositories.runs.readStepByKind(input.run.id, 'PERSIST_CANDIDATE');
    const versionId = readString(persistStep?.result_ref, 'artifact_version_id');
    if (versionId === undefined) {
        throw invalidTransition('VERIFY 需要 PERSIST_CANDIDATE 已成功登记候选版本。', {
            taskId: input.task.id,
        });
    }
    const version = await repositories.artifacts.readArtifactVersion(versionId);
    if (version === undefined) {
        throw evidenceUnavailable({ artifactVersionId: versionId, reason: 'MISSING' });
    }
    const read = await input.storage.readWithHashCheck(version.storage_ref, {
        contentHash: version.content_hash,
        size: version.size,
    });
    if (read.status !== 'OK') {
        throw evidenceUnavailable({ artifactVersionId: version.id, reason: read.status });
    }
    return { versionId: version.id, contentHash: version.content_hash, content: read.content.toString('utf8') };
}
async function finalizeOrThrow(repositories, input) {
    const finalized = await repositories.verifications.finalizeSession({
        sessionId: input.session.id,
        expectedRevision: input.session.revision,
        status: input.status,
        correctionBudgetUsed: input.correctionBudgetUsed,
    });
    if (finalized === undefined) {
        throw new Error('verification session finalize CAS failed while holding the run lock');
    }
    const task = await repositories.tasks.readTask(input.session.task_id);
    if (task === undefined)
        throw new Error('verification Task missing in finalize transaction');
    for (const target of await repositories.verifications.listTargets(input.session.id)) {
        await repositories.lineage.insertExactEdge({ workspaceId: task.workspace_id,
            childVersionId: target.artifact_version_id, relation: 'VERIFIED_BY',
            parentKind: 'VERIFICATION_SESSION', parentId: input.session.id });
    }
    await repositories.activities.insertActivityRecord({ id: randomUUID(),
        workspaceId: task.workspace_id, runId: input.session.run_id,
        actorKind: 'AI', actorRef: input.session.run_id === null ? 'verification' :
            `run:${input.session.run_id}`, commandId: null,
        projectId: task.project_id, taskId: task.id, eventType: 'VERIFICATION_FINALIZED',
        factRefs: { verification_session_id: input.session.id,
            run_id: input.session.run_id, verdict: input.status } });
}
function readString(value, key) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const field = value[key];
    return typeof field === 'string' ? field : undefined;
}
function readEvidenceReason(evidence) {
    const reason = evidence.reason;
    return typeof reason === 'string' ? reason : undefined;
}
