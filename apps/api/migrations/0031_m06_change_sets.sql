-- M06 增量 A：把每次变化集执行的逐文件事实从内存结果变成可追溯证据。
-- 依据 contracts/04-recovery-and-commit.md 与 docs/architecture/tool-adapters.md §2：
--   * 一次 Gateway 调用（invocation）至多一份 change_sets 行：恢复核对复用同一行，
--     不因二次核对插入另一份历史，也不新建伪造成功。
--   * change_set_files 是写入即固定的观测行：应用角色没有 UPDATE/DELETE，核对阶段
--     只补记执行阶段缺失的文件行，绝不改写执行时已记录的状态与原因。
--   * 只登记落盘之后的「结果事实」；磁盘 I/O 在事务外完成，落库与调用结果结算同处
--     一个短事务，二者要么同时成立要么同时不成立。
--   * 部分应用不整体成功：存在冲突/失败时整体标 PARTIAL；结果无法归属本次调用或
--     核对未确认时标 UNKNOWN，等待人工核对，不算通过。
--   * 作用域（workspace/project/run/resource）由复合外键与产生它的动作保持一致，
--     供归档栅栏与逐文件证据读取直接按 Run 取用。

CREATE TABLE change_sets (
  id uuid PRIMARY KEY,
  invocation_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  -- 变化集来自哪一种受管写动作；两者都只允许 RUN 来源并绑定受管资源根（0030 登记）。
  action_type text NOT NULL,
  -- 执行时使用的规范根：APPLY_CHANGESET 是受管资源根，WRITE_FILE 是目标文件的父目录。
  canonical_root text NOT NULL,
  status text NOT NULL,
  -- 当前整体状态来自适配器执行报告（EXECUTION）还是事后按真实内容回读（RECONCILIATION）。
  evidence_source text NOT NULL,
  -- 声明的文件数：与冻结动作参数一致，用于识别「结果丢失后一条证据都没留下」。
  file_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 幂等锚点：同一 invocation 至多一份变化集，核对按此身份回到同一行。
  CONSTRAINT uq_change_set_invocation UNIQUE (invocation_id),
  -- 供 change_set_files 用复合外键证明文件行属于同一 invocation 的同一份变化集。
  CONSTRAINT uq_change_set_identity UNIQUE (id, invocation_id),
  CONSTRAINT fk_change_set_invocation FOREIGN KEY (invocation_id, operation_id)
    REFERENCES invocation_attempts (id, operation_id),
  CONSTRAINT fk_change_set_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT fk_change_set_run FOREIGN KEY (workspace_id, run_id)
    REFERENCES runs (workspace_id, id),
  CONSTRAINT fk_change_set_resource FOREIGN KEY (workspace_id, project_id, resource_id)
    REFERENCES managed_resources (workspace_id, project_id, id),
  CONSTRAINT ck_change_set_action CHECK (action_type IN ('APPLY_CHANGESET', 'WRITE_FILE')),
  CONSTRAINT ck_change_set_status CHECK (status IN ('SUCCEEDED', 'PARTIAL', 'UNKNOWN')),
  CONSTRAINT ck_change_set_evidence CHECK (evidence_source IN ('EXECUTION', 'RECONCILIATION')),
  CONSTRAINT ck_change_set_root CHECK (canonical_root <> ''),
  CONSTRAINT ck_change_set_file_count CHECK (file_count >= 1)
);

CREATE INDEX ix_change_sets_run ON change_sets (run_id, created_at, id);
CREATE INDEX ix_change_sets_operation ON change_sets (operation_id, id);

-- 逐文件证据：一次变化集内每个相对路径一行，写入后不可改写（无 UPDATE/DELETE 权限）。
CREATE TABLE change_set_files (
  change_set_id uuid NOT NULL,
  -- 冗余保存 invocation 只为用复合外键证明文件行确实属于那份变化集。
  invocation_id uuid NOT NULL,
  -- 冻结动作参数里的根内相对路径（已按执行时的规范根归一）。
  relative_path text NOT NULL,
  action text NOT NULL,
  -- 声明的冻结基线（MODIFY/DELETE 的比对前像）与执行前实测到的当前内容。
  baseline_sha256 text,
  observed_baseline_sha256 text,
  -- 期望落盘后的目标摘要；DELETE 没有目标内容，固定为 NULL。
  target_sha256 text,
  -- 落盘后实际内容摘要；NULL 表示该路径当前不存在（DELETE 的成功形态）。
  actual_sha256 text,
  status text NOT NULL,
  error text,
  -- diff 引用占位：本增量只留字段，逐文件 diff 生成与 UI 尚未实现。
  diff_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (change_set_id, relative_path),
  CONSTRAINT fk_change_set_files_set FOREIGN KEY (change_set_id, invocation_id)
    REFERENCES change_sets (id, invocation_id),
  CONSTRAINT ck_change_set_files_action CHECK (action IN ('CREATE', 'MODIFY', 'DELETE')),
  CONSTRAINT ck_change_set_files_status CHECK (status IN ('APPLIED', 'CONFLICT', 'FAILED')),
  CONSTRAINT ck_change_set_files_path CHECK (relative_path <> ''
    AND octet_length(relative_path) <= 1024),
  -- 摘要列只接受真正的 SHA-256，避免把「看起来像 hash」的垃圾值当证据。
  CONSTRAINT ck_change_set_files_hashes CHECK (
    (baseline_sha256 IS NULL OR baseline_sha256 ~ '^[0-9a-f]{64}$')
    AND (observed_baseline_sha256 IS NULL OR observed_baseline_sha256 ~ '^[0-9a-f]{64}$')
    AND (target_sha256 IS NULL OR target_sha256 ~ '^[0-9a-f]{64}$')
    AND (actual_sha256 IS NULL OR actual_sha256 ~ '^[0-9a-f]{64}$')),
  -- 修改/删除必须留下冻结基线；执行前就因非法输入被拒的 FAILED 是唯一例外。
  CONSTRAINT ck_change_set_files_baseline CHECK (
    action = 'CREATE' OR status = 'FAILED' OR baseline_sha256 IS NOT NULL),
  CONSTRAINT ck_change_set_files_delete CHECK (action <> 'DELETE' OR target_sha256 IS NULL),
  -- 声称成功就必须有与目标一致的实际内容证据；删除的成功是路径确实不存在。
  CONSTRAINT ck_change_set_files_applied CHECK (
    status <> 'APPLIED'
    OR (action = 'DELETE' AND actual_sha256 IS NULL)
    OR (action <> 'DELETE' AND actual_sha256 IS NOT NULL AND actual_sha256 = target_sha256)),
  -- 未成功的文件必须留下原因，不能只留一个状态字。
  CONSTRAINT ck_change_set_files_reason CHECK (
    status = 'APPLIED' OR (error IS NOT NULL AND error <> '')),
  CONSTRAINT ck_change_set_files_diff CHECK (diff_ref IS NULL OR jsonb_typeof(diff_ref) = 'object')
);

-- 证据不可抹除：不授予 DELETE；逐文件行连 UPDATE 都不授予。
-- change_sets 只允许更新整体状态、证据来源、声明文件数与更新时间，
-- 身份/作用域/规范根等声明性列由权限禁止改写。
GRANT SELECT, INSERT ON change_sets TO relay_app;
GRANT UPDATE (status, evidence_source, file_count, updated_at) ON change_sets TO relay_app;
GRANT SELECT, INSERT ON change_set_files TO relay_app;
