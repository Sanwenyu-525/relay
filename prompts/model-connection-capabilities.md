# 模型连接能力档案：后端 + 前端任务书

> **交付状态（2026-10-20 凌晨）**：§3.1 迁移、§3.2 判定四层、§3.3 端点、§3.4 设置页声明入口与输入框提示均已实现并通过自检（见 §5 证据）。本片不含多连接切换与会话级模型选择接线，那仍是阶段 C-2b 的剩余部分。

请在 `D:/Develop/Relay-Agent` 完成「模型能力档案」这一层：把「这个模型能做什么」从进程环境变量提升为**跟着模型身份走的声明**，直接实现、测试并维护文档；所有汇报用中文，不 commit/push，不派子代理。

## 1. 为什么做（2026-10-19 用户指令「按你推荐来」）

用户先问「为什么无法确认」，再问「目录只收录 OpenRouter？应该所有模型都可以接进来的」。核查后的结论：

- **任意模型已经能接**：聊天端口是任意 OpenAI 兼容端点（`RELAY_MODEL_PROVIDER=openai-compatible` + base URL + model + key），自建 `agnes-3.0-flash` 走的就是这条路。
- **目录不是模型注册表**：`model_catalog_entries` 是**价格/能力快照**（`pricing` 非空、`architecture.input_modalities`、`is_free`），默认同步 OpenRouter，源可配（`RELAY_MODEL_CATALOG_BASE_URL`）但期望 OpenRouter 形状。自建 Provider 的 `/models` 不报 modalities，指过去也解析不出可用条目。
- **缺的是第三层**：能力档案。现在图片输入能力只有一个进程级布尔 `RELAY_MODEL_IMAGE_INPUT`，它与「当前配置的那个模型」隐式绑定——换模型、将来多连接时会失效。

本片把第三层独立出来：**能力声明按 (provider, source_model_id) 存档**，与目录、与进程环境解耦。

不在本片：多连接的增删改与切换 UI、会话级模型选择接线（阶段 C-2b 的另一半）、目录多源合并。本片不改变「能连谁」，只改变「能力从哪里来」。

## 2. 先读

