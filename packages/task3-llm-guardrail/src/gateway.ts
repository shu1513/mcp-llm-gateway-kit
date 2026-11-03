/**
 * Task 3: LLM gateway with a streaming PII guardrail.
 *
 * POST /v1/chat/completions (OpenAI-compatible body) -> forwarded to UPSTREAM_URL
 * with stream:true -> upstream SSE deltas pass through StreamRedactor -> SSE to
 * the client. Nothing is accumulated: only the redactor's bounded hold-back
 * tail and the current SSE line fragment live in memory.
 *
 * Chunk mapping: each upstream delta's `choices[0].delta.content` is pushed
 * into the redactor; whatever becomes safe is emitted as a chunk that keeps
 * the upstream chunk's id/model/created. A finish_reason / [DONE] triggers
 * flush() before being passed on, so the final held text precedes the end.
 */
import http from "node:http";
import { StreamRedactor, type RedactorOptions } from "./redactor.js";
import { SseParser, sseEvent } from "./sse.js";

export interface GuardrailGatewayOptions {
  upstreamUrl: string;
  upstreamApiKey?: string;
  redactor?: RedactorOptions;
  maxBodyBytes?: number;
  log?: (msg: string, extra?: unknown) => void;
}

interface OpenAiChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{ index?: number; delta?: { role?: string; content?: string | null }; finish_reason?: string | null }>;
  usage?: unknown;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c;
      if (raw.length > limit) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function errorJson(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "gateway_error" } }));
}

export function createGuardrailGateway(opts: GuardrailGatewayOptions): http.Server {
  const log = opts.log ?? ((msg, extra) => process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), msg, extra }) + "\n"));
  const maxBody = opts.maxBodyBytes ?? 1_000_000;

  return http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      errorJson(res, 404, "Not found");
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req, maxBody));
    } catch {
      errorJson(res, 400, "Invalid JSON body");
      return;
    }
    body.stream = true; // guardrail only operates on streams; non-stream callers still get SSE

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    let upstream: Response;
    try {
      upstream = await fetch(opts.upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(opts.upstreamApiKey ? { authorization: `Bearer ${opts.upstreamApiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      log("upstream fetch failed", { name: (e as Error).name });
      errorJson(res, 502, "Upstream unavailable");
      return;
    }
    if (!upstream.ok || !upstream.body) {
      log("upstream error status", { status: upstream.status });
      errorJson(res, 502, `Upstream returned ${upstream.status}`);
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();

    const redactor = new StreamRedactor(opts.redactor);
    const parser = new SseParser();
    let template: OpenAiChunk = {};
    let choiceIndex = 0;

    const emitText = (text: string) => {
      if (!text) return;
      const chunk: OpenAiChunk = { ...template, object: "chat.completion.chunk", choices: [{ index: choiceIndex, delta: { content: text }, finish_reason: null }] };
      res.write(sseEvent(JSON.stringify(chunk)));
    };

    const handleEvent = (data: string) => {
      if (data === "[DONE]") {
        emitText(redactor.flush());
        res.write(sseEvent("[DONE]"));
        return;
      }
      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return; // skip malformed upstream frame rather than poison the stream
      }
      const { choices, ...rest } = chunk;
      template = { ...template, ...rest };
      const choice = choices?.[0];
      if (!choice) {
        res.write(sseEvent(JSON.stringify(chunk))); // e.g. usage-only chunk
        return;
      }
      choiceIndex = choice.index ?? 0;
      const content = choice.delta?.content;
      if (typeof content === "string" && content.length > 0) emitText(redactor.push(content));
      if (choice.finish_reason) {
        emitText(redactor.flush());
        res.write(sseEvent(JSON.stringify({ ...template, choices: [{ index: choiceIndex, delta: {}, finish_reason: choice.finish_reason }] })));
      } else if (choice.delta?.role) {
        res.write(sseEvent(JSON.stringify({ ...template, choices: [{ index: choiceIndex, delta: { role: choice.delta.role }, finish_reason: null }] })));
      }
    };

    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const ev of parser.feed(decoder.decode(value, { stream: true }))) handleEvent(ev);
      }
      for (const ev of parser.end()) handleEvent(ev);
      emitText(redactor.flush()); // upstream closed without [DONE]
    } catch (e) {
      log("stream aborted", { name: (e as Error).name });
    } finally {
      log("stream complete", { redactions: redactor.stats });
      res.end();
    }
  });
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8090);
  const upstreamUrl = process.env.UPSTREAM_URL ?? "http://127.0.0.1:8091/v1/chat/completions";
  createGuardrailGateway({ upstreamUrl, upstreamApiKey: process.env.UPSTREAM_API_KEY }).listen(port, () =>
    process.stderr.write(`llm-guardrail gateway on :${port} -> ${upstreamUrl}\n`),
  );
}
