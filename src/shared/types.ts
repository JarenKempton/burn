// Burn observation model. Contract source: issue #7 (Decision: Adopt the Burn
// v0 architecture and interface contracts). Schemas are versioned
// independently of the HTTP API.

export const OBSERVATION_SCHEMA_VERSION = 1;
export const API_VERSION = "v1";
export const PROTOCOL_VERSION = 1;

export type ProviderId = "claude_code" | "codex" | "openrouter" | "lmstudio";

export type SourceQuality =
  | "official_api"
  | "official_cli"
  | "experimental_rpc"
  | "local_log"
  | "estimated";

// Rolling, fixed, lifetime, request, and unknown periods must remain
// distinguishable (issue #7).
export type WindowKind = "rolling" | "fixed" | "lifetime" | "request" | "unknown";

export interface QuotaWindow {
  kind: WindowKind;
  /** e.g. "5h", "weekly", "monthly" — provider-native label */
  label?: string | null;
  duration_seconds?: number | null;
}

// Unknown values are absent/null and never invented as zero.
export interface QuotaSnapshotPayload {
  type: "quota_snapshot";
  window: QuotaWindow;
  used_percent?: number | null;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  /** unit for used/limit/remaining, e.g. "requests", "tokens", "credits" */
  unit?: string | null;
  resets_at?: string | null;
}

export type TokenCounting = "provider_reported" | "local_log" | "estimated";

export interface ConsumptionPayload {
  type: "consumption";
  period_start: string;
  period_end: string;
  model?: string | null;
  input_tokens?: number | null;
  cached_input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_output_tokens?: number | null;
  total_tokens?: number | null;
  requests?: number | null;
  /** exact integer micros of `currency`; never floating point */
  cost_micros?: number | null;
  currency?: string | null;
  counting: TokenCounting;
}

export interface CreditBalancePayload {
  type: "credit_balance";
  total_purchased_micros?: number | null;
  total_used_micros?: number | null;
  remaining_micros?: number | null;
  currency: string;
}

export interface InferencePerformancePayload {
  type: "inference_performance";
  model?: string | null;
  request_ref?: string | null;
  time_to_first_token_ms?: number | null;
  tokens_per_second?: number | null;
  duration_ms?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

export type AdapterHealth =
  | "healthy"
  | "authentication_required"
  | "unsupported"
  | "temporarily_failed"
  | "incompatible_version";

export interface AdapterStatusPayload {
  type: "adapter_status";
  status: AdapterHealth;
  message?: string | null;
  provider_version?: string | null;
}

export type ObservationPayload =
  | QuotaSnapshotPayload
  | ConsumptionPayload
  | CreditBalancePayload
  | InferencePerformancePayload
  | AdapterStatusPayload;

export type PayloadType = ObservationPayload["type"];

export interface ObservationEnvelope {
  schema_version: number;
  /** globally unique; ingestion is idempotent by this ID */
  observation_id: string;
  node_id: string;
  provider_id: ProviderId;
  account_ref?: string | null;
  observed_at: string;
  collected_at: string;
  adapter_id: string;
  adapter_version: string;
  source_quality: SourceQuality;
  payload: ObservationPayload;
  /** reference into raw payload storage; raw payloads must be redacted */
  raw_ref?: string | null;
}

// ---- Wire types (HTTP) ----

export interface WellKnownBurn {
  product: "burn";
  protocol_version: number;
  server_id: string;
  server_name: string;
  enrollment_enabled: boolean;
  endpoints: {
    enrollment_requests: string;
    enrollment_token: string;
    observations: string;
    heartbeat: string;
  };
}

export interface EnrollmentRequestCreate {
  node_name: string;
  platform: string;
  agent_version: string;
}

export interface EnrollmentRequestCreated {
  request_id: string;
  /** short code the human matches in the browser */
  user_code: string;
  /** high-entropy secret; never displayed, never sent to the approval page */
  device_code: string;
  verification_url: string;
  expires_at: string;
  poll_interval_seconds: number;
}

export type EnrollmentStatus = "pending" | "approved" | "denied" | "expired";

export interface EnrollmentTokenExchange {
  request_id: string;
  device_code: string;
}

export interface EnrollmentTokenIssued {
  node_id: string;
  node_token: string;
  canonical_url: string;
}

export interface HeartbeatRequest {
  sent_at: string;
  boot_id: string;
  agent_version: string;
  /** best-effort report of how the previous session ended */
  previous_session?: { boot_id: string; termination: "clean" | "unclean_or_unknown" } | null;
}

export interface ObservationBatchResult {
  accepted: string[];
  duplicate: string[];
  rejected: { observation_id: string; reason: string }[];
}

export type NodeLiveness = "online" | "stale" | "offline";

export interface ApiError {
  error: { code: string; message: string };
}
