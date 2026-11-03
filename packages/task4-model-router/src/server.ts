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
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { openDb, type Db } from "./db.js";
import { GatewayError, toGatewayError } from "./errors.js";
import { SlidingWindowRateLimiter, type RateLimiterOptions } from "./rateLimiter.js";
import { ModelRouter, type RouterOptions } from "./router.js";
import { estimateRequestTokens } from "./tokens.js";

export interface ServerOptions {
  db: Db;
  limiter: Omit<RateLimiterOptions, "now"> & { now?: () => number };
  router: RouterOptions;
  maxBodyBytes?: number;
  log?: (msg: string, extra?: unknown) => void;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c;
      if (raw.length > limit) {
        reject(new GatewayError("bad_request", "Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
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

      const estimate = estimateRequestTokens(body);
      const decision = limiter.reserve(tenant, estimate);
      if (!decision.allowed) {
        throw new GatewayError("rate_limited", `Token rate limit exceeded (${decision.usedTokens}/${opts.limiter.limitTokens} tokens in window)`, decision.retryAfterMs);
      }
      reservationId = decision.reservationId;

      const controller = new AbortController();
      req.on("close", () => controller.abort());
      const result = await router.route(body, controller.signal);

      const actual = result.totalTokens ?? estimate;
      limiter.settle(reservationId, actual);
      logReq.run(requestId, tenant, Date.now(), result.provider, 200, null, actual);
      log("request ok", { requestId, tenant, provider: result.provider, attempts: result.attempts, tokens: actual });
      send(200, result.body, {
        "x-gateway-provider": result.provider,
        "x-ratelimit-limit-tokens": String(opts.limiter.limitTokens),
        "x-ratelimit-remaining-tokens": String(Math.max(0, decision.remainingTokens + estimate - actual)),
      });
    } catch (err) {
      const ge = toGatewayError(err);
      if (reservationId !== undefined) limiter.settle(reservationId, 0); // failed call consumed nothing
      if (tenant) logReq.run(requestId, tenant, Date.now(), null, ge.status, ge.code, null);
      log("request failed", { requestId, code: ge.code, message: ge.message, internal: ge.internal instanceof Error ? ge.internal.message : ge.internal });
      const headers: Record<string, string> = {};
      if (ge.retryAfterMs !== undefined && Number.isFinite(ge.retryAfterMs)) headers["retry-after"] = String(Math.ceil(ge.retryAfterMs / 1000));
      send(ge.status, ge.toBody(requestId), headers);
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
