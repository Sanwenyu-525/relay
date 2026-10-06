import type { DecimalRevision } from "../../types";
import { RelayTransportError } from "../core/errors";
import { RelayHttp } from "../core/http";
import { array, boolean, decimal, nullableString, object, string, stringArray } from "../core/primitives";
import { artifactDirectUsesFrom, artifactFrom, artifactLineageFrom, artifactTextLockFrom, artifactVersionResultFrom, combinationCheckFrom, impactCandidateFrom, impactCandidateGroupFrom, impactCheckFrom } from "../parse/artifacts";
import { commandEnvelopeFrom, stateMutationFrom } from "../parse/projects";
import type { RelayArtifact, RelayArtifactDirectUses, RelayArtifactImpactCandidate, RelayArtifactImpactCheck, RelayArtifactLineage, RelayArtifactTextLock, RelayArtifactVersionResult, RelayClosePartialFileWriteInput, RelayCombinationCheck, RelayFileWriteChangeSet, RelayFileWriteDispositionPreview, RelayFileWriteFrozenDiff, RelayImpactCandidateGroup, RelayTaskArtifacts } from "../dtos/artifacts";
import type { RelayStateMutation } from "../dtos/projects";

export async function getFileWriteChangeSets(http: RelayHttp, operationId: string): Promise<readonly RelayFileWriteChangeSet[]> {
  const body = await http.request(http.workspacePath(`/operations/${encodeURIComponent(operationId)}/change-sets`));
  const row = object(body, "FILE_WRITE ledger response");
  if (string(row, "operation_id", "FILE_WRITE ledger response") !== operationId) throw new Error("逐文件账本与原动作不匹配。");
  return array(row, "change_sets", "FILE_WRITE ledger response").map((item) => {
    const ledger = object(item, "FILE_WRITE ledger");
    return { id: string(ledger, "id", "FILE_WRITE ledger"),
      invocationId: string(ledger, "invocation_id", "FILE_WRITE ledger"),
      status: string(ledger, "status", "FILE_WRITE ledger"),
      files: array(ledger, "files", "FILE_WRITE ledger").map((entry) => {
        const file = object(entry, "FILE_WRITE ledger file");
        return { relativePath: string(file, "relative_path", "FILE_WRITE ledger file"),
          action: string(file, "action", "FILE_WRITE ledger file"),
          status: string(file, "status", "FILE_WRITE ledger file"),
          error: nullableString(file, "error", "FILE_WRITE ledger file") };
      }) };
  });
}

export async function getFileWriteFrozenDiff(http: RelayHttp, operationId: string): Promise<RelayFileWriteFrozenDiff> {
  const row = object(await http.request(http.workspacePath(`/operations/${encodeURIComponent(operationId)}/file-write-diff`)),
    "FILE_WRITE frozen diff");
  if (string(row, "operation_id", "FILE_WRITE frozen diff") !== operationId ||
      string(row, "basis", "FILE_WRITE frozen diff") !== "FROZEN_INTENT") {
    throw new Error("冻结文本差异与原动作不匹配。");
  }
  return { operationId, basis: "FROZEN_INTENT",
    files: array(row, "files", "FILE_WRITE frozen diff").map((entry) => {
      const file = object(entry, "FILE_WRITE frozen diff file");
      const action = string(file, "action", "FILE_WRITE frozen diff file");
      const availability = string(file, "availability", "FILE_WRITE frozen diff file");
      if (!["CREATE", "MODIFY", "DELETE"].includes(action) ||
          !["AVAILABLE", "UNAVAILABLE"].includes(availability)) {
        throw new Error("冻结文本差异状态无效。");
      }
      const beforeText = nullableString(file, "before_text", "FILE_WRITE frozen diff file");
      const afterText = nullableString(file, "after_text", "FILE_WRITE frozen diff file");
      if (availability === "AVAILABLE" && (beforeText === null || afterText === null)) {
        throw new Error("可用的冻结文本差异缺少正文。");
      }
      return { relativePath: string(file, "relative_path", "FILE_WRITE frozen diff file"),
        action: action as "CREATE" | "MODIFY" | "DELETE",
        baselineSha256: nullableString(file, "baseline_sha256", "FILE_WRITE frozen diff file"),
        targetSha256: nullableString(file, "target_sha256", "FILE_WRITE frozen diff file"),
        availability: availability as "AVAILABLE" | "UNAVAILABLE",
        unavailableReason: nullableString(file, "unavailable_reason", "FILE_WRITE frozen diff file"),
        beforeText, afterText };
    }) };
}

