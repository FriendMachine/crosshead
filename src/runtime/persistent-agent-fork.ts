import {
  AGENT_PASSPORT_SCHEMA_VERSION,
  buildDraftAgentPassport,
  type AgentPassport,
  validateAgentPassport,
} from "../protocol/passports";
import {
  INHERITANCE_BOUNDARY_VERSION,
  LINEAGE_LINK_VERSION,
  PERSISTENT_AGENT_ENTITY_VERSION,
  type LineageLink,
  type PersistentAgentEntity,
  type PersistentAgentInheritanceBoundary,
  type RuntimeAttachment,
  type RuntimeAttachmentStatus,
  type TrustCarryoverMode,
  validateLineageLink,
  validatePersistentAgentEntity,
  validatePersistentAgentInheritanceBoundary,
} from "../protocol/persistent-agents";
import {
  type EnginePortabilityDiagnostics,
  deriveEnginePortabilityDiagnostics,
} from "../protocol/engine-attachments";
import {
  normalizePersistentAgentId,
  sanitizePersistentAgentToken,
  signCanonicalPayload,
  verifyCanonicalPayloadSignature,
} from "./persistent-agent-utils";

export type RuntimePersistentAgentProfile = {
  name: string;
  npub: string;
  apiBase: string;
  memoryMode: string;
  workspaceScope: string;
  features: {
    feedback: boolean;
    relay: boolean;
    coldSync: boolean;
    autoWarmPromotion: boolean;
  };
  secureStoreMode: "file";
  createdAt: string;
  updatedAt: string;
  agentId?: string | null;
  lineageRoot?: string | null;
};

export type RuntimePersistentAgentAdapter = {
  name: string;
  status: "installed" | "attached" | "failed" | "partial";
  profileName: string | null;
  hostHome: string | null;
  managedFiles: string[];
  installedAt: string;
  updatedAt: string;
};

export type PersistentAgentForkRequest = {
  parentEntity: PersistentAgentEntity;
  parentProfile: RuntimePersistentAgentProfile;
  parentNsec: string;
  childProfileName: string;
  childNpub: string;
  childAgentId?: string;
  childDisplayName?: string;
  continuityPolicyRef?: string | null;
  forkReason: string;
  inherit: {
    policy: boolean;
    selfModel: boolean;
    projectModels: boolean;
    passport: boolean;
  };
  inheritedRefs?: string[];
  excludedRefs?: string[];
  trustCarryoverMode?: TrustCarryoverMode;
  createdAt?: string;
  notes?: string[];
};

export type PersistentAgentForkResult = {
  childEntity: PersistentAgentEntity;
  lineageLink: LineageLink;
  inheritanceBoundary: PersistentAgentInheritanceBoundary;
  childPassport: AgentPassport | null;
};

export type PersistentAgentLineageTreeNode = {
  agentId: string;
  npub: string;
  lineageRoot: string;
  children: PersistentAgentLineageTreeNode[];
};

export type PersistentAgentLineageInspection = {
  requestedAgentId: string;
  rootAgentId: string;
  parentLink: LineageLink | null;
  childLinks: LineageLink[];
  inheritanceBoundary: PersistentAgentInheritanceBoundary | null;
  ancestors: Array<{
    agentId: string;
    npub: string;
  }>;
  tree: PersistentAgentLineageTreeNode;
  signatureVerification: {
    lineageLinkValid: boolean | null;
    inheritanceBoundaryValid: boolean | null;
  };
  divergence: {
    separateIdentity: boolean;
    runtimeAttachmentsReset: boolean;
    engineAttachmentReset: boolean;
    inheritedRefs: string[];
    excludedRefs: string[];
  };
};

export type PersistentAgentInspection = {
  agent: PersistentAgentEntity;
  profile: {
    name: string;
    npub: string;
    apiBase: string;
    memoryMode: string;
    workspaceScope: string;
  } | null;
  passport: AgentPassport | null;
  enginePortability: EnginePortabilityDiagnostics;
  lineage: PersistentAgentLineageInspection;
};

const nowIso = (): string => new Date().toISOString();

const uniqueRefs = (values: string[]): string[] => [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];

