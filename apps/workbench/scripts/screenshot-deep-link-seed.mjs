// Seed Run + completion + artifact lineage for UI screenshot deep links.
// Usage: node apps/workbench/scripts/screenshot-deep-link-seed.mjs [baseUrl] [workspaceId] [projectId]
// Local relay_dev only. Does not touch production.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const envText = readFileSync(join(repoRoot, "apps/api/.env"), "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));

const base = process.argv[2] ?? `http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}`;
const workspaceId = process.argv[3] ?? "b34f1735-63f4-4962-a2ea-dc340439b608";
const projectId = process.argv[4] ?? "b7b7a62e-ef45-4247-8ce2-5372d9f703dd";
const layoutTaskId = "a3e57735-932b-4b96-85a9-1ea90bb884f9"; // existing READY task for /agent?work=

const root = `${base}/api/v1/workspaces/${workspaceId}`;
const headers = { "content-type": "application/json", authorization: `Bearer ${env.RELAY_API_BEARER_TOKEN}` };

async function call(path, body, method = "POST", expectOk = true) {
  const response = await fetch(`${root}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  if (expectOk && response.status >= 300) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  return { status: response.status, json, text };
}
const command = (extra = {}) => ({ command_id: randomUUID(), ...extra });

const out = { workspaceId, projectId, layoutTaskId, base };

// --- Task for AI Run (delegate) ---
{
  const created = await call("/tasks", command({
    project_id: projectId,
    title: "截图种子：委托 Run（勿人工改）",
    objective: "为 UI 截图生成一条可深链的 Run 记录。",
    mode: "ME",
    criteria: [{ statement: "Run 已创建且可从任务详情打开。", required: true, method: "HUMAN" }],
  }));
  const taskId = created.json.result.task_id;
  let revision = created.json.result.revision;
  const ready = await call(`/tasks/${taskId}/ready`, command({ expected_revision: revision }));
  revision = ready.json.result.revision;
  const delegated = await call(`/tasks/${taskId}/delegations`, command({
    expected_task_revision: revision,
  }));
  out.runTaskId = taskId;
  out.runId = delegated.json.result.run_id;
  out.delegateCommandId = delegated.json.command_id ?? delegated.json.result?.command_id;
  out.delegateStatus = delegated.status;
  out.delegateResult = delegated.json.result;
}

// --- Task for completion + lineage ---
{
  const created = await call("/tasks", command({
    project_id: projectId,
    title: "截图种子：完成与产物血缘（勿人工改）",
    objective: "为 UI 截图生成完成凭据与产物版本血缘。",
    mode: "ME",
    criteria: [
      { criterion_id: "shot-c1", statement: "产物 v2 已保存且血缘可读。", required: true, method: "HUMAN" },
      { criterion_id: "shot-c2", statement: "人工完成凭据已写入。", required: true, method: "HUMAN" },
    ],
  }));
  const taskId = created.json.result.task_id;
  let revision = created.json.result.revision;
  const ready = await call(`/tasks/${taskId}/ready`, command({ expected_revision: revision }));
  revision = ready.json.result.revision;
  const started = await call(`/tasks/${taskId}/start`, command({ expected_revision: revision }));
  revision = started.json.result.revision;

  const detail = await call(`/tasks/${taskId}`, null, "GET");
  const acceptanceRevision = detail.json.acceptance_revision ?? detail.json.acceptance?.acceptance_revision;

  const art1 = await call(`/tasks/${taskId}/artifacts`, command({
    expected_task_revision: revision,
    title: "截图种子产物.md",
    media_type: "text/markdown",
    content: "# 截图种子 v1\n\n第一版正文，用于血缘父节点。\n",
  }));
  const artifactId = art1.json.result.artifact_id;
  const version1Id = art1.json.result.version_id;
  revision = art1.json.result.task_revision ?? art1.json.result.revision ?? revision;
  const artifactRevision = art1.json.result.artifact_revision ?? art1.json.result.revision ?? "1";

  // refresh task revision from GET if needed
  const detail2 = await call(`/tasks/${taskId}`, null, "GET");
  revision = detail2.json.revision;
  const artMeta = await call(`/artifacts/${artifactId}`, null, "GET");
  const expectedArtifactRevision = artMeta.json.revision;

  const art2 = await call(`/artifacts/${artifactId}/versions`, command({
    expected_artifact_revision: expectedArtifactRevision,
    expected_task_revision: revision,
    media_type: "text/markdown",
    content: "# 截图种子 v2\n\n第二版正文，REVISED_FROM v1，供血缘页截图。\n",
  }));
  const version2Id = art2.json.result.version_id;

  const detail3 = await call(`/tasks/${taskId}`, null, "GET");
  revision = detail3.json.revision;
  const accRev = detail3.json.acceptance_revision ?? detail3.json.acceptance?.acceptance_revision ?? acceptanceRevision;
  const criteria = (detail3.json.acceptance?.criteria ?? []).map((c) => c.criterion_id);

  const completed = await call(`/tasks/${taskId}/complete`, command({
    expected_revision: revision,
    acceptance_revision: accRev,
    artifact_version_ids: [version2Id],
    acceptance: {
      statement: "截图种子：人工核对产物 v2 与两项验收条件均已满足。",
      accepted_criterion_ids: criteria,
      reason: "UI screenshot seed",
    },
  }));

  out.completionTaskId = taskId;
  out.artifactId = artifactId;
  out.artifactVersionIdV1 = version1Id;
  out.artifactVersionId = version2Id; // deep-link this
  out.completionId = completed.json.result.completion_id;
  out.completeResult = completed.json.result;

  // verify lineage readable
  const lineage = await call(`/artifact-versions/${version2Id}/lineage`, null, "GET");
  out.lineageStatus = lineage.status;
  out.lineageSummary = {
    edges: Array.isArray(lineage.json?.edges) ? lineage.json.edges.length : Object.keys(lineage.json ?? {}).length,
    keys: lineage.json ? Object.keys(lineage.json) : [],
  };
}

const outPath = join(repoRoot, "ui-screenshots-2026-10-11", "_deep-link-seed-ids.json");
writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
console.log(JSON.stringify(out, null, 2));
console.log(`wrote ${outPath}`);
