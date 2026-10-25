-- P1-C 第一片：成员消息唤醒与消费结算（ADR-034 包 C；协调者建任务、外部领取、
-- 巡检合并与 Windows 生命周期归后续片）。
--
-- 0140 只保存 processing_status 词表，消费循环归包 C；本迁移补上消费的持久事实：
-- 谁在领取（claimed_by + 租约）、试了几次（attempts）、何时结算（processed_at）、
-- 为何失败（failure_reason）。约束把「领取/结算事实」与 processing_status 绑死：
-- RECORDED 不携带任何在途领取事实；CLAIMED 必须有租约且未结算；两个终态必须有
-- 结算时间；失败原因只属于 FAILED。重复扫描与并发巡检不重复领取由
-- RECORDED→CLAIMED 的条件更新（CAS）保证，不新增第二套状态机。
--
-- model_calls 同步新增无 Run/会话作用域的 kind 取值 'MEMBER'（沿用 0091 给
-- COMPOSER 扩枚举的同一模式）：成员唤醒是一次真实模型调用，必须进既有账本——
-- 「项目不额外设累计消耗上限」不等于不计量（PT-09：实际消耗有来源）。
-- member_message_id 指回触发的消息行，成本证据可追溯到业务对象；与 VERIFY/
-- COMPOSER 一样不占 Run/会话预算，也不冒用验证探针身份。
--
-- 兼容与回滚：既有 project_member_messages 行全为 RECORDED 且新列允许空/默认值，
-- 不回填。model_calls 旧行与新枚举值不冲突。回退需先删本迁移写入的 'MEMBER'
-- 调用证据行并删除新列/约束；期间产生的 CLAIMED 行在回退前应由应用收敛到终态。
-- Breaking Change: No（旧客户端不感知新列与新枚举）。

ALTER TABLE project_member_messages
  ADD COLUMN claimed_by text,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN processed_at timestamptz,
  ADD COLUMN failure_reason text,
  ADD CONSTRAINT ck_member_message_processing CHECK (
    (processing_status = 'RECORDED' AND claimed_by IS NULL AND claimed_at IS NULL
      AND lease_expires_at IS NULL AND processed_at IS NULL AND failure_reason IS NULL)
    OR (processing_status = 'CLAIMED' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND processed_at IS NULL AND failure_reason IS NULL)
    OR (processing_status = 'PROCESSED' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND processed_at IS NOT NULL AND failure_reason IS NULL)
    OR (processing_status = 'FAILED' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND processed_at IS NOT NULL AND failure_reason IS NOT NULL)
  );

-- 唤醒扫描的取候选路径：只在未结算（RECORDED）行上走索引。
CREATE INDEX project_member_messages_wakeup
  ON project_member_messages (created_at, id)
  WHERE processing_status = 'RECORDED';

-- model_calls：重建 kind 枚举与 kind↔来源配对约束（与 0091 同一 DO 定位方式），
-- 再加 member_message_id 列。MEMBER 行要求 member_message_id 非空、其他作用域全空。
DO $$
DECLARE
  cons record;
BEGIN
  FOR cons IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'model_calls'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%DRAFT%'
      AND pg_get_constraintdef(oid) LIKE '%SEMANTIC_CHECK%'
  LOOP
    EXECUTE format('ALTER TABLE model_calls DROP CONSTRAINT %I', cons.conname);
  END LOOP;
END $$;

ALTER TABLE model_calls
  ADD COLUMN member_message_id uuid REFERENCES project_member_messages(id);

ALTER TABLE model_calls ADD CONSTRAINT ck_model_calls_kind
  CHECK (kind IN ('DRAFT', 'SEMANTIC_CHECK', 'ASSIST', 'VERIFY', 'COMPOSER', 'MEMBER'));

ALTER TABLE model_calls ADD CONSTRAINT ck_model_calls_kind_origin CHECK (
  (kind = 'DRAFT' AND step_attempt_id IS NOT NULL AND manifest_id IS NOT NULL
    AND assist_message_id IS NULL AND criterion_id IS NULL AND check_attempt IS NULL
    AND member_message_id IS NULL)
  OR (kind = 'SEMANTIC_CHECK' AND step_attempt_id IS NOT NULL AND manifest_id IS NULL
    AND assist_message_id IS NULL AND criterion_id IS NOT NULL AND criterion_id <> ''
    AND check_attempt IS NOT NULL AND member_message_id IS NULL)
  OR (kind = 'ASSIST' AND step_attempt_id IS NULL AND manifest_id IS NULL
    AND assist_message_id IS NOT NULL AND criterion_id IS NULL AND check_attempt IS NULL
    AND member_message_id IS NULL)
  OR (kind = 'VERIFY' AND step_attempt_id IS NULL AND manifest_id IS NULL
    AND assist_message_id IS NULL AND criterion_id IS NULL AND check_attempt IS NULL
    AND member_message_id IS NULL)
  OR (kind = 'COMPOSER' AND step_attempt_id IS NULL AND manifest_id IS NULL
    AND assist_message_id IS NULL AND criterion_id IS NULL AND check_attempt IS NULL
    AND member_message_id IS NULL)
  OR (kind = 'MEMBER' AND step_attempt_id IS NULL AND manifest_id IS NULL
    AND assist_message_id IS NULL AND criterion_id IS NULL AND check_attempt IS NULL
    AND member_message_id IS NOT NULL)
);

-- 新列不继承 0018/0140 的表级授权，逐列补齐应用角色权限。
GRANT SELECT (claimed_by, claimed_at, lease_expires_at, attempts, processed_at, failure_reason),
  INSERT (claimed_by, claimed_at, lease_expires_at, attempts, processed_at, failure_reason),
  UPDATE (claimed_by, claimed_at, lease_expires_at, attempts, processed_at, failure_reason)
  ON project_member_messages TO relay_app;
GRANT SELECT (member_message_id), INSERT (member_message_id), UPDATE (member_message_id)
  ON model_calls TO relay_app;