const mapAdapterStatus = (status: RuntimePersistentAgentAdapter["status"]): RuntimeAttachmentStatus => {
  switch (status) {
    case "attached":
      return "active";
    case "installed":
    case "partial":
      return "paused";
    case "failed":
      return "ended";
  }
};

const buildRuntimeAttachments = (
  profileName: string,
  agentId: string,
  passportRef: string | null,
  adapters: RuntimePersistentAgentAdapter[]
): RuntimeAttachment[] =>
  adapters
    .filter((adapter) => adapter.profileName === profileName)
    .map((adapter) => ({
      attachmentId: `attach_${sanitizePersistentAgentToken(`${adapter.name}_${profileName}`, "runtime")}`,
      runtimeHost: adapter.name,
      workspaceId: adapter.hostHome ? `host:${adapter.hostHome}` : null,
      sessionId: null,
      attachedAt: adapter.updatedAt,
      status: mapAdapterStatus(adapter.status),
      passportRef,
      continuityStateRef: `continuity_state:${agentId}`,
      notes: [`Derived from the managed ${adapter.name} adapter record for profile ${profileName}.`],
    }));

export const materializePersistentAgentEntity = (input: {
  profile: RuntimePersistentAgentProfile;
  adapters: RuntimePersistentAgentAdapter[];
  continuityPolicyRef?: string | null;
  existingEntity?: PersistentAgentEntity | null;
  selfModelRef?: string | null;
  passportRef?: string | null;
  projectModelRefs?: string[];
  notes?: string[];
}): PersistentAgentEntity => {
  const agentId = normalizePersistentAgentId(input.profile.agentId ?? input.profile.name);
  const lineageRoot = normalizePersistentAgentId(input.profile.lineageRoot ?? agentId);
  const existing = input.existingEntity ?? null;
  const entity: PersistentAgentEntity = {
    schemaVersion: PERSISTENT_AGENT_ENTITY_VERSION,
    agentRef: {
      agentId,
      npub: input.profile.npub,
      lineageRoot,
    },
    createdAt: existing?.createdAt ?? input.profile.createdAt ?? nowIso(),
    status: existing?.status ?? "active",
    policyRef: existing?.policyRef ?? input.continuityPolicyRef ?? null,
    projectModelRefs: existing?.projectModelRefs ?? uniqueRefs(input.projectModelRefs ?? []),
    selfModelRef:
      existing?.selfModelRef ??
      input.selfModelRef ??
      `self_model_profile:${input.profile.npub}`,
    passportRef: existing?.passportRef ?? input.passportRef ?? null,
    currentRuntimeAttachments: buildRuntimeAttachments(
      input.profile.name,
      agentId,
      existing?.passportRef ?? input.passportRef ?? null,
      input.adapters
    ),
    currentEngineAttachment: existing?.currentEngineAttachment ?? null,
    engineAttachmentHistory: existing?.engineAttachmentHistory ?? [],
    notes: uniqueRefs([
      ...(existing?.notes ?? []),
      ...(input.notes ?? []),
      "Persistent agent entity materialized from the local Crosshead runtime profile.",
    ]),
  };
  const validationErrors = validatePersistentAgentEntity(entity);
  if (validationErrors.length > 0) {
    throw new Error(`persistent agent materialization produced an invalid entity:\n${validationErrors.join("\n")}`);
  }
  return entity;
};

const lineageLinkSignaturePayload = (link: Omit<LineageLink, "payloadHash" | "signature">): Record<string, unknown> => ({
  schemaVersion: link.schemaVersion,
  linkId: link.linkId,
  parentAgentId: link.parentAgentId,
  childAgentId: link.childAgentId,
  lineageRoot: link.lineageRoot,
  forkReason: link.forkReason,
  inheritedRefs: [...link.inheritedRefs],
  excludedRefs: [...link.excludedRefs],
  trustCarryoverMode: link.trustCarryoverMode,
  inheritanceBoundaryRef: link.inheritanceBoundaryRef,
  signedAt: link.signedAt,
  signedByNpub: link.signedByNpub,
  notes: [...link.notes],
});

