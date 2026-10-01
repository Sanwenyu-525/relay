# M07 维护、备份与恢复的安全边界

日期：2026-10-01。本文保存实现取舍和重大协议故障根因；当前模块状态归 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)，实际成绩归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。备份及隔离还原组合已有实现，明确放行、确切发布包与安装总验收仍未完成，不能由分片能力推导已交付。

## 为什么需要多道边界

数据库 NORMAL/DRAINING 门只挡新工作。旧 Run、Assist、Web 和 Gateway 可以按原身份继续结算，Graph Saver 使用独立连接池；关闭 API 的业务池、租约过期或等待超时都不能证明写者已停。受管内容还存在先写文件、后提交数据库引用的窗口。维护必须分别取得可信停机、内容发布安全点和数据库边界，最后才能组合备份。

保持 Application 的业务 Owner、原 command/operation/invocation 身份和 UNKNOWN。原生维护入口只给 OS 级证明；不宣布业务恢复、完成或资源可重新派发，也不删除恢复记录。外部资源不属于 data_root 的内容备份。

## 当前 Windows 停机入口

[原生维护会话](../../apps/desktop/src-tauri/src/maintenance_session.rs)在普通 Tauri 启动前识别严格的 `--maintenance-session`，不创建窗口、不读 desktop.env、不连接 PG。它取得旧桌面的同一单实例 guard，复用原 ARMED 校验和命名 Job 停机机制，成功给出原 launchId 与 stopEvidence，并持续持有 guard；EOF 或原 nonce 的 release 释放。已有窗口占锁时静默拒绝，不误前置其他窗口。

[Node 会话](../../apps/api/src/runtime/desktop-maintenance-session.ts)只启动 manifest 声明 `relay-desktop-maintenance-v1`、EXE 摘要匹配的包；旧包在执行前拒绝，避免旧 EXE 忽略参数后打开普通窗口。能力声明不是发布者签名，也不替代完整资源/安装验收。私有 stdin/stdout 的版本、nonce、字段和长度均有界；可信状态绑定仍活着且协议未失败的子进程，历史 JSON 不构成继续持锁的证明。只转发最小 Windows 环境变量，不转发模型或数据库凭据。

范围仅为当前 Windows 登录会话的桌面 guard 及指定 data_root 的原 ARMED Job。其他登录会话、没有被该宿主管理的 CLI/工具或直接外部写者仍需独立证明。握手期限只界定失败，不作为停机证据。新入口不触发 supervisor 的业务恢复，不改变 DRAINING。

## 握手后的失败不能丢失

现象：握手 Promise 在 READY 后已兑现。后续若收到合法 RELEASED、非法帧，而 native 已正常退出，单纯 reject 原 Promise 或 kill 子进程可能失效，释放流程只检查退出码就会误报成功。

根因：把一次性握手完成和持续会话健康混为同一 Promise，没有保存握手后的失败。

修复：保存首个 sticky failure；`closed` 携带该失败，`isHeld()` 与 `release()` 均核对。未请求/未确认释放的意外关闭即使退出0也记为失效，部分残帧不能丢失。释放成功还需原 nonce 的唯一确认、完整输入、退出0且无信号。可控进程事件反例覆盖 `READY→RELEASED→非法帧→exit 0` 及 `READY→意外 EOF→exit 0`，不能靠杀进程产生非零退出码掩盖协议失败。

## 释放输入不能先兑现再校验

现象：首行 `release` 已 resolve，随后同一块尾随300字节或第二行非法输入的 reject 无效，CLI 仍输出释放成功。

根因：readline 与计量监听的顺序使首行先成为最终结果；Promise 的后续拒绝不能撤销已兑现的结果。

修复：[共享释放输入解析器](../../apps/api/src/runtime/maintenance-release-input.ts)先按原字节计量，只接受唯一完整 LF/CRLF release；超界、部分帧和尾随输入保存 sticky failure。CLI 在原生释放完成、输出成功之前复核输入。EOF/信号是独立的释放请求；错误路径仍释放自己的 guard，但不输出成功。