export async function getFileWriteDispositionPreview(http: RelayHttp, operationId: string): Promise<RelayFileWriteDispositionPreview> {
  const row = object(await http.request(http.workspacePath(`/operations/${encodeURIComponent(operationId)}/file-write-disposition`)),
    "FILE_WRITE disposition");
  const parseMode = (value: unknown): "PARTIAL_LEDGER" | "NO_RECEIPT" | null => {
    if (value === null || value === undefined) return null;
    if (value !== "PARTIAL_LEDGER" && value !== "NO_RECEIPT") throw new Error("文件处置观察类型无效。");
    return value;
  };
  const parseCandidates = (file: Record<string, unknown>, mode: string | null) =>
    mode === "NO_RECEIPT" ? array(file, "residual_candidates", "FILE_WRITE residuals").map((item) => {
      const candidate = object(item, "FILE_WRITE residual candidate");
      return { path: string(candidate, "path", "FILE_WRITE residual candidate"),
        id: nullableString(candidate, "id", "FILE_WRITE residual candidate"),
        sha256: nullableString(candidate, "sha256", "FILE_WRITE residual candidate"),
        status: string(candidate, "status", "FILE_WRITE residual candidate"),
        error: nullableString(candidate, "error", "FILE_WRITE residual candidate") };
    }) : [];
  const dispositionValue = row.disposition;
  const disposition = dispositionValue === null ? null : (() => {
    const record = object(dispositionValue, "FILE_WRITE disposition decision");
    const observation = object(record.observation, "FILE_WRITE disposition observation");
    const observationMode = parseMode(observation.observation_mode);
    return { id: string(record, "id", "FILE_WRITE disposition decision"),
      decision: string(record, "decision", "FILE_WRITE disposition decision"),
      createdAt: string(record, "created_at", "FILE_WRITE disposition decision"),
      observationSha256: string(record, "observation_sha256", "FILE_WRITE disposition decision"),
      observationMode,
      observationFiles: array(observation, "files", "FILE_WRITE disposition observation").map((item) => {
        const file = object(item, "FILE_WRITE disposition observed file");
        return { path: string(file, "path", "FILE_WRITE disposition observed file"),
          currentSha256: nullableString(file, "current_sha256", "FILE_WRITE disposition observed file"),
          ledgerStatus: string(file, "ledger_status", "FILE_WRITE disposition observed file"),
          ledgerActualSha256: observationMode === "NO_RECEIPT" ? null
            : nullableString(file, "ledger_actual_sha256", "FILE_WRITE disposition observed file"),
          currentTargetId: observationMode === "NO_RECEIPT"
            ? nullableString(file, "current_target_id", "FILE_WRITE disposition observed file") : null,
          residualCandidates: parseCandidates(file, observationMode) };
      }) };
  })();
  const observationMode = parseMode(row.observation_mode);
  const preview: RelayFileWriteDispositionPreview = {
    operationId: string(row, "operation_id", "FILE_WRITE disposition"),
    invocationId: nullableString(row, "invocation_id", "FILE_WRITE disposition"),
    changeSetId: nullableString(row, "change_set_id", "FILE_WRITE disposition"),
    runId: string(row, "run_id", "FILE_WRITE disposition"),
    runRevision: decimal(row, "run_revision", "FILE_WRITE disposition"),
    taskRevision: decimal(row, "task_revision", "FILE_WRITE disposition"),
    operationStatus: string(row, "operation_status", "FILE_WRITE disposition"),
    stopProofRecorded: boolean(row, "stop_proof_recorded", "FILE_WRITE disposition"),
    canDispose: boolean(row, "can_dispose", "FILE_WRITE disposition"),
    blockingReasons: array(row, "blocking_reasons", "FILE_WRITE disposition").map((reason) => {
      if (typeof reason !== "string") throw new Error("阻断原因响应格式无效。");
      return reason;
    }),
    observationSha256: nullableString(row, "observation_sha256", "FILE_WRITE disposition"),
    observationMode,
    files: array(row, "files", "FILE_WRITE disposition").map((entry) => {
      const file = object(entry, "FILE_WRITE current file");
      return { relativePath: string(file, "relative_path", "FILE_WRITE current file"),
        ledgerStatus: string(file, "ledger_status", "FILE_WRITE current file"),
        ledgerActualSha256: nullableString(file, "ledger_actual_sha256", "FILE_WRITE current file"),
        currentSha256: nullableString(file, "current_sha256", "FILE_WRITE current file"),
        readable: boolean(file, "readable", "FILE_WRITE current file"),
        currentTargetId: observationMode === "NO_RECEIPT"
          ? nullableString(file, "current_target_id", "FILE_WRITE current file") : null,
        residualCandidates: parseCandidates(file, observationMode) };
    }), disposition
  };
  if (preview.operationId !== operationId) throw new Error("处置预览与原动作不匹配。");
  return preview;
}