const inheritanceBoundarySignaturePayload = (
  boundary: Omit<PersistentAgentInheritanceBoundary, "payloadHash" | "signature">
): Record<string, unknown> => ({
  schemaVersion: boundary.schemaVersion,
  boundaryId: boundary.boundaryId,
  parentAgentId: boundary.parentAgentId,
  childAgentId: boundary.childAgentId,
  lineageRoot: boundary.lineageRoot,
  policyMode: boundary.policyMode,
  policyRef: boundary.policyRef,
  selfModelMode: boundary.selfModelMode,
  selfModelRef: boundary.selfModelRef,
  projectModelMode: boundary.projectModelMode,
  projectModelRefs: [...boundary.projectModelRefs],
  hotMemoryMode: boundary.hotMemoryMode,
  warmMemoryMode: boundary.warmMemoryMode,
  coldMemoryMode: boundary.coldMemoryMode,
  inheritedRefs: [...boundary.inheritedRefs],
  excludedRefs: [...boundary.excludedRefs],
  passportMode: boundary.passportMode,
  derivedPassportRef: boundary.derivedPassportRef,
  runtimeAttachmentMode: boundary.runtimeAttachmentMode,
  engineAttachmentMode: boundary.engineAttachmentMode,
  trustCarryoverMode: boundary.trustCarryoverMode,
  signedAt: boundary.signedAt,
  signedByNpub: boundary.signedByNpub,
  notes: [...boundary.notes],
});

export const verifyLineageLinkSignature = async (link: LineageLink): Promise<boolean> =>
  await verifyCanonicalPayloadSignature(
    lineageLinkSignaturePayload({
      schemaVersion: link.schemaVersion,
      linkId: link.linkId,
      parentAgentId: link.parentAgentId,
      childAgentId: link.childAgentId,
      lineageRoot: link.lineageRoot,
      forkReason: link.forkReason,
      inheritedRefs: link.inheritedRefs,
      excludedRefs: link.excludedRefs,
      trustCarryoverMode: link.trustCarryoverMode,
      inheritanceBoundaryRef: link.inheritanceBoundaryRef,
      signedAt: link.signedAt,
      signedByNpub: link.signedByNpub,
      notes: link.notes,
    }),
    link.signedByNpub,
    link.signature,
    link.payloadHash
  );

export const verifyPersistentAgentInheritanceBoundarySignature = async (
  boundary: PersistentAgentInheritanceBoundary
): Promise<boolean> =>
  await verifyCanonicalPayloadSignature(
    inheritanceBoundarySignaturePayload({
      schemaVersion: boundary.schemaVersion,
      boundaryId: boundary.boundaryId,
      parentAgentId: boundary.parentAgentId,
      childAgentId: boundary.childAgentId,
      lineageRoot: boundary.lineageRoot,
      policyMode: boundary.policyMode,
      policyRef: boundary.policyRef,
      selfModelMode: boundary.selfModelMode,
      selfModelRef: boundary.selfModelRef,
      projectModelMode: boundary.projectModelMode,
      projectModelRefs: boundary.projectModelRefs,
      hotMemoryMode: boundary.hotMemoryMode,
      warmMemoryMode: boundary.warmMemoryMode,
      coldMemoryMode: boundary.coldMemoryMode,
      inheritedRefs: boundary.inheritedRefs,
      excludedRefs: boundary.excludedRefs,
      passportMode: boundary.passportMode,
      derivedPassportRef: boundary.derivedPassportRef,
      runtimeAttachmentMode: boundary.runtimeAttachmentMode,
      engineAttachmentMode: boundary.engineAttachmentMode,
      trustCarryoverMode: boundary.trustCarryoverMode,
      signedAt: boundary.signedAt,
      signedByNpub: boundary.signedByNpub,
      notes: boundary.notes,
    }),
    boundary.signedByNpub,
    boundary.signature,
    boundary.payloadHash
  );

