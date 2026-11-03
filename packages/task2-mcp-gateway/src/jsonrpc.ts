/** Minimal JSON-RPC 2.0 wire types + helpers used by the gateway. */
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Gateway-specific: caller's role may not invoke this tool. */
  UnauthorizedToolCall: -32001,
  /** Gateway-specific: downstream unreachable / bad response. */
  UpstreamError: -32002,
} as const;

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Full envelope check per JSON-RPC 2.0 §4: jsonrpc "2.0", method string,
 * id absent | string | number | null, params absent | object | array.
 * Returns the reason when invalid.
 */
export function validateEnvelope(v: unknown): { ok: true; req: JsonRpcRequest } | { ok: false; reason: string; id: JsonRpcId } {
  if (!isObject(v)) return { ok: false, reason: "not an object", id: null };
  const id = v.id;
  const idOk = id === undefined || id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
  const safeId: JsonRpcId = idOk && id !== undefined ? (id as JsonRpcId) : null;
  if (!idOk) return { ok: false, reason: "id must be a string, number or null", id: null };
  if (v.jsonrpc !== "2.0") return { ok: false, reason: 'jsonrpc must be "2.0"', id: safeId };
  if (typeof v.method !== "string" || v.method.length === 0) return { ok: false, reason: "method must be a non-empty string", id: safeId };
  if (v.params !== undefined && !isObject(v.params) && !Array.isArray(v.params)) return { ok: false, reason: "params must be an object or array", id: safeId };
  return { ok: true, req: v as unknown as JsonRpcRequest };
}

export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined;
}
