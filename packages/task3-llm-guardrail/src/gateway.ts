/**
 * Task 3: LLM gateway with a streaming PII guardrail.
 *
 * POST /v1/chat/completions (OpenAI-compatible body) -> forwarded to UPSTREAM_URL
 * with stream:true -> upstream SSE deltas pass through StreamRedactor -> SSE to
 * the client. Nothing is accumulated: only the redactor's bounded hold-back
 * tail and the current SSE line fragment live in memory, and writes honour
 * backpressure (we stop reading upstream while the client's socket is full).
 *
 * Chunk mapping: each upstream delta's `choices[0].delta.content` is pushed
 * into the redactor; whatever becomes safe is emitted as a chunk that keeps
 * the upstream chunk's id/model/created. A finish_reason / [DONE] triggers
 * flush() before being passed on, so the final held text precedes the end.
 */
import http from "node:http";
import { once } from "node:events";
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Byte-bounded body read; decodes once at the end so multibyte chars split across chunks survive. */
function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "Payload too large"));
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function errorJson(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "gateway_error" } }));
}

export function createGuardrailGateway(opts: GuardrailGatewayOptions): http.Server {
  const log = opts.log ?? ((msg, extra) => process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), msg, extra }) + "\n"));
  const maxBody = opts.maxBodyBytes ?? 1_000_000;

  return http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      log("request failed", { status, message: (e as Error).message });
      errorJson(res, status, e instanceof HttpError ? e.message : "Internal gateway error");
    }
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") throw new HttpError(404, "Not found");

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, maxBody));
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, "Invalid JSON body");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
    const payload = body as Record<string, unknown>;
    if (!Array.isArray(payload.messages)) throw new HttpError(400, "Body must include messages[]");
    if (payload.n !== undefined && payload.n !== 1) throw new HttpError(400, "Only n=1 is supported by this gateway");
    payload.stream = true; // guardrail only operates on streams; non-stream callers still get SSE

    // Client went away (before or during the response) -> stop pulling from upstream.
    const controller = new AbortController();
    const onClientGone = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on("close", onClientGone);

    let upstream: Response;
    try {
      upstream = await fetch(opts.upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(opts.upstreamApiKey ? { authorization: `Bearer ${opts.upstreamApiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      log("upstream fetch failed", { name: (e as Error).name });
      throw new HttpError(502, "Upstream unavailable");
    }
    if (!upstream.ok || !upstream.body) {
      log("upstream error status", { status: upstream.status });
      throw new HttpError(502, `Upstream returned ${upstream.status}`);
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

    /** Write one SSE frame, waiting for the socket to drain if it is full. */
    const write = async (frame: string): Promise<void> => {
      if (res.destroyed) throw new Error("client disconnected");
      if (!res.write(frame)) await Promise.race([once(res, "drain"), once(res, "close")]);
    };
    const emitText = async (text: string): Promise<void> => {
      if (!text) return;
      const chunk: OpenAiChunk = { ...template, object: "chat.completion.chunk", choices: [{ index: choiceIndex, delta: { content: text }, finish_reason: null }] };
      await write(sseEvent(JSON.stringify(chunk)));
    };

    const handleEvent = async (data: string): Promise<void> => {
      if (data === "[DONE]") {
        await emitText(redactor.flush());
        await write(sseEvent("[DONE]"));
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
        await write(sseEvent(JSON.stringify(chunk))); // e.g. usage-only chunk
        return;
      }
      choiceIndex = choice.index ?? 0;
      const content = choice.delta?.content;
      if (typeof content === "string" && content.length > 0) await emitText(redactor.push(content));
      if (choice.finish_reason) {
        await emitText(redactor.flush());
        await write(sseEvent(JSON.stringify({ ...template, choices: [{ index: choiceIndex, delta: {}, finish_reason: choice.finish_reason }] })));
      } else if (choice.delta?.role) {
        await write(sseEvent(JSON.stringify({ ...template, choices: [{ index: choiceIndex, delta: { role: choice.delta.role }, finish_reason: null }] })));
      }
    };

    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read(); // not called again until the previous frames are drained
        if (done) break;
        for (const ev of parser.feed(decoder.decode(value, { stream: true }))) await handleEvent(ev);
      }
      for (const ev of parser.end()) await handleEvent(ev);
      await emitText(redactor.flush()); // upstream closed without [DONE]
    } catch (e) {
      log("stream aborted", { name: (e as Error).name, message: (e as Error).message });
      controller.abort();
      await reader.cancel().catch(() => {});
    } finally {
      res.off("close", onClientGone);
      log("stream complete", { redactions: redactor.stats });
      res.end();
    }
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8090);
  const upstreamUrl = process.env.UPSTREAM_URL ?? "http://127.0.0.1:8091/v1/chat/completions";
  createGuardrailGateway({ upstreamUrl, upstreamApiKey: process.env.UPSTREAM_API_KEY }).listen(port, () =>
    process.stderr.write(`llm-guardrail gateway on :${port} -> ${upstreamUrl}\n`),
  );
}
