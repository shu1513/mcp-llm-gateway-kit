/**
 * Task 2: MCP security gateway — an HTTP JSON-RPC reverse proxy between an AI
 * agent client and a downstream MCP server (Streamable HTTP style: POST /mcp).
 *
 * Policy
 *  - Every request needs `Authorization: Bearer <token>`; unknown token -> 401.
 *  - tools/list          -> forwarded unchanged.
 *  - tools/call          -> if params.name starts with "admin_", the caller's
 *                           role must be admin, else -32001 Unauthorized Tool
 *                           Call is returned here; downstream never sees it.
 *  - everything else     -> forwarded unchanged (initialize, ping, ...).
 *  - JSON-RPC batches are supported: each member is checked; if any member is
 *    blocked, the whole batch is answered locally (never partially forwarded).
 *
 * Forwarding preserves method/body/content-type and the Mcp-Session-Id header
 * in both directions, and streams the downstream body (so SSE responses pass
 * through without buffering).
 */
import http from "node:http";
import { Readable } from "node:stream";
import { authenticate, isAuthorizedToolCall, loadTokenMap, type Principal, type Role } from "./auth.js";
import { ErrorCodes, isJsonRpcRequest, isNotification, rpcError, type JsonRpcId, type JsonRpcRequest } from "./jsonrpc.js";

export interface GatewayOptions {
  downstreamUrl: string;
  tokens?: Map<string, Role>;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
  /** Observability hook: called for every decision. Defaults to stderr. */
  onEvent?: (e: GatewayEvent) => void;
}

export interface GatewayEvent {
  kind: "forwarded" | "blocked" | "unauthenticated" | "bad_request" | "upstream_error";
  method?: string;
  tool?: string;
  role?: Role;
  detail?: string;
}

const FORWARD_REQ_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version"];
const FORWARD_RES_HEADERS = ["content-type", "mcp-session-id", "cache-control"];

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Returns an error response if this single request must be blocked, else undefined. */
export function checkRequest(req: JsonRpcRequest, principal: Principal): ReturnType<typeof rpcError> | undefined {
  if (req.method !== "tools/call") return undefined;
  const name = (req.params as { name?: unknown } | undefined)?.name;
  if (typeof name !== "string") {
    return rpcError(req.id ?? null, ErrorCodes.InvalidParams, "tools/call requires params.name");
  }
  if (!isAuthorizedToolCall(principal.role, name)) {
    return rpcError(req.id ?? null, ErrorCodes.UnauthorizedToolCall, "Unauthorized Tool Call", {
      tool: name,
      role: principal.role,
      required_role: "admin",
    });
  }
  return undefined;
}

export function createGateway(opts: GatewayOptions): http.Server {
  const tokens = opts.tokens ?? loadTokenMap();
  const maxBody = opts.maxBodyBytes ?? 1_000_000;
  const timeoutMs = opts.upstreamTimeoutMs ?? 30_000;
  const emit = opts.onEvent ?? ((e) => process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n"));

  return http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, rpcError(null, ErrorCodes.InvalidRequest, "Only POST is supported"));
      return;
    }

    const principal = authenticate(req.headers.authorization, tokens);
    if (!principal) {
      emit({ kind: "unauthenticated" });
      res.setHeader("www-authenticate", 'Bearer realm="mcp-gateway"');
      sendJson(res, 401, rpcError(null, ErrorCodes.UnauthorizedToolCall, "Missing or invalid bearer token"));
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, maxBody);
    } catch (e) {
      emit({ kind: "bad_request", detail: (e as Error).message });
      sendJson(res, 413, rpcError(null, ErrorCodes.InvalidRequest, "Payload too large"));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      emit({ kind: "bad_request", detail: "parse error" });
      sendJson(res, 400, rpcError(null, ErrorCodes.ParseError, "Parse error"));
      return;
    }

    const batch = Array.isArray(parsed);
    const messages = batch ? (parsed as unknown[]) : [parsed];
    if (messages.length === 0 || !messages.every(isJsonRpcRequest)) {
      emit({ kind: "bad_request", detail: "invalid request" });
      sendJson(res, 400, rpcError(null, ErrorCodes.InvalidRequest, "Invalid JSON-RPC request"));
      return;
    }

    // Authorization pass: block locally if any member is unauthorized.
    const blocked = messages.map((m) => checkRequest(m, principal)).filter((e) => e !== undefined);
    if (blocked.length > 0) {
      for (const b of blocked) emit({ kind: "blocked", method: "tools/call", tool: (b.error.data as { tool?: string })?.tool, role: principal.role });
      // Notifications (no id) get no response body; everything else gets the error.
      const responses = messages
        .map((m) => (isNotification(m) ? undefined : (checkRequest(m, principal) ?? rpcError(m.id as JsonRpcId, ErrorCodes.InvalidRequest, "Batch rejected: contains an unauthorized tool call"))))
        .filter((r) => r !== undefined);
      if (responses.length === 0) {
        res.writeHead(202).end();
      } else {
        sendJson(res, 403, batch ? responses : responses[0]);
      }
      return;
    }

    // Forward transparently.
    const headers: Record<string, string> = {};
    for (const h of FORWARD_REQ_HEADERS) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    headers["content-type"] ??= "application/json";
    headers["accept"] ??= "application/json, text/event-stream";
    headers["x-forwarded-role"] = principal.role; // lets downstream audit, never trusted for authz there

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let upstream: Response;
    try {
      upstream = await fetch(opts.downstreamUrl, { method: "POST", headers, body: raw, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      emit({ kind: "upstream_error", detail: (e as Error).name });
      const detail = controller.signal.aborted ? "Downstream timed out" : "Downstream unreachable";
      const errs = messages.filter((m) => !isNotification(m)).map((m) => rpcError(m.id as JsonRpcId, ErrorCodes.UpstreamError, detail));
      sendJson(res, 502, batch ? errs : (errs[0] ?? rpcError(null, ErrorCodes.UpstreamError, detail)));
      return;
    }

    for (const m of messages) {
      emit({ kind: "forwarded", method: m.method, role: principal.role, tool: m.method === "tools/call" ? ((m.params as { name?: string })?.name) : undefined });
    }

    const resHeaders: Record<string, string> = {};
    for (const h of FORWARD_RES_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) resHeaders[h] = v;
    }
    res.writeHead(upstream.status, resHeaders);
    if (!upstream.body) {
      clearTimeout(timer);
      res.end();
      return;
    }
    const body = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
    body.on("end", () => clearTimeout(timer));
    body.on("error", () => {
      clearTimeout(timer);
      res.destroy();
    });
    body.pipe(res);
  });
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8080);
  const downstreamUrl = process.env.DOWNSTREAM_URL ?? "http://127.0.0.1:8081/mcp";
  createGateway({ downstreamUrl }).listen(port, () => {
    process.stderr.write(`mcp-gateway listening on :${port} -> ${downstreamUrl}\n`);
  });
}
