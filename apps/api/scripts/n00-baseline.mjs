#!/usr/bin/env node
/**
 * N00 使用基线测量。只读现有 HTTP API，不写业务表、不新增端点、不落数据库。
 *
 * 时间口径全部来自 /runs/:run_id/trace 已持久化的事实；Trace 没有的段（命令受理、
 * 首字时间、人工理解成本）一律记为不可得，不用相邻时间戳顶替。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDir, '..');
const workspaceRoot = resolve(apiRoot, '..', '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REAL_PROVIDER = 'openai-compatible';

function parseArgs(argv) {
  const args = { allowUnfilled: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--allow-unfilled') { args.allowUnfilled = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`);
    const key = arg.slice(2).replaceAll('-', '_');
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${arg} 缺少取值`);
    args[key] = value;
    i += 1;
  }
  return args;
}

/** 凭据只用于本机请求，不进入任何输出、证据或错误信息。 */
async function resolveToken() {
  if (process.env.RELAY_API_BEARER_TOKEN) return process.env.RELAY_API_BEARER_TOKEN;
  const env = await readFile(join(apiRoot, '.env'), 'utf8');
  const line = env.split(/\r?\n/).map((item) => item.trim())
    .find((item) => item.startsWith('RELAY_API_BEARER_TOKEN='));
  const token = line?.slice('RELAY_API_BEARER_TOKEN='.length).trim() ?? '';
  if (token === '') throw new Error('未找到 RELAY_API_BEARER_TOKEN；请设置环境变量或填写 apps/api/.env');
  return token;
}

async function getJson(baseUrl, token, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const body = await response.text();
  if (!response.ok) {
    // 只回传状态码与 problem code，不回显可能含内部标识的正文。
    let code = '';
    try { code = JSON.parse(body).code ?? ''; } catch { /* 非 JSON 正文不回显 */ }
    throw new Error(`GET ${path} 返回 ${response.status}${code === '' ? '' : ` ${code}`}`);
  }
  return JSON.parse(body);
}

const time = (value) => (typeof value === 'string' && value !== '' ? Date.parse(value) : null);
const span = (from, to) => (from === null || to === null ? null : to - from);
const round = (value) => (value === null ? null : Math.round(value));

function minTime(rows, pick) {
  const values = rows.map(pick).map(time).filter((value) => value !== null);
  return values.length === 0 ? null : Math.min(...values);
}

function maxTime(rows, pick) {
  const values = rows.map(pick).map(time).filter((value) => value !== null);
  return values.length === 0 ? null : Math.max(...values);
}

/** 单个 Run 的可核验指标；分不开的段不估算。 */
function measureRun(trace) {
  const attempts = trace.attempts ?? [];
  const calls = trace.model_calls ?? [];
  const steps = trace.steps ?? [];
  const reviews = trace.reviews ?? [];
  const verifications = trace.verifications ?? [];
  const invocations = (trace.operations ?? []).flatMap((operation) => operation.invocations ?? []);
  const sources = (trace.manifests ?? []).flatMap((manifest) => manifest.sources ?? []);

  const claimAt = minTime(attempts, (row) => row.started_at);
  const firstCallAt = minTime(calls, (row) => row.started_at);
  const persistAt = maxTime(steps.filter((step) => step.result_available), (step) => step.finished_at);
  const decidedReviews = reviews.filter((review) => review.decision !== null);
  const humanWaitMs = decidedReviews.length === 0 ? null : Math.max(
    ...decidedReviews.map((review) => span(time(review.created_at), time(review.decision.decided_at)) ?? 0),
  );

  const usageUnknownCalls = calls.filter((call) =>
    call.usage_input_tokens === null || call.usage_output_tokens === null);
  const providers = [...new Set(calls.map((call) => call.provider))].sort();

  return {
    run_id: trace.run_id,
    task_id: trace.task_id,
    project_id: trace.project_id,
    status: trace.status,
    execution: {
      claim_to_first_model_call_ms: round(span(claimAt, firstCallAt)),
      claim_to_persisted_ms: round(span(claimAt, persistAt)),
      steps_total: steps.length,
      steps_with_result: steps.filter((step) => step.result_available).length,
      attempts_total: attempts.length,
      attempts_retried: Math.max(0, attempts.length - new Set(attempts.map((row) => row.step_id)).size),
    },
    human: {
      reviews_total: reviews.length,
      reviews_decided: decidedReviews.length,
      review_wait_ms: round(humanWaitMs),
      verifications_total: verifications.length,
      verifications_finalized: verifications.filter((row) => row.finalized_at !== null).length,
    },
    effects: {
      operations_total: (trace.operations ?? []).length,
      invocations_total: invocations.length,
      invocations_unknown: invocations.filter((row) => row.status === 'UNKNOWN').length,
      // 在途（PREPARED/DISPATCHING）没有回执是正常的，只把已终结却无回执的算异常。
      invocations_terminal_without_result: invocations.filter((row) =>
        (row.status === 'SUCCEEDED' || row.status === 'FAILED') && row.result_available === false).length,
    },
    context: {
      manifests_total: (trace.manifests ?? []).length,
      sources_total: sources.length,
      sources_unavailable: sources.filter((row) => row.availability !== 'AVAILABLE').length,
    },
    model: {
      providers,
      calls_total: calls.length,
      calls_unsettled: calls.filter((row) => row.status !== 'SETTLED').length,
      usage_input_tokens: calls.reduce((sum, row) => sum + (row.usage_input_tokens ?? 0), 0),
      usage_output_tokens: calls.reduce((sum, row) => sum + (row.usage_output_tokens ?? 0), 0),
      calls_with_unknown_usage: usageUnknownCalls.length,
    },
    // Trace 未持久化这些时间点，用相邻时间戳代替会把排队/首字说成别的东西。
    not_derivable: {
      accept_to_claim_ms: '命令受理时间未在 Trace 暴露',
      first_token_ms: '首字时间未持久化',
      handoff_reading: '人工理解成本须由使用者记录',
    },
  };
}

