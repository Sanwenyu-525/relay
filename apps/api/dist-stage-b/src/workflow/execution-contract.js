import { createHash } from 'node:crypto';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import { DEFAULT_EXECUTION_CONFIG_VERSION, WORKFLOW_KEY, WORKFLOW_VERSION, } from './markdown-deliverable.js';
/**
 * 创建 Run 时冻结的执行契约（contracts/02-state-and-execution.md 第 3 节、
 * docs/database/physical-design-postgresql.md 第 2 节）。
 *
 * 契约一旦随 Run 冻结即不可变：BUILD_CONTEXT 只装配上下文，不重写这份快照。
 * 快照摘要用固定版本的规范 JSON 编码再算 SHA-256，禁止用 JSON.stringify 的键顺序，
 * 否则同一语义内容会得到不同摘要。
 */
export const CONTRACT_SOURCE_DELEGATE = 'DELEGATE';
/** 契约摘要使用的算法（与 command_receipts 的 payload_hash_algorithm 保持一致）。 */
export const CONTRACT_HASH_ALGORITHM = 'sha256';
/** 首批工具循环的循环预算上限；Delegate 只接受不超过这些值的请求。 */
export const TOOL_LOOP_MAX_ROUNDS = 12;
export const TOOL_LOOP_MAX_TOOL_CALLS = 48;
// 与 delegate-task 的同名清单保持一致：信封允许写入与受控命令，但那只说明「模型可以
// 请求」，不代表放行——准入仍由当前 Permission 与本次范围授权决定。
const TOOL_LOOP_CAPABILITIES = ['FILE_QUERY', 'FILE_READ', 'GIT_READ', 'FILE_WRITE', 'CLI_RUN'];
export function readToolLoopAction(snapshot) {
    const value = snapshot.tool_loop_action;
    if (value === undefined)
        return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('frozen tool loop action is invalid');
    }
    const action = value;
    const connections = action.connections;
    if (action.intent_key !== 'tool-loop-v1' || typeof action.resource_id !== 'string' ||
        action.resource_id === '' || typeof connections !== 'object' || connections === null ||
        Array.isArray(connections) || !Array.isArray(action.allowed_tools) ||
        action.allowed_tools.length === 0 ||
        action.allowed_tools.some((name) => typeof name !== 'string' || name === '') ||
        !Number.isInteger(action.max_rounds) || action.max_rounds < 1 ||
        action.max_rounds > TOOL_LOOP_MAX_ROUNDS ||
        !Number.isInteger(action.max_tool_calls) || action.max_tool_calls < 1 ||
        action.max_tool_calls > TOOL_LOOP_MAX_TOOL_CALLS) {
        throw new Error('frozen tool loop action is invalid');
    }
    const resolved = {};
    for (const [capability, connectionId] of Object.entries(connections)) {
        if (!TOOL_LOOP_CAPABILITIES.includes(capability) || typeof connectionId !== 'string' ||
            connectionId === '') {
            throw new Error('frozen tool loop action is invalid');
        }
        resolved[capability] = connectionId;
    }
    return { intent_key: 'tool-loop-v1', resource_id: action.resource_id,
        connections: resolved, allowed_tools: action.allowed_tools,
        max_rounds: action.max_rounds, max_tool_calls: action.max_tool_calls };
}
export function readFileWriteAction(snapshot) {
    const value = snapshot.file_write_action;
    if (value === undefined)
        return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('frozen Mock file write action is invalid');
    }
    const action = value;
    if (typeof action.operation_id !== 'string' || action.intent_key !== 'file-write-v1' ||
        typeof action.connection_id !== 'string' || typeof action.resource_id !== 'string' ||
        !Array.isArray(action.changes) || action.changes.length === 0 || action.changes.length > 16 ||
        action.changes.some((item) => typeof item !== 'object' || item === null || Array.isArray(item) ||
            typeof item.path !== 'string' || item.path === '' ||
            !['CREATE', 'MODIFY', 'DELETE'].includes(String(item.action)) ||
            (item.content !== undefined && typeof item.content !== 'string') ||
            (item.baselineSha256 !== undefined && typeof item.baselineSha256 !== 'string') ||
            (item.targetSha256 !== undefined && typeof item.targetSha256 !== 'string'))) {
        throw new Error('frozen Mock file write action is invalid');
    }
    return action;
}
export function readFileReadAction(snapshot) {
    const value = snapshot.file_read_action;
    if (value === undefined)
        return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('frozen Mock file read action is invalid');
    }
    const action = value;
    if (typeof action.operation_id !== 'string' || action.intent_key !== 'mock-file-read-v1' ||
        typeof action.connection_id !== 'string' || typeof action.resource_id !== 'string' ||
        typeof action.relative_target !== 'string' || action.relative_target === '' ||
        action.relative_target.includes('\u0000')) {
        throw new Error('frozen Mock file read action is invalid');
    }
    return action;
}
export function readWebFetchAction(snapshot) {
    const value = snapshot.web_fetch_action;
    if (value === undefined)
        return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('frozen Mock web fetch action is invalid');
    }
    const action = value;
    if (typeof action.operation_id !== 'string' || action.intent_key !== 'mock-web-fetch-v1' ||
        typeof action.connection_id !== 'string' || typeof action.url !== 'string' ||
        action.url === '') {
        throw new Error('frozen Mock web fetch action is invalid');
    }
    return action;
}
/** 统一读取冻结 Mock 意图的操作身份。 */
export function readMockActionOperationId(snapshot) {
    return readMockGatewayAction(snapshot)?.operation_id ??
        readFileReadAction(snapshot)?.operation_id ?? readWebFetchAction(snapshot)?.operation_id ??
        readFileWriteAction(snapshot)?.operation_id;
}
export function readCliRunAction(snapshot) {
    const value = snapshot.cli_run_action;
    if (value === undefined)
        return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('frozen CLI run action is invalid');
    }
    const action = value;
    if (typeof action.operation_id !== 'string' || action.intent_key !== 'cli-run-v1' ||
        typeof action.connection_id !== 'string' || typeof action.resource_id !== 'string' ||
        typeof action.executable !== 'string' || action.executable.trim() === '' ||
        action.executable.includes('\u0000') || !Array.isArray(action.args) ||
        action.args.length === 0 || !action.args.every((item) => typeof item === 'string') ||
        action.args.some((item) => item.includes('\u0000')) ||
        (action.max_output_bytes !== undefined &&
            (typeof action.max_output_bytes !== 'number' || !Number.isInteger(action.max_output_bytes) ||
                action.max_output_bytes < 0 || action.max_output_bytes > 1048576))) {
        throw new Error('frozen CLI run action is invalid');
    }
    return action;
}
/**
 * Validates the frozen action set once, for every reader.
 *
 * A Run may read before its DRAFT and then, still before the candidate is published,
 * write the files and run one bounded check command. The Fake marker write stays
 * exclusive because it is a Mock capability, not a real project effect.
 */
