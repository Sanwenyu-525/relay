import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import type { AssistMessageAttachmentRow, AssistProposalRow, AssistSessionRow,
  AssistantProfileRow, ConversationMode } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson, computePayloadHash } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import { availableFrozenSkill, FIRST_PARTY_REGISTRY, frozenSkillSnapshot, isCallableSkill,
  normalizeSkillInput } from '../skills/first-party-registry.js';
import { BUILTIN_METHOD_REGISTRY, currentBuiltinMethod, frozenMethodSnapshot,
  type FrozenMethod, type MethodActionKind } from '../skills/builtin-methods.js';
import { resolveChatCommand } from './chat-commands.js';
import { MAX_ASSIST_ATTACHMENTS_PER_MESSAGE, MAX_ASSIST_ATTACHMENT_TOTAL_BYTES }
  from './assist-attachments.js';
import { detectMethodIntent } from './method-intent.js';
import { checkAssistContent, checkRequiredText, normalizeText } from '../shared/text.js';
import type { ContextSourceRef } from '../workflow/execution-contract.js';
import { httpCommandScopeKey } from './actor.js';
import { establishConversationDiffBaseline } from '../conversation-diff/net-diff-service.js';
import { frozenRoleSnapshot, requireActiveAssistantProfile } from './assistant-profile-commands.js';
import { applyArtifactCreation, prepareArtifactCreation } from './artifact-commands.js';
import { runIdempotentCommand, CommandIdReusedError, resolveExistingReceipt,
  resolveReceiptAfterUniqueViolation, type CommandOutcome } from './command.js';
import { applyTaskCreation, prepareTaskCreation, type CreateTaskCriterionInput } from './create-task.js';
import {
  DomainError,
  invalidTransition,
  resourceNotFound,
  validationFailed,
} from './domain-error.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { createRepositories, type Repositories } from './unit-of-work.js';
import { applyTaskSkillContractChange } from './task-contract-commands.js';
import { skillOutputHash } from '../skills/skill-proposal.js';
import { requireRevision } from './revisions.js';
import { readAdmission, requireNormalAdmission } from './maintenance-admission.js';
import { freezeAssistModelSnapshot } from './assist-model-snapshot.js';
import { resolveSessionReadTools } from './assist-read-tools.js';

/**
 * Assist 命令（M04/P12，runtime-context.md 第 5 节）：
 *   * Assist 不生成 Run、不持有 Task owner；会话/消息/提案只服务对话；
 *   * 消息固定写入其会话（固定消息目标），切换页面不会把旧回复落到新目标；
 *   * 类型化提案的接受调用与用户手动相同的业务命令，在同一事务内重新校验当前版本；
 *     重复接受按同一 command_id 的命令回执幂等，不同 command_id 的再次接受被拒绝。
 */

const ACCEPT_COMMAND_TYPE = 'AcceptAssistProposal';

export type CreateAssistSessionResult = {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly title: string;
  readonly status: string;
  readonly conversation_mode: ConversationMode;
  readonly assistant_profile_id: string | null;
  readonly assistant_profile_revision: string | null;
  readonly remember: boolean;
  readonly revision: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export interface CreateAssistSessionInput {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly projectId?: string | null;
  readonly taskId?: string | null;
  readonly title: string;
  /** 缺省即 'AGENT'；既有调用方不传时语义不变。 */
  readonly conversationMode?: ConversationMode | undefined;
  /** conversationMode='ASSISTANT' 时必填。归档或跨 workspace 的 助手 建不出会话。 */
  readonly assistantProfileId?: string | undefined;
}

export async function createAssistSession(
  db: DbExecutor,
  input: CreateAssistSessionInput,
): Promise<CommandOutcome<CreateAssistSessionResult>> {
  const titleProblem = checkRequiredText(input.title, 'title', 'title');
  if (titleProblem !== undefined) throw validationFailed([titleProblem]);
  const title = normalizeText(input.title);
  const conversationMode: ConversationMode = input.conversationMode ?? 'AGENT';

  return runIdempotentCommand<CreateAssistSessionResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'CreateAssistSession',
    target: { workspace_id: input.workspaceId },
    // 模式进命令体：同一个 command_id 换模式重放必须被当成异载荷拒绝，
    // 否则「先按普通会话建、再按人设建」会拿到同一条会话。
    body: { project_id: input.projectId ?? null, task_id: input.taskId ?? null, title,
      conversation_mode: conversationMode, assistant_profile_id: input.assistantProfileId ?? null },
    execute: async (repositories) => {
      let projectId = input.projectId ?? null;
      const taskId = input.taskId ?? null;
      if (taskId !== null) {
        const task = await repositories.tasks.readTaskForShare(taskId);
        if (task === undefined || task.workspace_id !== input.workspaceId) throw resourceNotFound('Task');
        // 会话绑定 Task 时作用域跟随 Task，避免出现 Task 与 Project 不一致的会话。
        if (projectId !== null && task.project_id !== projectId) {
          throw validationFailed([{ field: 'task_id', message: 'task 与 project 不属于同一作用域' }]);
        }
        projectId = task.project_id;
      }
      if (projectId !== null) {
        await lockWritableProjectInWorkspace(repositories, input.workspaceId, projectId);
      }
      // 人设快照在同一次准备里冻结：助手之后被改写或归档都不改变这条会话的身份。
      const profile = conversationMode === 'ASSISTANT'
        ? await requireAssistantProfileForNewSession(repositories, input.workspaceId, input.assistantProfileId)
        : null;
      const sessionId = randomUUID();
      await repositories.assist.insertSession({
        id: sessionId, workspaceId: input.workspaceId, projectId, taskId, title,
        conversationMode,
        ...(profile === null ? {} : { assistantProfileId: profile.id,
          assistantProfileRevision: profile.revision, assistantRoleSnapshot: frozenRoleSnapshot(profile) }),
      });
      const created = await repositories.assist.readSession(sessionId);
      if (created === undefined) {
        throw new Error('assist session row vanished within its creating transaction');
      }
      return { session_id: created.id, workspace_id: created.workspace_id,
        project_id: created.project_id, task_id: created.task_id, title: created.title,
        status: created.status, conversation_mode: created.conversation_mode,
        assistant_profile_id: created.assistant_profile_id,
        assistant_profile_revision: created.assistant_profile_revision === null ? null
          : toDecimalString(created.assistant_profile_revision),
        remember: created.remember,
        revision: toDecimalString(created.revision),
        created_at: created.created_at.toISOString(),
        updated_at: created.updated_at.toISOString() };
    },
  });
}

/**
 * 事务内读 助手：跨 workspace 与已归档都在这里被拒。
 * 归档的 助手建不出新会话——快照冻结的是文本，冻结不了「这条依据是否仍然有效」。
 */
