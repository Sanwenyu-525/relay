# 真实模型连接与 Provider 可靠性跑通任务书

日期：2026-11-09。状态：**待执行**。本文件是执行提示词，不是已实施记录；成绩只写[统一功能验收表](../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。授权：允许为跑通本模块做**最小产品代码修复**；不 commit/push，不扩展功能，不泄露密钥。

## 1. 目标与「跑通」定义

让「登记连接 → 会话/Run 选择 → 受理冻结 → 真实调用 → 账本与刷新后身份不变」这条链路可核对：

> 连接登记（凭据只进 DPAPI）→ 选择默认/会话连接 → 消息或 Run 冻结连接身份、配置指纹、凭据指纹 → 真实 Provider 调用 → `model_calls` 记录 → 刷新/重新认证后仍是同一连接与同一冻结事实。

「跑通」必须同时满足：

1. 真实 Provider 至少一次成功调用；无有效凭据时如实 BLOCKED，不用 Fake 冒充；
2. 冻结的连接 ID、型号、协议、配置指纹、凭据指纹逐字可核对；
3. 任一闸门失败零外呼、零新账本、零模拟输出、零静默回退；
4. 429/超时/断流/取消分类正确，不把取消写成失败、不把限流写成通用失败；
5. 同 provider 同型号的两条连接互不冒充；轮换 Key 后旧验证结论失效；
6. 密钥不出现在日志、业务表、回执、HTTP 响应或前端存储。

## 2. 开工检查与必读事实源

1. 读根 `AGENTS.md`、[CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)；验收表搜索 `MODEL-SETTINGS-01`、`MODEL-SETTINGS-03`、`model-provider-faults`、免费模型额度行。
2. 读 [ADR-036](../docs/decisions/ADR-036-multi-provider-model-connections.md)、[HTTP §10.116/§10.117/§10.134](../docs/api/http-command-contract/part-08.md)、[工作台 §27.5/§28](../docs/frontend/workbench-design/part-09.md)、[测试计划 §受控故障边界](../docs/testing/verification-plan/part-02.md)。
3. `git status` 有大量未提交改动；本链相关文件包括 `model-connections.ts`、`model-connection-runtime.ts`、`select-session-model.ts`、`run-model-port.ts`、`model-port-factory.ts`、`openai-compatible-model-port.ts`、`anthropic-messages-model-port.ts`、`assist-free-model-routing.ts`、`model-call-recorder.ts`、`model-port-verification.ts` 及相关测试。逐文件读 diff，不覆盖、不回退。
4. 本机凭据只从用户级环境/DPAPI 读取；不把 Key 写入证据、命令输出或文档。没有有效 Key 时先报告，不伪造。
5. 行号可能移动；下表入口先 `rg` 复核。

## 3. 当前实现地图

| 环节 | 当前入口 | 关键事实 |
|---|---|---|
| 连接命令 | `apps/api/src/application/model-connections.ts:300/352/435/473` | 创建/编辑/轮换/启停；协议枚举 `:57` |
| 连接仓储 | `apps/api/src/model/model-connection-repository.ts:65/74/153` | 工作区作用域；不跨工作区共享 |
| HTTP | `apps/api/src/api/model-connection-api.ts:203/217/229/246/258/313/343-393` | 列表/默认/probe/逐连接验证 |
| 凭据 | `apps/api/src/credentials/credential-store.ts:11`；`dpapi-credential-store.ts:79/169-191`；`apps/credential-helper/src/main.rs:126-218` | 端口无列举/无回读；15s 超时；DPAPI helper |
| 会话选择 | `apps/api/src/application/select-session-model.ts:144/201`；`chat-command-api.ts:149/169` | 只接受本工作区 ACTIVE 且有凭据的连接 |
| 聊天冻结 | `apps/api/src/application/model-connection-runtime.ts:209/277`；`assist-commands.ts:827` | 显式会话选择 → 工作区聊天默认 → 进程默认；六道闸门 |
| Run 路由 | `apps/api/src/application/run-model-port.ts:101/119/145/174/228/258` | 冻结连接优先；legacy → `MODEL_NOT_CONFIGURED`；零回退 |
| 端口工厂 | `apps/api/src/workflow/model-port-factory.ts:33` | 唯一构造点 |
| OpenAI 兼容 | `apps/api/src/workflow/openai-compatible-model-port.ts:64/291/404` | 流式、超时、取消、finish_reason |
| Anthropic | `apps/api/src/workflow/anthropic-messages-model-port.ts:43/155/218/430/503` | `/messages`、`message_stop`；JSON 明确拒绝 |
| 免费路由 | `apps/api/src/application/assist-free-model-routing.ts:54/291/442/509`；`assist-model-snapshot.ts:80/125` | 429 + 账户日剩余正数才换候选；冷却持久化 |
| 账本 | `apps/api/src/application/model-call-recorder.ts:19/59`；`model-call-repository.ts:68/250/288` | 调用前 STARTED；失败分类；purpose |
| 验证 | `apps/api/src/application/model-port-verification.ts:100/194/57`；`model-verify-target.ts:24` | 13 态目标；DISABLED 零外呼 |

## 4. 已验收范围与未闭合项

- **MODEL-SETTINGS-01**（验收表第 41 行）：自检、已 commit/push `7fdafd90`；真实 PG/HTTP `chat-model-connection` 8/8、`session-model-selection` 11/11、`model-connections` 7/7、`model-verify` 8/8、`run-model-connection` 4/4。**无有效真实 Key，Provider 证据全为受控 Fake/桩**；跨工作区共享未开放。
- **MODEL-SETTINGS-03**（第 37 行）：自检；双协议为受控 Fake 的 HTTP/SSE 形状；未对接真实 Anthropic；JSON 类功能明确不可用。
- **model-provider-faults 18/18**：受控 SSE/HTTP 故障，不是真实外呼；覆盖 OpenAI 成功流/用量、客户端中断、Anthropic 头/路径/流式用量/tool_use/401。
- **真实外呼**：Agnes 617ms、Spark 6314ms 各一次「OK」；另有真实 Spark 聊天链。均为连通级，不声明稳定性或产品语义质量。
- **免费模型**：真实 RATE_LIMIT 与 `remaining:0` 有记录；自动额度接续未验收；只对明确 429 + 账户日剩余正数换候选。
- 未闭合：DPAPI 安装包可用性/切换/备份恢复；真实密钥轮换；Anthropic 真实限流/计费；跨工作区共享；独立验收。

## 5. 范围与非目标

**范围内**

- 连接登记、默认设置、会话选择、消息/Run 冻结、真实调用、账本核对。
- Key 轮换失败关闭、429/超时/断流/取消分类、同型号连接不冒充、逐连接验证。
- `MODEL_NOT_CONFIGURED` 零外呼与配置后恢复。

**范围外**

- Agent 提示词/工具循环、Task/Run 业务链、记忆/上下文。
- 跨工作区共享连接、连接池/负载均衡、自动换 Key。
- 直接引入上游 SDK 或新 Provider 框架；必须经 `createModelPort()`。
- 在无账号时宣称真实 Anthropic/免费额度通过。

## 6. 实施顺序

1. 用受控端口先复跑 S1 冻结、S2 轮换、S3 故障分类、S4 同型号隔离、S5 `MODEL_NOT_CONFIGURED`，确认基线。
2. 若本机有有效真实凭据，跑 S1/S3 的真实外呼子场景；否则明确 BLOCKED，不降低证据口径。
3. 每个失败先定位到「连接/选择/冻结/闸门/端口/账本/验证」哪一层；只改阻断点。
4. 每次修改重跑同一场景 + `model-provider-faults`、`chat-model-connection`、`session-model-selection`、`run-model-connection`、`model-verify` 定向用例。

## 7. 验收场景

### S1 冻结身份（P0）

- 登记连接 → 设为聊天默认 → 新建会话选择该连接 → 发消息 → 真实/受控调用 → 刷新并重新认证。
- 断言：消息冻结的连接 ID、型号、协议、配置指纹、凭据指纹逐字一致；`model_calls` 有对应行；没有回退到进程默认。

### S2 Key 轮换（P0）

- 在途/排队调用期间轮换 Key；断言 `ASSIST_MODEL_CREDENTIAL_CHANGED` 停止、零外呼；旧验证结论失效；新调用使用新指纹。

### S3 故障分类（P0）

- 429 → `RATE_LIMIT`；超时 → `MODEL_TIMEOUT`；断流 → 对应流错误；用户取消 → `CANCELLED` 而非 `FAILED`。
- 断言：消息行与 `model_calls` 同一口径；不静默换模型/换 Key。

### S4 同型号隔离（P0）

- 同 provider 同型号两条连接各验证一次；断言验证目标按 `connection_id` 归属，`target_last` 精确，不互相冒充；轮换后必须重验。

### S5 未配置（P0）

- 无任何可用配置时发消息/Run；断言 `MODEL_NOT_CONFIGURED`、零外呼、零模拟输出；配置后可重试成功。

### S6 真实外呼（P1，凭据可用时）

- 用本地已登记真实连接发一条无敏感内容的消息；记录耗时、HTTP 状态、`model_calls`、回复摘要。无凭据则记 BLOCKED，不用 Fake 替代。

## 8. 修复边界

- 任一闸门失败：零外呼、零新账本、零模拟输出。
- 零回退：不回退进程默认、其他连接或 Fake 冒充。
- 不静默换模型/换 Key；停用、改型号、改协议、轮换均类型化停止。
- 不记录密钥：不入业务表、日志、回执、HTTP 响应或前端存储。
- 测试放行仅 `RELAY_TEST_ALLOW_FAKE_MODEL=1`；生产不设置。
- 不删除/弱化失败测试；不 commit/push。

## 9. 环境与证据

- PG：一次性临时集群；记录迁移版本（0143/0144/0158/0160 等）。
- API：真实进程；记录端口、PID、构建来源。
- 凭据：只从用户级环境/DPAPI 读取；证据中只写指纹前缀或「已配置」，不写 Key。
- 证据目录：`tmp/MODEL-PROVIDER-20261109/`；保存 JSON checks、受控故障日志、真实外呼摘要。
- 明确区分：受控 Fake 证据、受控 HTTP/SSE 故障、真实外呼、产品语义质量。

## 10. 完成定义

1. S1–S5 在受控端口全部通过；S6 在凭据可用时通过，否则明确 BLOCKED。
2. 定向回归：`model-provider-faults`、`chat-model-connection`、`session-model-selection`、`model-connections`、`model-verify`、`run-model-connection`；`apps/api` 类型检查通过。
3. 没有新增回退路径、没有密钥泄露、没有把受控成绩写成真实外呼。
4. 验收表更新一行；`CODEX_NEXT_STEP` 只写当前状态与剩余限制。
5. 报告区分自检、独立验收、真实 Provider、Windows/安装态。

## 11. 已知基线与坑

- 本机可能没有有效真实 Key；无凭据时不要反复外呼或切换候选，按 BLOCKED 记录。
- Spark 可能 `RATE_LIMIT`；按 `retry_after_at` 等，不盲重试。
- 免费模型额度 `remaining:0` 时不会换候选；不要用「重试」绕过额度。
- Anthropic JSON 类请求在外呼前明确拒绝；不要为了“跑通”放宽成静默文本。
- 受控故障测试不能推断真实 Provider 行为；真实外呼也不能替代故障矩阵。
