# Task 1 — MCP server with strict validation (stdio)

Runnable MCP server (TypeScript, official `@modelcontextprotocol/sdk`) exposing:

| tool | input | notes |
|---|---|---|
| `get_customer_record` | `customer_id: "CUST-XXXXX"` | five uppercase letters/digits after `CUST-` |
| `trigger_refund` | `customer_id`, `amount` (positive finite number), `reason` (≥10 chars after trim) | unknown fields rejected |

## Run

```bash
npx tsx packages/task1-mcp-server/src/server.ts   # from repo root
npm run -s task1                                   # same; -s stops npm printing its "> script" banner on stdout
```

Point any MCP client at that command (e.g. MCP Inspector: `npx @modelcontextprotocol/inspector npx tsx packages/task1-mcp-server/src/server.ts`).

## Error mapping

| situation | response |
|---|---|
| malformed arguments (regex, type, range, extra keys) | JSON-RPC error `-32602 Invalid params`, `data.issues` lists each Zod issue |
| unknown tool | `-32602` (MCP convention for `tools/call` with an unknown name) |
| unknown method | `-32601 Method not found` |
| unparseable frame | `-32700 Parse error` with `id: null` (JSON-RPC 2.0 §4.2); server keeps serving |
| JSON that is not a JSON-RPC 2.0 message | `-32600 Invalid Request` with `id: null` |
| valid args, business failure (no such customer, suspended account) | tool result with `isError: true` — per the MCP spec this is a *tool* failure the model can act on, not a protocol failure |

The server is built on the SDK's low-level `Server` rather than `McpServer`: the high-level wrapper converts argument-validation failures into `isError: true` tool results, which is not what "standard JSON-RPC error codes" asks for. Zod (`src/schemas.ts`) stays the single source of validation; the JSON Schema advertised in `tools/list` mirrors it.

## stdout / stderr isolation

* `StdioServerTransport` is the only writer to stdout.
* All application logging is structured JSON on **stderr** (`src/log.ts`).
* `protectStdout()` rebinds `console.log/info/debug/warn/error` to stderr at startup so a stray `console.log` in a dependency cannot corrupt the frame stream.
* The SDK transport only *logs* undecodable frames; `installFrameErrorResponses` hooks the transport error path to answer them per spec, which also proves nothing non-JSON reaches stdout even on bad input.
* `test/server.test.ts` spawns the server with the documented `npm run -s task1` command, feeds it valid, invalid, non-JSON and non-2.0 frames, and asserts every stdout line parses as a JSON-RPC 2.0 message while logs appear only on stderr.

## Test

```bash
npx vitest run packages/task1-mcp-server
```
