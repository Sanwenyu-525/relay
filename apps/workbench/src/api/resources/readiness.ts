import { RelayHttp } from "../core/http";
import { object, string } from "../core/primitives";
import type { RelayReadiness } from "../dtos/readiness";

export async function getHealthReady(http: RelayHttp): Promise<RelayReadiness> {
  const body = await http.request("/health/ready");
  const record = object(body, "readiness");
  if (string(record, "status", "readiness") !== "ready") {
    throw new Error("服务端返回了无法识别的 readiness 状态。");
  }
  return { status: "ready" };
}