async function requireAssistantProfileForNewSession(repositories: Repositories,
  workspaceId: string, assistantProfileId: string | undefined): Promise<AssistantProfileRow> {
  if (assistantProfileId === undefined || assistantProfileId === '') {
    throw validationFailed([{ field: 'assistant_profile_id', message: '人设会话必须选择一个助手' }]);
  }
  return requireActiveAssistantProfile(repositories.assistantProfiles, workspaceId, assistantProfileId);
}

/**
 * 发送前的助手存活判定。
 *
 * 归档只推进「是否仍适用」，不改写配置文本；因此既有会话里的冻结人设快照还在，
 * 但依据已经撤销——这里按会话上的 assistant_profile_id 重新判定一次，而不是相信快照。
 * 跨 workspace 读不到同样在这里被拒。
 */
async function requireLiveAssistantProfile(repositories: Repositories,
  session: AssistSessionRow): Promise<void> {
  if (session.assistant_profile_id === null) {
    throw invalidTransition('这条会话的人设已经不存在，请换一个助手。',
      { sessionId: session.id });
  }
  await requireActiveAssistantProfile(repositories.assistantProfiles, session.workspace_id,
    session.assistant_profile_id);
}

export type RequestAssistMessageResult = {
  readonly session_id: string;
  readonly user_message_id: string;
  readonly assistant_message_id: string;
};

export interface AssistSourceRefInput {
  readonly kind: string;
  readonly root_id: string;
  readonly version: string;
}

export type BindAssistSessionProjectResult = {
  readonly session_id: string;
  readonly project_id: string;
  readonly revision: string;
};

export interface BindAssistSessionProjectInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly projectId: string;
}

/**
 * 把工作空间级会话归入项目（工作台 §18.1）。
 *
 * 归属与执行准入是两件事：这里只改 project_id，目录是否就绪仍由执行准备单独判定。
 * 因此归档项目必须先拒绝、且不为此新建项目 —— 绑定不是绕过目录冲突的后门。
 */
export async function bindAssistSessionProject(
  db: DbExecutor,
  input: BindAssistSessionProjectInput,
): Promise<CommandOutcome<BindAssistSessionProjectResult>> {
  if (input.projectId.trim() === '') {
    throw validationFailed([{ field: 'project_id', message: 'must be a uuid' }]);
  }
  return runIdempotentCommand<BindAssistSessionProjectResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'BindAssistSessionProject',
    target: { session_id: input.sessionId },
    body: { project_id: input.projectId },
    execute: async (repositories) => {
      // 行锁先于归属判定：并发绑定同一会话时，后到者必须读到已改的 project_id 并被拒。
      const session = await repositories.assist.readSession(input.sessionId, true);
      if (session === undefined || session.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist session');
      }
      if (session.project_id !== null) {
        throw invalidTransition('这段讨论已经归属于某项目，不能改写归属。');
      }
      if (session.status !== 'ACTIVE') {
        throw invalidTransition('会话已归档，不能归入项目。');
      }
      const project = await repositories.projects.readProject(input.projectId);
      if (project === undefined || project.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Project');
      }
      // 归档检查必须在加锁之前：归档项目不得因为一次绑定获得写锁。
      if (project.archived_at !== null) {
        throw invalidTransition('项目已归档，不能归入；不会为此新建项目。');
      }
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, input.projectId);
      if (await repositories.assist.hasInflightMessages(input.sessionId)) {
        throw invalidTransition('这段讨论还有消息在途，等它结束再归入项目。');
      }
      await repositories.assist.bindSessionProject(input.sessionId, input.projectId);
      const updated = await repositories.assist.readSession(input.sessionId);
      if (updated === undefined || updated.project_id === null) {
        throw new Error('assist session row vanished within its binding transaction');
      }
      return { session_id: updated.id, project_id: updated.project_id,
        revision: toDecimalString(updated.revision) };
    },
  });
}

export type BindAssistSessionDirectoryResult = {
  readonly session_id: string;
  readonly working_resource_id: string;
  readonly revision: string;
};

export interface BindAssistSessionDirectoryInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly resourceId: string;
}

/**
 * 绑定本会话的当前工作目录（0087 / 运行架构 §2.7.1）。
 *
 * 目录绑定是**作用域**，不是准入：它只让普通会话的读取动作有一个确切目标，
 * 不授予任何能力；能不能读、能不能写，仍由每次动作经 Gateway 按连接与权限判定。
 *
 * 三条不能放宽的边界：
 *   * 资源必须属于**该会话自己的 Project**。跨项目借用目录等于让一段会话读到别的项目的
 *     文件，因此这里按会话行上的 project_id 核对，不采信客户端传来的 project_id；
 *   * 资源必须当前 ACTIVE。停用过的目录不靠重新绑定获得准入，也不换资源 ID 绕过停用；
 *   * 会话必须 ACTIVE 且没有在途消息。在途消息已经按发送时的作用域开始生成，
 *     中途换目录会让这一次读取落到与用户所见不同的目录。
 *
 * 换绑是允许的：用户换目录就是换作用域，下一轮立即按新目录解析，不保留旧目录的缓存。
 */
export async function bindAssistSessionDirectory(
  db: DbExecutor,
  input: BindAssistSessionDirectoryInput,
): Promise<CommandOutcome<BindAssistSessionDirectoryResult>> {
  if (input.resourceId.trim() === '') {
    throw validationFailed([{ field: 'resource_id', message: 'must be a uuid' }]);
  }
  return runIdempotentCommand<BindAssistSessionDirectoryResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'BindAssistSessionDirectory',
    target: { session_id: input.sessionId },
    body: { resource_id: input.resourceId },
    execute: async (repositories) => {
      // 行锁先于判定：并发绑定同一会话时，后到者必须读到已改的 working_resource_id。
      const session = await repositories.assist.readSession(input.sessionId, true);
      if (session === undefined || session.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist session');
      }
      if (session.status !== 'ACTIVE') {
        throw invalidTransition('会话已归档，不能绑定目录。');
      }
      if (session.project_id === null) {
        throw invalidTransition('这段讨论还没有归入项目；先选定目录所属项目再绑定。');
      }
      const resource = await repositories.gateway.readResource(input.resourceId);
      if (resource === undefined || resource.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Managed resource');
      }
      // 归属核对按会话行上的 project_id，而不是客户端传来的值。
      if (resource.project_id !== session.project_id) {
        throw invalidTransition('该受管目录不属于这段会话的项目，不能跨项目借用。');
      }
      if (resource.status !== 'ACTIVE') {
        throw invalidTransition('受管目录已停用，恢复后才能作为这段会话的工作目录。');
      }
      const project = await repositories.projects.readProject(session.project_id);
      if (project === undefined || project.archived_at !== null) {
        throw invalidTransition('项目已归档，不能作为这段会话的工作目录。');
      }
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, session.project_id);
      if (await repositories.assist.hasInflightMessages(input.sessionId)) {
        throw invalidTransition('这段讨论还有消息在途，等它结束再换目录。');
      }
      await repositories.assist.bindSessionDirectory(input.sessionId, resource.id);
      const updated = await repositories.assist.readSession(input.sessionId);
      if (updated === undefined || updated.working_resource_id === null) {
        throw new Error('assist session row vanished within its directory binding transaction');
      }
      return { session_id: updated.id, working_resource_id: updated.working_resource_id,
        revision: toDecimalString(updated.revision) };
    },
  });
}

