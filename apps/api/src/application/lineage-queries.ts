import { createHash } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ArtifactLineageEdgeRow, ArtifactVersionRow, KnowledgeVersionRow } from '../infrastructure/database-schema.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { readArtifactVersionInWorkspace } from './guards.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

export interface LineageEdgeDto {
  readonly id: string;
  readonly relation: ArtifactLineageEdgeRow['relation'];
  readonly parent_kind: ArtifactLineageEdgeRow['parent_kind'];
  readonly parent_id: string | null;
  readonly availability: 'AVAILABLE' | 'UNAVAILABLE';
  readonly created_at: string;
}

export interface ArtifactLineageDto {
  readonly artifact_version_id: string;
  readonly artifact_id: string;
  readonly version_number: string;
  readonly sha256: string;
  readonly source_kind: ArtifactVersionRow['source_kind'];
  readonly content_availability: 'AVAILABLE' | 'UNAVAILABLE';
  readonly direct_parents: readonly LineageEdgeDto[];
}

export async function readArtifactLineage(db: DbExecutor, storage: ManagedContentStore,
  workspaceId: string, versionId: string): Promise<ArtifactLineageDto> {
  return db.transaction().setIsolationLevel('repeatable read').execute(async (snapshot) => {
    const r = createRepositories(snapshot);
    const { version, artifact } = await readArtifactVersionInWorkspace(r, workspaceId, versionId);
    const edges = await r.lineage.listByChild(version.id);
    const availability = await storage.readWithHashCheck(version.storage_ref,
      { contentHash: version.content_hash, size: version.size });
    return { artifact_version_id: version.id, artifact_id: artifact.id,
      version_number: version.version_number.toString(),
      sha256: version.content_hash.toString('hex'), source_kind: version.source_kind,
      content_availability: availability.status === 'OK' ? 'AVAILABLE' : 'UNAVAILABLE',
      direct_parents: await Promise.all(edges.map((edge) => edgeDto(r, storage, workspaceId,
        artifact.project_id, edge))) };
  });
}

async function edgeDto(r: Repositories, storage: ManagedContentStore, workspaceId: string,
  projectId: string | null, edge: ArtifactLineageEdgeRow): Promise<LineageEdgeDto> {
  const visible = await parentVisible(r, storage, workspaceId, projectId, edge);
  return { id: edge.id, relation: edge.relation, parent_kind: edge.parent_kind,
    parent_id: visible ? edge.parent_id : null,
    availability: visible ? 'AVAILABLE' : 'UNAVAILABLE',
    created_at: edge.created_at.toISOString() };
}

async function parentVisible(r: Repositories, storage: ManagedContentStore,
  workspaceId: string, projectId: string | null,
  edge: ArtifactLineageEdgeRow): Promise<boolean> {
  if (edge.parent_kind === 'ARTIFACT_VERSION') {
    const parent = await r.artifacts.readArtifactVersion(edge.parent_id);
    const owner = parent === undefined ? undefined : await r.artifacts.readArtifact(parent.artifact_id);
    if (parent === undefined || owner?.workspace_id !== workspaceId) return false;
    const content = await storage.readWithHashCheck(parent.storage_ref,
      { contentHash: parent.content_hash, size: parent.size });
    return content.status === 'OK';
  }
  if (edge.parent_kind === 'KNOWLEDGE_VERSION') {
    const version = await r.information.readKnowledgeVersionById(edge.parent_id);
    const root = version === undefined ? undefined : await r.information.readRoot('knowledge', version.knowledge_id);
    if (root?.workspace_id !== workspaceId || root.status !== 'ACTIVE' ||
        root.project_id !== null && root.project_id !== projectId ||
        version?.availability !== 'AVAILABLE') return false;
    if (version.source_kind !== 'ARTIFACT_VERSION') return version.content_text !== null &&
      version.content_sha256.equals(createHash('sha256').update(version.content_text).digest());
    const artifact = version.artifact_version_id === null ? undefined :
      await r.artifacts.readArtifactVersion(version.artifact_version_id);
    const owner = artifact === undefined ? undefined : await r.artifacts.readArtifact(artifact.artifact_id);
    if (artifact === undefined || owner?.workspace_id !== workspaceId ||
        !artifact.content_hash.equals(version.content_sha256)) return false;
    const content = await storage.readWithHashCheck(artifact.storage_ref,
      { contentHash: artifact.content_hash, size: artifact.size });
    return content.status === 'OK';
  }
  if (edge.parent_kind === 'RUN_STEP') {
    const step = await r.runs.readStep(edge.parent_id);
    const run = step === undefined ? undefined : await r.runs.readRun(step.run_id);
    return run?.workspace_id === workspaceId;
  }
  if (edge.parent_kind === 'VERIFICATION_SESSION') {
    const session = await r.verifications.readSession(edge.parent_id);
    const task = session === undefined ? undefined : await r.tasks.readTask(session.task_id);
    return task?.workspace_id === workspaceId;
  }
  const completion = await r.completions.readCompletionRecord(edge.parent_id);
  const task = completion === undefined ? undefined : await r.tasks.readTask(completion.task_id);
  return task?.workspace_id === workspaceId;
}
