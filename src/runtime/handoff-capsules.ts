import { createHash, randomUUID } from "crypto";

import { schnorr } from "@noble/curves/secp256k1";
import { nip19 } from "nostr-tools";

import {
  buildContinuityContinuationPlan,
  buildContinuityFidelityReport,
  validateContinuityIr,
} from "./continuity-ir";
import type {
  ContinuityContinuationPlan,
  ContinuityFieldEffect,
  ContinuityFidelityReport,
  ContinuityIr,
  ContinuityOpaqueAttachment,
  ContinuityRedaction,
  ContinuityRuntime,
} from "./continuity-ir";

// Signed handoff capsule wire format shared by the CLI, host adapters and the hosted service.
export const HANDOFF_CAPSULE_VERSION = "handoff_capsule_v1";
export const HANDOFF_CAPSULE_KIND = "lightweight";
export const HANDOFF_CAPSULE_DEFAULT_MAX_BYTES = 16 * 1024;

export type HandoffCapsule = {
  capsuleVersion: typeof HANDOFF_CAPSULE_VERSION;
  capsuleKind: typeof HANDOFF_CAPSULE_KIND;
  capsuleId: string;
  sourceRuntime: ContinuityRuntime;
  targetRuntime: ContinuityRuntime;
  createdAt: string;
  referencePolicy: {
    hotMemory: "embedded" | "reference" | "omitted";
    warmMemory: "reference";
    coldMemory: "reference";
    transcript: "embedded" | "reference" | "omitted";
  };
  sizeBudget: {
    maxBytes: number;
    actualBytes: number;
    withinBudget: boolean;
  };
  continuityIr: ContinuityIr;
  fidelity: ContinuityFidelityReport;
  redactions: ContinuityRedaction[];
  opaqueAttachments: ContinuityOpaqueAttachment[];
  signature: {
    scheme: "nostr_schnorr";
    signedBy: string;
    payloadHash: string;
    value: string;
  };
};

export type HandoffVerificationResult = {
  valid: boolean;
  signatureValid: boolean;
  payloadHashMatches: boolean;
  withinBudget: boolean;
  errors: string[];
  warnings: string[];
  sourceRuntime: ContinuityRuntime | null;
  targetRuntime: ContinuityRuntime | null;
  signedBy: string | null;
  sizeBytes: number | null;
};

export type HandoffInspection = {
  handoffId: string;
  capsuleVersion: string;
  capsuleKind: string;
  sourceRuntime: ContinuityRuntime;
  targetRuntime: ContinuityRuntime;
  signedBy: string;
  createdAt: string;
  task: {
    objective: string;
    openLoops: string[];
  };
  reasoning: {
    currentTheory: string | null;
    openQuestions: string[];
  };
  references: {
    hotMemory: string;
    warmCount: number;
    coldCount: number;
    projectModelCount: number;
    userModelCount: number;
    selfModelCount: number;
  };
  redactionCount: number;
  opaqueAttachmentCount: number;
  fidelity: {
    level: string;
    categories: string[];
    summary: string;
  };
  continuation: ContinuityContinuationPlan;
  sizeBudget: HandoffCapsule["sizeBudget"];
  warnings: string[];
};

export type HandoffReceipt = {
  receivedAt: string;
  receiverRuntime: ContinuityRuntime;
  receiverSessionId: string | null;
  receiverWorkspaceId: string | null;
  accepted: boolean;
  note: string | null;
  delivery: {
    primary: string | null;
    fallback: string | null;
    managedSurface: string | null;
  };
  warnings: string[];
  manualReestablishment: string[];
};

export type HandoffOutcomeKind = "accepted" | "rejected" | "completed" | "failed" | "corrected";

export type HandoffOutcomeSignals = {
  projectDirection: string[];
  openQuestions: string[];
  rejectedAlternatives: string[];
  unresolvedRisks: string[];
  demonstratedKnowledge: string[];
  recentCorrections: string[];
  orientation: string[];
  redundancyMarkers: string[];
};

export type HandoffOutcomeEvent = {
  outcomeId: string;
  kind: HandoffOutcomeKind;
  reportedAt: string;
  reporterRuntime: ContinuityRuntime;
  reporterSessionId: string | null;
  reporterWorkspaceId: string | null;
  summary: string | null;
  details: string | null;
  taskSucceeded: boolean | null;
  changedDirection: boolean;
  nextAction: string | null;
  resultingHandoffId: string | null;
  continuityOutcomeEventId: string | null;
  signals: HandoffOutcomeSignals;
};

