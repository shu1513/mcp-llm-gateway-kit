import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { SlidingWindowRateLimiter } from "../src/rateLimiter.js";

let dir: string;
let db: Db;
let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"));
  db = openDb(path.join(dir, "test.db"));
  clock = 1_000_000;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SlidingWindowRateLimiter", () => {
  it("admits until the token budget is reached, then rejects with retry_after", () => {
    const rl = new SlidingWindowRateLimiter(db, { limitTokens: 1000, windowMs: 60_000, now });
    expect(rl.reserve("t1", 400)).toMatchObject({ allowed: true, usedTokens: 400, remainingTokens: 600 });
    clock += 10_000;
    expect(rl.reserve("t1", 500)).toMatchObject({ allowed: true, usedTokens: 900, remainingTokens: 100 });
    clock += 10_000;
    const rej = rl.reserve("t1", 200);
    expect(rej.allowed).toBe(false);
    // Need 100 more tokens freed: the 400-token row (t=1,000,000) expires at +60s -> 40s from now.
    expect(rej).toMatchObject({ usedTokens: 900, remainingTokens: 100, retryAfterMs: 40_000 });
  });

  it("is per tenant", () => {
    const rl = new SlidingWindowRateLimiter(db, { limitTokens: 100, windowMs: 60_000, now });
    expect(rl.reserve("a", 100).allowed).toBe(true);
    expect(rl.reserve("b", 100).allowed).toBe(true);
    expect(rl.reserve("a", 1).allowed).toBe(false);
  });

  it("slides: old usage falls out of the window exactly at its boundary", () => {
    const rl = new SlidingWindowRateLimiter(db, { limitTokens: 100, windowMs: 1000, now });
    rl.reserve("t", 100);
    clock += 999;
    expect(rl.reserve("t", 1).allowed).toBe(false);
    clock += 1; // row ts + window == now -> expired (ts > cutoff is strict)
    expect(rl.reserve("t", 100).allowed).toBe(true);
    expect(rl.usage("t")).toBe(100);
  });

  it("evicts expired rows from disk", () => {
    const rl = new SlidingWindowRateLimiter(db, { limitTokens: 10_000, windowMs: 1000, now });
    for (let i = 0; i < 50; i++) rl.reserve("t", 10);
    expect(db.prepare("SELECT COUNT(*) AS n FROM token_usage").get()).toEqual({ n: 50 });
    clock += 2000;
    expect(rl.evict()).toBe(50);
    expect(db.prepare("SELECT COUNT(*) AS n FROM token_usage").get()).toEqual({ n: 0 });
  });

  it("settle replaces the estimate with actual usage", () => {
    const rl = new SlidingWindowRateLimiter(db, { limitTokens: 1000, windowMs: 60_000, now });
    const r = rl.reserve("t", 800);
    if (!r.allowed) throw new Error("unexpected");
    expect(rl.reserve("t", 300).allowed).toBe(false);
    rl.settle(r.reservationId, 120);
    expect(rl.usage("t")).toBe(120);
    expect(rl.reserve("t", 300).allowed).toBe(true);
  });

  it("never over-admits under concurrency (two limiter instances on the same file)", async () => {
    const limit = 5000;
    const a = new SlidingWindowRateLimiter(db, { limitTokens: limit, windowMs: 60_000, now });
    const db2 = openDb(path.join(dir, "test.db"));
    const b = new SlidingWindowRateLimiter(db2, { limitTokens: limit, windowMs: 60_000, now });
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => Promise.resolve().then(() => (i % 2 ? a : b).reserve("t", 100))),
    );
    const admitted = results.filter((r) => r.allowed).length;
    expect(admitted).toBe(limit / 100);
    expect(a.usage("t")).toBe(limit);
    db2.close();
  });

  it("rejects a single request larger than the whole budget with retry_after = Infinity", () => {
    const rl = new SlidingWindowRateLimiter(db, { limitTokens: 100, windowMs: 1000, now });
    expect(rl.reserve("t", 101)).toMatchObject({ allowed: false, retryAfterMs: Infinity });
  });
});