export interface RequestAssistMessageInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly content: string;
  readonly intent?: string | undefined;
  readonly sourceRefs?: readonly AssistSourceRefInput[] | undefined;
  readonly skillRef?: { readonly id: string; readonly version: string } | undefined;
  readonly skillInput?: JsonObject | undefined;
  /** 显式选择内置工作方法；不传时由 `/命令` 或自然语言识别决定。 */
  readonly methodRef?: { readonly id: string; readonly version: string;
    readonly action?: MethodActionKind } | undefined;
  /**
   * 0072：本轮是否写入个人学习状态。缺省 true（照常记录）。
   * 只在学习会话上有意义；关闭时本轮增量一律不写（提示词 §9.4）。
   */
  readonly recordLearning?: boolean | undefined;
  /**
   * 0093：随消息发送的图片附件身份。上传端点已落未引用行，这里在消息命令的同一
   * 事务内绑定到新用户消息；ids 进 payload hash，重放按原 ids 核对。无附件时不传，
   * 既有载荷逐字不变。
   */
  readonly attachmentIds?: readonly string[] | undefined;
  /**
   * 0093：将实际服务本消息的进程默认模型名（路由从 RELAY_MODEL_NAME 传入）。
   * 带附件时命令用它查目录并裁决图片输入能力；不传（或目录无条目）按未知拒绝，
   * 不冒充可用。无附件时忽略。
   */
  readonly chatModelName?: string | undefined;
  /** 0098: guards the create-session → select-model → first-message sequence. */
  readonly expectedModelSelectionRevision?: string | undefined;
}

const ASSIST_INTENTS: readonly string[] = ['DISCUSS', 'PROPOSE_CANDIDATE', 'PROPOSE_TASK'];
const MAX_ASSIST_SOURCES = 10;

