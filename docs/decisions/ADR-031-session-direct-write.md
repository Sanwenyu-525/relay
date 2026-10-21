# ADR-031：会话内直接写文件（新增 AGENT_SESSION_WRITE 来源）

## 状态

Accepted（方向由用户 2026-10-20 明确选择「会话内直接写」；同日按用户反馈「任务、审批、验收都繁琐」接续修正）。实现范围与待验边界归 CODEX_NEXT_STEP，结果只归统一验收表。下文关于档位、方法与剩余执行的决定已同步当前源码；最初的 ASK 会话直写、方法恒只读和 `execution` 恒空方案被本次接续替代，保留于 Git 历史。

## 日期

2026-10-20。

## 背景

此前会话轮次是「可读不可写」：`ASSISTANT_READ_TOOLS` 只含读工具，写请求被 `TOOL_NOT_READ_ONLY` 类型化拒绝（0060 / 0087）；写入口只有 RUN，用户要走「会话产出执行候选 → 确认 → 委托 Task/Run」两段式。

用户明确要求会话内直接写。这条要求本身合理：两段式在小改动上代价过高——为改一个文件要建 Task、跑验收条件、再走一次委托。

但它撞上一条既有契约：**模型返回不代表任务完成**。放开会话写必须同时回答：没有 Run、没有 Task、没有验收的写入，凭什么可信？

## 候选方案

1. **放宽 `AGENT_SESSION_READ` 的能力词表**（否决）：改动最小，但「读身份只读」这条库层语义当场失效。`attachOperation()` 与 `originMatches()` 都按来源核对，放宽后一次会话动作究竟是读还是写在账本上无法分辨，也让「读轮次不产生副作用」这条审计前提不再成立。
2. **新增 `AGENT_SESSION_WRITE` 来源，只放行基线可核对的写入**（采纳）：语义不退化；写与读在账本、日志与准入三处都可分辨。
3. **保持只读，把 Run 链路做顺**（用户否决）：不解决「为一个文件建一条 Task」的成本问题。

## 决策

采用方案 2。要点：

- **只放行 `FILE_WRITE` 能力下的 `APPLY_CHANGESET` 与 `READ_CHANGE_SET`**。同名能力下的 `WRITE_FILE`（全文覆盖、无基线）**不开放**：会话没有 Run 的 `resource_claims` 保护（该表强制绑定 task/run/worker，0060 与 0058 都记过这条限制），两个会话并发写同一文件时唯一可靠的闸门是那条 SHA-256 基线——prepare 与落盘前各无条件比对一次，后到者按 `TOOL_CHANGESET_BASELINE_CONFLICT` 拒绝，而不是悄悄覆盖对方刚写的正文。
- **排他口径与 `USER_ACTION` 一致**：不建 claim，靠 prepare 与 admit 各自按 `listOccupiedResources()` 拒绝在途目录。这不是更弱的检查，而是同一规则的另一种表达。
- **按实际工具启用直写**：`AUTO` / `FULL` 且本轮确实有 `apply_changeset` 才采用直写模板；`READ_ONLY` / `ASK` 不暴露会话写工具。仅有目录档位但连接已停用，不能向模型宣称能写。
- **审批使用可恢复的 Run**：ASK 请求由原消息产出候选，经已有自动启动入口进入 Run，复用原动作审批与恢复，不让用户重建任务。AUTO 档删除在创建 Operation 前返回 `SESSION_WRITE_REQUIRES_RUN`，交给同一入口；FULL 仍按 Gateway 判定。其他自定义策略若已产生 WAITING_APPROVAL，只能核对原动作，不生成第二个候选替代。
- **`execution` 只承载剩余工作**：已成功直写的改动不再入队；尚未执行的检查、浏览器/电脑操作或尚未创建动作的审批需求可进入原 Run。检查单独提交 `writes_files=false`、`file_changes=[]`。UNKNOWN 和已有待审批动作不得换身份重试。
- **方法与执行能力分开**：普通 Agent 的明确 `MODIFY` 方法轮可复用相同直写入口；`INSPECT` / null 仍只读。方法说明决定取证步骤，不额外授予权限，也不再强制所有修改建 Task。人设助手、学习搭档、提案型 Skill 的边界不变。
- **变更集前置校验复用 Run 侧同一份函数**（`normalizeToolChanges`：1–8 项、baseline 必须是真正的 64 位摘要、单文件 64 KiB）。Gateway prepare 会再校验一次；会话侧先做是为了让模型在派发前拿到类型化原因，而不是留一条注定被拒的动作。两份规则一旦漂移，两条入口就会对同一份声明给出不同结论。

## 代价与边界

- **写完就是写完**：会话写不产生 Task、验收条件或 PASS 判定。追溯靠 `session_tool_calls`（SETTLED / UNKNOWN / REJECTED）+ `change_sets` / `change_set_files` 两处账本，不靠模型自述。
- **UNKNOWN 必须人工核对**：派发后结果不明时，文件可能已改也可能没改。会话侧如实返回「结果未知、不要重试、不要声称改好」，资源保持隔离。
- **并发写靠基线，不靠锁**：会话 A 与 B 同时改同一文件时，后到者的基线必然过期而失败。这是**拒绝**而非合并；需要合并的并发场景仍应走 Run。
- **`READ_CHANGE_SET` 一并放行**：它只读自己刚写出的那份变更集证据（按 `operation_id` 查账本，不碰磁盘），不放行它等于让模型写完看不到自己写了什么。
- **Git 提交、命令行、浏览器提交与电脑输入仍然只有 Run**：会话写只改本会话绑定目录内的文件，不改仓库状态、不跑检查。
- **Windows 上不使用原生路径身份冻结（已知降级）**：`file_write_path_identity` 的复合外键强制绑定 `(operation, run, resource, action_type)`，会话写没有 `run_id`，插不进这张表。放开它要改该表的主键语义，代价远大于收益。因此会话写在 Windows 上落在 `executeFileChangeset` 的纯 Node 路径，存在 [ADR-012](ADR-012-windows-file-io-handle-boundary.md) 记录的「路径检查到实际 I/O 之间被替换」的竞争窗口。**这是会话写当前的明确弱点，不假装与 Run 同级**；需要同等保护的写入应走 Run。

## 影响

- 迁移 `0126` 重述三条 CHECK（`ck_logical_operation_origin`、`ck_logical_operation_resource`、`ck_invocation_run_identity`），均以 0087 / 0105 的最新正文为基础——0060 注释记录过 0054 重述时漏分支造成 9 例既有动作违反约束，本次按正文重述。
- [工具适配器](../architecture/tool-adapters.md) 的能力矩阵多一支；[工作台](../frontend/workbench-design.md) 的目录档位语义不变（档位仍只决定「模型能不能看到写工具」）。
- 契约侧「写入口只有 RUN」的表述在 [运行架构](../architecture/runtime-context.md) 与 [工具适配器](../architecture/tool-adapters.md) 中需要按本 ADR 更新为「RUN 或会话写来源」。
