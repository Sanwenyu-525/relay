# 模型配置与验证离线闭环——实现与定向验证记录（2026-09-28/29）

范围：模型配置状态、`POST /model-port/verify`（设计方案 A）、`GET /model-port/verification`、
model_calls `kind='VERIFY'` 账本、设置页六态 UI、Fake 验证分支覆盖。
真实外呼：**无放行记录 → 本包未执行任何真实外呼**（端点凭据存在 ≠ 授权）。

## 1. 交付物

| 变更 | 说明 |
|---|---|
| `apps/api/migrations/0043_model_call_verify.sql` | 放开 `model_calls.kind` 取值至 `VERIFY`；VERIFY 行无 Run/Assist 作用域 |
| `apps/api/src/workflow/model-port-verify.ts`（新增） | 验证编排、错误六分类、可注入 `VerifyCallPort`、可控 Fake、状态读取 |
| `apps/api/src/api/model-api.ts` | 新增 `POST /model-port/verify`、`GET /model-port/verification`；GET /model-port 形状不变 |
| `apps/api/src/workflow/model-port-config.ts` | 抽出 `computeModelConfigFingerprint`（与 ModelIdentity 同算法，不含密钥） |
| `apps/api/src/workflow/openai-compatible-model-port.ts` | 复用共享指纹 |
| `apps/api/src/model/model-call-repository.ts` | VERIFY 账本写入（无作用域）+ `latestVerify()` |
| `apps/api/src/infrastructure/database-schema.ts` | `ModelCallRow.kind` 类型加 `VERIFY` |
| `apps/workbench/src/api/relayClient.ts` | `getModelPortVerification` / `verifyModelPort` 与类型 |
| `apps/workbench/src/views/SettingsView.tsx` | 六态验证 UI、验证按钮、错误分类指引、通知偏好 11.5 文案、Worker 未探测+启动校验诊断 |
| `apps/api/test/unit/model-port-verify.test.ts`（新增） | Fake 五场景、错误分类、配置拒绝、真实外呼形状 |
| `apps/api/test/integration/model-verify.integration.test.ts`（新增） | 真实 PG：409、Fake 五分支落账本、指纹失效、无密钥 |
| `apps/workbench/tests/settingsView.spec.ts` | 六态 UI + 指纹失效 + 通知文案 + 密钥不渲染 |

## 2. 端点契约（摘要）

- `POST /model-port/verify` → `{ ok, latency_ms, provider, model, config_fingerprint, error_category, verified_at }`，永不返回密钥。
  - fake → 409 `MODEL_PORT_NOT_CONFIGURED`（不外呼、不落库）
  - invalid → 409 `MODEL_CONFIG_INVALID`（防御分支；见限制）
  - 并发 → 409 `MODEL_VERIFY_IN_PROGRESS`
  - 真实配置：固定短文本 `relay-verify-1`、非流式、`max_tokens=16`、15s 超时；结果写 `model_calls(kind='VERIFY')`
- `error_category ∈ AUTH | RATE_LIMIT | TIMEOUT | STREAM_BROKEN | PROTOCOL | NETWORK`
- `GET /model-port/verification` → `{ current_config_fingerprint, last, matches_current_config, worker_startup_validation }`
- 配置指纹不含密钥明文；配置（模型/端点/限额）变更 → 指纹变 → UI「已配置未验证」

## 3. 已运行检查（2026-09-29 本地）

| 检查 | 结果 |
|---|---|
| `apps/api` `pnpm run typecheck` | **通过** |
| `apps/workbench` `pnpm run typecheck` | **通过** |
| `apps/api` `pnpm run test`（unit） | **135/135 通过**（含新增 model-port-verify） |
| `apps/api` `pnpm run test:integration -- -TestFile model-verify` | **8/8 通过** |
| `apps/api` `pnpm run test:integration -- -TestFile model-port` | **2/2 通过**（既有 GET /model-port 未破坏） |
| `apps/workbench` `vitest run tests/settingsView.spec.ts` | **10/10 通过** |

### model-verify 集成用例清单

1. fake 配置：verify → 409 `MODEL_PORT_NOT_CONFIGURED`，不写账本
2. 残缺配置：`resolveVerifyConfig` → `MODEL_CONFIG_INVALID`；进程启动校验先拒绝
3. verify 需要 Bearer；GET verification 可读且不含密钥
4. Fake 注入五种结果均写入 `VERIFY` 账本并可回读（SUCCESS/AUTH/TIMEOUT/INVALID_MODEL/NETWORK）
5. 配置指纹变化后旧验证 `matches_current_config=false`
6. 未配置时读取状态：无指纹、无匹配
7. 配置侧拒绝不落库
8. 真实验证外呼路径在本套件中不被触发

### settingsView 用例清单

- fixture 模式不请求；Mock 端口「未配置」；真实 Provider「已配置未验证」→ 点击验证 →「验证通过」
- 验证失败显示 AUTH 指引；指纹不匹配回落「已配置未验证」；配置残缺「当前不可用」
- 通知偏好与工作台 11.5 一致（无「策略与调度尚未冻结」）
- 密钥字段即使出现也不渲染；Worker 显示「可执行性未探测」且不称同一配置文件

## 4. 剩余限制

1. **真实外呼未放行**：真实 Provider 的连接验证端点已实现，但本包不触发外呼；放行后需按设计第 4 节跑错误注入矩阵与专用测试项目链路。
2. **HTTP 层 `MODEL_CONFIG_INVALID` 难以经进程存活路径到达**：`checkers.ts` 模块加载即 `readModelPortConfig`，残缺配置进程无法启动（既有设计，防止静默回退）。端点分支仍在，由服务层测试覆盖语义。
3. **验证历史 latency_ms 不入库**：账本无延迟列，历史行回读为 `latency_ms=null`；当次 POST 响应含实时延迟。
4. **指纹不含 API Key**：与既有 `ModelIdentity.configFingerprint` 同算法；仅换密钥不改变指纹（换模型/端点/限额会）。若需密钥轮换也失效，应另扩指纹（未做，避免破坏既有调用身份）。
5. **Worker 可执行性未探测**：设置页明确显示「未探测」；仅附 API 进程环境的启动校验诊断（OK/FAILED/NOT_CONFIGURED），不声称 Worker 与 API 同一配置文件。
6. workbench 全量 vitest 在并发负载下 `tasks.spec.ts` / `run-events.spec.ts` 偶发时序失败（与本包无关，定向重跑通过）。

## 5. 文档同步

本文件为过程证据。设计仍见 [model-verification-design.md](model-verification-design.md)；
UI 通知规则事实源为 [workbench-design 11.5](../../../frontend/workbench-design.md#115-已确认的人工介入提醒规则)。