function classifyRuns(runs) {
  const real = runs.filter((run) => run.model.providers.length > 0 &&
    run.model.providers.every((provider) => provider === REAL_PROVIDER));
  const fake = runs.filter((run) => run.model.providers.includes('fake'));
  const other = runs.filter((run) => run.model.providers.some((provider) =>
    provider !== REAL_PROVIDER && provider !== 'fake'));
  const none = runs.filter((run) => run.model.providers.length === 0);
  if (real.length > 0 && (fake.length > 0 || other.length > 0)) return 'MIXED';
  if (real.length > 0) return 'REAL';
  if (fake.length > 0) return 'FAKE';
  if (other.length > 0) return 'OTHER';
  if (none.length === runs.length && runs.length > 0) return 'NO_MODEL_CALL';
  return 'UNFILLED';
}

function aggregate(runs) {
  const pick = (read) => {
    const values = runs.map(read).filter((value) => value !== null && value !== undefined);
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
  };
  return {
    runs: runs.length,
    claim_to_first_model_call_ms_max: Math.max(-1, ...runs.map((row) =>
      row.execution.claim_to_first_model_call_ms ?? -1)),
    claim_to_persisted_ms_max: Math.max(-1, ...runs.map((row) =>
      row.execution.claim_to_persisted_ms ?? -1)),
    claim_to_persisted_ms_total: pick((row) => row.execution.claim_to_persisted_ms),
    attempts_retried_total: pick((row) => row.execution.attempts_retried) ?? 0,
    review_wait_ms_max: Math.max(-1, ...runs.map((row) => row.human.review_wait_ms ?? -1)),
    invocations_unknown_total: pick((row) => row.effects.invocations_unknown) ?? 0,
    invocations_terminal_without_result_total:
      pick((row) => row.effects.invocations_terminal_without_result) ?? 0,
    sources_unavailable_total: pick((row) => row.context.sources_unavailable) ?? 0,
    calls_with_unknown_usage_total: pick((row) => row.model.calls_with_unknown_usage) ?? 0,
    usage_input_tokens_total: pick((row) => row.model.usage_input_tokens) ?? 0,
    usage_output_tokens_total: pick((row) => row.model.usage_output_tokens) ?? 0,
  };
}

/** 只报可由数字直接判定的问题，不在这里猜原因。 */
function listProblems(path) {
  const problems = [];
  if (path.provider_class === 'MIXED') problems.push('同一条路径混入 Mock 与真实 Provider，数字不可合并比较');
  if (path.provider_class === 'FAKE') problems.push('本路径只测到 Mock，不能当作真实模型时延');
  if (path.provider_class === 'UNFILLED') problems.push('本路径尚未记录任何 Run');
  if (path.aggregate.invocations_unknown_total > 0) {
    problems.push(`存在 ${path.aggregate.invocations_unknown_total} 个结果不明调用未收敛`);
  }
  if (path.aggregate.invocations_terminal_without_result_total > 0) {
    problems.push(
      `${path.aggregate.invocations_terminal_without_result_total} 个调用已终结却没有回执`);
  }
  if (path.aggregate.sources_unavailable_total > 0) {
    problems.push(`${path.aggregate.sources_unavailable_total} 个上下文来源当时不可用`);
  }
  if (path.aggregate.calls_with_unknown_usage_total > 0) {
    problems.push(`${path.aggregate.calls_with_unknown_usage_total} 次模型调用没有可核验用量`);
  }
  if (path.aggregate.attempts_retried_total > 0) {
    problems.push(`发生 ${path.aggregate.attempts_retried_total} 次步骤重试`);
  }
  if (Number(path.observations.rework_count ?? 0) > 0) {
    problems.push(`人工记录返工 ${path.observations.rework_count} 次`);
  }
  if (typeof path.observations.blocked_reason === 'string' &&
      path.observations.blocked_reason !== '') {
    problems.push(`未跑通：${path.observations.blocked_reason}`);
  }
  return problems;
}