export type HandoffStoredRecord = {
  handoffId: string;
  createdAt: string;
  updatedAt: string;
  state: "created" | "acknowledged" | "rejected";
  note: string | null;
  receipt: HandoffReceipt | null;
  outcomes: HandoffOutcomeEvent[];
  capsule: HandoffCapsule;
  validation: HandoffVerificationResult;
  inspection: HandoffInspection;
};

export type CreateSignedHandoffCapsuleInput = {
  translation: {
    sourceRuntime: ContinuityRuntime;
    targetRuntime: ContinuityRuntime | null;
    ir: ContinuityIr;
    fieldEffects?: ContinuityFieldEffect[];
    redactions?: ContinuityRedaction[];
    opaqueAttachments?: ContinuityOpaqueAttachment[];
  };
  signedBy: string;
  signingNsec: string;
  maxBytes?: number;
  now?: () => Date;
  capsuleId?: string;
};

export class HandoffCapsuleValidationError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const validateCapsuleStructure = (value: Record<string, unknown>): string[] => {
  const errors: string[] = [];
  if (typeof value.capsuleId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.capsuleId)) {
    errors.push("capsuleId must be a bounded portable identifier");
  }
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    errors.push("createdAt must be an ISO timestamp");
  }
  const policy = isRecord(value.referencePolicy) ? value.referencePolicy : null;
  if (!policy) {
    errors.push("referencePolicy must be an object");
  } else {
    if (!["embedded", "reference", "omitted"].includes(String(policy.hotMemory))) {
      errors.push("referencePolicy.hotMemory is invalid");
    }
    if (policy.warmMemory !== "reference" || policy.coldMemory !== "reference") {
      errors.push("referencePolicy warm and cold memory must use references");
    }
    if (!["embedded", "reference", "omitted"].includes(String(policy.transcript))) {
      errors.push("referencePolicy.transcript is invalid");
    }
  }
  const ir = isRecord(value.continuityIr) ? value.continuityIr : null;
  const task = ir && isRecord(ir.task) ? ir.task : null;
  const reasoning = ir && isRecord(ir.reasoningState) ? ir.reasoningState : null;
  const operational = ir && isRecord(ir.operationalContext) ? ir.operationalContext : null;
  const memory = ir && isRecord(ir.memoryReferences) ? ir.memoryReferences : null;
  const hotMemory = memory && isRecord(memory.hotMemory) ? memory.hotMemory : null;
  const policyState = ir && isRecord(ir.policy) ? ir.policy : null;
  const economics = ir && isRecord(ir.economics) ? ir.economics : null;
  const provenance = ir && isRecord(ir.provenance) ? ir.provenance : null;
  if (!task || !isStringArray(task.openLoops)) errors.push("continuityIr.task.openLoops must be a string array");
  if (!reasoning || !isStringArray(reasoning.openQuestions) || !isStringArray(reasoning.rejectedPaths) ||
      !isStringArray(reasoning.unresolvedRisks) ||
      (reasoning.currentTheory !== null && typeof reasoning.currentTheory !== "string")) {
    errors.push("continuityIr.reasoningState inspection fields are invalid");
  }
  if (!operational || !Array.isArray(operational.recentMessages) || !operational.recentMessages.every((entry) =>
    isRecord(entry) && ["user", "assistant", "system", "tool"].includes(String(entry.role)) &&
    typeof entry.content === "string")) {
    errors.push("continuityIr.operationalContext.recentMessages must contain valid transcript entries");
  }
  if (!memory || !hotMemory || !["embedded", "reference", "omitted"].includes(String(hotMemory.mode)) ||
      (hotMemory.summary !== null && typeof hotMemory.summary !== "string")) {
    errors.push("continuityIr.memoryReferences.hotMemory is invalid");
  }
  for (const field of ["warmIds", "coldChunkIds", "projectModelIds", "userModelIds", "selfModelIds"] as const) {
    if (!memory || !isStringArray(memory[field])) errors.push(`continuityIr.memoryReferences.${field} must be a string array`);
  }
  if (!policyState || !Array.isArray(policyState.enforcementHints)) {
    errors.push("continuityIr.policy.enforcementHints must be an array");
  }
  if (!economics || !isStringArray(economics.budgetHints)) {
    errors.push("continuityIr.economics.budgetHints must be a string array");
  }
  if (!provenance || provenance.sourceRuntime !== value.sourceRuntime) {
    errors.push("continuityIr provenance must match the capsule source runtime");
  }
  const fidelity = isRecord(value.fidelity) ? value.fidelity : null;
  const fidelityCategories = [
    "private_host_layout", "prompt_transport", "tool_invocation_ids", "host_specific_settings",
    "ephemeral_runtime_state", "engine_attachment_drift", "redacted_sensitive_content",
  ];
  if (!fidelity || !["full", "high", "partial", "minimal"].includes(String(fidelity.level)) ||
      typeof fidelity.summary !== "string" || !isStringArray(fidelity.categories) ||
      !fidelity.categories.every((entry) => fidelityCategories.includes(entry)) ||
      fidelity.sourceRuntime !== value.sourceRuntime || fidelity.targetRuntime !== value.targetRuntime) {
    errors.push("fidelity report is invalid or inconsistent with the capsule");
  }
  if (!Array.isArray(value.redactions) || !value.redactions.every((entry) =>
    isRecord(entry) && typeof entry.field === "string" && typeof entry.description === "string" &&
    ["host_private_path", "secret", "policy_scope", "public_capsule"].includes(String(entry.reason)))) {
    errors.push("redactions must contain valid redaction records");
  }
  if (!Array.isArray(value.opaqueAttachments) || !value.opaqueAttachments.every((entry) =>
    isRecord(entry) && typeof entry.name === "string" && typeof entry.summary === "string" &&
    ["host_config", "hook_state", "command_context"].includes(String(entry.kind)))) {
    errors.push("opaqueAttachments must contain valid attachment records");
  }
  return errors;
};

