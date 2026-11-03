/**
 * Pre-call token estimate used for the rate-limit reservation. Deliberately
 * cheap: ~4 chars per token for prompt text plus the requested max_tokens.
 * Replace `estimatePromptTokens` with a real tokenizer (tiktoken / the
 * provider's count endpoint) for tighter accounting; settle() corrects the
 * window with the provider-reported usage after the call either way.
 */
export function estimatePromptTokens(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : [];
  let chars = 0;
  for (const m of messages) chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  if (typeof body.prompt === "string") chars += body.prompt.length;
  return Math.ceil(chars / 4) + 4 * messages.length;
}

export function estimateRequestTokens(body: Record<string, unknown>, defaultMaxTokens = 256): number {
  const max = typeof body.max_tokens === "number" && body.max_tokens > 0 ? body.max_tokens : defaultMaxTokens;
  return estimatePromptTokens(body) + max;
}
