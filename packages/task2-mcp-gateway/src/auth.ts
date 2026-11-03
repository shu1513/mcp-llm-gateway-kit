/**
 * Bearer token -> role resolution.
 *
 * Tokens are opaque strings looked up in a static map (env GATEWAY_TOKENS as
 * JSON, e.g. {"tok-admin":"admin","tok-view":"viewer"}). The gateway fails
 * closed: with no GATEWAY_TOKENS it refuses to start unless ALLOW_DEV_TOKENS=1
 * explicitly opts into the well-known demo tokens. In production this is the
 * seam to swap for JWT verification or an introspection endpoint; the gateway
 * only depends on `authenticate(header) -> Principal | undefined`.
 */
export type Role = "admin" | "viewer";

export interface Principal {
  token: string;
  role: Role;
}

const ROLES: ReadonlySet<string> = new Set<Role>(["admin", "viewer"]);

export const DEV_TOKENS = '{"dev-admin-token":"admin","dev-viewer-token":"viewer"}';

export function loadTokenMap(env: NodeJS.ProcessEnv = process.env): Map<string, Role> {
  let raw = env.GATEWAY_TOKENS;
  if (raw === undefined) {
    if (env.ALLOW_DEV_TOKENS !== "1") throw new Error("GATEWAY_TOKENS is not set (set it, or ALLOW_DEV_TOKENS=1 for the demo tokens)");
    raw = DEV_TOKENS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GATEWAY_TOKENS must be a JSON object of token -> role");
  }
  const map = new Map<string, Role>();
  for (const [token, role] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof role !== "string" || !ROLES.has(role)) throw new Error(`GATEWAY_TOKENS: unknown role for token: ${role}`);
    map.set(token, role as Role);
  }
  return map;
}

/** Parses `Authorization: Bearer <token>`; returns undefined when absent/malformed. */
export function extractBearer(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
}

export function authenticate(header: string | string[] | undefined, tokens: Map<string, Role>): Principal | undefined {
  const token = extractBearer(header);
  if (!token) return undefined;
  const role = tokens.get(token);
  return role ? { token, role } : undefined;
}

/** Tools whose name starts with this prefix are admin-only. */
export const ADMIN_TOOL_PREFIX = "admin_";

export function isAuthorizedToolCall(role: Role, toolName: unknown): boolean {
  if (typeof toolName !== "string") return false;
  return !toolName.startsWith(ADMIN_TOOL_PREFIX) || role === "admin";
}
