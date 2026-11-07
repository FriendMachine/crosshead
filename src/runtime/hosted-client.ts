import type { HotSyncSnapshot, HotSyncEnvelope } from "../protocol/hot-sync";
import { hotSyncEtag, HOT_SYNC_PROTOCOL_VERSION } from "../protocol/hot-sync";
import { RECALL_TIMEOUT_MS } from "./continuity-recall";
import { createHash, randomUUID } from "crypto";
import { schnorr } from "@noble/curves/secp256k1";
import { nip19 } from "nostr-tools";
import type { ContinuityClaim, ContinuityClaimEvidence } from "../protocol/continuity-claims";
import type {
  ContinuityClaimCreateInput,
  ContinuityClaimEvidenceCreateInput,
  ContinuityClaimListFilters,
  ContinuityClaimVerificationResult,
} from "../protocol/continuity-claims";
import { L402_IDEMPOTENCY_HEADER } from "../protocol/hosted-api";

export type HostedSession = {
  sessionToken: string;
  expiresAt: string;
  scopes: string[];
};

export type HostedContextPackRequest = Record<string, unknown>;
export type HostedContextReflectRequest = Record<string, unknown>;
export type HostedInboxStateQuery = {
  statuses?: string[];
  priorities?: string[];
  contextId?: string;
  messageType?: string;
  unreadOnly?: boolean;
  includeTerminal?: boolean;
  limit?: number;
};

export type HostedObligationsQuery = {
  statuses?: string[];
  includeTerminal?: boolean;
  limit?: number;
};

export type HostedBillingCheckoutRequest = {
  credit_units: number;
  success_url?: string;
  cancel_url?: string;
};

export type HostedBillingInvoiceListFilters = {
  status?: string;
  created_after?: string;
  created_before?: string;
  paid_after?: string;
  paid_before?: string;
  limit?: number;
};

export type HostedPublicDiscoveryQuery = {
  eventTypes?: string[];
  authors?: string[];
  primaryId?: string;
  eventId?: string;
  capabilityId?: string;
  offerId?: string;
  taskRef?: string;
  agentId?: string;
  status?: string;
  since?: number;
  until?: number;
  latestOnly?: boolean;
  includeRaw?: boolean;
  limit?: number;
};

const parseBase64Url = (input: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const buffer = Buffer.from(normalized, "base64");
    const canonical = buffer.toString("base64url");
    return buffer.length > 0 && canonical === input.replace(/=+$/, "") ? new Uint8Array(buffer) : null;
  } catch {
    return null;
  }
};

const AUTH_CHALLENGE_VERSION = "crosshead_auth_v1";
const AUTH_CHALLENGE_PURPOSE = "crosshead_hosted_auth";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

const decodeAuthChallenge = (input: {
  challenge: string;
  responseExpiresAt: string;
  expectedNpub: string;
  expectedAudience: string;
  now?: number;
}): Uint8Array => {
  const bytes = parseBase64Url(input.challenge);
  if (!bytes || bytes.byteLength > 4096) throw new Error("Hosted auth challenge must be bounded base64url JSON");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error("Hosted auth challenge must contain JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hosted auth challenge must be an object");
  const challenge = value as Record<string, unknown>;
  const issuedAt = typeof challenge.issued_at === "string" ? Date.parse(challenge.issued_at) : NaN;
  const expiresAt = typeof challenge.expires_at === "string" ? Date.parse(challenge.expires_at) : NaN;
  const responseExpiresAt = Date.parse(input.responseExpiresAt);
  const now = input.now ?? Date.now();
  if (challenge.version !== AUTH_CHALLENGE_VERSION || challenge.purpose !== AUTH_CHALLENGE_PURPOSE) {
    throw new Error("Hosted auth challenge has an unsupported version or purpose");
  }
  if (challenge.audience !== input.expectedAudience || challenge.npub !== input.expectedNpub) {
    throw new Error("Hosted auth challenge is not bound to this origin and identity");
  }
  if (typeof challenge.nonce !== "string" || !/^[A-Za-z0-9_-]{22,128}$/.test(challenge.nonce)) {
    throw new Error("Hosted auth challenge nonce is invalid");
  }
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(responseExpiresAt) ||
      expiresAt !== responseExpiresAt || issuedAt > now + 30_000 || issuedAt < now - 5 * 60_000 ||
      expiresAt <= now || expiresAt - issuedAt > 5 * 60_000 || expiresAt <= issuedAt) {
    throw new Error("Hosted auth challenge timestamps are invalid");
  }
  return bytes;
};

