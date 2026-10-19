/**
 * GitHub 只读适配器（ADR-023 首片 / docs/architecture/relay-skills.md §10）。
 *
 * 职责与 Git、CLI 适配器一致：把 Gateway 冻结的逻辑动作翻译成一次 `gh` 调用，
 * 再把 `gh` 的回复翻译成 outcome/result。这里不判定权限（准入在 prepare/admit），
 * 不修改 Task/Run 状态。
 *
 * 三条不可让步的边界，都落在这个文件里而不是提示词里：
 *   * **模型永远不提供 argv。** 参数按动作白名单规范化一次并冻结进 params，argv 由
 *     本文件逐字段构造；`--repo` 的值来自受管根的 remote，不是调用方声明。因此
 *     `gh api`、`--jq`、任意 flag 与任意仓库名都无法从模型侧抵达。
 *   * **凭据不经过 Relay。** 子进程环境用显式白名单构造，因此 Relay 进程里的任何
 *     token 都不会转发进来；`gh` 只用它自己的安全存储。失败原因里也不允许出现
 *     stderr 之外的凭据形态。
 *   * **标题、正文、评论都是不可信数据。** 结果里带 `untrusted_external_content`，
 *     正文有字节上限并显式标记截断，绝不把外部内容升级成指令。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import { runSafeGit } from '../git/git-adapter.js';
import { githubExecutable, githubExecutableHint } from './gh-executable.js';

const execFileAsync = promisify(execFile);

export const GITHUB_READ_ACTION_TYPES = [
  'GITHUB_REPO_VIEW', 'GITHUB_PR_LIST', 'GITHUB_PR_VIEW', 'GITHUB_ISSUE_LIST', 'GITHUB_ISSUE_VIEW',
] as const;
export type GithubReadAction = (typeof GITHUB_READ_ACTION_TYPES)[number];

export function isGithubReadAction(actionType: string): actionType is GithubReadAction {
  return (GITHUB_READ_ACTION_TYPES as readonly string[]).includes(actionType);
}

/** 单次列表最多返回的条目数；模型只能在此范围内收窄。 */
export const GITHUB_LIST_MAX = 50;
/** PR / Issue 正文的字节上限：正文属于外部内容，默认只带前一段。 */
export const GITHUB_BODY_MAX_BYTES = 8 * 1024;
/** 状态检查结论最多带几条，超出只保留计数。 */
export const GITHUB_CHECKS_MAX = 25;
/** Issue 评论最多带几条，超出只保留总数。 */
export const GITHUB_COMMENTS_MAX = 10;
/** 单条评论正文的字节上限：评论是另一段不可信外部内容，不能独占上下文。 */
export const GITHUB_COMMENT_MAX_BYTES = 2 * 1024;
/** 失败原因里保留的 stderr 字节上限。 */
const GITHUB_ERROR_MAX_BYTES = 2 * 1024;

const PR_STATES = ['open', 'closed', 'merged', 'all'] as const;
const ISSUE_STATES = ['open', 'closed', 'all'] as const;

/**
 * 把调用方给的参数收窄成该动作允许的那几个字段。
 *
 * 在 prepare 期调用一次，因此冻结进 `params_hash` 的就是这里返回的形状；
 * 派发期不再解释任何未在这份白名单里的键。未知键直接拒掉，不静默丢弃——
 * 静默丢弃会让「我明明传了 limit」变成一次无法核对的默认值查询。
 */
export function githubParamsForAction(actionType: string, params: JsonObject): JsonObject {
  const refuse = (field: string, message: string): never => {
    throw new Error(`${field}: ${message}`);
  };
  const keys = Object.keys(params);
  switch (actionType) {
    case 'GITHUB_REPO_VIEW': {
      if (keys.length > 0) refuse('params', 'github_repo_view 不接受任何参数');
      return {};
    }
    case 'GITHUB_PR_LIST': {
      for (const key of keys) {
        if (key !== 'state' && key !== 'limit') refuse('params', `未知的参数：${key}`);
      }
      const state = params.state === undefined ? 'open' : requireState(params.state, PR_STATES, 'params.state');
      return { state, limit: requireLimit(params.limit) };
    }
    case 'GITHUB_PR_VIEW': {
      for (const key of keys) if (key !== 'number') refuse('params', `未知的参数：${key}`);
      const number = params.number;
      if (!Number.isInteger(number) || (number as number) <= 0) {
        refuse('params.number', 'github_pr_view 需要一个正整数 number');
      }
      return { number: number as number };
    }
    case 'GITHUB_ISSUE_LIST': {
      for (const key of keys) {
        if (key !== 'state' && key !== 'limit') refuse('params', `未知的参数：${key}`);
      }
      const state = params.state === undefined ? 'open' : requireState(params.state, ISSUE_STATES, 'params.state');
      return { state, limit: requireLimit(params.limit) };
    }
    case 'GITHUB_ISSUE_VIEW': {
      for (const key of keys) if (key !== 'number') refuse('params', `未知的参数：${key}`);
      const number = params.number;
      if (!Number.isInteger(number) || (number as number) <= 0) {
        refuse('params.number', 'github_issue_view 需要一个正整数 number');
      }
      return { number: number as number };
    }
    default:
      throw new Error(`不支持的 GitHub 动作：${actionType}`);
  }
}