const stableStringify = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

const signablePayload = (capsule: Record<string, unknown>): string => {
  const unsigned: Record<string, unknown> = {
    ...capsule,
    sizeBudget: {
      ...(isRecord(capsule.sizeBudget) ? capsule.sizeBudget : {}),
      actualBytes: 0,
      withinBudget: true,
    },
  };
  delete unsigned.signature;
  return stableStringify(unsigned);
};

const decodeNpub = (npub: string): Uint8Array => {
  const decoded = nip19.decode(npub);
  if (decoded.type !== "npub") throw new HandoffCapsuleValidationError("signedBy must be a valid npub");
  return new Uint8Array(Buffer.from(decoded.data, "hex"));
};

const decodeNsec = (nsec: string): Uint8Array => {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new HandoffCapsuleValidationError("signing nsec must be a valid nsec");
  return decoded.data;
};

const buildInspection = (capsule: HandoffCapsule, verification: HandoffVerificationResult): HandoffInspection => ({
  handoffId: capsule.capsuleId,
  capsuleVersion: capsule.capsuleVersion,
  capsuleKind: capsule.capsuleKind,
  sourceRuntime: capsule.sourceRuntime,
  targetRuntime: capsule.targetRuntime,
  signedBy: capsule.signature.signedBy,
  createdAt: capsule.createdAt,
  task: { objective: capsule.continuityIr.task.objective, openLoops: capsule.continuityIr.task.openLoops },
  reasoning: {
    currentTheory: capsule.continuityIr.reasoningState.currentTheory,
    openQuestions: capsule.continuityIr.reasoningState.openQuestions,
  },
  references: {
    hotMemory: capsule.referencePolicy.hotMemory,
    warmCount: capsule.continuityIr.memoryReferences.warmIds.length,
    coldCount: capsule.continuityIr.memoryReferences.coldChunkIds.length,
    projectModelCount: capsule.continuityIr.memoryReferences.projectModelIds.length,
    userModelCount: capsule.continuityIr.memoryReferences.userModelIds.length,
    selfModelCount: capsule.continuityIr.memoryReferences.selfModelIds.length,
  },
  redactionCount: capsule.redactions.length,
  opaqueAttachmentCount: capsule.opaqueAttachments.length,
  fidelity: {
    level: capsule.fidelity.level,
    categories: capsule.fidelity.categories,
    summary: capsule.fidelity.summary,
  },
  continuation: buildContinuityContinuationPlan(
    {
      sourceRuntime: capsule.sourceRuntime,
      targetRuntime: capsule.targetRuntime,
      ir: capsule.continuityIr,
      fidelity: capsule.fidelity,
      redactions: capsule.redactions,
      opaqueAttachments: capsule.opaqueAttachments,
    },
    capsule.targetRuntime
  ),
  sizeBudget: capsule.sizeBudget,
  warnings: verification.warnings,
});

