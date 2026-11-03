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

/**
 * Normalizes the output budget and returns the body that will be forwarded plus
 * the token estimate to reserve. If the caller set no limit, `defaultMaxTokens`
 * is injected into the forwarded request so the provider cannot generate more
 * than what was reserved; `n` choices multiply the completion budget.
 */
export function normalizeBudget(
  body: Record<string, unknown>,
  defaultMaxTokens = 256,
): { body: Record<string, unknown>; estimate: number; maxTokens: number } {
  const explicit = [body.max_tokens, body.max_completion_tokens].find((v) => typeof v === "number" && v > 0) as number | undefined;
  const maxTokens = Math.ceil(explicit ?? defaultMaxTokens);
  const n = typeof body.n === "number" && body.n > 1 ? Math.ceil(body.n) : 1;
  const forwarded = explicit === undefined ? { ...body, max_tokens: maxTokens } : body;
  return { body: forwarded, estimate: estimatePromptTokens(body) + maxTokens * n, maxTokens };
}
