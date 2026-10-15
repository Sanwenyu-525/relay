import { createHash } from 'node:crypto';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { DEFAULT_FAKE_SCENARIO, isFakeScenario, } from './context-fixture.js';
/** 缺资料时声明缺失的输入名（供 DRAFT 记录证据；P05 不尝试补齐）。 */
export const MISSING_MATERIAL_INPUT = 'material';
/**
 * 确定性 FakeModelPort：无网络、无随机、无时间依赖。
 *
 * 场景由 Manifest payload 的 `fake_scenario` 决定；同输入必得同输出（含 provider_request_id 与用量）。
 * 这样测试可以断言“去重/重放不重跑”，也可以断言各场景的稳定行为。
 *
 * P06 追加：合法候选带一个可识别的引用标记，使 `citation-exists-v1` 能 PASS；
 * `CITATION_MISSING_ONCE` 只在修正轮（manifest.correction.round ≥ 1）补上引用，让修正回路收敛。
 *
 * M04 Assist：按 intent 返回确定性回复或提案 JSON；触发串仅用于测试
 * （真实端口不解释这些标记），生产 Mock 路径不会包含它们。
 */
export class FakeModelPort {
    delayMs;
    identity = {
        provider: 'fake', model: 'fake-model-v1',
        configFingerprint: createHash('sha256').update('fake-model-v1').digest('hex'),
    };
    constructor(delayMs = 0) {
        this.delayMs = delayMs;
    }
    async generate(request) {
        if (this.delayMs > 0 && request.signal?.aborted !== true) {
            if (process.env.NODE_ENV === 'test')
                process.stdout.write('{"type":"mock_model_started"}\n');
            await new Promise((resolve) => {
                const onAbort = () => {
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(() => {
                    request.signal?.removeEventListener('abort', onAbort);
                    resolve();
                }, this.delayMs);
                request.signal?.addEventListener('abort', onAbort, { once: true });
            });
        }
        if (request.signal?.aborted === true) {
            if (this.delayMs > 0 && process.env.NODE_ENV === 'test') {
                process.stdout.write('{"type":"mock_model_cancelled"}\n');
            }
            return { kind: 'CANCELLED' };
        }
        const scenario = readScenario(request.manifest);
        const title = readNestedString(request.manifest, ['task', 'title']) ?? '候选交付';
        const objective = readNestedString(request.manifest, ['contract', 'objective']) ?? '未提供目标';
        const correctionRound = readCorrectionRound(request.manifest);
        // 冻结的工具脚本按轮次确定性推进：请求里已有的历史轮次决定这次发第几轮，
        // 脚本耗尽后回到普通生成。这样测试可以断言「模型真的按工具结果走完了序列」，
        // 而不是拿到一份预制答案。
        const scripted = await scriptedToolRound(request);
        if (scripted !== undefined)
            return scripted;
        switch (scenario) {
            case 'SCHEMA_INVALID':
                return {
                    kind: 'SCHEMA_INVALID',
                    reason: '候选正文缺少必需小节：## 结论。',
                    raw: renderWithoutConclusion(title, objective),
                };
            case 'MISSING_MATERIAL':
                return { kind: 'MISSING_MATERIAL', missing: [MISSING_MATERIAL_INPUT] };
            case 'NO_CITATION':
                return contentResult(request, renderCandidate(title, objective, { citation: false }));
            case 'SEMANTIC_UNSUPPORTED':
                return contentResult(request, renderCandidate(title, objective, { marker: 'EVIDENCE_UNSUPPORTED' }));
            case 'SEMANTIC_UNCERTAIN':
                return contentResult(request, renderCandidate(title, objective, { marker: 'SEMANTIC_UNCERTAIN' }));
            case 'CITATION_MISSING_ONCE':
                return contentResult(request, renderCandidate(title, objective, { citation: correctionRound >= 1 }));
            case 'CHECKER_ERROR':
            case 'LEGAL':
            default:
                return contentResult(request, renderCandidate(title, objective, { citation: true }));
        }
    }
    /** Assist 确定性回复：DISCUSS 回显最后一条用户消息；提案意图返回可通过
     * 应用层 schema 校验的 JSON。`FAKE_ASSIST_*` 触发串只服务测试断言。 */
    async assist(request) {
        const lastUser = [...request.turns].reverse().find((turn) => turn.role === 'user');
        // B 档只读轮次：声明了工具时按冻结脚本逐轮发出请求，脚本耗尽后回到普通回复。
        // 触发串只服务测试断言，真实端口不解释它。
        if (request.tools !== undefined && request.tools.length > 0) {
            const scripted = scriptedAssistToolRound(request);
            if (scripted !== undefined)
                return scripted;
        }
        // Skill 在原始用户轮次后另附一段权威事实；测试触发串仍取原始用户轮次。
        const trigger = request.skill === undefined ? lastUser?.content ?? '' :
            request.turns.filter((turn) => turn.role === 'user').at(-2)?.content ?? '';
        if (trigger.includes('FAKE_ASSIST_ABORT')) {
            await new Promise((resolve) => {
                if (request.signal?.aborted === true) {
                    resolve();
                    return;
                }
                request.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            if (request.signal?.aborted === true)
                return { kind: 'CANCELLED' };
        }
        if (trigger.includes('FAKE_ASSIST_THROW')) {
            throw new Error('fake assist model failure');
        }
        const seed = seedOf(lastUser?.content ?? request.system);
        const providerRequestId = `fake-assist-${seed}`;
        // Fake 无真实 Provider，不伪造缓存用量：显式 null 让 UI 显示"未采集"而非 0%。
        const usage = {
            inputTokens: Math.max(1, Math.ceil((request.system.length +
                request.turns.reduce((sum, turn) => sum + turn.content.length, 0)) / 4)),
            outputTokens: 0,
            cacheReadTokens: null,
            cacheCreationTokens: null,
        };
        if (request.skill !== undefined) {
            const facts = request.skill.facts;
            let proposal;
            if (request.skill.id === 'task-to-execution-contract') {
                const acceptance = facts.acceptance;
                const existing = Array.isArray(acceptance.criteria) ? acceptance.criteria : [];
                proposal = { objective: String(acceptance.objective ?? '明确任务结果'),
                    expected_outputs: { kind: 'MARKDOWN_DOCUMENT',
                        ...(request.skill.version === '1.1.0'
                            ? { description: '交付一份可核对的 Markdown 结果说明。' } : {}) },
                    criteria: [...(existing.length === 0
                            ? [{ statement: '存在可核对的交付说明。', required: true, method: 'HUMAN' }]
                            : existing.map((entry) => {
                                const criterion = entry;
                                return { statement: String(criterion.statement),
                                    required: criterion.required === true, method: String(criterion.method) };
                            })),
                        { statement: '交付内容包含可核对的新增摘要。', required: true,
                            method: 'MARKDOWN_STRUCTURE' }],
                    suggested_mode: 'ME' };
            }
            else if (request.skill.id === 'verification-plan') {
                const checks = Array.isArray(facts.registered_checks) ? facts.registered_checks : [];
                proposal = request.skill.version === '1.1.0'
                    ? { additional_checks: [{ statement: '交付内容包含可核对的结论摘要。',
                                required: true, method: 'MARKDOWN_STRUCTURE' }] }
                    : { checks: checks.map((entry) => {
                            const check = entry;
                            return { criterion_id: String(check.criterion_id),
                                checker_id: String(check.checker_id), required: check.required === true };
                        }) };
            }
            else if (request.skill.id === 'goal-to-project-blueprint') {
                const view = facts.view_configuration;
                const state = facts.state;
                proposal = { intent: String(request.skill.input?.desired_outcome ??
                        '将当前项目目标拆分为可审查的下一步'),
                    goal_id: request.skill.input?.goal_id ?? null,
                    phase_key: String(state.phase_key),
                    tasks: [{ local_key: 'next', title: '整理项目下一步',
                            objective: '形成可供人工审查的项目下一步清单' }],
                    next_action: { kind: 'NEW_TASK', local_key: 'next' },
                    view_kind: String(view.kind) };
            }
            else {
                const project = facts.project;
                proposal = { highlights: [{ statement: '当前项目状态已读取。',
                            ref_kind: 'PROJECT', ref_id: String(project.id) }], next_steps: [] };
            }
            const raw = trigger.includes('FAKE_ASSIST_BAD_JSON') ? '{bad' :
                JSON.stringify({ summary: '（Fake Assist）已依据当前事实生成建议。', proposal });
            return { kind: 'CONTENT', content: raw, providerRequestId,
                usage: { ...usage, outputTokens: Math.max(1, Math.ceil(raw.length / 4)) } };
        }
        if (request.intent === 'DISCUSS') {
            const reply = `（Fake Assist）已收到：${(lastUser?.content ?? '').slice(0, 200)}`;
            if (request.skill === undefined)
                await request.onTextDelta?.(reply);
            return { kind: 'CONTENT', content: reply, providerRequestId,
                usage: { ...usage, outputTokens: Math.max(1, Math.ceil(reply.length / 4)) } };
        }
        if (request.intent === 'IMPACT_CHECK') {
            let firstTarget = null;
            try {
                const input = JSON.parse(lastUser?.content ?? '');
                firstTarget = input.direct_targets?.[0]?.version_id ?? null;
            }
            catch { /* invalid input is rejected by the caller's output validation */ }
            const raw = JSON.stringify({ possibly_related: firstTarget === null ? [] : [{
                        target_version_id: firstTarget, reason: 'Fake 模型建议人工核对该直接引用的语义影响。'
                    }] });
            return { kind: 'CONTENT', content: raw, providerRequestId,
                usage: { ...usage, outputTokens: Math.max(1, Math.ceil(raw.length / 4)) } };
        }
        if (request.intent === 'IMPACT_CANDIDATE') {
            let targetText = '';
            try {
                targetText = JSON.parse(lastUser?.content ?? '').target_text ?? '';
            }
            catch { /* invalid input remains an invalid candidate */ }
            const raw = JSON.stringify({ markdown: `${targetText}\n\n> Fake 候选：请核对新来源后决定是否应用。\n` });
            return { kind: 'CONTENT', content: raw, providerRequestId,
                usage: { ...usage, outputTokens: Math.max(1, Math.ceil(raw.length / 4)) } };
        }
        const body = request.intent === 'PROPOSE_CANDIDATE'
            ? { summary: `（Fake Assist）已生成候选 Markdown（${seed.slice(0, 8)}）。`,
                proposal: { title: `候选 ${seed.slice(0, 8)}`,
                    markdown: `# 候选 ${seed.slice(0, 8)}\n\n由 Fake Assist 确定性生成。\n` } }
            : { summary: `（Fake Assist）已生成任务定义提案（${seed.slice(0, 8)}）。`,
                proposal: { title: `新任务 ${seed.slice(0, 8)}`,
                    objective: `按会话讨论推进：${(lastUser?.content ?? '').slice(0, 120)}`,
                    criteria: [{ statement: '存在可核对的交付说明。', required: true, method: 'HUMAN' }],
                    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' } } };
        const raw = trigger.includes('FAKE_ASSIST_BAD_JSON')
            ? '{"summary":"broken" "proposal":'
            : JSON.stringify(body);
        return { kind: 'CONTENT', content: raw, providerRequestId,
            usage: { ...usage, outputTokens: Math.max(1, Math.ceil(raw.length / 4)) } };
    }
    /** 确定性请求解释：只回候选 JSON。触发串 `FAKE_INTERPRET_DISCUSS` /
     * `FAKE_INTERPRET_CLARIFY` / `FAKE_INTERPRET_BAD_JSON` 只服务测试断言。 */
    async interpret(request) {
        const content = request.userContent;
        const providerRequestId = `fake-interpret-${seedOf(content).slice(0, 16)}`;
        const usage = { inputTokens: Math.max(1, Math.ceil((request.system.length + content.length) / 4)), outputTokens: 0,
            cacheReadTokens: null, cacheCreationTokens: null };
        if (request.signal?.aborted === true)
            return { kind: 'CANCELLED' };
        let body;
        if (content.includes('FAKE_INTERPRET_DISCUSS')) {
            body = { decision: 'DISCUSS' };
        }
        else if (content.includes('FAKE_INTERPRET_CLARIFY')) {
            body = { decision: 'CLARIFY', questions: ['这次要改的是哪个文件或哪段功能？'] };
        }
        else {
            body = { decision: 'PREPARE', task: { title: content.slice(0, 60),
                    objective: content.slice(0, 400),
                    criteria: [{ statement: '存在可核对的交付说明。', required: true, method: 'HUMAN' }],
                    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
                    file_changes: [] } };
        }
        const raw = content.includes('FAKE_INTERPRET_BAD_JSON') ? '{"decision":' : JSON.stringify(body);
        return { kind: 'CONTENT', content: raw, providerRequestId,
            usage: { ...usage, outputTokens: Math.max(1, Math.ceil(raw.length / 4)) } };
    }
}
async function contentResult(request, content) {
    await request.onTextDelta?.(content);
    return {
        kind: 'CONTENT',
        content,
        providerRequestId: providerRequestIdOf(request),
        usage: usageOf(request.manifest, content),
    };
}
/**
 * Manifest 上的 `tool_script` 是测试专用的冻结脚本：`[{ name, arguments }, ...]`，
 * 每个元素是一轮里要发出的一个工具请求。返回本轮应发出的请求；脚本已耗尽返回 undefined。
 * 真实端口不解释这个字段，生产 Mock 路径不会包含它。
 */
async function scriptedToolRound(request) {
    const script = readNestedValue(request.manifest, ['tool_script']);
    if (!Array.isArray(script))
        return undefined;
    const consumed = request.toolTurns?.length ?? 0;
    const round = script[consumed];
    if (!Array.isArray(round) || round.length === 0)
        return undefined;
    const calls = [];
    for (const [ordinal, item] of round.entries()) {
        if (typeof item !== 'object' || item === null || Array.isArray(item))
            return undefined;
        const entry = item;
        if (typeof entry.name !== 'string' || typeof entry.arguments !== 'object' ||
            entry.arguments === null || Array.isArray(entry.arguments))
            return undefined;
        calls.push({ providerToolCallId: `fake-tool-${consumed}-${ordinal}`,
            name: entry.name, arguments: entry.arguments });
    }
    // Fake 脚本不模拟边说话边调工具；真实形态由 OpenAiCompatibleModelPort 的单测覆盖。
    return { kind: 'TOOL_CALLS', calls, preamble: '',
        providerRequestId: `fake-tools-${consumed}`,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null } };
}
function seedOf(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
/**
 * Assist 侧的冻结工具脚本：从首条用户消息里的 `FAKE_ASSIST_TOOLS <json>` 读出
 * `[[{name,arguments}], ...]`，按已结算的历史轮次推进。
 *
 * 与 generate 侧的 manifest 脚本同形，刻意放在消息里而不是给端口另加一个参数：
 * Assist 端口的请求形状由应用层冻结，测试注入不改变它。脚本里的工具名必须在
 * 本次声明的词表内——不声明的工具不会被 Fake 发出来冒充模型越权。
 */
function scriptedAssistToolRound(request) {
    const lastUser = [...request.turns].reverse().find((turn) => turn.role === 'user');
    const trigger = lastUser?.content ?? '';
    const marker = 'FAKE_ASSIST_TOOLS ';
    const start = trigger.indexOf(marker);
    if (start < 0)
        return undefined;
    const raw = (trigger.slice(start + marker.length).split('\n')[0] ?? '').trim();
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (!Array.isArray(parsed))
        return undefined;
    const consumed = request.toolTurns?.length ?? 0;
    const round = parsed[consumed];
    if (!Array.isArray(round) || round.length === 0)
        return undefined;
    const declared = new Map((request.tools ?? []).map((spec) => [spec.name, spec]));
    const calls = [];
    for (const [ordinal, item] of round.entries()) {
        if (typeof item !== 'object' || item === null || Array.isArray(item))
            return undefined;
        const entry = item;
        if (typeof entry.name !== 'string' || !declared.has(entry.name))
            return undefined;
        const args = entry.arguments;
        calls.push({ providerToolCallId: `fake-assist-tool-${consumed}-${ordinal}`,
            name: entry.name,
            arguments: typeof args === 'object' && args !== null && !Array.isArray(args)
                ? args : {} });
    }
    return { kind: 'TOOL_CALLS', calls, preamble: '',
        providerRequestId: `fake-assist-tools-${consumed}`,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null } };
}
function readScenario(manifest) {
    const value = manifest.fake_scenario;
    return typeof value === 'string' && isFakeScenario(value) ? value : DEFAULT_FAKE_SCENARIO;
}
/** 修正轮次来自 Manifest 的 `correction.round`；缺省与 round 0 等价。 */
function readCorrectionRound(manifest) {
    const value = readNestedValue(manifest, ['correction', 'round']);
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}
/**
 * 合法候选：含一级标题与全部必需二级节，且每节非空。
 * 引用标记形如 `参考资料：[Relay 设计系统](https://example.invalid/relay)`，域名不可解析，不声称论断被支持。
 */
function renderCandidate(title, objective, options = {}) {
    const citation = options.citation === false ? [] : CITATION_LINE;
    const marker = options.marker === undefined ? [] : ['', `语义标记：${options.marker}`];
    return [
        `# ${title}`,
        '',
        '## 摘要',
        '',
        `本候选依据目标“${objective}”生成，覆盖固定必需结构。`,
        ...marker,
        '',
        '## 结论',
        '',
        `结论：已按目标“${objective}”给出候选交付，等待验证。`,
        ...citation,
        '',
    ].join('\n');
}
const CITATION_LINE = [
    '',
    '参考资料：[Relay 设计系统](https://example.invalid/relay)',
];
/** 结构错误候选：缺少 `## 结论` 必需节。 */
function renderWithoutConclusion(title, objective) {
    return [
        `# ${title}`,
        '',
        '## 摘要',
        '',
        `本候选依据目标“${objective}”生成，但缺少必需小节。`,
        '',
    ].join('\n');
}
/** provider 请求身份由输入摘要确定性派生，便于测试断言“同输入同输出”。 */
function providerRequestIdOf(request) {
    const digest = createHash('sha256')
        .update(canonicalizeJson({
        manifest: request.manifest,
        output_schema: request.outputSchema,
    }), 'utf8')
        .digest('hex');
    return `fake-${digest.slice(0, 32)}`;
}
/** 用量按规范编码长度估算，保持确定性；P05 不承诺真实计费口径。 */
function usageOf(manifest, content) {
    const inputLength = canonicalizeJson(manifest).length;
    const outputLength = content.length;
    return {
        inputTokens: Math.max(1, Math.ceil(inputLength / 4)),
        outputTokens: Math.max(1, Math.ceil(outputLength / 4)),
        cacheReadTokens: null,
        cacheCreationTokens: null,
    };
}
function readNestedString(manifest, path) {
    const value = readNestedValue(manifest, path);
    return typeof value === 'string' ? value : undefined;
}
function readNestedValue(manifest, path) {
    let current = manifest;
    for (const key of path) {
        if (typeof current !== 'object' || current === null || Array.isArray(current)) {
            return undefined;
        }
        current = current[key];
    }
    return current;
}
