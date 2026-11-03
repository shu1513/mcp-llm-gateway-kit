/**
 * Mock model provider with switchable behaviour, for tests and local demos:
 *   mode=ok      -> 200 with a completion + usage
 *   mode=429     -> 429 Too Many Requests (+ Retry-After: 1)
 *   mode=hang    -> accepts the request and never answers (until closed)
 *   mode=500     -> 500 with an ugly stack-trace-like body (must never leak)
 *   mode=garbage -> 200 with a non-JSON body
 */
import http from "node:http";

export type MockMode = "ok" | "429" | "hang" | "500" | "garbage";

export interface MockProvider {
  server: http.Server;
  calls: number;
  mode: MockMode;
  name: string;
}

export function createMockProvider(name: string, mode: MockMode = "ok"): MockProvider {
  const state: MockProvider = { server: undefined as unknown as http.Server, calls: 0, mode, name };
  state.server = http.createServer((req, res) => {
    state.calls++;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { model?: string; messages?: Array<{ content?: string }> };
      switch (state.mode) {
        case "ok": {
          const prompt = body.messages?.at(-1)?.content ?? "";
          const completion = `(${name}) echo: ${prompt}`;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: `chatcmpl-${name}-${state.calls}`,
              object: "chat.completion",
              model: body.model ?? "mock",
              choices: [{ index: 0, message: { role: "assistant", content: completion }, finish_reason: "stop" }],
              usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(completion.length / 4), total_tokens: Math.ceil(prompt.length / 4) + Math.ceil(completion.length / 4) },
            }),
          );
          return;
        }
        case "429":
          res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
          res.end(JSON.stringify({ error: { message: `${name}: rate limit reached for org-internal-123` } }));
          return;
        case "hang":
          return; // never answered; server.closeAllConnections() tears it down
        case "500":
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(`Error: boom\n    at InternalHandler (/srv/${name}/handler.js:42:13)\n    at process.processTicksAndRejections`);
          return;
        case "garbage":
          res.writeHead(200, { "content-type": "application/json" });
          res.end("<html>not json</html>");
          return;
      }
    });
  });
  return state;
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8101);
  const mode = (process.env.MODE ?? "ok") as MockMode;
  createMockProvider(process.env.NAME ?? "primary", mode).server.listen(port, () => process.stderr.write(`mock provider ${mode} on :${port}\n`));
}