export function readFrozenRunActions(snapshot) {
    const fileRead = readFileReadAction(snapshot);
    const web = readWebFetchAction(snapshot);
    if (fileRead !== undefined && web !== undefined) {
        throw new Error('frozen contract carries more than one read action');
    }
    if (readToolLoopAction(snapshot) !== undefined && (fileRead !== undefined || web !== undefined)) {
        // 固定读取与自主工具循环都会在同一 Run 内读取；两者并存会让「这次读取证据是谁」
        // 变得不确定，因此只允许其一。
        throw new Error('frozen tool loop cannot be combined with a fixed read action');
    }
    const marker = readMockGatewayAction(snapshot);
    const fileWrite = readFileWriteAction(snapshot);
    const cliRun = readCliRunAction(snapshot);
    if (marker !== undefined && (fileWrite !== undefined || cliRun !== undefined)) {
        throw new Error('frozen Mock marker write cannot be combined with a real write or check');
    }
    if (marker !== undefined && (fileRead !== undefined || web !== undefined)) {
        throw new Error('frozen Mock marker write cannot be combined with a read');
    }
    const read = fileRead !== undefined ? { kind: 'READ', ...fileRead }
        : web !== undefined ? { kind: 'WEB', ...web } : undefined;
    const writes = marker !== undefined
        ? [{ kind: 'WRITE', ...marker }]
        : fileWrite !== undefined
            ? [{ kind: 'FILE_WRITE', ...fileWrite },
                ...(cliRun === undefined ? [] : [{ kind: 'CLI', ...cliRun }])]
            : cliRun === undefined ? [] : [{ kind: 'CLI', ...cliRun }];
    return { read, writes };
}
/**
 * Frozen operation identities in execution order: a read first, then the write or check.
 * A repeated delivery replays the same identities; it never creates a second operation.
 */
