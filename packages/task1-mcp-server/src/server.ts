#!/usr/bin/env node
/**
 * Task 1: MCP server over stdio exposing get_customer_record and trigger_refund.
 *
 * Built on the SDK's low-level `Server` (not `McpServer`) on purpose: the
 * high-level wrapper swallows argument-validation failures into
 * `{ isError: true }` tool results, but this task asks for standard JSON-RPC
 * error codes. Owning the tools/call handler lets us map:
 *
 *  - malformed arguments (bad customer_id format, non-positive amount, short
 *    reason, unknown fields)            -> JSON-RPC error -32602 Invalid params
 *  - unknown tool name                  -> -32602 Invalid params (MCP convention)
 *  - unknown method                     -> -32601 (SDK protocol layer)
 *  - unparseable / non-JSON-RPC frame   -> -32700 / -32600 with id null, sent by
 *                                          our transport error hook (the SDK only
 *                                          logs these); the server keeps serving
 *  - valid args that fail a business rule (no such customer, suspended)
 *                                       -> tool result with isError: true, per
 *                                          the MCP tools spec, so the model can
 *                                          read the failure and recover.
 *
 * Transport hygiene: stdout carries JSON-RPC only. All logging goes through
 * log.ts to stderr, and console.* is rebound to stderr at startup.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { log, protectStdout } from "./log.js";
import { getCustomerRecordSchema, triggerRefundSchema } from "./schemas.js";
import { store } from "./store.js";

protectStdout();

/** JSON Schema advertised via tools/list. Kept in sync with schemas.ts by test. */
export const TOOLS: Tool[] = [
  {
    name: "get_customer_record",
    description: "Fetch a customer's record by id. customer_id must look like CUST-XXXXX (five uppercase letters/digits).",
    inputSchema: {
      type: "object",
      properties: { customer_id: { type: "string", pattern: "^CUST-[A-Z0-9]{5}$", description: "Customer id, e.g. CUST-00001" } },
      required: ["customer_id"],
      additionalProperties: false,
    },
  },
  {
    name: "trigger_refund",
    description: "Issue a refund to a customer. amount is a positive number of currency units; reason must be at least 10 characters.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", pattern: "^CUST-[A-Z0-9]{5}$" },
        amount: { type: "number", exclusiveMinimum: 0 },
        reason: { type: "string", minLength: 10 },
      },
      required: ["customer_id", "amount", "reason"],
      additionalProperties: false,
    },
  },
];

const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });
const ok = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
});

function invalidParams(tool: string, err: ZodError): McpError {
  const issues = err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${tool}`, { issues });
}

export function buildServer(): Server {
  const server = new Server({ name: "customer-ops", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = req.params;

    switch (name) {
      case "get_customer_record": {
        const parsed = getCustomerRecordSchema.safeParse(args);
        if (!parsed.success) throw invalidParams(name, parsed.error);
        const { customer_id } = parsed.data;
        log.info("get_customer_record", { customer_id });
        const record = store.getCustomer(customer_id);
        return record ? ok({ ...record }) : fail(`No customer found for ${customer_id}`);
      }
      case "trigger_refund": {
        const parsed = triggerRefundSchema.safeParse(args);
        if (!parsed.success) throw invalidParams(name, parsed.error);
        const { customer_id, amount, reason } = parsed.data;
        log.info("trigger_refund", { customer_id, amount });
        const record = store.getCustomer(customer_id);
        if (!record) return fail(`No customer found for ${customer_id}`);
        if (record.status !== "active") return fail(`Customer ${customer_id} is ${record.status}; refunds are blocked`);
        return ok({ ...store.createRefund(customer_id, amount, reason) });
      }
      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
  });

  server.onerror = (err) => log.error("server error", { message: err.message });
  return server;
}

/**
 * The SDK's stdio transport drops frames it cannot decode after calling
 * onerror. JSON-RPC 2.0 says a Parse error / Invalid Request must be answered
 * with id null, so we hook onerror after connect() (which installs the
 * protocol's own handler) and emit that response before delegating.
 */
export function installFrameErrorResponses(transport: StdioServerTransport): void {
  const previous = transport.onerror;
  transport.onerror = (err: Error) => {
    if (err instanceof SyntaxError) {
      void transport.send({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.ParseError, message: "Parse error" } } as never);
    } else if (err instanceof ZodError || err.name === "ZodError") {
      // duck-typed: the SDK may validate with its own zod copy
      void transport.send({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.InvalidRequest, message: "Invalid Request" } } as never);
    }
    previous?.(err);
  };
}

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  installFrameErrorResponses(transport);
  log.info("customer-ops MCP server listening on stdio");
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  main().catch((err) => {
    log.error("fatal", { message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
