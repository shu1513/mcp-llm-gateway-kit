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

export function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as JsonRpcRequest).jsonrpc === "2.0" &&
    typeof (v as JsonRpcRequest).method === "string"
  );
}

export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined;
}
