# TypeScript P00：PostgreSQL 基础验证

这是独立的 P00 实验，不是生产工程、正式 migration 或 V001。它只验证 TypeScript strict、Kysely/pg 与真实 PostgreSQL 的数据库基础项，不能证明审批恢复、UNKNOWN 核对、真实 Provider、P01 人工闭环或完整 P00 已通过。

## 准备便携运行时

从本目录运行以下 PowerShell；它仅在仓库忽略的 `.research/runtime-cache` 下载和解压，不修改系统默认 Node、不安装 Windows 服务，也不使用 Docker 或既有 PostgreSQL。Node 的摘要来自官方 `SHASUMS256.txt`；EDB 不提供可取得的同路径摘要（请求 `.sha256` 返回 HTTP 403），所以 PostgreSQL 摘要只用于记录本地输入，不能当作上游校验。

```powershell
$workspace = (Resolve-Path ..\..).Path
$cache = Join-Path $workspace '.research\runtime-cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null

$nodeZip = Join-Path $cache 'node-v24.21.0-win-x64.zip'
Invoke-WebRequest 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip' -OutFile $nodeZip
if ((Get-FileHash $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541') { throw 'Node SHA-256 mismatch' }
Expand-Archive $nodeZip -DestinationPath $cache -Force

$pgZip = Join-Path $cache 'postgresql-18.6-2-windows-x64-binaries.zip'
Invoke-WebRequest 'https://get.enterprisedb.com/postgresql/postgresql-18.6-2-windows-x64-binaries.zip' -OutFile $pgZip
if ((Get-FileHash $pgZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '41bb1496f60666d3745ae8a855753b877d14fa9e34667f266867635b790fc323') { throw 'PostgreSQL input differs from the recorded P00 input' }
Expand-Archive $pgZip -DestinationPath (Join-Path $cache 'postgresql-18.6-2') -Force
```