export function readFrozenActionOperationIds(snapshot) {
    const { read, writes } = readFrozenRunActions(snapshot);
    return [read?.operation_id, ...writes.map((write) => write.operation_id)]
        .filter((id) => id !== undefined);
}
/** The single frozen action a Run contract still has to settle, in execution order. */
export function readFrozenActionOperationId(snapshot, settled) {
    return readFrozenActionOperationIds(snapshot).find((id) => !settled.has(id));
}
const CONTEXT_SOURCE_KINDS = ['KNOWLEDGE', 'MEMORY', 'DECISION'];
export function readContextSources(snapshot) {
    const value = snapshot.context_sources;
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error('frozen context sources are invalid');
    return value.map((entry) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new Error('frozen context sources are invalid');
        }
        const source = entry;
        if (typeof source.kind !== 'string' || !CONTEXT_SOURCE_KINDS.includes(source.kind) ||
            typeof source.root_id !== 'string' || typeof source.version !== 'string' ||
            !/^[1-9][0-9]*$/u.test(source.version)) {
            throw new Error('frozen context sources are invalid');
        }
        return { kind: source.kind,
            root_id: source.root_id, version: source.version };
    });
}
export function readMockGatewayAction(snapshot) {
    const value = snapshot.mock_gateway_action;
    if (value === undefined)
        return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('frozen Mock Gateway action is invalid');
    }
    const action = value;
    if (typeof action.operation_id !== 'string' || action.intent_key !== 'mock-write-marker-v1' ||
        typeof action.connection_id !== 'string' || typeof action.resource_id !== 'string' ||
        typeof action.target !== 'string' || typeof action.content !== 'string') {
        throw new Error('frozen Mock Gateway action is invalid');
    }
    return action;
}
/**
 * 从 Task 当前验收版本与 criteria 生成冻结快照与摘要。
 *
 * 只接受已经读取到的验收事实（objective/expected_outputs/criteria），不在本函数内查询数据库，
 * 因此 workflow 层不反向依赖应用协调器，也不自行决定“当前”验收版本。
 */
export function freezeExecutionContract(input) {
    const workflowKey = input.workflowKey ?? WORKFLOW_KEY;
    const workflowVersion = input.workflowVersion ?? WORKFLOW_VERSION;
    const executionConfigVersion = input.executionConfigVersion ?? DEFAULT_EXECUTION_CONFIG_VERSION;
    const criteria = input.criteria.map((criterion) => ({
        criterion_id: criterion.criterionId,
        statement: criterion.statement,
        required: criterion.required,
        method: criterion.method,
        target_spec: criterion.targetSpec,
        ...(criterion.checkerId === undefined ? {} : { checker_id: criterion.checkerId }),
    }));
    const snapshot = {
        source: CONTRACT_SOURCE_DELEGATE,
        task_id: input.taskId,
        acceptance_revision: toDecimalString(input.acceptanceRevision),
        objective: input.objective,
        expected_outputs: input.expectedOutputs,
        criteria,
        rule_revision: toDecimalString(input.ruleRevision ?? 0n),
        rule_refs: input.ruleRefs ?? [],
        workflow: {
            key: workflowKey,
            version: workflowVersion,
        },
        execution_config_version: executionConfigVersion,
        ...(input.mockGatewayAction === undefined ? {} : { mock_gateway_action: { ...input.mockGatewayAction } }),
        ...(input.fileReadAction === undefined ? {} : { file_read_action: { ...input.fileReadAction } }),
        ...(input.webFetchAction === undefined ? {} : { web_fetch_action: { ...input.webFetchAction } }),
        ...(input.fileWriteAction === undefined ? {} : { file_write_action: { ...input.fileWriteAction,
                changes: input.fileWriteAction.changes.map((change) => ({ ...change })) } }),
        ...(input.cliRunAction === undefined ? {} : { cli_run_action: { ...input.cliRunAction,
                args: [...input.cliRunAction.args] } }),
        ...(input.toolLoopAction === undefined ? {} : { tool_loop_action: { ...input.toolLoopAction,
                connections: { ...input.toolLoopAction.connections },
                allowed_tools: [...input.toolLoopAction.allowed_tools] } }),
        ...(input.contextSources === undefined || input.contextSources.length === 0 ? {} :
            { context_sources: input.contextSources.map((source) => ({ ...source })) }),
    };
    const contractHash = createHash(CONTRACT_HASH_ALGORITHM)
        .update(canonicalizeJson(snapshot), 'utf8')
        .digest();
    return {
        workflowKey,
        workflowVersion,
        executionConfigVersion,
        snapshot,
        contractHash,
    };
}
