import type { JsonObject } from '../infrastructure/json.js';
import { readBoundedText } from './bounded-response.js';
import { CANDIDATE_OUTPUT_SCHEMA } from './markdown-deliverable.js';
import { readInternalTool } from './tool-catalog.js';
import { renderDraftUserPrompt } from './prompts/draft-user-prompt.js';
import { selectRuntimeSystemPrompt } from './prompts/index.js';
import type { AssistModelPort, AssistContentPart, AssistRequest, AssistResult,
  AssistTurn, ComposerDraftPort, ComposerDraftRequest, ComposerDraftResult,
  ConversationInterpretationRequest, ModelIdentity, ModelPort, ModelRequest, ModelResult,
  ModelToolArgumentsDelta, ModelToolCall, ModelToolSpec, ModelToolTurn, ModelUsage,
  ModelUsageProgress } from './fake-model-port.js';
import { computeModelConfigFingerprint, defaultBaseUrlFor, protocolOf,
  type ModelPortConfig } from './model-port-config.js';
import { guardedModelFetch, parseModelBaseUrl, type ModelFetchDependencies } from
  './model-endpoint-policy.js';
import type { ProviderRoutingGuard } from './free-call-guard.js';
import { readCredentialFingerprint } from './credential-identity.js';
import { isAbortByName, ModelCallBudgetError, ModelCapabilityUnsupportedError,
  ModelOutputBudgetError, ModelSourcePolicyError, ModelTimeoutError, ModelToolOutputError,
  SemanticResponseError } from './model-port-errors.js';

/**
 * Anthropic Messages 原生模型端口（MODEL-SETTINGS-03）。
 *
 * 这是**第二种真实协议**，不是把 Anthropic 伪装成 OpenAI Chat Completions：
 *   * 端点：POST `{base}/messages`（不是 `/chat/completions`）；
 *   * 认证：`x-api-key` + `anthropic-version`（不是 `Authorization: Bearer`）；
 *   * 请求体：`system` 是顶层字段，`max_tokens` 必填，工具用 `input_schema`；
 *   * 流：SSE 事件 `message_start` / `content_block_delta` / `message_delta` / `message_stop`，
 *     终止标记是 `message_stop`（没有 `data: [DONE]`）。
 *
 * 与 OpenAI 端口共享同一套边界：`ModelPort` / `AssistModelPort` / `ComposerDraftPort`
 * 接口、同一组预算/超时/工具输出错误类、同一份系统提示词与工具声明、同一条
 * `guardedModelFetch` 端点策略。没有第二套模型执行系统。
 *
 * 能力边界（不得静默降级）：
 *   * 支持：文本生成、流式增量、工具调用（含流式参数增量）、图片输入、取消、
 *     超时分类、Token 用量（含缓存读写）、语义验收（提示词约束 + 严格解析）；
 *   * 明确拒绝：任何依赖 `response_format=json_object` 的请求。Anthropic Messages
 *     没有这个协议字段，端口在**外呼之前**抛 `ModelCapabilityUnsupportedError`，
 *     不假装设置过格式约束。受影响的功能：候选提案、学习信封、草稿辅助、请求解释。
 */
