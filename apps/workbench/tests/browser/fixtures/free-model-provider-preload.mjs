// Test-only transport: a real loopback HTTP Provider behind the unchanged public
// endpoint guard. Never loaded by production code; never accepts real credentials.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

if (process.env.NODE_ENV !== "test" || process.env.RELAY_OPENROUTER_API_KEY !== "synthetic-free-model-browser") {
  throw new Error("free-model fixture requires its synthetic test environment");
}
const port = Number(process.env.RELAY_FREE_MODEL_FIXTURE_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("fixture port missing");
const counters = { directoryRequests: 0, accountRequests: 0, calls: [] };
const catalog = ["a", "b", "c"].map((id) => ({
  id: `fixture/${id}:free`, name: `Controlled free ${id.toUpperCase()}`, context_length: 131072,
  pricing: { prompt: "0", completion: "0" },
  supported_parameters: ["tools", "tool_choice", "response_format", "structured_outputs"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
}));
const server = createServer(async (request, response) => {
  const json = (body, status = 200, headers = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  };
  if (request.url === "/evidence" && request.method === "GET") return json(counters);
  if (request.url === "/api/v1/models") {
    counters.directoryRequests++;
    return json({ data: catalog, total_count: catalog.length, links: { next: null } });
  }
  if (request.url === "/api/v1/key") {
    counters.accountRequests++;
    return json({ data: { is_free_tier: true, free_model_daily_requests: { used: 1, limit: 50, remaining: 49 } } });
  }
  if (request.url !== "/api/v1/chat/completions" || request.method !== "POST") return json({ error: "fixture route missing" }, 404);
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 2 * 1024 * 1024) return json({ error: "fixture body bound" }, 413);
  }
  const body = JSON.parse(raw);
  counters.calls.push({ model: body.model, provider: body.provider, stream: body.stream,
    tools: (body.tools ?? []).map((tool) => tool.function?.name),
    hasPaidFallback: Object.hasOwn(body, "models") || Object.hasOwn(body, "plugins") });
  if (body.model === "fixture/a:free") return json({ error: { code: 429,
    message: "Controlled upstream rate limit", metadata: { error_type: "rate_limit_exceeded", provider_code: 429 } } }, 429, { "retry-after": "1" });
  if (body.model !== "fixture/b:free" && body.model !== "fixture/c:free") return json({ error: "unexpected model" }, 400);
  const id = `controlled-${randomUUID()}`;
  const content = JSON.stringify({ reply: "RELAY_CONTROLLED_OK", execution: null, maintenance: null });
  const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0 };
  if (!body.stream) return json({ id, object: "chat.completion", created: 1, model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage });
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
  response.end("data: [DONE]\n\n");
});
if (process.env.RELAY_FREE_MODEL_FIXTURE_CLIENT !== "true") {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
}

const realLookup = dns.lookup;
dns.lookup = async (hostname, options) => hostname === "openrouter.ai"
  ? options?.all ? [{ address: "8.8.8.8", family: 4 }] : { address: "8.8.8.8", family: 4 }
  : realLookup(hostname, options);
syncBuiltinESMExports();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.origin !== "https://openrouter.ai") return realFetch(input, init);
  // Do not forward Authorization even for this synthetic credential. Only final
  // model/body routing is observed by the local fixture, with no prompts logged.
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.delete("authorization");
  const result = await realFetch(`http://127.0.0.1:${port}${target.pathname}`, { ...init, headers });
  return new Response(result.body, { status: result.status, headers: result.headers });
};
