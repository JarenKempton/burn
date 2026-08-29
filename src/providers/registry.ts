import type { Adapter } from "./types";
import type { BurnConfig } from "../shared/config";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { openRouterAdapter } from "./openrouter";
import { lmStudioAdapter } from "./lmstudio";

export const ALL_ADAPTERS: Adapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  openRouterAdapter,
  lmStudioAdapter,
];

// Providers that require explicit opt-in via `burn providers add`.
// LM Studio is deferred for v0 (weakest surface — no history API), so it
// only collects when deliberately enabled.
const OPT_IN: ReadonlySet<string> = new Set(["lmstudio"]);

export function isEnabled(cfg: BurnConfig, providerId: string): boolean {
  const enabled = cfg.providers?.[providerId as keyof NonNullable<BurnConfig["providers"]>]?.enabled;
  return OPT_IN.has(providerId) ? enabled === true : enabled !== false;
}

export function enabledAdapters(cfg: BurnConfig): Adapter[] {
  return ALL_ADAPTERS.filter((a) => isEnabled(cfg, a.providerId));
}

export function adapterFor(providerId: string): Adapter | undefined {
  return ALL_ADAPTERS.find((a) => a.providerId === providerId);
}