export async function requestAssistMessage(
  db: DbExecutor,
  input: RequestAssistMessageInput,
  modelEnv: NodeJS.ProcessEnv = process.env,
): Promise<CommandOutcome<RequestAssistMessageResult>> {
  if (input.expectedModelSelectionRevision !== undefined &&
      !/^[1-9][0-9]*$/u.test(input.expectedModelSelectionRevision)) {
    throw validationFailed([{ field: 'expected_model_selection_revision',
      message: '必须是正整数修订号' }]);
  }
  const contentProblem = checkAssistContent(input.content, 'content');
  if (contentProblem !== undefined) throw validationFailed([contentProblem]);
  const content = normalizeText(input.content);
  const intent = input.intent ?? 'DISCUSS';
  if (!ASSIST_INTENTS.includes(intent)) {
    throw validationFailed([{ field: 'intent', message: `intent 必须是 ${ASSIST_INTENTS.join('/')}` }]);
  }
  if (input.skillRef !== undefined && input.intent !== undefined ||
      input.skillRef === undefined && input.skillInput !== undefined) {
    throw validationFailed([{ field: 'skill_ref',
      message: 'Skill 调用由 skill_ref 决定意图，不能混用 intent；skill_input 需要 skill_ref' }]);
  }
  if (input.skillRef !== undefined && input.methodRef !== undefined) {
    throw validationFailed([{ field: 'method_ref',
      message: '一条消息只能采用一种身份：Skill 与内置方法不能同时指定' }]);
  }
  // 显式 Skill 身份决定这条消息的处理入口：正文是 Skill 输入，不再进入自然语言
  // 方法识别。否则「skill_ref + 请审查这个项目的当前状态」会在同一条消息上写出
  // `skill_snapshot` 与 `method_snapshot`，撞上 0071 的互斥约束，整条消息回滚。
  // `/命令` 解析仍然生效（未知/系统/菜单命令照旧类型化拒绝），正文里的 `/方法`
  // 命令与 skill_ref 同样按「一条消息一种身份」拒绝，而不是写成双快照。
  const methodRequest = input.skillRef === undefined
    ? resolveMethodRequest(content, input.methodRef)
    : resolveMethodFreeRequest(content);

  return runIdempotentCommand<RequestAssistMessageResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'RequestAssistMessage',
    target: { session_id: input.sessionId },
    body: { content, intent,
      ...(input.recordLearning === undefined ? {} : { record_learning: input.recordLearning }),
      ...(input.skillRef === undefined ? {} : {
        skill_ref: input.skillRef, skill_input: input.skillInput ?? {},
      }),
      ...(methodRequest.kind !== 'BOUND' ? {} : {
        method_ref: { id: methodRequest.method.id, version: methodRequest.method.version },
        method_action: methodRequest.action,
      }),
      sources: input.sourceRefs === undefined ? null :
        input.sourceRefs.map((source): JsonObject => ({
          kind: source.kind, root_id: source.root_id, version: source.version })),
      // 0093：ids 进 payload hash——重放按原 ids 核对；无附件时键不出现在载荷里，
      // 既有消息的 payload 逐字不变。
      ...(input.attachmentIds === undefined ? {} : { attachment_ids: [...input.attachmentIds] }),
      ...(input.expectedModelSelectionRevision === undefined ? {} : {
        expected_model_selection_revision: input.expectedModelSelectionRevision,
      }),
    },
    execute: async (repositories) => {
      const session = await repositories.assist.readSession(input.sessionId, true);
      if (session === undefined || session.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist session');
      }
      if (session.project_id !== null) {
        await lockWritableProjectInWorkspace(repositories, input.workspaceId, session.project_id);
      }
      // 工作台 §34：在首条消息开始处理、任何写入前建立会话基线（幂等）。采集失败不破坏原
      // 消息与执行流程——只记录原因，后续读取按「缺少会话起点」呈现。
      if (session.conversation_mode === 'AGENT' && session.working_resource_id !== null &&
          session.status === 'ACTIVE') {
        try {
          await establishConversationDiffBaseline(repositories, {
            workspaceId: input.workspaceId, sessionId: session.id,
          });
        } catch {
          // 基线采集不阻塞聊天：失权/超限/非 Git 根等按「缺基线」在读取端呈现。
        }
      }
      if (session.status !== 'ACTIVE') {
        throw invalidTransition('会话已归档，不能再发送消息。', { sessionId: session.id });
      }
      // 0060: 助手会话的准入收紧。它是只读会话，因此三件事在这里被明确挡住：
      //   * 不排队——上一条还在回答时再发一条会被拒，而不是变成看不见的队列；
      //   * 不调 Skill、不提提案——这两者在助手档没有意义，且提案会带出写入路径；
      //   * 助手归档后既有会话冻结——快照冻结的是文本，冻结不了「这条依据是否仍有效」。
      if (session.conversation_mode === 'ASSISTANT') {
        if (input.skillRef !== undefined) {
          throw invalidTransition('助手会话不调用 Skill；请在普通会话里发起。',
            { sessionId: session.id });
        }
        // 只读助手不因方法、命令或定制获得写能力：只读方法可以运行，要求修改的一律拒绝。
        if (methodRequest.kind === 'BOUND' && methodRequest.action === 'MODIFY') {
          throw invalidTransition('只读助手会话不因内置方法获得修改能力；请在普通会话里发起。',
            { sessionId: session.id });
        }
        if (intent !== 'DISCUSS') {
          throw invalidTransition('助手会话只做只读回答，不生成提案。',
            { sessionId: session.id });
        }
        // 终态原因排在在途原因之前：助手已归档时告诉用户「等上一条结束」是误导，
        // 因为等下去这条消息也永远不会变得可发。
        await requireLiveAssistantProfile(repositories, session);
        if (await repositories.assist.hasInflightMessages(session.id)) {
          throw invalidTransition('这段对话正在回答上一条，请等它结束再发。',
            { sessionId: session.id });
        }
      }
      // 0072：学习会话与助手档同样是受限身份——它不调 Skill、不提提案、不因内置方法获得修改能力。
      // 学习身份**只**多一项能力：经专门入口写个人学习记录；对项目仍然只读。
      if (session.conversation_mode === 'LEARNING') {
        if (input.skillRef !== undefined) {
          throw invalidTransition('学习会话不调用 Skill；请在普通会话里发起。',
            { sessionId: session.id });
        }
        if (methodRequest.kind === 'BOUND' && methodRequest.action === 'MODIFY') {
          throw invalidTransition('学习会话不因内置方法获得修改能力；请在普通会话里发起。',
            { sessionId: session.id });
        }
        if (intent !== 'DISCUSS') {
          throw invalidTransition('学习会话只做教学回答，不生成提案。',
            { sessionId: session.id });
        }
      }
      // 提案意图绑定对应作用域：候选 Markdown 需要明确目标 Task；任务定义需要明确 Project。
      if (intent === 'PROPOSE_CANDIDATE' && session.task_id === null) {
        throw invalidTransition('生成候选 Markdown 提案要求会话绑定一个 Task。', { sessionId: session.id });
      }
      if (intent === 'PROPOSE_TASK' && session.project_id === null) {
        throw invalidTransition('生成任务定义提案要求会话绑定一个 Project。', { sessionId: session.id });
      }
      const skill = input.skillRef === undefined ? null :
        FIRST_PARTY_REGISTRY.skill(input.skillRef.id, input.skillRef.version);
      if (input.skillRef !== undefined && skill === undefined) {
        throw validationFailed([{ field: 'skill_ref', message: '未知或不可用的第一方 Skill 版本' }]);
      }
      if (skill !== null && skill !== undefined && !isCallableSkill(skill)) {
        throw validationFailed([{ field: 'skill_ref', message: '该 Skill 版本仅保留历史读取' }]);
      }
      if (skill !== null && skill !== undefined &&
          (skill.definition.target === 'TASK' && session.task_id === null ||
           skill.definition.target === 'PROJECT' && session.project_id === null)) {
        throw invalidTransition('Skill 与 Assist 会话目标作用域不匹配。', { sessionId: session.id });
      }
      const skillInput = skill === null || skill === undefined ? null :
        normalizeSkillInput(skill, input.skillInput ?? {});
      if (skill !== null && skill !== undefined && skillInput === null) {
        throw validationFailed([{ field: 'skill_input', message: '输入不符合该 Skill 的固定契约' }]);
      }
      const sources = await resolveAssistSources(repositories, session, input.sourceRefs);
      // 方法身份同样在发起时冻结：之后定义被替换或禁用都不改变这条消息已采用的版本。
      const method = methodRequest.kind === 'BOUND' ? methodRequest.method : null;
      const methodAction = methodRequest.kind === 'BOUND' ? methodRequest.action : null;
      // The session row is already locked above. Freeze the exact selection and candidate
      // order in this same acceptance transaction so queued messages never read later state.
      const selection = await repositories.modelSelection.readForSession(session.id);
      if (input.expectedModelSelectionRevision !== undefined &&
          (selection === undefined || toDecimalString(selection.revision) !==
            input.expectedModelSelectionRevision)) {
        throw new DomainError({ code: 'MODEL_SELECTION_REVISION_CONFLICT', status: 409,
          type: '/problems/model-selection-revision-conflict', title: '模型选择已变化',
          detail: '发送首条消息前，会话模型选择已被其他操作修改；请重新读取选择并确认。',
          retryable: true, retryAction: 'REFRESH_AND_REDECIDE', conflict: {
            entityType: 'session_model_selection',
            expectedRevision: input.expectedModelSelectionRevision,
            ...(selection === undefined ? {} : { actualRevision: toDecimalString(selection.revision) }),
            sessionId: session.id,
          } });
      }
      const hasRuntimeTools = (session.conversation_mode === 'AGENT' ||
        session.conversation_mode === 'ASSISTANT') && intent === 'DISCUSS' && skill === null &&
        (await resolveSessionReadTools(repositories, session)).length > 0;
      const modelSnapshot = await freezeAssistModelSnapshot(repositories, selection, modelEnv, {
        requiresTools: hasRuntimeTools,
        requiresJsonOutput: intent !== 'DISCUSS' || skill !== null ||
          session.conversation_mode === 'LEARNING',
      });

      const userSeq = await repositories.assist.nextMessageSeq(session.id);
      const userMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      // 0093：先裁决附件（归属/数量/总量），再写消息——全部在同一事务，任何拒绝整体回滚。
      const messageAttachments = await resolveMessageAttachments(repositories, session,
        input.attachmentIds);
      if (messageAttachments.length > 0 && selection?.free_only === true) {
        throw invalidTransition('免费模型会话仅支持文本消息。', { sessionId: session.id });
      }
      if (messageAttachments.length > 0) {
        await assertChatModelAcceptsImages(repositories, input.chatModelName);
      }
      await repositories.assist.insertMessage({
        id: userMessageId, sessionId: session.id, seq: userSeq, role: 'USER',
        status: 'COMPLETED', intent: 'DISCUSS', content, sources: [],
      });
      if (messageAttachments.length > 0) {
        const bound = await repositories.assist.bindAttachments(session.id, userMessageId,
          messageAttachments.map((row) => row.id));
        if (bound !== messageAttachments.length) {
          throw resourceNotFound('Assist message attachment');
        }
      }
      await repositories.assist.insertMessage({
        id: assistantMessageId, sessionId: session.id, seq: userSeq + 1n, role: 'ASSISTANT',
        status: 'PENDING', intent: intent as 'DISCUSS', content: null, sources,
        ...(session.conversation_mode === 'LEARNING' && input.recordLearning === false
          ? { learningRecordDisabled: true } : {}),
        ...(skill === null || skill === undefined ? {} : {
          skillSnapshot: frozenSkillSnapshot(skill), skillInput: skillInput!,
        }),
        ...(method === null ? {} : {
          methodSnapshot: frozenMethodSnapshot(method), methodAction: methodAction!,
          methodArgument: methodRequest.kind === 'BOUND' ? methodRequest.argument : null,
        }),
        ...(modelSnapshot === undefined ? {} : {
          modelSelectionSnapshot: modelSnapshot.snapshot,
          modelAttemptState: modelSnapshot.attemptState,
        }),
      });
      return { session_id: session.id, user_message_id: userMessageId,
        assistant_message_id: assistantMessageId };
    },
  });
}

