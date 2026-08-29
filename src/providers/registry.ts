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

export function enabledAdapters(cfg: BurnConfig): Adapter[] {
  return ALL_ADAPTERS.filter((a) => cfg.providers?.[a.providerId]?.enabled !== false);
}

export function adapterFor(providerId: string): Adapter | undefined {
  return ALL_ADAPTERS.find((a) => a.providerId === providerId);
}
