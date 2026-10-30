import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { auditRequiredContext } from '../application/required-context-files.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

/**
 * 项目必读文件体积审计（2026-10-30）。
 *
 * 只读投影，不是命令：不写任何业务事实、不产生回执，重放无副作用——与 `/work-context`、
 * `/context-manifests` 同一类。它回答的是「按当前配置，这次发送之前会有多少必读内容要进
 * 上下文」，因此**不能**与圆环（最近一次真实调用的实测用量）混算，也没必要落库。
 *
 * 全参数显式：`agent` 决定按哪类 Agent 的规则入口枚举（不同 Agent 入口文件不同），
 * `model` 决定 Provider 窗口是否已知，`refresh=1` 跳过目录遍历缓存（发送前与手动刷新用）。
 */

const uuid = Type.String({ format: 'uuid' });
const strict = { additionalProperties: false } as const;

const params = Type.Object({ workspace_id: uuid, resource_id: uuid }, strict);
const query = Type.Object({
  agent: Type.Optional(Type.String({ maxLength: 32 })),
  model: Type.Optional(Type.String({ maxLength: 200 })),
  /** 0145：单次调用预算以会话档位为准；有会话就必须传，否则会按工作区默认报偏。 */
  session_id: Type.Optional(uuid),
  /** 新会话首条消息尚无会话行时，用户已选的上下文档位；与 body 的档位同一口径。 */
  budget_tokens: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{2,8}$' })),
  /** `1` = 跳过遍历缓存重新遍历；显式字符串避免查询串布尔强转的歧义。 */
  refresh: Type.Optional(Type.String({ pattern: '^(0|1)$' })),
  /** 历史上下文预留（实测 input tokens，不传则按会话上一次调用自动取）。 */
  history_tokens: Type.Optional(Type.String({ pattern: '^[0-9]{1,9}$' })),
}, strict);

const severity = Type.Union([Type.Literal('NONE'), Type.Literal('NOTICE'),
  Type.Literal('HIGH'), Type.Literal('SEVERE')]);

const fileRisk = Type.Object({
  path: Type.String(),
  category: Type.Union([Type.Literal('AUTO_INJECTED'), Type.Literal('TASK_REQUIRED')]),
  scope: Type.Union([Type.Literal('ROOT'), Type.Literal('NESTED'), Type.Literal('DECLARED')]),
  reason: Type.String(),
  bytes: Type.Integer(),
  estimated_tokens: Type.Integer(),
  modified_at: Type.String(),
  share: Type.Union([Type.Number(), Type.Null()]),
  severity,
}, strict);

const budget = Type.Object({
  provider_window_tokens: Type.Union([Type.Integer(), Type.Null()]),
  provider_window_known: Type.Boolean(),
  call_budget_tokens: Type.Integer(),
  call_budget_source: Type.Union([Type.Literal('SESSION'), Type.Literal('WORKSPACE_TIER'),
    Type.Literal('APPLICATION_DEFAULT')]),
  effective_input_tokens: Type.Union([Type.Integer(), Type.Null()]),
  effective_basis: Type.Union([Type.Literal('PROVIDER_WINDOW'), Type.Literal('CALL_BUDGET'),
    Type.Literal('UNAVAILABLE')]),
  reserves: Type.Object({ output_tokens: Type.Integer(), system_prompt_tokens: Type.Integer(),
    tool_definition_tokens: Type.Integer(), history_tokens: Type.Integer() }, strict),
  estimated_total_input_tokens: Type.Union([Type.Integer(), Type.Null()]),
  required_total_tokens: Type.Integer(),
  required_total_share: Type.Union([Type.Number(), Type.Null()]),
  confidence: Type.Union([Type.Literal('EXACT_WINDOW'), Type.Literal('WINDOW_UNKNOWN'),
    Type.Literal('UNAVAILABLE')]),
  estimate: Type.Object({ method: Type.String(), bytes_per_token: Type.Integer(),
    note: Type.String() }, strict),
}, strict);

