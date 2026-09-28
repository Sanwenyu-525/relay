# ADR-012：Windows 文件动作的句柄边界

## 状态与日期

Accepted（方案已落代码，M06 总出口未验收），2026-09-27。Windows 上**新** `FILE_WRITE` Operation 使用原生助手；旧 Operation 缺少物理身份，仍保守核对，不能把当前路径补作原身份。

## 背景

`FILE_WRITE` 已冻结输入、检查受管根与链接、按文件保存结果，并在崩溃后用原回执和磁盘回读核对。但 `file-changeset.ts` 在 `realpath`/`lstat` 检查后重新按路径 `mkdir`、`readFile`、`writeFile`、`rm`；冻结基线与恢复也重新按路径读取。另一个本机进程可在检查和实际 I/O 之间替换父目录或目标。重复检查或比较写前写后摘要只能缩小窗口，不能证明读写仍指向同一对象。Windows 上 Node 24 的文件接口缺少以受信目录句柄为根逐段打开、禁止重解析与控制删除共享的完整能力。

接口依据：[Node 24 文件 API](https://nodejs.org/docs/latest-v24.x/api/fs.html)、[NtCreateFile 与相对根句柄](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)、[Windows 文件命名规则](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)。这些文档限定可选机制，不代替当前项目的 Windows 竞争实测。

## 候选与取舍

| 方案 | 收益 | 代价或缺口 |
|---|---|---|
| 继续使用 Node 路径 API，增加前后检查 | 改动少 | 仍可在检查与使用之间替换，不能用于 M06 总出口的路径安全证明 |
| 在 Tauri 窗口进程内实现安全写入 | 可复用现有 Rust/Windows 构建环境 | 真正调用文件工具的是独立 Node Worker；跨进程请求与旧 Invocation 恢复仍须另设协议 |
| Worker 调用固定的 Windows 原生文件助手 | 让冻结、执行、核对共用句柄级边界；可按当前进程监管与打包机制分发 | 增加受信可执行文件、调用协议、构建与竞争测试；助手崩溃或回执丢失仍按 UNKNOWN 处理 |
| Node N-API 原生扩展 | 少一次子进程启动 | 增加 Node ABI、加载与部署耦合；仍需相同的 Windows 句柄实现和恢复协议 |

## 决策与当前实现

固定的 Rust 原生助手由 Worker 以结构化、限量输入调用。助手只承担受管资源根内的捕获、执行和核对文件 I/O；Task、Run、Permission、Operation、Invocation、账本和人工处置仍由原应用与数据库 Owner 管理。桌面窗口不能代替 Worker 调用助手。Windows 包包含并核验确切助手产物；助手不存在时不回退到 Node 路径写入。

助手从受管资源根路径锚定，而不是从 `WRITE_FILE` 目标的父目录锚定。逐个单段打开并持有根、父目录和目标句柄，拒绝重解析点、硬链接及特殊路径别名；准备时冻结卷号/File ID，执行与恢复按同一身份核对。0036 为**新 Operation** 持久化物理身份；0038 又为新 Windows 资源登记保存当时的根 File ID，并要求准备新写动作时匹配。旧资源没有登记时身份，不能由当前磁盘回填；须显式停用并经 0039 的活动路径唯一规则重新登记为新资源 ID，才能准备新 Windows 写动作。旧 Operation 的冻结身份、原 Invocation 的 UNKNOWN 和不可改写账本语义不变。

不能原地修改已有目标：独占目标句柄期间仍可建立根外硬链接。CREATE/MODIFY 先在受管父目录暂存完整内容并核验，在任何写入前将暂存对象标记为删除待定，再复核链接数；MODIFY 把持有句柄的旧目标改名为随机备份，之后以不覆盖已有名称的换名提交暂存对象。目标名空窗若被抢占，保留旧正文于备份并报告 `effect_uncertain`，上层保持原 Invocation `UNKNOWN` 与资源隔离。DELETE 只对持有的目标句柄执行。助手中断或回执丢失同样不能当作无效果；在备份换名后强杀的反例已证实旧内容备份和新内容暂存同时残留。

对此只增加有界只读观察和显式人工出口：助手按冻结根/父目录身份枚举同目录残留候选，记录当前目标及候选的 File ID、摘要和可读状态；候选不被归因到原 Invocation。缺回执 `UNKNOWN` 账本、可信 Job 停机证明、资源隔离和新鲜快照同时满足时，可复用人工处置事务保留观察到的文件、失败旧 Run 并交回 Task。它不恢复、删除或重试残留；观察后的外部编辑仍可能发生。复用现有处置表，避免为此新增第二套状态或迁移。

这仍不是任意代码的 OS 沙箱。目录替换、硬链接与目标抢占已有真实 Windows 定向反例；外部编辑器在操作结束后的修改、断电持久性、旧资源登记身份和安装升级仍分别待验，不能从单组测试推出 M06 总出口。

## 验证出口

1. 在 Windows 上可控地把替换点插入父目录检查与创建/写入之间、目标检查与写入/删除之间、冻结读取与恢复回读之间；根外文件不得改变，不能把同摘要的新对象误认作原对象。
2. 检查 junction/符号链接、普通目录根替换、硬链接、备用数据流及目标竞态；证明合法 CREATE/MODIFY/DELETE 和混合部分效果仍得到正确账本。
3. 助手进程强杀或回执丢失后，沿原 Invocation 保留 UNKNOWN 与资源隔离；真实 Windows Job、PostgreSQL、桌面包和安装出口分别复验。

## 影响与接续

涉及 Worker 文件适配器、受管资源身份、恢复回执、Windows 打包和测试；0036/0037 为新动作保存物理身份并允许根相对的冻结差异路径。新 Windows `WRITE_FILE` 的只读账本/差异路径使用受管根相对路径，旧动作的历史路径不改；详见 API 契约。增量 G 的真实助手 20/20、隔离 PostgreSQL real-tools 49/49、强杀无回执/旧部分写入图链各 1/1、React 定向 6/6 已通过；确切包的摘要核验、原有 Windows Job 恢复链及 WebView2 自动差异页再次通过，见 [M06 记录](../testing/m06-independent-acceptance.md#增量-g无回执崩溃残留的人工处置开发自检2026-09-27)。无回执强杀处置的完整桌面同场景、人工交互及独立总验收仍待验证；M06 保持 IN_PROGRESS，安装包总验收属 M07。
