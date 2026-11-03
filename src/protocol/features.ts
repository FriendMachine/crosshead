import { crossheadEnvironment } from "./environment";
export const FEATURE_GATE_SCHEMA_VERSION = "feature_gates_v1" as const;
export const CAPABILITY_DOCUMENT_SCHEMA_VERSION = "onlybots_capabilities_v1" as const;

export const ONLYBOTS_ENVIRONMENTS = [
  "test",
  "local",
  "lab",
  "staging",
  "production",
] as const;

export type OnlyBotsEnvironment = (typeof ONLYBOTS_ENVIRONMENTS)[number];

export const FEATURE_GATE_STATES = ["off", "internal", "dogfood", "public"] as const;
export type FeatureGateState = (typeof FEATURE_GATE_STATES)[number];

export const FEATURE_GATE_IDS = [
  "live_irc_lab",
  "llm_social_agents",
  "external_social_transports",
  "public_app_surfaces",
  "fleet_console",
  "paid_actions",
  "external_mutations",
  "hosted_service_connections",
  "dreaming_review",
  "social_memory_disclosure",
  "skill_registration",
  "metrics_endpoint",
] as const;

export type FeatureGateId = (typeof FEATURE_GATE_IDS)[number];

export interface FeatureGateDefinition {
  readonly id: FeatureGateId;
  readonly title: string;
  readonly description: string;
  readonly default_state_by_environment: Record<OnlyBotsEnvironment, FeatureGateState>;
  readonly production_guard?: "must_be_off";
}

export interface FeatureGateStatus {
  readonly id: FeatureGateId;
  readonly title: string;
  readonly description: string;
  readonly state: FeatureGateState;
  readonly enabled: boolean;
  readonly default_state: FeatureGateState;
  readonly override_env?: string;
}

export interface FeatureGateSnapshot {
  readonly schema_version: typeof FEATURE_GATE_SCHEMA_VERSION;
  readonly environment: OnlyBotsEnvironment;
  readonly raw_environment: string;
  readonly source: "environment";
  readonly feature_gates: Record<FeatureGateId, FeatureGateStatus>;
}

export interface CapabilityDocument {
  readonly schema_version: typeof CAPABILITY_DOCUMENT_SCHEMA_VERSION;
  readonly environment: OnlyBotsEnvironment;
  readonly raw_environment: string;
  readonly source: "environment" | "bundled" | "server" | "cache";
  readonly feature_gates: FeatureGateSnapshot["feature_gates"];
  readonly cli_discovery: {
    readonly bundled_manifest: boolean;
    readonly server_refresh_optional: boolean;
    readonly help_requires_network: boolean;
  };
}

export const FEATURE_GATE_DEFINITIONS: readonly FeatureGateDefinition[] = [
  {
    id: "live_irc_lab",
    title: "Live IRC lab",
    description: "Local/lab IRC environment for watching social agents and disclosure traces.",
    production_guard: "must_be_off",
    default_state_by_environment: {
      test: "internal",
      local: "internal",
      lab: "dogfood",
      staging: "off",
      production: "off",
    },
  },
  {
    id: "llm_social_agents",
    title: "LLM social agents",
    description: "OpenAI-backed social agents in live lab or exploratory transports.",
    production_guard: "must_be_off",
    default_state_by_environment: {
      test: "internal",
      local: "internal",
      lab: "dogfood",
      staging: "off",
      production: "off",
    },
  },
  {
    id: "external_social_transports",
    title: "External social transports",
    description: "Slack, Telegram, and similar non-IRC social ingress transports.",
    production_guard: "must_be_off",
    default_state_by_environment: {
      test: "off",
      local: "off",
      lab: "off",
      staging: "off",
      production: "off",
    },
  },
  {
    id: "public_app_surfaces",
    title: "Public app surfaces",
    description: "Browser-facing app experiences beyond the public API and static discovery pages.",
    production_guard: "must_be_off",
    default_state_by_environment: {
      test: "internal",
      local: "dogfood",
      lab: "dogfood",
      staging: "dogfood",
      production: "off",
    },
  },
  {
    id: "fleet_console",
    title: "Fleet console",
    description:
      "Human sign-in at /account for organizations, members, agent fleets, organization credits, and hosted runs. Requires verified email delivery outside local/test.",
    default_state_by_environment: {
      test: "internal",
      local: "dogfood",
      lab: "dogfood",
      staging: "dogfood",
      production: "off",
    },
  },
  {
    id: "paid_actions",
    title: "Paid actions",
    description: "Credit-backed operations such as message send, handoff, warmup, and dream apply.",
    default_state_by_environment: {
      test: "internal",
      local: "dogfood",
      lab: "dogfood",
      staging: "dogfood",
      production: "public",
    },
  },
  {
    id: "external_mutations",
    title: "External mutations",
    description: "Actions that can mutate connected external services or spend externally held funds.",
    default_state_by_environment: {
      test: "internal",
      local: "internal",
      lab: "internal",
      staging: "dogfood",
      production: "internal",
    },
  },
  {
    id: "hosted_service_connections",
    title: "Hosted service connections",
    description: "Brokered use of organization service credentials by hosted executions.",
    production_guard: "must_be_off",
    default_state_by_environment: {
      test: "internal",
      local: "internal",
      lab: "internal",
      staging: "off",
      production: "off",
    },
  },
  {
    id: "dreaming_review",
    title: "Dreaming review",
    description: "Dream proposal review, apply, and operator-facing continuity workflows.",
    default_state_by_environment: {
      test: "internal",
      local: "dogfood",
      lab: "dogfood",
      staging: "dogfood",
      production: "internal",
    },
  },
  {
    id: "social_memory_disclosure",
    title: "Social memory disclosure",
    description: "Audience-scoped retrieval and provenance-backed disclosure controls.",
    default_state_by_environment: {
      test: "internal",
      local: "dogfood",
      lab: "dogfood",
      staging: "dogfood",
      production: "internal",
    },
  },
  {
    id: "skill_registration",
    title: "Skill registration",
    description: "Runtime skill registration endpoints and manifest publishing surfaces.",
    default_state_by_environment: {
      test: "internal",
      local: "internal",
      lab: "internal",
      staging: "off",
      production: "off",
    },
  },
  {
    id: "metrics_endpoint",
    title: "Metrics endpoint",
    description: "Prometheus-style metrics endpoint exposure.",
    default_state_by_environment: {
      test: "internal",
      local: "internal",
      lab: "internal",
      staging: "internal",
      production: "off",
    },
  },
];

