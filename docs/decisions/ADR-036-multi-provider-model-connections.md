# ADR-036：多 Provider 模型连接管理的数据模型与凭据存储前提

## 状态与日期

2026-10-27。**Proposed（仅设计，未实现、未验收）**。

本文件只记录 P2 的数据契约候选、取舍与被识别出的**前置阻塞项**。它不表示任何连接管理能力已经存在：当前实现仍只有「进程环境变量里的单一默认连接 + OpenRouter 独立免费凭据」，即 `RELAY_MODEL_*` 与 `RELAY_OPENROUTER_API_KEY`。本 ADR 不改变任何已实现行为。

## 背景

P2 要求登记多个 OpenAI 兼容 Provider，每条连接可设名称、类型、HTTPS 端点、默认型号与调用预算，凭据可轮换、可验证、可停用，并支持工作区默认连接与会话级选择；同时必须保持 `RELAY_MODEL_*` 向后兼容、旧 Run 身份不变。

P0/P1 已落地的相关事实（本轮之前或本轮完成，均可复核）：

- 模型身份由 Run 执行契约冻结（`model_selection_snapshot`），执行端唯一入口 `application/run-model-port.ts` 只按冻结计划解析，不符即停。
- 凭据身份（`sha256(域‖provider‖key)`）已落在 `model_calls.credential_fingerprint`、`execution_contracts.credential_fingerprint`、`assist_messages.model_credential_fingerprint` 三个服务端列（迁移 0142），换 Key 会失效旧验证、停止旧 Run、隔离账户冷却。
- 连接验证已支持显式目标（`{connection:'openrouter', model}`）与目标级 13 态。

## 前置阻塞项（本 ADR 的核心结论）

**仓库当前没有任何安全秘密存储设施。** 全仓检索 `DPAPI` / `CredWrite` / `keyring` / `keytar` / `safeStorage` 只命中受管内容存储（它保存用户文件，不是密钥库），没有任何操作系统凭据库封装。凭据今天只来自进程环境变量（`.env`，被 Git 忽略）。

因此 P2 **不能**按「先把密钥写进普通业务表，之后再换」的路径推进：那会把明文密钥落到业务库、备份、日志与迁移快照里，违背「不写入普通业务表」的硬约束，也无法回滚。

在实现连接管理之前必须先具备：

1. 一个受操作系统保护的凭据存储（候选见下表），只暴露「写入 / 删除 / 按不透明句柄解析」三个动作；
2. 解析只发生在服务端进程内存里，**读取接口不存在**（任何 HTTP 端点都不能回读密钥或摘要）；
3. 轮换时旧句柄立即失效，并用 `credential_fingerprint` 让冻结调用发现身份变化。

## 候选与取舍

| 问题 | 候选 | 取舍 |
|---|---|---|
| 秘密存储 | ① Windows DPAPI（Tauri/Rust 侧封装，绑定当前用户） ② Windows Credential Manager（`CredWrite`/`CredRead`） ③ Tauri `keyring` 生态插件 ④ 自建加密文件 + 机器密钥 | 倾向 ①/②：不引入第三方服务、绑定用户会话、无需主密码。③ 需先核对维护状态与打包行为（新依赖须单独论证）。④ 自建加密等于自己发明密钥管理，代价与风险不可接受 |
| 凭据引用形态 | ① 业务表存不透明 `credential_ref` + `credential_version` ② 业务表存密钥密文 | 选 ①：业务表永远不含密文；密文只在系统凭据库 |
| 连接与模型的关系 | ① 连接只存默认型号，型号列表来自目录/自述 ② 每条连接维护型号清单表 | 选 ①（最小）：型号选择仍走既有目录与 `session_model_selection`，不新建第二套模型清单 |
| 默认连接作用域 | ① 进程级单默认 ② 工作区级默认 | 选 ②：既有 `workspace_default_directories` / 上下文档位已是工作区级默认的成熟形态，沿用它而不是再造一套 |
| 会话选择的连接维度 | ① 把 `session_model_selection.connection` 枚举扩成连接 id ② 新增 `connection_id` 列，保留旧枚举语义 | 选 ②：`connection` 枚举被迁移 0089/0094/0095 的 CHECK 与回执语义钉住，直接改枚举是 Breaking 且难以回滚 |
| 旧环境变量 | ① 视为一个虚拟内置连接（不落库） ② 迁移期回填成一条真实连接 | 选 ①：回填会把密钥搬进数据库，正是要避免的路径；虚拟连接保留 `RELAY_MODEL_*` 语义，冻结身份仍用配置指纹 + 凭据身份 |
| 停用/撤销的连接 | ① 仅拦新调用 ② 同时终止在途 Run | 选 ①：在途 Run 已有冻结身份与安全停止点，撤销权限本身由既有 Permission 机制负责，不新建第二套终止语义 |