const decodeNsec = (nsec: string): Uint8Array => {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") {
    throw new Error("nsec must be a valid NIP-19 secret key");
  }
  return decoded.data;
};

const decodeNpub = (npub: string): Uint8Array => {
  const decoded = nip19.decode(npub);
  if (decoded.type !== "npub") {
    throw new Error("npub must be a valid NIP-19 public key");
  }
  return new Uint8Array(Buffer.from(decoded.data, "hex"));
};

const normalizeApiBase = (apiBase: string): { serviceBaseUrl: string; apiBaseUrl: string } => {
  const parsed = new URL(apiBase);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) {
    throw new Error("Hosted API base must use HTTPS; HTTP is allowed only for an exact loopback host");
  }
  const origin = parsed.origin;
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/") {
    return {
      serviceBaseUrl: origin,
      apiBaseUrl: `${origin}/v1`,
    };
  }
  if (path.endsWith("/v1")) {
    const servicePath = path.slice(0, -3);
    return {
      serviceBaseUrl: `${origin}${servicePath}`,
      apiBaseUrl: `${origin}${path}`,
    };
  }
  return {
    serviceBaseUrl: `${origin}${path}`,
    apiBaseUrl: `${origin}${path}/v1`,
  };
};

// Deterministic JSON used to derive idempotency keys. Object keys are sorted so that
// re-serializing the same logical payload (e.g. a queue item replayed on retry) always
// produces the same string, which keeps the server-side idempotency dedupe stable.
const canonicalJson = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") {
      return input;
    }
    if (seen.has(input as object)) {
      return null;
    }
    seen.add(input as object);
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    const source = input as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      normalized[key] = normalize(source[key]);
    }
    return normalized;
  };
  return JSON.stringify(normalize(value) ?? null);
};

// Builds a value matching L402_IDEMPOTENCY_KEY_PATTERN (/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/).
// Deterministic per (operation, payload): retries of the same logical operation reuse the key
// (so the hosted ledger charges once), while distinct payloads get distinct keys.
const buildIdempotencyKey = (operationId: string, body: unknown): string => {
  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex").slice(0, 48);
  return `${operationId}-${digest}`;
};

const readBoundedJson = async <T>(response: Response, maxBytes = MAX_JSON_RESPONSE_BYTES): Promise<T> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Hosted API response exceeds the size limit");
  if (!response.body) throw new Error("Hosted API returned an empty response");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Hosted API response exceeds the size limit");
    }
    chunks.push(Buffer.from(chunk.value));
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as T; }
  catch { throw new Error("Hosted API returned invalid JSON"); }
};

const SIGNED_MEMORY_VERSION = "crosshead_signed_memory_v1";
type SignedMemoryEnvelope = {
  version: typeof SIGNED_MEMORY_VERSION;
  scope: string | null;
  content: string;
  signedBy: string;
  createdAt: string;
  signature: string;
};

export class HostedOnlyBotsRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;
  readonly retryAfterMs: number;

  constructor(input: { message: string; status: number; code?: string | null; details?: unknown; retryAfterMs?: number }) {
    super(input.message);
    this.name = "HostedOnlyBotsRequestError";
    this.status = input.status;
    this.code = input.code ?? null;
    this.details = input.details;
    this.retryAfterMs = input.retryAfterMs ?? 0;
  }
}

/**
 * Classify a failed hosted request for local diagnostics without copying its
 * message, URL, headers or body: a timeout, an HTTP status/code, or an error name.
 */
const SAFE_FAILURE_LABEL = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const safeFailureLabel = (value: string | null): string | null => (value !== null && SAFE_FAILURE_LABEL.test(value) ? value : null);

export const describeHostedFailure = (error: unknown): Record<string, string | number | null> => {
  // The server chooses `code`; validate it like an error name so it cannot carry message text.
  if (error instanceof HostedOnlyBotsRequestError) return { errorClass: "http", status: error.status, code: safeFailureLabel(error.code) };
  const name = error instanceof Error ? error.name : typeof error;
  if (name === "TimeoutError") return { errorClass: "timeout" };
  if (name === "AbortError") return { errorClass: "aborted" };
  return { errorClass: safeFailureLabel(name) ?? "unknown" };
};

/**
 * Warning for a bounded recall that fell back to free hot memory. Only a timeout, abort,
 * network failure or unconfirmed server error leaves open whether the paid request settled.
 */