- [AGENTS.md](../AGENTS.md) §3「事实只有一个逻辑写入 Owner」、§5 验证要求
- [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)
- [工作台 §33.2 能力预检](../docs/frontend/workbench-design.md#332-暂存与发送)（已实现的提前提示）
- [HTTP §10.100 模型端口的图片输入能力投影](../docs/api/http-command-contract.md#10100-模型端口的图片输入能力投影2026-10-19)
- 现状代码：`apps/api/src/application/chat-image-input.ts`（**唯一判定入口**）、`apps/api/src/workflow/model-port-config.ts`（`readDeclaredImageInput`）、`apps/api/src/api/model-api.ts`（`describeImageInput`）、`apps/workbench/src/lib/chatImageInput.ts`

共享工作区存在并行改动（会话草稿、信息恢复、记忆状态等）；检查 `git status` 与目标文件 diff，定点编辑，不覆盖他人改动。

## 3. 目标设计

### 3.1 数据

新增表 `model_capability_declarations`（additive migration）：

| 列 | 类型 | 说明 |
|---|---|---|
| `provider` | text not null | 与 `/model-port` 的 provider 同一枚举（`openai-compatible` 等），不用 fake |
| `source_model_id` | text not null | 与 `model_catalog_entries.source_model_id` 同一口径 |
| `image_input` | boolean not null | 唯一一条能力：是否接受图片输入 |
| `note` | text null | 声明依据（例如「官方文档写明原生多模态」），≤500 字符 |
| `declared_at` / `updated_at` | timestamptz not null | 审计用 |
| PK | `(provider, source_model_id)` | 一个模型一条声明，重复声明是覆盖不是追加 |

实例级全局事实，不隶属 Workspace（与 `model_catalog_entries`、`/model-port` 同一先例）。撤销声明 = 删除行，回到「未声明」。

### 3.2 判定优先级（不得改变现有语义）

```
目录有该模型条目  → 以目录 capabilities.image_input 为准（声明不能覆盖目录判定）
目录无条目        → 看声明表；有 → 用声明
                   无 → 看 RELAY_MODEL_IMAGE_INPUT（兼容期，仅对当前配置模型生效）
                   无 → MODEL_NOT_IN_CATALOG（拒绝，fail-closed）
```

`apps/api/src/application/chat-image-input.ts` 的 `chatImageInputState` 增加 `declaration?: boolean` 入参；闸门（`assertChatModelAcceptsImages`）与 `/model-port` 投影继续共用它——**不允许出现第二份判定**。

### 3.3 API

**实施记录（2026-10-20 凌晨）**：本节原写「走 command_receipt」，实现时改为**实例级配置端点（无回执）**。理由：一次声明没有状态机、没有修订，重发同体必然得到同一状态；回执要保护的是「同一命令是否已生效」的歧义，而这里 GET 直接回答。沿用 `/model-catalog/refresh` 的实例级先例，避免为一个布尔值新增命令类型与三处 switch。若将来声明需要多人协作或审计追责，再升级为命令。

| 端点 | 语义 |
|---|---|
| `GET …/model-capabilities` | 列出声明：`{items:[{provider, source_model_id, image_input, note, declared_at, updated_at}]}`。workspace 路径沿用实例级先例（`workspace_id` 不作作用域键） |
| `PUT …/model-capabilities/{provider}/{source_model_id}` | `{image_input, note?}` → 200 同形行。`provider` 仅接受 `openai-compatible`；`note ≤ 500`，超长 422 不截断；同键再写是覆盖 |
| `DELETE …/model-capabilities/{provider}/{source_model_id}` | → `{removed: boolean}`。撤销回到「未声明」，不是记成「不支持」 |

`GET /model-port` 增加 `image_input_source: 'CATALOG' | 'DECLARED' | 'ENV' | 'NONE'`，说明这次结论来自哪一层；`image_input` 取值集合不变。

权限：写声明属于实例级配置，沿用当前 Bearer 边界；不新增角色。

### 3.4 前端

- 设置页「模型连接」卡片（`views/SettingsView.tsx` 的 model-port 区块）增加「图片输入能力」：三态（支持 / 不支持 / 未声明）+ 一句依据输入框 + 保存/撤销。展示当前结论来自哪一层（`image_input_source`），让「目录说可以」与「你声明的」可区分。
- 输入框的提前提示（`lib/chatImageInput.ts`）保持现有行为；文案按 `image_input_source` 微调：`ENV` 时补一句「当前结论来自服务端环境声明」。
- 不新增一级导航，不重构设置页；复用既有 `.segmented`、`.field` 与 token。

## 4. 实现要求

1. 先补能暴露缺口的用例，再实现。禁止先改断言再补实现。
2. 迁移只做加法：新表 + 索引；不修改 `model_catalog_entries`。回滚方式是停用读表（读路径保留 env 兜底），不需要反向迁移。
3. 闸门与投影必须同源：任何一处判定改动都要同时改 `chat-image-input.ts`，并由单测锁定「同一输入 → 同一结论」。
4. 声明写入后**不缓存跨请求**：下次 `/model-port` 必须读到新值（与 env 需要重启形成对比，这正是本片的价值）。若引入缓存，必须有显式失效点与用例。
5. 审计：声明/撤销都产生命令回执；不写密钥、不写完整 base URL。
6. 目录条目存在时，声明表**不得**改变结论——补一条回归用例，防止将来有人「顺手」让声明覆盖目录。
7. 旧服务端兼容：客户端读不到 `image_input_source` 时按 `NONE` 处理，不当作 `CATALOG`。

## 5. 验证与交付

- **单测**：判定四层优先级（目录/声明/env/拒绝）；`image_input_source` 映射；声明表读写与并发覆盖。
- **集成（真实 PG）**：`POST` 建声明 → `GET /model-port` 立即变 `DECLARED`；撤销后回 `MODEL_NOT_IN_CATALOG`；同 `command_id` 重放不重复写；异载荷 409；跨 Workspace 路径读到同一份实例级事实。
- **前端**：设置页三态声明与撤销、来源展示；输入框提示在 `DECLARED` 下消失、在 `MODEL_NOT_IN_CATALOG` 下出现；保存失败保留原状态与错误说明。
- **浏览器（真实 Chromium）**：设置页改声明后回到输入框，粘图不再出现警示条（可用 `page.route` 伪造，不连数据库）。

交付时说明：改了什么、实际运行了哪些检查、文档同步、剩余限制（尤其「未跑真实 Provider 的多模态语义质量」与「多连接切换仍未接线」）。

## 6. 文档影响

- [HTTP §10.100](../docs/api/http-command-contract.md#10100-模型端口的图片输入能力投影2026-10-19)：补 `image_input_source`、声明端点与优先级表；标注 Breaking Change 与兼容策略。
- [工作台 §33.2](../docs/frontend/workbench-design.md#332-暂存与发送)：能力预检改为「目录 → 声明 → env」三层来源。
- [领域模型](../docs/architecture/domain-model.md)：说明「模型连接 / 目录 / 能力档案」三者的职责边界，避免再把目录当注册表。
- [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)：本片完成后把「阶段 C-2b」剩余部分（多连接与会话选择接线）列为下一片。
- 运行 `node scripts/check-docs.mjs`。