## 拟议数据模型（未实现）

- `model_connections`：`id`、`workspace_id`、`name`、`provider_kind`（`openai-compatible`）、`base_url`（复用 `parseModelBaseUrl` 的公开 HTTPS 约束）、`default_model`、预算四列（与 `ModelPortConfig` 同名同义）、`status`（`ACTIVE`/`DISABLED`）、`credential_ref`、`credential_version`、`revision`、时间戳。
- `workspace_default_model_connection`：`workspace_id` 主键、`connection_id`、`revision`，与既有工作区默认项同一 CAS 风格。
- `session_model_selection` 增 `connection_id`（可空）：空＝沿用旧 `connection` 枚举语义（兼容），非空＝指向具体连接。
- `execution_contracts` 增 `connection_id`（可空，冻结列）：旧 Run 为空，按既有兼容路径解析；新 Run 冻结具体连接，连接被停用后旧 Run 仍按冻结身份停止而不是换连接。
- 迁移编号从 0143 起追加；0142 及以前不改写。

## 后果

- 实现顺序被约束为：**凭据存储 → 连接表与默认连接 → API/UI → 会话与 Run 冻结接线**。跳过第一步就无从安全保存凭据。
- 代价：新增一个 OS 级依赖与打包/权限验证面（DPAPI 在打包后的可用性、用户切换、备份恢复）；连接管理 UI 是新的设置页分区；迁移需要一次数据模型扩展但**不需要**密钥回填。
- 风险：虚拟内置连接与真实连接并存期间，解析顺序必须是「会话选择 → 工作区默认连接 → 进程默认」，任何一处顺序错误都会重现「冻结 A、调用 B」的旧缺陷；因此接线必须复用 `run-model-port.ts` 这个唯一入口，不得新增第二条解析路径。

## 实现进度（2026-10-27）

**前置设施已完成并通过验证，连接管理本身仍未开始。**

- `apps/credential-helper`（Rust + Windows DPAPI，当前用户作用域 + 固定域分隔熵）：`protect` / `resolve` / `delete` / `status` 四个操作，一次进程一个 JSON 请求，引用只接受 `[A-Za-z0-9_-]{8,64}`（同时是文件名，杜绝 `../` 逃逸）。Rust 单测 **5/5**（真实 DPAPI 往返、落盘无明文、篡改 blob 拒绝、空秘密拒绝、删除幂等）。
- `apps/api/src/credentials/credential-store.ts`：端口（put/resolve/delete/status，**没有列举、没有回读摘要**）与引用校验；`dpapi-credential-store.ts`：以子进程调用 helper，超时 15s、输出上限 64 KiB、失败一律类型化（`HELPER_PROTOCOL`/`HELPER_EXIT`/`HELPER_TIMEOUT`/`PLATFORM_UNSUPPORTED`），错误消息不含秘密。单测 **7/7**（假 helper 验协议与失败语义）。
- 真实二进制集成测试 `credential-store.integration.test.ts` **2/2**（真实 DPAPI 往返、blob 不含明文、引用逃逸拒绝、缺失引用按「未配置」）；helper 由 `apps/api/scripts/run-integration.ps1` 构建并导出 `RELAY_CREDENTIAL_HELPER`。
- 运维入口 `node dist/src/cli/model-credential.js put|status|check|delete <ref>`：秘密**只从 stdin** 读（命令行参数会进进程列表与历史），`check` 只回「有没有、多长」，永不回显秘密。
- 环境契约：`RELAY_CREDENTIAL_ROOT`（缺省 `<RELAY_DATA_ROOT>/credentials`）、`RELAY_CREDENTIAL_HELPER`（缺省按进程目录推断）。

- **凭据引用已接入默认连接（虚拟内置连接）**：`credentials/credential-env.ts` 在 API 与 Worker 启动最早期把 `RELAY_MODEL_API_KEY_REF` / `RELAY_OPENROUTER_API_KEY_REF` / `OPENROUTER_API_KEY_REF` 物化成对应明文变量，之后既有 20+ 个同步读取点不改一行。歧义（明文 + 引用）、引用缺失、存储不可用三种情况都让进程启动失败，不回落明文/默认模型/「未配置」；物化后删除 `_REF`，二次物化是 no-op。单测 **9/9**，真实 DPAPI 集成新增一例（库里的 Key → 可用配置，轮换后 `credential_fingerprint` 变化而配置指纹不变）。
- 因此「凭据不进业务表」在**单连接阶段就已经成立**：业务表将来只存 `credential_ref`，秘密始终只在系统凭据库。

