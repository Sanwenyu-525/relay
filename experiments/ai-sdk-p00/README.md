# AI SDK Core P00 离线边界实验

状态：`离线协议边界已实测`，不是生产接入、Provider Spike 或 ADR-006 冻结证据。

本目录只验证 AI SDK Core 在 Relay 边界的一小段行为：流式文本和完整工具参数可被获取；候选在进入 Relay 前经过实际 SDK schema 校验和 TypeBox 复核；工具定义不含 `execute`，因此 SDK 不会自动执行该工具。Relay 仍须持久化模型响应、动作身份和规范化参数，并在审批、Gateway、UNKNOWN 核对后才执行外部效果。

2026-09-20 接续增加 Fastify 5 的离线联合 schema 检查：同一 TypeBox 定义分别通过 Fastify 的实际 HTTP validator 和 AI SDK 官方 Mock 的工具调用解析。Fastify 显式设为 `coerceTypes: false`、`removeAdditional: false`；合法输入、缺字段、未知字段和数字代替字符串的 fixture 必须在两边得到一致的接受/拒绝结果。它验证受信应用定义的 HTTP/工具子集，不允许把模型或用户提供的 schema 交给 Fastify 编译。

## 锁定输入

- `ai@7.0.107`，Apache-2.0，Node `>=22`；tarball 完整性为 `sha512-PVYQ3W9kR8oYiGQxbg4aFIlhQzKskZm8UV+4E0zB2uKOzFr8ju3bXQncOOZtLsOgJY8vdpgyu3cXtomsfcdQYg==`。
- 官方来源为 [vercel/ai](https://github.com/vercel/ai)，tag `ai@7.0.107`，提交 [`08ae5ad05bc12496dd1ffcf64e34419e0831300d`](https://github.com/vercel/ai/tree/08ae5ad05bc12496dd1ffcf64e34419e0831300d)。完整源码路径、SHA-256、用途和实验依赖见 [upstream-lock.json](upstream-lock.json)。
- 使用官方 `ai/test` 导出的 `MockLanguageModelV4`，不是自制 SDK 或自定义 Provider 协议。上游实现和测试入口分别是 `packages/ai/src/test/mock-language-model-v4.ts`、`packages/ai/test/index.ts`、`packages/ai/src/generate-text/stream-text.test.ts`。
- 依赖完整性与全部传递版本由 [pnpm-lock.yaml](pnpm-lock.yaml) 固定。`@sinclair/typebox@0.34.52` 仅用于把固定 JSON Schema 传递给 SDK 并作第二次运行时校验。
- `fastify@5.12.5`，MIT，npm 完整性为 `sha512-OB2k1dlxs5/NAABqeKV2FUHkSD2BbENsCak8yULVcymn3fHIPDVa9TI3SDnJSWYSllZmSYuZXy2gTnsT+Sut1A==`；上游为 [fastify/fastify](https://github.com/fastify/fastify)，发布 gitHead `ba235fdcd9a83a4c7ccf793f7b2596a8f65389b6`。它只用于 `app.inject()` 的本地校验，未启动监听端口或增加业务 API。

本地源码研究缓存位于 `.research/vercel-ai`，由 `.gitignore` 排除。可用以下命令复现该输入：

```powershell
git clone --depth 1 --branch "ai@7.0.107" https://github.com/vercel/ai.git .research/vercel-ai
```

## 最小边界

[src/boundary.ts](src/boundary.ts) 只定义一个 `write_artifact` 候选工具。它传入 AI SDK 的 `jsonSchema(..., { validate })`，由 TypeBox 拒绝缺字段、额外字段或不符合长度限制的输入；工具对象没有 `execute` 属性。

成功时只生成一个 JSON 候选，保留：Provider、model ID、模型 response ID/model ID/timestamp、`responseMessages`、tool call ID 和已验证参数。候选 JSON 在测试中经过 `JSON.stringify` / `JSON.parse` 往返；本实验不把它当作数据库恢复校验器。单轮出现零个、截断、非法、未知或多个工具调用均不会成为候选。

## 已运行证据

早期 7 项离线基线的 run ID 为 `ai-sdk-p00-20260920T085425Z`，输入 SHA-256、命令和边界声明见 [结果索引](results/ai-sdk-p00-20260920T085425Z.json)。原始输出：

- [Node 22 类型检查](results/ai-sdk-p00-20260920T085425Z-node22-typecheck.txt) 与 [7/7 测试](results/ai-sdk-p00-20260920T085425Z-node22-test.txt)
- [便携 Node 24 类型检查](results/ai-sdk-p00-20260920T085425Z-node24-typecheck.txt) 与 [7/7 测试](results/ai-sdk-p00-20260920T085425Z-node24-test.txt)

接续 run `ai-sdk-p00-20260920T120324Z` 使用新增的 Fastify 5.12.5 锁定输入，便携 Node 24 类型检查、构建与 **8/8** 测试均 exit 0；输入摘要、命令、输出与未覆盖项见 [结果索引](results/ai-sdk-p00-20260920T120324Z.json)、[类型检查](results/ai-sdk-p00-20260920T120324Z-node24-typecheck.txt)和[测试输出](results/ai-sdk-p00-20260920T120324Z-node24-test.txt)。主 Agent 也在同一稳定输入上独立复验了该三项命令，均 exit 0。

已覆盖：流式文本和完整参数、非法 JSON、JSON 合法但 schema 非法、额外调用、截断参数、Provider 错误、实际在途 `AbortSignal` 取消、候选 JSON 往返，以及 Fastify + TypeBox + AI SDK 对共享 fixture 的联合校验。测试完全离线，没有模型端点或凭据。

## 复现

当前系统 Node 22.22.3 可运行兼容检查；项目候选基线的便携 Node 24.21.0 可按下列命令复验，不改系统默认 Node：

```powershell
$env:npm_config_registry = 'https://registry.npmjs.org/'
Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:http_proxy,Env:https_proxy,Env:ALL_PROXY,Env:all_proxy -ErrorAction SilentlyContinue
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm test

$node24 = Resolve-Path ..\..\.research\runtime-cache\node-v24.21.0-win-x64\node.exe
& $node24 node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
& $node24 node_modules\typescript\bin\tsc -p tsconfig.json
& $node24 --test dist\src\boundary.test.js
```

前两行仅作用于当前 PowerShell 进程：本机默认镜像/代理在安装时不可用，所以安装使用官方 registry；不会修改用户全局 npm、pnpm 或代理设置。

## 未证明的事项

这不是测试计划第 6 节 Spike 3 的通过证据：用户当前没有配置两个合法 Provider 端点，因此没有运行 OpenAI 加第二个真实 Provider，也未验证 Provider 特性子集、真实断流/超时或真实取消语义。它同样不证明 PostgreSQL 的持久化和跨进程恢复、审批消费、Gateway 准入、UNKNOWN 效果核对、真实外部副作用，或 37 项产品验收。正式接入时模型调用属于 Relay 持久步骤，但在数据库短事务之外执行；恢复事实仍由 Relay 保存。