export const verifyHandoffCapsule = async (value: unknown): Promise<HandoffVerificationResult> => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return {
      valid: false, signatureValid: false, payloadHashMatches: false, withinBudget: false,
      errors: ["capsule must be an object"], warnings: [], sourceRuntime: null, targetRuntime: null,
      signedBy: null, sizeBytes: null,
    };
  }
  const sourceRuntime = value.sourceRuntime === "codex" || value.sourceRuntime === "claude-code" ? value.sourceRuntime : null;
  const targetRuntime = value.targetRuntime === "codex" || value.targetRuntime === "claude-code" ? value.targetRuntime : null;
  if (!sourceRuntime) errors.push("sourceRuntime must be codex or claude-code");
  if (!targetRuntime) errors.push("targetRuntime must be codex or claude-code");
  if (sourceRuntime && sourceRuntime === targetRuntime) errors.push("sourceRuntime and targetRuntime must differ");
  if (value.capsuleVersion !== HANDOFF_CAPSULE_VERSION) errors.push(`capsuleVersion must be ${HANDOFF_CAPSULE_VERSION}`);
  if (value.capsuleKind !== HANDOFF_CAPSULE_KIND) errors.push(`capsuleKind must be ${HANDOFF_CAPSULE_KIND}`);
  errors.push(...validateCapsuleStructure(value));
  errors.push(...validateContinuityIr(value.continuityIr));

  const signature = isRecord(value.signature) ? value.signature : null;
  const signedBy = typeof signature?.signedBy === "string" ? signature.signedBy : null;
  const signatureValue = typeof signature?.value === "string" && /^[0-9a-f]{128}$/i.test(signature.value)
    ? signature.value : null;
  const payloadHash = typeof signature?.payloadHash === "string" && /^[0-9a-f]{64}$/i.test(signature.payloadHash)
    ? signature.payloadHash : null;
  if (signature?.scheme !== "nostr_schnorr") errors.push("signature.scheme must be nostr_schnorr");
  if (!signedBy) errors.push("signature.signedBy must be a valid npub");
  if (!signatureValue) errors.push("signature.value must be a 64-byte hex signature");
  if (!payloadHash) errors.push("signature.payloadHash must be a sha256 hex digest");

  const payload = signablePayload(value);
  const computedHash = createHash("sha256").update(payload).digest("hex");
  const payloadHashMatches = payloadHash === computedHash;
  if (!payloadHashMatches) errors.push("signature payload hash does not match capsule payload");

  let signatureValid = false;
  if (signedBy && signatureValue) {
    try {
      signatureValid = await schnorr.verify(signatureValue, new TextEncoder().encode(payload), decodeNpub(signedBy));
    } catch {
      signatureValid = false;
    }
  }
  if (!signatureValid) errors.push("signature is invalid");

  const sizeBytes = Buffer.byteLength(stableStringify(value), "utf8");
  const sizeBudget = isRecord(value.sizeBudget) ? value.sizeBudget : null;
  const declaredMaxBytes = sizeBudget?.maxBytes;
  const validMaxBytes = typeof declaredMaxBytes === "number" && Number.isSafeInteger(declaredMaxBytes) &&
    declaredMaxBytes >= 1024 && declaredMaxBytes <= HANDOFF_CAPSULE_DEFAULT_MAX_BYTES;
  if (!validMaxBytes) errors.push(`sizeBudget.maxBytes must be between 1024 and ${HANDOFF_CAPSULE_DEFAULT_MAX_BYTES}`);
  const maxBytes = validMaxBytes ? declaredMaxBytes : HANDOFF_CAPSULE_DEFAULT_MAX_BYTES;
  const withinBudget = sizeBytes <= maxBytes;
  if (!withinBudget) errors.push(`capsule exceeds size budget (${sizeBytes} bytes > ${maxBytes} bytes)`);
  if (sizeBudget?.actualBytes !== sizeBytes) errors.push("sizeBudget.actualBytes does not match the encoded capsule size");
  if (sizeBudget?.withinBudget !== withinBudget) errors.push("sizeBudget.withinBudget does not match the encoded capsule size");

  const warnings = isRecord(value.fidelity) && typeof value.fidelity.summary === "string"
    ? [value.fidelity.summary] : [];
  return {
    valid: errors.length === 0,
    signatureValid,
    payloadHashMatches,
    withinBudget,
    errors,
    warnings,
    sourceRuntime,
    targetRuntime,
    signedBy,
    sizeBytes,
  };
};

