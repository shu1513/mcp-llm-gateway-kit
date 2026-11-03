/** Incremental Server-Sent Events parser: feed raw bytes/text, get `data:` payloads. */
export class SseParser {
  private partial = "";
  private dataLines: string[] = [];
  private dataBytes = 0;

  /** @param maxEventBytes upper bound on one event's data (and on an unterminated line); exceeding it throws. */
  constructor(private readonly maxEventBytes = 1_000_000) {}

  /** Returns the complete event data payloads found so far. */
  feed(text: string): string[] {
    this.partial += text;
    if (this.partial.length > this.maxEventBytes) throw new Error("SSE line exceeds maxEventBytes");
    const out: string[] = [];
    let nl: number;
    while ((nl = this.partial.indexOf("\n")) !== -1) {
      let line = this.partial.slice(0, nl);
      this.partial = this.partial.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.dataLines.length > 0) {
          out.push(this.dataLines.join("\n"));
          this.dataLines = [];
          this.dataBytes = 0;
        }
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keep-alive
      if (line.startsWith("data:")) {
        const d = line.slice(5).replace(/^ /, "");
        this.dataBytes += d.length;
        if (this.dataBytes > this.maxEventBytes) throw new Error("SSE event exceeds maxEventBytes");
        this.dataLines.push(d);
      }
      // event:/id:/retry: fields are ignored; OpenAI-style streams only use data:
    }
    return out;
  }

  /** Flush a trailing event that lacked its blank-line terminator. */
  end(): string[] {
    const out = this.feed("\n\n");
    this.partial = "";
    return out;
  }
}

export function sseEvent(data: string): string {
  return `data: ${data}\n\n`;
}
