# Goal 与目录工作上下文 API

状态：后端接口已实现；实际验收范围归[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。更新：2026-10-17。

本页定义 Goal 与普通工作目录的只读工作上下文入口。Goal 是正式业务对象，按显式 Goal–Project 关系汇集多个项目；普通目录是 `managed_resources` 中的受管目录。目录与 Goal 可交叉，同一会话始终保持原 session ID。Goal–Project 关系不表示 Task 与 Goal 显式对齐。

**Breaking Change: No。** 本次增加只读 GET 路由，不改变既有 API、写命令或权限，不增加数据库结构和迁移，也不创建 Task、Run、关联、回执或审计记录。路由继续使用既有 bearer 与 Workspace 可见性保护。

## Goal 工作上下文

`GET /api/v1/workspaces/{workspace_id}/goals/{goal_id}/work-context?status=ACTIVE`

`status` 可为 `ACTIVE`（默认）、`ARCHIVED` 或 `ALL`；其他值返回 422。不存在或属于其他 Workspace 的 Goal 返回 404。

```json
{
  "kind": "GOAL",
  "goal": { "id": "…", "title": "…", "description": "…", "status": "ACTIVE", "revision": "2" },
  "projects": [{
    "id": "…", "title": "…", "project_type": "GENERAL",
    "archive_status": "ACTIVE", "archived_at": null, "revision": "3",
    "directories": [{ "id": "…", "canonical_root": "D:/work", "status": "ACTIVE", "revision": "1" }]
  }],
  "sessions": [{
    "id": "…", "project_id": "…", "title": "讨论", "status": "ACTIVE",
    "revision": "1", "working_resource_id": null
  }]
}
```

项目只来自 `project_goals` 中当前显式关联，包含已归档项目及真实归档状态。目录列出这些项目登记的全部受管目录，包括已停用状态。会话属于这些项目且 `task_id IS NULL`，不要求绑定目录；因此未绑定目录的目标项目会话仍会出现。Goal 没有关联项目时返回 200 和空数组。

## 目录工作上下文

`GET /api/v1/workspaces/{workspace_id}/working-directories/{resource_id}/work-context?status=ACTIVE`

`status` 参数与 Goal 入口相同。不存在或属于其他 Workspace 的目录返回 404。无关联 Goal 的目录仍正常返回，`linked_goals` 为空数组。

```json
{
  "kind": "DIRECTORY",
  "directory": {
    "id": "…", "canonical_root": "D:/work", "status": "ACTIVE", "revision": "1",
    "project": {
      "id": "…", "title": "…", "project_type": "GENERAL",
      "archive_status": "ACTIVE", "archived_at": null, "revision": "3"
    }
  },
  "linked_goals": [{ "id": "…", "title": "…", "status": "ACTIVE", "revision": "2" }],
  "sessions": [{
    "id": "…", "project_id": "…", "title": "讨论", "status": "ACTIVE",
    "revision": "1", "working_resource_id": "…"
  }]
}
```

目录会话只包含 `working_resource_id` 精确等于该资源且 `task_id IS NULL` 的会话。项目其他目录或未绑定目录的会话不会混入。项目归档、目录停用和 Goal 状态按存储事实返回；读接口不隐式授予执行资格。

两种响应只含导航所需字段，不包含消息正文、凭据或模型数据。查询仅投影现存事实，不按名称或路径推断关联；解除关联后下一次读取反映当前关系，会话身份与历史不变。

## 工作台入口（2026-10-24）

Goal 详情的「工作上下文」区以 `status=ALL` 汇集关联项目、受管目录与普通会话；目录入口 `/working-directories/:id` 只列 `working_resource_id` 精确等于该目录的会话。会话链接沿用原 `session` 与 `project` 深链接（`/agent?session=…&project=…`），不创建、不重绑 Session；归档项目、停用目录与归档 Goal 均按真实状态呈现。交互规则归[工作台 §51](../frontend/workbench-design.md#51-正式目标管理与项目状态写入2026-10-24已实施实机未验)。