官方来源：[Node v24.21.0 dist](https://nodejs.org/dist/v24.21.0/)；[PostgreSQL Windows 下载页](https://www.postgresql.org/download/windows/) 和 [EDB 二进制包页](https://www.enterprisedb.com/download-postgresql-binaries)。

## 可复制运行命令

在本目录执行。命令显式使用便携 Node 24 启动 Corepack 的 pnpm 9.15.9，锁文件不可变；前三个代理变量仅影响当前 PowerShell 会话，避免受本机代理配置影响。

```powershell
$node24 = Resolve-Path ..\..\.research\runtime-cache\node-v24.21.0-win-x64\node.exe
$corepack = Join-Path (Split-Path -Parent $node24) 'node_modules\corepack\dist\corepack.js'
$env:NO_PROXY = '*'; $env:HTTP_PROXY = ''; $env:HTTPS_PROXY = ''; $env:ALL_PROXY = ''
& $node24 $corepack pnpm@9.15.9 install --frozen-lockfile --registry=https://registry.npmjs.org
& $node24 .\node_modules\typescript\bin\tsc --noEmit
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-real-pg.ps1
```

脚本每次选择回环端口，并只创建随机 `relay_p00_*` 测试数据库和随机 schema。Node runner 在删除测试数据库后只能写入 `AWAITING_SERVER_CLEANUP`；包装脚本实测 `pg_ctl stop` 成功后，才把同一次运行写为 `PASSED`。每个运行写入 `results/<run_id>.json`，保留历史；`results/latest.json` 仅复制当前运行，因此失败运行不会沿用之前的成功状态。可用下列故障回归验证该行为（命令应以退出码 1 结束）：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-real-pg.ps1 -SimulateNodeFailure
Get-Content .\results\latest.json -Raw
```

`cleanup.dedicated_postgresql` 只有实际 `pg_ctl stop` 返回 0 才声明停止成功。测试结束后，runner 终止该测试数据库的会话、删除该数据库和临时应用角色，包装脚本停止同一专属 data directory。结果不会包含连接 URL、凭据或随机资源名。

## 覆盖范围

- Kysely 的真实 PostgreSQL 迁移重复执行，以及已应用迁移文件缺失时的拒绝。
- 已应用迁移内容改变：Kysely `v0.29.6` 的 `src/migration/migrator.ts` 只保存 `name`/`timestamp`，校验缺失和顺序，不记录内容摘要。实验单一入口在同一事务内写入 SHA-256 清单，拒绝已应用文件缺失、无清单或摘要改变。
- Raw Kysely 与补充哈希入口分别各启动两个独立 Node 24 子进程；迁移内的测试专用 `pg_sleep` 建立锁持有窗口，父进程轮询 `pg_stat_activity` 观察 advisory-lock 等待。两个模式均断言子进程都成功、`executed` 恰为 `0/1`、Kysely 迁移记录恰一条；哈希入口还断言清单恰一条且等于迁移源 SHA-256。
- 迁移 DDL、Kysely 记录和内容清单的同事务故障回滚；一般 Kysely 事务回滚；`bigint` 大于 `2^53` 时 pg INT8 parser 返回 `bigint`；应用角色不能 DDL；两个条件更新中仅一个 revision CAS 成功。
- 真实 SQL 错误会使 PostgreSQL 事务中止，且 Kysely `v0.29.6` 随后的 session-lock `unlock` 返回 `25P02`。回归先记录该复现，再确认调用者原连接仍可查询、专属迁移连接销毁后无遗留 advisory lock，另一连接在 `500ms` `lock_timeout` 下可继续迁移。

单一哈希入口在事务内取得 `pg_advisory_xact_lock`，并将同一次冻结的 migration catalog/provider 传给同一 transaction instance 上的 Kysely Migrator。Kysely PostgreSQL adapter 另使用 session-level `pg_advisory_lock`；因此入口使用专属迁移连接，以免 SQL 失败时 adapter 的 `unlock` 无法在 aborted transaction 内执行而把锁带回调用者连接池。代价是每次哈希迁移增加一次短生命周期连接的建立和销毁；本实验没有测量这项成本，也不将这种隔离方式扩展为生产通用迁移框架。目录读取、摘要、Kysely DDL 和清单要么一起提交，要么一起回滚。

## 固定版本、来源与输入追溯

| 项目 | 固定输入 | 来源与核验 |
|---|---|---|
| Node | `v24.21.0` Windows x64 ZIP | 官方 SHA-256：`158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`。 |
| PostgreSQL | EDB `postgresql-18.6-2-windows-x64-binaries.zip` | 本次本地输入 SHA-256：`41bb1496f60666d3745ae8a855753b877d14fa9e34667f266867635b790fc323`；没有伪称上游校验。 |
| Kysely | `0.29.6` | 上游 commit `2fefd4c848cc3129281fac0632d2376c7a723ee4`，MIT；查阅缓存 `.research/upstream/kysely` 的 `LICENSE`、`src/migration/migrator.ts`、`src/dialect/postgres/postgres-adapter.ts`。`0.28.17` 不能让 Migrator 使用已有 Transaction，首次实测拒绝。 |
| pg | `8.16.3` | 上游 tag `pg@8.16.3` 的 commit `8f8e7315e8f7c1bb01e98fdb41c8c92585510782`，MIT；实际包的 `node_modules/pg/LICENSE`、`node_modules/pg/lib/client.js` 为许可和运行来源。 |
| TypeScript / tsx | `5.9.3` / `4.20.6` | Apache-2.0 / MIT；精确解析版本和传递依赖完整性由 `pnpm-lock.yaml` 锁定。 |

根工作区没有 Git commit。每个真实运行结果都包含 `package.json`、`pnpm-lock.yaml`、`tsconfig.json`、迁移、全部 `src/*.ts` 和 PowerShell 包装脚本的 SHA-256；因此不依赖伪造 commit 即可追溯本实验输入。

## 未覆盖

- 不调用任何 Provider，也不读取环境中的 API key。
- 不实现 Workflow、审批恢复、UNKNOWN 恢复器、Gateway 或生产 migration。
- 未设置性能预算；不将本实验当性能报告或端到端吞吐结论。
- 不覆盖完整测试计划的 B01、B03–B05、Spike 1–3 或 37 个验收场景。
