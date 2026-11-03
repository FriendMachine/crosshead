// Wire contract for the daemon's organizational-worker federation-status
// endpoint. The observer implementation ships only in operator builds.
// Reference to an organization's binding of an agent to a federated worker.
export type AgentFederationBindingRef = {
  bindingRef: string;
  ownerSystem: "onlybots";
  immutableVersion: string;
  contentDigest: string;
  issuerRef: string;
  statusCheckRef: string;
};

export type OrganizationalWorkerFederationObservationStatus =
  | "active"
  | "stale"
  | "inactive";

export const ORGANIZATIONAL_WORKER_FEDERATION_STATUS_VERSION =
  "onlybots.agent-federation-status/v1" as const;
export const ORGANIZATIONAL_WORKER_FEDERATION_STATUS_ACTOR_KIND =
  "ACTOR_KIND_SERVICE" as const;

export type OrganizationalWorkerFederationStatusRequest = {
  bearerToken: string | null;
  localControlTokenPresented: boolean;
  method: string | null;
  queryPresent: boolean;
  bodyPresent: boolean;
  tenantId: string | null;
  siteId: string | null;
  principalId: string | null;
  actorKind: string | null;
  organizationId: string;
  agentId: string;
  bindingRef: string;
  statusCheckRef: string;
};

export type OrganizationalWorkerFederationStatusResponse = {
  schemaVersion: typeof ORGANIZATIONAL_WORKER_FEDERATION_STATUS_VERSION;
  status: OrganizationalWorkerFederationObservationStatus;
  checkedAt: string;
  observer: {
    ownerSystem: "baseplate";
    tenantId: string;
    siteId: string;
    principalId: string;
  };
  binding: {
    organizationId: string;
    agentId: string;
    agentNpub: string;
    hostAttachmentRef: string;
    workerPrincipalId: string;
    executorRouteId: string;
    resourceBindingId: string;
  };
  reference: AgentFederationBindingRef;
};

export type OrganizationalWorkerFederationStatusErrorCode =
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "UNAVAILABLE";

export class OrganizationalWorkerFederationStatusError extends Error {
  constructor(
    readonly reasonCode: OrganizationalWorkerFederationStatusErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OrganizationalWorkerFederationStatusError";
  }
}

export interface OrganizationalWorkerFederationStatusObserver {
  observe(
    request: OrganizationalWorkerFederationStatusRequest
  ): Promise<OrganizationalWorkerFederationStatusResponse>;
}