const DEFINITION_BY_ID = Object.fromEntries(
  FEATURE_GATE_DEFINITIONS.map((definition) => [definition.id, definition]),
) as Record<FeatureGateId, FeatureGateDefinition>;

const ENV_ALIASES: Record<string, OnlyBotsEnvironment> = {
  ci: "test",
  dev: "local",
  development: "local",
  prod: "production",
};

export function normalizeOnlyBotsEnvironment(raw: string | undefined | null): OnlyBotsEnvironment {
  const normalized = (raw ?? "local").trim().toLowerCase();
  if ((ONLYBOTS_ENVIRONMENTS as readonly string[]).includes(normalized)) {
    return normalized as OnlyBotsEnvironment;
  }
  return ENV_ALIASES[normalized] ?? "local";
}

export function featureGateEnvKey(id: FeatureGateId): string {
  return `ONLYBOTS_FEATURE_${id.toUpperCase()}`;
}

export function parseFeatureGateState(raw: string, envKey: string): FeatureGateState {
  const normalized = raw.trim().toLowerCase();
  if ((FEATURE_GATE_STATES as readonly string[]).includes(normalized)) {
    return normalized as FeatureGateState;
  }
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return "dogfood";
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return "off";
  }
  throw new Error(
    `${envKey} must be one of ${FEATURE_GATE_STATES.join(", ")} or a boolean-like value`,
  );
}

export function buildFeatureGateSnapshot(input?: {
  readonly environment?: string | null;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): FeatureGateSnapshot {
  const env = crossheadEnvironment(input?.env ?? {});
  const rawEnvironment = input?.environment ?? env.CROSSHEAD_ENV ?? "local";
  const environment = normalizeOnlyBotsEnvironment(rawEnvironment);
  const feature_gates = {} as Record<FeatureGateId, FeatureGateStatus>;

  for (const id of FEATURE_GATE_IDS) {
    const definition = DEFINITION_BY_ID[id];
    const envKey = featureGateEnvKey(id);
    const overrideValue = env[envKey];
    const default_state = definition.default_state_by_environment[environment];
    const state =
      overrideValue === undefined ? default_state : parseFeatureGateState(overrideValue, envKey);
    feature_gates[id] = {
      id,
      title: definition.title,
      description: definition.description,
      state,
      enabled: state !== "off",
      default_state,
      ...(overrideValue === undefined ? {} : { override_env: envKey }),
    };
  }

  const snapshot: FeatureGateSnapshot = {
    schema_version: FEATURE_GATE_SCHEMA_VERSION,
    environment,
    raw_environment: String(rawEnvironment),
    source: "environment",
    feature_gates,
  };
  validateFeatureGateSnapshot(snapshot);
  return snapshot;
}

export function validateFeatureGateSnapshot(snapshot: FeatureGateSnapshot): void {
  if (snapshot.environment !== "production") {
    return;
  }
  const unsafe = FEATURE_GATE_DEFINITIONS.filter(
    (definition) =>
      definition.production_guard === "must_be_off" &&
      snapshot.feature_gates[definition.id]?.state !== "off",
  );
  if (unsafe.length > 0) {
    const ids = unsafe.map((definition) => definition.id).join(", ");
    throw new Error(`production feature policy requires these gates to be off: ${ids}`);
  }
}

export function isFeatureEnabled(
  snapshot: FeatureGateSnapshot | undefined,
  id: FeatureGateId,
): boolean {
  return snapshot?.feature_gates[id]?.enabled ?? false;
}

export function featureGateState(
  snapshot: FeatureGateSnapshot | undefined,
  id: FeatureGateId,
): FeatureGateState {
  return snapshot?.feature_gates[id]?.state ?? "off";
}

export function buildCapabilityDocument(
  snapshot: FeatureGateSnapshot,
  source: CapabilityDocument["source"] = snapshot.source,
): CapabilityDocument {
  return {
    schema_version: CAPABILITY_DOCUMENT_SCHEMA_VERSION,
    environment: snapshot.environment,
    raw_environment: snapshot.raw_environment,
    source,
    feature_gates: snapshot.feature_gates,
    cli_discovery: {
      bundled_manifest: true,
      server_refresh_optional: true,
      help_requires_network: false,
    },
  };
}

export function buildBundledCapabilityDocument(environment?: string | null): CapabilityDocument {
  return buildCapabilityDocument(
    buildFeatureGateSnapshot({ environment: environment ?? "production", env: {} }),
    "bundled",
  );
}
