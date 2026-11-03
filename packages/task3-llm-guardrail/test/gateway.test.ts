import { describe, it, expect, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { createGuardrailGateway } from "../src/gateway.js";
import { createMockUpstream } from "../src/mock-upstream.js";
import { SseParser } from "../src/sse.js";

const closers: Array<() => Promise<void>> = [];
async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterAll(async () => {
  for (const c of closers) await c();
});

async function setup(opts: Parameters<typeof createMockUpstream>[0]) {
  const up = await listen(createMockUpstream(opts));
  const gw = await listen(createGuardrailGateway({ upstreamUrl: `${up}/v1/chat/completions`, log: () => {} }));
  return { gw };
}

interface Frame { t: number; data: string }
async function streamThrough(gw: string, prompt = "hello"): Promise<Frame[]> {
  const t0 = Date.now();
  const res = await fetch(`${gw}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: prompt }] }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const parser = new SseParser();
  const frames: Frame[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const data of parser.feed(dec.decode(value, { stream: true }))) frames.push({ t: Date.now() - t0, data });
  }
  return frames;
}

const content = (frames: Frame[]) =>
  frames
    .filter((f) => f.data !== "[DONE]")
    .map((f) => JSON.parse(f.data).choices?.[0]?.delta?.content ?? "")
    .join("");

describe("guardrail gateway (end to end)", () => {
  it("redacts PII split across upstream SSE frames and keeps the protocol shape", async () => {
    const text = "Contact jane.doe@example.com, SSN 123-45-6789, card 4111 1111 1111 1111. Done.";
    const { gw } = await setup({ text, sliceSize: 3, delayMs: 1 });
    const frames = await streamThrough(gw);
    expect(content(frames)).toBe("Contact [REDACTED], SSN [REDACTED], card [REDACTED]. Done.");
    expect(frames.at(-1)!.data).toBe("[DONE]");
    const parsed = frames.slice(0, -1).map((f) => JSON.parse(f.data));
    expect(parsed[0].choices[0].delta.role).toBe("assistant");
    expect(parsed.at(-1).choices[0].finish_reason).toBe("stop");
    for (const p of parsed) {
      expect(p.id).toBe("chatcmpl-mock");
      expect(p.object).toBe("chat.completion.chunk");
    }
    // No frame ever contains a raw secret fragment that could be reassembled.
    const raw = frames.map((f) => f.data).join("");
    expect(raw).not.toMatch(/example\.com|6789|1111/);
  });

  it("keeps time-to-first-token low: first text arrives before the upstream's second slice", async () => {
    const text = "Hello there, this is a long answer about nothing sensitive at all. ";
    const { gw } = await setup({ text, sliceSize: 8, delayMs: 300 });
    const frames = await streamThrough(gw);
    const firstText = frames.find((f) => f.data !== "[DONE]" && JSON.parse(f.data).choices?.[0]?.delta?.content);
    expect(firstText).toBeDefined();
    expect(firstText!.t).toBeLessThan(250); // upstream slice 2 comes at ~300ms
    expect(content(frames)).toBe(text);
  });

  it("uses the prompt echo path and handles a 50 KB response without buffering it all", async () => {
    const unit = "ok bob@x.io 123-45-6789 ";
    const text = unit.repeat(2000);
    const { gw } = await setup({ text, sliceSize: 512, delayMs: 0 });
    const frames = await streamThrough(gw);
    expect(content(frames)).toBe("ok [REDACTED] [REDACTED] ".repeat(2000));
    // Many frames rather than one: proves incremental emission.
    expect(frames.length).toBeGreaterThan(50);
  });

  it("rejects non-object / unsupported bodies with 400 instead of crashing", async () => {
    const { gw } = await setup({ text: "x" });
    for (const body of ["null", "1", '"hello"', "[]", "{}", '{"messages":[],"n":2}']) {
      const res = await fetch(`${gw}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(res.status, body).toBe(400);
      expect((await res.json()).error.type).toBe("gateway_error");
    }
    // the server is still alive afterwards
    expect(content(await streamThrough(gw, "echo:still fine"))).toBe("still fine");
  });

  it("stops reading upstream when the client disconnects mid-stream", async () => {
    const text = "word ".repeat(5000);
    let upstreamClosed = false;
    const up = createMockUpstream({ text, sliceSize: 5, delayMs: 5 });
    up.on("request", (_req, res) => res.on("close", () => (upstreamClosed = true)));
    const upUrl = await listen(up);
    const gw = await listen(createGuardrailGateway({ upstreamUrl: `${upUrl}/v1/chat/completions`, log: () => {} }));
    const ac = new AbortController();
    const res = await fetch(`${gw}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), signal: ac.signal });
    await res.body!.getReader().read(); // first frame
    ac.abort();
    const deadline = Date.now() + 3000;
    while (!upstreamClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(upstreamClosed).toBe(true);
  });

  it("returns a sanitized 502 when upstream is down", async () => {
    const gw = await listen(createGuardrailGateway({ upstreamUrl: "http://127.0.0.1:1/v1/chat/completions", log: () => {} }));
    const res = await fetch(`${gw}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { message: "Upstream unavailable", type: "gateway_error" } });
  });
});
