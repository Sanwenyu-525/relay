import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { cancelAssistMessage, createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { archiveAssistantProfile, createAssistantProfile } from
  '../../src/application/assistant-profile-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createDataRoot } from './api-harness.js';
import { toDecimalString } from '../../src/shared/decimal.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * 助手会话的准入、幂等与撤销（ADR-018 §5–§7）。
 *
 * 每条用例都是一个人可能真的踩到的状况：
 *   * 助手会话不排队——上一条还在回答时再发一条必须被明确拒绝，而不是变成看不见的队列；
 *   * 助手会话不调 Skill、不提提案：这两条在助手档没有意义；
 *   * 助手归档后既有会话冻结发消息，但历史仍可读；
 *   * 同 command_id 同载荷重放返回原消息，异载荷被拒；
 *   * 停止沿用既有消息取消通道，不产生第二个停止入口。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-assistant-admission');
let dataRoot: string;
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly assistantId: string;
  readonly revision: bigint;
}

async function fixture(mode: 'AGENT' | 'ASSISTANT' = 'ASSISTANT'): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-assistant-admission-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Relay\n', 'utf8');
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'assistant-admission' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: 'assistant-admission', projectType: 'DEVELOPMENT' });
  });
  const assistant = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '只读复核这份改动' });
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '准入会话', projectId,
    ...(mode === 'ASSISTANT'
      ? { conversationMode: 'ASSISTANT' as const,
        assistantProfileId: assistant.result.assistant_profile_id as string }
      : {}) });
  return { workspaceId, projectId, sessionId: session.result.session_id,
    assistantId: assistant.result.assistant_profile_id as string,
    revision: BigInt(String(assistant.result.revision)) };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code) : undefined;
}

function detailOf(error: unknown): string {
  return typeof error === 'object' && error !== null
    ? String((error as { detail?: unknown }).detail ?? '') : '';
}

test('助手会话不排队：上一条在途时再发一条被明确拒绝', async () => {
  const fx = await fixture();
  const first = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '先问一句' });
  await assert.rejects(() => requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '趁它在跑再问一句' }),
  (error: unknown) => {
    assert.equal(codeOf(error), 'INVALID_TRANSITION');
    // 文案不得出现「排队」：这里没有队列，只有一条在途。
    assert.doesNotMatch(detailOf(error), /排队/u);
    return true;
  });
  // 被拒的那条没有留下任何消息行。
  const messages = await createRepositories(app.db).assist.listMessages(fx.sessionId);
  assert.equal(messages.filter((entry) => entry.role === 'USER').length, 1);
  assert.equal(messages.at(-1)?.id, first.result.assistant_message_id);
});

test('助手会话拒绝 Skill 与提案意图', async () => {
  const fx = await fixture();
  await assert.rejects(() => requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '来份任务契约',
    skillRef: { id: 'task-to-execution-contract', version: '1.1.0' } }),
  (error: unknown) => {
    assert.equal(codeOf(error), 'INVALID_TRANSITION');
    assert.match(detailOf(error), /Skill/u);
    return true;
  });
  await assert.rejects(() => requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '提个任务',
    intent: 'PROPOSE_TASK' }),
  (error: unknown) => {
    assert.equal(codeOf(error), 'INVALID_TRANSITION');
    assert.match(detailOf(error), /只读/u);
    return true;
  });
});

test('普通会话不受影响：Skill 与提案意图照旧按原规则判定', async () => {
  const fx = await fixture('AGENT');
  const asked = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '提个任务定义',
    intent: 'PROPOSE_TASK' });
  assert.equal(asked.result.session_id, fx.sessionId);
});

test('助手归档后既有会话冻结，但历史仍可读', async () => {
  const fx = await fixture();
  await requestAssistMessage(app.db, { workspaceId: fx.workspaceId, sessionId: fx.sessionId,
    commandId: randomUUID(), content: '归档前问一句' });
  await archiveAssistantProfile(app.db, { workspaceId: fx.workspaceId,
    assistantProfileId: fx.assistantId, commandId: randomUUID(),
    expectedRevision: toDecimalString(fx.revision) });

  await assert.rejects(() => requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '归档后再问一句' }),
  (error: unknown) => {
    assert.equal(codeOf(error), 'INVALID_TRANSITION');
    // 冻结必须给出下一步，而不是只给一个错误码。
    assert.match(detailOf(error), /助手/u);
    return true;
  });
  const messages = await createRepositories(app.db).assist.listMessages(fx.sessionId);
  assert.ok(messages.length >= 2, '归档不能让既有讨论消失');
});

test('同 command_id 同载荷重放返回原消息，异载荷被拒', async () => {
  const fx = await fixture();
  const commandId = randomUUID();
  const first = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId, content: '同一句' });
  const replay = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId, content: '同一句' });
  assert.equal(replay.result.user_message_id, first.result.user_message_id);
  assert.equal(replay.result.assistant_message_id, first.result.assistant_message_id);
  assert.equal(replay.replayed, true);

  // 上面那次重放发生在第一条仍在途时：回执判定必须排在在途判定之前，否则用户
  // 连按两次发送就会看到「请等它结束」，而不是拿回同一条消息。

  // 异载荷必须拒绝：它是一次新的用户决定，不能拿回原回执。先让在途那条结束，
  // 否则测到的会是排队规则而不是幂等规则。
  await cancelAssistMessage(app.db, { workspaceId: fx.workspaceId,
    messageId: first.result.assistant_message_id, commandId: randomUUID() });
  await assert.rejects(() => requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId, content: '改成另一句' }),
  (error: unknown) => { assert.equal((error as { name?: unknown }).name, 'CommandIdReusedError');
    return true; });
});

test('停止沿用既有消息取消通道，不产生第二个停止入口', async () => {
  const fx = await fixture();
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '读一下这个目录' });
  const cancelled = await cancelAssistMessage(app.db, { workspaceId: fx.workspaceId,
    messageId: sent.result.assistant_message_id, commandId: randomUUID() });
  // PENDING 消息直接收敛为 CANCELLED：不需要 Task、Run 或任何助手专属的停止资源。
  assert.equal(cancelled.result.status, 'CANCELLED');
  const message = await createRepositories(app.db).assist
    .readMessage(sent.result.assistant_message_id);
  assert.equal(message?.status, 'CANCELLED');
  assert.equal(message?.cancel_requested, true);
});