# Agent 生成的领取、停止与生命周期

日期：2026-10-30。当前测试结果归[Agent 主链验收](../testing/acceptance-details/part-11.md#条目-191)，不替代真实 Provider 或桌面验收。

## 已复现的问题

1. 宿主 AbortSignal 在 tick 开始前已经停止，仍会领取 PENDING 消息并生成 COMPLETED 回复。原因是仅监听后续 abort 事件，没有检查信号当前状态。
2. 同会话第一轮模型还在等待时，第二个 Worker 能领取并完成排队消息。原领取语句只排斥同一消息的重复领取，没有排斥该会话已有的 RUNNING 消息，会破坏回复顺序及插话的投递目标。
3. Agent 主流程异步返回时，外层 finally 提前清理心跳和停止监听。用户取消与宿主停止不能及时中断在途模型请求，长生成也失去续租。原因是 try/finally 内直接返回 Promise，而没有 await 生成结束；同一入口的人设和学习分支存在相同结构。

## 修复与边界

- 进入 tick、异步维护之后及领取前检查宿主停止；领取后注册监听时也同步当前信号，停止后的宿主不再启动新调用。
- 生产 Application 在原短事务内领取：先选择并锁定可领取的会话，再用下一条语句的新快照核对 RUNNING 并更新消息。会话锁持有到领取事务提交；第二次核对防止并发语句使用旧快照。已有生成的会话继续排队，其他会话仍可领取，不引入全局串行锁。
- 三种生成分支等待实际结算后才运行 finally。用户取消仍先写 cancel_requested；仅宿主停止时不伪造用户取消，保留原领取事实供租约恢复核对。
- 不修改 Task/Run 执行权、不重试未知副作用，也不新增 migration 或 HTTP 字段。Breaking Change: No。

## 回归落点

- `assist.integration.test.ts`：已停止宿主零领取/零调用；同会话排队、其他会话可推进及前轮结束后续跑。
- `agent-conversation-main-loop.integration.test.ts`：模型在途时用户取消与宿主停止都能中断请求，分别保持 CANCELLED 与待恢复的 RUNNING 事实。
- 连续工具和执行候选测试的主流程夹具显式关闭独立自动记忆提取，仍保留历史记忆/召回；否则提取模型调用会覆盖测试端口记录的最后一轮工具与上下文。自动记忆默认行为不改，由其独立集成套件及基础聊天调用账本测试覆盖。

关键实现为 [assist-runner](../../apps/api/src/application/assist-runner.ts) 与 [assist-repository](../../apps/api/src/assist/assist-repository.ts)。共享大文件中的 `AGENT_STOP_CLAIM_FENCE`、`AGENT_GENERATION_LIFETIME`、`AGENT_SESSION_GENERATION_FENCE` 是本轮定点修改锚点。

## 模型响应流与计量接缝（2026-10-30 接续）

后续沿 OpenAI-compatible 流接缝复现三处缺陷：SSE 超长完整行与换行符同块到达时绕过原有长度检查；校验失败只终止包装流而不取消上游、释放 reader；已收到的 SDK 缓存用量被后续未携带该字段的 metadata 覆盖成 null。

修复保留既有单行上限，同时检查完整行与未结束的行；正常 EOF、主动取消和校验失败均释放上游 reader，失败时发起上游取消，不等待不可信上游完成清理才向消费者报错。缓存字段按「缺省保留已知值、显式 0/null 更新」处理，不伪造未上报的用量，也不能恢复 SDK 在端口收到数据之前就丢弃的字段。

对应实现为 [模型端点流守卫](../../apps/api/src/workflow/model-endpoint-policy.ts) 与 [模型端口](../../apps/api/src/workflow/openai-compatible-model-port.ts)。回归包括超长完整行、持续打开的上游取消、正常 EOF/调用方取消，以及 SDK metadata 的缺省/0/null；受控本地 HTTP 另验证 SDK→Assist→PG→独立 API 的失败分类、零部分正文及上游 HTTP 响应关闭。取消夹具等待模型调用入口后再触发取消，因为消息 RUNNING 本身不保证 model_call 已创建；保留原账本断言。当前成绩归[调用诊断验收](../testing/acceptance-details/part-16.md#条目-297)，不代表真实 Provider、计费或 TLS/DNS 验收。请求/响应结构不变，Breaking Change: No。
