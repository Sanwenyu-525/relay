# C：持久控制、恢复与动作准入

> 当前执行入口为 [M01–M07](stack-migration.md)。本文件保留原 P 阶段业务范围；模型统一 gpt-6-sol / ultra，UI 使用完整 React 迁移路线，技术选择按 ADR-010。不得按旧编号重建工程；前置与验收按公共契约及当前授权执行，后置不等于通过。

## P08：控制请求和恢复器

```text
执行 P08，前置 P07。读 AGENTS.md、prompts/README.md、contracts/02-state-and-execution.md、contracts/04-recovery-and-commit.md、docs/testing/verification-plan.md、docs/database/physical-design-postgresql.md。
源码对照：按公共“本地源码参考要求”核对 .research 中 LangGraph interrupt/checkpoint/重放及已选执行方案的中断测试；明确借鉴机制与直接依赖的区别，不能把框架恢复成功当成本项目业务提交或外部副作用安全。
范围：持久 PAUSE/CANCEL/HANDOFF/CANCEL_TASK、Resume、worker lease/epoch、恢复扫描与故障点。请求先入库返回 202，安全点才 APPLIED；UI 不能把已请求当已接手。不同意图冲突需拒绝或显式 supersede，不后写覆盖。
产品补充核对：工作台第 11 节的恢复摘要是读投影，不能代替本节恢复器或执行权交接。Focus/Later/静音只影响展示或提醒，不取消持久控制、不消除未决阻塞；来源或外部回执不明时保留未知，禁止据聊天自报完成推进 Run。新增通知与并发策略未定时不借本节实施。
先查 P00 采用表，复用已选 runtime 的中断/checkpoint 能力，只补业务控制与核对；禁止框架和自研恢复器同时推进同一内部步骤。测试必须穿过真实框架持久化与事件适配，不能全部 Mock 掉集成边界。
实现停止与完成同数据库序列化边界，两个提交顺序都正确。过期 Worker 业务提交拒绝；终态迟到结果仅作核对证据。已有成功步骤不重放；PASS 后恢复只重试提交。P09 未完成前以有独立效果日志的 Fake Action 模拟未知副作用，不开放真实工具。
故障注入覆盖 B03–B08、D01–D07：重启不丢意图、claim 过期不证明进程停止、资源未安全不能交接、完成回执丢失仍幂等。使用 barrier 控制并发而非 sleep 猜顺序。交付恢复说明及每个故障证据，进入 P09。
```

## P09：Permission、Gateway 与资源

```text
执行 P09，前置 P08。读 AGENTS.md、prompts/README.md、docs/architecture/tool-adapters.md、docs/api/module-api.md、docs/database/physical-design-postgresql.md、contracts/04-recovery-and-commit.md。
源码对照：按公共“本地源码参考要求”核对 .research 中 DeepSeek Harness 工具准入、Pi 工具钩子及 Codex 审批/中断的相关实现和测试；交付中明确哪些机制被采用、哪些业务权限和恢复约束仍由 Relay 补齐。
范围：Connection/Capability/Permission 独立模型、规范资源/claim、operation/invocation、批准占用和 authority 锁协议。AUTO/ASK/DENY 判定以实际目标/参数/配置为依据；连接存在不是权限。所有动作 Prepare→Admit→事务外 execute→记录 outcome，不允许 Adapter 自行重试写入。
验证已选 harness 的内置工具也经过本项目 Gateway 或已证实等效的权限边界；仅在外面包装一次调用不算覆盖内部动作。优先复用现成工具实现，补必要准入与证据适配，不重新开发通用工具平台。
实现跨 Task/Project 根重叠排他、HELD/QUARANTINED 唯一占用、Task/worker/resource 三类 token 验证。权限撤销与准入通过同 authority 行串行化；批准固定逻辑动作，每次 invocation 另留绑定。USER_IMPORT 作为显式类型来源校验，不以空 run_id 免检查。
先交 FakeAdapter 与可核对效果，真实适配器另做。测试 B07/B08、C03/C09、D01–D07，覆盖撤销/准入两顺序、并发批准、UNKNOWN 不可换 ID/Provider 绕过。API 不公开任意改成功入口，日志脱敏；同步新增表/约束与错误，进入 D。
```
