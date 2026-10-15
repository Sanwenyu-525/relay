-- 工具续轮的最小协议数据：仅每轮首行保存 assistant 正文与 Provider reasoning_content。
-- 0054 的工具请求/结果账本仍为恢复依据；此字段不写 model_calls 计量账本、不作业务判断，
-- 不通过工具轨迹 API 暴露。旧行保持 NULL，不能补造未保存的历史。
ALTER TABLE run_tool_calls ADD COLUMN assistant_message jsonb;

ALTER TABLE run_tool_calls ADD CONSTRAINT ck_run_tool_calls_assistant_message CHECK (
  assistant_message IS NULL OR (
    ordinal = 0
    AND jsonb_typeof(assistant_message) = 'object'
    AND assistant_message ? 'content'
    AND jsonb_typeof(assistant_message -> 'content') = 'string'
    AND (NOT assistant_message ? 'reasoning_content'
      OR jsonb_typeof(assistant_message -> 'reasoning_content') = 'string')
    AND assistant_message - 'content' - 'reasoning_content' = '{}'::jsonb
    AND octet_length(assistant_message ->> 'content')
      + coalesce(octet_length(assistant_message ->> 'reasoning_content'), 0) <= 524288
  )
);

-- relay_app 原有表级 INSERT 覆盖新列；既有 UPDATE 列授权不含 assistant_message，
-- 因此续轮字段随首次 INSERT 固定，之后只能推进工具状态/结果。
