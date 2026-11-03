/**
 * Mock downstream MCP server (HTTP JSON-RPC). Enough of the protocol to show
 * the gateway forwarding tools/list and tools/call. Counts calls so tests can
 * prove blocked requests never reached it.
 */
import http from "node:http";
import { ErrorCodes, isJsonRpcRequest, rpcError, type JsonRpcRequest } from "./jsonrpc.js";

const TOOLS = [
  { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "get_time", description: "Current server time", inputSchema: { type: "object", properties: {} } },
  { name: "admin_reset_key", description: "Rotate the tenant API key (admin only)", inputSchema: { type: "object", properties: {} } },
];

export interface MockDownstream {
  server: http.Server;
  calls: JsonRpcRequest[];
}

function handle(req: JsonRpcRequest): unknown {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock-downstream", version: "1.0.0" } } };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const { name, arguments: args } = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      switch (name) {
        case "echo":
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(args?.text ?? "") }] } };
        case "get_time":
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: new Date().toISOString() }] } };
        case "admin_reset_key":
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "key rotated: sk-new-" + Math.random().toString(36).slice(2, 8) }] } };
        default:
          return rpcError(id, ErrorCodes.InvalidParams, `Unknown tool: ${name}`);
      }
    }
    default:
      return rpcError(id, ErrorCodes.MethodNotFound, `Method not found: ${req.method}`);
  }
}

export function createMockDownstream(): MockDownstream {
  const calls: JsonRpcRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(rpcError(null, ErrorCodes.ParseError, "Parse error")));
        return;
      }
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      const results: unknown[] = [];
      for (const m of msgs) {
        if (!isJsonRpcRequest(m)) {
          results.push(rpcError(null, ErrorCodes.InvalidRequest, "Invalid request"));
          continue;
        }
        calls.push(m);
        if (m.id === undefined) continue; // notification
        results.push(handle(m));
      }
      if (results.length === 0) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "mock-session-1" });
      res.end(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
    });
  });
  return { server, calls };
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8081);
  createMockDownstream().server.listen(port, () => process.stderr.write(`mock downstream MCP on :${port}\n`));
}
