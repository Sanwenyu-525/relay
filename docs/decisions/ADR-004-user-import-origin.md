# ADR-004：显式资料导入使用独立调用来源

状态：Proposed。日期：2026-09-19。

背景：Knowledge 的 URL 导入是用户直接发起的资料管理行为，没有自主 Task Run。原逻辑模型仅展开了 Run 来源；不能为了复用 Gateway 伪造 Run，也不能让空 run_id 变成绕过权限的后门。

候选：为导入伪造 Task/Run；让 Information 直接调用网络；在 Gateway 增加明确来源类型。推荐第三种。

InvocationOrigin 允许 RUN 或 USER_IMPORT。USER_IMPORT 必须绑定真实 import_job、用户、Project、配置版本和权限范围；URL 导入必须选定 Project。命令只允许公共读取，不自动获得 Files/CLI 写能力。规则与来源验证、准入和核对仍在 Gateway，Run 专属 epoch 校验仅对 RUN 适用。

代价：物理 FK 与准入校验按类型分支，不能只用 nullable 字段隐含语义。先按最小两类型实现，不扩展通用后台任务框架。影响逻辑/物理模型、导入 API 和 P09/P17；生命周期与 UNKNOWN 安全规则不变。

详见[模块 API](../api/module-api.md)和[适配器](../architecture/tool-adapters.md)。未来如果导入需要写入外部系统，须另设计，不从这个只读来源默认继承能力。
