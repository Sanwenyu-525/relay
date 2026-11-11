-- 0161：删除会话改为「解除引用」而不是阻断（ADR-027 2026-11-10 修订）。
--
-- 用户决定：删除是显式动作，需要保留的对象不会被随手删除；服务端不再用
-- `SESSION_DELETE_BLOCKED` 把会话锁死在「被别的对象引用」这一状态。删除会话时：
--   * 会话自有的行（消息、计划、目标、待办、记忆凭据、撤回账本、委派账本等）照旧显式删；
--   * 外部对象**保留**，只把指向被删会话/消息的来源列置空（Task 验收观察、项目假设、
--     工作片段、蓝图提案、artifact 影响检查）；学习证据由会话派生，随会话删除，
--     知识点身份保留；
--   * 分叉子会话保留，`forked_from_session_id` 置空；
--   * 单独删除子代理会话时，父会话委派账本保留，`child_session_id` 与结论消息引用置空。
--
-- 这一条只补「解除引用」真正需要的东西：
--   1. artifact 影响检查的两条来源列原本 NOT NULL，无法置空；现在允许 NULL，检查本身、
--      候选组与已提交的组合检查全部保留，只是失去「来自哪条会话/消息」的指针。
--   2. 蓝图提案的 CHECK 要求 SKILL 提案必须有来源消息。新增 `source_detached_at`：
--      会话删除时来源消息置空并写下脱钩时刻，提案仍明确是 SKILL 来源，只是原消息已删除。
--   3. 验收观察与假设版本的来源列此前没有 UPDATE 授权；补**列级** UPDATE，不放开整表。
--      其他要置空的列（工作片段、蓝图提案、学习证据、委派账本、会话分叉）已有 UPDATE。
--
-- 刻意不做：不授予 Task 观察/假设/工作片段/蓝图/组合检查的 DELETE，也不删除这些外部对象。
-- 删除会话只解除引用，不替别的对象抹掉历史。
--
-- 回滚：恢复两条 NOT NULL 只对「没有置空过」的库成立；已解除引用的行无法回滚，执行前须核对
-- `assist_session_id` / `assist_message_id` 是否已有 NULL。列级 UPDATE 授权可直接 REVOKE，
-- 回滚后删除带这些引用的会话会退回 500 permission denied，而不是恢复旧的业务阻断。

ALTER TABLE artifact_impact_checks
  ALTER COLUMN assist_session_id DROP NOT NULL,
  ALTER COLUMN assist_message_id DROP NOT NULL;

ALTER TABLE artifact_impact_candidates
  ALTER COLUMN assist_session_id DROP NOT NULL,
  ALTER COLUMN assist_message_id DROP NOT NULL;

COMMENT ON COLUMN artifact_impact_checks.assist_session_id IS
  '发起这次影响检查的会话；会话被删除后置 NULL，检查与其下游组合检查保留。';
COMMENT ON COLUMN artifact_impact_checks.assist_message_id IS
  '承载影响分析的助手消息；会话被删除后置 NULL，检查保留。';
COMMENT ON COLUMN artifact_impact_candidates.assist_session_id IS
  '发起修改候选的会话；会话被删除后置 NULL，候选与已应用版本保留。';
COMMENT ON COLUMN artifact_impact_candidates.assist_message_id IS
  '承载候选正文的助手消息；会话被删除后置 NULL，候选保留。';

-- 蓝图提案：SKILL 来源必须有消息的 CHECK 允许「消息已随会话删除」这一确定状态。
ALTER TABLE project_blueprint_proposals
  ADD COLUMN source_detached_at timestamptz;

ALTER TABLE project_blueprint_proposals
  DROP CONSTRAINT ck_blueprint_origin_message,
  ADD CONSTRAINT ck_blueprint_origin_message CHECK (
    (origin = 'USER_DRAFT' AND skill_message_id IS NULL)
    OR (origin = 'SKILL' AND (skill_message_id IS NOT NULL OR source_detached_at IS NOT NULL))
  );

COMMENT ON COLUMN project_blueprint_proposals.source_detached_at IS
  '来源会话被删除、skill_message_id 已置空的时刻；非空表示提案保留但原消息不可再读。';

-- 蓝图候选冻结触发器只放行一种来源变化：SKILL 提案的来源消息随会话删除而置空，
-- 且同一语句写下脱钩时刻。其余字段（origin/candidate/baseline/source/摘要）仍不可变，
-- 也不允许把来源重新指回任何消息。
CREATE OR REPLACE FUNCTION guard_project_blueprint_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR
     OLD.project_id IS DISTINCT FROM NEW.project_id OR
     OLD.origin IS DISTINCT FROM NEW.origin OR
     OLD.supersedes_proposal_id IS DISTINCT FROM NEW.supersedes_proposal_id OR
     OLD.candidate IS DISTINCT FROM NEW.candidate OR
     OLD.baseline IS DISTINCT FROM NEW.baseline OR
     OLD.source IS DISTINCT FROM NEW.source OR
     OLD.candidate_sha256 IS DISTINCT FROM NEW.candidate_sha256 THEN
    RAISE EXCEPTION 'Project Blueprint candidate is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.skill_message_id IS DISTINCT FROM NEW.skill_message_id OR
      OLD.source_detached_at IS DISTINCT FROM NEW.source_detached_at) AND NOT (
      OLD.skill_message_id IS NOT NULL AND NEW.skill_message_id IS NULL
      AND OLD.source_detached_at IS NULL AND NEW.source_detached_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Project Blueprint candidate is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

GRANT UPDATE (source_message_id) ON task_acceptance_trial_observations TO relay_app;
GRANT UPDATE (source_message_id) ON hypothesis_versions TO relay_app;
GRANT UPDATE (assist_session_id, assist_message_id) ON artifact_impact_checks TO relay_app;
GRANT UPDATE (assist_session_id, assist_message_id) ON artifact_impact_candidates TO relay_app;
