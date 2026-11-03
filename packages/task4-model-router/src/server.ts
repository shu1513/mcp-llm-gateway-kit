/**
 * Task 4: HTTP front for the rate limiter + model router.
 *
 *   POST /v1/chat/completions   (x-api-key: <tenant key>)
 *
 *   reserve(estimate) --429 if over--> route(primary -> secondary) --> settle(actual) --> JSON
 *
 * Every failure returns the standardized {error:{code,message,request_id}}
 * payload from errors.ts; nothing from upstream (status text, body, stack)
 * reaches the client. Details go to stderr with the same request_id.
 *
 * Token accounting on failure: a provider that answered 429 / was unreachable
 * generated nothing, so the reservation is released. A provider that *timed
 * out* may well have generated (and billed) tokens, so its share of the
 * estimate is kept — conservative by design.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { openDb, type Db } from "./db.js";
import { GatewayError, toGatewayError } from "./errors.js";
import { SlidingWindowRateLimiter, type RateLimiterOptions } from "./rateLimiter.js";
import { ModelRouter, type Attempt, type RouterOptions } from "./router.js";
import { normalizeBudget } from "./tokens.js";

export interface ServerOptions {
  db: Db;
  limiter: Omit<RateLimiterOptions, "now"> & { now?: () => number };
  router: RouterOptions;
  maxBodyBytes?: number;
  log?: (msg: string, extra?: unknown) => void;
}

/** Byte-bounded body read; decodes once so multibyte characters split across chunks survive. */
function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new GatewayError("bad_request", "Payload too large"));
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createServer(opts: ServerOptions): http.Server & { limiter: SlidingWindowRateLimiter } {
  const log = opts.log ?? ((msg, extra) => process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), msg, ...(extra ? { extra } : {}) }) + "\n"));
  const limiter = new SlidingWindowRateLimiter(opts.db, opts.limiter);
  const router = new ModelRouter({ ...opts.router, log });
  const logReq = opts.db.prepare(
    "INSERT OR REPLACE INTO request_log (request_id, tenant_key, ts_ms, provider, status, error_code, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const tenant = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined;
    let reservationId: number | undefined;
    let estimate = 0;
    const attempts: Attempt[] = [];
    const controller = new AbortController();
    const onClientGone = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on("close", onClientGone);
    /** Best-effort DB writes: a failing disk must never prevent the sanitized response. */
    const safely = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        log("db write failed", { requestId, what, message: (e as Error).message });
      }
    };

    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") throw new GatewayError("bad_request", "Unknown route");
      if (!tenant) throw new GatewayError("unauthorized", "Missing x-api-key header");

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req, opts.maxBodyBytes ?? 1_000_000));
      } catch (e) {
        throw e instanceof GatewayError ? e : new GatewayError("bad_request", "Invalid JSON body");
      }
      if (typeof body !== "object" || body === null || !Array.isArray(body.messages)) throw new GatewayError("bad_request", "Body must include messages[]");

      const budget = normalizeBudget(body);
      estimate = budget.estimate;
      const decision = limiter.reserve(tenant, estimate);
      if (!decision.allowed) {
        throw new GatewayError("rate_limited", `Token rate limit exceeded (${decision.usedTokens}/${opts.limiter.limitTokens} tokens in window)`, decision.retryAfterMs);
      }
      reservationId = decision.reservationId;

      const result = await router.route(budget.body, controller.signal, attempts);

      // Provider-reported usage, plus the full estimate for any earlier attempt that timed out (it may have generated).
      const timedOut = attempts.filter((a) => a.outcome === "timeout").length;
      const actual = (result.totalTokens ?? estimate) + timedOut * estimate;
      safely("settle", () => limiter.settle(reservationId!, actual));
      safely("log", () => logReq.run(requestId, tenant, Date.now(), result.provider, 200, null, actual));
      log("request ok", { requestId, tenant, provider: result.provider, attempts: result.attempts, tokens: actual });
      send(200, result.body, {
        "x-gateway-provider": result.provider,
        "x-ratelimit-limit-tokens": String(opts.limiter.limitTokens),
        "x-ratelimit-remaining-tokens": String(Math.max(0, decision.remainingTokens + estimate - actual)),
      });
    } catch (err) {
      const ge = toGatewayError(err);
      if (reservationId !== undefined) {
        // Keep the estimate for every timed-out attempt (unknown consumption); release the rest.
        const keep = attempts.filter((a) => a.outcome === "timeout" || a.outcome === "cancelled").length * estimate;
        safely("settle", () => limiter.settle(reservationId!, keep));
      }
      if (tenant) safely("log", () => logReq.run(requestId, tenant, Date.now(), null, ge.status, ge.code, null));
      log("request failed", { requestId, code: ge.code, message: ge.message, attempts, internal: ge.internal instanceof Error ? ge.internal.message : ge.internal });
      const headers: Record<string, string> = {};
      if (ge.retryAfterMs !== undefined && Number.isFinite(ge.retryAfterMs)) headers["retry-after"] = String(Math.ceil(ge.retryAfterMs / 1000));
      if (!res.headersSent) send(ge.status, ge.toBody(requestId), headers);
    } finally {
      res.off("close", onClientGone);
    }
  });

  const sweep = setInterval(() => limiter.evict(), Math.max(1000, opts.limiter.windowMs));
  sweep.unref();
  server.on("close", () => clearInterval(sweep));
  return Object.assign(server, { limiter });
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8100);
  const db = openDb(process.env.DB_PATH ?? "./router.db");
  const server = createServer({
    db,
    limiter: { limitTokens: Number(process.env.LIMIT_TOKENS ?? 50_000), windowMs: Number(process.env.WINDOW_MS ?? 60_000) },
    router: {
      timeoutMs: Number(process.env.TIMEOUT_MS ?? 3000),
      providers: [
        { name: "primary", url: process.env.PRIMARY_URL ?? "http://127.0.0.1:8101/v1/chat/completions", apiKey: process.env.PRIMARY_API_KEY, model: process.env.PRIMARY_MODEL },
        { name: "secondary", url: process.env.SECONDARY_URL ?? "http://127.0.0.1:8102/v1/chat/completions", apiKey: process.env.SECONDARY_API_KEY, model: process.env.SECONDARY_MODEL },
      ],
    },
  });
  server.listen(port, () => process.stderr.write(`model-router on :${port}\n`));
}