export const describeBoundedRecallFallback = (error: unknown): string => {
  const prefix = "Saved-context retrieval unavailable; continuing with free hot memory.";
  if (error instanceof HostedOnlyBotsRequestError) {
    const details = error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : null;
    if (error.code === "paid_operation_commit_unknown") {
      return `${prefix} The payment outcome is unknown; retry only with the same idempotency key to resolve it without a duplicate charge.`;
    }
    if (error.code === "recall_deadline_exceeded" && details?.charged_sats === 0) {
      return `${prefix} The server missed its response budget (HTTP ${error.status}) and charged nothing; a retry is safe.`;
    }
    if (details?.charged_sats === 0) return `${prefix} The server could not deliver the request (HTTP ${error.status}) and charged nothing; a retry is safe.`;
    if (error.status < 500) return `${prefix} The server rejected the request (HTTP ${error.status}).`;
  }
  return `${prefix} A timed-out or failed paid request may still settle; inspect billing before retrying.`;
};

const extractHostedError = (data: unknown): { message: string | null; code: string | null; details: unknown } => {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { message: null, code: null, details: undefined };
  }
  const error = (data as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return { message: null, code: null, details: undefined };
  }
  const candidate = error as { message?: unknown; code?: unknown; details?: unknown };
  return {
    message: typeof candidate.message === "string" ? candidate.message : null,
    code: typeof candidate.code === "string" ? candidate.code : null,
    details: candidate.details,
  };
};

export class HostedOnlyBotsClient {
  readonly serviceBaseUrl: string;
  readonly apiBaseUrl: string;
  private readonly privateKey: Uint8Array;

  constructor(
    private readonly config: {
      apiBase: string;
      npub: string;
      nsec: string;
      session?: HostedSession | null;
    }
  ) {
    const normalized = normalizeApiBase(config.apiBase);
    this.serviceBaseUrl = normalized.serviceBaseUrl;
    this.apiBaseUrl = normalized.apiBaseUrl;
    this.privateKey = decodeNsec(config.nsec);
    if (!Buffer.from(schnorr.getPublicKey(this.privateKey)).equals(Buffer.from(decodeNpub(config.npub)))) {
      throw new Error("nsec does not match npub");
    }
  }

  session(): HostedSession | null {
    return this.config.session ?? null;
  }

  setSession(session: HostedSession | null): void {
    this.config.session = session;
  }

  private memorySignaturePayload(envelope: Omit<SignedMemoryEnvelope, "signature">): string {
    return `crosshead-memory-v1\n${canonicalJson(envelope)}`;
  }

  private async signMemory(content: string, scope?: string): Promise<string> {
    const unsigned: Omit<SignedMemoryEnvelope, "signature"> = {
      version: SIGNED_MEMORY_VERSION,
      scope: scope ?? null,
      content,
      signedBy: this.config.npub,
      createdAt: new Date().toISOString(),
    };
    const signature = Buffer.from(
      await schnorr.sign(new TextEncoder().encode(this.memorySignaturePayload(unsigned)), this.privateKey)
    ).toString("hex");
    return JSON.stringify({ ...unsigned, signature } satisfies SignedMemoryEnvelope);
  }

  private async verifyMemory(content: unknown, expectedScope?: string): Promise<string | null> {
    if (typeof content !== "string" || content.length > MAX_JSON_RESPONSE_BYTES) return null;
    let value: unknown;
    try { value = JSON.parse(content); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const envelope = value as Partial<SignedMemoryEnvelope>;
    if (envelope.version !== SIGNED_MEMORY_VERSION || envelope.signedBy !== this.config.npub ||
		envelope.scope !== (expectedScope ?? null) || typeof envelope.content !== "string" ||
		typeof envelope.createdAt !== "string" || !Number.isFinite(Date.parse(envelope.createdAt)) ||
		typeof envelope.signature !== "string" || !/^[0-9a-f]{128}$/i.test(envelope.signature)) return null;
    const decoded = nip19.decode(envelope.signedBy);
    if (decoded.type !== "npub") return null;
    const unsigned: Omit<SignedMemoryEnvelope, "signature"> = {
      version: SIGNED_MEMORY_VERSION,
      scope: envelope.scope,
      content: envelope.content,
      signedBy: envelope.signedBy,
      createdAt: envelope.createdAt,
    };
    const valid = await schnorr.verify(
      envelope.signature,
      new TextEncoder().encode(this.memorySignaturePayload(unsigned)),
      decoded.data
    );
    return valid ? envelope.content : null;
  }

  private async verifiedHotMemoryResponse(
    data: Record<string, unknown>, expectedScope?: string
  ): Promise<Record<string, unknown>> {
    if (Array.isArray(data.scopes)) {
      const scopes: Record<string, unknown>[] = [];
      for (const raw of data.scopes) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const entry = raw as Record<string, unknown>;
		const scope = typeof entry.scope === "string" ? entry.scope : undefined;
		const content = await this.verifyMemory(entry.content, scope);
		if (content !== null) scopes.push({ ...entry, content, integrity: "verified" });
      }
      return { ...data, scopes, integrity: "verified-client-signatures" };
    }
    const content = await this.verifyMemory(data.content, expectedScope);
    return content === null
      ? { ...data, content: "", integrity: "rejected-unverified" }
      : { ...data, content, integrity: "verified" };
  }

