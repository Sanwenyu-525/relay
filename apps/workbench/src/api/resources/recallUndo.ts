import type { RelayAssistRecallUndo } from "../dtos/assist";
import { RelayContractError, RelayTransportError } from "../core/errors";
import type { RelayHttp } from "../core/http";
import { array, nullableString, object, string } from "../core/primitives";
import { commandEnvelopeFrom } from "../parse/projects";

function undoFrom(value: unknown, recallId: string): RelayAssistRecallUndo {
  const row = object(value, "recall undo");
  const status = string(row, "status", "recall undo");
  if ((status !== "RUNNING" && status !== "COMPLETED" && status !== "PARTIAL" && status !== "FAILED")
    || string(row, "source_recall_id", "recall undo") !== recallId) {
    throw new RelayContractError("文件回退的撤销回执无法对应，请重新核对。");
  }
  return { id: string(row, "id", "recall undo"), sourceRecallId: recallId,
    status, rootPath: string(row, "root_path", "recall undo"),
    files: array(row, "files", "recall undo").map((value) => {
      const file = object(value, "recall undo file");
      return { path: string(file, "path", "recall undo file"), status: string(file, "status", "recall undo file"),
        reason: nullableString(file, "reason", "recall undo file") };
    }) };
}

export async function getAssistRecallUndo(http: RelayHttp, recallId: string): Promise<RelayAssistRecallUndo> {
  return undoFrom(await http.request(http.workspacePath(
    `/assist-message-recalls/${encodeURIComponent(recallId)}/undo`)), recallId);
}

export async function undoAssistRecall(http: RelayHttp, recallId: string, commandId: string): Promise<RelayAssistRecallUndo> {
  const body = await http.request(http.workspacePath(
    `/assist-message-recalls/${encodeURIComponent(recallId)}/undo`), {
    method: "POST", body: JSON.stringify({ command_id: commandId }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== commandId) throw new Error("command mismatch");
    return undoFrom(envelope.result, recallId);
  } catch { throw new RelayTransportError("文件回退的撤销回执无法核对，请按原命令查询。"); }
}
