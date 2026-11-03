/**
 * Streaming PII redactor.
 *
 * Problem: a token stream delivers text in arbitrary slices ("jane.do" | "e@ex" |
 * "ample.com"), so matching each delta on its own misses anything that straddles
 * a boundary. Buffering the whole response fixes that but kills TTFT and memory.
 *
 * Approach: keep only a small *hold-back* tail — the longest suffix of the
 * buffer that could still be the beginning of a sensitive pattern — and emit
 * everything before it immediately. Each pattern has a "partial" regex that
 * recognises its own prefixes; the hold is the max over all of them, capped at
 * MAX_HOLD so a pathological run of pattern characters cannot grow memory.
 * Matches that would straddle the cut pull the cut back to their start —
 * unless the match itself is longer than MAX_HOLD (no real email/card is), in
 * which case it is clipped at the cut and redacted as-is, so memory stays
 * bounded even for an endless "a@b.commmmm…".
 *
 * Memory is O(MAX_HOLD + chunk), latency is one chunk, and output equals what a
 * whole-text redaction would produce (tested across every split point).
 */

export interface RedactorOptions {
  replacement?: string;
  /** Require Luhn-valid digit runs before treating them as card numbers (default true). */
  luhn?: boolean;
  /** Upper bound on held characters (default 256 ≥ max email length). */
  maxHold?: number;
}

interface PatternDef {
  name: "email" | "ssn" | "card";
  /** Complete-match regex, global. */
  full: RegExp;
  /** Anchored-at-end regex matching any prefix of the pattern (used for hold-back). */
  partial: RegExp;
  /** Optional post-filter on a full match. */
  accept?: (m: string) => boolean;
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function buildPatterns(opts: { luhn: boolean }): PatternDef[] {
  return [
    {
      name: "email",
      full: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
      partial: /[A-Za-z0-9._%+-]+(?:@[A-Za-z0-9.-]*)?$/,
    },
    {
      name: "ssn",
      full: /(?<![\d-])\d{3}[- ]\d{2}[- ]\d{4}(?![\d-])/g,
      partial: /\d{1,3}(?:[- ]\d{0,2}(?:[- ]\d{0,4})?)?$/,
    },
    {
      name: "card",
      // 13–19 digits, optional single space/dash separators, not glued to other digits.
      full: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
      partial: /\d(?:[ -]?\d){0,18}[ -]?$/,
      accept: opts.luhn ? (m) => luhnValid(m.replace(/[ -]/g, "")) : undefined,
    },
  ];
}

export class StreamRedactor {
  private buf = "";
  private readonly patterns: PatternDef[];
  private readonly replacement: string;
  private readonly maxHold: number;
  /** Count of redactions performed, by pattern (for metrics/tests). */
  readonly stats: Record<PatternDef["name"], number> = { email: 0, ssn: 0, card: 0 };

  constructor(opts: RedactorOptions = {}) {
    this.replacement = opts.replacement ?? "[REDACTED]";
    this.maxHold = opts.maxHold ?? 256;
    this.patterns = buildPatterns({ luhn: opts.luhn ?? true });
  }

  /** Characters currently held back (bounded by maxHold). */
  get pending(): number {
    return this.buf.length;
  }

  /** Feed a delta; returns text that is safe to emit now (possibly ""). */
  push(chunk: string): string {
    if (chunk.length === 0) return "";
    this.buf += chunk;
    const cut = this.safeCut();
    return this.emit(cut);
  }

  /** End of stream: redact and release everything held. */
  flush(): string {
    return this.emit(this.buf.length);
  }

  private safeCut(): number {
    const n = this.buf.length;
    // Only the tail can be partial; look at the last maxHold+1 chars (+1 so a
    // run longer than maxHold is detected as "over the cap").
    const tailStart = Math.max(0, n - this.maxHold - 1);
    const tail = this.buf.slice(tailStart);
    let hold = 0;
    for (const p of this.patterns) {
      const m = p.partial.exec(tail);
      if (m && m[0].length > hold) hold = m[0].length;
    }
    hold = Math.min(hold, this.maxHold);
    return n - hold;
  }

  private emit(cut: number): string {
    if (cut <= 0) return "";
    // Find complete matches; any that straddles the cut pulls the cut back.
    const matches: Array<{ start: number; end: number; name: PatternDef["name"] }> = [];
    for (const p of this.patterns) {
      p.full.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.full.exec(this.buf)) !== null) {
        if (p.accept && !p.accept(m[0])) continue;
        matches.push({ start: m.index, end: m.index + m[0].length, name: p.name });
      }
    }
    for (const m of matches) {
      if (m.start < cut && m.end > cut) {
        if (m.end - m.start > this.maxHold) m.end = cut; // clip: redact what we have, keep memory bounded
        else cut = m.start;
      }
    }
    if (cut <= 0) return "";

    const inRange = matches.filter((m) => m.end <= cut).sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let pos = 0;
    for (const m of inRange) {
      if (m.start < pos) continue; // overlapped by an earlier (longer) match
      out += this.buf.slice(pos, m.start) + this.replacement;
      this.stats[m.name]++;
      pos = m.end;
    }
    out += this.buf.slice(pos, cut);
    this.buf = this.buf.slice(cut);
    return out;
  }
}

/** Convenience for tests/docs: whole-text redaction with identical rules. */
export function redactText(text: string, opts?: RedactorOptions): string {
  const r = new StreamRedactor(opts);
  return r.push(text) + r.flush();
}
