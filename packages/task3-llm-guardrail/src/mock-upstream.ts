/**
 * Mock OpenAI-compatible streaming upstream. Streams the configured text in
 * fixed-size slices with a delay between them, so PII is split across SSE
 * frames (the hard case) and TTFT is measurable.
 */
import http from "node:http";
import { sseEvent } from "./sse.js";

export interface MockUpstreamOptions {
  text: string;
  sliceSize?: number;
  delayMs?: number;
  /** Delay before the very first content chunk (default 0). */
  firstDelayMs?: number;
}

export function createMockUpstream(opts: MockUpstreamOptions): http.Server {
  const slice = opts.sliceSize ?? 4;
  const delay = opts.delayMs ?? 5;
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}") as { messages?: Array<{ content?: string }> };
      // "echo:" prompts stream the prompt itself; otherwise the configured text.
      const prompt = body.messages?.at(-1)?.content ?? "";
      const text = prompt.startsWith("echo:") ? prompt.slice(5) : opts.text;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1700000000, model: "mock-1" };
      res.write(sseEvent(JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })));
      if (opts.firstDelayMs) await new Promise((r) => setTimeout(r, opts.firstDelayMs));
      for (let i = 0; i < text.length; i += slice) {
        res.write(sseEvent(JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + slice) }, finish_reason: null }] })));
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
      res.write(sseEvent(JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })));
      res.write(sseEvent("[DONE]"));
      res.end();
    });
  });
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8091);
  const text =
    process.env.MOCK_TEXT ??
    "Sure. Reach Jane at jane.doe@example.com or 555-01-2345 (SSN) and bill card 4111 1111 1111 1111. Order #1234 5678 9012 3456 is fine.";
  createMockUpstream({ text, sliceSize: 3, delayMs: 20 }).listen(port, () => process.stderr.write(`mock upstream on :${port}\n`));
}
