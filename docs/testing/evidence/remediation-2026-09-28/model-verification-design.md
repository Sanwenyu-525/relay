# 模型配置与验证入口——最小设计（2026-09-28，第二包前置）

状态：**Design only（实现阻塞）**。真实外呼需要放行记录；当前无放行记录（见 [config-sources.md](config-sources.md) 第 2 节与整体验收 A08），本文件只固定设计边界，不构成调用授权。

## 1. 目标

让设置页「模型验证成功」一态获得真实数据源，并满足：密钥只在受控服务端/宿主保存；固定非项目文本；失败不回退 Mock；错误可理解、可执行。

## 2. 入口形状（候选对比后推荐 A）

| 候选 | 形状 | 代价 | 结论 |
|---|---|---|---|
| A（推荐） | `POST /model-port/verify`：服务端用当前进程 `ModelPortConfig` 发起一次固定短文本（如 `relay-verify-1`，非流式、`maxTokens` 下限）调用；结果按新 `kind='VERIFY'` 写入 `model_calls` 账本 | 需一条 migration 放开 kind 取值；账本可追溯、设置页可读「最近一次验证」 | 首选：与「验证结果可关联记录」验收一致 |
| B | 端点只返回当次结果，不落库（进程内存保存 last result） | 零 migration；重启丢失、不可审计 | 仅当明确接受「重启后无历史」时降级 |
| C | 复用 `ASSIST` kind + 合成 origin | 不改表；账本语义被污染（VERIFY 不是 Assist 调用） | 不推荐 |

端点行为（A）：
1. 读取 `readModelPortConfig(process.env)`；`fake` → 409 `MODEL_PORT_NOT_CONFIGURED`（不发外呼）；`invalid` → 409 `MODEL_CONFIG_INVALID`。
2. 以短超时（如 15s）发起固定文本调用；响应只含 `{ ok, latency_ms, provider, model, config_fingerprint, error_category, verified_at }`，**永不包含密钥或原始响应头**。
3. `error_category` 枚举与设置页指引一一对应：`AUTH`(401/403→核对 API Key/权限)、`RATE_LIMIT`(429→稍后重试/配额)、`TIMEOUT`(超时→网络或端点)、`STREAM_BROKEN`(流中断→协议兼容性)、`PROTOCOL`(结构化输出/响应形状)、`NETWORK`(连接失败→端点可达性)。
4. 幂等与权限：任何持本实例 Bearer 的客户端可触发；单实例内并发验证排队或 409（避免放大外呼）。

## 3. 与在途 Run / 配置切换的关系（必须明确）

- 验证端点只读当前进程配置；**不热切换**正在使用的 ModelPort。API/Worker 配置切换 = 改配置文件 + 重启进程；在途 Run 的冻结执行契约不因此改变（模型身份变化不继承进已 Delegate 的 Run——现有 `config_fingerprint` 已按调用记录）。
- 桌面链改配置后：Stop → 改 `desktop.env` → Start；Supervisor/Worker 与 API 同一 `--env-file`，重启后三者指纹一致（见 config-sources 报告的复现命令）。
- 批准不扩大工具权限；验证调用不携带 ContextManifest、不读项目资料。

## 4. 放行后的执行顺序（占位，不在本设计内执行）

1. 固定短文本验证认证/端点/模型/流式协议（无项目资料）。
2. 专用测试项目走 Assist→Delegate→Review→产物→完成→重开，每个结论绑定 Run/调用/产物/版本记录。
3. 错误注入矩阵：401/403、429、超时、流中断、取消、结构化输出错误、缺 usage；失败不得回退 Mock。
4. UNKNOWN 保留原调用身份先核对；取消中不提前显示已取消。

## 5. 当前阻塞

- 真实外呼授权：**无放行记录 → 阻塞**（端点凭据在 `apps/api/.env` 存在，但配置存在 ≠ 授权）。
- 第二 Provider / 安装组合：未验证，单独保留，禁止扩大结论。