## 数据库连接维护的失败边界

[实际会话](../../apps/api/src/runtime/database-connect-fence.ts)使用不可变ACL凭据及显式恢复，具体命令和运维限制只在部署设计维护。真实PG反例暴露以下边界：

- 普通migrator看其他用户的backend_type可能得到NULL，`<> 'autovacuum worker'`会把旧app/Saver连接漏掉；改用 `IS DISTINCT FROM`，不可分类连接保守拒绝，不增授全局监控权限。权限隐藏依据 [PG18统计函数](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/utils/adt/pgstatfuncs.c)。
- 仅按datid筛选会漏掉已通过CONNECT、仍在启动的连接。[PG18启动顺序](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/utils/init/postinit.c)先持目标库对象锁并检查CONNECT，后发布最终统计再提交启动事务。因此先查目标库对象锁，再清统计快照和查活动连接；反向读取可能漏掉锁到统计登记的交接。反例用唯一application_name和真实post_auth_delay观察授权后的窗口，不以睡眠推断状态；首观测错误使用不存在的wait_event，保留失败输出并纠正。
- 内存已生成journal不代表本操作撤销过权限。此前写文件失败或REVOKE前ACL漂移也进入补偿，可能把另一会话刚撤销的CONNECT重新授回。现在只在尝试权限COMMIT后补偿；通过控制真实PG查询返回的时序注入外部撤销，所有SQL仍在临时PG执行，旧条件反例失败、修复后不覆盖外部ACL。
- 创建释放输入Promise后先等PG检查，输入提前失败会形成未处理拒绝，使Node退出并跳过finally。CLI立即注册拒绝处理，READY前复核输入，随后等待原Promise；真实子进程在READY前收到坏帧仍释放自己的ACL，不输出成功。强杀/连接丢失不能走此清理，凭据保留供显式恢复。

以上修复不把状态观察变成永久冻结证明。生产操作不杀未知backend，测试管理员只对私有临时库已验证的维护PID注入故障。临时PG测试启动配置开启两个prepared事务槽，覆盖真实PREPARE后断开连接的残留事务；不改变用户PG配置。实际成绩仅归功能验收表。

## 备份与恢复仍需组合的内容

### 文件清单与原包定义保留

内部[文件复制入口](../../apps/api/src/runtime/backup-files.ts)枚举当前 data_root 的受管文件；`artifacts` 包含未登记候选，正文原样写入备份的 `data/artifacts`。`staging` 和原 `runtime-launches/<UUID>.json` 写入 `evidence`，不进入可启动的新数据根。原文件不删除，日志与内容准入sentinel不复制；Knowledge正文在PG，尚无恢复协议的非空 `knowledge/runtime-workspaces` 或未知根条目拒绝，不静默漏备。目的地的 `data/evidence` 必须新建，已存在时拒绝覆盖。复制前后核对路径/文件身份、目录集合及字节/hash，刷盘并重复检查调用方的存活维护断言；它本身不能证明数据库或外部写者已停。

Node没有任意Windows reparse属性和目录ADS枚举接口，因此复用固定系统Windows PowerShell/.NET/kernel32的[只读元数据检查](../../apps/api/src/runtime/backup-paths.ts)，通过stdin JSON传路径，脚本不执行输入、不读取正文，子进程仅带最小Windows环境。按层检查属性和streams后才遍历子目录；symlink/junction、多hardlink、路径别名与非默认stream拒绝。此检查与前后身份核对属于受信运维边界，不宣称抵抗同OS用户竞争替换路径的原生隔离。文件预算100000、总条目200000、深度64、引用累计16MiB；CONTENT/STAGING每文件256KiB，ARMED64KiB。元数据输入另限制500000路径/64MiB，输出128字符、stderr4KiB、60秒超时。

