/**
 * Token-aware sliding-window rate limiter backed by SQLite.
 *
 * Each admitted request inserts a (tenant, ts, tokens) row; usage in the last
 * `windowMs` is SUM(tokens) over that tenant's rows with ts > now - window.
 * Decisions run inside BEGIN IMMEDIATE so concurrent requests (even across
 * processes sharing the .db file) cannot both see headroom and both commit.
 *
 * Flow: reserve(estimate) before calling the model -> settle(actual) after, so
 * the window reflects real usage while still being enforced up front.
 * evict() deletes rows older than the window (called on every reserve for the
 * tenant, plus a periodic global sweep).
 */
import type { Db } from "./db.js";

export interface RateLimiterOptions {
  limitTokens: number; // e.g. 50_000
  windowMs: number; // e.g. 60_000
  now?: () => number;
}

export interface Reservation {
  allowed: true;
  reservationId: number;
  usedTokens: number; // including this reservation
  remainingTokens: number;
}

export interface Rejection {
  allowed: false;
  usedTokens: number;
  remainingTokens: number;
  retryAfterMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly now: () => number;
  private readonly stmts;
  private readonly reserveTx: (tenant: string, tokens: number) => Reservation | Rejection;

  constructor(
    private readonly db: Db,
    private readonly opts: RateLimiterOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.stmts = {
      evictTenant: db.prepare("DELETE FROM token_usage WHERE tenant_key = ? AND ts_ms <= ?"),
      evictAll: db.prepare("DELETE FROM token_usage WHERE ts_ms <= ?"),
      sum: db.prepare("SELECT COALESCE(SUM(tokens), 0) AS used FROM token_usage WHERE tenant_key = ? AND ts_ms > ?"),
      insert: db.prepare("INSERT INTO token_usage (tenant_key, ts_ms, tokens) VALUES (?, ?, ?)"),
      oldest: db.prepare("SELECT ts_ms, tokens FROM token_usage WHERE tenant_key = ? AND ts_ms > ? ORDER BY ts_ms ASC"),
      settle: db.prepare("UPDATE token_usage SET tokens = ? WHERE id = ?"),
    };

    this.reserveTx = db.transaction((tenant: string, tokens: number): Reservation | Rejection => {
      const now = this.now();
      const cutoff = now - this.opts.windowMs;
      this.stmts.evictTenant.run(tenant, cutoff);
      const { used } = this.stmts.sum.get(tenant, cutoff) as { used: number };

      if (used + tokens > this.opts.limitTokens) {
        return {
          allowed: false,
          usedTokens: used,
          remainingTokens: Math.max(0, this.opts.limitTokens - used),
          retryAfterMs: this.retryAfter(tenant, cutoff, used, tokens, now),
        };
      }
      const info = this.stmts.insert.run(tenant, now, tokens);
      return {
        allowed: true,
        reservationId: Number(info.lastInsertRowid),
        usedTokens: used + tokens,
        remainingTokens: this.opts.limitTokens - used - tokens,
      };
    }).immediate as (tenant: string, tokens: number) => Reservation | Rejection;
  }

  /** Atomically check headroom and record `estimatedTokens` for the tenant. */
  reserve(tenant: string, estimatedTokens: number): Reservation | Rejection {
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) throw new Error("estimatedTokens must be a non-negative number");
    return this.reserveTx(tenant, Math.ceil(estimatedTokens));
  }

  /** Replace the estimate with the provider-reported usage (or 0 if the call failed). */
  settle(reservationId: number, actualTokens: number): void {
    this.stmts.settle.run(Math.max(0, Math.ceil(actualTokens)), reservationId);
  }

  /** Global sweep of expired rows; returns rows removed. */
  evict(): number {
    return this.stmts.evictAll.run(this.now() - this.opts.windowMs).changes;
  }

  usage(tenant: string): number {
    return (this.stmts.sum.get(tenant, this.now() - this.opts.windowMs) as { used: number }).used;
  }

  /** Walk the window oldest-first until enough tokens would have expired for `want` to fit. */
  private retryAfter(tenant: string, cutoff: number, used: number, want: number, now: number): number {
    if (want > this.opts.limitTokens) return Infinity; // can never fit
    let freed = 0;
    for (const row of this.stmts.oldest.iterate(tenant, cutoff) as Iterable<{ ts_ms: number; tokens: number }>) {
      freed += row.tokens;
      if (used - freed + want <= this.opts.limitTokens) return Math.max(1, row.ts_ms + this.opts.windowMs - now);
    }
    return this.opts.windowMs;
  }
}