function requireState(value: JsonValue | undefined, allowed: readonly string[], field: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${field}: 只允许 ${allowed.join(' / ')}`);
  }
  return value;
}

function requireLimit(value: JsonValue | undefined): number {
  if (value === undefined) return 10;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > GITHUB_LIST_MAX) {
    throw new Error(`params.limit: 必须是 1 到 ${GITHUB_LIST_MAX} 的整数`);
  }
  return value as number;
}

/**
 * argv 由本文件逐字段构造：目标仓库用已核对过的 owner/name 显式钉住
 * （`pr`/`issue` 用 `--repo`，`repo view` 用位置参数），因此 `gh` 不会按它自己的
 * remote 优先级去猜另一个仓库。
 */
export function buildArgs(actionType: GithubReadAction, params: JsonObject, repo: string): string[] {
  const scope = ['--repo', repo];
  switch (actionType) {
    case 'GITHUB_REPO_VIEW':
      // `gh repo view` **没有** `--repo` 标志：仓库是位置参数（gh 2.102.0 实测）。
      // 写成 `--repo` 会被判 unknown flag——只靠「本机没装 gh」的测试永远发现不了。
      return ['repo', 'view', repo, '--json', 'name,owner,defaultBranchRef,url,isPrivate'];
    case 'GITHUB_PR_LIST':
      return ['pr', 'list', ...scope, '--state', String(params.state),
        '--limit', String(params.limit), '--json', 'number,title,state,headRefName,url,updatedAt'];
    case 'GITHUB_PR_VIEW':
      return ['pr', 'view', ...scope, String(params.number), '--json',
        'number,title,body,state,headRefName,baseRefName,author,url,isDraft,mergeable,' +
        'statusCheckRollup,additions,deletions,changedFiles,updatedAt'];
    case 'GITHUB_ISSUE_LIST':
      return ['issue', 'list', ...scope, '--state', String(params.state),
        '--limit', String(params.limit), '--json', 'number,title,state,url,updatedAt'];
    case 'GITHUB_ISSUE_VIEW':
      // 评论用 `--json ...,comments` 取（`--comments` 只配人类可读输出，见上游 gh Skill）。
      return ['issue', 'view', ...scope, String(params.number), '--json',
        'number,title,body,state,author,url,labels,createdAt,updatedAt,comments'];
  }
}

/**
 * 子进程环境的显式白名单。
 *
 * 不继承 `process.env`：那样会把 Relay 进程里的一切（包括它可能见过的 token）带进
 * 一个会访问网络的子进程。这里只给 Windows 定位与 `gh` 找到自己的凭据存储所必需的
 * 几项。`GH_PROMPT_DISABLED` 保证 `gh` 缺权限时直接失败而不是挂在 stdin 上。
 */
export function githubEnv(): NodeJS.ProcessEnv {
  const source = process.env;
  return {
    SYSTEMROOT: source.SYSTEMROOT ?? '', SYSTEMDRIVE: source.SYSTEMDRIVE ?? '',
    WINDIR: source.WINDIR ?? '', PATH: source.PATH ?? '', PATHEXT: source.PATHEXT ?? '',
    TEMP: source.TEMP ?? '', TMP: source.TMP ?? '',
    USERPROFILE: source.USERPROFILE ?? '', HOME: source.USERPROFILE ?? source.HOME ?? '',
    APPDATA: source.APPDATA ?? '', LOCALAPPDATA: source.LOCALAPPDATA ?? '',
    HTTP_PROXY: source.HTTP_PROXY, HTTPS_PROXY: source.HTTPS_PROXY, NO_PROXY: source.NO_PROXY,
    http_proxy: source.http_proxy, https_proxy: source.https_proxy, no_proxy: source.no_proxy,
    GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1',
  };
}

export interface GithubExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly kind?: string;
}

/** 一次有界的 `gh` 调用；非零退出不抛出，交由失败归类处理。 */
export async function runGithub(args: readonly string[], options: {
  readonly cwd: string; readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number;
}): Promise<GithubExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(githubExecutable(), [...args], {
      cwd: options.cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 2 * 1024 * 1024,
      env: githubEnv(),
    });
    return { exitCode: 0, stdout, stderr: stderr.toString().trim() };
  } catch (error: any) {
    if (error?.code === 'ABORT_ERR' || (error?.killed === true && error?.signal !== undefined)) {
      const aborted = options.signal?.aborted === true;
      return { exitCode: -1, stdout: '', stderr: '', kind: aborted ? 'cancelled' : 'timeout' };
    }
    if (error?.code === 'ENOENT') return { exitCode: -1, stdout: '', stderr: '', kind: 'missing' };
    return {
      exitCode: typeof error?.code === 'number' ? error.code : -1,
      stdout: (error?.stdout ?? '').toString(),
      stderr: (error?.stderr ?? error?.message ?? '').toString().trim(),
    };
  }
}

/**
 * 受管根指向哪个 GitHub 仓库——本地判定，不走网络。
 *
 * 这一步是「不误操作别人的仓库」的闸门：解析不出 GitHub remote 就失败关闭，
 * 不猜、不用别的 remote 顶替。多个 remote 时按 remote 名的字典序取第一个 GitHub
 * remote，保证同一目录每次解析到同一个仓库，而不是让 `gh` 自己去优先。
 */
export async function resolveGithubRepo(cwd: string,
  signal?: AbortSignal): Promise<{ readonly repo: string; readonly reason?: string }> {
  const res = await runSafeGit(['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd, signal });
  // 1 是「一条 remote 都没匹配到」而不是读取出错：没有 remote 的目录同样要报
  // NO_GITHUB_REMOTE，好让提示落在「这个目录没有 GitHub remote」上。
  if (res.exitCode > 1) return { repo: '', reason: 'GIT_REMOTE_UNREADABLE' };
  const candidates: { name: string; repo: string }[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const [key, url] = line.trim().split(/\s+/, 2);
    if (key === undefined || url === undefined) continue;
    const repo = githubRepoOf(url);
    if (repo === null) continue;
    candidates.push({ name: key.slice('remote.'.length).split('.')[0] ?? '', repo });
  }
  if (candidates.length === 0) return { repo: '', reason: 'NO_GITHUB_REMOTE' };
  candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { repo: candidates[0]!.repo };
}

/** 只认 github.com；企业主机的仓库身份另片再谈，现在一律不算。 */
export function githubRepoOf(url: string): string | null {
  const trimmed = url.trim();
  let host = '';
  let path = '';
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    let parsed: URL;
    try { parsed = new URL(trimmed); } catch { return null; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return null;
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    // scp 式 git 地址：git@github.com:owner/repo.git，冒号左边是主机而不是端口。
    const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/u.exec(trimmed);
    if (scp === null) return null;
    host = scp[1]!;
    path = `/${scp[2]!}`;
  }
  if (host.toLowerCase() !== 'github.com') return null;
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return null;
  const owner = segments[0]!;
  const name = segments[1]!.replace(/\.git$/u, '');
  if (!/^[A-Za-z0-9._-]+$/u.test(owner) || !/^[A-Za-z0-9._-]+$/u.test(name)) return null;
  return `${owner}/${name}`;
}

export function githubFailureKind(result: { readonly kind?: string | undefined;
  readonly stderr: string }): string {
  if (result.kind === 'missing') return 'GH_CLI_UNAVAILABLE';
  if (result.kind === 'timeout') return 'GH_TIMEOUT';
  if (result.kind === 'cancelled') return 'GH_CANCELLED';
  const stderr = result.stderr;
  if (/not logged in|gh auth login|no .{0,20}accounts tracked|authentication required|bad credentials|HTTP 401/iu.test(stderr)) {
    return 'GH_UNAUTHENTICATED';
  }
  if (/could not resolve host|no such host|dial tcp|connection refused|i\/o timeout|tls|network|proxy/iu.test(stderr)) {
    return 'GH_NETWORK_ERROR';
  }
  if (/not a git repository|no remote|could not determine repository|unknown host|point to a known GitHub host/iu.test(stderr)) {
    return 'GH_REPO_UNIDENTIFIED';
  }
  if (/HTTP 404|Could not resolve|not found|Could not find/iu.test(stderr)) return 'GH_NOT_FOUND';
  if (/HTTP 403|Forbidden|rate limit|secondary verification/iu.test(stderr)) return 'GH_FORBIDDEN';
  return 'GH_ERROR';
}

/** `gh --json` 的顶层结果：数组或对象，形状由 gh 决定，因此一切读取都要容错。 */
function parsedJson(stdout: string): JsonValue | null {
  const text = stdout.trim();
  if (text === '') return null;
  try { return JSON.parse(text) as JsonValue; } catch { return null; }
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function textOf(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  const nested = asObject(value);
  if (nested !== undefined) {
    const login = nested.login;
    if (typeof login === 'string') return login;
    const name = nested.name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/** 外部文本的有界化：截断必须显式说出来，否则读到的就是一段被悄悄剪短的正文。 */
function boundedText(value: JsonValue | undefined,
  maxBytes: number = GITHUB_BODY_MAX_BYTES): { text: string; truncated: boolean } {
  const text = typeof value === 'string' ? value : '';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return { text, truncated: false };
  let kept = '';
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > maxBytes) break;
    kept += char;
    used += size;
  }
  return { text: kept, truncated: true };
}

function listItem(value: JsonValue | undefined): JsonObject {
  const item = asObject(value) ?? {};
  return {
    number: typeof item.number === 'number' ? item.number : null,
    title: textOf(item.title),
    state: textOf(item.state),
    ...(item.headRefName === undefined ? {} : { headRefName: textOf(item.headRefName) }),
    url: textOf(item.url),
    updatedAt: textOf(item.updatedAt),
  };
}

/**
 * 把 `gh` 的 JSON 投影成有界结果。
 *
 * 这里做的是投影而不是透传：状态检查列表和正文都可能很大，直接进入上下文会挤掉
 * 真正的对话。投影规则与 Git 只读投影同一口径——有上限、截断可见、计数保留。
 */
export function projectGithubResult(actionType: GithubReadAction, stdout: string): JsonObject {
  const parsed = parsedJson(stdout);
  if (parsed === null) return { parse_failed: true, bytes: Buffer.byteLength(stdout, 'utf8') };
  if (actionType === 'GITHUB_REPO_VIEW') {
    const view = asObject(parsed) ?? {};
    return {
      name: textOf(view.name),
      owner: textOf(view.owner),
      default_branch: textOf(view.defaultBranchRef),
      url: textOf(view.url),
      is_private: typeof view.isPrivate === 'boolean' ? view.isPrivate : null,
      untrusted_external_content: true,
    };
  }
  if (actionType === 'GITHUB_PR_LIST' || actionType === 'GITHUB_ISSUE_LIST') {
    const items = asArray(parsed);
    return {
      items: items.map(listItem),
      returned: items.length,
      untrusted_external_content: true,
    };
  }
  if (actionType === 'GITHUB_ISSUE_VIEW') {
    const view = asObject(parsed) ?? {};
    const body = boundedText(view.body);
    const allComments = asArray(view.comments);
    // 评论是另一段外部内容：条数与单条字节都设上限，并把被剪掉的事实说出来。
    const comments = allComments.slice(0, GITHUB_COMMENTS_MAX).map((entry) => {
      const comment = asObject(entry) ?? {};
      const text = boundedText(comment.body, GITHUB_COMMENT_MAX_BYTES);
      return { author: textOf(comment.author), created_at: textOf(comment.createdAt),
        body: text.text, body_truncated: text.truncated };
    });
    return {
      number: typeof view.number === 'number' ? view.number : null,
      title: textOf(view.title),
      state: textOf(view.state),
      author: textOf(view.author),
      url: textOf(view.url),
      labels: asArray(view.labels).map((label) => textOf(asObject(label)?.name ?? label)),
      created_at: textOf(view.createdAt),
      updated_at: textOf(view.updatedAt),
      body: body.text,
      body_truncated: body.truncated,
      comments: comments as unknown as JsonObject[],
      comments_total: allComments.length,
      comments_truncated: allComments.length > comments.length,
      untrusted_external_content: true,
    };
  }
  const view = asObject(parsed) ?? {};
  const body = boundedText(view.body);
  const checks = asArray(view.statusCheckRollup).slice(0, GITHUB_CHECKS_MAX).map((entry) => {
    const check = asObject(entry) ?? {};
    return { name: textOf(check.name), state: textOf(check.state), bucket: textOf(check.bucket),
      url: textOf(check.url) };
  });
  return {
    number: typeof view.number === 'number' ? view.number : null,
    title: textOf(view.title),
    state: textOf(view.state),
    head_ref: textOf(view.headRefName),
    base_ref: textOf(view.baseRefName),
    author: textOf(view.author),
    url: textOf(view.url),
    is_draft: typeof view.isDraft === 'boolean' ? view.isDraft : null,
    mergeable: textOf(view.mergeable),
    additions: typeof view.additions === 'number' ? view.additions : null,
    deletions: typeof view.deletions === 'number' ? view.deletions : null,
    changed_files: typeof view.changedFiles === 'number' ? view.changedFiles : null,
    updated_at: textOf(view.updatedAt),
    body: body.text,
    body_truncated: body.truncated,
    checks: checks as unknown as JsonObject[],
    checks_total: asArray(view.statusCheckRollup).length,
    untrusted_external_content: true,
  };
}

/**
 * Gateway 派发入口。
 *
 * 失败一律以 FAILED + 类型化 reason 结算而不是抛出：未装 `gh`、未登录、网络不通都是
 * 可说明的外部事实，不该升级成 Worker 异常，更不能被当成「查询结果为空」。
 */
export async function githubExecute(operation: {
  readonly id: string; readonly action_type: string; readonly params: JsonObject;
  readonly normalized_target: string; readonly connection_id: string;
}, invocation: { readonly id: string }, signal?: AbortSignal): Promise<{
  readonly outcome: 'SUCCEEDED' | 'FAILED'; readonly result: JsonObject;
}> {
  const base = { operation_id: operation.id, invocation_id: invocation.id };
  if (!isGithubReadAction(operation.action_type)) {
    return { outcome: 'FAILED', result: { ...base, reason: 'UNKNOWN_GITHUB_ACTION',
      action_type: operation.action_type } };
  }
  if (signal?.aborted) return failed(base, 'GH_CANCELLED', '本次 GitHub 读取在发起前已被取消。');

  const identity = await resolveGithubRepo(operation.normalized_target, signal);
  if (identity.repo === '') {
    return failed(base, 'GH_REPO_UNIDENTIFIED',
      `这个受管目录没有可确定的 GitHub remote（${identity.reason ?? '未解析到 github.com 仓库'}），` +
      '因此不会去查任何一个仓库。');
  }
  const args = buildArgs(operation.action_type, operation.params, identity.repo);
  const res = await runGithub(args, { cwd: operation.normalized_target, signal });
  if (res.kind !== undefined) {
    return failed(base, githubFailureKind(res), ghHint(githubFailureKind(res), res.kind));
  }
  if (res.exitCode !== 0) {
    const kind = githubFailureKind(res);
    return failed(base, kind, `${ghHint(kind, undefined)} ${clip(res.stderr)}`.trim());
  }
  const projected = projectGithubResult(operation.action_type, res.stdout);
  return { outcome: 'SUCCEEDED',
    result: { ...base, repo: identity.repo, capability: 'GITHUB_READ', ...projected } };
}

function failed(base: JsonObject, kind: string, detail: string): {
  readonly outcome: 'FAILED'; readonly result: JsonObject;
} {
  // 类型化原因写在 `reason` 上，与 Computer/Git 适配器同一口径：会话轮次按 reason 呈现
  // 失败抬头，写成 GH_ERROR 会把「没装 gh」「没登录」「目录不是仓库」压成同一个猜测。
  return { outcome: 'FAILED', result: { ...base, reason: kind, error: detail } };
}

/**
 * 失败要说人话：未装 `gh` 与未登录必须有可行动的下一步，
 * 而不是让模型把一段 stderr 猜成「没有 PR」。
 */
function ghHint(kind: string, rawKind: string | undefined): string {
  if (rawKind === 'timeout') return 'GitHub CLI 在 30 秒内没有返回，本次结果未知。';
  if (rawKind === 'cancelled') return '本次 GitHub 读取已被取消，没有产生结果。';
  switch (kind) {
    case 'GH_CLI_UNAVAILABLE': return `找不到可执行的 GitHub CLI。${githubExecutableHint()}`;
    case 'GH_UNAUTHENTICATED': return 'GitHub CLI 当前没有可用凭据，请在本机执行 gh auth login 后重试。';
    case 'GH_NETWORK_ERROR': return '无法连接 GitHub，请检查网络或代理。';
    case 'GH_REPO_UNIDENTIFIED': return '这个工作目录没有指向 GitHub 的仓库 remote，无法确定要查询哪个仓库。';
    case 'GH_NOT_FOUND': return 'GitHub 上没有找到要查询的对象。';
    case 'GH_FORBIDDEN': return 'GitHub 拒绝了这个请求（权限或限流）。';
    default: return 'GitHub CLI 调用失败。';
  }
}

function clip(text: string): string {
  return Buffer.byteLength(text, 'utf8') <= GITHUB_ERROR_MAX_BYTES
    ? text : text.slice(0, GITHUB_ERROR_MAX_BYTES);
}