[原包校验](../../apps/api/src/runtime/backup-package.ts)核对完整资源清单、实际文件集合、Node24及维护协议、所有资源和EXE摘要，拒绝漏项/多项、禁配文件、链接和隐藏stream。预算100000总条目、引用16MiB、每文件256MiB、manifest8MiB；循环检查5分钟期限，超过期限不返回成功，单次元数据探针另有60秒上限，不把这些期限当作Windows IO响应时间承诺。历史Skill/Pack不是只保存ID、版本或成员摘要：原包的[registry导出](../../apps/api/src/skills/first-party-registry.ts)保留完整定义及依赖，包括退役版本；无凭据的独立Node子进程调用原包导出，父进程据归档正文重建原hash，导出后再核对包。缺导出、缺Pack正文或hash不符时拒绝，不回退协调应用中的新版定义。导出子进程10秒/1MiB预算，包为受信本地代码；资源hash不是发布者签名。这两个内部入口已接入下述协调CLI，小资源fixture仍不当作确切新发布包验收。

Windows 内容发布改由实际原生写者持共享锁，排他维护持同一真实 sentinel；选择及代价见 [ADR-015](../decisions/ADR-015-managed-content-native-publication.md)。原助手被杀后实际 IO 也终止，不能由 Node 继续 rename；剩余 part或已发布未登记候选仍由原效果身份核对，不当作恢复成功。非 Windows 没有这项原生冻结保证。维护会话的 root/sentinel File ID 与持锁进程同时有效，不可将历史帧导入另一进程作为授权。

- 数据库备份包含业务 schema 和 `relay_graph_v1`；Saver 独立池必须纳入写者边界。
- `relay_migrator` 的数据库Owner身份可供本库维护和完整dump；原bootstrap不收敛角色/ACL漂移，须catalog预检。连接维护、原ACL恢复和备份组合已有实现；隔离恢复与确切发布包另验，不继承分片成绩。
- 不可变产物、未登记候选、staging 与原动作证据一起清点；未引用文件不能自动清理或当成已完成动作。Knowledge 的正文目前在 PG。
- ARMED 仅作为恢复证据隔离保存；不能直接复制到新实例的活动 runtime-launches 后启动普通宿主，否则可能触及源实例的命名 Job。
- FileWrite 回执在 PG；外部 managed_resources 的绝对根和 Windows File ID 保留历史身份，不能因复制 data_root 就宣布外部效果可恢复或重新执行。
- Skill 的持久快照与 Pack 的完整历史定义边界不同；缺历史依赖时拒绝，不用随包新版顶替。配置中的供应商密钥不明文复制进普通备份。

