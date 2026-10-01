// 只读视觉夹具服务。仅绑定 loopback，不连数据库、不调用 Provider、拒绝业务写入。
import { createServer } from "node:http";
import { bodies, docBody, artifacts, prefix, otherTaskId, thirdTaskId } from "./collab-visual-fixtures.mjs";
import { pageBodies, todayBody, searchBody } from "./visual-page-fixtures.mjs";

const port = Number(process.argv[2] ?? 8794);
const pages = process.argv.includes("--pages") ? pageBodies() : bodies;
createServer((request, response) => {
  if (request.headers.origin === "http://127.0.0.1:4174" || request.headers.origin === "http://127.0.0.1:4175") {
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
  }
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.method !== "GET") {
    response.writeHead(405).end(JSON.stringify({ code: "VISUAL_FIXTURE_READ_ONLY", message: "视觉夹具不执行业务命令。" })); return;
  }
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;
  if (process.argv.includes("--pages") && /\/runs\/[^/]+\/events$/u.test(path)) {
    response.setHeader("Content-Type", "text/event-stream");
    response.writeHead(200); response.write(": read-only visual fixture\n\n");
    const heartbeat = setInterval(() => response.write(": visual fixture heartbeat\n\n"), 15000);
    response.on("close", () => clearInterval(heartbeat)); return;
  }
  let body = pages.get(path);
  if (process.argv.includes("--pages") && path === `${prefix}/today`) body = todayBody(url.searchParams);
  if (process.argv.includes("--pages") && path === `${prefix}/search`) body = searchBody(url.searchParams);
  if (process.argv.includes("--pages") && path === `${prefix}/tasks` && url.searchParams.get("inbox") === "true") {
    body = pages.get(`${prefix}/visual-inbox`);
  }
  if (path === "/health/ready") body = { status: "ready" };
  if (path.endsWith("/content") && path.includes("/artifact-versions/")) {
    const versionId = path.split("/artifact-versions/")[1].split("/")[0];
    const collections = [...pages.entries()].filter(([entry, value]) => entry.endsWith("/artifacts") && Array.isArray(value.items));
    const allArtifacts = process.argv.includes("--pages") ? collections.flatMap(([, value]) => value.items) : artifacts.items;
    const version = allArtifacts.flatMap((artifact) => artifact.versions)
      .find((item) => item.artifact_version_id === versionId);
    if (!version) {
      response.writeHead(404).end(JSON.stringify({ code: "VISUAL_FIXTURE_MISSING", message: "该视觉夹具没有此产物版本。" })); return;
    }
    response.setHeader("Content-Type", "text/markdown; charset=utf-8");
    response.writeHead(200).end(version.version_number === "2" ? docBody
      : "# 评价方案初稿\n\n这是 v1 的视觉示例正文。指标口径尚待整理；此处不会以当前 v2 正文替换历史版本。\n"); return;
  }
  if (body === undefined && path.startsWith(`${prefix}/artifact-versions/`) &&
    !path.slice(`${prefix}/artifact-versions/`.length).includes("/")) body = artifacts.items[0];
  if (body === undefined && (path === `${prefix}/tasks/${otherTaskId}` || path === `${prefix}/tasks/${thirdTaskId}`)) {
    body = bodies.get(`${prefix}/tasks`).items.find((item) => path.endsWith(item.id));
  }
  if (path.endsWith("/artifacts") && body === undefined) body = { items: [], current_accepted_version_ids: [] };
  if (path.includes("/search") && body === undefined) body = { items: [], next_cursor: null };
  if (body === undefined) { response.writeHead(404).end(JSON.stringify({ code: "VISUAL_FIXTURE_MISSING", message: "该视觉夹具没有此读取。" })); return; }
  response.writeHead(200).end(JSON.stringify(body));
}).listen(port, "127.0.0.1", () => console.log(`只读视觉夹具：http://127.0.0.1:${port}（无数据库/Provider）`));
