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
 *
 * Batches follow JSON-RPC 2.0 §6: every member is judged on its own. Invalid
 * envelopes (-32600) and unauthorized calls (-32001) are answered locally;
 * the remaining members are forwarded as a smaller batch and the two sets of
 * responses are merged. Single requests are streamed straight through
 * (SSE-capable); batches are buffered because merging needs the parsed body.
 */
import http from "node:http";
import { Readable } from "node:stream";
import { authenticate, isAuthorizedToolCall, loadTokenMap, type Principal, type Role } from "./auth.js";
import { ErrorCodes, isNotification, rpcError, validateEnvelope, type JsonRpcError, type JsonRpcId, type JsonRpcRequest } from "./jsonrpc.js";

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

class PayloadTooLarge extends Error {}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new PayloadTooLarge());
        req.pause();
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

/** Per-member verdict: forward it, answer it locally, or (notification) drop silently. */
type Verdict = { kind: "forward"; req: JsonRpcRequest } | { kind: "local"; req?: JsonRpcRequest; error: JsonRpcError } | { kind: "drop"; req: JsonRpcRequest };

export function judge(member: unknown, principal: Principal): Verdict {
  const v = validateEnvelope(member);
  if (!v.ok) return { kind: "local", error: rpcError(v.id, ErrorCodes.InvalidRequest, `Invalid Request: ${v.reason}`) };
  const req = v.req;
  if (req.method !== "tools/call") return { kind: "forward", req };

  const name = (req.params as { name?: unknown } | undefined)?.name;
  let error: JsonRpcError | undefined;
  if (typeof name !== "string") {
    error = rpcError(req.id ?? null, ErrorCodes.InvalidParams, "tools/call requires params.name");
  } else if (!isAuthorizedToolCall(principal.role, name)) {
    error = rpcError(req.id ?? null, ErrorCodes.UnauthorizedToolCall, "Unauthorized Tool Call", { tool: name, role: principal.role, required_role: "admin" });
  }
  if (!error) return { kind: "forward", req };
  // A notification cannot be answered; it is simply not forwarded.
  return isNotification(req) ? { kind: "drop", req } : { kind: "local", req, error };
}

const httpStatusFor = (errors: JsonRpcError[]): number =>
  errors.some((e) => e.error.code === ErrorCodes.UnauthorizedToolCall) ? 403 : 400;

export function createGateway(opts: GatewayOptions): http.Server {
  const tokens = opts.tokens ?? loadTokenMap();
  const maxBody = opts.maxBodyBytes ?? 1_000_000;
  const timeoutMs = opts.upstreamTimeoutMs ?? 30_000;
  const emit = opts.onEvent ?? ((e) => process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n"));

  async function forward(raw: string, reqHeaders: http.IncomingHttpHeaders, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {};
    for (const h of FORWARD_REQ_HEADERS) {
      const v = reqHeaders[h];
      if (typeof v === "string") headers[h] = v;
    }
    headers["content-type"] ??= "application/json";
    headers["accept"] ??= "application/json, text/event-stream";
    return fetch(opts.downstreamUrl, { method: "POST", headers, body: raw, signal });
  }

  return http.createServer(async (req, res) => {
    try {
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
        emit({ kind: "bad_request", detail: e instanceof PayloadTooLarge ? "payload too large" : "read error" });
        res.setHeader("connection", "close");
        sendJson(res, e instanceof PayloadTooLarge ? 413 : 400, rpcError(null, ErrorCodes.InvalidRequest, e instanceof PayloadTooLarge ? "Payload too large" : "Bad request"));
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
      if (batch && (parsed as unknown[]).length === 0) {
        emit({ kind: "bad_request", detail: "empty batch" });
        sendJson(res, 400, rpcError(null, ErrorCodes.InvalidRequest, "Invalid Request: empty batch"));
        return;
      }

      const verdicts = (batch ? (parsed as unknown[]) : [parsed]).map((m) => judge(m, principal));
      const local = verdicts.filter((v): v is Extract<Verdict, { kind: "local" }> => v.kind === "local").map((v) => v.error);
      const toForward = verdicts.filter((v): v is Extract<Verdict, { kind: "forward" }> => v.kind === "forward").map((v) => v.req);
      for (const v of verdicts) {
        if (v.kind === "local" && v.error.error.code === ErrorCodes.UnauthorizedToolCall) emit({ kind: "blocked", method: "tools/call", tool: (v.error.error.data as { tool: string }).tool, role: principal.role });
        else if (v.kind === "local") emit({ kind: "bad_request", detail: v.error.error.message });
        else if (v.kind === "drop") emit({ kind: "blocked", method: v.req.method, tool: (v.req.params as { name?: string })?.name, role: principal.role });
      }

      // Nothing to forward: answer entirely from here.
      if (toForward.length === 0) {
        if (local.length === 0) res.writeHead(202).end(); // only dropped notifications
        else sendJson(res, httpStatusFor(local), batch ? local : local[0]);
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const forwardIds = toForward.filter((m) => !isNotification(m)).map((m) => m.id as JsonRpcId);
      const upstreamFailure = (detail: string): JsonRpcError[] => forwardIds.map((id) => rpcError(id, ErrorCodes.UpstreamError, detail));

      let upstream: Response;
      try {
        upstream = await forward(batch ? JSON.stringify(toForward) : raw, req.headers, controller.signal);
      } catch (e) {
        clearTimeout(timer);
        emit({ kind: "upstream_error", detail: (e as Error).name });
        const errs = [...local, ...upstreamFailure(controller.signal.aborted ? "Downstream timed out" : "Downstream unreachable")];
        if (errs.length === 0) res.writeHead(202).end(); // notifications only: nothing to report
        else sendJson(res, 502, batch ? errs : errs[0]);
        return;
      }
      for (const m of toForward) emit({ kind: "forwarded", method: m.method, role: principal.role, tool: m.method === "tools/call" ? (m.params as { name?: string })?.name : undefined });

      const resHeaders: Record<string, string> = {};
      for (const h of FORWARD_RES_HEADERS) {
        const v = upstream.headers.get(h);
        if (v) resHeaders[h] = v;
      }

      if (!batch) {
        // Single request: stream the downstream body straight through (SSE-safe).
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
        res.on("close", () => body.destroy());
        body.pipe(res);
        return;
      }

      // Batch: merge downstream responses with the locally produced ones.
      let downstreamResponses: unknown[] = [];
      try {
        const text = await upstream.text();
        if (text.trim().length > 0) {
          const parsedRes = JSON.parse(text);
          downstreamResponses = Array.isArray(parsedRes) ? parsedRes : [parsedRes];
        }
      } catch {
        emit({ kind: "upstream_error", detail: "malformed downstream body" });
        downstreamResponses = upstreamFailure("Malformed downstream response");
      } finally {
        clearTimeout(timer);
      }
      const merged = [...local, ...downstreamResponses];
      if (merged.length === 0) res.writeHead(202, { "mcp-session-id": resHeaders["mcp-session-id"] ?? "" }).end();
      else {
        res.writeHead(200, { ...resHeaders, "content-type": "application/json" });
        res.end(JSON.stringify(merged));
      }
    } catch (e) {
      emit({ kind: "upstream_error", detail: `handler: ${(e as Error).message}` });
      if (!res.headersSent) sendJson(res, 500, rpcError(null, ErrorCodes.InternalError, "Internal error"));
      else res.destroy();
    }
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