命令、操作顺序和限制只在[部署设计](../deployment/本机部署.md#4-备份恢复)维护；测试规格归[测试计划](../testing/verification-plan.md#7-windows-桌面交付验证)。本次没有新增数据库模型或 HTTP 接口。

## 完整备份组合与原动作保留

[协调器](../../apps/api/src/runtime/backup.ts)复用原准入与恢复Owner，不建立第二套业务状态。先核对源包、两真实角色和同一数据库目标，再写新目录的incomplete凭据、用原command/revision进入DRAINING。原生停止证明只来自仍存活的桌面会话，租约不构成替代证明；由原Owner核对旧Run效果后取得原包helper的内容锁和数据库连接维护会话。受控read-only连接、dump仅在自己连接关闭前后检查quiescent，三会话存活断言贯穿操作；未匹配原launch的写者拒绝，不杀未知进程。

[业务事实核对](../../apps/api/src/runtime/backup-state.ts)绑定全部原迁移正文hash、Graph版本、不可变正文引用、历史Skill快照与原包Pack完整定义。原effect/operation/invocation/model-call摘要保留原身份，外部资源只保留历史元数据。复制/归档后重新核对数据库状态、源包与目的字节；manifest绑定这些事实。成功标记只在正常恢复原ACL并关闭自己的三会话后写入，DRAINING不自动解除。故障保留partial与原ACL凭据；目录存在不是成功证据。隔离启动及还原见下文；配置切换与明确放行尚待实施。

取得数据库fence前还有身份窗口：首次目标核对和初始只读快照相符，不能保证其关闭后同名数据库没有被运维替换，也不能证明DRAINING revision仍属于原维护动作。此前后续快照彼此一致就可成功，manifest却可能绑定旧OID/revision。现初始准入revision及取得fence后的物理目标/revision都必须与原实连目标、原准入动作完全一致，否则拒绝。反例在私有PG通过真实Application连续改变准入，或在初始读连接关闭后删除/重建自己空临时库；只控制查询完成时序，DDL与快照均真实执行。旧条件产生错误成功，修正后不写complete，保留失败输出，不以新快照自动接受替代身份。

历史UNKNOWN不能全部归类为当前写者：M06人工处置Owner会关闭Operation、释放资源与delivery，却刻意保留原Invocation UNKNOWN。若只看Invocation状态，旧ARMED核销后会永久误拒备份。现仅在MANUALLY_CLOSED FILE_WRITE具备精确人工处置、同Invocation/Operation/Run/Worker epoch/action的stop proof及已释放原claim时排除活动写者；原UNKNOWN仍进入账本摘要与完整dump。缺证明或资源未释放仍拒绝，不能把原UNKNOWN改成功。另有旧Assist RUNNING在ARMED已核销时缺本次stop proof的可用性限制，保留拒绝，后续须补Owner核销/持久停止依据。

组合清理要求观察真实关闭。此前desktop握手失败或native会话已失效时，release可能先throw，协调器只能看到拒绝而没观察子进程close；现握手/失败release均等待owned close，协调器在release结算后再核对closed。后续closed等待另有10秒界限；native释放协议自己的5秒kill并不承诺OS close硬响应时限。释放或close失败不能生成成功标记，不以“kill已请求”当作进程停止。

[PG归档入口](../../apps/api/src/runtime/backup-postgres.ts)绑定实际PG18 dump/restore EXE、前后身份/hash及TOC，wx普通文件描述符接dump stdout、刷盘并复核。固定最小PG环境不继承Provider/pgpass/service，原连接URL不进入argv或错误输出。实测强杀并等到自己的pg_dump退出后，服务端阻塞backend仍可能待lock timeout才退出；不增授kill权限，成功路径继续检查quiescent。Skill/Pack正文均先预算再读取，避免超大历史JSON先在Node物化。Windows真实组合测试使用当前debug原生EXE/helper与小API资源fixture，不能当作确切发布包或可启动产品恢复验收。成绩仅维护在功能验收表。

## 恢复标记与启动前拒绝

普通启动必须在任何Job恢复或业务连接前拒绝隔离目标。原宿主会消费ARMED并打开源命名Job，Node监督器也会核销旧launch与恢复原执行；仅DRAINING仍有结算/控制写入。因此宿主三处入口及Node三入口使用相同根目录项，存在一律拒绝，不解释正文为权限。缺失检查在Windows可能把文件祖先误报NotFound，须确认现存祖先为目录；目录别名仅用于普通读取检查，不改变后续恢复写入层的严格路径限制。选择及边界归[ADR-014](../decisions/ADR-014-database-maintenance-admission.md#2026-10-01-接续决定恢复目标在普通启动前隔离)。

API私有桌面模式在拒绝后关闭自己的stdin启动管道，使错误输出后能够自然退出；Worker与监督器输出固定隔离错误，不读或泄露标记正文。回归以真实Node子进程和私有连接观察器证明没有数据库连接或ready/核销输出，Rust直接监督器入口证明源ARMED原字节不变、无新Job目录；它们不是完整Windows窗口或产品restore证据。

旧包可能忽略新标记，所以构建清单只有实际EXE与三个编译入口/共享模块前检通过才发布隔离协议；通用包诊断可显式要求该能力，缺字段的旧包仍可作为历史来源核对。该诊断不代替恢复协调器的全inventory、源包/目标包分别绑定、迁移兼容及归档核对。标记创建、空库持续CONNECT隔离与还原凭据已由下节协调器实现，明确放行仍待实施；不能向已经运行的实例临时写文件就声称已冻结，也不新增手工删除标记的放行入口。Breaking Change: No（HTTP/数据库契约无变化；新的启动拒绝仅针对隔离目标）。

## 新空库隔离还原与只读核对

[还原协调器](../../apps/api/src/runtime/restore.ts)只处理受信运维预建的新空库和不存在的新data_root。先验证完整备份清单、原包资源及归档历史定义，再验证目标包全部资源、隔离启动能力及相同迁移正文；不自动迁移、不调用Saver安装或普通业务恢复。文件层先在同父临时目录刷盘隔离标记，再发布新根。目标[专用隔离会话](../../apps/api/src/runtime/restore-database-isolation.ts)复用原角色/有效ACL/DDL锁检查，但使用不同版本、不同purpose的凭据，关闭只结束自己的连接，绝不恢复CONNECT；源库ACL恢复入口拒绝该凭据。

[归档还原](../../apps/api/src/runtime/backup-postgres.ts)固定PG18、原归档字节与TOC、原pg_restore摘要，使用完整single-transaction/exit-on-error还原，不使用create/clean、schema过滤或禁用原Owner/ACL。正文按原storage_ref复制；staging和ARMED仅放evidence。复用原只读状态核对，将实际新库物理身份单独绑定后，对照源状态、全部迁移/Graph版本、历史定义和正文引用；不为UNKNOWN核销、换动作或重发。归档、文件与两包在结束前再次校验。只有核对通过并关闭自己的维护连接后才写不可覆盖的 `restore/verified.json`；它仅证明隔离还原核对，不授予启动权限。

失败或取消保留partial、根标记和可能已提交的目标CONNECT撤销。首次空库预检失败发生在撤销前，保留目标原ACL；不能把失败处理写成不论是否提交都强行恢复或撤销权限。原目录/配置与原包不变，外部资源仅保留历史绝对路径与File ID。首版不提供自动激活，后续还需显式兼容/外部身份核对、目标运行入口及配置切换协议；证据目录和还原元数据也须纳入未来维护生命周期，不临时复制为活动ARMED。

独立审查修正两个协调边界：真实备份准入为target/mode/revision三字段，状态摘要为mode/revision两字段，严格解码后须按业务投影核对，不能整体hash误拒全部备份。末段关闭数据库连接后仅核root/marker，不能代替restore子目录检查；元数据wx写入现在核普通祖先、父目录/leaf身份、刷盘后的字节及最终路径，成功返回前再核marker和实际凭据。真实PG组合在原维护连接及其pin凭据句柄都实际关闭后，将restore子目录换成指向原根的junction，要求拒绝成功、原根无新增verified且源记录/正文不变。最初只挂Client.end会在凭据句柄关闭前rename，Windows返回EPERM，不能算成功注入末段换向；夹具改为精确原pin句柄真实close后注入，并分别断言连接结束、句柄匹配和换向完成，不改生产关闭顺序。这些检查不声称对抗同OS管理员的原生无TOCTOU隔离。

真实PG反例发现地址格式误拒：原 `inet_server_addr()::text` 返回 `/32` 或 `/128`，初版新隔离检查仅接受裸地址。修复只在验证器接受原本机host掩码，不改备份身份值、不扩大远程地址；裸值及掩码值均进入回归。另一个反例在pg_catalog创建用户函数，初版仅检查public依赖/额外schema会误认空库；现按固定PG18普通对象OID边界检查系统schema的用户对象，不在assertHeld重复空库条件干扰受控还原。

源数据根选址也有真实缺口：CLI没有原data_root参数，旧检查仅知道备份、两包和新根；将新根设为原data_root内不存在的子目录，产品PG反例实际错误成功，向源目录新增还原条目。现严格读取备份原有的content_root_id，复用已核验目标包助手的只读inspect-root协议，逐个比较新根现有父/祖先的完整Windows File ID；匹配就在任何目录创建或目标权限变更前拒绝。同卷移动仍保留ID，原路径和搬迁路径都需覆盖；不新增备份字段或CLI源路径。子进程只带五项Windows环境、不接受环境helper覆盖，限输出并等待自有close，不读取源正文或连接源库。历史ID不授予所有权，源根删除重建或跨卷复制改变ID后仍须运维确认选址；这些检查不替代源实例停机或唯一业务Owner。工具核对失败保守拒绝；原生核对循环有30秒预算、每个helper最多10秒，前置路径检查及OS关闭不承诺硬响应上限。

libpq将含 `=` 的dbname解释为连接参数，故还原首版拒绝该数据库名，避免覆盖固定环境。真实catalog锁反例又确认：还原工具前导SQL重置lock/statement等超时为0，PGOPTIONS只是连接初值。杀自己的pg_restore并等待child close后，后台仍可能等锁；此前预期服务端5秒结束的检查确实失败，保留原输出，不能以缩短观察或删除隔离断言补成通过。取消后保留目标CONNECT/标记，失败不给verified；测试释放自己准确阻塞者后另观察后台结束和事务回滚，生产不增授全局kill权限。成功路径仍核对残余连接，故障需受信运维处理而不是盲重试。详细操作与限制归[部署说明](../deployment/本机部署.md#完整备份与隔离恢复)，实际结果仅归功能验收表。Breaking Change: No（新增受信运维CLI，无HTTP或业务schema变化）。

### 业务只读的恢复维护核对

2026-10-01 接续增加[维护核对协调器](../../apps/api/src/runtime/restore-check.ts)与[材料解码](../../apps/api/src/runtime/restore-materials.ts)。它对已还原的非空目标重持专用维护会话，读取既有目标journal，核对实际六字段目标、完整已撤销ACL、精确DRAINING revision、合作DDL锁及其他/启动连接与prepared事务；不写ACL、准入或journal。源fence的恢复ACL逻辑和首次空库入口不改变。成功、失败、取消均只关闭自己的连接和pin句柄，保持原隔离。

本地六份材料分别核对严格结构、原manifest/hash绑定、Registry/历史状态、目标凭据及CONTENT/evidence映射；原备份入口仍要求实际complete，不能因存储材料解码就宣称备份完整。读取同时保存目录/文件身份与字节基准，末段会话关闭后再次检查，替换成相同字节的另一文件也拒绝。确切目标运行包在核对前后重新检查资源与启动隔离能力；不重新读取原备份或原包，报告明确为STORED绑定而非新来源证明，重算本地hash也不是历史真实性认证。

仅核当前备份状态的选定投影和清单文件；完整Task/Run列、全部Graph正文/历史执行兼容、目标依赖可调用性、外部资源live身份、配置切换/唯一Owner及明确激活均未因此通过。内容会话复用实际native锁，首次可能创建sentinel，故“业务只读”不承诺整个文件系统零写。正常释放并观察自己的native和PG实际关闭后才返回 `ISOLATED/NOT_GRANTED` 报告；报告是持锁期间的观察，不能作为未来放行授权。不消费evidence中的ARMED，不调用Gateway/Graph恢复，不重发UNKNOWN。目标evidence/restore材料的后续再备份生命周期仍须另行闭合。

独立审查发现受控状态读取器使用connectionString时会继承进程PG环境，而专用重持会话已固定连接参数。纯Client构造反例（未访问网络）确认省略端口/密码的合法URL继承环境端口、TLS、密码与options，最终目标比较发生在连接之后。现状态读取器同样复用有限URL解码，显式host/port/user/database、密码函数、禁TLS及只读连接初值；保留原REPEATABLE READ READ ONLY事务，合成环境反例覆盖连接前参数，不读取或输出用户配置。实际运行与独立结果仅写功能验收表。Breaking Change: No（新增受信运维CLI，无HTTP、schema或迁移变化）。

### 维护连接的显式目标与环境继承

后续纯构造反例确认另外四个入口仍继承环境：备份双角色attest、应用维护Pool、源fence的hold/recover共用连接、新空目标隔离连接。URL先经有限校验不代表随后 `connectionString` 不会补入PGPORT/PGPASSWORD/PGSSLMODE/PGOPTIONS；连接后的物理身份比较太晚，不能作为错误目标或TLS/options的前置防护。

四入口复用[有限字段连接参数](../../apps/api/src/runtime/maintenance-connection.ts)，直接pin现有pg已使用的官方parser 2.14.0，不升级或另实现TLS解析。显式host/user/database必填，port默认5432、密码以函数快照传递空值，SSL默认false，options给非空可写初值，encoding默认UTF8。源fence保留显式远程/TLS/options；备份和恢复仍先检查原有限本机契约。只返回八个目标/认证/会话字段，再由调用方固定名称和超时，防止查询字段提升为driver/Pool内部构造选项或触发第二次connectionString解析。官方toClientConfig会丢弃旧 `ssl=no-verify` 字符串，须按实际pg规则先归一，不能由此关闭TLS；未知SSL字符串拒绝。未修改原ACL补偿Owner、空库预检、非空只读会话或关闭后的隔离语义。

真实PG反例只在产品调用期间注入合成环境，finally恢复后再以harness观察实际目标、ACL、原journal与应用42501；显式URL只读options须仍导致安全拒绝。无网络单元比较实际Client/Pool缺省参数、旧新TLS字段与内部query拒绝；TLS参数比较不等于实际TLS服务验收。备份组合须保持原Job/正文/Graph/故障断言，桌面单实例guard占用时的拒绝不是通过，正常关闭已核对且用户授权的窗口后复测。实际成绩仅归功能验收表。Breaking Change: Yes（运维URL的隐式PG环境补齐被取消；HTTP、schema、migration无变化）。

### 目标运行包的有限离线依赖核对

2026-10-01 接续增加[固定探针](../../apps/api/src/runtime/restore-runtime-probe.ts)，由既有restore-check调用。包inventory/hash及启动隔离源码检查只能证明文件绑定，不能证明第三方模块可加载。历史source包继续按原规则核验，目标包在与既有receipt及迁移字节绑定后，才执行自己的Node；不借协调器node_modules，不导入API/Worker或读取配置。

直接依赖必须为当前10项确切版本，包内metadata/入口hash与清单相符；同步Node24钩子保留实际ESM条件并覆盖传递ESM/CJS来源和加载字节。有限调用包括pg/Pool、MemorySaver/PostgresSaver与ChatOpenAI构造、Kysely编译、TypeBox/Fastify inject、纯本地图、JsonOutputParser及连接串解析；不连接数据库、监听或调用模型。最小环境、输入/输出预算、owned child截止/取消及实际close用于有界的合作执行核对；摘要不包含全加载路径或配置。失败不创建内容sentinel或改变数据库隔离。

只读审查指出两个实现缺口：只kill直接child时，被依赖创建且继承pipe的后代可能让close一直等待，DNS也有独立外发入口；离线固定脚本因此在依赖导入前拒绝非必要进程/Worker及DNS入口。另逐帧toString会损坏跨pipe帧的中文UTF8，stdin改为按字节限额收集后一次严格解码。加载钩子保留到真实close，cleanup结束后重算并封口加载集合，晚到的新导入不得产生陈旧成功报告。它们不是对抗恶意包/同OS写者的沙箱保证；本轮真实反例与结果仅归功能验收表。

首次真实Node运行还发现固定脚本摘要表达式缺括号，child解析即失败，继发stdin EPIPE或空stdout，全部保守报CHILD_FAILED；此前TypeScript只检查到String.raw外层代码。修复只补括号，不改业务断言；诊断使用私有合成夹具和最小环境，原stderr只留本机，随后用确切Node检查实际固定脚本语法，再重新执行原测试。类型检查不替代嵌入脚本的实际运行，通用CHILD_FAILED反例也须与真实成功基准及close观察一起判断，防止共同早退被当作具体拒绝出口。

真实篡改反例随后指出metadata初始化早于库调用的try，已知hash错误会丢失结构化输出而退成通用child错误。外层现在覆盖初始化并只输出固定白名单code，内层资源cleanup保持；不注册全局uncaught/unhandled handler，晚导入异常仍须非零真实退出。中文管道夹具曾在检查前因整包rename被Windows EPERM拒绝，不能当作UTF8反例成绩；现从创建时就使用普通中文根，不移动刚加载过的整包，保留实际stdin拆字节和非法UTF8拒绝，不修改生产路径规则。

真实PG观察入口也保留一次操作失败：将整个既有run-integration脚本接到Tee日志管道，会让postmaster继承外层pipe，PowerShell在启动命令后等不到EOF；脚本已有“不pipe pg_ctl/node”的注释同样适用于外层。启动打印成功时迁移/Graph/测试实际均未开始。核对自己的临时目录、postmaster PID/EXE/启动时间后只停止该私有集群，等待原wrapper结束与删除，再直接无管道运行入口；不把not-run当产品失败或通过，也不停止用户PG。长进程的实际工具尾只留本机，标明非全量native stdout。

报告scope固定为PACKAGED_DEPENDENCIES_OFFLINE_ONLY，不清除完整依赖可调用性等五项pending，更不授激活。集成夹具仅把既有普通生产依赖目录放入目标包、保留原历史source夹具；确切新发布包、真实Saver/Provider/工具及完整历史执行兼容仍另验。Breaking Change: Yes（restore-check目标包新增完整依赖声明/资源要求）；无HTTP、schema或migration变化，不新增架构Owner或运行时依赖。

### 受管资源根身份的有限观察

2026-10-01 接续在restore-check当前状态投影比对后增加受管根观察，现有内容锁及目标维护会话仍持有。存储路径文字与数据库投影不能证明当前目录身份；复用已核目标包助手的inspect-root，不带managed-content参数，只打开已有根查询原生FileIdInfo。根身份采用卷序列号16位hex与原生128位FileId的32位hex，不以Node dev/ino替代，也不证明外部正文与备份时相同。

合法file_write_root_id为null时保持NO_STORED_ID；同ID报告MATCH，不同ID报告ID_MISMATCH，原生粗ROOT_UNAVAILABLE仅报告UNAVAILABLE，不猜测删除或重建。查询不修改登记、resource_epoch、revision、权限、动作或执行权。助手调用提取仅复用既有单次协议，源祖先分离的严格路径、硬链接拒绝及错误语义保留；新观察核对普通助手身份与前后SHA，限定环境、数量/字节及合作期限，并等待owned child实际关闭。固定128根上限及30秒/单次10秒预算不是OS硬RTO。

报告单列resource_root_identity_probe，绑定本次状态、助手与资源行身份；EXTERNAL_RESOURCE_LIVE_IDENTITY及其余pending继续保留，激活保持NOT_GRANTED。仅新增维护报告和有限观察，没有HTTP、业务schema、migration或Gateway登记Owner变化；超过固定根数上限的维护核对将安全拒绝，Breaking Change: Yes（维护CLI有界观察）。真实运行结果及独立验收状态仅归功能验收表，不把有限MATCH升级为恢复可启动或完整外部事实已验收。

### 恢复目录后续再备份的当前边界

当前仍隔离的目标不能调用普通createBackup：原目标保留应用角色CONNECT撤销，首次双角色目标核对即拒绝，尚未创建backup_root。即使未来具备合法应用连接，当前文件inventory也先按根条目名称拒绝 `restore-isolation.json`、`restore/` 和 `evidence/`，不会静默漏掉或扫描未知材料；这不是完整再备份能力。现有readRestoreBackup需要新备份自己的complete、manifest、state、Registry、source-ACL与归档，不会将restore目录中的原历史manifest当作新备份完成证明。

TODO：接续明确有限历史材料清单、格式版本及兼容出口后再实施。保持现有CONTENT/STAGING/ARMED活动文件映射，历史evidence及恢复元数据须单独绑定与预算；不递归形成evidence/evidence，不把历史ARMED伪装为当前runtime-launches、本次stoppedLaunch授权或当前目标ACL。恢复链须区分原来源身份、当次目标身份和新备份事实，缺材料/hash错配/unknown路径继续拒绝；普通新增Task/正文与既有历史证据均需纳入真实备份→还原→再次备份/还原反例。明确激活的准入与唯一Owner另行核对，旧check报告不能代替连续有效会话或新核对。
