# AI Field Developer / Solutions Engineer — assessment

Four runnable solutions, one TypeScript workspace, 60 tests.

| task | package | what it is |
|---|---|---|
| 1 | [`packages/task1-mcp-server`](packages/task1-mcp-server/README.md) | MCP server over stdio (`get_customer_record`, `trigger_refund`), Zod validation → JSON-RPC `-32602`, stdout reserved for JSON-RPC |
| 2 | [`packages/task2-mcp-gateway`](packages/task2-mcp-gateway/README.md) | HTTP JSON-RPC reverse proxy: Bearer → role, `admin_*` tools gated with `-32001`, batches, transparent forwarding |
| 3 | [`packages/task3-llm-guardrail`](packages/task3-llm-guardrail/README.md) | LLM gateway that redacts emails / SSNs / cards inside a live SSE stream with a bounded hold-back buffer |
| 4 | [`packages/task4-model-router`](packages/task4-model-router/README.md) | SQLite sliding-window token limiter + primary→secondary failover on 429 / 3 s timeout, sanitized errors |

## Setup

```bash
npm install          # Node ≥ 20
npm test             # all four packages
npm run typecheck
npm run task1 | task2 | task3 | task4   # run a service (see each README for the mock peers + curl examples)
```

Each package is self-contained: `src/` (implementation + a mock peer so it runs with no external accounts), `test/` (vitest, real sockets, no mocks of the code under test), `README.md` (design, decision tables, assumptions).

## Assumptions made where the brief was open

* **Task 1** returns protocol errors (`-32602`) for malformed arguments and tool-level `isError` results for business failures (unknown customer, suspended account), following the MCP tools spec. It is built on the SDK's low-level `Server` because the high-level `McpServer` swallows validation failures into tool results.
* **Task 2** resolves tokens with a static token→role map (`GATEWAY_TOKENS`) behind one function; JWT/introspection is a drop-in there. `tools/list` is forwarded unfiltered, as asked. A batch containing any unauthorized call is answered locally in full rather than partially forwarded.
* **Task 3** speaks the OpenAI chat-completions SSE format. Card detection is Luhn-checked by default so order numbers survive; configurable.
* **Task 4** fails over on `429`, timeout (3000 ms), connection failure and unparseable body; other non-2xx statuses are returned as `upstream_error` without failover. The pre-call token estimate is `chars/4 + max_tokens` and is replaced by the provider's reported usage afterwards. SQLite is `better-sqlite3`, on disk, WAL.

Everything is plain Node (`node:http`, global `fetch`), no framework, so the request/response handling is visible rather than hidden behind middleware.