  // Header bag for L402 paid operations. The hosted API rejects paid POSTs without a valid
  // idempotency key; callers may pass an explicit key (e.g. a stable queue-item id) or let it
  // be derived deterministically from the request body.
  private paidHeaders(operationId: string, body: unknown, idempotencyKey?: string): Record<string, string> {
    // A new retrieval or dream run must see current state; explicit retry keys still replay.
    if (idempotencyKey == null && ["memory_search_v1", "context_pack_v1", "context_dream_run_v1"].includes(operationId)) {
      return { [L402_IDEMPOTENCY_HEADER]: `${operationId}-${randomUUID()}` };
    }
    return {
      [L402_IDEMPOTENCY_HEADER]: idempotencyKey ?? buildIdempotencyKey(operationId, body),
    };
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH";
      body?: unknown;
      auth?: boolean;
      expectedStatuses?: number[];
      useServiceBase?: boolean;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {}
  ): Promise<{ status: number; data: T }> {
    const url = `${options.useServiceBase ? this.serviceBaseUrl : this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.auth) {
      const session = this.config.session;
      if (!session) {
        throw new Error("Hosted session is missing");
      }
      headers.authorization = `Bearer ${session.sessionToken}`;
    }
    Object.assign(headers, options.headers ?? {});

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
    const data = response.status === 304 ? undefined as T : await readBoundedJson<T>(response);
    const expected = options.expectedStatuses ?? [200];
    if (!expected.includes(response.status)) {
      const error = extractHostedError(data);
      throw new HostedOnlyBotsRequestError({
				status: response.status,
				retryAfterMs: Math.max(0, Number(response.headers.get("retry-after")) * 1000 || Date.parse(response.headers.get("retry-after") ?? "") - Date.now() || 0),
				code: error.code,
				details: error.details,
				message: error.message ?? `Hosted API request failed with ${response.status}`,
      });
    }
    return { status: response.status, data };
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.serviceBaseUrl}/health`, {
		redirect: "error",
		signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  async authenticate(): Promise<HostedSession> {
    const challenge = await this.request<{ challenge: string; expires_at: string }>("/auth/challenge", {
      method: "POST",
      body: { npub: this.config.npub },
    });
    const challengeBytes = decodeAuthChallenge({
      challenge: challenge.data.challenge,
      responseExpiresAt: challenge.data.expires_at,
      expectedNpub: this.config.npub,
      expectedAudience: this.serviceBaseUrl,
    });
    const signature = Buffer.from(await schnorr.sign(challengeBytes, this.privateKey)).toString(
      "hex"
    );
    const verify = await this.request<{ session_token: string; expires_at: string; scopes: string[] }>("/auth/verify", {
      method: "POST",
      body: {
        npub: this.config.npub,
        challenge: challenge.data.challenge,
        signature,
      },
    });
    const session = {
      sessionToken: verify.data.session_token,
      expiresAt: verify.data.expires_at,
      scopes: verify.data.scopes,
    } satisfies HostedSession;
    this.config.session = session;
    return session;
  }

  async ensureSession(): Promise<HostedSession> {
    const current = this.config.session;
    if (current) {
      const expiry = new Date(current.expiresAt);
      if (!Number.isNaN(expiry.getTime()) && expiry.getTime() > Date.now() + 1_000) {
        return current;
      }
    }
    return this.authenticate();
  }

  async prepareContextPack(body: HostedContextPackRequest, idempotencyKey?: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/context/pack", {
      method: "POST",
      body,
      auth: true,
      headers: this.paidHeaders("context_pack_v1", body, idempotencyKey),
      timeoutMs: body.recallPolicy === "bounded" ? RECALL_TIMEOUT_MS : undefined,
    });
    // Nothing returned by the hosted service is an authenticated instruction
    // channel. Keep only a bounded opaque identifier used for reflection; all
    // prompt material is rendered from locally verified hot memory instead.
    const packId = response.data.packId;
    return {
      ...(typeof packId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(packId) ? { packId } : {}),
      contextText: "",
      fragments: [],
    };
  }

