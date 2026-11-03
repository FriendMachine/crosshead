export const organizationalWorkerReadinessSchemaVersion =
  "onlybots.organizational-worker-readiness.v1" as const;

export const organizationalWorkerCapabilityNames = [
  "federationBindings",
  "assignmentInspection",
  "assignmentAcceptance",
  "execution",
  "cancellation",
  "recovery",
  "outboxDelivery",
] as const;

export type OrganizationalWorkerCapability =
  (typeof organizationalWorkerCapabilityNames)[number];

export const organizationalWorkerReasonCodes = [
  "disabled_by_config",
  "environment_not_local_or_lab",
  "organization_store_unavailable",
  "runtime_profile_unavailable",
  "identity_binding_unavailable",
  "baseplate_assignment_read_unavailable",
  "issuer_principal_not_attested",
  "lease_status_endpoint_unavailable",
  "capability_status_endpoint_unavailable",
  "assignment_delivery_unavailable",
  "cancellation_delivery_unavailable",
  "adapter_not_configured",
  "live_execution_authority_unavailable",
  "delivery_reconciliation_unavailable",
  "workspace_binding_unavailable",
  "outbound_transport_unavailable",
  "outbox_reconciliation_required",
] as const;

export type OrganizationalWorkerReadinessReasonCode =
  (typeof organizationalWorkerReasonCodes)[number];

export type OrganizationalWorkerMode = "off" | "inspect" | "active";

export type OrganizationalWorkerReadinessState =
  | "DISABLED"
  | "INSPECTION_READY"
  | "DELIVERY_READY"
  | "BOUNDED_EXECUTION_READY"
  | "UNAVAILABLE"
  | "ACTIVE_READY";

export type OrganizationalWorkerCapabilities = Record<
  OrganizationalWorkerCapability,
  boolean
>;

export type OrganizationalWorkerReadiness = {
  schemaVersion: typeof organizationalWorkerReadinessSchemaVersion;
  configuredMode: OrganizationalWorkerMode;
  state: OrganizationalWorkerReadinessState;
  capabilities: OrganizationalWorkerCapabilities;
  reasonCodes: OrganizationalWorkerReadinessReasonCode[];
};

