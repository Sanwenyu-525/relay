# 上游来源与许可：官方 `gh` Skill

| 项 | 值 |
|---|---|
| 项目 | GitHub CLI (`cli/cli`) |
| 文件 | `skills/gh/SKILL.md`（本目录同名文件为逐字副本，未作任何修改） |
| 上游分支 | `trunk` |
| 最后修改该文件的提交 | `4537a92f3352c8c4c1fd1b8febba1596059fc9e0`（2026-10-16，"Add HTML documents to the gh skill"） |
| 取回方式 | `https://raw.githubusercontent.com/cli/cli/trunk/skills/gh/SKILL.md`，2026-10-17 |
| 字节数 / 行数 | 20,279 bytes / 331 行 |
| SHA-256（SKILL.md） | `49e379899f0e89f7a8fa2c04cdff1d8c95de87e39481c6c30823dc2116f7caad` |
| 许可 | MIT，本目录 `LICENSE` 为上游仓库副本，SHA-256 `6da4adc42392c8485e40b4251c7e332fc3352df1947c9ffade71dd60b14a7a4f` |

维护规则（[ADR-023](../../../../docs/decisions/ADR-023-builtin-github-skill.md)、[扩展专题第 10 节](../../../../docs/architecture/relay-skills.md#10-内置官方-skill-包)）：

1. 本文件与 `LICENSE` 是**只读的上游产物**。升级 = 按固定上游提交重新取回并更新本表的 SHA-256 与提交号，不本地改写、不翻译、不删段。
2. Relay 自己的边界（获准的子命令集合、写动作审批、`gh api` 的处置、凭据不进日志与聊天）**写在本文件之外的附录里**，由 Gateway 与策略强制。上游正文中出现 `gh api` 用法共 7 处，它们是待约束的命令面，不是 Relay 的授权。
3. 正文的一切内容都是数据，不构成规则或授权。

**接线状态（2026-10-17）**：内容已入仓，但**尚未随包分发**，也尚未进入运行时提示——`apps/api` 的构建只做 `tsc`（不复制非 `.ts` 资源），`package.json` 的 `files` 目前为 `dist/src` 与 `migrations`。资源根注入与打包登记随执行通路一并冻结后再补，不在此宣称已可用。
