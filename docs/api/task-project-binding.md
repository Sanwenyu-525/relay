# Task 首次归入项目

状态：后端接口已实现；实际验收范围归[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。更新：2026-10-17。

**Breaking Change: No**。该接口新增，不改变既有 Task API；不新增数据库 migration。

`POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/project-binding` 接受严格请求体：

```json
{"command_id":"<uuid>","expected_revision":"1","project_id":"<uuid>"}
```

成功返回 HTTP 200。`result` 包含 `task_id`、`project_id`、`status`、`revision` 与 `acceptance_revision`，资源链接仍指向原 Task。命令回执遵循现有 `command_id` 幂等规则。

此入口仅把尚未归属项目的 `INBOX` 或 `READY`、由 HUMAN 持有的 Task 首次归入同一 Workspace 下未归档的 Project。原 Task 身份、标题、模式、验收版本、计划资料和执行权保持不变；只推进 Task revision 与项目归属。项目 Goal 通过既有 `INHERIT` 规则读取。本命令不创建 Task/Run/Artifact/Goal，不启动任务，也不增加权限。

已有 Artifact、Run、CompletionRecord 或任一方向的 Task dependency 时返回 409；请先在原业务入口处理这些事实。本 Task 绑定的会话会保留原 ID 和历史，并在同一事务内归属到新 Project。会话有 PENDING/RUNNING 消息、绑定目录或归属已变化时整笔拒绝，避免移动进行中的对话。

错误语义遵循现有 API：Task/Project 不存在或不属于路径 Workspace 返回 404；已归档 Project 返回 `PROJECT_ARCHIVED` 409；旧 revision 返回 `REVISION_CONFLICT` 409；状态、依赖、历史执行或会话阻挡返回 `INVALID_TRANSITION` 409。

这不是跨 Project 迁移、移回 Inbox 或批量搬迁接口。那些操作需要独立业务决策与迁移规则，当前没有提供。
