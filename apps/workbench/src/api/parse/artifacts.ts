import { array, availability, boolean, decimal, integer, nullableString, object, string, stringArray } from "../core/primitives";
import type { RelayArtifact, RelayArtifactDirectUses, RelayArtifactImpactCandidate, RelayArtifactImpactCheck, RelayArtifactLineage, RelayArtifactTextLock, RelayArtifactVersionResult, RelayCombinationCheck, RelayImpactCandidateGroup, RelayLineageParentKind, RelayLineageRelation } from "../dtos/artifacts";

export function artifactVersionResultFrom(
  result: Readonly<Record<string, unknown>>
): RelayArtifactVersionResult {
  return {
    taskId: string(result, "task_id", "command result"),
    artifactId: string(result, "artifact_id", "command result"),
    artifactRevision: decimal(result, "artifact_revision", "command result"),
    versionId: string(result, "version_id", "command result"),
    versionNumber: decimal(result, "version_number", "command result"),
    mediaType: string(result, "media_type", "command result"),
    sha256: string(result, "sha256", "command result"),
    size: decimal(result, "size", "command result"),
    taskRevision: decimal(result, "task_revision", "command result")
  };
}

export function impactCheckFrom(value: unknown): RelayArtifactImpactCheck {
  const row = object(value, "impact check");
  const status = string(row, "status", "impact check");
  if (!["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(status))
    throw new Error("影响检查状态无效。");
  return { id: string(row, "id", "impact check"), artifactId: string(row, "artifact_id", "impact check"),
    sourceBeforeVersionId: string(row, "source_before_version_id", "impact check"),
    sourceAfterVersionId: string(row, "source_after_version_id", "impact check"),
    status: status as RelayArtifactImpactCheck["status"],
    errorCode: row.error_code === null ? null : string(row, "error_code", "impact check"),
    directTargets: array(row, "direct_targets", "impact check").map((value) => {
      const item = object(value, "direct target");
      const availability = string(item, "availability", "direct target");
      if (availability !== "AVAILABLE" && availability !== "UNAVAILABLE") throw new Error("直接引用可用性无效。");
      return { targetVersionId: string(item, "target_version_id", "direct target"),
        targetArtifactId: string(item, "target_artifact_id", "direct target"),
        relation: string(item, "relation", "direct target"),
        versionNumber: decimal(item, "version_number", "direct target"), availability,
        analysed: boolean(item, "analysed", "direct target") };
    }),
    possiblyRelated: array(row, "possibly_related", "impact check").map((value) => {
      const item = object(value, "possibly related");
      return { targetVersionId: string(item, "target_version_id", "possibly related"),
        reason: string(item, "reason", "possibly related") };
    }),
    hasMore: boolean(row, "has_more", "impact check"),
    inputTruncated: boolean(row, "input_truncated", "impact check"),
    unanalysedScope: stringArray(row, "unanalysed_scope", "impact check"),
    stale: boolean(row, "stale", "impact check") };
}

export function impactCandidateGroupFrom(value: unknown): RelayImpactCandidateGroup {
  const row = object(value, "impact candidate group");
  const summary = object(row.summary, "impact group summary");
  return { id: string(row, "id", "impact candidate group"),
    impactCheckId: string(row, "impact_check_id", "impact candidate group"),
    sourceArtifactId: string(row, "source_artifact_id", "impact candidate group"),
    sourceBeforeVersionId: string(row, "source_before_version_id", "impact candidate group"),
    sourceAfterVersionId: string(row, "source_after_version_id", "impact candidate group"),
    sourceArtifactRevision: decimal(row, "source_artifact_revision", "impact candidate group"),
    createdAt: string(row, "created_at", "impact candidate group"),
    stale: boolean(row, "stale", "impact candidate group"),
    items: array(row, "items", "impact candidate group").map((value) => {
      const item = object(value, "impact group item");
      return { ordinal: integer(item, "ordinal", "impact group item"),
        targetArtifactId: string(item, "target_artifact_id", "impact group item"),
        targetVersionId: string(item, "target_version_id", "impact group item"),
        relation: string(item, "relation", "impact group item"),
        speculative: boolean(item, "speculative", "impact group item"),
        availability: string(item, "availability", "impact group item"),
        analysed: boolean(item, "analysed", "impact group item"),
        targetArtifactRevision: decimal(item, "target_artifact_revision", "impact group item"),
        targetIsCurrentVersion: boolean(item, "target_is_current_version", "impact group item"),
        candidateId: item.candidate_id === null ? null
          : string(item, "candidate_id", "impact group item"),
        candidateStatus: item.candidate_status === null ? null
          : string(item, "candidate_status", "impact group item"),
        candidateErrorCode: item.candidate_error_code === null ? null
          : string(item, "candidate_error_code", "impact group item"),
        candidateStale: boolean(item, "candidate_stale", "impact group item"),
        appliedVersionId: item.applied_version_id === null ? null
          : string(item, "applied_version_id", "impact group item") };
    }),
    summary: { total: integer(summary, "total", "impact group summary"),
      applied: integer(summary, "applied", "impact group summary"),
      withCandidate: integer(summary, "with_candidate", "impact group summary"),
      withoutCandidate: integer(summary, "without_candidate", "impact group summary"),
      staleCandidates: integer(summary, "stale_candidates", "impact group summary"),
      unavailable: integer(summary, "unavailable", "impact group summary") },
    unanalysedScope: stringArray(row, "unanalysed_scope", "impact candidate group"),
    dependencies: (row.dependencies === undefined ? [] : array(row, "dependencies", "impact candidate group")).map(value => {
      const d = object(value, "impact dependency");
      return { targetVersionId: string(d, "target_version_id", "impact dependency"), dependsOnTargetVersionId: string(d, "depends_on_target_version_id", "impact dependency") };
    }),
    combinationCheckIds: array(row, "combination_check_ids", "impact candidate group")
      .map((value) => {
        if (typeof value !== "string") throw new Error("组合检查标识无效。");
        return value;
      }) };
}

export function combinationCheckFrom(value: unknown): RelayCombinationCheck {
  const row = object(value, "combination check");
  if (string(row, "overall_result", "combination check") !== "NONE")
    throw new Error("组合检查不应给出整体结论。");
  return { id: string(row, "id", "combination check"),
    groupId: string(row, "group_id", "combination check"),
    taskId: string(row, "task_id", "combination check"),
    acceptanceRevision: decimal(row, "acceptance_revision", "combination check"),
    createdAt: string(row, "created_at", "combination check"),
    overallResult: "NONE",
    overallNote: string(row, "overall_note", "combination check"),
    stale: boolean(row, "stale", "combination check"),
    gaps: stringArray(row, "gaps", "combination check"),
    items: array(row, "items", "combination check").map((value) => {
      const item = object(value, "combination check item");
      return { ordinal: integer(item, "ordinal", "combination check item"),
        artifactId: string(item, "artifact_id", "combination check item"),
        artifactVersionId: string(item, "artifact_version_id", "combination check item"),
        isCurrentVersion: boolean(item, "is_current_version", "combination check item"),
        readable: boolean(item, "readable", "combination check item"),
        verificationSessionId: item.verification_session_id === null ? null
          : string(item, "verification_session_id", "combination check item"),
        verificationStatus: item.verification_status === null ? null
          : string(item, "verification_status", "combination check item") };
    }) };
}

export function impactCandidateFrom(value: unknown): RelayArtifactImpactCandidate {
  const row = object(value, "impact candidate");
  const status = string(row, "status", "impact candidate");
  if (!["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(status))
    throw new Error("修改候选状态无效。");
  return { id: string(row, "id", "impact candidate"),
    impactCheckId: string(row, "impact_check_id", "impact candidate"),
    targetArtifactId: string(row, "target_artifact_id", "impact candidate"),
    targetVersionId: string(row, "target_version_id", "impact candidate"),
    status: status as RelayArtifactImpactCandidate["status"],
    errorCode: row.error_code === null ? null : string(row, "error_code", "impact candidate"),
    markdown: row.markdown === null ? null : string(row, "markdown", "impact candidate"),
    stale: boolean(row, "stale", "impact candidate"),
    appliedVersionId: row.applied_version_id === null ? null : string(row, "applied_version_id", "impact candidate") };
}

export function artifactTextLockFrom(value: unknown): RelayArtifactTextLock {
  const row = object(value, "artifact text lock");
  const kind = string(row, "block_kind", "artifact text lock");
  const status = string(row, "status", "artifact text lock");
  const index = row.block_index === null ? null : integer(row, "block_index", "artifact text lock");
  if ((kind !== "PARAGRAPH" && kind !== "SECTION") ||
      (status !== "MAPPED" && status !== "UNMAPPED") ||
      (status === "MAPPED" && index === null) || (status === "UNMAPPED" && index !== null))
    throw new Error("锁定块状态无效。");
  return { id: string(row, "id", "artifact text lock"),
    artifactId: string(row, "artifact_id", "artifact text lock"),
    baseVersionId: string(row, "base_version_id", "artifact text lock"),
    blockKind: kind, blockIndex: index, text: string(row, "text", "artifact text lock"),
    status };
}

export function artifactFrom(value: unknown): RelayArtifact {
  const record = object(value, "artifact");
  return {
    id: string(record, "id", "artifact"),
    taskId: string(record, "task_id", "artifact"),
    title: string(record, "title", "artifact"),
    revision: decimal(record, "revision", "artifact"),
    latestVersionId: nullableString(record, "latest_version_id", "artifact"),
    versionCount: integer(record, "version_count", "artifact"),
    versions: array(record, "versions", "artifact").map((item) => {
      const version = object(item, "artifact version");
      return {
        artifactVersionId: string(version, "artifact_version_id", "artifact version"),
        versionNumber: decimal(version, "version_number", "artifact version"),
        mediaType: string(version, "media_type", "artifact version"),
        sha256: string(version, "sha256", "artifact version"),
        size: decimal(version, "size", "artifact version"),
        sourceKind: string(version, "source_kind", "artifact version"),
        createdAt: string(version, "created_at", "artifact version")
      };
    })
  };
}

export function artifactDirectUsesFrom(value: unknown): RelayArtifactDirectUses {
  const row = object(value, "artifact direct uses");
  if (row.scope !== "RECORDED_DIRECT_ONLY" || row.complete !== false) {
    throw new Error("直接引用查询的分析范围无效。");
  }
  return {
    sourceArtifactVersionId: string(row, "source_artifact_version_id", "artifact direct uses"),
    sourceContentAvailability: availability(row, "source_content_availability", "artifact direct uses"),
    scope: "RECORDED_DIRECT_ONLY", complete: false,
    hasMore: boolean(row, "has_more", "artifact direct uses"),
    directUses: array(row, "direct_uses", "artifact direct uses").map((value) => {
      const use = object(value, "artifact direct use");
      const relation = string(use, "relation", "artifact direct use");
      if (relation !== "DERIVED_FROM" && relation !== "REVISED_FROM") {
        throw new Error("直接引用的关系类型无效。");
      }
      const state = availability(use, "availability", "artifact direct use");
      const childArtifactVersionId = nullableString(use, "child_artifact_version_id", "artifact direct use");
      const childArtifactId = nullableString(use, "child_artifact_id", "artifact direct use");
      const childVersionNumber = use.child_version_number === null ? null
        : decimal(use, "child_version_number", "artifact direct use");
      if (state === "AVAILABLE" ? !childArtifactVersionId || !childArtifactId || childVersionNumber === null
        : childArtifactVersionId !== null || childArtifactId !== null || childVersionNumber !== null) {
        throw new Error("直接引用的可用性与版本身份不一致。");
      }
      return { relation, childArtifactVersionId, childArtifactId, childVersionNumber,
        availability: state, createdAt: string(use, "created_at", "artifact direct use") };
    }),
  };
}

export function artifactLineageFrom(value: unknown): RelayArtifactLineage {
  const row = object(value, "artifact lineage");
  const relations: readonly RelayLineageRelation[] = ["DERIVED_FROM", "REVISED_FROM", "GENERATED_BY", "VERIFIED_BY", "ACCEPTED_BY"];
  const parentKinds: readonly RelayLineageParentKind[] = ["ARTIFACT_VERSION", "KNOWLEDGE_VERSION", "RUN_STEP", "VERIFICATION_SESSION", "COMPLETION_RECORD"];
  return { artifactVersionId: string(row, "artifact_version_id", "artifact lineage"),
    artifactId: string(row, "artifact_id", "artifact lineage"), versionNumber: decimal(row, "version_number", "artifact lineage"),
    sha256: string(row, "sha256", "artifact lineage"), sourceKind: string(row, "source_kind", "artifact lineage"),
    contentAvailability: availability(row, "content_availability", "artifact lineage"),
    directParents: array(row, "direct_parents", "artifact lineage").map((value) => {
      const edge = object(value, "lineage edge");
      const relation = string(edge, "relation", "lineage edge");
      const parentKind = string(edge, "parent_kind", "lineage edge");
      if (!relations.includes(relation as RelayLineageRelation) || !parentKinds.includes(parentKind as RelayLineageParentKind)) {
        throw new Error("lineage edge 的关系或父来源类型无效。");
      }
      return { id: string(edge, "id", "lineage edge"), relation: relation as RelayLineageRelation,
        parentKind: parentKind as RelayLineageParentKind, parentId: nullableString(edge, "parent_id", "lineage edge"),
        availability: availability(edge, "availability", "lineage edge"), createdAt: string(edge, "created_at", "lineage edge") };
    }) };
}