**仍未做**：`model_connections` / 工作区默认连接 / 会话与 Run 的 `connection_id` 冻结接线、连接管理 API 与设置页 UI。这些仍按上面的实现顺序推进，且不得新增第二条模型解析路径。

## 阶段二进度（2026-10-27）：连接登记已落地，执行接线未做

- 迁移 `0143_model_connections`：工作区作用域一张表（名称、Provider 类型、HTTPS 端点、确切型号、预算五列、`credential_ref`、`credential_version`、`status`、`revision`）。预算上下界与 `ModelPortConfig` 一致，跨列约束由表 CHECK 与应用层整行校验双重保证。
- 端点（§10.116）：列表 / 读取 / 凭据存在性 / 创建 / 更新 / 轮换 / 启停。写命令走 `runIdempotentCommand`（回执与业务事实同事务、`command_id` 重放返回当时结果），更新一律 revision CAS。
- 凭据：请求体的 `api_key` 只出现一次 → 系统凭据库 → 表里只留引用。响应、列表、错误、回执均不含密钥/密文/摘要/引用；`command_id` 的载荷摘要也不含 `api_key`。轮换覆盖同一引用下的秘密并加代数，不留孤儿 blob。
- 无 DELETE：停用是状态，已冻结在旧连接上的历史需要原身份继续可读。
- 验证：`model-connections.integration.test.ts` 7/7（真实 PG + 真实 HTTP + 真实 DPAPI，含「轮换后库里秘密确实被替换且无孤儿 blob」「跨工作区 404」「重放不重复创建」）；`migration` 12/12（清单已同步 0143）；`model-port` 2/2、`model-verify` 8/8 无回归。

**仍未做（下一阶段）**：`workspace_default_model_connection`、`session_model_selection.connection_id`、`execution_contracts.connection_id` 冻结列，以及 `run-model-port.ts` / 冻结流程对连接的解析。**这些连接目前不可用于执行**——执行端仍只按 Run 冻结计划或进程默认解析；端点集合也不声称任何连接「已验证」。接线时必须复用 `run-model-port.ts` 这一条解析路径，不得新增第二条。

## 阶段三进度（2026-10-27）：默认连接 → Run 冻结 → 执行端解析已打通

- 迁移 `0144_workspace_default_model_connection`：默认连接表 + `execution_contracts.connection_id` / `connection_credential_version`（同现同缺、不进快照、不参与 `contract_hash`）。
- `application/model-connection-runtime.ts`：**唯一一处**把「连接行 + 库里秘密」变成 `ModelPortConfig` 的地方，冻结端与执行端共用，因此两边算出的配置指纹必然一致。
- 冻结：`DelegateTask` 优先按工作区默认连接冻结（单候选）；连接停用/凭据缺失/连接不存在时**委派失败**，不退回进程默认。
- 执行：`run-model-port.ts` 在进程默认分支**之前**分流到 `resolveFrozenConnection`，四道闸门（可见 → ACTIVE → 代数一致 → 指纹一致）后才解析秘密；停止原因新增 `MODEL_CONNECTION_UNAVAILABLE` / `MODEL_CONNECTION_DISABLED` / `MODEL_CONNECTION_CREDENTIAL_MISSING`。
- 端点：`GET/PUT /model-connections/default`（§10.117）。
- 设置页：`ModelConnectionsCard`（懒加载）——列表、状态、凭据代数、设为默认、启停、轮换凭据、新增连接；文案明确「默认连接只影响新 Run，会话聊天仍按会话选择或进程默认」。
- 验证：`run-model-connection` 4/4（真实 PG + 受控 Provider）、`migration` 12/12（清单同步 0144）、Workbench `modelConnectionsSettings` 7/7 与设置页回归 33/33。

**仍未做**：会话级选择接入连接（`session_model_selection.connection_id`，需新增列而非改枚举）、Assist 聊天按连接解析（目前仍走进程默认/会话选择）、连接级「验证」按钮（验证仍按进程默认与 OpenRouter 目标）、跨工作区共享连接。

## 未决问题

1. 秘密存储选型（DPAPI 与 Credential Manager 的实际打包行为需在目标机器验证）。
2. 多 Workspace 下连接是否可共享（倾向：连接属工作区，不跨工作区可见）。
3. 凭据轮换时是否保留旧版本的冷却/验证历史（倾向：保留历史行，仅让旧句柄失效）。
4. 连接级预算与工作区上下文档位的优先级（倾向：连接预算是上限，档位只能取小）。