function renderReport(summary) {
  const lines = [
    '# N00 使用基线报告',
    '',
    `生成时间：${summary.generated_at}`,
    `任务集：${summary.task_set.title}（v${summary.task_set.version}）`,
    `基线来源：${summary.source}`,
    '',
    '## 口径',
    '',
    '- 执行段时间来自 `/api/v1/workspaces/:workspace_id/runs/:run_id/trace` 已持久化的时间戳：领取=最早 attempt 开始，首内容=最早模型调用开始（不是首字），落库=最后一个带结果步骤完成。',
    '- 命令受理到领取、首字时间、人工理解成本在 Trace 中不存在，列为不可得，需人工记录，不用相邻时间戳顶替。',
    '- Mock 与真实 Provider 不合并统计；用量缺失按未知计数，不按 0 计。',
    '',
    '## 路径汇总',
    '',
    '| 路径 | 状态 | Provider | Run 数 | 领取→首调用(max) | 领取→落库(max) | 重试 | UNKNOWN 调用 | 未知用量调用 | 人工返工 |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const path of summary.paths) {
    lines.push(`| ${path.title} | ${path.status} | ${path.provider_class} | ${path.aggregate.runs} | ` +
      `${ms(path.aggregate.claim_to_first_model_call_ms_max)} | ${ms(path.aggregate.claim_to_persisted_ms_max)} | ` +
      `${path.aggregate.attempts_retried_total} | ${path.aggregate.invocations_unknown_total} | ` +
      `${path.aggregate.calls_with_unknown_usage_total} | ${path.observations.rework_count ?? '未记'} |`);
  }
  lines.push('', '## 优先问题清单', '');
  const problems = summary.paths.flatMap((path) =>
    listProblems(path).map((text) => `- ${path.title}：${text}`));
  lines.push(problems.length === 0 ? '- 无：三条路径都已记录且未触发任何可判定问题。' : problems);
  lines.push('', '## 人工记录', '');
  for (const path of summary.paths) {
    lines.push(`- ${path.title}：` +
      (Object.keys(path.observations).length === 0
        ? '未记录'
        : Object.entries(path.observations).map(([key, value]) => `${key}=${value}`).join('，')));
  }
  lines.push('', '## 本次未覆盖', '', ...summary.limitations.map((text) => `- ${text}`), '');
  return `${lines.join('\n')}\n`;
}

const ms = (value) => (value === null || value === undefined || value < 0 ? '不可得' : `${value} ms`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceId = args.workspace_id ?? process.env.RELAY_WORKSPACE_ID;
  if (workspaceId === undefined || !UUID.test(workspaceId)) {
    throw new Error('需要 --workspace-id <uuid>（或环境变量 RELAY_WORKSPACE_ID）');
  }
  const taskSetPath = resolve(args.task_set ?? join(scriptDir, 'n00-task-set.json'));
  const taskSet = JSON.parse(await readFile(taskSetPath, 'utf8'));
  if (taskSet.version !== 1 || !Array.isArray(taskSet.paths)) {
    throw new Error(`任务集格式不支持：${taskSetPath}`);
  }

  const token = await resolveToken();
  const baseUrl = (args.base_url ?? process.env.RELAY_API_BASE_URL ?? 'http://127.0.0.1:8787')
    .replace(/\/+$/u, '');

  const paths = [];
  for (const definition of taskSet.paths) {
    const runIds = definition.runs ?? [];
    for (const runId of runIds) {
      if (!UUID.test(runId)) throw new Error(`${definition.id} 的 run_id 不是 UUID：${runId}`);
    }
    const runs = [];
    for (const runId of runIds) {
      const trace = await getJson(baseUrl, token,
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${runId}/trace`);
      runs.push(measureRun(trace));
    }
    paths.push({
      id: definition.id,
      title: definition.title,
      intent: definition.intent,
      status: runs.length === 0 ? 'NOT_RECORDED' : 'RECORDED',
      provider_class: classifyRuns(runs),
      aggregate: aggregate(runs),
      observations: definition.observations ?? {},
      runs,
    });
  }

  const recorded = paths.filter((path) => path.status === 'RECORDED').length;
  const summary = {
    generated_at: new Date().toISOString(),
    source: `${baseUrl}（只读 Trace）`,
    task_set: { title: taskSet.title, version: taskSet.version, path: taskSetPath },
    workspace_id: workspaceId,
    paths,
    limitations: [
      '受理反馈段与人工理解成本无法从 Trace 得出，只反映任务集里的人工记录。',
      'Mock 与真实 Provider 分开统计；本报告不把任一方当作另一方的替代。',
      '样本量小的路径只能当起点，不能当作产品整体时延结论。',
      '本报告不含正文、产物内容或任何凭据。',
    ],
  };

  const stamp = summary.generated_at.replace(/[-:]/gu, '').replace(/\..+$/u, '').replace('T', '-');
  const outDir = resolve(args.out ?? join(workspaceRoot, 'docs', 'testing', 'evidence',
    'n00-baseline', stamp));
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(join(outDir, 'report.md'), renderReport(summary), 'utf8');
  process.stdout.write(`${outDir}\n`);

  if (recorded < paths.length && !args.allow_unfilled) {
    process.stderr.write(
      `只有 ${recorded}/${paths.length} 条路径记录了 Run；未记录路径的聚合值为 0，不是测量结果。\n`);
    process.exitCode = 2;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
