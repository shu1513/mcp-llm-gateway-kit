import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createGateway, type GatewayEvent } from "../src/gateway.js";
import { createMockDownstream } from "../src/mock-downstream.js";

const tokens = new Map<string, "admin" | "viewer">([
  ["tok-admin", "admin"],
  ["tok-viewer", "viewer"],
]);

let downstream: ReturnType<typeof createMockDownstream>;
let gatewayUrl: string;
const events: GatewayEvent[] = [];
const closers: Array<() => Promise<void>> = [];

async function listen(server: import("node:http").Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  downstream = createMockDownstream();
  const dport = await listen(downstream.server);
  const gw = createGateway({ downstreamUrl: `http://127.0.0.1:${dport}/mcp`, tokens, onEvent: (e) => events.push(e) });
  gatewayUrl = `http://127.0.0.1:${await listen(gw)}/mcp`;
});
afterAll(async () => {
  for (const c of closers) await c();
});

const rpc = (token: string | undefined, body: unknown) =>
  fetch(gatewayUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("MCP gateway", () => {
  it("rejects requests without a valid bearer token (401)", async () => {
    const before = downstream.calls.length;
    for (const t of [undefined, "nope", "tok-admin extra"]) {
      const res = await rpc(t, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe(-32001);
    }
    expect(downstream.calls.length).toBe(before);
  });

  it("forwards tools/list transparently for any role", async () => {
    for (const t of ["tok-viewer", "tok-admin"]) {
      const res = await rpc(t, { jsonrpc: "2.0", id: 7, method: "tools/list" });
      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBe("mock-session-1");
      const body = await res.json();
      expect(body.id).toBe(7);
      expect(body.result.tools.map((x: { name: string }) => x.name)).toEqual(["echo", "get_time", "admin_reset_key"]);
    }
  });

  it("blocks admin_ tools for viewers with -32001 and never calls downstream", async () => {
    const before = downstream.calls.length;
    const res = await rpc("tok-viewer", { jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "admin_reset_key", arguments: {} } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: "a",
      error: { code: -32001, message: "Unauthorized Tool Call", data: { tool: "admin_reset_key", role: "viewer", required_role: "admin" } },
    });
    expect(downstream.calls.length).toBe(before);
    expect(events.at(-1)).toMatchObject({ kind: "blocked", tool: "admin_reset_key", role: "viewer" });
  });

  it("forwards admin_ tools for admins", async () => {
    const res = await rpc("tok-admin", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "admin_reset_key", arguments: {} } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.content[0].text).toMatch(/^key rotated/);
    expect(downstream.calls.at(-1)).toMatchObject({ method: "tools/call", params: { name: "admin_reset_key" } });
  });

  it("forwards non-admin tool calls for viewers", async () => {
    const res = await rpc("tok-viewer", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } });
    expect((await res.json()).result.content[0].text).toBe("hi");
  });

  it("does not let a prefix lookalike through (case-sensitive, exact prefix)", async () => {
    const before = downstream.calls.length;
    const res = await rpc("tok-viewer", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "admin_" } });
    expect((await res.json()).error.code).toBe(-32001);
    expect(downstream.calls.length).toBe(before);
  });

  it("rejects tools/call without params.name as -32602", async () => {
    const res = await rpc("tok-admin", { jsonrpc: "2.0", id: 5, method: "tools/call", params: {} });
    expect((await res.json()).error.code).toBe(-32602);
  });

  it("answers batches locally when any member is unauthorized", async () => {
    const before = downstream.calls.length;
    const res = await rpc("tok-viewer", [
      { jsonrpc: "2.0", id: 10, method: "tools/list" },
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "admin_reset_key" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ id: 10, error: { code: -32600 } });
    expect(body[1]).toMatchObject({ id: 11, error: { code: -32001 } });
    expect(downstream.calls.length).toBe(before);
  });

  it("forwards fully-authorized batches", async () => {
    const res = await rpc("tok-admin", [
      { jsonrpc: "2.0", id: 20, method: "ping" },
      { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "admin_reset_key" } },
    ]);
    const body = await res.json();
    expect(body.map((m: { id: number }) => m.id)).toEqual([20, 21]);
  });

  it("returns -32700 / -32600 for malformed payloads", async () => {
    expect((await (await rpc("tok-admin", "{not json")).json()).error.code).toBe(-32700);
    expect((await (await rpc("tok-admin", { hello: "world" })).json()).error.code).toBe(-32600);
    expect((await (await rpc("tok-admin", [])).json()).error.code).toBe(-32600);
  });

  it("returns -32002 when downstream is unreachable", async () => {
    const gw = createGateway({ downstreamUrl: "http://127.0.0.1:1/mcp", tokens, onEvent: () => {} });
    const url = `http://127.0.0.1:${await listen(gw)}/mcp`;
    const res = await fetch(url, { method: "POST", headers: { authorization: "Bearer tok-admin" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe(-32002);
  });
});