const allCapabilities = (enabled: boolean): OrganizationalWorkerCapabilities => ({
  federationBindings: enabled,
  assignmentInspection: enabled,
  assignmentAcceptance: enabled,
  execution: enabled,
  cancellation: enabled,
  recovery: enabled,
  outboxDelivery: enabled,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const disabledReadiness = (): OrganizationalWorkerReadiness => ({
  schemaVersion: organizationalWorkerReadinessSchemaVersion,
  configuredMode: "off",
  state: "DISABLED",
  capabilities: allCapabilities(false),
  reasonCodes: ["disabled_by_config"],
});

const activeReadiness = (): OrganizationalWorkerReadiness => ({
  schemaVersion: organizationalWorkerReadinessSchemaVersion,
  configuredMode: "active",
  state: "ACTIVE_READY",
  capabilities: allCapabilities(true),
  reasonCodes: [],
});

const hasAnyCapability = (capabilities: OrganizationalWorkerCapabilities): boolean =>
  organizationalWorkerCapabilityNames.some((name) => capabilities[name]);

const hasAnyActiveCapability = (
  capabilities: OrganizationalWorkerCapabilities
): boolean =>
  [
    "assignmentAcceptance",
    "execution",
    "cancellation",
    "recovery",
    "outboxDelivery",
  ].some((name) => capabilities[name as OrganizationalWorkerCapability]);

const validateReadiness = (
  value: OrganizationalWorkerReadiness,
  workerApiAvailable: boolean
): OrganizationalWorkerReadiness => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("organizational worker readiness must be an object");
  }
  const topLevelKeys = Object.keys(value).sort();
  const expectedTopLevelKeys = [
    "capabilities",
    "configuredMode",
    "reasonCodes",
    "schemaVersion",
    "state",
  ];
  if (
    topLevelKeys.length !== expectedTopLevelKeys.length ||
    topLevelKeys.some((key, index) => key !== expectedTopLevelKeys[index])
  ) {
    throw new Error(
      "organizational worker readiness must contain exactly the supported fields"
    );
  }
  if (value.schemaVersion !== organizationalWorkerReadinessSchemaVersion) {
    throw new Error(
      `organizational worker readiness schemaVersion must be ${organizationalWorkerReadinessSchemaVersion}`
    );
  }
  if (!["off", "inspect", "active"].includes(value.configuredMode)) {
    throw new Error("organizational worker readiness configuredMode is invalid");
  }
  if (
    ![
      "DISABLED",
      "INSPECTION_READY",
      "DELIVERY_READY",
      "BOUNDED_EXECUTION_READY",
      "UNAVAILABLE",
      "ACTIVE_READY",
    ].includes(
      value.state
    )
  ) {
    throw new Error("organizational worker readiness state is invalid");
  }
  if (!value.capabilities || typeof value.capabilities !== "object") {
    throw new Error("organizational worker readiness capabilities must be an object");
  }
  const capabilityKeys = Object.keys(value.capabilities).sort();
  const expectedCapabilityKeys = [...organizationalWorkerCapabilityNames].sort();
  if (
    capabilityKeys.length !== expectedCapabilityKeys.length ||
    capabilityKeys.some((key, index) => key !== expectedCapabilityKeys[index])
  ) {
    throw new Error(
      "organizational worker readiness capabilities must contain exactly the supported capability names"
    );
  }
  for (const name of organizationalWorkerCapabilityNames) {
    if (typeof value.capabilities[name] !== "boolean") {
      throw new Error(
        `organizational worker readiness capability ${name} must be boolean`
      );
    }
  }
  if (!Array.isArray(value.reasonCodes)) {
    throw new Error("organizational worker readiness reasonCodes must be an array");
  }
  const uniqueReasonCodes = new Set(value.reasonCodes);
  if (uniqueReasonCodes.size !== value.reasonCodes.length) {
    throw new Error("organizational worker readiness reasonCodes must be unique");
  }
  for (const reasonCode of value.reasonCodes) {
    if (
      !organizationalWorkerReasonCodes.includes(
        reasonCode as OrganizationalWorkerReadinessReasonCode
      )
    ) {
      throw new Error(
        `organizational worker readiness reasonCode ${String(reasonCode)} is invalid`
      );
    }
  }

  const anyCapability = hasAnyCapability(value.capabilities);
  if (!workerApiAvailable && anyCapability) {
    throw new Error(
      "organizational worker readiness cannot advertise capabilities without a worker API"
    );
  }
  if (value.configuredMode === "off" && anyCapability) {
    throw new Error("an organizational worker configured off cannot advertise capabilities");
  }
  if (value.state === "DISABLED") {
    if (value.configuredMode !== "off" || anyCapability) {
      throw new Error("DISABLED organizational worker readiness must be off with no capabilities");
    }
    if (!value.reasonCodes.includes("disabled_by_config")) {
      throw new Error("DISABLED organizational worker readiness must explain disabled_by_config");
    }
  }
  if (value.state === "UNAVAILABLE" && anyCapability) {
    throw new Error("UNAVAILABLE organizational worker readiness cannot advertise capabilities");
  }
  if (value.state === "INSPECTION_READY") {
    if (value.configuredMode !== "inspect") {
      throw new Error("INSPECTION_READY organizational worker readiness requires inspect mode");
    }
    if (
      !value.capabilities.assignmentInspection &&
      !value.capabilities.federationBindings
    ) {
      throw new Error(
        "INSPECTION_READY requires a federation or assignment inspection capability"
      );
    }
    if (hasAnyActiveCapability(value.capabilities)) {
      throw new Error("INSPECTION_READY cannot advertise active worker capabilities");
    }
  }
  if (value.state === "DELIVERY_READY") {
    if (value.configuredMode !== "active") {
      throw new Error("DELIVERY_READY organizational worker readiness requires active mode");
    }
    if (
      !value.capabilities.federationBindings ||
      !value.capabilities.assignmentInspection ||
      !value.capabilities.assignmentAcceptance ||
      value.capabilities.execution ||
      !value.capabilities.cancellation ||
      !value.capabilities.recovery ||
      !value.capabilities.outboxDelivery
    ) {
      throw new Error(
	"DELIVERY_READY must expose the durable delivery capabilities and keep execution disabled"
      );
    }
    if (
      value.reasonCodes.length !== 2 ||
      value.reasonCodes[0] !== "live_execution_authority_unavailable" ||
      value.reasonCodes[1] !== "delivery_reconciliation_unavailable"
    ) {
      throw new Error(
	"DELIVERY_READY must explain its execution-authority and stream-reconciliation limits"
      );
    }
  }
  if (value.state === "BOUNDED_EXECUTION_READY") {
    if (value.configuredMode !== "active") {
      throw new Error(
	"BOUNDED_EXECUTION_READY organizational worker readiness requires active mode"
      );
    }
    if (
      organizationalWorkerCapabilityNames.some(
	(name) => !value.capabilities[name]
      )
    ) {
      throw new Error(
	"BOUNDED_EXECUTION_READY must advertise every composed worker capability"
      );
    }
    if (
      value.reasonCodes.length !== 1 ||
      value.reasonCodes[0] !== "delivery_reconciliation_unavailable"
    ) {
      throw new Error(
	"BOUNDED_EXECUTION_READY must preserve the external reconciliation limitation"
      );
    }
  }
  if (value.state === "ACTIVE_READY") {
    if (value.configuredMode !== "active") {
      throw new Error("ACTIVE_READY organizational worker readiness requires active mode");
    }
    if (organizationalWorkerCapabilityNames.some((name) => !value.capabilities[name])) {
      throw new Error("ACTIVE_READY must advertise every organizational worker capability");
    }
    if (value.reasonCodes.length > 0) {
      throw new Error("ACTIVE_READY cannot include unavailability reasons");
    }
  }
  return {
    schemaVersion: organizationalWorkerReadinessSchemaVersion,
    configuredMode: value.configuredMode,
    state: value.state,
    capabilities: {
      federationBindings: value.capabilities.federationBindings,
      assignmentInspection: value.capabilities.assignmentInspection,
      assignmentAcceptance: value.capabilities.assignmentAcceptance,
      execution: value.capabilities.execution,
      cancellation: value.capabilities.cancellation,
      recovery: value.capabilities.recovery,
      outboxDelivery: value.capabilities.outboxDelivery,
    },
    reasonCodes: [...value.reasonCodes],
  };
};

export const normalizeOrganizationalWorkerReadiness = (
  value: OrganizationalWorkerReadiness | undefined,
  workerApiAvailable: boolean,
  allowImplicitActive: boolean = false
): OrganizationalWorkerReadiness => {
  if (value === undefined && workerApiAvailable && !allowImplicitActive) {
    throw new Error(
      "a generalized organizational worker API requires explicit readiness"
    );
  }
  return validateReadiness(
    value ?? (workerApiAvailable ? activeReadiness() : disabledReadiness()),
    workerApiAvailable
  );
};

export const cloneOrganizationalWorkerReadiness = (
  value: OrganizationalWorkerReadiness
): OrganizationalWorkerReadiness => clone(value);

export class OrganizationalWorkerCapabilityUnavailableError extends Error {
  readonly code = "ORGANIZATIONAL_WORKER_CAPABILITY_UNAVAILABLE";

  constructor(
    readonly capability: OrganizationalWorkerCapability,
    readonly readiness: OrganizationalWorkerReadiness
  ) {
    super(`organizational worker capability ${capability} is unavailable`);
    this.name = "OrganizationalWorkerCapabilityUnavailableError";
  }
}