export class AnthropicMessagesModelPort
implements ModelPort, AssistModelPort, ComposerDraftPort {
  private readonly baseUrl: string;
  private readonly wireFetch: typeof fetch;
  private readonly callLimit: number;
  readonly identity: ModelIdentity;

  constructor(private readonly config: ModelPortConfig,
    private readonly transport: ModelFetchDependencies = {},
    /** 免费路由硬限制只属于 OpenRouter/OpenAI 兼容路径；这里只为保持工厂签名一致。 */
    freeGuard?: ProviderRoutingGuard,
    budget?: { readonly callReservationTokens: number;
      readonly scopeCallLimit: number; readonly scopeTokenLimit: number }) {
    void freeGuard;
    if (protocolOf(config) !== 'anthropic-messages') {
      throw new Error('ANTHROPIC_PORT_REQUIRES_ANTHROPIC_PROTOCOL');
    }
    const baseUrl = parseModelBaseUrl(config.baseUrl ?? defaultBaseUrlFor('anthropic-messages'));
    this.baseUrl = baseUrl;
    // SSE 终止标记按协议选择：Anthropic 流没有 `data: [DONE]`，用错词表会把正常结束判成断流。
    this.wireFetch = guardedModelFetch(baseUrl, transport,
      { terminator: 'ANTHROPIC_MESSAGE_STOP' });
    this.callLimit = budget?.callReservationTokens ?? config.maxCallTokens;
    this.identity = { provider: config.provider, model: config.model,
      configFingerprint: computeModelConfigFingerprint(config),
      credentialFingerprint: readCredentialFingerprint(config), budget: {
        callReservationTokens: this.callLimit,
        scopeCallLimit: budget?.scopeCallLimit ?? config.maxScopeCalls,
        scopeTokenLimit: budget?.scopeTokenLimit ?? config.maxScopeTokens,
      } };
  }

  /** 0135：同一配置与凭据，换用冻结快照的预算；配置指纹不变（配置没变）。 */
  withBudget(budget: { readonly callReservationTokens: number;
    readonly scopeCallLimit: number; readonly scopeTokenLimit: number }):
  AnthropicMessagesModelPort {
    return new AnthropicMessagesModelPort(this.config, this.transport, undefined, budget);
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    if (request.outputSchema !== CANDIDATE_OUTPUT_SCHEMA) {
      throw new Error('MODEL_OUTPUT_SCHEMA_UNSUPPORTED');
    }
    if (Array.isArray(request.manifest.sources) && request.manifest.sources.some(
      (source) => typeof source === 'object' && source !== null &&
        !Array.isArray(source) && source.selection_reason === 'RECENT_SCOPE_FALLBACK')) {
      // 与 OpenAI 端口同一个错误类：run-steps 按 instanceof 把它映射成既有失败码。
      throw new ModelSourcePolicyError();
    }
    const tools = request.tools ?? [];
    const system = selectRuntimeSystemPrompt({ kind: 'DRAFT', capability: {
      toolsEnabled: tools.length > 0,
      canWrite: tools.some((spec) => spec.name === 'apply_changeset'),
      canOperate: tools.some((spec) => {
        const definition = readInternalTool(spec.name);
        return definition?.capability === 'COMPUTER_INPUT' ||
          definition?.capability === 'BROWSER_ACTION' ||
          definition?.capability === 'BROWSER_COMMIT';
      }) } }).system;
    const messages: AnthropicMessage[] = [
      { role: 'user', content: renderDraftUserPrompt(request.manifest) },
      ...anthropicToolTurns(request.toolTurns ?? []),
    ];
    try {
      const response = await this.complete({ system, messages, tools,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onTextDelta === undefined ? {} : { onTextDelta: request.onTextDelta }),
        ...(request.onStreamEvent === undefined ? {} : { onStreamEvent: request.onStreamEvent }),
        ...(request.onToolArgumentsDelta === undefined ? {}
          : { onToolArgumentsDelta: request.onToolArgumentsDelta }) });
      if (request.signal?.aborted === true) return { kind: 'CANCELLED',
        providerRequestId: response.providerRequestId, usage: response.usage };
      if (response.toolCalls !== undefined) {
        return { kind: 'TOOL_CALLS', calls: response.toolCalls, preamble: response.text,
          providerRequestId: response.providerRequestId, usage: response.usage };
      }
      return { kind: 'CONTENT', content: response.text,
        providerRequestId: response.providerRequestId, usage: response.usage };
    } catch (error) {
      if (request.signal?.aborted === true) return { kind: 'CANCELLED' };
      throw error;
    }
  }

  /**
   * 语义验收：Anthropic 没有 `response_format=json_object`，因此不伪造它。判定协议由
   * `SEMANTIC_VERDICT` 提示词 + 严格解析保证；解析失败抛 `SemanticResponseError`，
   * 由调用方按检查器故障处理（不等于 PASS，也不等于 FAIL）。
   */
  async evaluate(input: { readonly statement: string; readonly content: string },
    signal?: AbortSignal): Promise<{
    readonly verdict: 'PASS' | 'FAIL' | 'UNCERTAIN'; readonly reason: string;
    readonly providerRequestId: string; readonly usage: ModelUsage;
  }> {
    const system = selectRuntimeSystemPrompt({ kind: 'SEMANTIC_VERDICT' }).system;
    const messages: AnthropicMessage[] = [{ role: 'user', content: `验收陈述：${input.statement}

候选正文：
${input.content}` }];
    const response = await this.complete({ system, messages,
      ...(signal === undefined ? {} : { signal }) });
    try {
      return { ...parseVerdict(response.text),
        providerRequestId: response.providerRequestId, usage: response.usage };
    } catch {
      throw new SemanticResponseError(response.providerRequestId, response.usage);
    }
  }

  async assist(request: AssistRequest): Promise<AssistResult> {
    // 结构化回复（提案 JSON、学习信封、Skill 事实）依赖 response_format；Anthropic 没有该
    // 字段，在外呼前显式拒绝，而不是发一个「看起来结构化」的请求。
    if (request.responseFormat === 'json_object' || request.learning !== undefined ||
        request.intent !== 'DISCUSS' || request.skill !== undefined) {
      throw structuredUnsupported();
    }
    const messages: AnthropicMessage[] = [];
    for (const turn of request.turns) {
      messages.push(turn.role === 'user'
        ? { role: 'user', content: anthropicUserContent(turn) }
        : { role: 'assistant', content: turn.content });
    }
    messages.push(...anthropicToolTurns(request.toolTurns ?? []));
    for (const steer of request.steers ?? []) messages.push({ role: 'user', content: steer });
    const tools = request.tools ?? [];
    try {
      const response = await this.complete({ system: request.system, messages, tools,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.intent === 'DISCUSS' && request.onTextDelta !== undefined
          ? { onTextDelta: request.onTextDelta } : {}),
        ...(request.onStreamEvent === undefined ? {} : { onStreamEvent: request.onStreamEvent }),
        ...(request.onToolArgumentsDelta === undefined ? {}
          : { onToolArgumentsDelta: request.onToolArgumentsDelta }),
        ...(request.onUsageProgress === undefined ? {}
          : { onUsageProgress: request.onUsageProgress }) });
      if (request.signal?.aborted === true) return { kind: 'CANCELLED',
        providerRequestId: response.providerRequestId, usage: response.usage };
      if (response.toolCalls !== undefined && response.toolCalls.length > 0) {
        return { kind: 'TOOL_CALLS', calls: response.toolCalls, preamble: response.text,
          providerRequestId: response.providerRequestId, usage: response.usage };
      }
      return { kind: 'CONTENT', content: response.text,
        providerRequestId: response.providerRequestId, usage: response.usage };
    } catch (error) {
      if (request.signal?.aborted === true) return { kind: 'CANCELLED' };
      throw error;
    }
  }

  /** 请求解释的协议是 JSON：Anthropic 明确拒绝，不静默降级成普通讨论。 */
  async interpret(_request: ConversationInterpretationRequest): Promise<AssistResult> {
    throw structuredUnsupported();
  }

  /** 草稿辅助的协议是 JSON：Anthropic 明确拒绝。 */
  async draftAssist(_request: ComposerDraftRequest): Promise<ComposerDraftResult> {
    throw structuredUnsupported();
  }

  private async complete(input: {
    readonly system: string;
    readonly messages: readonly AnthropicMessage[];
    readonly tools?: readonly ModelToolSpec[] | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly onTextDelta?: ((text: string) => Promise<void>) | undefined;
    readonly onStreamEvent?: (() => Promise<void>) | undefined;
    readonly onToolArgumentsDelta?: ((delta: ModelToolArgumentsDelta) => Promise<void>) | undefined;
    readonly onUsageProgress?: ((progress: ModelUsageProgress) => Promise<void>) | undefined;
  }): Promise<{ text: string; toolCalls?: readonly ModelToolCall[];
    providerRequestId: string; usage: ModelUsage }> {
    const estimatedInputTokens = Math.ceil(Buffer.byteLength(JSON.stringify({
      system: input.system, messages: input.messages }), 'utf8') / 3);
    if (estimatedInputTokens + this.config.maxOutputTokens > this.callLimit) {
      throw new ModelCallBudgetError();
    }
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const signal = input.signal === undefined ? timeoutSignal
      : AbortSignal.any([input.signal, timeoutSignal]);
    const maxBytes = Math.min(this.config.maxOutputTokens * 16, 512 * 1024);
    const usage: { inputTokens: number | null; outputTokens: number | null;
      cacheReadTokens: number | null; cacheCreationTokens: number | null } = {
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
    const reportUsage = async (textBytes: number, toolBytes: number): Promise<void> => {
      if (input.onUsageProgress === undefined) return;
      await input.onUsageProgress({ inputTokensEstimate: estimatedInputTokens,
        outputTokensEstimate: Math.ceil((textBytes + toolBytes) / 3),
        providerUsage: { ...usage } });
    };
    try {
      // 请求尚未发出时先给出输入量估算：界面不必等到第一个事件才有读数。
      await reportUsage(0, 0);
      const response = await this.wireFetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json',
          // Anthropic 的原生认证头。不发 Authorization: Bearer——那是另一种协议的形状。
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01' },
        body: JSON.stringify(this.requestBody(input)),
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        // 错误体只用于诊断，且必须有界读取；原始响应绝不写日志。
        const detail = await readBoundedText(response, 8 * 1024).catch(() => '');
        throw new AnthropicHttpError(response.status,
          `anthropic messages call failed with HTTP ${response.status}${
            detail === '' ? '' : `: ${summarizeProviderError(detail)}`}`);
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      // 非流式响应按协议错误拒绝：请求声明了 stream=true，返回另一种形状说明端点不对。
      if (!contentType.includes('text/event-stream')) {
        throw new AnthropicProtocolError('anthropic messages response is not an SSE stream');
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      try {
        const result = await this.readStream(reader, {
          maxBytes, signal, tools: input.tools ?? [],
          ...(input.onTextDelta === undefined ? {} : { onTextDelta: input.onTextDelta }),
          ...(input.onStreamEvent === undefined ? {} : { onStreamEvent: input.onStreamEvent }),
          ...(input.onToolArgumentsDelta === undefined ? {}
            : { onToolArgumentsDelta: input.onToolArgumentsDelta }),
          reportUsage, usage });
        if (signal.aborted) throw new ModelTimeoutError();
        if ((usage.inputTokens !== null && usage.outputTokens !== null &&
            usage.inputTokens + usage.outputTokens > this.callLimit) ||
            (usage.outputTokens !== null && usage.outputTokens > this.config.maxOutputTokens)) {
          throw new ModelCallBudgetError(result.providerRequestId, usage);
        }
        return { text: result.text, ...(result.toolCalls.length === 0 ? {}
          : { toolCalls: result.toolCalls }),
          providerRequestId: result.providerRequestId, usage };
      } catch (error) {
        // 出错时主动取消底层流：不把半截连接留给 GC，也不让上游继续写。
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (timeoutSignal.aborted && input.signal?.aborted !== true) throw new ModelTimeoutError();
      if (input.signal?.aborted === true || isAbortByName(error)) throw error;
      throw error;
    }
  }

  private async readStream(reader: ReadableStreamDefaultReader<Uint8Array>,
    options: {
      readonly maxBytes: number;
      readonly signal: AbortSignal;
      readonly tools: readonly ModelToolSpec[];
      readonly onTextDelta?: ((text: string) => Promise<void>) | undefined;
      readonly onStreamEvent?: (() => Promise<void>) | undefined;
      readonly onToolArgumentsDelta?: ((delta: ModelToolArgumentsDelta) => Promise<void>) | undefined;
      readonly reportUsage: (textBytes: number, toolBytes: number) => Promise<void>;
      readonly usage: { inputTokens: number | null; outputTokens: number | null;
        cacheReadTokens: number | null; cacheCreationTokens: number | null };
    },
  ): Promise<{ text: string; toolCalls: readonly ModelToolCall[]; providerRequestId: string }> {
    const textParts: string[] = [];
    const toolBlocks = new Map<number, { id: string; name: string; json: string;
      seed: string }>();
    const toolCalls: ModelToolCall[] = [];
    let textBytes = 0;
    let providerRequestId = '';
    let stopReason: string | null = null;
    const decoder = new TextDecoder();
    let streamEventRecorded = false;
    let currentEvent = '';
    let pending = '';
    const handle = async (event: string, data: string): Promise<void> => {
      if (data === '' || event === 'ping') return;
      const record = asRecord(parseEventData(data));
      if (record === null) {
        throw new AnthropicProtocolError('anthropic messages event is not an object');
      }
      const type = typeof record.type === 'string' ? record.type : event;
      if (type === 'error') {
        throw new AnthropicProtocolError(`anthropic messages stream error: ${
          summarizeProviderError(JSON.stringify(record.error ?? {}))}`);
      }
      if (type === 'message_start') {
        const message = asRecord(record.message);
        if (typeof message?.id === 'string') providerRequestId = message.id;
        const startUsage = asRecord(message?.usage);
        if (startUsage !== null) {
          options.usage.inputTokens = countOrNull(startUsage.input_tokens);
          options.usage.cacheReadTokens = countOrNull(startUsage.cache_read_input_tokens);
          options.usage.cacheCreationTokens = countOrNull(startUsage.cache_creation_input_tokens);
        }
        await options.reportUsage(textBytes, accumulatedToolBytes(toolBlocks));
        return;
      }
      if (type === 'content_block_start') {
        const index = typeof record.index === 'number' ? record.index : -1;
        const block = asRecord(record.content_block);
        if (index < 0 || block === null) {
          throw new AnthropicProtocolError('anthropic content block is malformed');
        }
        const blockType = typeof block.type === 'string' ? block.type : '';
        if (blockType === 'tool_use') {
          // Anthropic 在 start 里可能给出空 input 对象；真正的参数随后以
          // input_json_delta 增量到达。这里只登记身份，不把 `{}` 当成最终参数。
          // 规范说 start 里是空 input、参数随后以 input_json_delta 到达；但部分兼容网关
          // 会直接给完整 input。两者都保留：有增量时以增量为准，没有增量时用这里的初值。
          const seed = typeof block.input === 'object' && block.input !== null &&
            !Array.isArray(block.input) && Object.keys(block.input).length > 0
            ? JSON.stringify(block.input) : '';
          toolBlocks.set(index, { id: typeof block.id === 'string' && block.id !== ''
            ? block.id : `tool-${index}`,
            name: typeof block.name === 'string' ? block.name : '', json: '', seed });
          await options.reportUsage(textBytes, accumulatedToolBytes(toolBlocks));
          return;
        }
        if (blockType === 'text' && typeof block.text === 'string' && block.text !== '') {
          textParts.push(block.text);
          textBytes += Buffer.byteLength(block.text, 'utf8');
          if (textBytes > options.maxBytes) {
            throw new ModelOutputBudgetError(providerRequestId, options.usage);
          }
          if (toolBlocks.size === 0 && options.onTextDelta !== undefined) {
            await options.onTextDelta(block.text);
          }
          await options.reportUsage(textBytes, accumulatedToolBytes(toolBlocks));
          return;
        }
        // thinking / redacted_thinking 等块：不作为正文发布，也不参与工具派发。
        return;
      }
      if (type === 'content_block_delta') {
        const index = typeof record.index === 'number' ? record.index : -1;
        const delta = asRecord(record.delta);
        if (delta === null) return;
        const deltaType = typeof delta.type === 'string' ? delta.type : '';
        if (deltaType === 'text_delta' && typeof delta.text === 'string') {
          textParts.push(delta.text);
          textBytes += Buffer.byteLength(delta.text, 'utf8');
          if (textBytes > options.maxBytes) {
            throw new ModelOutputBudgetError(providerRequestId, options.usage);
          }
          // 携带工具请求的那一轮，正文只作为前置说明；不把半个回复发布给调用方。
          if (toolBlocks.size === 0 && options.onTextDelta !== undefined) {
            await options.onTextDelta(delta.text);
          }
          await options.reportUsage(textBytes, accumulatedToolBytes(toolBlocks));
          return;
        }
        if (deltaType === 'input_json_delta') {
          const block = toolBlocks.get(index);
          if (block === undefined) {
            throw new AnthropicProtocolError('anthropic tool argument arrived before its block');
          }
          block.json += typeof delta.partial_json === 'string' ? delta.partial_json : '';
          if (Buffer.byteLength(block.json, 'utf8') > options.maxBytes) {
            throw new ModelOutputBudgetError(providerRequestId, options.usage);
          }
          if (options.onToolArgumentsDelta !== undefined) {
            await options.onToolArgumentsDelta({ toolIndex: index,
              providerToolCallId: block.id, name: block.name, argumentsText: block.json });
          }
          await options.reportUsage(textBytes, accumulatedToolBytes(toolBlocks));
          return;
        }
        // thinking_delta / signature_delta：不发布、不存储（无法安全回放到下一轮）。
        return;
      }
      if (type === 'content_block_stop') {
        const index = typeof record.index === 'number' ? record.index : -1;
        const block = toolBlocks.get(index);
        if (block === undefined) return;
        toolCalls.push(this.parseToolBlock(block, options.tools, providerRequestId,
          options.usage));
        return;
      }
      if (type === 'message_delta') {
        const delta = asRecord(record.delta);
        if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
        const deltaUsage = asRecord(record.usage);
        if (deltaUsage !== null) {
          options.usage.outputTokens = countOrNull(deltaUsage.output_tokens)
            ?? options.usage.outputTokens;
          options.usage.inputTokens = countOrNull(deltaUsage.input_tokens)
            ?? options.usage.inputTokens;
        }
        await options.reportUsage(textBytes, accumulatedToolBytes(toolBlocks));
        return;
      }
      if (type === 'message_stop') return;
      // 未知事件类型按协议错误拒绝：不假装理解，也不静默跳过可能的正文。
      throw new AnthropicProtocolError(
        `anthropic messages stream sent an unsupported event (${type})`);
    };
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!streamEventRecorded) {
        streamEventRecorded = true;
        await options.onStreamEvent?.();
      }
      pending += decoder.decode(next.value, { stream: true });
      let index = pending.indexOf('\n');
      while (index !== -1) {
        const line = pending.slice(0, index).replace(/\r$/u, '');
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
        if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue; }
        if (line.startsWith('data:')) {
          await handle(currentEvent, line.slice(5).trim());
          continue;
        }
        if (line.trim() === '') currentEvent = '';
      }
      if (pending.length > 2 * 1024 * 1024) {
        throw new AnthropicProtocolError('anthropic SSE line exceeds the size limit');
      }
    }
    if (stopReason === 'max_tokens') {
      throw new ModelOutputBudgetError(providerRequestId, options.usage);
    }
    return { text: textParts.join(''), toolCalls, providerRequestId };
  }

  private requestBody(input: { readonly system: string;
    readonly messages: readonly AnthropicMessage[];
    readonly tools?: readonly ModelToolSpec[] | undefined }): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxOutputTokens,
      system: input.system,
      messages: input.messages,
      stream: true,
      temperature: 0,
    };
    if (input.tools !== undefined && input.tools.length > 0) {
      // 工具声明用 Anthropic 自己的 `input_schema`，不沿用 OpenAI 的 `parameters` 形状。
      body.tools = input.tools.map((tool) => ({ name: tool.name,
        description: tool.description, input_schema: tool.parameters }));
    }
    return body;
  }

  private parseToolBlock(block: { id: string; name: string; json: string;
    seed: string }, tools: readonly ModelToolSpec[], providerRequestId: string,
    usage: ModelUsage): ModelToolCall {
    if (!tools.some((tool) => tool.name === block.name)) {
      throw new ModelToolOutputError(providerRequestId, usage);
    }
    const text = block.json !== '' ? block.json : block.seed;
    let parsed: unknown;
    try { parsed = JSON.parse(text === '' ? '{}' : text); }
    catch { throw new ModelToolOutputError(providerRequestId, usage); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ModelToolOutputError(providerRequestId, usage);
    }
    return { providerToolCallId: block.id, name: block.name,
      arguments: parsed as JsonObject };
  }
}

