import { describe, it, expect } from "vitest";
import { StreamRedactor, redactText, luhnValid } from "../src/redactor.js";

const SAMPLE =
  "Hi Jane, email jane.doe+billing@sub.example.co.uk and SSN 123-45-6789 or 123 45 6789. " +
  "Card 4111 1111 1111 1111, also 4111-1111-1111-1111 and 4111111111111111. " +
  "Order 1234 5678 9012 3456 stays, phone 555-0100 stays, year 2024 stays, ip 10.0.0.1 stays. bob@x.io";

const EXPECTED =
  "Hi Jane, email [REDACTED] and SSN [REDACTED] or [REDACTED]. " +
  "Card [REDACTED], also [REDACTED] and [REDACTED]. " +
  "Order 1234 5678 9012 3456 stays, phone 555-0100 stays, year 2024 stays, ip 10.0.0.1 stays. [REDACTED]";

describe("whole-text rules", () => {
  it("redacts emails, SSNs and Luhn-valid cards; leaves look-alikes", () => {
    expect(redactText(SAMPLE)).toBe(EXPECTED);
  });
  it("luhn", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("1234567890123456")).toBe(false);
  });
  it("can disable Luhn to redact any 13-19 digit run", () => {
    expect(redactText("Order 1234 5678 9012 3456 now", { luhn: false })).toBe("Order [REDACTED] now");
  });
  it("does not treat digits glued to a longer run as a card", () => {
    expect(redactText("id 41111111111111112345678")).toBe("id 41111111111111112345678");
  });
});

describe("streaming equivalence", () => {
  it("produces identical output for every slice size", () => {
    for (let size = 1; size <= 24; size++) {
      const r = new StreamRedactor();
      let out = "";
      for (let i = 0; i < SAMPLE.length; i += size) out += r.push(SAMPLE.slice(i, i + size));
      out += r.flush();
      expect(out, `slice=${size}`).toBe(EXPECTED);
    }
  });

  it("produces identical output for random slicing", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let trial = 0; trial < 200; trial++) {
      const r = new StreamRedactor();
      let out = "";
      let i = 0;
      while (i < SAMPLE.length) {
        const n = 1 + Math.floor(rnd() * 12);
        out += r.push(SAMPLE.slice(i, i + n));
        i += n;
      }
      out += r.flush();
      expect(out).toBe(EXPECTED);
    }
  });

  it("emits plain prose immediately (low latency), holding only a possible prefix", () => {
    const r = new StreamRedactor();
    expect(r.push("The quick brown fox ")).toBe("The quick brown fox ");
    expect(r.pending).toBe(0);
    expect(r.push("jumps over jane")).toBe("jumps over ");
    expect(r.pending).toBe(4); // "jane" could be the start of an email
    expect(r.push(".doe@exa")).toBe("");
    expect(r.push("mple.com today")).toBe("[REDACTED] ");
    expect(r.flush()).toBe("today");
  });

  it("holds a trailing digit run until it is resolved", () => {
    const r = new StreamRedactor();
    expect(r.push("card 4111 1111 1111 ")).toBe("card ");
    expect(r.push("1111")).toBe("");
    expect(r.push(" ok")).toBe("[REDACTED] ");
    expect(r.flush()).toBe("ok");
  });

  it("bounds memory: held text never exceeds maxHold even for an endless token", () => {
    const r = new StreamRedactor({ maxHold: 64 });
    let maxPending = 0;
    for (let i = 0; i < 5000; i++) {
      r.push("a");
      maxPending = Math.max(maxPending, r.pending);
    }
    expect(maxPending).toBeLessThanOrEqual(64);
  });

  it("handles a 200 KB stream with bounded buffer", () => {
    const big = (SAMPLE + " ").repeat(600);
    const r = new StreamRedactor();
    let out = "";
    let maxPending = 0;
    for (let i = 0; i < big.length; i += 7) {
      out += r.push(big.slice(i, i + 7));
      maxPending = Math.max(maxPending, r.pending);
    }
    out += r.flush();
    expect(out).toBe((EXPECTED + " ").repeat(600));
    expect(maxPending).toBeLessThanOrEqual(256);
    expect(r.stats).toEqual({ email: 1200, ssn: 1200, card: 1800 });
  });
});