export const forkPersistentAgent = async (request: PersistentAgentForkRequest): Promise<PersistentAgentForkResult> => {
  const createdAt = request.createdAt ?? nowIso();
  const childAgentId = normalizePersistentAgentId(request.childAgentId ?? request.childProfileName);
  if (childAgentId === request.parentEntity.agentRef.agentId) {
    throw new Error("fork childAgentId must differ from the parent agentId");
  }
  if (request.forkReason.trim().length === 0) {
    throw new Error("fork reason is required");
  }

  const excludedRefs = uniqueRefs(request.excludedRefs ?? []);
  const explicitInheritedRefs = uniqueRefs(request.inheritedRefs ?? []);
  if (explicitInheritedRefs.some((ref) => excludedRefs.includes(ref))) {
    throw new Error("fork inherited refs and excluded refs must not overlap");
  }
  const inheritedRefs = uniqueRefs([
    ...(request.inherit.policy && request.parentEntity.policyRef ? [request.parentEntity.policyRef] : []),
    ...(request.inherit.selfModel && request.parentEntity.selfModelRef ? [request.parentEntity.selfModelRef] : []),
    ...(request.inherit.projectModels ? request.parentEntity.projectModelRefs : []),
    ...explicitInheritedRefs,
  ]);

  const childPolicyRef =
    request.inherit.policy &&
    request.parentEntity.policyRef &&
    !excludedRefs.includes(request.parentEntity.policyRef)
      ? request.parentEntity.policyRef
      : null;
  const childSelfModelRef =
    request.inherit.selfModel &&
    request.parentEntity.selfModelRef &&
    !excludedRefs.includes(request.parentEntity.selfModelRef)
      ? request.parentEntity.selfModelRef
      : null;
  const childProjectModelRefs = request.inherit.projectModels
    ? request.parentEntity.projectModelRefs.filter((ref) => !excludedRefs.includes(ref))
    : [];
  const lineageRoot = request.parentEntity.agentRef.lineageRoot;
  const trustCarryoverMode = request.trustCarryoverMode ?? "bounded";
  const boundaryId = `inheritance_boundary_${sanitizePersistentAgentToken(`${request.parentProfile.name}_${request.childProfileName}`, "fork")}`;
  const linkId = `lineage_${sanitizePersistentAgentToken(`${request.parentProfile.name}_${request.childProfileName}`, "fork")}`;
  const derivedPassportRef = request.inherit.passport ? `${AGENT_PASSPORT_SCHEMA_VERSION}:local:${childAgentId}` : null;

  const childPassport = request.inherit.passport
    ? buildDraftAgentPassport({
        agentRef: {
          agentId: childAgentId,
          npub: request.childNpub,
          lineageRoot,
        },
        displayName:
          request.childDisplayName ??
          `Crosshead ${request.childProfileName} fork`,
        continuityPolicyRef: childPolicyRef ?? request.continuityPolicyRef ?? null,
        compilerVersion: "runtime-lineage-fork",
        currentEngineAttachmentRef: null,
        allowedWorkspaces: [`profile:${request.childProfileName}`],
        createdAt,
      })
    : null;
  if (childPassport) {
    childPassport.notes = uniqueRefs([
      ...childPassport.notes,
      `Derived during fork from parent ${request.parentEntity.agentRef.agentId}.`,
      `Fork reason: ${request.forkReason}`,
    ]);
    const passportErrors = validateAgentPassport(childPassport);
    if (passportErrors.length > 0) {
      throw new Error(`fork derived an invalid child passport:\n${passportErrors.join("\n")}`);
    }
  }

  const unsignedBoundary: Omit<PersistentAgentInheritanceBoundary, "payloadHash" | "signature"> = {
    schemaVersion: INHERITANCE_BOUNDARY_VERSION,
    boundaryId,
    parentAgentId: request.parentEntity.agentRef.agentId,
    childAgentId,
    lineageRoot,
    policyMode: childPolicyRef ? "inherit" : "reset",
    policyRef: childPolicyRef,
    selfModelMode: childSelfModelRef ? "inherit" : "reset",
    selfModelRef: childSelfModelRef,
    projectModelMode: childProjectModelRefs.length > 0 ? "inherit" : "reset",
    projectModelRefs: [...childProjectModelRefs],
    hotMemoryMode: "reset",
    warmMemoryMode: inheritedRefs.length > 0 ? "reference_only" : "reset",
    coldMemoryMode: inheritedRefs.length > 0 ? "reference_only" : "reset",
    inheritedRefs: inheritedRefs.filter((ref) => !excludedRefs.includes(ref)),
    excludedRefs,
    passportMode: childPassport ? "derive" : "reset",
    derivedPassportRef,
    runtimeAttachmentMode: "reset",
    engineAttachmentMode: "reset",
    trustCarryoverMode,
    signedAt: createdAt,
    signedByNpub: request.parentProfile.npub,
    notes: uniqueRefs([
      ...(request.notes ?? []),
      "Hot memory and runtime-facing attachments reset at fork time so parent and child can diverge safely.",
    ]),
  };
  const boundarySignature = await signCanonicalPayload(
    inheritanceBoundarySignaturePayload(unsignedBoundary),
    request.parentNsec
  );
  const inheritanceBoundary: PersistentAgentInheritanceBoundary = {
    ...unsignedBoundary,
    payloadHash: boundarySignature.payloadHash,
    signature: boundarySignature.signature,
  };
  const boundaryErrors = validatePersistentAgentInheritanceBoundary(inheritanceBoundary);
  if (boundaryErrors.length > 0) {
    throw new Error(`fork produced an invalid inheritance boundary:\n${boundaryErrors.join("\n")}`);
  }

  const unsignedLineageLink: Omit<LineageLink, "payloadHash" | "signature"> = {
    schemaVersion: LINEAGE_LINK_VERSION,
    linkId,
    parentAgentId: request.parentEntity.agentRef.agentId,
    childAgentId,
    lineageRoot,
    forkReason: request.forkReason.trim(),
    inheritedRefs: [...inheritanceBoundary.inheritedRefs],
    excludedRefs: [...excludedRefs],
    trustCarryoverMode,
    inheritanceBoundaryRef: inheritanceBoundary.boundaryId,
    signedAt: createdAt,
    signedByNpub: request.parentProfile.npub,
    notes: uniqueRefs([
      ...(request.notes ?? []),
      "Fork lineage signed by the parent runtime identity.",
    ]),
  };
  const linkSignature = await signCanonicalPayload(lineageLinkSignaturePayload(unsignedLineageLink), request.parentNsec);
  const lineageLink: LineageLink = {
    ...unsignedLineageLink,
    payloadHash: linkSignature.payloadHash,
    signature: linkSignature.signature,
  };
  const linkErrors = validateLineageLink(lineageLink);
  if (linkErrors.length > 0) {
    throw new Error(`fork produced an invalid lineage link:\n${linkErrors.join("\n")}`);
  }

  const childEntity: PersistentAgentEntity = {
    schemaVersion: PERSISTENT_AGENT_ENTITY_VERSION,
    agentRef: {
      agentId: childAgentId,
      npub: request.childNpub,
      lineageRoot,
    },
    createdAt,
    status: "active",
    policyRef: childPolicyRef,
    projectModelRefs: childProjectModelRefs,
    selfModelRef: childSelfModelRef,
    passportRef: derivedPassportRef,
    currentRuntimeAttachments: [],
    currentEngineAttachment: null,
    engineAttachmentHistory: [],
    notes: uniqueRefs([
      ...(request.notes ?? []),
      `Forked from ${request.parentEntity.agentRef.agentId}.`,
      `Lineage link: ${lineageLink.linkId}.`,
      `Inheritance boundary: ${inheritanceBoundary.boundaryId}.`,
    ]),
  };
  const entityErrors = validatePersistentAgentEntity(childEntity);
  if (entityErrors.length > 0) {
    throw new Error(`fork produced an invalid child persistent agent entity:\n${entityErrors.join("\n")}`);
  }

  return {
    childEntity,
    lineageLink,
    inheritanceBoundary,
    childPassport,
  };
};

