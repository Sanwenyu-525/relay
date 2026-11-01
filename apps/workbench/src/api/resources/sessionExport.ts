import type { RelayHttp } from "../core/http";
import { RelayApiError, RelayContractError } from "../core/errors";
import { isRecord } from "../core/primitives";

/**
 * 会话导出（`GET /assist-sessions/:id/export`）的客户端读取。
 *
 * 这份文档的结构**不在这里重复声明**：它的十九个顶层段落跟着服务端各投影走，客户端复制一份
 * 类型就等于给同一事实建第二个 Owner——服务端加一列，界面并不会因此多读到任何东西，反而会
 * 在这里先报「格式无效」，把一个本来能保存的诊断文件拦成失败。客户端只核对四件必须成立的事：
 *   * `format` 与 `schema_version`：确认拿到的确实是 Relay 会话导出，而不是某个错误页或旧路由的兜底响应；
 *   * `session.id` 等于请求的那条会话：文件名按这条会话的标题起，正文必须是同一会话的事实；
 *   * `messages` 是数组：空会话也是合法事实，但缺这一列说明这份文档根本不完整；
 *   * `exported_at` 读得出一个时刻：文件名上的那一天与文档里写的必须是同一天。
 *
 * 正文由调用方原样落盘：不在界面上重新拼一份「精简版」，也不删字段——导出文件的价值正在于
 * 它是服务端同一份投影。
 */

export const SESSION_EXPORT_FORMAT = "relay-session-export";

export interface RelaySessionExport {
  readonly schemaVersion: string;
  readonly sessionId: string;
  readonly title: string;
  /** 服务端写下的导出时刻：文件名上的那一天取它，界面上「截至什么时候」与文件名才是同一个时刻。 */
  readonly exportedAt: Date;
  readonly messageCount: number;
  /** 服务端在 `completeness` 里自己声明的「本文件是部分导出」，界面必须把这句话摆出来。 */
  readonly partial: boolean;
  /** 落盘用的完整正文：与 `partial` 同源，都是服务端文档本身。 */
  readonly text: string;
}

function partialOf(completeness: unknown): boolean {
  if (!isRecord(completeness)) return false;
  return Object.values(completeness).some((report) => isRecord(report) && report.truncated === true);
}

export function sessionExportDocument(sessionId: string, body: unknown): RelaySessionExport {
  if (!isRecord(body)) throw new RelayContractError("会话导出响应不是对象");
  if (body.format !== SESSION_EXPORT_FORMAT) {
    throw new RelayContractError("响应不是 Relay 会话导出文档（format 不匹配）。");
  }
  const version = body.schema_version;
  if (typeof version !== "string" || version === "") {
    throw new RelayContractError("会话导出文档缺少 schema_version。");
  }
  const session = isRecord(body.session) ? body.session : {};
  if (session.id !== sessionId) {
    throw new RelayContractError("会话导出文档里的会话与请求的会话不是同一条。");
  }
  if (!Array.isArray(body.messages)) throw new RelayContractError("会话导出文档缺少消息段落。");
  const exportedAt = new Date(typeof body.exported_at === "string" ? body.exported_at : Number.NaN);
  if (Number.isNaN(exportedAt.getTime())) {
    throw new RelayContractError("会话导出文档缺少可读的导出时刻。");
  }
  return {
    schemaVersion: version,
    sessionId,
    title: typeof session.title === "string" ? session.title : "",
    exportedAt,
    messageCount: body.messages.length,
    partial: partialOf(body.completeness),
    text: `${JSON.stringify(body, null, 2)}\n`
  };
}

export async function exportAssistSessionDocument(http: RelayHttp,
  sessionId: string): Promise<RelaySessionExport> {
  try {
    const body = await http.request(http.workspacePath(`/assist-sessions/${sessionId}/export`));
    return sessionExportDocument(sessionId, body);
  } catch (caught) {
    throw await exportReadError(caught);
  }
}

/**
 * 读取失败的定位：404 有两种含义，都说成「导出失败」会让人以为会话内容出了问题。
 *
 * 与待办读取同一处口径：这个 URL 没有匹配到已注册路由时，Fastify 给的是不带 Relay code 的
 * 404（客户端只能看到 `HTTP_ERROR`）；会话在本 Workspace 不可见时给的是 `RESOURCE_NOT_FOUND`。
 * 前者既可能是服务端构建早于本路由，也可能是 API 基础地址或前缀不对——只有 404 这一个事实，
 * 分不清就不断言，把两种可能一并写进说明。
 */
async function exportReadError(caught: unknown): Promise<unknown> {
  if (!(caught instanceof RelayApiError) || caught.problem.status !== 404) return caught;
  if (caught.problem.code !== "HTTP_ERROR") return caught;
  return new RelayContractError("导出接口返回了未注册路由的 404：这个地址上没有 GET "
    + "/assist-sessions/:id/export。可能是桌面端连接的 API 构建早于该路由，也可能是 API 基础地址"
    + "或路径前缀不对；请核对桌面端配置的服务端版本与地址后重试。导出没有产生任何文件。");
}