export const inspectHandoffCapsule = async (value: unknown): Promise<HandoffInspection> => {
  const verification = await verifyHandoffCapsule(value);
  if (!verification.valid || !isRecord(value)) throw new HandoffCapsuleValidationError(verification.errors.join("; "));
  return buildInspection(value as unknown as HandoffCapsule, verification);
};

export const createSignedHandoffCapsule = async (
  input: CreateSignedHandoffCapsuleInput
): Promise<HandoffStoredRecord> => {
  const { translation } = input;
  if (!translation.targetRuntime || translation.sourceRuntime === translation.targetRuntime) {
    throw new HandoffCapsuleValidationError("sourceRuntime and targetRuntime must differ for a handoff capsule");
  }
  const irErrors = validateContinuityIr(translation.ir);
  if (irErrors.length > 0) throw new HandoffCapsuleValidationError(irErrors.join("; "));
  const privateKey = decodeNsec(input.signingNsec);
  const expectedPublicKey = decodeNpub(input.signedBy);
  if (!Buffer.from(schnorr.getPublicKey(privateKey)).equals(Buffer.from(expectedPublicKey))) {
    throw new HandoffCapsuleValidationError("signing nsec does not match signedBy npub");
  }

  const maxBytes = input.maxBytes ?? HANDOFF_CAPSULE_DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > HANDOFF_CAPSULE_DEFAULT_MAX_BYTES) {
    throw new HandoffCapsuleValidationError(`maxBytes must be between 1024 and ${HANDOFF_CAPSULE_DEFAULT_MAX_BYTES}`);
  }
  const capsuleId = input.capsuleId ?? randomUUID();
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const fidelity = buildContinuityFidelityReport({
    sourceRuntime: translation.sourceRuntime,
    targetRuntime: translation.targetRuntime,
    fieldEffects: translation.fieldEffects ?? [],
    redactions: translation.redactions ?? [],
    opaqueAttachments: translation.opaqueAttachments ?? [],
  });
  const unsigned: Omit<HandoffCapsule, "signature"> = {
    capsuleVersion: HANDOFF_CAPSULE_VERSION,
    capsuleKind: HANDOFF_CAPSULE_KIND,
    capsuleId,
    sourceRuntime: translation.sourceRuntime,
    targetRuntime: translation.targetRuntime,
    createdAt,
    referencePolicy: {
      hotMemory: translation.ir.memoryReferences.hotMemory.mode,
      warmMemory: "reference" as const,
      coldMemory: "reference" as const,
      transcript: translation.ir.operationalContext.recentMessages.length > 0 ? "embedded" as const : "omitted" as const,
    },
    sizeBudget: { maxBytes, actualBytes: 0, withinBudget: true },
    continuityIr: translation.ir,
    fidelity,
    redactions: translation.redactions ?? [],
    opaqueAttachments: translation.opaqueAttachments ?? [],
  };
  const payload = signablePayload(unsigned);
  const signature = Buffer.from(await schnorr.sign(new TextEncoder().encode(payload), privateKey)).toString("hex");
  const capsule: HandoffCapsule = {
    ...unsigned,
    signature: {
      scheme: "nostr_schnorr",
      signedBy: input.signedBy,
      payloadHash: createHash("sha256").update(payload).digest("hex"),
      value: signature,
    },
  };
  // actualBytes is part of the encoded capsule, so account for its own digit
  // width until the size reaches a fixed point.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const measured = Buffer.byteLength(stableStringify(capsule), "utf8");
    if (capsule.sizeBudget.actualBytes === measured) break;
    capsule.sizeBudget.actualBytes = measured;
  }
  capsule.sizeBudget.withinBudget = capsule.sizeBudget.actualBytes <= maxBytes;
  if (!capsule.sizeBudget.withinBudget) {
    throw new HandoffCapsuleValidationError(
      `capsule exceeds size budget (${capsule.sizeBudget.actualBytes} bytes > ${maxBytes} bytes)`
    );
  }
  const validation = await verifyHandoffCapsule(capsule);
  if (!validation.valid) throw new HandoffCapsuleValidationError(validation.errors.join("; "));
  return {
    handoffId: capsuleId,
    createdAt,
    updatedAt: createdAt,
    state: "created",
    note: null,
    receipt: null,
    outcomes: [],
    capsule,
    validation,
    inspection: buildInspection(capsule, validation),
  };
};