export async function closePartialFileWrite(http: RelayHttp, input: RelayClosePartialFileWriteInput): Promise<void> {
  const body = await http.request(http.workspacePath(`/operations/${encodeURIComponent(input.operationId)}/file-write-disposition`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, invocation_id: input.invocationId,
      decision: "KEEP_CURRENT_AND_FAIL_RUN", expected_run_revision: input.expectedRunRevision,
      expected_task_revision: input.expectedTaskRevision,
      expected_observation_sha256: input.expectedObservationSha256 })
  }, 200);
  try {
    const receipt = commandEnvelopeFrom(body);
    if (receipt.commandId !== input.commandId ||
        string(receipt.result, "operation_id", "FILE_WRITE disposition result") !== input.operationId ||
        string(receipt.result, "invocation_id", "FILE_WRITE disposition result") !== input.invocationId ||
        string(receipt.result, "run_id", "FILE_WRITE disposition result") !== input.runId ||
        string(receipt.result, "run_status", "FILE_WRITE disposition result") !== "FAILED" ||
        string(receipt.result, "decision", "FILE_WRITE disposition result") !== "KEEP_CURRENT_AND_FAIL_RUN") {
      throw new Error("处置回执与原动作不匹配。");
    }
  } catch { throw new RelayTransportError("处置回执无法核对，请查询原 command_id。"); }
}

