-- 模型能力档案（2026-10-19）：把「这个模型能做什么」从进程环境变量提升为跟着
-- 模型身份走的声明。目录（model_catalog_entries）是价格快照、只覆盖公开目录里的模型；
-- 自建 Provider 的模型不在其中，此前只能靠 RELAY_MODEL_IMAGE_INPUT 这一个进程级布尔，
-- 换模型即失效。
--
-- 实例级全局事实，不隶属 Workspace（与 model_catalog_entries、/model-port 同一先例）。
-- 一个模型一条声明，重复声明是覆盖；撤销声明是删除行，回到「未声明」。
CREATE TABLE model_capability_declarations (
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  source_model_id text NOT NULL CHECK (length(source_model_id) BETWEEN 1 AND 200),
  -- 目前唯一一条能力：是否接受图片输入。目录里有条目时目录仍是准绳，
  -- 声明只补「目录里没有这个模型」这一处空白（见 application/chat-image-input.ts）。
  image_input boolean NOT NULL,
  -- 声明依据（例如「官方文档写明原生多模态」）。不存密钥、不存完整 base URL。
  note text CHECK (note IS NULL OR length(note) <= 500),
  declared_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, source_model_id)
);

-- 应用角色需要读写它（与 0118/0119 同一约定）：漏了这条会让 /model-port 的投影
-- 静默降级成 UNKNOWN——读不到表时端点不失败，只如实说「这次无法确认」。
GRANT SELECT, INSERT, UPDATE, DELETE ON model_capability_declarations TO relay_app;
