# Task 3 — LLM gateway streaming guardrail (PII redaction)

`POST /v1/chat/completions` (OpenAI-compatible) → forwarded to `UPSTREAM_URL` with `stream: true` → every SSE delta flows through a **streaming redactor** → SSE back to the client. Emails, SSNs and credit-card numbers become `[REDACTED]`, even when split across frames.

## Run

```bash
PORT=8091 npx tsx packages/task3-llm-guardrail/src/mock-upstream.ts     # streams a sample answer 3 chars at a time
npm run task3                                                             # PORT=8090, UPSTREAM_URL=http://127.0.0.1:8091/v1/chat/completions
curl -N localhost:8090/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

Against a real provider: `UPSTREAM_URL=https://api.openai.com/v1/chat/completions UPSTREAM_API_KEY=sk-... npm run task3`.

## How the streaming redaction works (`src/redactor.ts`)

Per-delta matching misses `jane.do|e@exa|mple.com`; buffering the whole reply kills TTFT. The redactor keeps only a **hold-back tail**: the longest suffix of the text seen so far that could still be the *start* of a pattern. Each pattern has two regexes:

| pattern | complete match | prefix ("could still become one") |
|---|---|---|
| email | `local@domain.tld` | `[A-Za-z0-9._%+-]+(@[A-Za-z0-9.-]*)?$` |
| SSN | `ddd-dd-dddd` / `ddd dd dddd` | `\d{1,3}([- ]\d{0,2}([- ]\d{0,4})?)?$` |
| card | 13–19 digits, optional single `-`/space separators, Luhn-valid | `\d([ -]?\d){0,18}[ -]?$` |

On each `push(delta)`: append, compute hold = max prefix length over all patterns (capped at `maxHold`, default 256 ≥ the longest valid email), redact complete matches in the part before the cut, emit it, keep the tail. A complete match that would straddle the cut pulls the cut back to its start. `flush()` at `finish_reason` / `[DONE]` / upstream close releases the rest.

Properties (all tested in `test/redactor.test.ts`):
* **Correctness:** output is byte-identical to whole-text redaction for every slice size 1–24 and 200 random slicings.
* **Latency:** plain prose is emitted immediately; only a trailing word/digit run is held. TTFT test: first token leaves the gateway before the upstream's second frame.
* **Memory:** O(maxHold + delta). A 5,000-char run of token characters never holds more than `maxHold`; a 200 KB stream is processed with ≤256 chars buffered. A complete match that keeps growing past `maxHold` (an adversarial endless `a@b.commm…`) is clipped and redacted at the cut rather than retained.

Luhn filtering (default on) keeps order numbers like `1234 5678 9012 3456` intact; set `{ luhn: false }` to redact any 13–19-digit run.

## SSE handling (`src/sse.ts`, `src/gateway.ts`)

* Incremental SSE parser handles frames split mid-line and `\r\n`.
* Each upstream content delta is pushed into the redactor; released text is re-emitted as a chunk carrying the upstream `id`/`model`/`created`. Role, `finish_reason` and `[DONE]` frames pass through after a `flush()`, so ordering is preserved. Frame boundaries shift (one upstream frame may produce zero or more output frames) but concatenated content is exact.
* **Backpressure:** each `res.write` is awaited for `drain` when the client socket is full, and the next upstream `read()` only happens after the previous frames are written, so a slow client throttles the upstream pull instead of growing Node's write queue. SSE lines/events over 1 MB abort the stream.
* Client disconnect (`res` `close` before finish) aborts the upstream fetch and cancels the reader. Upstream errors return a sanitized JSON error (502), never upstream details.
* Request bodies are validated (`messages[]` required, `n` must be 1, non-object JSON rejected) and all handler failures are caught, so a bad request cannot crash the process.

## Assumptions

* OpenAI chat-completions SSE format (the de-facto gateway contract; Anthropic/Bedrock adapters would translate to the same chunk shape before the redactor).
* Single choice (`n=1`); multi-choice streams would need one redactor per choice index.
* Patterns are deliberately simple regexes; a production guardrail would add phone numbers, IBANs, and a configurable allow-list.

## Test

```bash
npx vitest run packages/task3-llm-guardrail
```
