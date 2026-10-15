-- 内置工作方法与聊天命令（总纲 §0.13 / Skill 专题 §9 / 测试计划 §26 BC-02–BC-04）。
--
-- 三条新增方法（code-review / fault-diagnosis / docs-maintenance）与首批四项提案型 Skill
-- 的区别是：方法可以实际开展工作，其身份必须在**发起那一刻**冻结，之后定义被替换或禁用
-- 都不改变这条消息已经采用的版本。因此这里只给 assist_messages 增加三列：
--   * method_snapshot：冻结的方法定义 + 摘要（形状与校验见 skills/builtin-methods.ts）；
--   * method_action  ：本次行动（INSPECT 只读报告 / MODIFY 明确要求修改）；
--   * method_argument：用户补充的目标文本（与 skill_input 分开，避免被当成提案输入）。
--
-- 本迁移不改任何表结构之外的东西、不回填历史行：既有消息三列全为 NULL，
-- 读出后与新增能力之前的行为完全一致。
--
-- Breaking Change：No（纯新增可空列与约束）。

ALTER TABLE assist_messages ADD COLUMN method_snapshot jsonb;
ALTER TABLE assist_messages ADD COLUMN method_action text;
ALTER TABLE assist_messages ADD COLUMN method_argument text;

-- 三列必须同时齐备或同时缺席：一条消息要么没采用方法，要么带着完整的方法身份。
-- 只写 method_snapshot 而不知道本次是只读还是修改，会让回执无法解释它到底做了什么。
ALTER TABLE assist_messages ADD CONSTRAINT ck_assist_message_method CHECK (
  (method_snapshot IS NULL AND method_action IS NULL AND method_argument IS NULL)
  OR (jsonb_typeof(method_snapshot) = 'object'
    AND method_action IN ('INSPECT', 'MODIFY')
    AND (method_argument IS NULL OR length(method_argument) <= 2000)));

-- 方法与第一方 Skill 调用是两种身份，不能同时出现在一条消息上。
ALTER TABLE assist_messages ADD CONSTRAINT ck_assist_message_method_exclusive CHECK (
  method_snapshot IS NULL OR skill_snapshot IS NULL);
