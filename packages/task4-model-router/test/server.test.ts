import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js";
import { createServer } from "../src/server.js";
import { createMockProvider } from "../src/mock-provider.js";

let url: string;
let primary: ReturnType<typeof createMockProvider>;
let secondary: ReturnType<typeof createMockProvider>;
let dir: string;
let clock = 5_000_000;
const closers: Array<() => Promise<void>> = [];

async function listen(s: import("node:http").Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }));
  return (s.address() as AddressInfo).port;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-srv-"));
  primary = createMockProvider("primary", "ok");
  secondary = createMockProvider("secondary", "ok");
  const pp = await listen(primary.server);
  const sp = await listen(secondary.server);
  const server = createServer({
    db: openDb(path.join(dir, "gw.db")),
    limiter: { limitTokens: 2000, windowMs: 60_000, now: () => clock },
    router: {
      timeoutMs: 200,
      providers: [
        { name: "primary", url: `http://127.0.0.1:${pp}/v1/chat/completions` },
        { name: "secondary", url: `http://127.0.0.1:${sp}/v1/chat/completions` },
      ],
    },
    log: () => {},
  });
  url = `http://127.0.0.1:${await listen(server)}/v1/chat/completions`;
});
afterAll(async () => {
  while (closers.length) await closers.pop()!();
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown, key: string | null = "tenant-A") =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });

const msg = (text: string, max_tokens?: number) => ({ model: "m", messages: [{ role: "user", content: text }], ...(max_tokens ? { max_tokens } : {}) });

describe("router HTTP server", () => {
  it("proxies a completion and reports the provider + rate-limit headers", async () => {
    const res = await post(msg("hello", 100));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-provider")).toBe("primary");
    expect(res.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
    expect(Number(res.headers.get("x-ratelimit-remaining-tokens"))).toBeLessThan(2000);
    const body = await res.json();
    expect(body.choices[0].message.content).toContain("echo: hello");
  });

  it("standardizes auth and validation errors", async () => {
    expect((await (await post(msg("x"), null)).json()).error.code).toBe("unauthorized");
    expect((await (await post("{nope")).json()).error.code).toBe("bad_request");
    expect((await (await post({ model: "m" })).json()).error.code).toBe("bad_request");
  });

  it("enforces the per-tenant token window and settles with actual usage", async () => {
    // Fresh tenant, budget 2000. Each call reserves ~prompt/4 + max_tokens, then settles to actual (small).
    const r1 = await post(msg("a".repeat(400), 1500), "tenant-B"); // reserve ~1604, settle ~110
    expect(r1.status).toBe(200);
    const r2 = await post(msg("b".repeat(400), 1500), "tenant-B"); // fits only because r1 settled down
    expect(r2.status).toBe(200);
    const r3 = await post(msg("c", 1900), "tenant-B");
    expect(r3.status).toBe(429);
    expect(r3.headers.get("retry-after")).toBeTruthy();
    const body = await r3.json();
    expect(body.error).toMatchObject({ code: "rate_limited", retry_after_ms: expect.any(Number) });
    expect(body.error.request_id).toBe(r3.headers.get("x-request-id"));
    clock += 60_001; // window slides
    expect((await post(msg("c", 1900), "tenant-B")).status).toBe(200);
  });

  it("fails over to the secondary on 429 / timeout and releases the reservation on total failure", async () => {
    primary.mode = "429";
    let res = await post(msg("failover", 50), "tenant-C");
    expect(res.headers.get("x-gateway-provider")).toBe("secondary");

    primary.mode = "hang";
    res = await post(msg("failover2", 50), "tenant-C");
    expect(res.headers.get("x-gateway-provider")).toBe("secondary");

    secondary.mode = "500";
    primary.mode = "429";
    res = await post(msg("both", 50), "tenant-C");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("upstream_error");
    expect(JSON.stringify(body)).not.toMatch(/handler\.js|boom|127\.0\.0\.1/);
    primary.mode = "ok";
    secondary.mode = "ok";
  });

  it("never over-admits under concurrent load", async () => {
    // tenant-D: budget 2000. 400-char prompt + max_tokens 100 reserves 204; the mock
    // echoes the prompt so actual usage settles to ~205 -> at most 9 can ever fit.
    const results = await Promise.all(Array.from({ length: 60 }, () => post(msg("x".repeat(400), 100), "tenant-D")));
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429).length;
    expect(ok + limited).toBe(60);
    expect(ok).toBeLessThanOrEqual(9);
    expect(ok).toBeGreaterThanOrEqual(8);
  });
});
