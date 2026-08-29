// API-equivalent price table, USD per 1M tokens, matched by model-id prefix.
//
// These power the "~$X est" column in `burn usage` for subscription usage
// (Claude Code, Codex), which is NOT billed per token — the estimate answers
// "what would this have cost at API list price". OpenRouter rows use the
// provider-reported actual cost instead and never touch this table.
//
// Prices drift; unknown models get no estimate rather than a wrong one.
// Edit freely — this file is the single source.

export interface ModelPrice {
  prefix: string;
  input: number;
  cached_input: number;
  output: number;
}

export const PRICE_TABLE: ModelPrice[] = [
  // Anthropic (list prices)
  { prefix: "claude-opus-4", input: 15, cached_input: 1.5, output: 75 },
  { prefix: "claude-sonnet-4", input: 3, cached_input: 0.3, output: 15 },
  { prefix: "claude-haiku-4", input: 1, cached_input: 0.1, output: 5 },
  // OpenAI GPT-5 family (Codex subscription models)
  { prefix: "gpt-5", input: 1.25, cached_input: 0.125, output: 10 },
];

export function estimateCostMicros(
  model: string | null,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
): number | null {
  if (!model) return null;
  const price = PRICE_TABLE.find((p) => model.startsWith(p.prefix));
  if (!price) return null;
  const usd =
    (inputTokens / 1_000_000) * price.input +
    (cachedInputTokens / 1_000_000) * price.cached_input +
    (outputTokens / 1_000_000) * price.output;
  return Math.round(usd * 1_000_000);
}
