import type { Database } from "bun:sqlite";
import type { ObservationEnvelope, ProviderId } from "../shared/types";

// Provider adapter contract. Adapters emit versioned, source-qualified
// observations and never flatten unlike provider concepts (issue #7).
// Adapter failure must not prevent heartbeats or other adapters (the runner
// isolates each collect() call). Provider credentials stay on this node.

export interface AdapterContext {
  nodeId: string;
  /** collector-local db for incremental cursors; adapters use getCursor/setCursor */
  db: Database;
  settings: Record<string, unknown>;
  credentials: Record<string, string>;
}

export interface Adapter {
  providerId: ProviderId;
  adapterId: string;
  adapterVersion: string;
  /** true when the provider appears installed/configured on this node */
  detect(ctx: AdapterContext): Promise<boolean>;
  /** collect new observations since the adapter's cursor; must be idempotent */
  collect(ctx: AdapterContext): Promise<ObservationEnvelope[]>;
}
