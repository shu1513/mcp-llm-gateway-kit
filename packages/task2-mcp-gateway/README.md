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
npm run task2                                                          # terminal 2 (PORT=8080, DOWNSTREAM_URL=http://127.0.0.1:8081/mcp)

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

Tokens: `GATEWAY_TOKENS='{"<token>":"admin"|"viewer"}'` (defaults to `dev-admin-token` / `dev-viewer-token`).

## Decision table

| request | result |
|---|---|
| no / unknown `Authorization: Bearer` | HTTP 401, JSON-RPC `-32001` |
| `tools/list` | forwarded unchanged |
| `tools/call` with `params.name` starting `admin_`, role ≠ admin | HTTP 403, JSON-RPC `-32001 Unauthorized Tool Call` with `data: {tool, role, required_role}`; downstream not called |
| `tools/call` otherwise | forwarded |
| any other method (`initialize`, `ping`, notifications…) | forwarded |
| JSON-RPC batch with any unauthorized member | whole batch answered locally (`-32001` for the offending member, `-32600` for the rest) — never partially forwarded |
| bad JSON / not a request / empty batch | `-32700` / `-32600` |
| downstream unreachable or timeout | HTTP 502, JSON-RPC `-32002` |

Forwarding keeps `Content-Type`, `Accept`, `Mcp-Session-Id`, `Mcp-Protocol-Version` and streams the downstream body, so SSE responses pass through unbuffered. The gateway adds `X-Forwarded-Role` for downstream audit logs only; authorization is enforced here.

## Assumptions / production notes

* Token → role is a static map behind `auth.ts#authenticate`; swap in JWT verification or token introspection there without touching the proxy.
* Prefix check is exact and case-sensitive (`admin_`), so `Admin_x` is *not* treated as admin-only. If downstream tool names are case-insensitive, normalise before the check.
* `tools/list` is forwarded transparently as the spec asks. Hiding `admin_*` tools from viewers in the list is a one-line filter if desired, but changes what the client sees.
* Body limit 1 MB, upstream timeout 30 s (configurable).

## Test

```bash
npx vitest run packages/task2-mcp-gateway
```
