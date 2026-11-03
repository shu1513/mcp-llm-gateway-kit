# Task 4 — Rate-limiting + model-fallback router

```
client --x-api-key--> POST /v1/chat/completions
          │
          ├─ reserve(estimate)  SQLite sliding window, 50k tokens / 60 s per tenant  → 429 rate_limited
          ├─ route()            primary ──429 / >3000 ms / unreachable──▶ secondary
          └─ settle(actual)     window corrected with provider-reported usage
```

## Run

```bash
PORT=8101 MODE=ok   NAME=primary   npx tsx packages/task4-model-router/src/mock-provider.ts
PORT=8102 MODE=ok   NAME=secondary npx tsx packages/task4-model-router/src/mock-provider.ts
npm run task4        # PORT=8100, DB_PATH=./router.db, LIMIT_TOKENS=50000, WINDOW_MS=60000, TIMEOUT_MS=3000
curl -s localhost:8100/v1/chat/completions -H 'x-api-key: tenant-1' -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"max_tokens":50}' -i
```

Restart the primary with `MODE=429` or `MODE=hang` and the same curl answers from the secondary (`x-gateway-provider: secondary`). Real providers: `PRIMARY_URL`, `PRIMARY_API_KEY`, `PRIMARY_MODEL`, `SECONDARY_*`.

## Rate limiter (`src/rateLimiter.ts`)

* **Sliding window, token-aware.** Each admitted request writes `(tenant, ts, tokens)` to `token_usage`; usage = `SUM(tokens)` over rows newer than `now − 60 s`. No fixed buckets, so a burst at 00:59 still counts at 01:30.
* **Reserve → settle.** The limiter is checked *before* the model call with a cheap estimate (`chars/4 + max_tokens`), then the row is updated with the provider's `usage.total_tokens` (or 0 if the call failed). Enforced up front, accurate after.
* **Atomic under concurrency.** The check-and-insert runs in `BEGIN IMMEDIATE`, so two requests cannot both observe headroom and both commit, even from separate processes sharing the `.db` (tested with two connections and 200 interleaved reservations: exactly `limit/100` admitted).
* **Eviction.** Expired rows for the tenant are deleted inside every reservation; a global sweep runs each window. Boundary is strict (`ts > cutoff`), tested at ±1 ms.
* **`retry_after_ms`** is exact: walk the tenant's rows oldest-first until enough tokens would expire for the request to fit. A request larger than the whole budget gets `Infinity` (never fits) → the client sees no `retry_after_ms`.

## Router (`src/router.ts`)

* Providers are tried in order. Failover on: `429`, timeout (default 3000 ms, `AbortController`), connection failure, or an unparseable body. Other non-2xx answers surface immediately as `upstream_error` — a `400` from the model usually means the request is wrong and would fail on the backup too.
* **Timeout race:** the timer is always cleared in `finally`; an abort firing after a successful response is a no-op, so a slow-but-successful primary never also triggers the secondary (tested: 20 concurrent calls at a 100 ms budget, secondary call count stays 0). Body reading shares the same budget so a provider that accepts and stalls still times out.
* Client disconnect aborts the in-flight upstream call.
* `model` can be overridden per provider (backup providers often serve a different model id).

## Error sanitization (`src/errors.ts`)

Every failure, from any layer, becomes:

```json
{ "error": { "code": "rate_limited", "message": "Token rate limit exceeded (1920/2000 tokens in window)", "request_id": "…", "retry_after_ms": 40000 } }
```

Codes: `bad_request` 400, `unauthorized` 401, `rate_limited` 429, `upstream_rate_limited` 429, `upstream_timeout` 504, `upstream_error` 502, `all_providers_failed` 502, `internal_error` 500. Upstream bodies/status text/stack traces are kept on the `GatewayError.internal` field which is only ever logged (with the same `request_id`, so an operator can correlate). Tests assert the client body never contains the mock provider's fake stack trace or host.

## SQLite notes

`better-sqlite3`, on-disk file (`DB_PATH`), WAL journal, `busy_timeout` 5 s. The synchronous API keeps each limiter decision a single short transaction; `request_log` keeps one row per request for audit.

## Test

```bash
npx vitest run packages/task4-model-router
```