/** 结构化输出（`response_format=json_object`）在 Anthropic Messages 上不存在。 */
function structuredUnsupported(): ModelCapabilityUnsupportedError {
  return new ModelCapabilityUnsupportedError('json_object',
    'anthropic-messages does not implement response_format=json_object; '
    + 'this request is refused before any provider call instead of silently dropping the constraint');
}

/** 一次 HTTP 失败：状态码参与既有分类（`classifyProviderError` 读 `status`）。 */
class AnthropicHttpError extends Error {
  override readonly name = 'AnthropicHttpError';
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class AnthropicProtocolError extends Error {
  override readonly name = 'AnthropicProtocolError';
  constructor(message: string) {
    super(message);
  }
}

type AnthropicContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: { readonly type: 'base64';
      readonly media_type: string; readonly data: string } }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string;
      readonly input: JsonObject }
  | { readonly type: 'tool_result'; readonly tool_use_id: string;
      readonly content: string; readonly is_error?: boolean };

interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly AnthropicContentBlock[];
}

/** 与 OpenAI 端口同一形状：图片在前、正文收尾；只有图片时不补空 text 块。 */
function anthropicUserContent(turn: AssistTurn): string | readonly AnthropicContentBlock[] {
  if (turn.parts === undefined || turn.parts.length === 0) return turn.content;
  const blocks: AnthropicContentBlock[] = turn.parts.map((part: AssistContentPart) =>
    part.type === 'image'
      ? { type: 'image' as const, source: { type: 'base64' as const,
        media_type: part.mediaType, data: part.dataBase64 } }
      : { type: 'text' as const, text: part.text });
  return turn.content.trim() === '' ? blocks : [...blocks, { type: 'text', text: turn.content }];
}

