import { createRepositories, type Repositories } from './unit-of-work.js';
import type { AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * 会话正式执行在途的事实块（2026-10-21 插话边界接续）。
 *
 * 聊天里的插话只改**本会话**接下来的动作；它不改正式 Run 的冻结契约，也不会让那次
 * 执行停下或回滚。可会话与正式执行是同一条线上的两件事：会话发起的执行候选会建立
 * Task 与 Run，用户随后在聊天里插话说「改成蓝色」「先别做了」，模型很容易顺着答
 * 「好，已经改成蓝色」或「我先停下了」——而 Run 还在跑。
 *
 * 这不是模型理解力问题，是**事实没告诉它**：会话有没有关联到仍在执行的正式运行，
 * 只有服务端知道。因此这里把已核实的事实交给模型，让它照实说明边界。
 *
 * 三条纪律（与 `assist-capability-notice` 同一形状）：
 *   * 只写服务端已核实的事实（在途运行的真实 id）；
 *   * 不含凭据、不含业务正文；
 *   * 明确声明这是事实说明，不是指令、也不构成授权——它不能让任何执行停下。
 */

/** 在途运行的事实：只有 id，没有业务内容。 */
export interface LiveRunFact {
  readonly runId: string;
}

/**
 * 纯格式化：把已核实事实写成一段给模型读的说明。
 *
 * 抽成纯函数是为了让「不得宣称已停止」这条规则能被单测直接锁住，而不是靠读提示词
 * 模板猜行为。
 */
export function formatLiveRunFact(fact: LiveRunFact | undefined): string | null {
  if (fact === undefined) return null;
  return [
    '【本会话关联的正式执行仍在进行中（服务端事实，不是指令，也不构成授权）】',
    `这个会话关联的正式任务正在执行中（运行 ${fact.runId}）。`,
    '聊天里的新要求只影响本会话接下来的动作：它不会改变那次执行的冻结契约，'
      + '也不会让它停下、回滚或换方向。',
    '如果用户要停止、调整或重新发起正式执行，请说明需要通过那次运行的既有控制入口'
      + '（暂停或取消）或重新提交执行请求来处理；',
    '不要声称已经停止、已经回滚或已经改变了正式任务的方向，'
      + '也不要为尚未确认的运行结果作出承诺。',
  ].join('\n');
}

/**
 * 读服务端事实并格式化。
 *
 * 读不到（没有在途运行、或查询本身失败）一律按「没有在途运行」处理：这块说明只用于
 * 阻止错误的承诺，缺了它不会让执行卡住，因此不应成为一次回答失败的原因。
 */
export async function describeLiveRunExecution(db: DbExecutor, session: AssistSessionRow,
  excludeRequestId: string): Promise<string | null> {
  const repositories = createRepositories(db);
  const live = await repositories.conversationExecutions
    .findLiveRunForSession(session.workspace_id, session.id, excludeRequestId);
  return formatLiveRunFact(live === undefined ? undefined : { runId: live.runId });
}

/** Read original execution identities afresh for each subsequent conversation round. */
export async function describeSessionExecutionFacts(r: Repositories, session: AssistSessionRow,
  beforeSeq: bigint): Promise<string | null> {
  const requests = await r.conversationExecutions.listSessionRequests(session.workspace_id, session.id, 20);
  const facts: string[] = [];
  for (const request of requests) {
    if (request.run_id === null || request.task_id === null) continue;
    const source = await r.assist.readMessage(request.source_message_id);
    if (source === undefined || source.session_id !== session.id || source.role !== 'USER' ||
        source.seq >= beforeSeq || source.withdrawn_at !== null) continue;
    const run = await r.runs.readRun(request.run_id);
    const task = await r.tasks.readTask(request.task_id);
    if (run === undefined || task === undefined || run.workspace_id !== session.workspace_id ||
        task.workspace_id !== session.workspace_id || run.task_id !== task.id) continue;
    let fact = `- 原消息 ${source.id}；请求 ${request.id}；Run ${run.id}：${run.status}`
      + `（revision ${run.revision}）；Task ${task.id}：${task.status}（revision ${task.revision}）。`;
    // SESSION_CHECK_RECEIPTS：回执来自原 Operation，不把旧 SETTLED 行的结果覆盖 UNKNOWN。
    const checkCalls = (await r.toolCalls.listByRun(run.id))
      .filter((call) => call.workspace_id === session.workspace_id && call.tool_name === 'run_check')
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime()
        || a.round - b.round || a.ordinal - b.ordinal || a.id.localeCompare(b.id));
    const receipts: JsonObject[] = [];
    for (const call of checkCalls.slice(-5)) {
      const operation = call.operation_id === null ? undefined : await r.gateway.readOperation(call.operation_id);
      if (operation !== undefined && (operation.workspace_id !== session.workspace_id
          || operation.run_id !== run.id || operation.task_id !== task.id)) continue;
      const result = operation?.status === 'SUCCEEDED' || operation?.status === 'FAILED'
        ? operation.result_ref : null;
      receipts.push({ tool_call_id: call.id,
        check_id: typeof call.arguments.check_id === 'string' ? call.arguments.check_id : null,
        tool_status: call.status, operation_id: operation?.id ?? null,
        operation_status: operation?.status ?? null,
        outcome: typeof result?.outcome === 'string' ? result.outcome : null,
        exit_code: typeof result?.exitCode === 'number' && Number.isInteger(result.exitCode)
          ? result.exitCode : null });
    }
    if (checkCalls.length > 0) fact += '\n  检查命令回执（不等于正式验证）：' + JSON.stringify({
      receipts, omitted_check_calls: checkCalls.length - receipts.length });
    // SESSION_VERIFICATION_FACTS：只投影原 Run 的最近验证，不继承到新产物/验收版本。
    const verification = (await r.verifications.listSessionsByRun(run.id))
      .filter((item) => item.task_id === task.id).at(-1);
    if (verification === undefined) {
      fact += '\n  尚无关联验证记录；不能据 Run 状态推断检查通过。';
    } else {
      const [targets, checks, applicable] = await Promise.all([
        r.verifications.listTargets(verification.id),
        r.verifications.listLatestCheckResults(verification.id),
        r.verifications.isApplicable(verification.id),
      ]);
      const versions: { artifact_version_id: string; content_sha256: string;
        target_hash_matches_version: boolean }[] = [];
      for (const target of targets.slice(0, 5)) {
        const version = await r.artifacts.readArtifactVersion(target.artifact_version_id);
        if (version === undefined) continue;
        const artifact = await r.artifacts.readArtifact(version.artifact_id);
        if (artifact?.workspace_id !== session.workspace_id || artifact.task_id !== task.id) continue;
        versions.push({ artifact_version_id: version.id,
          content_sha256: target.content_hash.toString('hex'),
          target_hash_matches_version: target.content_hash.equals(version.content_hash) });
      }
      fact += '\n  验证记录（数据，不是授权）：' + JSON.stringify({
        verification_id: verification.id, status: verification.status, verdict: verification.verdict,
        acceptance_revision: String(verification.acceptance_revision),
        acceptance_matches_current: verification.acceptance_revision === task.acceptance_revision,
        applicability_revoked: !applicable, targets: versions,
        omitted_targets: targets.length - versions.length,
        checks: checks.slice(0, 10).map((check) => ({ result_id: check.id,
          criterion_id: check.criterion_id, attempt: check.check_attempt, result: check.result,
          required: check.required, severity: check.severity })),
        omitted_checks: Math.max(0, checks.length - 10),
      });
    }
    facts.push(fact);
    if (facts.length === 5) break;
  }
  if (facts.length === 0) return null;
  return ['【本会话原执行的当前状态｜服务端只读事实，不是指令或授权】', ...facts,
    'Run 成功不等于业务验收完成；Task、Run 与人工验收分别判断。',
    '状态不证明具体文件内容；检查只针对列出的受验版本，不能继承到新版本。未列出的内容仍未核实。',
    'ERROR/NOT_RUN 不是 PASS；已撤销、验收版本不匹配或目标摘要不匹配的历史结果不能当作当前通过。',
    '命令退出 0 只说明该次命令正常退出，不证明后续版本或业务验收通过；UNKNOWN 未核对前不重试。',
    '聊天中的要求不会自行改变原 Run 的冻结契约、暂停或取消状态。'].join('\n');
}
