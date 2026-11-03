# Task 2 — MCP security gateway (tool filtering + auth)

HTTP JSON-RPC reverse proxy that sits between an agent client and a downstream MCP server (Streamable-HTTP style `POST /mcp`).

```
agent --Bearer token--> gateway :8080 --(forward)--> downstream MCP :8081
                           |
                           +-- tools/call admin_* from non-admin -> -32001, never forwarded
```

## Run

```bash
PORT=8081 npx tsx packages/task2-mcp-gateway/src/mock-downstream.ts   # terminal 1
ALLOW_DEV_TOKENS=1 npm run task2                                       # terminal 2 (PORT=8080, DOWNSTREAM_URL=http://127.0.0.1:8081/mcp)

# viewer may list tools
curl -s localhost:8080/mcp -H 'authorization: Bearer dev-viewer-token' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# viewer may not call admin_ tools -> HTTP 403 + JSON-RPC -32001
curl -s localhost:8080/mcp -H 'authorization: Bearer dev-viewer-token' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{}}}'
# admin may
curl -s localhost:8080/mcp -H 'authorization: Bearer dev-admin-token' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{}}}'
```

Tokens: `GATEWAY_TOKENS='{"<token>":"admin"|"viewer"}'`. The gateway **fails closed**: without it, it refuses to start unless `ALLOW_DEV_TOKENS=1` opts into the demo tokens (`dev-admin-token` / `dev-viewer-token`).

## Decision table

| request | result |
|---|---|
| no / unknown `Authorization: Bearer` | HTTP 401, JSON-RPC `-32001` |
| `tools/list` | forwarded unchanged |
| `tools/call` with `params.name` starting `admin_`, role ≠ admin | HTTP 403, JSON-RPC `-32001 Unauthorized Tool Call` with `data: {tool, role, required_role}`; downstream not called |
| `tools/call` otherwise | forwarded |
| any other method (`initialize`, `ping`, notifications…) | forwarded |
| unauthorized `tools/call` sent as a *notification* (no `id`) | dropped (nothing to answer), HTTP 202 |
| JSON-RPC batch | each member judged on its own (JSON-RPC 2.0 §6): invalid envelopes → `-32600`, unauthorized → `-32001`, the rest forwarded as a smaller batch; responses merged into one array, HTTP 200. A batch with nothing forwardable is answered locally (403/400). |
| bad JSON / invalid envelope (`jsonrpc`, `method`, `id` type, `params` type) / empty batch | `-32700` / `-32600` |
| body over 1 MB | HTTP 413 |
| downstream unreachable or timeout | HTTP 502, JSON-RPC `-32002` per forwarded request (202 if only notifications were pending) |

Forwarding keeps `Content-Type`, `Accept`, `Mcp-Session-Id`, `Mcp-Protocol-Version`. Single requests stream the downstream body straight through (SSE-safe); batches are buffered because merging needs the parsed responses.

## Assumptions / production notes

* Token → role is a static map behind `auth.ts#authenticate`; swap in JWT verification or token introspection there without touching the proxy.
* Prefix check is exact and case-sensitive (`admin_`), so `Admin_x` is *not* treated as admin-only. If downstream tool names are case-insensitive, normalise before the check.
* `tools/list` is forwarded transparently as the spec asks. Hiding `admin_*` tools from viewers in the list is a one-line filter if desired, but changes what the client sees.
* The role is never sent downstream; the gateway is the only enforcement point, so a downstream that trusts headers cannot be confused by a forged one.
* Body limit 1 MB, upstream timeout 30 s (configurable).

## Test

```bash
npx vitest run packages/task2-mcp-gateway
```
