# 选型与适配实验包

本目录保存 P00 选型和 M01 技术适配的可运行证据，不是生产工程。模型响应与工具效果使用可控 fixture；真实 PostgreSQL 实验只操作专属测试实例、数据库与 schema。各实验的外部依赖、运行命令和验证边界以自身说明为准，不代表真实 Provider 或生产业务通过。

## 实验组成

- `langgraph-poc/`：LangGraph 1.2.11 的真实 checkpoint 恢复实验，以及无 checkpoint 的基准图。`lab.py` 使用 SQLite 作为业务测试替身，不能当作产品 PostgreSQL 验证。
- `runtime-bench/`：Pi core/ai 0.85.1 的真实 agent loop；默认流式模型适配器，基准中无持久化。
- `rig-poc/`：Rig agent 0.42.0 的真实 AgentRunner，使用发布 crate 提供的 `MockCompletionModel`/`MockTurn` 与一个受控工具；不自写 agent loop。
- `run_benchmarks.py`：按独立进程运行三种实现并保存原始 JSON。
- [typescript-p00](typescript-p00/README.md)：TypeScript/Kysely/pg 的真实 PostgreSQL 基础实验，覆盖迁移完整性、事务、bigint、权限与 CAS；不等于完整审批/UNKNOWN 恢复或 P01。
- [ai-sdk-p00](ai-sdk-p00/README.md)：真实 AI SDK Core + 官方 Mock Provider + TypeBox 的离线协议边界实验，覆盖参数校验、无自动工具执行、错误与取消；不等于两个真实 Provider 兼容通过。
- [recovery-p00](recovery-p00/README.md)：真实 PostgreSQL 与独立 Node 进程的审批、受管单文件效果和 UNKNOWN 核对实验；不等于完整业务恢复、资源排他或完成事务。
- [desktop-p00](desktop-p00/README.md)：Tauri release 目录包、随包 Node/Fake Worker 和真实 WebView 的启动、鉴权、重载与正常退出实验；不等于安装交付或完整桌面验收。
- [m01-stack-adapter](m01-stack-adapter/README.md)：2026-09-23/24 在真实 PG18.6 上验证官方 LangGraph 1.x/PostgresSaver interrupt、重放、权限、最小 command/outbox 排他；锁定 React/Vite/Tauri/Node24 的隔离兼容组合，保留旧 Vue 页面截图基线。未接入生产入口。

## Rig 行为实验

在 Windows 上使用 MSVC toolchain 构建（GNU linker 无法可靠处理本项目中文路径）：

```powershell
cd experiments/rig-poc
cargo +stable-x86_64-pc-windows-msvc test --offline
cargo +stable-x86_64-pc-windows-msvc build --release --offline
cargo +stable-x86_64-pc-windows-msvc run --offline -- scenario normal
cargo +stable-x86_64-pc-windows-msvc run --offline -- scenario unknown
cargo +stable-x86_64-pc-windows-msvc run --offline -- scenario denied
cargo +stable-x86_64-pc-windows-msvc run --offline -- scenario budget
```

`Cargo.lock` 固定实际解析结果。`unknown` 在 Rig 运行时拒绝并且工具副作用为 0；`denied` 将拒绝结果交给下一模型轮次且工具副作用为 0；`budget` 以 `max_turns=1` 停止在第二次模型调用前。拒绝场景的语义是“拒绝后继续让模型收敛”，不是应用层最终拒绝协议。

## LangGraph 与依赖

`langgraph-poc/requirements.txt` 是直接依赖，`requirements.lock` 是在 `.research/poc-venv` 中执行 `uv pip freeze` 得到的完整环境快照。运行新增基准测试：

```powershell
uv run --python .research/poc-venv/Scripts/python.exe `
  pytest -q experiments/langgraph-poc/test_bench_workflow.py
```

已有 `test_workflow.py` 覆盖持久化恢复场景；这次没有重复运行那组 15 项测试。

## 可重复性能观测

先构建 Rig release binary，再运行：

```powershell
cd experiments/rig-poc
cargo +stable-x86_64-pc-windows-msvc build --release --offline
cd ../..
uv run --python .research/poc-venv/Scripts/python.exe `
  python experiments/run_benchmarks.py --repetitions 3
```

结果保存在 `experiments/results/benchmark-latest.json`，其中每条记录保留 ready JSON、ready 冷启动耗时、运行时原始结果、返回码和 stderr。每个运行时启动 3 个独立进程；每个进程执行 200 次串行样本和 10 批 × 16 并发样本。共同负载为“两次 fake model turn + 一次 controlled tool”，并发探针为 5 ms 模拟 I/O，三者均无持久化。

基准配置仍有不可消除的实现差异：Pi 是 stream-driven loop，LangGraph 是 buffered graph，Rig 是 buffered blocking AgentRunner；冷启动包含各自解释器/运行时/框架加载。故 p50/p95/吞吐/RSS 仅用于这组固定负载的选型观察，不能推出语言本身的性能结论，也不能替代真实模型、数据库、网络或恢复测试。Windows RSS 通过进程 API 读取；其他平台若无法读取则记为 0。
