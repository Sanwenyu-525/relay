import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient, RelayModelPortStatus, RelayModelVerificationState } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { resolveVerificationState, type ModelVerificationStateKind } from "../views/SettingsView";

/**
 * 当前服务实例的模型端口只读条。回答「这个实例到底会不会调真实模型」，
 * 不重复设置页的验证交互（验证写入调用账本，只在设置页触发）。
 */

const stateLabels: Record<ModelVerificationStateKind, string> = {
  UNCONFIGURED: "未配置真实模型",
  UNVERIFIED: "已配置，尚未验证连接",
  VERIFYING: "验证中",
  VERIFIED: "连接已验证",
  VERIFY_FAILED: "连接验证失败",
  UNAVAILABLE: "模型端口状态不可读"
};

const providerLabels: Record<RelayModelPortStatus["provider"], string> = {
  fake: "Mock 端口",
  "openai-compatible": "真实 Provider（OpenAI 兼容）",
  invalid: "配置残缺"
};

export default function ModelConnectionStrip({ client, compact = false }: { readonly client: RelayApiClient; readonly compact?: boolean }) {
  const [status, setStatus] = useState<RelayModelPortStatus | null>(null);
  const [verification, setVerification] = useState<RelayModelVerificationState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setStatus(null);
    setVerification(null);
    setError(null);
    void Promise.all([client.getModelPortStatus(), client.getModelPortVerification()])
      .then(([nextStatus, nextVerification]) => {
        if (!active) return;
        setStatus(nextStatus);
        setVerification(nextVerification);
      })
      .catch((caught: unknown) => { if (active) setError(describeLiveError(caught).message); });
    return () => { active = false; };
  }, [client]);

  if (error !== null) {
    return <p className="helper-text" data-testid="collab-model-connection" role="status">
      模型端口状态读取失败：{error}</p>;
  }
  if (status === null) {
    return <p className="helper-text" data-testid="collab-model-connection">正在读取模型端口状态…</p>;
  }

  const state = resolveVerificationState({ status, verification, verifying: false });
  const details = <>
    <span className="status-chip">{stateLabels[state]}</span>
    {` ${providerLabels[status.provider]}${status.model === null ? "" : ` · ${status.model}`}`}
    {state === "UNCONFIGURED" && " · 本实例的 Assist 与 Run 生成走 Mock，不会外发任何内容。"}
    {state === "VERIFIED" && " · 连接验证通过不等于真实任务执行成功。"}
    {state === "VERIFY_FAILED" && " · 见设置页的失败分类；修复配置前不要把生成结果当作模型产出。"}
    {" "}
    <Link className="text-link" to="/settings">模型连接设置 →</Link>
  </>;
  if (compact) return <details className="collab-model-details" data-testid="collab-model-connection">
    <summary>{stateLabels[state]}</summary><p className="helper-text">{details}</p>
  </details>;
  return <p className="helper-text" data-testid="collab-model-connection">{details}</p>;
}
