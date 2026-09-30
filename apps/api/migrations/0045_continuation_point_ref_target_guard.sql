-- 0044 的 ck_project_continuation_point_refs_target 是 NULL 不安全的：ref_kind='TASK' 且 task_id 为 NULL 时
-- `task_id = ref_id` 求值为 NULL 而非 FALSE，CHECK 只拒绝 FALSE，脏行因此可以落库，而 ref_id 本身没有外键。
-- 显式 IS NOT NULL 让两支都先落到 FALSE；同时把两类目标外键统一为即时检查（原 0044 只有 task_id 是 DEFERRABLE，无依据）。
ALTER TABLE project_continuation_point_refs
  DROP CONSTRAINT ck_project_continuation_point_refs_target;

ALTER TABLE project_continuation_point_refs
  ADD CONSTRAINT ck_project_continuation_point_refs_target CHECK (
    (ref_kind = 'TASK' AND task_id IS NOT NULL AND task_id = ref_id
      AND artifact_version_id IS NULL) OR
    (ref_kind = 'ARTIFACT_VERSION' AND artifact_version_id IS NOT NULL
      AND artifact_version_id = ref_id AND task_id IS NULL)
  );

-- 0044 里的两列外键是内联写的，名字由 PostgreSQL 自动生成，不是这里原本假设的约束名。
ALTER TABLE project_continuation_point_refs
  DROP CONSTRAINT project_continuation_point_refs_task_id_fkey;

ALTER TABLE project_continuation_point_refs
  ADD CONSTRAINT fk_project_continuation_point_refs_task
    FOREIGN KEY (task_id) REFERENCES tasks (id);

ALTER TABLE project_continuation_point_refs
  DROP CONSTRAINT project_continuation_point_refs_artifact_version_id_fkey;

ALTER TABLE project_continuation_point_refs
  ADD CONSTRAINT fk_project_continuation_point_refs_artifact_version
    FOREIGN KEY (artifact_version_id) REFERENCES artifact_versions (id);
