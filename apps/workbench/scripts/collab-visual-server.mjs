// 只读视觉夹具服务。仅绑定 loopback，不连数据库、不调用 Provider、拒绝业务写入。
import { createServer } from "node:http";
import { bodies, docBody, artifacts, prefix, otherTaskId, thirdTaskId } from "./collab-visual-fixtures.mjs";
import { pageBodies, todayBody } from "./visual-page-fixtures.mjs";

const port = Number(process.argv[2] ?? 8794);
const pages = process.argv.includes("--pages") ? pageBodies() : bodies;
createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:4174");
  response.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.method !== "GET") {
    response.writeHead(405).end(JSON.stringify({ code: "VISUAL_FIXTURE_READ_ONLY", message: "视觉夹具不执行业务命令。" })); return;
  }
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;
  let body = pages.get(path);
  if (process.argv.includes("--pages") && path === `${prefix}/today`) body = todayBody(url.searchParams);
  if (process.argv.includes("--pages") && path === `${prefix}/tasks` && url.searchParams.get("inbox") === "true") {
    body = { items: [], next_cursor: null };
  }
  if (path === "/health/ready") body = { status: "ready" };
  if (path.endsWith("/content") && path.includes("/artifact-versions/")) {
    response.setHeader("Content-Type", "text/markdown; charset=utf-8");
    response.writeHead(200).end(docBody); return;
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
