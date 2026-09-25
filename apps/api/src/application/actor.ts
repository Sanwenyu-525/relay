/**
 * V1 的单用户身份。
 *
 * 契约（docs/api/http-command-contract.md 第 1、2 节）要求命令 scope 为（Workspace、当前用户），
 * 且不接受客户端声明的 actor。V1 还没有用户与成员模型，当前用户是服务端固定的本机单用户主体；
 * 客户端无法通过任何请求字段替换它。
 */
export const LOCAL_SUBJECT = 'local';

/** 审计记录里的发起者标识（与 CLI 的 cli:init-workspace 区分）。 */
export const LOCAL_ACTOR_REF = 'user:local';

/** HTTP 命令回执的作用域键：同一 Workspace 的同一本机用户。 */
export function httpCommandScopeKey(workspaceId: string): string {
  return `workspace:${workspaceId}:user:${LOCAL_SUBJECT}`;
}