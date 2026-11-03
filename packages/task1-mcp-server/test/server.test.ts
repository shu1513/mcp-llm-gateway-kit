import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "../src/server.ts");
const tsx = path.resolve(here, "../../../node_modules/.bin/tsx");

describe("customer-ops MCP server (via SDK client)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: tsx, args: [serverPath], stderr: "pipe" }));
  });
  afterAll(async () => {
    await client.close();
  });

  it("lists both tools with schemas that mirror the Zod rules", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_customer_record", "trigger_refund"]);
    const refund = tools.find((t) => t.name === "trigger_refund")!;
    expect(refund.inputSchema).toMatchObject({
      required: ["customer_id", "amount", "reason"],
      additionalProperties: false,
      properties: { customer_id: { pattern: "^CUST-[A-Z0-9]{5}$" }, amount: { type: "number", exclusiveMinimum: 0 }, reason: { minLength: 10 } },
    });
  });

  it("returns a customer record for a well-formed id", async () => {
    const res = await client.callTool({ name: "get_customer_record", arguments: { customer_id: "CUST-00001" } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { name: string }).name).toBe("Ada Lovelace");
  });

  it("rejects a malformed customer_id with -32602 Invalid params", async () => {
    await expect(
      client.callTool({ name: "get_customer_record", arguments: { customer_id: "cust-1" } }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it.each([
    ["negative amount", { customer_id: "CUST-00001", amount: -5, reason: "duplicate charge on invoice" }],
    ["zero amount", { customer_id: "CUST-00001", amount: 0, reason: "duplicate charge on invoice" }],
    ["amount as string", { customer_id: "CUST-00001", amount: "12.5", reason: "duplicate charge on invoice" }],
    ["short reason", { customer_id: "CUST-00001", amount: 12.5, reason: "oops" }],
    ["whitespace reason", { customer_id: "CUST-00001", amount: 12.5, reason: "             " }],
    ["missing reason", { customer_id: "CUST-00001", amount: 12.5 }],
    ["unknown field", { customer_id: "CUST-00001", amount: 12.5, reason: "duplicate charge on invoice", force: true }],
  ])("trigger_refund rejects %s with -32602", async (_label, args) => {
    const err = await client.callTool({ name: "trigger_refund", arguments: args as Record<string, unknown> }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
  });

  it("issues a refund for a valid request", async () => {
    const res = await client.callTool({
      name: "trigger_refund",
      arguments: { customer_id: "CUST-A1B2C", amount: 12.5, reason: "duplicate charge on invoice 42" },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ customer_id: "CUST-A1B2C", amount: 12.5 });
  });

  it("reports business-rule failures as tool errors, not protocol errors", async () => {
    const missing = await client.callTool({ name: "get_customer_record", arguments: { customer_id: "CUST-ZZZZZ" } });
    expect(missing.isError).toBe(true);
    const suspended = await client.callTool({
      name: "trigger_refund",
      arguments: { customer_id: "CUST-00002", amount: 1, reason: "goodwill credit for outage" },
    });
    expect(suspended.isError).toBe(true);
  });

  it("returns -32602 for an unknown tool", async () => {
    await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it("returns -32601 for an unknown method", async () => {
    await expect(client.request({ method: "tools/nope" }, undefined as never)).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
    });
  });
});

describe("stdio isolation", () => {
  // Launch exactly as the README documents (npm wrapper included): a `> script`
  // banner from npm would land on stdout and fail the JSON check below.
  const root = path.resolve(here, "../../..");
  it("writes only JSON-RPC frames to stdout; logs go to stderr", async () => {
    const child = spawn("npm", ["run", "-s", "task1"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const frames = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_customer_record", arguments: { customer_id: "CUST-00001" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_customer_record", arguments: { customer_id: "nope" } } },
      "this is not json\n",
      { jsonrpc: "1.0", id: 99, method: "tools/list" },
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
    ];
    for (const f of frames) child.stdin.write(typeof f === "string" ? f : JSON.stringify(f) + "\n");

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !/"id":4/.test(out)) await new Promise((r) => setTimeout(r, 50));
    child.kill();

    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const msg = JSON.parse(line); // throws if any non-JSON leaked onto stdout
      expect(msg.jsonrpc).toBe("2.0");
    }
    const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).filter((m) => m.id !== undefined).map((m) => [m.id, m]));
    expect(byId[2].result).toBeDefined();
    expect(byId[3].error.code).toBe(-32602);
    expect(byId[4].result.tools).toHaveLength(2); // survived the garbage frames
    const nullIdErrors = lines.map((l) => JSON.parse(l)).filter((m) => m.id === null).map((m) => m.error.code);
    expect(nullIdErrors).toEqual([-32700, -32600]); // parse error, then invalid request (jsonrpc 1.0)

    expect(err).toContain('"level":"info"'); // logs landed on stderr
    expect(out).not.toContain('"level":"info"');
  });
});
