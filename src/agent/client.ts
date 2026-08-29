import type {
  EnrollmentRequestCreate,
  EnrollmentRequestCreated,
  EnrollmentStatus,
  EnrollmentTokenIssued,
  HeartbeatRequest,
  ObservationBatchResult,
  ObservationEnvelope,
  WellKnownBurn,
} from "../shared/types";

export class BurnClient {
  constructor(
    public baseUrl: string,
    private nodeToken?: string
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private headers(auth: boolean): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (auth && this.nodeToken) h["authorization"] = `Bearer ${this.nodeToken}`;
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown, auth = false): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(auth),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const err = (await res.json()) as { error?: { code?: string; message?: string } };
        detail = err.error ? ` (${err.error.code}: ${err.error.message})` : "";
      } catch {}
      throw new Error(`${method} ${path} failed: HTTP ${res.status}${detail}`);
    }
    return (await res.json()) as T;
  }

  wellKnown = () => this.req<WellKnownBurn>("GET", "/.well-known/burn");

  createEnrollment = (body: EnrollmentRequestCreate) =>
    this.req<EnrollmentRequestCreated>("POST", "/v1/enrollment/requests", body);

  pollEnrollment = (requestId: string) =>
    this.req<{ status: EnrollmentStatus }>("GET", `/v1/enrollment/requests/${requestId}`);

  exchangeToken = (requestId: string, deviceCode: string) =>
    this.req<EnrollmentTokenIssued>("POST", "/v1/enrollment/token", {
      request_id: requestId,
      device_code: deviceCode,
    });

  heartbeat = (body: HeartbeatRequest) =>
    this.req<{ ok: boolean; received_at: string }>("POST", "/v1/heartbeat", body, true);

  sendObservations = (observations: ObservationEnvelope[]) =>
    this.req<ObservationBatchResult>("POST", "/v1/observations", { observations }, true);
}