const buildTree = (
  agentId: string,
  entitiesById: Map<string, PersistentAgentEntity>,
  childrenByParent: Map<string, LineageLink[]>,
): PersistentAgentLineageTreeNode => {
  const entity = entitiesById.get(agentId);
  return {
    agentId,
    npub: entity?.agentRef.npub ?? "unknown",
    lineageRoot: entity?.agentRef.lineageRoot ?? agentId,
    children: (childrenByParent.get(agentId) ?? []).map((link) => buildTree(link.childAgentId, entitiesById, childrenByParent)),
  };
};

export const inspectPersistentAgentLineage = async (input: {
  requestedAgentId: string;
  entities: PersistentAgentEntity[];
  lineageLinks: LineageLink[];
  inheritanceBoundaries: PersistentAgentInheritanceBoundary[];
}): Promise<PersistentAgentLineageInspection> => {
  const entitiesById = new Map(input.entities.map((entity) => [entity.agentRef.agentId, entity]));
  const parentLink = input.lineageLinks.find((link) => link.childAgentId === input.requestedAgentId) ?? null;
  const childLinks = input.lineageLinks.filter((link) => link.parentAgentId === input.requestedAgentId);
  const boundary =
    parentLink && parentLink.inheritanceBoundaryRef
      ? input.inheritanceBoundaries.find((entry) => entry.boundaryId === parentLink.inheritanceBoundaryRef) ?? null
      : null;

  const ancestors: Array<{ agentId: string; npub: string }> = [];
  let cursor = parentLink;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.parentAgentId)) {
    visited.add(cursor.parentAgentId);
    const ancestor = entitiesById.get(cursor.parentAgentId);
    ancestors.unshift({
      agentId: cursor.parentAgentId,
      npub: ancestor?.agentRef.npub ?? cursor.signedByNpub,
    });
    cursor = input.lineageLinks.find((link) => link.childAgentId === cursor?.parentAgentId) ?? null;
  }

  const rootAgentId = ancestors[0]?.agentId ?? input.requestedAgentId;
  const childrenByParent = new Map<string, LineageLink[]>();
  for (const link of input.lineageLinks) {
    const current = childrenByParent.get(link.parentAgentId) ?? [];
    current.push(link);
    childrenByParent.set(link.parentAgentId, current);
  }
  const requestedEntity = entitiesById.get(input.requestedAgentId);
  return {
    requestedAgentId: input.requestedAgentId,
    rootAgentId,
    parentLink,
    childLinks,
    inheritanceBoundary: boundary,
    ancestors,
    tree: buildTree(rootAgentId, entitiesById, childrenByParent),
    signatureVerification: {
      lineageLinkValid: parentLink ? await verifyLineageLinkSignature(parentLink) : null,
      inheritanceBoundaryValid: boundary ? await verifyPersistentAgentInheritanceBoundarySignature(boundary) : null,
    },
    divergence: {
      separateIdentity: parentLink ? entitiesById.get(parentLink.parentAgentId)?.agentRef.npub !== requestedEntity?.agentRef.npub : true,
      runtimeAttachmentsReset: boundary ? requestedEntity?.currentRuntimeAttachments.length === 0 : requestedEntity?.currentRuntimeAttachments.length === 0,
      engineAttachmentReset: requestedEntity?.currentEngineAttachment === null,
      inheritedRefs: parentLink?.inheritedRefs ?? [],
      excludedRefs: parentLink?.excludedRefs ?? [],
    },
  };
};

export const buildPersistentAgentInspection = async (input: {
  agent: PersistentAgentEntity;
  profile?: RuntimePersistentAgentProfile | null;
  passport?: AgentPassport | null;
  entities: PersistentAgentEntity[];
  lineageLinks: LineageLink[];
  inheritanceBoundaries: PersistentAgentInheritanceBoundary[];
}): Promise<PersistentAgentInspection> => ({
  agent: input.agent,
  profile: input.profile
    ? {
        name: input.profile.name,
        npub: input.profile.npub,
        apiBase: input.profile.apiBase,
        memoryMode: input.profile.memoryMode,
        workspaceScope: input.profile.workspaceScope,
      }
    : null,
  passport: input.passport ?? null,
  enginePortability: deriveEnginePortabilityDiagnostics(input.agent.currentEngineAttachment, input.agent.engineAttachmentHistory),
  lineage: await inspectPersistentAgentLineage({
    requestedAgentId: input.agent.agentRef.agentId,
    entities: input.entities,
    lineageLinks: input.lineageLinks,
    inheritanceBoundaries: input.inheritanceBoundaries,
  }),
});