const audit = Type.Object({
  state: Type.Union([Type.Literal('OK'), Type.Literal('NO_FILE_ACCESS'),
    Type.Literal('SCAN_UNAVAILABLE')]),
  detail: Type.String(),
  agent: Type.Object({ id: Type.String(), label: Type.String() }, strict),
  root: Type.Union([Type.String(), Type.Null()]),
  scanned_at: Type.String(),
  fingerprint: Type.String(),
  severity,
  files: Type.Array(fileRisk),
  budget,
  reasons: Type.Array(Type.Object({ code: Type.String(), text: Type.String(),
    ratio: Type.Union([Type.Number(), Type.Null()]),
    path: Type.Union([Type.String(), Type.Null()]) }, strict)),
  suggestions: Type.Array(Type.Object({ code: Type.String(), text: Type.String() }, strict)),
  skipped: Type.Array(Type.Object({ path: Type.String(), reason: Type.String() }, strict)),
  /** 「查看文件」用的同一读取入口；无权限时为 null。 */
  access: Type.Union([Type.Object({ project_id: uuid, connection_id: uuid }, strict),
    Type.Null()]),
  thresholds: Type.Object({
    single_file: Type.Object({ notice: Type.Number(), high: Type.Number(),
      severe: Type.Number() }, strict),
    total_files: Type.Object({ notice: Type.Number(), high: Type.Number(),
      severe: Type.Number() }, strict),
    tool_definition_reserve_tokens: Type.Integer(),
    walk_cache_ttl_ms: Type.Integer(),
    max_scanned_directories: Type.Integer(),
    max_config_bytes: Type.Integer(),
    max_required_files: Type.Integer(),
  }, strict),
}, strict);

export type RequiredContextAuditDto = Static<typeof audit>;

export function registerRequiredContextRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/working-directories/:resource_id/required-context-audit', {
    schema: { params, querystring: query, response: { 200: audit } },
  }, async (request, reply) => {
    try {
      const path = request.params as Static<typeof params>;
      const search = request.query as Static<typeof query>;
      const result = await auditRequiredContext(dependencies.database.executor, {
        workspaceId: path.workspace_id,
        resourceId: path.resource_id,
        agent: search.agent ?? null,
        model: search.model ?? null,
        sessionId: search.session_id ?? null,
        budgetTokens: search.budget_tokens === undefined ? null : Number(search.budget_tokens),
        refresh: search.refresh === '1',
        historyTokens: search.history_tokens === undefined ? null : Number(search.history_tokens),
      });
      // DTO 显式投影：TypeBox response schema 会丢弃未声明字段，这里让形状与 schema 一一对应，
      // 不把应用层对象直接倒给 HTTP（漏映射时线上会读到空体）。
      return {
        state: result.state, detail: result.detail,
        agent: { id: result.agent.id, label: result.agent.label },
        root: result.root, scanned_at: result.scanned_at, fingerprint: result.fingerprint,
        severity: result.severity,
        files: result.files.map((file) => ({ path: file.path, category: file.category,
          scope: file.scope, reason: file.reason, bytes: file.bytes,
          estimated_tokens: file.estimated_tokens, modified_at: file.modified_at,
          share: file.share, severity: file.severity })),
        budget: { ...result.budget, reserves: { ...result.budget.reserves },
          estimate: { ...result.budget.estimate } },
        reasons: result.reasons.map((reason) => ({ code: reason.code, text: reason.text,
          ratio: reason.ratio, path: reason.path })),
        suggestions: result.suggestions.map((suggestion) => ({ code: suggestion.code,
          text: suggestion.text })),
        skipped: result.skipped.map((entry) => ({ path: entry.path, reason: entry.reason })),
        access: result.access === null ? null
          : { project_id: result.access.project_id, connection_id: result.access.connection_id },
        thresholds: { single_file: { ...result.thresholds.single_file },
          total_files: { ...result.thresholds.total_files },
          tool_definition_reserve_tokens: result.thresholds.tool_definition_reserve_tokens,
          walk_cache_ttl_ms: result.thresholds.walk_cache_ttl_ms,
          max_scanned_directories: result.thresholds.max_scanned_directories,
          max_config_bytes: result.thresholds.max_config_bytes,
          max_required_files: result.thresholds.max_required_files },
      };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
