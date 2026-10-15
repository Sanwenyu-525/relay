-- 自然语言状态维护独立复验整改（prompts/remediation/natural-language-state-maintenance-acceptance-20261010.md，2026-10-10）。
-- 三处 schema 变化，其余逻辑留在应用层，不复制第二套业务状态：
--
-- R1 拒绝语义：用户回答「不调整」后，受这项决定约束的变更进入新终态 DECLINED
--    （按用户决定未执行）。它既不是 APPLIED/SKIPPED（那会谎报「已生效/已存在」），
--    也不是 PENDING（那会让自动应用再次执行）。请求行同样新增 DECLINED 终态。
--    只放宽这两个状态白名单；APPLIED/COMPENSATED 的引用约束逐字保留。
--
-- R3 解释基线前置冻结：conversation_state_requests 新增 interpretation_baseline，
--    在 claim 事务里、调用模型**之前**持久冻结该意图依据的 Project State 版本；
--    解释结算把结果关联到这一基准，重启/UNKNOWN 恢复沿同一行继续，不重新按最新版本冒充。
--    迁移前的旧行该列为 NULL：结算时缺少可信基线的状态类变更按类型化冲突保守拒绝。
--
-- R6 展示身份绑定：新表 project_daily_view_presentations 记录每次 GET 真正签发的
--    展示身份（presentation_id + seq + 当次 State 版本 + 已展示事实摘要）。
--    确认必须逐项对上签发记录，序号在上限内不再足以证明「这份身份/内容展示过」。
--    兼容：迁移时把既有基线行按其自身身份回填为一条 legacy 签发记录（seq 可为 0，
--    对应 0065 之前无序号时代的确认），此后新协议的确认都留下可核对的签发来源；
--    迁移后伪造的基线因缺少签发来源且版本高于任何真实读取，由应用层识别并修复（见
--    confirmProjectDailyView 的 provenance 恢复分支，审计事件 PROJECT_DAILY_VIEW_BASELINE_REPAIRED）。
--    回滚风险：新表与新列均为追加，回退应用版本后旧代码不读它们；DECLINED 终态
--    会被旧白名单拒绝（仅影响回退后读写新数据），建议随数据清理一并评估。

-- R1：请求与变更的状态白名单增加 DECLINED。
ALTER TABLE conversation_state_requests DROP CONSTRAINT ck_conversation_state_request_status;
ALTER TABLE conversation_state_requests ADD CONSTRAINT ck_conversation_state_request_status
  CHECK (status IN (
    'INTERPRETING', 'DISCUSSED', 'CLARIFY', 'READY', 'APPLYING', 'APPLIED', 'PARTIAL',
    'FAILED', 'DECISION_REQUIRED', 'DECLINED', 'UNDOING', 'UNDONE', 'UNDO_PARTIAL',
    'UNDO_BLOCKED'));

ALTER TABLE conversation_state_changes DROP CONSTRAINT ck_conversation_state_change_status;
ALTER TABLE conversation_state_changes ADD CONSTRAINT ck_conversation_state_change_status
  CHECK (status IN (
    'PENDING', 'APPLIED', 'FAILED', 'SKIPPED', 'DECLINED', 'COMPENSATED',
    'COMPENSATION_FAILED'));

-- R3：模型调用前冻结的解释基线（jsonb：{ "state_revision": "0" }）。
ALTER TABLE conversation_state_requests ADD COLUMN interpretation_baseline jsonb;

-- R6：真实签发的展示身份与当次事实摘要。
CREATE TABLE project_daily_view_presentations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  presentation_id uuid NOT NULL,
  issued_seq bigint NOT NULL,
  state_revision bigint NOT NULL,
  fact_refs jsonb NOT NULL CHECK (jsonb_typeof(fact_refs) = 'object'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_daily_view_presentation_identity UNIQUE (workspace_id, presentation_id),
  CONSTRAINT uq_daily_view_presentation_seq UNIQUE (workspace_id, project_id, issued_seq),
  CONSTRAINT ck_daily_view_presentation_seq CHECK (issued_seq >= 0)
);
CREATE INDEX ix_daily_view_presentation_project
  ON project_daily_view_presentations (project_id, issued_seq DESC);
GRANT SELECT, INSERT, UPDATE ON project_daily_view_presentations TO relay_app;

-- 兼容回填：迁移前已确认的基线按其自身展示身份回填签发来源（0065 之前的历史行序号为 0，
-- 不与后续签发的序号冲突——计数器从 0 起，第一次新签发是 1）。
INSERT INTO project_daily_view_presentations
  (id, workspace_id, project_id, presentation_id, issued_seq, state_revision, fact_refs, issued_at)
select gen_random_uuid(), b.workspace_id, b.project_id, b.presentation_id,
  b.viewed_presentation_seq, b.viewed_state_revision, b.viewed_fact_refs, b.confirmed_at
from project_daily_view_baselines b
on conflict do nothing;
