import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";

import type {
  RuntimeAttachRequest,
  RuntimeAttachResponse,
  RuntimeDetachRequest,
  RuntimeAdapterRecord,
  RuntimeContinuityInspection,
  RuntimeContinuityPatchMutation,
  RuntimeDoctorReport,
  RuntimeStatus,
} from "./local-runtime";
import type {
  RuntimeLifecycleActivity,
  RuntimeLifecycleEventRequest,
  RuntimeLifecycleEventResponse,
} from "./lifecycle-engine";
import type { PersistentAgentInspection, PersistentAgentLineageInspection } from "./persistent-agent-fork";
import { resolveOnlyBotsHome } from "./runtime-env";

const LOCAL_TOKEN_HEADER = "x-onlybots-local-token";

type LocalRuntimeClientOptions = {
  home?: string;
  timeoutMs?: number;
};

type DaemonStateSnapshot = {
  status: "running" | "stopped";
  port: number | null;
  controlToken: string;
};

const resolveRuntimeHome = (home?: string): string => resolveOnlyBotsHome(home);

const daemonStateFile = (home: string): string => path.join(home, "state", "daemon.json");

const parseDaemonState = (filePath: string): DaemonStateSnapshot | null => {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (
      (parsed.status === "running" || parsed.status === "stopped") &&
      (typeof parsed.port === "number" || parsed.port === null) &&
      typeof parsed.controlToken === "string"
    ) {
      return {
        status: parsed.status,
        port: parsed.port,
        controlToken: parsed.controlToken,
      };
    }
  } catch {
    // Ignore corrupt state and surface a higher-level unavailable error.
  }
  return null;
};

export class LocalRuntimeClient {
  private readonly runtimeHome: string;
  private readonly timeoutMs: number;