/**
 * 0093：图片附件的模型能力闸门。当前聊天恒由进程默认连接服务（会话选择→端口接线
 * 属阶段 C-2b，落地后此处应改为读取冻结快照），因此按进程默认模型名在目录里查条目：
 * 无条目或 image_input 非 true 一律拒绝——未知不冒充可用，也不因带图就换模型、
 * 换连接或悄悄降级为纯文本。
 */
async function assertChatModelAcceptsImages(
  repositories: Repositories, chatModelName: string | undefined): Promise<void> {
  const model = chatModelName?.trim() ?? '';
  const entry = model === '' ? undefined
    : await repositories.modelCatalog.readEntryBySourceModelId(model);
  if (entry === undefined) {
    throw validationFailed([{ field: 'attachment_ids',
      message: '目录中没有当前聊天模型的条目，无法确认图片输入能力；请先同步模型目录或改发纯文本。' }]);
  }
  if (entry.capabilities.image_input !== true) {
    throw validationFailed([{ field: 'attachment_ids',
      message: '当前聊天模型不支持图片输入，不能发送图片附件。' }]);
  }
}

/**
 * 0093：随消息的图片附件裁决。上传端点已落未引用行；这里核对归属（同 workspace+
 * session）、去重、数量与总量上限，返回待绑定行，由消息命令在同一事务内绑定到
 * 新用户消息。ids 是命令体的一部分（payload hash 覆盖），重放按原 ids 重新核对；
 * 已被占用的行由 bindAttachments 的 `where message_id is null` 挡住，绑定数不足
 * 即按 RESOURCE_NOT_FOUND 拒绝整条命令，绝不部分绑定。
 */
async function resolveMessageAttachments(
  repositories: Repositories, session: AssistSessionRow,
  ids: readonly string[] | undefined): Promise<readonly AssistMessageAttachmentRow[]> {
  if (ids === undefined || ids.length === 0) return [];
  if (ids.length > MAX_ASSIST_ATTACHMENTS_PER_MESSAGE) {
    throw validationFailed([{ field: 'attachment_ids',
      message: `每条消息最多 ${MAX_ASSIST_ATTACHMENTS_PER_MESSAGE} 张图片` }]);
  }
  const seen = new Set<string>();
  const rows: AssistMessageAttachmentRow[] = [];
  let total = 0;
  for (const id of ids) {
    if (seen.has(id)) {
      throw validationFailed([{ field: 'attachment_ids', message: '附件 id 重复' }]);
    }
    seen.add(id);
    const row = await repositories.assist.readAttachment(id, session.workspace_id, session.id);
    if (row === undefined) throw resourceNotFound('Assist message attachment');
    rows.push(row);
    total += row.byte_length;
  }
  if (total > MAX_ASSIST_ATTACHMENT_TOTAL_BYTES) {
    throw validationFailed([{ field: 'attachment_ids',
      message: `附件总量不得超过 ${MAX_ASSIST_ATTACHMENT_TOTAL_BYTES} 字节` }]);
  }
  return rows;
}

/**
 * 显式来源选择（外发边界前置）：与 Delegate 的 context_sources 同一规则——
 * 同一 Workspace、ACTIVE、Project 作用域匹配、具体不可变版本存在、去重后 ≤10 条。
 * 版本引用随消息冻结；构建期缺失按 UNAVAILABLE 排除并留痕，不静默替换。
 */
