/**
 * Standardized gateway error payload. This is the ONLY error shape clients
 * ever see; upstream bodies, stack traces and internal URLs never leak.
 */
export type GatewayErrorCode =
  | "bad_request"
  | "unauthorized"
  | "rate_limited"
  | "upstream_timeout"
  | "upstream_rate_limited"
  | "upstream_error"
  | "all_providers_failed"
  | "internal_error";

const STATUS: Record<GatewayErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  rate_limited: 429,
  upstream_timeout: 504,
  upstream_rate_limited: 429,
  upstream_error: 502,
  all_providers_failed: 502,
  internal_error: 500,
};

export interface GatewayErrorBody {
  error: {
    code: GatewayErrorCode;
    message: string;
    request_id: string;
    retry_after_ms?: number;
  };
}

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly retryAfterMs?: number,
    /** Internal detail for logs only; never serialized to the client. */
    readonly internal?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
  get status(): number {
    return STATUS[this.code];
  }
  toBody(requestId: string): GatewayErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        request_id: requestId,
        ...(this.retryAfterMs !== undefined && Number.isFinite(this.retryAfterMs) ? { retry_after_ms: Math.ceil(this.retryAfterMs) } : {}),
      },
    };
  }
}

/** Anything that is not already a GatewayError becomes an opaque internal_error. */
export function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  return new GatewayError("internal_error", "Internal gateway error", undefined, err);
}
