# ADR-015：Windows 受管内容由实际原生写者持发布锁

## 状态与日期

Accepted，2026-10-01。用于 P20/M07 内容发布安全点，不代替 [ADR-014](ADR-014-database-maintenance-admission.md) 的持久准入门或原宿主停机，不代表完整备份/恢复已通过。实际结果归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

## 背景

人工产物、Run 候选、Assist 及影响检查均通过 ManagedContentStore 发布不可变内容。DRAINING 允许原工作继续，存储层此前由 Node 按路径创建 staging、写入和 rename；仅停 API 或持一个独立锁助手，无法防止锁助手退出后 Node 继续发布。受管内容安全点必须覆盖实际执行 IO 的进程及整段发布。

## 候选方案

| 方案 | 优点 | 代价 |
|---|---|---|
| 所有 Node/CLI 写者纳管 Windows Job 并持续持共享锁 | 保留 Node IO | 多个入口均需纳管，独立调用方容易遗漏；Job 与实际写者关系须逐项证明 |
| 独立锁助手持锁，Node 继续写文件 | 接线少 | 助手死亡后 Node 仍可写，失锁与 IO 停止没有同一 Owner，不能作为维护边界 |
| 原生助手同时持锁并执行完整发布 | Store 单一入口覆盖现有调用方；助手退出使实际 IO 一起停止 | Windows 发布依赖新助手，增加每次 spawn；兼容与真实并发/强杀必须验收 |

## 最终决策与原因

选择实际原生发布者。复用 [ADR-012](ADR-012-windows-file-io-handle-boundary.md) 的既有 Rust 文件助手、句柄相对 IO 与身份核对，不引入新运行时或通用文件协议。业务验证、版本登记和事务 Owner 保持 Application；原生层只负责既有受管内容的物理发布。

Windows ManagedContentStore 只通过固定 `relay-managed-content-v1` 私有协议发布，助手缺失/失败不回退 Node IO。助手在真实 data_root 的固定 sentinel 上持共享 LockFileEx，随后独自创建 staging、写入、刷盘、不可覆盖 rename、再次刷盘；结束前持真实根/祖先/子目录句柄，拒绝 reparse 与多链接 sentinel，禁止持锁期间替换 sentinel。维护助手对同一真实 sentinel 持排他锁；冲突即时拒绝，发布失败前不创建 part/目标，不用超时推断旧写者停止。

Node 必须核对回包版本、相对 ref、摘要、字节数和物理身份，并等待正常退出；握手后的会话失败持续失效。内容仍以内部 ID 生成不可变路径，保留既有256 KiB上限、摘要/字节语义和 StorageConflict/StorageUnavailable 映射。非 Windows 路径保持现有实现，不声称具有本次 Windows 冻结保证。

## 代价、兼容与影响

影响原生助手、ManagedContentStore、独立维护 CLI、Windows 测试及发布资源。数据库/HTTP 字段不变，无新 migration；公开存储失败沿既有503 `STORAGE_UNAVAILABLE`，Breaking Change: No。Windows API 开发与测试也须提供当前助手；旧助手缺新协议会失败关闭，不能只更新 API 后继续依赖旧资源。

文件已发布但回包/数据库提交失败仍可能留下候选或 orphan；不得清理、改原动作 ID或自报成功。原 Run 按原 effect/operation 身份核对，人工命令依原回执语义处理。发布锁只排除参与本协议的受管内容发布者，不能冻结 PG/Saver、旧 Node 二进制、外部 FILE_WRITE/Git/CLI或手工文件修改。完整维护仍须旧进程边界、数据库一致性和恢复隔离。

## 后续

组合存活的原宿主停机会话、内容排他会话与数据库边界，保留未决动作和历史依赖；再实现完整备份与新数据库/data_root 隔离恢复。操作说明归[部署设计](../deployment/本机部署.md#4-备份恢复)，重要故障根因归[M07 开发记录](../development/m07-backup-recovery.md)。
