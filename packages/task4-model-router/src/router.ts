/**
 * Resilient model router: primary -> secondary failover.
 *
 * Failover triggers (per task): primary answers 429, or does not answer within
 * `timeoutMs` (3000 ms default). A connection-level failure (refused/reset) is
 * treated like a timeout — the provider is equally unavailable. Any other
 * non-2xx from the primary is reported as upstream_error without failover,
 * since a 400 from the model usually means the request itself is bad.
 *
 * Timeout race: the fetch is raced against a timer via AbortController; the
 * timer is always cleared, and an abort after a successful response is a no-op,
 * so a slow-but-successful primary cannot both answer and trigger failover.
 */
import { GatewayError } from "./errors.js";

export interface Provider {
  name: string;
  url: string;
  apiKey?: string;
  /** If set, overrides `model` in the forwarded body (backup providers often host a different model). */
  model?: string;
}

export interface RouterOptions {
  providers: Provider[]; // [primary, secondary, ...] in failover order
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string, extra?: unknown) => void;
}

export interface Attempt {
  provider: string;
  outcome: "ok" | "timeout" | "rate_limited" | "unreachable" | "malformed" | "error" | "cancelled";
  ms: number;
}

export interface RouteResult {
  provider: string;
  status: number;
  body: unknown;
  /** Total tokens reported by the provider, if any. */
  totalTokens?: number;
  attempts: Attempt[];
}

export interface Usage {
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

export class ModelRouter {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string, extra?: unknown) => void;

  constructor(private readonly opts: RouterOptions) {
    if (opts.providers.length === 0) throw new Error("at least one provider required");
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  /**
   * @param attempts optional sink that receives every attempt even when the
   *   call ultimately throws (the caller uses it for token accounting).
   */
  async route(body: Record<string, unknown>, signal?: AbortSignal, attempts: Attempt[] = []): Promise<RouteResult> {
    let lastError: GatewayError | undefined;

    for (const provider of this.opts.providers) {
      // Cancellation is terminal: never start (or fail over to) another paid call for a client that left.
      if (signal?.aborted) throw new GatewayError("client_closed", "Client closed the request");

      const started = Date.now();
      const outcome = await this.callProvider(provider, body, signal);
      const ms = Date.now() - started;
      attempts.push({ provider: provider.name, outcome: outcome.outcome, ms });

      if (outcome.kind === "ok") {
        return { provider: provider.name, status: outcome.status, body: outcome.body, totalTokens: outcome.totalTokens, attempts };
      }
      this.log("provider attempt failed", { provider: provider.name, outcome: outcome.outcome, ms });
      if (outcome.kind === "failover") {
        lastError = outcome.error;
        continue; // try the next provider
      }
      throw outcome.error; // non-failover error: surface immediately (sanitized)
    }

    throw new GatewayError("all_providers_failed", "All model providers are unavailable", lastError?.retryAfterMs, attempts);
  }

  private async callProvider(
    provider: Provider,
    body: Record<string, unknown>,
    clientSignal?: AbortSignal,
  ): Promise<
    | { kind: "ok"; outcome: "ok"; status: number; body: unknown; totalTokens?: number }
    | { kind: "failover"; outcome: Attempt["outcome"]; error: GatewayError }
    | { kind: "fatal"; outcome: Attempt["outcome"]; error: GatewayError }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
    const onClientAbort = () => controller.abort(new Error("client_closed"));
    clientSignal?.addEventListener("abort", onClientAbort, { once: true });

    try {
      const payload = provider.model ? { ...body, model: provider.model } : body;
      let res: Response;
      try {
        res = await this.fetchImpl(provider.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (e) {
        if (clientSignal?.aborted) return { kind: "fatal", outcome: "cancelled", error: new GatewayError("client_closed", "Client closed the request") };
        const timedOut = controller.signal.aborted && (controller.signal.reason as Error)?.message === "timeout";
        return {
          kind: "failover",
          outcome: timedOut ? "timeout" : "unreachable",
          error: new GatewayError(
            timedOut ? "upstream_timeout" : "upstream_error",
            timedOut ? `Provider ${provider.name} timed out` : `Provider ${provider.name} unreachable`,
            undefined,
            e,
          ),
        };
      }

      // Read the body under the same timeout budget (a provider can accept the
      // connection and then stall).
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        if (clientSignal?.aborted) return { kind: "fatal", outcome: "cancelled", error: new GatewayError("client_closed", "Client closed the request") };
        return { kind: "failover", outcome: "timeout", error: new GatewayError("upstream_timeout", `Provider ${provider.name} stalled`, undefined, e) };
      }

      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        return {
          kind: "failover",
          outcome: "rate_limited",
          error: new GatewayError("upstream_rate_limited", `Provider ${provider.name} rate limited`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined, text.slice(0, 500)),
        };
      }
      if (!res.ok) {
        return {
          kind: "fatal",
          outcome: "error",
          error: new GatewayError("upstream_error", `Provider ${provider.name} returned an error`, undefined, { status: res.status, body: text.slice(0, 500) }),
        };
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (e) {
        return { kind: "failover", outcome: "malformed", error: new GatewayError("upstream_error", `Provider ${provider.name} returned a malformed response`, undefined, e) };
      }
      const usage = (json as { usage?: Usage })?.usage;
      return { kind: "ok", outcome: "ok", status: res.status, body: json, totalTokens: usage?.total_tokens };
    } finally {
      clearTimeout(timer);
      clientSignal?.removeEventListener("abort", onClientAbort);
    }
  }
}