async function resolveAssistSources(repositories: Repositories, session: AssistSessionRow,
  sourceRefs: readonly AssistSourceRefInput[] | undefined): Promise<readonly JsonObject[]> {
  if (sourceRefs === undefined || sourceRefs.length === 0) return [];
  if (sourceRefs.length > MAX_ASSIST_SOURCES) {
    throw invalidTransition(`显式来源选择最多 ${MAX_ASSIST_SOURCES} 条。`, { sessionId: session.id });
  }
  const resolved: JsonObject[] = [];
  const seen = new Set<string>();
  for (const source of sourceRefs) {
    const key = `${source.kind}:${source.root_id}:${source.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isContextSourceKind(source.kind) || !/^[1-9][0-9]*$/u.test(source.version)) {
      throw validationFailed([{ field: 'source_refs', message: '来源引用格式无效' }]);
    }
    const kind = source.kind.toLowerCase() as 'knowledge' | 'memory' | 'decision';
    const root = await repositories.information.readRoot(kind, source.root_id);
    if (root === undefined || root.workspace_id !== session.workspace_id) {
      throw resourceNotFound('Assist source');
    }
    if (root.status !== 'ACTIVE') {
      throw invalidTransition(`显式来源 ${source.root_id} 已停用，不能随会话冻结。`,
        { sessionId: session.id });
    }
    if (root.project_id !== null && root.project_id !== session.project_id) {
      throw resourceNotFound('Assist source');
    }
    const version = await repositories.information.readVersion(kind, source.root_id,
      BigInt(source.version));
    if (version === undefined) throw resourceNotFound('Assist source version');
    resolved.push({ kind: source.kind, root_id: source.root_id, version: source.version,
      status: 'FROZEN' });
  }
  return resolved;
}

function isContextSourceKind(kind: string): kind is ContextSourceRef['kind'] {
  return kind === 'KNOWLEDGE' || kind === 'MEMORY' || kind === 'DECISION';
}

type MethodRequest =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'BOUND'; readonly method: FrozenMethod;
      readonly action: MethodActionKind; readonly argument: string | null };

/**
 * 本次消息采用的内置工作方法（Skill 专题 §9.2）。
 *
 * 显式 `/命令` 优先；否则由自然语言识别决定，且**讨论不执行**（"讨论诊断方法"不会采用）。
 * 未知命令与非法参数在这里类型化拒绝，保留用户可修改的输入；系统命令不由消息入口执行。
 */
function resolveMethodRequest(content: string,
  explicit: { readonly id: string; readonly version: string;
    readonly action?: MethodActionKind } | undefined): MethodRequest {
  const command = resolveChatCommand(content);
  if (command.kind === 'UNKNOWN_COMMAND' || command.kind === 'INVALID_ARGUMENT') {
    throw validationFailed([{ field: 'content', message: command.detail }]);
  }
  if (command.kind === 'MENU') {
    throw validationFailed([{ field: 'content',
      message: '“/”是命令菜单前缀；请选择或补全命令后再发送。' }]);
  }
  if (command.kind === 'SYSTEM') {
    throw validationFailed([{ field: 'content',
      message: `/${command.system} 是系统命令，由会话控制入口执行，不作为普通消息发送。` }]);
  }
  let ref = explicit;
  let action: MethodActionKind | null = explicit?.action ?? null;
  let argument: string | null = null;
  if (command.kind === 'METHOD') {
    ref = { id: command.method.id, version: command.method.version };
    action = command.action;
    argument = command.argument === '' ? null : command.argument;
  } else if (explicit === undefined) {
    const detected = detectMethodIntent(content);
    if (detected !== null && !detected.discussion) {
      const current = currentBuiltinMethod(detected.method_id);
      if (current === undefined) {
        throw validationFailed([{ field: 'content', message: '内置方法当前不可用。' }]);
      }
      ref = { id: current.id, version: current.version };
      action = detected.action;
    }
  }
  if (ref === undefined) return { kind: 'NONE' };
  const method = BUILTIN_METHOD_REGISTRY.method(ref.id, ref.version);
  if (method === undefined) {
    throw validationFailed([{ field: 'method_ref', message: '未知或不可用的内置方法版本' }]);
  }
  return { kind: 'BOUND', method, action: action ?? method.definition.default_action, argument };
}

/**
 * 显式 Skill 消息的方法解析：只保留 `/命令` 的输入校验，不绑定任何方法身份。
 *
 * 显式 skill_ref 已经决定处理入口，正文整体是 Skill 输入——自然语言识别与 `/方法`
 * 命令都不再产生第二身份。命令解析的拒绝（未知命令、非法参数、菜单前缀、系统命令）
 * 仍然前置：那是输入校验，与身份绑定无关。
 */
function resolveMethodFreeRequest(content: string): MethodRequest {
  const command = resolveChatCommand(content);
  if (command.kind === 'UNKNOWN_COMMAND' || command.kind === 'INVALID_ARGUMENT') {
    throw validationFailed([{ field: 'content', message: command.detail }]);
  }
  if (command.kind === 'MENU') {
    throw validationFailed([{ field: 'content',
      message: '“/”是命令菜单前缀；请选择或补全命令后再发送。' }]);
  }
  if (command.kind === 'SYSTEM') {
    throw validationFailed([{ field: 'content',
      message: `/${command.system} 是系统命令，由会话控制入口执行，不作为普通消息发送。` }]);
  }
  if (command.kind === 'METHOD') {
    throw validationFailed([{ field: 'method_ref',
      message: '一条消息只能采用一种身份：Skill 与内置方法不能同时指定' }]);
  }
  return { kind: 'NONE' };
}

export type CancelAssistMessageResult = {
  readonly message_id: string;
  readonly status: string;
};

export interface CancelAssistMessageInput {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly commandId: string;
}

export async function cancelAssistMessage(
  db: DbExecutor,
  input: CancelAssistMessageInput,
): Promise<CommandOutcome<CancelAssistMessageResult>> {
  return runIdempotentCommand<CancelAssistMessageResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'CancelAssistMessage',
    target: { message_id: input.messageId },
    body: {},
    execute: async (repositories) => {
      const message = await repositories.assist.readMessage(input.messageId, true);
      if (message === undefined) throw resourceNotFound('Assist message');
      const session = await repositories.assist.readSession(message.session_id);
      if (session === undefined || session.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist message');
      }
      if (session.project_id !== null) {
        await lockWritableProjectInWorkspace(repositories, input.workspaceId, session.project_id);
      }
      if (message.status === 'PENDING' || message.status === 'RUNNING') {
        // 取消意图先持久化（红线 7）：PENDING 直接收敛；RUNNING 由生成方在结算前观察。
        const outcome = await repositories.assist.setCancelRequested(input.messageId);
        if (outcome === 'UNSETTLED') {
          throw invalidTransition('消息状态已变化，取消未生效。', { messageId: input.messageId });
        }
        return { message_id: input.messageId,
          status: outcome === 'CANCELLED' ? 'CANCELLED' : 'RUNNING' };
      }
      if (message.status === 'CANCELLED') {
        return { message_id: input.messageId, status: 'CANCELLED' };
      }
      throw invalidTransition(`消息已${message.status === 'COMPLETED' ? '完成' : '失败'}，不能取消。`,
        { messageId: input.messageId });
    },
  });
}

export type AcceptAssistProposalResult = JsonObject;

export interface AcceptAssistProposalInput {
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly commandId: string;
  readonly storage: ManagedContentStore;
  readonly expectedTaskRevision?: string;
  readonly expectedAcceptanceRevision?: string;
  readonly payloadHash?: string;
}

/**
 * 接受提案：回执、业务效果与提案状态在同一事务提交。
 * 提案行以 FOR UPDATE 持锁贯穿整个效果，保证并发接受恰好一次生效；
 * 业务效果通过底层命令的 prepare/apply 组合完成，校验路径与用户手动调用完全一致。
 * base_revision 已前进时业务校验以 409 拒绝，提案按 EXPIRED 收敛后整体提交，
 * 不留下「效果已发生而提案仍 PENDING」的中间态。
 */
export async function acceptAssistProposal(
  db: DbExecutor,
  input: AcceptAssistProposalInput,
): Promise<CommandOutcome<AcceptAssistProposalResult>> {
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  const hasTaskCas = input.expectedTaskRevision !== undefined ||
    input.expectedAcceptanceRevision !== undefined || input.payloadHash !== undefined;
  const expectedTaskRevision = input.expectedTaskRevision === undefined ? null :
    requireRevision(input.expectedTaskRevision, 'expected_task_revision');
  const expectedAcceptanceRevision = input.expectedAcceptanceRevision === undefined ? null :
    requireRevision(input.expectedAcceptanceRevision, 'expected_acceptance_revision');
  const payloadHash = computePayloadHash({
    commandType: ACCEPT_COMMAND_TYPE,
    target: { proposal_id: input.proposalId },
    body: hasTaskCas ? {
      expected_task_revision: expectedTaskRevision?.toString() ?? null,
      expected_acceptance_revision: expectedAcceptanceRevision?.toString() ?? null,
      payload_hash: input.payloadHash ?? null,
    } : {},
  });

  let expiredWith: unknown;
  // 同一 scope 下不同候选的两个接受请求互不串行，会各自越过回执重查，直到写同一条
  // 命令回执时才相遇。候选锁串行不了这种情况，所以回执唯一冲突必须翻译成与通用
  // 幂等路径一致的结果：同摘要重放原回执，异摘要 409 COMMAND_ID_REUSED。
  let committed: { result: AcceptAssistProposalResult; replayed: boolean;
    committedAt: Date } | null;
  try {
    committed = await db.transaction().execute(async (trx) => {
      const repositories = createRepositories(trx);
    const existing = await repositories.receipts.findReceipt({ scopeKey,
      commandId: input.commandId });
    if (existing !== undefined) {
      if (!Buffer.from(existing.payload_hash).equals(payloadHash)) {
        throw new CommandIdReusedError(scopeKey, input.commandId);
      }
      return { result: existing.result_ref as AcceptAssistProposalResult, replayed: true,
        committedAt: existing.created_at };
    }

    const gate = await readAdmission(repositories, 'share');
    const committedWhileWaiting = await repositories.receipts.findReceipt({ scopeKey,
      commandId: input.commandId });
    if (committedWhileWaiting !== undefined) {
      return resolveExistingReceipt<AcceptAssistProposalResult>(committedWhileWaiting, payloadHash);
    }
    requireNormalAdmission(gate);
    const proposal = await repositories.assist.readProposal(input.proposalId, true);
    if (proposal === undefined || proposal.workspace_id !== input.workspaceId) {
      throw resourceNotFound('Assist proposal');
    }
    if (proposal.project_id !== null) {
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, proposal.project_id);
    }
    // 取得候选锁后再查一次同 scope/command 的回执：上面的两次查询都发生在加锁之前，
    // 两个同 command_id、同内容的并发请求都会通过它们，然后一起等这里这把锁。
    // 胜出的请求已经连同业务效果和回执提交，输的一方必须沿原回执重放，
    // 不能按“提案已被接受”拒绝成 409——那是同一次操作的两个视角，不是一次新决定。
    // 摘要不同仍由 resolveExistingReceipt 抛 CommandIdReusedError，与首次路径一致。
    const committedWhileLocking = await repositories.receipts.findReceipt({ scopeKey,
      commandId: input.commandId });
    if (committedWhileLocking !== undefined) {
      return resolveExistingReceipt<AcceptAssistProposalResult>(committedWhileLocking, payloadHash);
    }
    if (proposal.status === 'ACCEPTED') {
      throw invalidTransition('提案已被接受，不能再次接受。', { proposalId: proposal.id });
    }
    if (proposal.status !== 'PENDING') {
      throw invalidTransition(`提案已${proposal.status === 'REJECTED' ? '被拒绝' : '过期'}。`,
        { proposalId: proposal.id });
    }
    const isTaskSkill = proposal.kind === 'TASK_CONTRACT_CHANGE' ||
      proposal.kind === 'VERIFICATION_PLAN_CHANGE';
    if (isTaskSkill) {
      if (expectedTaskRevision === null || expectedAcceptanceRevision === null ||
          input.payloadHash === undefined || !/^[0-9a-f]{64}$/u.test(input.payloadHash)) {
        throw validationFailed([{ field: 'expected_task_revision',
          message: 'Task Skill 接受要求双版本与提案 payload_hash' }]);
      }
      if (input.payloadHash !== proposal.payload_hash ||
          assistPayloadHash(proposal.payload) !== proposal.payload_hash) {
        throw invalidTransition('提案内容摘要与用户确认的不一致。',
          { proposalId: proposal.id });
      }
      const authority = await repositories.workspaces.lockAuthority(input.workspaceId, 'share');
      if (authority === undefined) throw resourceNotFound('Workspace authority');
      await requireCurrentSkillProposal(repositories, proposal);
    } else if (hasTaskCas) {
      throw validationFailed([{ field: 'expected_task_revision',
        message: '旧提案接受不使用 Task Skill CAS 字段' }]);
    }

    let result: JsonObject;
    try {
      result = await runProposalEffect(repositories, input, proposal,
        expectedTaskRevision, expectedAcceptanceRevision);
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      // base_revision 落后：先在同一事务里把提案收敛为 EXPIRED 并提交，再把原始
      // 409 抛给调用方（在事务内直接抛出会连同 EXPIRED 一起回滚）。
      await repositories.assist.settleProposal(proposal.id, 'EXPIRED',
        { reason: 'BASE_REVISION_CONFLICT' });
      expiredWith = error;
      return null;
    }

    const settled = await repositories.assist.settleProposal(proposal.id, 'ACCEPTED',
      { command_id: input.commandId, result });
    if (!settled) {
      throw invalidTransition('提案状态已变化，接受未生效。', { proposalId: proposal.id });
    }
    const receipt = await repositories.receipts.insertReceipt({
      scopeKey, commandId: input.commandId, commandType: ACCEPT_COMMAND_TYPE,
      payloadHash, result,
    });
    return { result, replayed: false, committedAt: receipt.created_at };
    });
  } catch (error) {
    return resolveReceiptAfterUniqueViolation<AcceptAssistProposalResult>(db, error,
      scopeKey, input.commandId, payloadHash);
  }
  if (expiredWith !== undefined) throw expiredWith;
  if (committed === null) {
    throw new Error('assist proposal accept ended without an outcome');
  }
  return committed;
}

/** 按提案种类驱动既有公开命令的事务内效果；校验与用户手动调用一致。 */
async function runProposalEffect(repositories: Repositories,
  input: AcceptAssistProposalInput, proposal: AssistProposalRow,
  expectedTaskRevision: bigint | null,
  expectedAcceptanceRevision: bigint | null): Promise<JsonObject> {
  const payload = proposal.payload as JsonObject;
  if (proposal.kind === 'TASK_CONTRACT_CHANGE' ||
      proposal.kind === 'VERIFICATION_PLAN_CHANGE') {
    if (expectedTaskRevision === null || expectedAcceptanceRevision === null) {
      throw new Error('Task Skill CAS was not validated');
    }
    return applyTaskSkillContractChange(repositories, { workspaceId: input.workspaceId,
      commandId: input.commandId, proposal,
      expectedRevision: expectedTaskRevision,
      expectedAcceptanceRevision });
  }
  if (proposal.kind === 'CANDIDATE_MARKDOWN') {
    const prepared = prepareArtifactCreation({
      workspaceId: input.workspaceId,
      taskId: proposal.target_id,
      commandId: input.commandId,
      expectedTaskRevision: toDecimalString(proposal.base_revision),
      title: typeof payload.title === 'string' ? payload.title : '',
      mediaType: typeof payload.media_type === 'string' ? payload.media_type : 'text/markdown',
      content: typeof payload.markdown === 'string' ? payload.markdown : '',
    });
    return applyArtifactCreation(repositories, input.storage, prepared);
  }
  if (proposal.kind !== 'TASK_DEFINITION') {
    throw invalidTransition('未知 Assist 提案类型，不能接受。', { proposalId: proposal.id });
  }
  const criteria = (Array.isArray(payload.criteria) ? payload.criteria : [])
    .filter(isJsonObject)
    .map((criterion): CreateTaskCriterionInput => ({
      ...(typeof criterion.criterion_id === 'string'
        ? { criterionId: criterion.criterion_id } : {}),
      statement: typeof criterion.statement === 'string' ? criterion.statement : '',
      required: criterion.required === true,
      ...(typeof criterion.method === 'string' ? { method: criterion.method } : {}),
      ...(isJsonObject(criterion.target_spec) ? { targetSpec: criterion.target_spec } : {}),
    }));
  const prepared = prepareTaskCreation({
    workspaceId: input.workspaceId,
    commandId: input.commandId,
    projectId: proposal.target_id,
    title: typeof payload.title === 'string' ? payload.title : '',
    objective: typeof payload.objective === 'string' ? payload.objective : '',
    criteria,
    expectedOutputs: isJsonObject(payload.expected_outputs) ? payload.expected_outputs : {},
    mode: 'ME',
  });
  return applyTaskCreation(repositories, prepared);
}

/** Recheck frozen generation identity and current source permission at acceptance. */
async function requireCurrentSkillProposal(r: Repositories,
  proposal: AssistProposalRow): Promise<void> {
  const message = await r.assist.readMessage(proposal.message_id);
  const session = await r.assist.readSession(proposal.session_id);
  if (message?.status !== 'COMPLETED' || message.skill_snapshot === null ||
      message.skill_output === null || session === undefined ||
      session.workspace_id !== proposal.workspace_id ||
      session.task_id !== proposal.target_id ||
      message.session_id !== session.id ||
      message.skill_snapshot.sha256 !== proposal.skill_sha256 ||
      skillOutputHash(message.skill_output) !== proposal.skill_output_sha256) {
    throw invalidTransition('Skill 提案来源已不可核对。', { proposalId: proposal.id });
  }
  const sourceOutput = message.skill_output;
  const baseline = sourceOutput.baseline;
  const kind = sourceOutput.kind;
  if (!isJsonObject(baseline) ||
      !isJsonObject(sourceOutput.payload) ||
      typeof sourceOutput.payload_sha256 !== 'string' ||
      createHash('sha256').update(canonicalizeJson(sourceOutput.payload))
        .digest('hex') !== sourceOutput.payload_sha256 ||
      baseline.task_id !== proposal.target_id ||
      baseline.task_revision !== proposal.base_revision.toString() ||
      baseline.acceptance_revision !== proposal.base_acceptance_revision?.toString() ||
      kind !== (proposal.kind === 'TASK_CONTRACT_CHANGE'
        ? 'TASK_DEFINITION_SUGGESTION' : 'VERIFICATION_PLAN_SUGGESTION')) {
    throw invalidTransition('Skill 提案基线与来源不一致。', { proposalId: proposal.id });
  }
  const frozen = availableFrozenSkill(message.skill_snapshot);
  if (frozen === null || !isCallableSkill(frozen) ||
      frozen.sha256 !== proposal.skill_sha256 ||
      proposal.kind === 'TASK_CONTRACT_CHANGE' &&
        frozen.id !== 'task-to-execution-contract' ||
      proposal.kind === 'VERIFICATION_PLAN_CHANGE' &&
        (frozen.id !== 'verification-plan' || frozen.version !== '1.1.0')) {
    throw invalidTransition('冻结 Skill 版本不再可应用。', { proposalId: proposal.id });
  }
  for (const raw of Array.isArray(message.sources) ? message.sources : []) {
    if (!isJsonObject(raw) ||
        (raw.kind !== 'KNOWLEDGE' && raw.kind !== 'MEMORY' &&
          raw.kind !== 'DECISION') ||
        typeof raw.root_id !== 'string' ||
        typeof raw.version !== 'string' || !/^[1-9][0-9]*$/u.test(raw.version)) {
      throw invalidTransition('Skill 来源已不可用。', { proposalId: proposal.id });
    }
    const sourceKind = raw.kind.toLowerCase() as 'knowledge' | 'memory' | 'decision';
    const root = await r.information.readRoot(sourceKind, raw.root_id);
    const version = await r.information.readVersion(sourceKind, raw.root_id,
      BigInt(raw.version));
    if (root?.workspace_id !== proposal.workspace_id || root.status !== 'ACTIVE' ||
        root.project_id !== null && root.project_id !== session.project_id ||
        version === undefined ||
        sourceKind === 'knowledge' && typeof version === 'object' &&
          version !== null && 'availability' in version &&
          version.availability !== 'AVAILABLE' ||
        sourceKind === 'memory' && typeof version === 'object' &&
          version !== null && 'expires_at' in version &&
          version.expires_at instanceof Date && version.expires_at <= new Date()) {
      throw invalidTransition('Skill 来源已不可用。', { proposalId: proposal.id });
    }
  }
}

export type RejectAssistProposalResult = {
  readonly proposal_id: string;
  readonly status: string;
};

export interface RejectAssistProposalInput {
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly commandId: string;
}

export async function rejectAssistProposal(
  db: DbExecutor,
  input: RejectAssistProposalInput,
): Promise<CommandOutcome<RejectAssistProposalResult>> {
  return runIdempotentCommand<RejectAssistProposalResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'RejectAssistProposal',
    target: { proposal_id: input.proposalId },
    body: {},
    execute: async (repositories) => {
      const proposal = await repositories.assist.readProposal(input.proposalId, true);
      if (proposal === undefined || proposal.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist proposal');
      }
      if (proposal.project_id !== null) {
        await lockWritableProjectInWorkspace(repositories, input.workspaceId, proposal.project_id);
      }
      if (proposal.status === 'REJECTED') {
        return { proposal_id: proposal.id, status: 'REJECTED' };
      }
      const settled = await repositories.assist.settleProposal(proposal.id, 'REJECTED',
        { command_id: input.commandId });
      if (!settled) {
        throw invalidTransition('提案已决断，不能拒绝。', { proposalId: proposal.id });
      }
      return { proposal_id: proposal.id, status: 'REJECTED' };
    },
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.name === 'DomainError' &&
    (error as { code?: string }).code === 'REVISION_CONFLICT';
}

/** 提案 payload 的规范摘要；生成时与接受时一致，用于审计与失效检测。 */
export function assistPayloadHash(payload: JsonObject): string {
  return createHash('sha256').update(canonicalizeJson(payload), 'utf8').digest('hex');
}
