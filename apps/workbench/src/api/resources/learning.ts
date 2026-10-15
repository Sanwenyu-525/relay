import { RelayHttp } from "../core/http";
import { RelayTransportError } from "../core/errors";
import { array, boolean, decimal, integer, nullableString, object, string } from "../core/primitives";
import { commandEnvelopeFrom } from "../parse/projects";

export interface RelayLearningEvidence {
  evidenceId: string; kind: string; scenario: string; detail: string; disposition: string;
  sourceKind: string; sourceMessageId: string | null; sessionId: string | null; observedAt: string;
}
export interface RelayLearningConcept {
  conceptId: string; topic: string; displayName: string; generation: string; revision: string;
  evidence: readonly RelayLearningEvidence[];
}
export interface RelayLearningRecords {
  epoch: string; clearedAt: string | null; concepts: readonly RelayLearningConcept[];
}
export interface RelayLearningState {
  sessionId: string; recordsEnabled: boolean; revision: string;
  rounds: readonly { messageId: string; status: string; rejectionReason: string | null; recordEnabled: boolean }[];
}
export interface RelayLearningContinuation {
  sessionId: string; goal: string; lastObservedAt: string | null;
  openItems: readonly { conceptId: string; displayName: string; detail: string; scenario: string }[];
}
export type RelayLearningCommand = { commandId: string } & (
  { kind: "correct"; sessionId: string; conceptId: string; scenario: string; detail: string } |
  { kind: "delete"; evidenceId: string; expectedGeneration: string } |
  { kind: "clear" } |
  { kind: "control"; sessionId: string; recordsEnabled: boolean; expectedRevision: string });

export function learningCommandType(action: RelayLearningCommand): string {
  return { correct: "CorrectLearningRecord", delete: "DeleteLearningEvidence",
    clear: "ClearLearningRecords", control: "SetLearningRecordControl" }[action.kind];
}

export async function getLearningRecords(http: RelayHttp): Promise<RelayLearningRecords> {
  const row = object(await http.request(http.workspacePath("/learning-records")), "learning records");
  return { epoch: decimal(row, "epoch", "learning records"), clearedAt: nullableString(row, "cleared_at", "learning records"),
    concepts: array(row, "concepts", "learning records").map((raw) => {
      const item = object(raw, "learning concept");
      return { conceptId: string(item, "concept_id", "learning concept"), topic: string(item, "topic", "learning concept"),
        displayName: string(item, "display_name", "learning concept"), generation: decimal(item, "generation", "learning concept"),
        revision: decimal(item, "revision", "learning concept"), evidence: array(item, "evidence", "learning concept").map((rawEvidence) => {
          const e = object(rawEvidence, "learning evidence");
          return { evidenceId: string(e, "evidence_id", "learning evidence"), kind: string(e, "kind", "learning evidence"),
            scenario: string(e, "scenario", "learning evidence"), detail: string(e, "detail", "learning evidence"),
            disposition: string(e, "disposition", "learning evidence"), sourceKind: string(e, "source_kind", "learning evidence"),
            sourceMessageId: nullableString(e, "source_message_id", "learning evidence"), sessionId: nullableString(e, "session_id", "learning evidence"),
            observedAt: string(e, "observed_at", "learning evidence") };
        }) };
    }) };
}

export async function getLearningState(http: RelayHttp, sessionId: string): Promise<RelayLearningState> {
  const row = object(await http.request(http.workspacePath(`/learning-sessions/${encodeURIComponent(sessionId)}/state`)), "learning state");
  if (string(row, "session_id", "learning state") !== sessionId) throw new RelayTransportError("学习状态与当前会话不匹配。");
  return { sessionId, recordsEnabled: boolean(row, "records_enabled", "learning state"), revision: decimal(row, "revision", "learning state"),
    rounds: array(row, "rounds", "learning state").map((raw) => {
      const item = object(raw, "learning round");
      const status = string(item, "status", "learning round");
      if (!["PENDING", "SETTLED", "REJECTED", "CANCELLED"].includes(status)) throw new RelayTransportError("学习轮次状态无法核对。");
      return { messageId: string(item, "message_id", "learning round"), status,
        rejectionReason: nullableString(item, "rejection_reason", "learning round"), recordEnabled: boolean(item, "record_enabled", "learning round") };
    }) };
}

export async function getLearningContinuation(http: RelayHttp, sessionId: string): Promise<RelayLearningContinuation> {
  const row = object(await http.request(http.workspacePath(`/learning-sessions/${encodeURIComponent(sessionId)}/continuation`)), "learning continuation");
  if (string(row, "session_id", "learning continuation") !== sessionId) throw new RelayTransportError("学习接续与当前会话不匹配。");
  return { sessionId, goal: string(row, "goal", "learning continuation"), lastObservedAt: nullableString(row, "last_observed_at", "learning continuation"),
    openItems: array(row, "open_items", "learning continuation").map((raw) => {
      const item = object(raw, "learning open item");
      return { conceptId: string(item, "concept_id", "learning open item"), displayName: string(item, "display_name", "learning open item"),
        detail: string(item, "detail", "learning open item"), scenario: string(item, "scenario", "learning open item") };
    }) };
}

export function learningResultMatches(action: RelayLearningCommand, result: Record<string, unknown>): boolean {
  try {
    switch (action.kind) {
      case "correct": return string(result, "concept_id", "learning result") === action.conceptId &&
        string(result, "evidence_id", "learning result") !== "" && decimal(result, "generation", "learning result") !== "";
      case "delete": return boolean(result, "deleted", "learning result") &&
        string(result, "concept_id", "learning result") !== "" && decimal(result, "generation", "learning result") !== "";
      case "clear": return decimal(result, "epoch", "learning result") !== "" &&
        integer(result, "cleared_evidence", "learning result") >= 0 && integer(result, "cleared_concepts", "learning result") >= 0 &&
        integer(result, "cancelled_rounds", "learning result") >= 0;
      case "control": return string(result, "session_id", "learning result") === action.sessionId &&
        boolean(result, "records_enabled", "learning result") === action.recordsEnabled && decimal(result, "revision", "learning result") !== "";
    }
  } catch { return false; }
}

export async function submitLearningCommand(http: RelayHttp, action: RelayLearningCommand): Promise<void> {
  let path: string; let body: Record<string, unknown>;
  switch (action.kind) {
    case "correct": path = "/learning-records/corrections"; body = { session_id: action.sessionId,
      concept_id: action.conceptId, scenario: action.scenario, detail: action.detail }; break;
    case "delete": path = "/learning-records/deletions"; body = { evidence_id: action.evidenceId,
      expected_generation: action.expectedGeneration }; break;
    case "clear": path = "/learning-records/clearances"; body = {}; break;
    case "control": path = `/learning-sessions/${encodeURIComponent(action.sessionId)}/record-control`;
      body = { records_enabled: action.recordsEnabled, expected_revision: action.expectedRevision }; break;
  }
  const raw = await http.request(http.workspacePath(path), { method: "POST", body: JSON.stringify({ command_id: action.commandId, ...body }) });
  try {
    const envelope = commandEnvelopeFrom(raw);
    if (envelope.commandId !== action.commandId || !learningResultMatches(action, envelope.result)) throw new Error("command mismatch");
  } catch { throw new RelayTransportError("学习命令回执无法核对，请查询原命令。"); }
}