/**
 * 历史工具轮次 → Anthropic 的 assistant(tool_use) + user(tool_result) 序列。
 *
 * Anthropic 要求工具结果出现在**下一条 user 消息**里（不是 tool 角色）；这是协议差异，
 * 不是策略差异——结果正文仍然只是数据，下一轮提示词已声明工具输出不是指令。
 */
function anthropicToolTurns(turns: readonly ModelToolTurn[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  for (const turn of turns) {
    for (const steer of turn.steersBefore ?? []) messages.push({ role: 'user', content: steer });
    const blocks: AnthropicContentBlock[] = [];
    const preamble = turn.preamble ?? '';
    if (preamble !== '') blocks.push({ type: 'text', text: preamble });
    for (const call of turn.calls) {
      blocks.push({ type: 'tool_use', id: call.providerToolCallId, name: call.name,
        input: call.arguments });
    }
    // Anthropic 不接受空 content；没有正文也没有工具请求的轮次（异常历史）用空字符串，
    // 而不是伪造一段正文。
    messages.push({ role: 'assistant', content: blocks.length === 0 ? '' : blocks });
    messages.push({ role: 'user', content: turn.results.map((result) =>
      ({ type: 'tool_result' as const, tool_use_id: result.providerToolCallId,
        content: result.content, ...(result.isError ? { is_error: true } : {}) })) });
  }
  return messages;
}

function parseEventData(data: string): unknown {
  try { return JSON.parse(data); }
  catch { throw new AnthropicProtocolError('anthropic messages event is not valid JSON'); }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function accumulatedToolBytes(blocks: ReadonlyMap<number, { readonly json: string }>): number {
  let total = 0;
  for (const block of blocks.values()) total += Buffer.byteLength(block.json, 'utf8');
  return total;
}

/** 错误体只保留可读摘要；不把整段上游响应写进异常或日志。 */
function summarizeProviderError(raw: string): string {
  try {
    const record = asRecord(JSON.parse(raw));
    const error = asRecord(record?.error);
    const message = typeof error?.message === 'string' ? error.message
      : typeof record?.message === 'string' ? record.message : '';
    const type = typeof error?.type === 'string' ? error.type : '';
    const summary = `${type}${type === '' ? '' : ': '}${message}`.trim();
    return summary.length > 300 ? `${summary.slice(0, 300)}…` : (summary === '' ? 'error' : summary);
  } catch {
    return 'error';
  }
}

function parseVerdict(text: string): { verdict: 'PASS' | 'FAIL' | 'UNCERTAIN'; reason: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim()); }
  catch { throw new Error('semantic verdict is not valid JSON'); }
  const record = asRecord(parsed);
  if (record !== null && Object.keys(record).sort().join(',') === 'reason,verdict' &&
      (record.verdict === 'PASS' || record.verdict === 'FAIL' || record.verdict === 'UNCERTAIN') &&
      typeof record.reason === 'string' && record.reason.trim().length > 0 &&
      record.reason.length <= 500) {
    return { verdict: record.verdict, reason: record.reason.trim() };
  }
  throw new Error('semantic verdict is not a valid JSON verdict');
}
