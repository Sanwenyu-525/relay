# 后端启动边界：IPv6 与编译目录定位

日期：2026-10-29。范围：启动配置与 HTTP 边界；当前验证结果归[基础链验收](../testing/acceptance-details/part-16.md#条目-282)。

## 现象与根因

- `RELAY_API_BIND_HOST=::1` 配合 `http://[::1]:5173` 来源无法启动：URL 的 `hostname` 是 `[::1]`，来源白名单却使用 `::1`。
- 来源通过后，合法 IPv6 请求仍返回 Host 400：Fastify 的 `request.hostname` 同样保留方括号，不能直接与绑定地址比较。
- 编译后的 `findRepositoryRoot()` 固定向上四层，得到仓库内的 `apps`，错误允许源码仓库根目录作为 `RELAY_DATA_ROOT`。源码路径和编译路径相差一层，固定深度不能同时适用。

此前配置测试显式注入模拟仓库根，HTTP 集成主要使用 IPv4，因此没有覆盖真实编译入口和 IPv6 的组合。

## 修复与防回归

- 来源使用 URL 的规范主机名，Host 校验将 `::1` 绑定地址转换为 `[::1]`；错误端口、非回环 IPv6 和未授权 Origin 继续拒绝。
- 从配置模块位置向上查找 `pnpm-workspace.yaml` 与 `apps/api/package.json`，找到实际源码根；无源码工作区标记的安装布局保留原回退路径。本轮没有安装包运行证据。
- 配置单测覆盖完整 IPv6 配置、非回环拒绝及实际工作区定位；HTTP 边界测试包含真实 IPv6 监听。真实进程集成覆盖 IPv6 readiness 和源码目录拒绝。
- CLI 迁移测试的预期清单曾停在 124 项，而目录已有 145 项。改为核对磁盘中的完整 SQL 文件名清单及账本行数；迁移内容、历史完整性与回滚仍由独立的 migration 套件验证，不放宽断言。

请求与响应协议保持兼容，Breaking Change: No；没有新增或修改 migration，不批量修改已有业务数据。