export async function createArtifactWithVersion(http: RelayHttp, input: { readonly taskId: string; readonly commandId: string; readonly expectedTaskRevision: DecimalRevision; readonly title: string; readonly mediaType: string; readonly content: string; }): Promise<RelayArtifactVersionResult> {
  const body = await http.request(http.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/artifacts`), {
    method: "POST",
    body: JSON.stringify({
      command_id: input.commandId,
      expected_task_revision: input.expectedTaskRevision,
      title: input.title,
      media_type: input.mediaType,
      content: input.content
    })
  });
  return artifactVersionResultFrom(commandEnvelopeFrom(body).result);
}

export async function submitArtifactVersion(http: RelayHttp, input: { readonly artifactId: string; readonly commandId: string; readonly expectedArtifactRevision: DecimalRevision; readonly expectedTaskRevision: DecimalRevision; readonly mediaType: string; readonly content: string; }): Promise<RelayArtifactVersionResult> {
  const body = await http.request(
    http.workspacePath(`/artifacts/${encodeURIComponent(input.artifactId)}/versions`),
    {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_artifact_revision: input.expectedArtifactRevision,
        expected_task_revision: input.expectedTaskRevision,
        media_type: input.mediaType,
        content: input.content
      })
    }
  );
  return artifactVersionResultFrom(commandEnvelopeFrom(body).result);
}

export async function getArtifact(http: RelayHttp, artifactId: string): Promise<RelayArtifact> {
  return artifactFrom(await http.request(http.workspacePath(`/artifacts/${encodeURIComponent(artifactId)}`)));
}

export async function getTaskArtifacts(http: RelayHttp, taskId: string): Promise<RelayTaskArtifacts> {
  const record = object(await http.request(http.workspacePath(`/tasks/${encodeURIComponent(taskId)}/artifacts`)), "task artifacts");
  return {
    items: array(record, "items", "task artifacts").map(artifactFrom),
    currentAcceptedVersionIds: stringArray(record, "current_accepted_version_ids", "task artifacts")
  };
}

/** 正文接口返回 text/markdown 本身而不是 JSON，因此单独走文本读取。 */
export async function getArtifactVersionContent(http: RelayHttp, artifactVersionId: string): Promise<string> {
  return http.requestText(
    http.workspacePath(`/artifact-versions/${encodeURIComponent(artifactVersionId)}/content`)
  );
}

export async function getArtifactLineage(http: RelayHttp, artifactVersionId: string): Promise<RelayArtifactLineage> {
  return artifactLineageFrom(await http.request(http.workspacePath(`/artifact-versions/${encodeURIComponent(artifactVersionId)}/lineage`)));
}

export async function getArtifactDirectUses(http: RelayHttp, artifactVersionId: string): Promise<RelayArtifactDirectUses> {
  return artifactDirectUsesFrom(await http.request(http.workspacePath(`/artifact-versions/${encodeURIComponent(artifactVersionId)}/direct-uses`)));
}

export async function getArtifactTextLocks(http: RelayHttp, artifactId: string): Promise<readonly RelayArtifactTextLock[]> {
  const row = object(await http.request(http.workspacePath(`/artifacts/${encodeURIComponent(artifactId)}/text-locks`)), "artifact text locks");
  if (string(row, "artifact_id", "artifact text locks") !== artifactId) throw new Error("锁定列表目标不匹配。");
  return array(row, "locks", "artifact text locks").map(artifactTextLockFrom);
}

export async function lockArtifactText(http: RelayHttp, input: { readonly artifactId: string; readonly commandId: string; readonly expectedArtifactRevision: DecimalRevision; readonly expectedVersionId: string; readonly blockKind: "PARAGRAPH" | "SECTION"; readonly blockIndex: number }): Promise<{ readonly artifactRevision: DecimalRevision; readonly lock: RelayArtifactTextLock }> {
  const row = object(commandEnvelopeFrom(await http.request(http.workspacePath(`/artifacts/${encodeURIComponent(input.artifactId)}/text-locks`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      expected_artifact_revision: input.expectedArtifactRevision,
      expected_version_id: input.expectedVersionId, block_kind: input.blockKind,
      block_index: input.blockIndex }) })).result, "lock artifact text");
  if (string(row, "artifact_id", "lock artifact text") !== input.artifactId) throw new Error("锁定回执目标不匹配。");
  return { artifactRevision: decimal(row, "artifact_revision", "lock artifact text"),
    lock: artifactTextLockFrom(row.lock) };
}

export async function unlockArtifactText(http: RelayHttp, input: { readonly artifactId: string; readonly lockId: string; readonly commandId: string; readonly expectedArtifactRevision: DecimalRevision }): Promise<DecimalRevision> {
  const row = object(commandEnvelopeFrom(await http.request(http.workspacePath(`/artifacts/${encodeURIComponent(input.artifactId)}/text-locks/${encodeURIComponent(input.lockId)}/unlock`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      expected_artifact_revision: input.expectedArtifactRevision }) })).result, "unlock artifact text");
  if (string(row, "artifact_id", "unlock artifact text") !== input.artifactId ||
      string(row, "unlocked_lock_id", "unlock artifact text") !== input.lockId)
    throw new Error("解锁回执目标不匹配。");
  return decimal(row, "artifact_revision", "unlock artifact text");
}

export async function startArtifactImpactCheck(http: RelayHttp, input: { readonly beforeVersionId: string; readonly afterVersionId: string; readonly expectedArtifactRevision: DecimalRevision; readonly analysisTargetVersionIds: readonly string[]; readonly commandId: string }): Promise<string> {
  const row = object(commandEnvelopeFrom(await http.request(http.workspacePath(`/artifact-versions/${encodeURIComponent(input.beforeVersionId)}/impact-checks`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      source_after_version_id: input.afterVersionId,
      expected_artifact_revision: input.expectedArtifactRevision,
      analysis_target_version_ids: input.analysisTargetVersionIds }) })).result, "impact check request");
  return string(row, "impact_check_id", "impact check request");
}

export async function getArtifactImpactCheck(http: RelayHttp, id: string): Promise<RelayArtifactImpactCheck> {
  return impactCheckFrom(await http.request(http.workspacePath(`/impact-checks/${encodeURIComponent(id)}`)));
}

export async function startArtifactImpactCandidate(http: RelayHttp, input: { readonly checkId: string; readonly targetVersionId: string; readonly expectedTargetRevision: DecimalRevision; readonly confirmedPossible: boolean; readonly commandId: string }): Promise<string> {
  const row = object(commandEnvelopeFrom(await http.request(http.workspacePath(`/impact-checks/${encodeURIComponent(input.checkId)}/candidates`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      target_version_id: input.targetVersionId,
      expected_target_revision: input.expectedTargetRevision,
      confirmed_possible: input.confirmedPossible }) })).result, "impact candidate request");
  return string(row, "candidate_id", "impact candidate request");
}

export async function getArtifactImpactCandidate(http: RelayHttp, id: string): Promise<RelayArtifactImpactCandidate> {
  return impactCandidateFrom(await http.request(http.workspacePath(`/impact-candidates/${encodeURIComponent(id)}`)));
}

/** N02：组只关联已登记目标，不调用模型；响应不明按原 command_id 核对。 */
export async function createImpactCandidateGroup(http: RelayHttp, input: { readonly checkId: string; readonly targetVersionIds: readonly string[]; readonly commandId: string }): Promise<string> {
  const row = object(commandEnvelopeFrom(await http.request(http.workspacePath(`/impact-checks/${encodeURIComponent(input.checkId)}/candidate-groups`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      target_version_ids: input.targetVersionIds }) })).result, "impact group request");
  return string(row, "group_id", "impact group request");
}

export async function getImpactCandidateGroup(http: RelayHttp, id: string): Promise<RelayImpactCandidateGroup> {
  return impactCandidateGroupFrom(await http.request(http.workspacePath(`/impact-candidate-groups/${encodeURIComponent(id)}`)));
}

export async function createCombinationCheck(http: RelayHttp, input: { readonly groupId: string; readonly artifactVersionIds: readonly string[]; readonly commandId: string }): Promise<string> {
  const row = object(commandEnvelopeFrom(await http.request(http.workspacePath(`/impact-candidate-groups/${encodeURIComponent(input.groupId)}/combination-checks`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      artifact_version_ids: input.artifactVersionIds }) })).result, "combination check request");
  return string(row, "combination_check_id", "combination check request");
}

export async function getCombinationCheck(http: RelayHttp, id: string): Promise<RelayCombinationCheck> {
  return combinationCheckFrom(await http.request(http.workspacePath(`/combination-checks/${encodeURIComponent(id)}`)));
}

export async function applyArtifactImpactCandidate(http: RelayHttp, input: { readonly candidateId: string; readonly expectedTargetRevision: DecimalRevision; readonly commandId: string }): Promise<string> {
  const row = object(commandEnvelopeFrom(await http.request(http.workspacePath(`/impact-candidates/${encodeURIComponent(input.candidateId)}/apply`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      expected_target_revision: input.expectedTargetRevision }) })).result, "apply impact candidate");
  return string(row, "version_id", "apply impact candidate");
}

/**
   * “选择要接受的版本”是 Project State 的类型化命令，不是 Task 字段。
   * 该 action 要求 source_ref（选择依据的来源引用），不能省略：服务端按 REQUIRED_INPUT_MISSING 拒绝。
   */
export async function selectArtifactVersion(http: RelayHttp, input: { readonly projectId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly artifactVersionId: string; readonly sourceRef: string; }): Promise<RelayStateMutation> {
  const body = await http.request(
    http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/state-commands`),
    {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_revision: input.expectedRevision,
        action: "SELECT_ARTIFACT_VERSION",
        artifact_version_id: input.artifactVersionId,
        source_ref: input.sourceRef
      })
    }
  );
  return stateMutationFrom(commandEnvelopeFrom(body).result);
}
