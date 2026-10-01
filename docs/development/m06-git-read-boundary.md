# M06：Git 读取的机器协议与扩展程序边界

日期：2026-10-01。角色：故障根因与实现取舍；实际成绩和独立验收状态只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

## 现象与根因

原[Git Adapter](../../apps/api/src/git/git-adapter.ts)共用的执行函数对stdout整段trim。porcelain首行的空格是状态列：仅工作树修改的 ` M tracked.txt` 被变成 `M tracked.txt`，解析后错误进入staged，路径还丢失首字母。按换行分割和trim路径也不能正确保留带空格的路径及重命名记录。相同处理会删除diff的末尾换行，回执不再与Git原patch字节相同。

原diff只关external diff，没有关textconv；status还会使用仓库配置的fsmonitor及可选index刷新。私有仓库反例观察到textconv和fsmonitor程序实际创建测试标记。clean配置亦未在读取前拒绝。读取权限不能代替任意扩展程序执行权限；官方机制分别见[diff](https://git-scm.com/docs/git-diff)、[status](https://git-scm.com/docs/git-status)、[fsmonitor](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsmonitor)和[filter](https://git-scm.com/docs/gitattributes#_filter)。

## 修复与取舍

- 读路径保留原stdout，用porcelain v1的NUL记录解析。保留确切路径，重命名读取目标路径并消费原路径；branch/HEAD等标量单独trim，unborn分支和detached HEAD分别表示。
- 读调用使用无pager、无可选锁、禁用fsmonitor和diff index自动刷新；diff禁external diff、textconv和颜色，保留完整patch。原Git写入/核对调用仍走原执行语义与审批链。
- status/diff前读取有效filter配置。非空clean/process程序明确拒绝为 `GIT_READ_EXTERNAL_FILTER_UNSUPPORTED`，不运行程序，也不静默禁掉内容转换后伪造正常结果。无匹配必须是实际Git退出1且无stdout/stderr；启动、取消、超输出等非数字错误与配置故障不作为空配置接受，返回固定 `GIT_READ_CONFIG_UNAVAILABLE`，不保存原配置值或错误。
- 根仓库采用submodule dirty工作树排除及短gitlink diff，不自动进入嵌套工作树执行其配置程序；submodule commit变化仍可见。嵌套工作树的文件变化未覆盖，不能称整个目录树干净。

直接忽略所有filter会改变Git内容语义；自动信任仓库程序则越过只读能力。当前选择明确拒绝外部clean/process配置（包括常见LFS process配置）。此类仓库的读取支持仍是缺口，不把禁用的承诺能力记为完成。若以后接入，须先定义受信执行/回执/取消边界，不能仅解除拒绝。

这是受信宿主Git、合作目录/配置环境下的有限读取修复，不是OS沙箱、对抗同用户配置竞态的隔离或原子仓库快照。PATH上的宿主Git仍属于既有受信配置；变更中没有引入新依赖、通用Shell或另一个业务Owner。

## 修改范围与兼容性

生产仅修改Git Adapter；测试为[原生Git单元](../../apps/api/test/unit/git-adapter.test.ts)和[既有Gateway集成](../../apps/api/test/integration/real-tools-gateway.integration.test.ts)。原operation/invocation、Permission、Worker、claim和结算入口保留；没有新HTTP入口、数据库表或migration。

Breaking Change: Yes（内部Git读取行为：外部filter仓库拒绝、nested工作树排除、确切patch/路径结果修正）。HTTP响应形状Breaking Change: No。历史Invocation及证据不重写，新读取不把结果自动归因给Agent，也不消费历史UNKNOWN。

## 回归方式

测试只操作自建临时仓库和一次性PG：机器列、index/worktree、空格/中文路径、真正重命名、unborn/detached、原patch字节、扩展程序标记与index不变、clean/process拒绝、配置/取消失败分类、submodule工作树排除和commit变化。Gateway覆盖AUTO原身份、真实patch持久化、已知FAILED与零程序效果，同时保留原commit/push、文件冲突和CLI恢复/取消集合。

初次重命名夹具同时改变了一行文件正文，Git合法表示为A+D；夹具改为先提交相同正文的基线再mv，保留目标路径断言，不修改生产解析器隐藏A+D。原失败与复验输出按[保留规则](../README.md#6-验收结果与原始输出保留)留本机，数量和结果不在本文复制。
