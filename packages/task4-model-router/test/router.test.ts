import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { ModelRouter } from "../src/router.js";
import { GatewayError } from "../src/errors.js";
import { createMockProvider, type MockMode } from "../src/mock-provider.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function provider(name: string, mode: MockMode) {
  const p = createMockProvider(name, mode);
  await new Promise<void>((r) => p.server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => { p.server.closeAllConnections(); p.server.close(() => r()); }));
  return { p, url: `http://127.0.0.1:${(p.server.address() as AddressInfo).port}/v1/chat/completions` };
}

const body = { model: "gpt-x", messages: [{ role: "user", content: "hi" }] };

describe("ModelRouter failover", () => {
  it("uses the primary when healthy", async () => {
    const a = await provider("primary", "ok");
    const b = await provider("secondary", "ok");
    const r = new ModelRouter({ providers: [{ name: "primary", url: a.url }, { name: "secondary", url: b.url }], timeoutMs: 500 });
    const res = await r.route(body);
    expect(res.provider).toBe("primary");
    expect(res.totalTokens).toBeGreaterThan(0);
    expect(b.p.calls).toBe(0);
  });

  it("fails over on 429 from the primary", async () => {
    const a = await provider("primary", "429");
    const b = await provider("secondary", "ok");
    const r = new ModelRouter({ providers: [{ name: "primary", url: a.url }, { name: "secondary", url: b.url, model: "backup-model" }], timeoutMs: 500 });
    const res = await r.route(body);
    expect(res.provider).toBe("secondary");
    expect((res.body as { model: string }).model).toBe("backup-model"); // model override applied
    expect(res.attempts.map((x) => x.outcome)).toEqual(["rate_limited", "ok"]);
  });

  it("fails over when the primary exceeds the timeout", async () => {
    const a = await provider("primary", "hang");
    const b = await provider("secondary", "ok");
    const r = new ModelRouter({ providers: [{ name: "primary", url: a.url }, { name: "secondary", url: b.url }], timeoutMs: 200 });
    const t0 = Date.now();
    const res = await r.route(body);
    expect(res.provider).toBe("secondary");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(res.attempts[0].ms).toBeGreaterThanOrEqual(190);
  });

  it("fails over when the primary is unreachable", async () => {
    const b = await provider("secondary", "ok");
    const r = new ModelRouter({ providers: [{ name: "primary", url: "http://127.0.0.1:1/v1" }, { name: "secondary", url: b.url }], timeoutMs: 500 });
    expect((await r.route(body)).provider).toBe("secondary");
  });

  it("fails over on a malformed primary body", async () => {
    const a = await provider("primary", "garbage");
    const b = await provider("secondary", "ok");
    const r = new ModelRouter({ providers: [{ name: "primary", url: a.url }, { name: "secondary", url: b.url }], timeoutMs: 500 });
    expect((await r.route(body)).provider).toBe("secondary");
  });

  it("does NOT fail over on a non-429 error status and never leaks the upstream body", async () => {
    const a = await provider("primary", "500");
    const b = await provider("secondary", "ok");
    const r = new ModelRouter({ providers: [{ name: "primary", url: a.url }, { name: "secondary", url: b.url }], timeoutMs: 500 });
    const err = await r.route(body).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe("upstream_error");
    const client = JSON.stringify(err.toBody("req-1"));
    expect(client).not.toMatch(/handler\.js|boom|at InternalHandler|127\.0\.0\.1/);
    expect(b.p.calls).toBe(0);
  });

  it("reports all_providers_failed when every provider fails, carrying the upstream retry-after", async () => {
    const a = await provider("primary", "429");
    const b = await provider("secondary", "429");
    const r = new ModelRouter({ providers: [{ name: "primary", url: a.url }, { name: "secondary", url: b.url }], timeoutMs: 500 });
    const err = (await r.route(body).catch((e) => e)) as GatewayError;
    expect(err.code).toBe("all_providers_failed");
    expect(err.toBody("x")).toEqual({ error: { code: "all_providers_failed", message: "All model providers are unavailable", request_id: "x", retry_after_ms: 1000 } });
  });

  it("treats client cancellation as terminal: no failover to a second paid call", async () => {
    const a = await provider("primary", "hang");
    const b = await provider("secondary", "ok");
    const r = new ModelRouter({ providers: [{ name: "primary", url: a.url }, { name: "secondary", url: b.url }], timeoutMs: 2000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const attempts: import("../src/router.js").Attempt[] = [];
    const err = (await r.route(body, ac.signal, attempts).catch((e) => e)) as GatewayError;
    expect(err.code).toBe("client_closed");
    expect(attempts.map((x) => x.outcome)).toEqual(["cancelled"]);
    expect(b.p.calls).toBe(0);
    // Already-aborted signal: nothing is called at all.
    const err2 = (await r.route(body, ac.signal).catch((e) => e)) as GatewayError;
    expect(err2.code).toBe("client_closed");
    expect(a.p.calls).toBe(1);
  });

  it("does not fail over after a successful slow primary (timer cleared, no double response)", async () => {
    const a = await provider("primary", "ok");
    const b = await provider("secondary", "ok");
    const r = new ModelRouter({ providers: [{ name: "primary", url: a.url }, { name: "secondary", url: b.url }], timeoutMs: 100 });
    const results = await Promise.all(Array.from({ length: 20 }, () => r.route(body)));
    expect(results.every((x) => x.provider === "primary")).toBe(true);
    await new Promise((res) => setTimeout(res, 150));
    expect(b.p.calls).toBe(0);
  });
});