  constructor(options: LocalRuntimeClientOptions = {}) {
    this.runtimeHome = resolveRuntimeHome(options.home);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  home(): string {
    return this.runtimeHome;
  }

  private daemonState(): DaemonStateSnapshot {
    const state = parseDaemonState(daemonStateFile(this.runtimeHome));
    if (!state || state.status !== "running" || !state.port) {
      throw new Error("Crosshead local runtime daemon is not running");
    }
    return state;
  }

  private async request<T>(
    method: "GET" | "POST",
    route: string,
    options: { query?: Record<string, string | undefined>; body?: unknown } = {}
  ): Promise<T> {
    const state = this.daemonState();
    const url = new URL(`http://127.0.0.1:${state.port}${route}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (typeof value === "string" && value.length > 0) {
        url.searchParams.set(key, value);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          [LOCAL_TOKEN_HEADER]: state.controlToken,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const data = (await response.json()) as T | { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(
          typeof (data as { error?: { message?: string } }).error?.message === "string"
            ? (data as { error: { message: string } }).error.message
            : `Local runtime request failed with ${response.status}`
        );
      }
      return data as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async status(profileName?: string): Promise<RuntimeStatus> {
    return this.request<RuntimeStatus>("GET", "/v1/status", {
      query: {
        profile: profileName,
      },
    });
  }

  /** Operator builds supply the federation binding input/result types. */
  async issueWorkerFederationBinding<TResult = unknown>(body: unknown): Promise<TResult> {
    return this.request<TResult>("POST", "/v1/organizational-worker/federation-bindings", { body });
  }

  async doctor(profileName?: string): Promise<RuntimeDoctorReport> {
    return this.request<RuntimeDoctorReport>("GET", "/v1/doctor", {
      query: {
        profile: profileName,
      },
    });
  }

  async inspectContinuityPolicy(): Promise<RuntimeContinuityInspection> {
    return this.request<RuntimeContinuityInspection>("GET", "/v1/continuity/policy");
  }

  async inspectContinuityState(): Promise<RuntimeContinuityInspection> {
    return this.request<RuntimeContinuityInspection>("GET", "/v1/continuity/state");
  }

  async applyContinuityPatch(body: Record<string, unknown>): Promise<RuntimeContinuityPatchMutation> {
    return this.request<RuntimeContinuityPatchMutation>("POST", "/v1/continuity/patches", {
      body,
    });
  }

  async removeContinuityPatch(body: Record<string, unknown>): Promise<RuntimeContinuityPatchMutation> {
    return this.request<RuntimeContinuityPatchMutation>("POST", "/v1/continuity/patches/remove", {
      body,
    });
  }

  async readActivity(lines: number = 50): Promise<RuntimeLifecycleActivity> {
    return this.request<RuntimeLifecycleActivity>("GET", "/v1/events", {
      query: {
        lines: String(lines),
      },
    });
  }

  async attachAdapter(request: RuntimeAttachRequest): Promise<RuntimeAttachResponse> {
    return this.request<RuntimeAttachResponse>("POST", "/v1/adapters/attach", {
      body: request,
    });
  }

  async detachAdapter(request: RuntimeDetachRequest): Promise<RuntimeAdapterRecord> {
    return this.request<RuntimeAdapterRecord>("POST", "/v1/adapters/detach", { body: request });
  }

  async emitEvent(request: RuntimeLifecycleEventRequest): Promise<RuntimeLifecycleEventResponse> {
    return this.request<RuntimeLifecycleEventResponse>("POST", "/v1/events", {
      body: request,
    });
  }

  async searchMemory(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/memory/search", {
      body,
    });
  }

  async readHotMemory(profileName?: string, scope?: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v1/memory/hot", {
      query: {
        profile: profileName,
				scope,
      },
    });
  }

  async listWarmMemory(
    profileName?: string,
    filter: { type?: string; status?: string; includeSystemMemory?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v1/memory/warm", {
      query: {
        profile: profileName,
        type: filter.type,
        status: filter.status,
        include_system: filter.includeSystemMemory ? "true" : undefined,
      },
    });
  }

  async inspectContinuityJudgment(profileName?: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v1/context/judgment", {
      query: {
        profile: profileName,
      },
    });
  }

  async inspectContinuity(profileName?: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v1/context/continuity", {
      query: {
        profile: profileName,
      },
    });
  }

  async inspectDreams(
    profileName?: string,
    filter: { proposalId?: string; runId?: string; status?: string } = {}
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v1/context/dreams", {
      query: {
        profile: profileName,
	proposalId: filter.proposalId,
        runId: filter.runId,
        status: filter.status,
      },
    });
  }

  async runDreamJob(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/context/dreams/run", {
      body,
    });
  }

  async reviewDreamProposal(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/context/dreams/review", {
      body,
    });
  }

  async readPublicDiscoverySchema(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v1/public/discovery/schema");
  }

  async inspectPublicDiscovery(
    profileName?: string,
    filter: {
      eventType?: string;
      authors?: string;
      primaryId?: string;
      eventId?: string;
      capabilityId?: string;
      offerId?: string;
      taskRef?: string;
      agentId?: string;
      status?: string;
      since?: string;
      until?: string;
      latestOnly?: string;
      includeRaw?: string;
      limit?: string;
    } = {}
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v1/public/discovery/events", {
      query: {
		profile: profileName,
		event_type: filter.eventType,
		authors: filter.authors,
		primary_id: filter.primaryId,
		event_id: filter.eventId,
		capability_id: filter.capabilityId,
		offer_id: filter.offerId,
		task_ref: filter.taskRef,
		agent_id: filter.agentId,
		status: filter.status,
		since: filter.since,
		until: filter.until,
		latest_only: filter.latestOnly,
		include_raw: filter.includeRaw,
		limit: filter.limit,
      },
    });
  }

  async publishPublicDiscovery(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/public/discovery/publish", {
      body,
    });
  }

  async evaluateWarmMemory(profileName?: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/memory/warm/evaluate", {
      body: {
        ...body,
        profileName,
      },
    });
  }

  async exportMemory(profileName?: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/memory/export", {
      body: profileName ? { profileName } : {},
    });
  }

  async inspectInboxState(
    profileName?: string,
    filter: {
      statuses?: string[];
      priorities?: string[];
      contextId?: string;
      messageType?: string;
      unreadOnly?: boolean;
      includeTerminal?: boolean;
      limit?: number;
    } = {}
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v1/messages/inbox/state", {
      query: {
		profile: profileName,
		statuses: filter.statuses?.join(","),
		priorities: filter.priorities?.join(","),
		context_id: filter.contextId,
		message_type: filter.messageType,
		unread_only: typeof filter.unreadOnly === "boolean" ? String(filter.unreadOnly) : undefined,
		include_terminal: typeof filter.includeTerminal === "boolean" ? String(filter.includeTerminal) : undefined,
		limit: typeof filter.limit === "number" ? String(Math.trunc(filter.limit)) : undefined,
      },
    });
  }

  async replayInboxItem(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/messages/inbox/replay", {
      body,
    });
  }

  async acknowledgeInboxItem(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/messages/inbox/ack", {
      body,
    });
  }

  async resolveInboxItem(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/messages/inbox/resolve", {
      body,
    });
  }

  async inspectAgent(profileName?: string, agentId?: string): Promise<PersistentAgentInspection> {
    if (typeof agentId === "string" && agentId.trim().length > 0) {
      return this.request<PersistentAgentInspection>("GET", `/v1/agents/${encodeURIComponent(agentId)}`, {
        query: {
          profile: profileName,
        },
      });
    }
    return this.request<PersistentAgentInspection>("GET", "/v1/agents/current", {
      query: {
        profile: profileName,
      },
    });
  }

  async inspectLineage(profileName?: string, agentId?: string): Promise<PersistentAgentLineageInspection> {
    const route =
      typeof agentId === "string" && agentId.trim().length > 0
        ? `/v1/agents/${encodeURIComponent(agentId)}/lineage`
        : "/v1/agents/current/lineage";
    return this.request<PersistentAgentLineageInspection>("GET", route, {
      query: {
        profile: profileName,
      },
    });
  }

  async forkAgent(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/agents/fork", {
      body,
    });
  }

  async createHandoff(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/handoffs/create", {
      body,
    });
  }

  async verifyHandoff(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/handoffs/verify", {
      body,
    });
  }

  async inspectHandoff(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/handoffs/inspect", {
      body,
    });
  }

  async readHandoff(handoffId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", `/v1/handoffs/${encodeURIComponent(handoffId)}`);
  }

  async acknowledgeHandoff(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/handoffs/ack", {
      body,
    });
  }

  async recordHandoffOutcome(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/v1/handoffs/outcome", {
      body,
    });
  }
}
