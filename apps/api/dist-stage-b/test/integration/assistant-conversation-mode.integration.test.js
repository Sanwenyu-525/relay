import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';
import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { createAssistantProfile, reviseAssistantProfile, archiveAssistantProfile } from '../../src/application/assistant-profile-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { toDecimalString } from '../../src/shared/decimal.js';
import { createDataRoot, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
/**
 * 会话模式与人设 助手配置的真实 PG 出口（迁移 0059）。
 *
 * 覆盖三类事实：
 *   * assistant_profiles 的作用域唯一性、revision CAS 与归档；
 *   * assist_sessions 建立时冻结模式与人设快照，之后不可改写；
 *   * 既有会话按 AGENT 读出，不虚构 助手 关系；同 command_id 异载荷被拒。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-assistant-readonly-session');
let dataRoot;
let api;
before(async () => {
    await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
    dataRoot = await createDataRoot();
    api = await startTestApi();
});
after(async () => {
    if (api !== undefined)
        await api.stop();
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
});
async function workspace(title) {
    const workspaceId = randomUUID();
    await withTransaction(app.db, async (repositories) => {
        await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `${title}-${workspaceId.slice(0, 8)}` });
        await repositories.workspaces.insertAuthorityRow(workspaceId);
    });
    return workspaceId;
}
async function countSessions(workspaceId) {
    return (await sql `select exists(
    select 1 from assist_sessions where workspace_id = ${workspaceId}) as present`
        .execute(app.db)).rows[0]?.present === true ? 1 : 0;
}
function codeOf(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : undefined;
}
/** 契约第 1 节：revision 在 JSON 与回执里都是十进制字符串。 */
function revisionOf(result) {
    return BigInt(String(result.revision));
}
/** validationFailed 把逐项问题放在 fieldErrors 里，detail 只是总述。 */
function problemText(error) {
    if (typeof error !== 'object' || error === null)
        return '';
    const problems = error.fieldErrors;
    if (!Array.isArray(problems))
        return '';
    return problems.map((problem) => typeof problem === 'object' && problem !== null
        ? Object.values(problem).join(' ') : String(problem)).join(' ');
}
test('0059：assist_sessions 增五列且 CHECK 绑定模式与 助手', async () => {
    const columns = (await sql `
    select column_name from information_schema.columns
    where table_name = 'assist_sessions'
      and column_name in ('conversation_mode','assistant_profile_id','assistant_profile_revision',
        'assistant_role_snapshot','remember')
    order by column_name`.execute(app.db)).rows.map((row) => row.column_name);
    assert.deepEqual(columns, ['assistant_profile_id', 'assistant_profile_revision', 'assistant_role_snapshot', 'conversation_mode', 'remember']);
    const workspaceId = await workspace('mode-check');
    // BOT 必须带 assistant_profile_id，缺 助手的会话插不进去。
    await assert.rejects(() => sql `
    insert into assist_sessions (id, workspace_id, project_id, task_id, title,
      conversation_mode, assistant_profile_id)
    values (${randomUUID()}, ${workspaceId}, null, null, '缺 助手的 BOT 会话', 'ASSISTANT', null)`
        .execute(app.db));
    // AGENT 不得携带 助手 字段，避免「普通会话其实挂着人设」的形态。
    const created = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
        name: '审读', roleDescription: '只读复核' });
    const botId = created.result.assistant_profile_id;
    await assert.rejects(() => sql `
    insert into assist_sessions (id, workspace_id, project_id, task_id, title,
      conversation_mode, assistant_profile_id, assistant_profile_revision, assistant_role_snapshot)
    values (${randomUUID()}, ${workspaceId}, null, null, '挂着 助手的 AGENT 会话', 'AGENT',
      ${botId}, 1, ${JSON.stringify({ name: '审读' })}::jsonb)`.execute(app.db));
});
test('既有会话按 AGENT 读出，且不虚构 助手 关系', async () => {
    const workspaceId = await workspace('legacy-agent');
    await sql `insert into assist_sessions (id, workspace_id, project_id, task_id, title)
    values (${randomUUID()}, ${workspaceId}, null, null, '迁移前的旧会话')`.execute(app.db);
    const row = (await sql `
    select conversation_mode, assistant_profile_id, assistant_profile_revision, assistant_role_snapshot, remember
    from assist_sessions where workspace_id = ${workspaceId}`.execute(app.db)).rows[0];
    assert.equal(row?.conversation_mode, 'AGENT');
    assert.equal(row?.assistant_profile_id, null);
    assert.equal(row?.assistant_profile_revision, null);
    assert.equal(row?.assistant_role_snapshot, null);
    assert.equal(row?.remember, true);
});
test('assistant_profiles 同 workspace 活跃名唯一，归档后可重用', async () => {
    const workspaceId = await workspace('助手-names');
    const first = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
        name: '审读', roleDescription: '只读复核', tone: '简短' });
    const botId = first.result.assistant_profile_id;
    await assert.rejects(() => createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
        name: '审读', roleDescription: '另一个同名助手' }), (error) => {
        assert.equal(codeOf(error), 'VALIDATION_FAILED');
        assert.match(problemText(error), /同名/);
        return true;
    });
    const archived = await archiveAssistantProfile(app.db, { workspaceId, assistantProfileId: botId,
        commandId: randomUUID(), expectedRevision: toDecimalString(revisionOf(first.result)) });
    assert.equal(archived.result.status, 'ARCHIVED');
    // 归档后同名可再建，且旧行不被改动。
    const reused = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
        name: '审读', roleDescription: '新的同名 助手' });
    assert.notEqual(reused.result.assistant_profile_id, botId);
    const row = (await sql `
    select status, role_description from assistant_profiles where id = ${botId}`.execute(app.db)).rows[0];
    assert.deepEqual(row, { status: 'ARCHIVED', role_description: '只读复核' });
});
test('revise 用 revision CAS，落后的期望被拒且不改行', async () => {
    const workspaceId = await workspace('助手-cas');
    const created = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
        name: '审读', roleDescription: '第一版' });
    const botId = created.result.assistant_profile_id;
    const revised = await reviseAssistantProfile(app.db, { workspaceId, assistantProfileId: botId,
        commandId: randomUUID(), expectedRevision: toDecimalString(revisionOf(created.result)),
        name: '审读', roleDescription: '第二版' });
    assert.equal(revisionOf(revised.result), revisionOf(created.result) + 1n);
    await assert.rejects(() => reviseAssistantProfile(app.db, { workspaceId, assistantProfileId: botId,
        commandId: randomUUID(), expectedRevision: toDecimalString(revisionOf(created.result)),
        name: '审读', roleDescription: '第三版' }), (error) => { assert.equal(codeOf(error), 'REVISION_CONFLICT'); return true; });
    const row = (await sql `select role_description
    from assistant_profiles where id = ${botId}`.execute(app.db)).rows[0];
    assert.equal(row?.role_description, '第二版');
});
test('BOT 会话建立时冻结人设快照，之后不可改写', async () => {
    const workspaceId = await workspace('frozen-snapshot');
    const 助手 = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
        name: '审读', roleDescription: '只读复核' });
    const botId = 助手.result.assistant_profile_id;
    const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
        title: '人设会话', conversationMode: 'ASSISTANT', assistantProfileId: botId });
    const frozen = (await sql `
    select assistant_profile_id, assistant_profile_revision, assistant_role_snapshot
    from assist_sessions where id = ${created.result.session_id}`.execute(app.db)).rows[0];
    assert.equal(frozen?.assistant_profile_id, botId);
    assert.equal(frozen?.assistant_profile_revision, revisionOf(助手.result));
    assert.equal(frozen?.assistant_role_snapshot.name, '审读');
    // 快照是文本，不是授权：不得含能力或连接信息。
    assert.equal(frozen?.assistant_role_snapshot.capabilities, undefined);
    // 改 助手 不影响既有会话的冻结快照。
    await reviseAssistantProfile(app.db, { workspaceId, assistantProfileId: botId, commandId: randomUUID(),
        expectedRevision: toDecimalString(revisionOf(助手.result)),
        name: '审读', roleDescription: '改过的人设' });
    const after_ = (await sql `
    select assistant_role_snapshot from assist_sessions where id = ${created.result.session_id}`
        .execute(app.db)).rows[0];
    assert.equal(after_?.assistant_role_snapshot.role_description, '只读复核');
    // 直接改写被 CHECK 与只读语义共同挡住：会话身份没有公开的改写命令。
    await assert.rejects(() => sql `update assist_sessions set assistant_profile_id = null
    where id = ${created.result.session_id}`.execute(app.db));
});
test('BOT 会话缺 助手建不出来，归档 助手建不出新会话', async () => {
    const workspaceId = await workspace('助手-required');
    await assert.rejects(() => createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
        title: '缺 助手', conversationMode: 'ASSISTANT' }), (error) => { assert.equal(codeOf(error), 'VALIDATION_FAILED'); return true; });
    const 助手 = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
        name: '审读', roleDescription: '只读复核' });
    await archiveAssistantProfile(app.db, { workspaceId, assistantProfileId: 助手.result.assistant_profile_id,
        commandId: randomUUID(), expectedRevision: toDecimalString(revisionOf(助手.result)) });
    await assert.rejects(() => createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
        title: '归档 助手', conversationMode: 'ASSISTANT', assistantProfileId: 助手.result.assistant_profile_id }), (error) => { assert.equal(codeOf(error), 'INVALID_TRANSITION'); return true; });
});
test('跨 workspace 的 助手 不能建会话', async () => {
    const ownerWorkspace = await workspace('助手-owner');
    const otherWorkspace = await workspace('助手-other');
    const 助手 = await createAssistantProfile(app.db, { workspaceId: ownerWorkspace, commandId: randomUUID(),
        name: '审读', roleDescription: '只读复核' });
    await assert.rejects(() => createAssistSession(app.db, { workspaceId: otherWorkspace,
        commandId: randomUUID(), title: '越权', conversationMode: 'ASSISTANT',
        assistantProfileId: 助手.result.assistant_profile_id }), (error) => { assert.equal(codeOf(error), 'RESOURCE_NOT_FOUND'); return true; });
});
test('同 command_id 换模式重放被拒', async () => {
    const workspaceId = await workspace('replay-mode');
    const commandId = randomUUID();
    await createAssistSession(app.db, { workspaceId, commandId, title: '先按普通会话建' });
    // 摘要不同即异载荷：不能因为 command_id 相同就拿到那条普通会话。
    await assert.rejects(() => createAssistSession(app.db, { workspaceId, commandId,
        title: '先按普通会话建', conversationMode: 'ASSISTANT', assistantProfileId: randomUUID() }), (error) => {
        assert.equal(error.name, 'CommandIdReusedError');
        return true;
    });
});
test('同 command_id 同载荷重放返回原会话', async () => {
    const workspaceId = await workspace('replay-same');
    const 助手 = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
        name: '审读', roleDescription: '只读复核' });
    const commandId = randomUUID();
    const first = await createAssistSession(app.db, { workspaceId, commandId, title: '人设会话',
        conversationMode: 'ASSISTANT', assistantProfileId: 助手.result.assistant_profile_id });
    const second = await createAssistSession(app.db, { workspaceId, commandId, title: '人设会话',
        conversationMode: 'ASSISTANT', assistantProfileId: 助手.result.assistant_profile_id });
    assert.equal(second.result.session_id, first.result.session_id);
    assert.equal(second.replayed, true);
});
test('AGENT 会话不传模式时行为不变', async () => {
    const workspaceId = await workspace('agent-unchanged');
    const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
        title: '普通会话' });
    const row = (await sql `
    select conversation_mode, remember from assist_sessions where id = ${created.result.session_id}`
        .execute(app.db)).rows[0];
    assert.equal(row?.conversation_mode, 'AGENT');
    assert.equal(row?.remember, true);
    // 既有发送入口照常工作：mode 不参与消息准入（Task 3 才加 B 档规则）。
    const sent = await requestAssistMessage(app.db, { workspaceId,
        sessionId: created.result.session_id, commandId: randomUUID(), content: '普通讨论一句' });
    assert.equal(sent.result.session_id, created.result.session_id);
});
test('HTTP：建 助手、列 助手、按人设模式建会话，读回冻结快照', async () => {
    const workspaceId = await workspace('http-助手');
    const scope = workspacePath(workspaceId, '');
    const created = await api.post(`${scope}/assistant-profiles`, { command_id: randomUUID(),
        name: '审读', role_description: '只读复核这份改动', tone: '简短',
        read_scope: { roots: ['src'] } });
    assert.equal(created.status, 201, created.text);
    const botId = created.body.result.assistant_profile_id;
    const listed = await api.get(`${scope}/assistant-profiles`);
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.body.items.map((item) => item.name), ['审读']);
    const session = await api.post(`${scope}/assist-sessions`, { command_id: randomUUID(),
        title: '人设会话', conversation_mode: 'ASSISTANT', assistant_profile_id: botId });
    assert.equal(session.status, 201, session.text);
    const sessionId = session.body.result;
    assert.equal(sessionId.conversation_mode, 'ASSISTANT');
    const read = await api.get(`${scope}/assist-sessions/${sessionId.session_id}`);
    assert.equal(read.status, 200, read.text);
    const dto = read.body;
    assert.equal(dto.conversation_mode, 'ASSISTANT');
    assert.equal(dto.assistant_profile_id, botId);
    assert.equal(dto.assistant_role?.name, '审读');
    assert.deepEqual(dto.assistant_role?.read_scope, { roots: ['src'] });
    assert.equal(dto.remember, true);
    // 不传模式的既有客户端仍按 AGENT 建会话，响应里多出来的字段不改变既有语义。
    const plain = await api.post(`${scope}/assist-sessions`, { command_id: randomUUID(),
        title: '普通会话' });
    assert.equal(plain.status, 201, plain.text);
    assert.equal(plain.body.result.conversation_mode, 'AGENT');
});
test('HTTP：BOT 缺 assistant_profile_id 被拒，且不建出会话', async () => {
    const workspaceId = await workspace('http-missing-助手');
    const before_ = await countSessions(workspaceId);
    const response = await api.post(workspacePath(workspaceId, '/assist-sessions'), { command_id: randomUUID(), title: '缺 助手', conversation_mode: 'ASSISTANT' });
    assert.equal(response.status, 422, response.text);
    assert.equal(response.body.code, 'VALIDATION_FAILED');
    assert.equal(await countSessions(workspaceId), before_);
});
test('HTTP：只读范围想扩大时被拒', async () => {
    const workspaceId = await workspace('http-scope');
    const response = await api.post(workspacePath(workspaceId, '/assistant-profiles'), { command_id: randomUUID(), name: '越界', role_description: '想读到根外',
        read_scope: { roots: ['../outside'] } });
    assert.equal(response.status, 422, response.text);
    const rows = (await sql `select exists(
    select 1 from assistant_profiles where workspace_id = ${workspaceId}) as present`
        .execute(app.db)).rows[0];
    assert.equal(rows?.present, false);
});