  async inspectContextPack(packId: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>(`/context/packs/${encodeURIComponent(packId)}`, {
      method: "GET",
      auth: true,
    });
    return response.data;
  }

  async inspectContinuityJudgment(): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/context/judgment", {
      method: "GET",
      auth: true,
    });
    return response.data;
  }

  async inspectContinuity(): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/context/continuity", {
      method: "GET",
      auth: true,
    });
    return response.data;
  }

  async getBillingPricing(): Promise<Record<string, unknown>> {
    const response = await this.request<Record<string, unknown>>("/billing/pricing", {
      method: "GET",
    });
    return response.data;
  }

  async getBillingAccount(): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/billing/account", {
      method: "GET",
      auth: true,
    });
    return response.data;
  }

  /** Attaches this agent to an organization with a join code from the Crosshead console. */
  async joinOrganization(body: { code: string; agent_id?: string }): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/organizations/join", {
      method: "POST",
      body,
      auth: true,
      expectedStatuses: [200, 201],
    });
    return response.data;
  }

  async createBillingCheckout(body: HostedBillingCheckoutRequest): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/billing/stripe/checkout", {
      method: "POST",
      body,
      auth: true,
    });
    return response.data;
  }

  async createBillingDepositInvoice(amountSats: number): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/balance/deposit", {
      method: "POST",
      body: { amount_sats: amountSats },
      auth: true,
    });
    return response.data;
  }

  async listBillingInvoices(filters: HostedBillingInvoiceListFilters = {}): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const search = new URLSearchParams();
    if (typeof filters.status === "string") {
      search.set("status", filters.status);
    }
    if (typeof filters.created_after === "string") {
      search.set("created_after", filters.created_after);
    }
    if (typeof filters.created_before === "string") {
      search.set("created_before", filters.created_before);
    }
    if (typeof filters.paid_after === "string") {
      search.set("paid_after", filters.paid_after);
    }
    if (typeof filters.paid_before === "string") {
      search.set("paid_before", filters.paid_before);
    }
    if (typeof filters.limit === "number" && Number.isFinite(filters.limit)) {
      search.set("limit", String(Math.trunc(filters.limit)));
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    const response = await this.request<Record<string, unknown>>(`/balance/invoices${suffix}`, {
      method: "GET",
      auth: true,
    });
    return response.data;
  }

  async getBillingInvoice(invoiceId: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>(`/balance/invoices/${encodeURIComponent(invoiceId)}`, {
      method: "GET",
      auth: true,
    });
    return response.data;
  }

  async getBillingInvoiceByPaymentHash(paymentHash: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>(
      `/balance/invoices/by-payment-hash/${encodeURIComponent(paymentHash)}`,
      { method: "GET", auth: true }
    );
    return response.data;
  }

  async listContinuityClaims(filters: ContinuityClaimListFilters = {}): Promise<ContinuityClaim[]> {
    await this.ensureSession();
    const search = new URLSearchParams();
    if (Array.isArray(filters.statuses) && filters.statuses.length > 0) {
      search.set("status", filters.statuses.join(","));
    }
    if (Array.isArray(filters.kinds) && filters.kinds.length > 0) {
      search.set("kind", filters.kinds.join(","));
    }
    if (typeof filters.unresolvedOnly === "boolean") {
      search.set("unresolved", String(filters.unresolvedOnly));
    }
    if (typeof filters.subjectType === "string") {
      search.set("subject_type", filters.subjectType);
    }
    if (typeof filters.subjectRef === "string") {
      search.set("subject_ref", filters.subjectRef);
    }
    if (typeof filters.evidenceKind === "string") {
      search.set("evidence_kind", filters.evidenceKind);
    }
    if (typeof filters.limit === "number" && Number.isFinite(filters.limit)) {
      search.set("limit", String(Math.trunc(filters.limit)));
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    const response = await this.request<{ claims: ContinuityClaim[] }>(`/continuity/claims${suffix}`, {
      method: "GET",
      auth: true,
    });
    return response.data.claims;
  }

  async createContinuityClaim(input: ContinuityClaimCreateInput): Promise<ContinuityClaim> {
    await this.ensureSession();
    const response = await this.request<{ claim: ContinuityClaim }>("/continuity/claims", {
      method: "POST",
      body: input,
      auth: true,
      expectedStatuses: [201],
    });
    return response.data.claim;
  }

  async addContinuityClaimEvidence(input: ContinuityClaimEvidenceCreateInput): Promise<ContinuityClaimEvidence> {
    await this.ensureSession();
    const response = await this.request<{ evidence: ContinuityClaimEvidence }>(
      `/continuity/claims/${encodeURIComponent(input.claimId)}/evidence`,
      {
				method: "POST",
				body: input,
				auth: true,
				expectedStatuses: [201],
      }
    );
    return response.data.evidence;
  }

  async verifyContinuityClaim(claimId: string): Promise<ContinuityClaimVerificationResult> {
    await this.ensureSession();
    const response = await this.request<ContinuityClaimVerificationResult>(
      `/continuity/claims/${encodeURIComponent(claimId)}/verify`,
      {
				method: "POST",
				auth: true,
      }
    );
    return response.data;
  }

  async markContinuityClaimStale(claimId: string, staleAt?: Date): Promise<ContinuityClaim> {
    await this.ensureSession();
    const response = await this.request<{ claim: ContinuityClaim }>(
      `/continuity/claims/${encodeURIComponent(claimId)}/stale`,
      {
				method: "POST",
				body: staleAt ? { staleAt: staleAt.toISOString() } : {},
				auth: true,
      }
    );
    return response.data.claim;
  }

  async inspectDreams(query: { proposalId?: string; runId?: string; status?: string } = {}): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const search = new URLSearchParams();
    if (typeof query.proposalId === "string" && query.proposalId.length > 0) {
      search.set("proposalId", query.proposalId);
    }
    if (typeof query.runId === "string" && query.runId.length > 0) {
      search.set("runId", query.runId);
    }
    if (typeof query.status === "string" && query.status.length > 0) {
      search.set("status", query.status);
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    const response = await this.request<Record<string, unknown>>(`/context/dreams${suffix}`, {
      method: "GET",
      auth: true,
    });
    return response.data;
  }

  async runDreamJob(body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/context/dreams/run", {
      method: "POST",
      body,
      auth: true,
      headers: this.paidHeaders("context_dream_run_v1", body, idempotencyKey),
    });
    return response.data;
  }

  async reviewDreamProposal(body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/context/dreams/review", {
      method: "POST",
      body,
      auth: true,
      headers: this.paidHeaders("context_dream_review_v1", body, idempotencyKey),
    });
    return response.data;
  }

  async reviewSelfModel(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/context/self-model/review", {
      method: "POST",
      body,
      auth: true,
    });
    return response.data;
  }

  async inspectInboxState(query: HostedInboxStateQuery = {}): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const search = new URLSearchParams();
    if (Array.isArray(query.statuses) && query.statuses.length > 0) {
      search.set("statuses", query.statuses.join(","));
    }
    if (Array.isArray(query.priorities) && query.priorities.length > 0) {
      search.set("priorities", query.priorities.join(","));
    }
    if (typeof query.contextId === "string" && query.contextId.length > 0) {
      search.set("context_id", query.contextId);
    }
    if (typeof query.messageType === "string" && query.messageType.length > 0) {
      search.set("message_type", query.messageType);
    }
    if (typeof query.unreadOnly === "boolean") {
      search.set("unread_only", String(query.unreadOnly));
    }
    if (typeof query.includeTerminal === "boolean") {
      search.set("include_terminal", String(query.includeTerminal));
    }
    if (typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
      search.set("limit", String(Math.trunc(query.limit)));
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    const response = await this.request<Record<string, unknown>>(`/messages/inbox/state${suffix}`, {
      method: "GET",
      auth: true,
    });
    return response.data;
  }

  async inspectObligations(query: HostedObligationsQuery = {}): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const search = new URLSearchParams();
    if (Array.isArray(query.statuses) && query.statuses.length > 0) {
      search.set("statuses", query.statuses.join(","));
    }
    if (typeof query.includeTerminal === "boolean") {
      search.set("include_terminal", String(query.includeTerminal));
    }
    if (typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
      search.set("limit", String(Math.trunc(query.limit)));
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    const response = await this.request<Record<string, unknown>>(`/obligations${suffix}`, {
      method: "GET",
      auth: true,
    });
    return response.data;
  }

  async evaluateEventRules(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/event-rules/evaluate", {
      method: "POST",
      body,
      auth: true,
    });
    return response.data;
  }

  async readPublicDiscoverySchema(): Promise<Record<string, unknown>> {
    const response = await this.request<Record<string, unknown>>("/public/discovery/schema", {
      method: "GET",
    });
    return response.data;
  }

  async inspectPublicDiscovery(query: HostedPublicDiscoveryQuery = {}): Promise<Record<string, unknown>> {
    const search = new URLSearchParams();
    if (Array.isArray(query.eventTypes) && query.eventTypes.length > 0) {
      search.set("event_type", query.eventTypes.join(","));
    }
    if (Array.isArray(query.authors) && query.authors.length > 0) {
      search.set("authors", query.authors.join(","));
    }
    if (typeof query.primaryId === "string" && query.primaryId.length > 0) {
      search.set("primary_id", query.primaryId);
    }
    if (typeof query.eventId === "string" && query.eventId.length > 0) {
      search.set("event_id", query.eventId);
    }
    if (typeof query.capabilityId === "string" && query.capabilityId.length > 0) {
      search.set("capability_id", query.capabilityId);
    }
    if (typeof query.offerId === "string" && query.offerId.length > 0) {
      search.set("offer_id", query.offerId);
    }
    if (typeof query.taskRef === "string" && query.taskRef.length > 0) {
      search.set("task_ref", query.taskRef);
    }
    if (typeof query.agentId === "string" && query.agentId.length > 0) {
      search.set("agent_id", query.agentId);
    }
    if (typeof query.status === "string" && query.status.length > 0) {
      search.set("status", query.status);
    }
    if (typeof query.since === "number" && Number.isFinite(query.since)) {
      search.set("since", String(Math.trunc(query.since)));
    }
    if (typeof query.until === "number" && Number.isFinite(query.until)) {
      search.set("until", String(Math.trunc(query.until)));
    }
    if (typeof query.latestOnly === "boolean") {
      search.set("latest_only", String(query.latestOnly));
    }
    if (typeof query.includeRaw === "boolean") {
      search.set("include_raw", String(query.includeRaw));
    }
    if (typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
      search.set("limit", String(Math.trunc(query.limit)));
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    const response = await this.request<Record<string, unknown>>(`/public/discovery/events${suffix}`, {
      method: "GET",
    });
    return response.data;
  }

  async publishRelayEvent(event: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/relay/publish", {
      method: "POST",
      body: { event },
      auth: true,
    });
    return response.data;
  }

  async replayInboxItem(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/messages/inbox/replay", {
      method: "POST",
      body,
      auth: true,
    });
    return response.data;
  }

  async acknowledgeInboxItem(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/messages/inbox/ack", {
      method: "POST",
      body,
      auth: true,
    });
    return response.data;
  }

  async resolveInboxItem(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/messages/inbox/resolve", {
      method: "POST",
      body,
      auth: true,
    });
    return response.data;
  }

  async reflectContextPack(body: HostedContextReflectRequest, idempotencyKey?: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/context/reflect", {
      method: "POST",
      body,
      auth: true,
      headers: this.paidHeaders("context_reflect_v1", body, idempotencyKey),
    });
    return response.data;
  }

  async createHandoff(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    void body;
    throw new Error("Hosted handoff creation is disabled: capsules must be signed and stored by the local runtime");
  }

  async verifyHandoff(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    void body;
    throw new Error("Hosted handoff verification is disabled: verify the exact capsule with the local runtime");
  }

  async inspectHandoff(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    void body;
    throw new Error("Hosted handoff inspection is disabled: inspect the verified capsule with the local runtime");
  }

  async readHandoff(handoffId: string): Promise<Record<string, unknown>> {
    void handoffId;
    throw new Error("Hosted handoff reads are disabled: read the signed record from the local runtime");
  }

  async acknowledgeHandoff(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    void body;
    throw new Error("Hosted handoff acknowledgements are disabled: update the local signed record");
  }

  async recordHandoffOutcome(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    void body;
    throw new Error("Hosted handoff outcomes are disabled: update the local signed record");
  }

  async searchMemory(body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/memory/search", {
      method: "POST",
      body,
      auth: true,
      headers: this.paidHeaders("memory_search_v1", body, idempotencyKey),
    });
    return response.data;
  }

  async hotSyncCapabilities(): Promise<{version:number;enabled:boolean}> {
    await this.ensureSession();
    return (await this.request<{version:number;enabled:boolean}>("/memory/hot-sync/capabilities",{auth:true,timeoutMs:5000})).data;
  }
  async readHotSync(namespace: string, scope: string, known?: HotSyncSnapshot): Promise<HotSyncSnapshot> {
    await this.ensureSession();
    const response=await this.request<HotSyncSnapshot>(`/memory/hot-sync?namespace=${encodeURIComponent(namespace)}&scope=${encodeURIComponent(scope)}`, {auth:true,timeoutMs:5000,expectedStatuses:[200,304],headers:known && known.revision>0?{"if-none-match":hotSyncEtag(this.config.npub,known)}:undefined});
    if(response.status===304){if(!known)throw new Error("Unexpected unchanged hot-sync response");return known;}
    return response.data;
  }
  async writeHotSync(base: HotSyncSnapshot, content: HotSyncEnvelope): Promise<HotSyncSnapshot> {
    await this.ensureSession();
    return (await this.request<HotSyncSnapshot>("/memory/hot-sync", {method:"PUT",auth:true,timeoutMs:5000,body:{protocol_version:HOT_SYNC_PROTOCOL_VERSION,namespace:base.namespace,scope:base.scope,expected_epoch:base.epoch,expected_revision:base.revision,content}})).data;
  }
  async resetHotSync(base: HotSyncSnapshot): Promise<HotSyncSnapshot> {
    await this.ensureSession();
    return (await this.request<HotSyncSnapshot>("/memory/hot-sync/reset", {method:"POST",auth:true,timeoutMs:5000,body:{protocol_version:HOT_SYNC_PROTOCOL_VERSION,namespace:base.namespace,scope:base.scope,expected_epoch:base.epoch,expected_revision:base.revision}})).data;
  }
  async listHotSync(namespace: string, cursor: string | null = null): Promise<{scopes: HotSyncSnapshot[];next_cursor:string|null}> {
    await this.ensureSession();
    return (await this.request<{scopes:HotSyncSnapshot[];next_cursor:string|null}>(`/memory/hot-sync/scopes?namespace=${encodeURIComponent(namespace)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {auth:true,timeoutMs:5000})).data;
  }

  async readHotMemory(scope?: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const suffix = scope ? `?scope=${encodeURIComponent(scope)}` : "";
    const response = await this.request<Record<string, unknown>>(`/memory/hot${suffix}`, {
      timeoutMs,
      method: "GET",
      auth: true,
    });
    return await this.verifiedHotMemoryResponse(response.data, scope);
  }

  async writeHotMemory(content: string, scope?: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const signedContent = await this.signMemory(content, scope);
    const response = await this.request<Record<string, unknown>>("/memory/hot", {
      method: "PUT",
      body: scope ? { content: signedContent, scope } : { content: signedContent },
      auth: true,
      expectedStatuses: [200],
    });
    return response.data;
  }

  async createWarmMemory(body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/memory/warm", {
      method: "POST",
      body,
      auth: true,
      headers: this.paidHeaders("memory_warm_write_v1", body, idempotencyKey),
    });
    return response.data;
  }

  async listWarmMemory(filter: { type?: string; status?: string; includeSystemMemory?: boolean } = {}): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const search = new URLSearchParams();
    if (filter.type) {
      search.set("type", filter.type);
    }
    if (filter.status) {
      search.set("status", filter.status);
    }
    if (filter.includeSystemMemory) {
      search.set("include_system", "true");
    }
    const response = await this.request<Record<string, unknown>>(
      `/memory/warm${search.size > 0 ? `?${search.toString()}` : ""}`,
      {
      method: "GET",
      auth: true,
    });
    return response.data;
  }

  async evaluateWarmMemory(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const response = await this.request<Record<string, unknown>>("/memory/warm/evaluate", {
      method: "POST",
      body,
      auth: true,
    });
    return response.data;
  }

  async ingestColdMemory(items: Record<string, unknown>[], idempotencyKey?: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    const body = { items };
    const response = await this.request<Record<string, unknown>>("/memory/cold/ingest", {
      method: "POST",
      body,
      auth: true,
      headers: this.paidHeaders("memory_cold_ingest_v1", body, idempotencyKey),
    });
    return response.data;
  }

  async exportMemory(idempotencyKey?: string): Promise<Record<string, unknown>> {
    await this.ensureSession();
    // Export takes no request body, so default to a fresh per-call key rather than a
    // body-derived one (which would be constant and collapse every export into one charge).
    const response = await this.request<Record<string, unknown>>("/memory/export", {
      method: "POST",
      body: {},
      auth: true,
      headers: this.paidHeaders("memory_export_v1", { ts: Date.now(), nonce: randomUUID() }, idempotencyKey),
    });
    return response.data;
  }
}
