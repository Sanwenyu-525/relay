# 开发工具 Skills 与共享入口

角色：本机开发工具的安装入口、来源和检查方法；不是 Relay 产品运行时 Skill 注册表。调用规则只维护在根 [AGENTS](../../AGENTS.md#4-设计实施与协作)，本次验收只维护在[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

## 1. 来源与入口

统一来源为 `%USERPROFILE%/.agents/skills`。机器可读的扫描范围、各 Agent 入口和已固定上游版本见 [dev-skills.config.json](../../scripts/dev-skills.config.json)，不要另外维护一份清单。脚本使用 Python 用户主目录及实际 `%LOCALAPPDATA%`，不绑定用户名；其他安装位置应显式修改配置，不能根据目录名称猜测。

| 工具 | 本机核实依据与共享方式 | 项目规则 |
|---|---|---|
| Codex | 原生用户 `.agents/skills`；兼容现有 `.codex/skills`。当前会话目录及 app-server 原生 `skills/list` 可核对实际发现 | 原生根 `AGENTS.md` |
| Trae / Trae CN | Windows 全局入口为 `.trae-cn/skills`；国际版兼容规则以安装版本为准。逐 Skill Junction 指向公共来源，避开 `.agents` 导入开关的不确定性 | `.trae/rules/relay-project.md` 的 `alwaysApply: true` 仅引用根 AGENTS |
| WorkBuddy | `.workbuddy/skills`；安装包实际 runtime 及 `.skill-list-cache.json` 的 `userSettings` 记录提供依据；逐 Skill Junction | 原生 `CODEBUDDY.md` / `AGENTS.md`；根 CODEBUDDY 仅提示完整读取 AGENTS，避免自动注入长度限制 |
| WorkBuddy AI | 独立的 `.workbuddy-ai/skills`；不能和 WorkBuddy 混称同一入口；逐 Skill Junction，已有链接按内容保留 | 同上，读取同一个根 AGENTS |
| Qoder / Qoder CN | `.qoder/skills` / `.qoder-cn/skills`；CN 安装包 `qoder-cn-agent-sdk` runtime 证实用户目录与项目 `.qoder` 分开。两个入口逐 Skill Junction | 安装包 runtime 支持原生 `AGENTS.md` |
| ZCode | `.zcode/skills`；安装的 `zcode-guide` 0.3.0 同时说明原生兼容 `.agents/skills`。保留逐 Skill Junction，避免不同客户端版本的发现差异 | 原生根 `AGENTS.md` |

Junction 让内部相对路径随 Skill 根目录完整解析，不需要每个会话复制。用户独立 Skills、工具内置 Skills、插件 Skills 仍由原工具管理；共享来源不意味着把需要特定 MCP、模型服务或产品 SDK 的 Skill 自动变成其他 Agent 的可执行能力。插件缓存可能含停用版本和备份，不将其计数冒充当前已启用数量。

官方依据：[Codex Skills](https://learn.chatgpt.com/docs/build-skills)、[Trae Skills](https://docs.trae.cn/ide_skills)、[Trae Rules](https://docs.trae.cn/ide_rules)、[Qoder Skills](https://docs.qoder.com/extensions/skills)、[ZCode Skills](https://zcode.z.ai/cn/docs/skill)、[WorkBuddy Skills](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)。官网描述与本机安装版本不一致时，保留差异并检查真实 runtime，不按官网推断客户端已加载。

## 2. 来源固定、差异与恢复

新增的 Anthropic `frontend-design`、Vercel `web-design-guidelines`、Impeccable `impeccable` 及选中的 Emil Skills 均来自作者仓库，按配置中的 commit 固定；完整复制 Skill 子目录，不运行远程安装脚本。Impeccable 使用仓库已编译的 `.agents/skills/impeccable`，不能拿 `skill/SKILL.src.md` 当可安装成品。它包含 Windows launcher；引擎首次运行下载固定版本二进制并验证 `.sha256`，不要求每次安装 Node 包。

`vercel-react-best-practices` 从完整的既有 Codex 安装复制到公共来源，保留原版本；已与上游固定提交比较文件集合。文件内容不同不等于缺失或允许升级，不能把比较提交写成既有安装的原始 commit。`ui-ux-pro-max` 与 Taste 有本地修改，没有可追溯安装提交时必须标为 unknown；当前文件哈希只能证明后续是否漂移，不能证明官方来源或历史版本。

本轮原文件与目录备份放在 `%USERPROFILE%/.agents/skill-audit/backups/20261025-221601`；`operations.json` 记录七处同名冲突的来源与备份位置。Trae 原 `webapp-testing` 的真实 ID 为 `webapp-uat`，按真实 ID 保留；其他冲突目录完整移出发现入口保存，再映射公共版本。`ui-design-flow` 只修 Frontmatter 分隔符与缩进；`video-gen` 只移除原生 Codex 不接受的 UTF-8 BOM。另补回两份 nested `planning-with-files` 缺失资源到保留的原仓库，未覆盖现有文件。

`design-engineer-3` 的规范 ID 是 `design-engineer`；其本地 `metadata.json` 指向作者 `trentferguson/homescreen-hero`，当前固定比较提交也缺少声明的三份 references。不要编造参考文件或从不相关的同名 Skill 拼接；在资源恢复前，默认路由使用完整的 `impeccable` / `ui-ux-pro-max`。自定义 `3d-animation-short-generator-dsh` 的缺失参考图从同机完整 `3d-animation-short-generator` 恢复，来源与图像 SHA-256 记录在统一配置。

需要恢复某个旧版时，先比对备份及公共版本，确认目标是链接且解析到预期公共目录，再用 `[IO.Directory]::Delete($linkPath, $false)` 仅摘除链接，将已核实的备份移回确切原位置。不要递归删除 Junction、公共源或整个用户 Skill 目录。以后新增备份使用新目录，不覆盖本次备份。

## 3. 可重复检查

前提：Python 3.12+ 与 PyYAML。本机已具备；检查脚本不会自动安装依赖，也不会执行 Skill 中的脚本、Hooks 或远程代码。

```powershell
# 默认只读，输出概况与 Agent 矩阵；已知异常会返回 1
python scripts/audit-dev-skills.py

# 每项 Skill 的 ID、入口、真实路径、版本、来源、文件哈希、错误与依赖清单
python scripts/audit-dev-skills.py --json --verbose

# 只预览缺失映射、相同内容、冲突与 blocked-source；不会写入
python scripts/audit-dev-skills.py --link --dry-run

# 显式创建完整来源的缺失 Junction；不完整来源只报告 blocked-source，不覆盖冲突
python scripts/audit-dev-skills.py --link

# 人工核对差异后，显式保存新的内容基线
python scripts/audit-dev-skills.py --write-baseline

python scripts/audit-dev-skills.test.py -v
node scripts/check-docs.mjs
```

`--config`、`--home`、`--project` 可用于隔离环境；`--baseline` 可指定基线位置。默认基线为 `%USERPROFILE%/.agents/skill-audit/baseline.json`；`--write-baseline --dry-run` 不写文件。完整来源重复同步应为 keep；已知不完整来源持续标记 blocked-source 并返回 1。新建 Skill 后再次显式 `--link` 才会加入原生入口，不在普通只读检查时偷偷同步。

扫描包括用户、项目、公共、已列明插件缓存及内置入口；检查 UTF-8/BOM、YAML 元数据、正文、明确 Markdown 资源链接、内部损坏链接/循环、Python 语法、文件内容哈希、同名异版与固定上游副本漂移。代码块中的示例不当成安装资源；无法确定的内联资源和输出占位链接列为 review，已人工核实的必需资源在统一配置 `requiredResources` 中声明并严格检查。忽略 `.git`、`node_modules`、Python 虚拟环境、缓存及插件 `.in_use` 等运行标记；它们不是 Skill 源文件，运行环境需另验。脚本不检查所有工具的自定义 profile 或未来新增插件位置；入口变化时先更新统一配置。

JSON 中 `structural-pass` **仅表示结构检查通过**。依赖 manifest 标为 `not-executed`；工具/MCP 依赖、网络规则源、密钥、POSIX shell 与 Python 语法提示需要按 Skill 的真实工作流验证。未知来源不自动变成可信，插件缓存的 YAML 不规范也不直接等价于该工具宽松解析器无法运行。明确区分：结构通过、来源已核、OS 可读、Agent 已发现、Agent 已读取、任务实际调用成功。

本机原始输出保留在 `%USERPROFILE%/.agents/skill-audit/` 的 `inventory.json`、`baseline.json`、`codex-native-discovery.json`。这些是带时点的本机证据，不能作为跨机器测试成绩。检查默认返回 1 时，应查看具体错误与 drift，不能删除条目或放宽检查后自报全通过。

## 4. 客户端 Smoke Test

- Codex：原生 app-server `initialize` 后调用 `skills/list`，参数包含当前项目 `cwds` 与 `forceReload: true`；检查 `enabled`、`errors`、路径及重点 ID，再在实际任务读取相应 SKILL。只列出名称不证明已经执行工作流。
- Trae：重新打开技能设置或按安装版本刷新索引，核对原生技能列表；官方文档说明 `.agents` 导入开关，所以本机采用 `.trae-cn` 原生入口。工具未启动时不要宣称通过。
- WorkBuddy / AI：原生技能设置核对列表和启用状态；缓存只是此前发现的证据。打包的 CLI wrapper 不一定可独立运行，不为测试随意更改其安装包或网络代理。
- Qoder：官方 IDE 文档要求重启后查看 `/` 列表；本机还存在不同 Desktop 版本，不自动重启正在工作的会话，后续需在对应版本验证。
- ZCode：设置 → 技能和 `/` 菜单核对加载、遮蔽、禁用与错误；原生 `zcode-guide` 的 `diagnosing-skills` / `zcode-configuration-guide` 提供版本对应的发现顺序。并发用户操作时退出自动点击，不用过期控件索引继续操作。

真实任务 Smoke Test 应只读取指定 Skill 与一个已知参考文件，并返回 Skill ID/路径和关键规则；不改代码、不发外部消息、不触发生成/部署。此步骤用于验证触发与读取，不承担业务验收。
