import path from "path";

import { buildEngineAttachment, type EngineAttachment, validateEngineAttachment } from "../protocol/engine-attachments";
import { sanitizePersistentAgentToken } from "./persistent-agent-utils";

export const CONTINUITY_IR_VERSION = "continuity_ir_v1";

export type ContinuityRuntime = "codex" | "claude-code";
export type ContinuityRole = "user" | "assistant" | "system" | "tool";
export type ContinuityTaskStatus = "pending" | "in_progress" | "blocked" | "completed";
export type ContinuityFieldMode = "embedded" | "reference" | "omitted";
export type ContinuityFileReferenceKind = "repo-relative" | "external-reference";
export type ContinuityFidelityLevel = "full" | "high" | "partial" | "minimal";
export type ContinuityEffectAction = "preserved" | "downgraded" | "omitted" | "opaque";
export type ContinuityLossCategory =
  | "private_host_layout"
  | "prompt_transport"
  | "tool_invocation_ids"
  | "host_specific_settings"
  | "ephemeral_runtime_state"
  | "engine_attachment_drift"
  | "redacted_sensitive_content";
export type ContinuityRedactionReason = "host_private_path" | "secret" | "policy_scope" | "public_capsule";

export type ContinuityTranscriptEntry = {
  role: ContinuityRole;
  content: string;
  timestamp?: string;
  toolName?: string | null;
};

export type ContinuityToolResult = {
  toolName: string;
  summary: string;
  status: "ok" | "error" | "unknown";
  callId?: string | null;
};

export type ContinuityFileReference = {
  path: string;
  kind: ContinuityFileReferenceKind;
};

export type ContinuityEnforcementHint = {
  surface: string;
  level: "runtime_enforced" | "best_effort" | "advisory";
  notes?: string | null;
};

export type ContinuityOpaqueAttachment = {
  name: string;
  kind: "host_config" | "hook_state" | "command_context";
  summary: string;
};

export type ContinuityRedaction = {
  field: string;
  reason: ContinuityRedactionReason;
  description: string;
};

export type ContinuityFieldEffect = {
  field: string;
  action: ContinuityEffectAction;
  category?: ContinuityLossCategory;
  reason: string;
  critical?: boolean;
};

export type ContinuityFidelityReport = {
  level: ContinuityFidelityLevel;
  sourceRuntime: ContinuityRuntime;
  targetRuntime: ContinuityRuntime | null;
  summary: string;
  categories: ContinuityLossCategory[];
  omittedFields: string[];
  downgradedFields: string[];
  opaqueAttachments: string[];
  redactions: ContinuityRedaction[];
};

export type ContinuityIr = {
  irVersion: typeof CONTINUITY_IR_VERSION;
  identity: {
    agentId: string | null;
    npub: string | null;
    lineageRoot: string | null;
  };
  task: {
    objective: string;
    status: ContinuityTaskStatus;
    openLoops: string[];
    priority: number | null;
  };
  reasoningState: {
    currentTheory: string | null;
    openQuestions: string[];
    rejectedPaths: string[];
    unresolvedRisks: string[];
    portabilityNotes: string[];
    nextAction: string | null;
  };
  operationalContext: {
    workspaceId: string;
    workspaceLabel: string;
    sessionId: string;
    turnId: string | null;
    currentPrompt: string | null;
    recentMessages: ContinuityTranscriptEntry[];
    toolResults: Array<{
      toolName: string;
      summary: string;
      status: "ok" | "error" | "unknown";
    }>;
    activeFiles: ContinuityFileReference[];
  };
  memoryReferences: {
    hotMemory: {
      mode: ContinuityFieldMode;
      summary: string | null;
    };
    warmIds: string[];
    coldChunkIds: string[];
    projectModelIds: string[];
    userModelIds: string[];
    selfModelIds: string[];
  };
  policy: {
    policyRef: string | null;
    continuityPolicy: string | null;
    enforcementHints: ContinuityEnforcementHint[];
    memoryScope: {
      allowedWorkspaces: string[];
      allowedTrustZones: string[];
    };
  };
  delegation: {
    whyTransfer: string | null;
    requestedCapabilities: string[];
    recommendedTarget: ContinuityRuntime | null;
  };
  engineAttachment: EngineAttachment;
  economics: {
    budgetRemainingSats: number | null;
    costSoFarSats: number | null;
    budgetHints: string[];
  };
  provenance: {
    sourceRuntime: ContinuityRuntime;
    createdAt: string;
    captureKind: "session" | "turn";
    workspaceRootRedacted: boolean;
  };
};

export type ContinuityCaptureBase = {
  runtime: ContinuityRuntime;
  workspaceRoot: string;
  workspaceId?: string;
  sessionId: string;
  turnId?: string | null;
  hostVersion?: string;
  prompt?: string;
  transcript?: ContinuityTranscriptEntry[];
  toolResults?: ContinuityToolResult[];
  activeFiles?: string[];
  identity?: {
    agentId?: string | null;
    npub?: string | null;
    lineageRoot?: string | null;
  };
  task?: {
    objective?: string;
    status?: ContinuityTaskStatus;
    openLoops?: string[];
    priority?: number | null;
  };
  reasoning?: {
    currentTheory?: string | null;
    openQuestions?: string[];
    rejectedPaths?: string[];
    unresolvedRisks?: string[];
    portabilityNotes?: string[];
    nextAction?: string | null;
  };
  memory?: {
    hotSummary?: string | null;
    warmIds?: string[];
    coldChunkIds?: string[];
    projectModelIds?: string[];
    userModelIds?: string[];
    selfModelIds?: string[];
  };
  policy?: {
    policyRef?: string | null;
    continuityPolicy?: string | null;
    enforcementHints?: ContinuityEnforcementHint[];
    memoryScope?: {
      allowedWorkspaces?: string[];
      allowedTrustZones?: string[];
    };
  };
  delegation?: {
    whyTransfer?: string | null;
    requestedCapabilities?: string[];
    recommendedTarget?: ContinuityRuntime | null;
  };
  economics?: {
    budgetRemainingSats?: number | null;
    costSoFarSats?: number | null;
    budgetHints?: string[];
  };
};

export type CapturedContinuityContext = {
  runtime: ContinuityRuntime;
  workspaceRoot: string;
  workspaceId: string;
  workspaceLabel: string;
  sessionId: string;
  turnId: string | null;
  hostVersion: string | null;
  prompt: string | null;
  transcript: ContinuityTranscriptEntry[];
  toolResults: ContinuityToolResult[];
  activeFiles: ContinuityFileReference[];
  identity: ContinuityIr["identity"];
  task: ContinuityIr["task"];
  reasoningState: ContinuityIr["reasoningState"];
  memoryReferences: ContinuityIr["memoryReferences"];
  policy: ContinuityIr["policy"];
  delegation: ContinuityIr["delegation"];
  economics: ContinuityIr["economics"];
  promptTransport: string | null;
  opaqueAttachments: ContinuityOpaqueAttachment[];
  fieldEffects: ContinuityFieldEffect[];
  redactions: ContinuityRedaction[];
};

export type ContinuityTranslationResult = {
  sourceRuntime: ContinuityRuntime;
  targetRuntime: ContinuityRuntime | null;
  ir: ContinuityIr;
  fieldEffects: ContinuityFieldEffect[];
  opaqueAttachments: ContinuityOpaqueAttachment[];
  redactions: ContinuityRedaction[];
  fidelity: ContinuityFidelityReport;
};

const buildContinuityEngineAttachment = (
  captured: CapturedContinuityContext,
  targetRuntime: ContinuityRuntime | null
): EngineAttachment => {
  const attachedAt =
    sanitizeString(captured.transcript[captured.transcript.length - 1]?.timestamp) ?? new Date().toISOString();
  const compensationHints =
    targetRuntime && targetRuntime !== captured.runtime
      ? [
          `Review the ${captured.runtime} to ${targetRuntime} transfer before unattended execution because host posture and prompt transport can drift.`,
        ]
      : [];

  return buildEngineAttachment({
    attachmentId: `engine_attach_${sanitizePersistentAgentToken(
      [captured.runtime, captured.sessionId, captured.turnId ?? "session"].join("_"),
      "continuity"
    )}`,
    runtimeHost: captured.runtime,
    hostVersion: captured.hostVersion,
    promptTransport: captured.promptTransport,
    attachedAt,
    portabilityNotes: captured.reasoningState.portabilityNotes,
    continuityFidelityNotes:
      targetRuntime && targetRuntime !== captured.runtime
        ? [`Captured on ${captured.runtime} and prepared for ${targetRuntime} materialization.`]
        : [],
    compensationHints,
  });
};

export type ContinuityMaterializationResult = {
  targetRuntime: ContinuityRuntime;
  startupContext: string;
  promptEnvelope: string;
  delivery: {
    primary: string;
    fallback: string | null;
    managedSurface: string;
  };
  continuationPlan: ContinuityContinuationPlan;
  warnings: string[];
};

export type ContinuityContinuationPlan = {
  carriedForward: string[];
  referenceOnly: string[];
  manualReestablishment: string[];
  cautions: string[];
};

export type ContinuityCoverageReport = {
  totalMarkers: number;
  matchedMarkers: string[];
  missingMarkers: string[];
  score: number;
};

export type ContinuityRestatementComparison = {
  baseline: ContinuityCoverageReport;
  materialized: ContinuityCoverageReport;
  lift: number;
};

export type ContinuityTranslationContract<TCapture> = {
  runtime: ContinuityRuntime;
  captureContext: (input: TCapture) => CapturedContinuityContext;
  normalizeToContinuityIr: (
    captured: CapturedContinuityContext,
    targetRuntime?: ContinuityRuntime | null
  ) => ContinuityTranslationResult;
  materializeFromContinuityIr: (
    translation: ContinuityTranslationResult,
    targetRuntime?: ContinuityRuntime
  ) => ContinuityMaterializationResult;
  reportFidelity: (translation: ContinuityTranslationResult) => ContinuityFidelityReport;
};

const criticalLossFields = new Set([
  "task.objective",
  "reasoningState.currentTheory",
  "operationalContext.recentMessages",
  "memoryReferences.hotMemory.summary",
]);

const continuationManualStepByCategory: Record<ContinuityLossCategory, string> = {
  private_host_layout: "Map the runtime-neutral workspace reference onto the local machine layout before continuing.",
  prompt_transport: "Re-apply the target host prompt/context transport because it does not transfer losslessly across runtimes.",
  tool_invocation_ids: "Reconnect any in-flight tool work manually because host-local tool call ids do not transfer.",
  host_specific_settings: "Re-establish host-specific config from the opaque attachments before assuming equivalent behavior.",
  ephemeral_runtime_state: "Recreate any runtime-local ephemeral state before relying on it.",
  engine_attachment_drift: "Confirm the target runtime has equivalent execution, tool, and approval posture.",
  redacted_sensitive_content: "Restore any intentionally redacted private details manually only if they are genuinely required.",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sanitizeString = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeStringArray = (values: string[] | undefined | null): string[] => {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const value of values ?? []) {
    const trimmed = sanitizeString(value);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    sanitized.push(trimmed);
  }
  return sanitized;
};

const pushUnique = (target: string[], value: string | null | undefined): void => {
  const sanitized = sanitizeString(value);
  if (!sanitized || target.includes(sanitized)) {
    return;
  }
  target.push(sanitized);
};

const sanitizeNumber = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const normalizeTaskStatus = (value: ContinuityTaskStatus | undefined): ContinuityTaskStatus => value ?? "in_progress";

const buildWorkspaceId = (workspaceRoot: string, workspaceId?: string): string =>
  sanitizeString(workspaceId) ?? `repo:${path.basename(path.resolve(workspaceRoot))}`;

const toFileReference = (workspaceRoot: string, filePath: string): ContinuityFileReference => {
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedPath = path.resolve(workspaceRoot, filePath);
  const relative = path.relative(normalizedRoot, normalizedPath);
  if (!relative.startsWith("..") && !path.isAbsolute(filePath)) {
    return {
      path: relative === "" ? "." : relative.replaceAll(path.sep, "/"),
      kind: "repo-relative",
    };
  }
  if (!relative.startsWith("..") && path.isAbsolute(filePath)) {
    return {
      path: relative.replaceAll(path.sep, "/"),
      kind: "repo-relative",
    };
  }
  return {
    path: filePath.replaceAll(path.sep, "/"),
    kind: "external-reference",
  };
};

export const buildCapturedContinuityContext = (
  input: ContinuityCaptureBase & {
    promptTransport?: string | null;
    opaqueAttachments?: ContinuityOpaqueAttachment[];
    fieldEffects?: ContinuityFieldEffect[];
    redactions?: ContinuityRedaction[];
  }
): CapturedContinuityContext => {
  const workspaceId = buildWorkspaceId(input.workspaceRoot, input.workspaceId);
  const workspaceLabel = path.basename(path.resolve(input.workspaceRoot));

  return {
    runtime: input.runtime,
    workspaceRoot: path.resolve(input.workspaceRoot),
    workspaceId,
    workspaceLabel,
    sessionId: input.sessionId,
    turnId: sanitizeString(input.turnId),
    hostVersion: sanitizeString(input.hostVersion),
    prompt: sanitizeString(input.prompt),
    transcript: (input.transcript ?? []).map((entry) => ({
      role: entry.role,
      content: entry.content,
      ...(sanitizeString(entry.timestamp) ? { timestamp: sanitizeString(entry.timestamp) ?? undefined } : {}),
      ...(sanitizeString(entry.toolName ?? undefined) ? { toolName: sanitizeString(entry.toolName ?? undefined) } : {}),
    })),
    toolResults: (input.toolResults ?? []).map((result) => ({
      toolName: result.toolName,
      summary: result.summary,
      status: result.status,
      callId: sanitizeString(result.callId ?? undefined),
    })),
    activeFiles: (input.activeFiles ?? []).map((filePath) => toFileReference(input.workspaceRoot, filePath)),
    identity: {
      agentId: sanitizeString(input.identity?.agentId),
      npub: sanitizeString(input.identity?.npub),
      lineageRoot: sanitizeString(input.identity?.lineageRoot),
    },
    task: {
      objective: sanitizeString(input.task?.objective) ?? sanitizeString(input.prompt) ?? "Continue the transferred task",
      status: normalizeTaskStatus(input.task?.status),
      openLoops: sanitizeStringArray(input.task?.openLoops),
      priority: sanitizeNumber(input.task?.priority),
    },
    reasoningState: {
      currentTheory: sanitizeString(input.reasoning?.currentTheory),
      openQuestions: sanitizeStringArray(input.reasoning?.openQuestions),
      rejectedPaths: sanitizeStringArray(input.reasoning?.rejectedPaths),
      unresolvedRisks: sanitizeStringArray(input.reasoning?.unresolvedRisks),
      portabilityNotes: sanitizeStringArray(input.reasoning?.portabilityNotes),
      nextAction: sanitizeString(input.reasoning?.nextAction),
    },
    memoryReferences: {
      hotMemory: {
        mode: sanitizeString(input.memory?.hotSummary) ? "embedded" : "omitted",
        summary: sanitizeString(input.memory?.hotSummary),
      },
      warmIds: sanitizeStringArray(input.memory?.warmIds),
      coldChunkIds: sanitizeStringArray(input.memory?.coldChunkIds),
      projectModelIds: sanitizeStringArray(input.memory?.projectModelIds),
      userModelIds: sanitizeStringArray(input.memory?.userModelIds),
      selfModelIds: sanitizeStringArray(input.memory?.selfModelIds),
    },
    policy: {
      policyRef: sanitizeString(input.policy?.policyRef),
      continuityPolicy: sanitizeString(input.policy?.continuityPolicy),
      enforcementHints: (input.policy?.enforcementHints ?? []).map((hint) => ({
        surface: hint.surface,
        level: hint.level,
        notes: sanitizeString(hint.notes ?? undefined),
      })),
      memoryScope: {
        allowedWorkspaces: sanitizeStringArray(input.policy?.memoryScope?.allowedWorkspaces),
        allowedTrustZones: sanitizeStringArray(input.policy?.memoryScope?.allowedTrustZones),
      },
    },
    delegation: {
      whyTransfer: sanitizeString(input.delegation?.whyTransfer),
      requestedCapabilities: sanitizeStringArray(input.delegation?.requestedCapabilities),
      recommendedTarget: input.delegation?.recommendedTarget ?? null,
    },
    economics: {
      budgetRemainingSats: sanitizeNumber(input.economics?.budgetRemainingSats),
      costSoFarSats: sanitizeNumber(input.economics?.costSoFarSats),
      budgetHints: sanitizeStringArray(input.economics?.budgetHints),
    },
    promptTransport: sanitizeString(input.promptTransport),
    opaqueAttachments: input.opaqueAttachments ?? [],
    fieldEffects: input.fieldEffects ?? [],
    redactions: input.redactions ?? [],
  };
};

const summarizeFidelity = (
  level: ContinuityFidelityLevel,
  omittedFields: string[],
  downgradedFields: string[],
  opaqueAttachments: string[]
): string => {
  const parts = [
    `fidelity=${level}`,
    omittedFields.length > 0 ? `${omittedFields.length} omitted` : null,
    downgradedFields.length > 0 ? `${downgradedFields.length} downgraded` : null,
    opaqueAttachments.length > 0 ? `${opaqueAttachments.length} opaque` : null,
  ].filter((value): value is string => value !== null);
  return parts.join(", ");
};

export const buildContinuityFidelityReport = (input: {
  sourceRuntime: ContinuityRuntime;
  targetRuntime: ContinuityRuntime | null;
  fieldEffects: ContinuityFieldEffect[];
  redactions: ContinuityRedaction[];
  opaqueAttachments: ContinuityOpaqueAttachment[];
}): ContinuityFidelityReport => {
  const omittedFields = input.fieldEffects.filter((effect) => effect.action === "omitted").map((effect) => effect.field);
  const downgradedFields = input.fieldEffects
    .filter((effect) => effect.action === "downgraded")
    .map((effect) => effect.field);
  const categories = Array.from(
    new Set(
      [
        ...input.fieldEffects.map((effect) => effect.category).filter((value): value is ContinuityLossCategory => Boolean(value)),
        ...(input.redactions.length > 0 ? (["redacted_sensitive_content"] as ContinuityLossCategory[]) : []),
      ]
    )
  );
  const criticalLosses = omittedFields.filter((field) => criticalLossFields.has(field)).length;
  const downgradedCount = downgradedFields.length;

  let level: ContinuityFidelityLevel;
  if (criticalLosses >= 2 || omittedFields.length >= 5) {
    level = "minimal";
  } else if (criticalLosses >= 1 || omittedFields.length >= 4 || downgradedCount >= 4) {
    level = "partial";
  } else if (omittedFields.length === 0 && downgradedCount === 0 && input.redactions.length === 0) {
    level = "full";
  } else if (omittedFields.length <= 3 && downgradedCount <= 2) {
    level = "high";
  } else {
    level = "partial";
  }

  return {
    level,
    sourceRuntime: input.sourceRuntime,
    targetRuntime: input.targetRuntime,
    summary: summarizeFidelity(
      level,
      omittedFields,
      downgradedFields,
      input.opaqueAttachments.map((attachment) => attachment.name)
    ),
    categories,
    omittedFields,
    downgradedFields,
    opaqueAttachments: input.opaqueAttachments.map((attachment) => attachment.name),
    redactions: input.redactions,
  };
};

export const normalizeCapturedContextToContinuityIr = (
  captured: CapturedContinuityContext,
  targetRuntime: ContinuityRuntime | null = null
): ContinuityTranslationResult => {
  const fieldEffects: ContinuityFieldEffect[] = [
    {
      field: "operationalContext.workspaceRoot",
      action: "omitted",
      category: "private_host_layout",
      reason: "Absolute workspace roots are reduced to a workspace label plus workspace id.",
    },
    ...captured.fieldEffects,
  ];

  if (captured.toolResults.some((result) => sanitizeString(result.callId))) {
    fieldEffects.push({
      field: "operationalContext.toolResults.callId",
      action: "omitted",
      category: "tool_invocation_ids",
      reason: "Runtime-specific tool invocation ids are not portable across hosts.",
    });
  }

  if (targetRuntime && targetRuntime !== captured.runtime) {
    fieldEffects.push({
      field: "engineAttachment.runtimeHost",
      action: "downgraded",
      category: "engine_attachment_drift",
      reason: `The source runtime ${captured.runtime} differs from the target runtime ${targetRuntime}.`,
      critical: true,
    });
    if (captured.promptTransport) {
      fieldEffects.push({
        field: "engineAttachment.promptTransport",
        action: "downgraded",
        category: "prompt_transport",
        reason: "Prompt transport is re-materialized into a different host surface.",
      });
    }
  }

  const ir: ContinuityIr = {
    irVersion: CONTINUITY_IR_VERSION,
    identity: captured.identity,
    task: captured.task,
    reasoningState: captured.reasoningState,
    operationalContext: {
      workspaceId: captured.workspaceId,
      workspaceLabel: captured.workspaceLabel,
      sessionId: captured.sessionId,
      turnId: captured.turnId,
      currentPrompt: captured.prompt,
      recentMessages: captured.transcript,
      toolResults: captured.toolResults.map((result) => ({
        toolName: result.toolName,
        summary: result.summary,
        status: result.status,
      })),
      activeFiles: captured.activeFiles,
    },
    memoryReferences: captured.memoryReferences,
    policy: captured.policy,
    delegation: {
      ...captured.delegation,
      recommendedTarget: targetRuntime ?? captured.delegation.recommendedTarget,
    },
    engineAttachment: buildContinuityEngineAttachment(captured, targetRuntime),
    economics: captured.economics,
    provenance: {
      sourceRuntime: captured.runtime,
      createdAt: new Date().toISOString(),
      captureKind: captured.turnId ? "turn" : "session",
      workspaceRootRedacted: true,
    },
  };

  const fidelity = buildContinuityFidelityReport({
    sourceRuntime: captured.runtime,
    targetRuntime,
    fieldEffects,
    redactions: captured.redactions,
    opaqueAttachments: captured.opaqueAttachments,
  });

  return {
    sourceRuntime: captured.runtime,
    targetRuntime,
    ir,
    fieldEffects,
    opaqueAttachments: captured.opaqueAttachments,
    redactions: captured.redactions,
    fidelity,
  };
};

const buildRecentMessagesDigest = (messages: ContinuityTranscriptEntry[]): string | null => {
  if (messages.length === 0) {
    return null;
  }
  return messages
    .slice(-3)
    .map((entry) => `${entry.role}: ${entry.content}`)
    .join("\n");
};

const buildWarnings = (translation: ContinuityTranslationResult): string[] => {
  const warnings = [
    ...translation.fidelity.omittedFields.map((field) => `omitted ${field}`),
    ...translation.fidelity.downgradedFields.map((field) => `downgraded ${field}`),
    ...translation.redactions.map((redaction) => `redacted ${redaction.field} (${redaction.reason})`),
  ];
  return sanitizeStringArray(warnings);
};

export const buildContinuityContinuationPlan = (
  translation: Pick<
    ContinuityTranslationResult,
    "sourceRuntime" | "targetRuntime" | "ir" | "fidelity" | "redactions" | "opaqueAttachments"
  >,
  targetRuntime: ContinuityRuntime
): ContinuityContinuationPlan => {
  const carriedForward: string[] = [];
  const referenceOnly: string[] = [];
  const manualReestablishment: string[] = [];
  const cautions: string[] = [];
  const ir = translation.ir;

  pushUnique(carriedForward, "task objective");
  if (ir.task.openLoops.length > 0) {
    pushUnique(carriedForward, `open loops (${ir.task.openLoops.length})`);
  }
  if (ir.reasoningState.currentTheory) {
    pushUnique(carriedForward, "current theory");
  }
  if (ir.reasoningState.openQuestions.length > 0) {
    pushUnique(carriedForward, `open questions (${ir.reasoningState.openQuestions.length})`);
  }
  if (ir.reasoningState.rejectedPaths.length > 0) {
    pushUnique(carriedForward, `rejected paths (${ir.reasoningState.rejectedPaths.length})`);
  }
  if (ir.reasoningState.unresolvedRisks.length > 0) {
    pushUnique(carriedForward, `unresolved risks (${ir.reasoningState.unresolvedRisks.length})`);
  }
  if (ir.delegation.whyTransfer) {
    pushUnique(carriedForward, "transfer intent");
  }
  if (ir.memoryReferences.hotMemory.summary) {
    pushUnique(carriedForward, "hot memory summary");
  }
  if (ir.operationalContext.recentMessages.length > 0) {
    pushUnique(carriedForward, `recent messages (${Math.min(3, ir.operationalContext.recentMessages.length)})`);
  }
  if (ir.policy.policyRef || ir.policy.continuityPolicy || ir.policy.enforcementHints.length > 0) {
    pushUnique(carriedForward, "continuity policy posture");
  }
  if (ir.economics.budgetHints.length > 0 || ir.economics.budgetRemainingSats !== null || ir.economics.costSoFarSats !== null) {
    pushUnique(carriedForward, "budget posture");
  }

  if (ir.memoryReferences.warmIds.length > 0) {
    pushUnique(referenceOnly, `warm memory references (${ir.memoryReferences.warmIds.length})`);
  }
  if (ir.memoryReferences.coldChunkIds.length > 0) {
    pushUnique(referenceOnly, `cold memory references (${ir.memoryReferences.coldChunkIds.length})`);
  }
  if (ir.memoryReferences.projectModelIds.length > 0) {
    pushUnique(referenceOnly, `project model references (${ir.memoryReferences.projectModelIds.length})`);
  }
  if (ir.memoryReferences.userModelIds.length > 0) {
    pushUnique(referenceOnly, `user model references (${ir.memoryReferences.userModelIds.length})`);
  }
  if (ir.memoryReferences.selfModelIds.length > 0) {
    pushUnique(referenceOnly, `self model references (${ir.memoryReferences.selfModelIds.length})`);
  }

  for (const category of translation.fidelity.categories) {
    pushUnique(manualReestablishment, continuationManualStepByCategory[category]);
  }
  if (translation.redactions.length > 0) {
    pushUnique(manualReestablishment, continuationManualStepByCategory.redacted_sensitive_content);
  }
  if (translation.opaqueAttachments.length > 0) {
    pushUnique(
      cautions,
      `Opaque attachments preserved for inspection only: ${translation.opaqueAttachments.map((attachment) => attachment.name).join(", ")}`
    );
  }
  pushUnique(cautions, translation.fidelity.summary);
  if (translation.targetRuntime && translation.targetRuntime !== targetRuntime) {
    pushUnique(
      cautions,
      `Materialization target ${targetRuntime} differs from the translation target ${translation.targetRuntime}.`
    );
  }
  if (translation.sourceRuntime !== targetRuntime) {
    pushUnique(
      cautions,
      `Cross-runtime transfer from ${translation.sourceRuntime} to ${targetRuntime} requires operator review for host-specific gaps.`
    );
  }

  return {
    carriedForward,
    referenceOnly,
    manualReestablishment,
    cautions,
  };
};

const buildCoverageMarkers = (ir: ContinuityIr): string[] =>
  sanitizeStringArray(
    [
      ir.task.objective,
      ...ir.task.openLoops.slice(0, 2),
      ir.reasoningState.currentTheory,
      ...ir.reasoningState.openQuestions.slice(0, 2),
      ...ir.reasoningState.rejectedPaths.slice(0, 1),
      ...ir.reasoningState.unresolvedRisks.slice(0, 1),
      ir.delegation.whyTransfer,
      ir.memoryReferences.hotMemory.summary,
      ...ir.memoryReferences.warmIds.slice(0, 2),
      ...ir.memoryReferences.projectModelIds.slice(0, 1),
      ...ir.economics.budgetHints.slice(0, 1),
      ...ir.operationalContext.recentMessages.slice(-2).map((entry) => entry.content),
    ].filter((entry): entry is string => typeof entry === "string")
  );

const normalizeSearchText = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();

export const buildPlainTextContinuationSummary = (
  translation: Pick<ContinuityTranslationResult, "ir">,
  targetRuntime: ContinuityRuntime
): string => {
  const lines = [
    `Continue this task in ${targetRuntime}.`,
    `Task: ${translation.ir.task.objective}`,
    translation.ir.delegation.whyTransfer ? `Why transfer: ${translation.ir.delegation.whyTransfer}` : null,
  ].filter((value): value is string => value !== null);
  return lines.join("\n");
};

export const scoreContinuityCoverage = (
  value: string,
  translation: Pick<ContinuityTranslationResult, "ir">
): ContinuityCoverageReport => {
  const markers = buildCoverageMarkers(translation.ir);
  const haystack = normalizeSearchText(value);
  const matchedMarkers = markers.filter((marker) => haystack.includes(normalizeSearchText(marker)));
  const missingMarkers = markers.filter((marker) => !matchedMarkers.includes(marker));
  const totalMarkers = markers.length;
  return {
    totalMarkers,
    matchedMarkers,
    missingMarkers,
    score: totalMarkers === 0 ? 1 : Math.round((matchedMarkers.length / totalMarkers) * 100) / 100,
  };
};

export const compareContinuityRestatement = (
  materializedText: string,
  translation: Pick<ContinuityTranslationResult, "ir">,
  targetRuntime: ContinuityRuntime
): ContinuityRestatementComparison => {
  const baselineText = buildPlainTextContinuationSummary(translation, targetRuntime);
  const baseline = scoreContinuityCoverage(baselineText, translation);
  const materialized = scoreContinuityCoverage(materializedText, translation);
  return {
    baseline,
    materialized,
    lift: Math.round((materialized.score - baseline.score) * 100) / 100,
  };
};

export const materializeContinuityIrForRuntime = (
  translation: ContinuityTranslationResult,
  targetRuntime: ContinuityRuntime
): ContinuityMaterializationResult => {
  const ir = translation.ir;
  const recentDigest = buildRecentMessagesDigest(ir.operationalContext.recentMessages);
  const continuationPlan = buildContinuityContinuationPlan(translation, targetRuntime);
  const lines = [
    `Crosshead handoff capsule: source=${translation.sourceRuntime} target=${targetRuntime} ${translation.fidelity.summary}`,
    `Task: ${ir.task.objective}`,
    `Status: ${ir.task.status}`,
    ir.task.openLoops.length > 0 ? `Open loops: ${ir.task.openLoops.join(" | ")}` : null,
    ir.reasoningState.currentTheory ? `Current theory: ${ir.reasoningState.currentTheory}` : null,
    ir.reasoningState.openQuestions.length > 0 ? `Open questions: ${ir.reasoningState.openQuestions.join(" | ")}` : null,
    ir.reasoningState.rejectedPaths.length > 0 ? `Rejected paths: ${ir.reasoningState.rejectedPaths.join(" | ")}` : null,
    ir.reasoningState.unresolvedRisks.length > 0 ? `Unresolved risks: ${ir.reasoningState.unresolvedRisks.join(" | ")}` : null,
    ir.delegation.whyTransfer ? `Why transfer: ${ir.delegation.whyTransfer}` : null,
    ir.memoryReferences.hotMemory.summary ? `Hot summary: ${ir.memoryReferences.hotMemory.summary}` : null,
    ir.memoryReferences.warmIds.length > 0 ? `Warm refs: ${ir.memoryReferences.warmIds.join(", ")}` : null,
    ir.memoryReferences.projectModelIds.length > 0 ? `Project refs: ${ir.memoryReferences.projectModelIds.join(", ")}` : null,
    recentDigest ? `Recent messages:\n${recentDigest}` : null,
    translation.opaqueAttachments.length > 0
      ? `Opaque attachments: ${translation.opaqueAttachments.map((attachment) => attachment.name).join(", ")}`
      : null,
  ].filter((value): value is string => value !== null);
  const startupContext = lines.join("\n");

  if (targetRuntime === "codex") {
    return {
      targetRuntime,
      startupContext,
      promptEnvelope: `${startupContext}\n\nResume this task in Codex:\n${ir.task.objective}`,
      delivery: {
        primary: "additionalContext",
        fallback: "injectedPrompt",
        managedSurface: "hooks.json UserPromptSubmit",
      },
      continuationPlan,
      warnings: buildWarnings(translation),
    };
  }

  return {
    targetRuntime,
    startupContext,
    promptEnvelope: `${startupContext}\n\nResume this task in Claude Code:\n${ir.task.objective}`,
    delivery: {
      primary: "--append-system-prompt",
      fallback: "injectedPrompt",
      managedSurface: ".claude/settings.json UserPromptSubmit hooks",
    },
    continuationPlan,
    warnings: buildWarnings(translation),
  };
};

export const validateContinuityIr = (value: unknown): string[] => {
  if (!isRecord(value)) {
    return ["continuity IR must be an object"];
  }
  const errors: string[] = [];
  const ir = value as Partial<ContinuityIr>;

  if (ir.irVersion !== CONTINUITY_IR_VERSION) {
    errors.push(`irVersion must be ${CONTINUITY_IR_VERSION}`);
  }
  if (!isRecord(ir.identity)) {
    errors.push("identity must be present");
  }
  if (!isRecord(ir.task)) {
    errors.push("task must be present");
  } else {
    if (sanitizeString(ir.task.objective) === null) {
      errors.push("task.objective must be a non-empty string");
    }
    if (!["pending", "in_progress", "blocked", "completed"].includes(String(ir.task.status))) {
      errors.push("task.status must be a valid continuity task status");
    }
    if (!Array.isArray(ir.task.openLoops)) {
      errors.push("task.openLoops must be an array");
    }
  }
  if (!isRecord(ir.reasoningState)) {
    errors.push("reasoningState must be present");
  }
  if (!isRecord(ir.operationalContext)) {
    errors.push("operationalContext must be present");
  } else {
    if (sanitizeString(ir.operationalContext.workspaceId) === null) {
      errors.push("operationalContext.workspaceId must be a non-empty string");
    }
    if (!Array.isArray(ir.operationalContext.recentMessages)) {
      errors.push("operationalContext.recentMessages must be an array");
    }
  }
  if (!isRecord(ir.memoryReferences)) {
    errors.push("memoryReferences must be present");
  } else if (!isRecord(ir.memoryReferences.hotMemory)) {
    errors.push("memoryReferences.hotMemory must be present");
  }
  if (!isRecord(ir.policy)) {
    errors.push("policy must be present");
  }
  if (!isRecord(ir.delegation)) {
    errors.push("delegation must be present");
  }
  if (!isRecord(ir.engineAttachment)) {
    errors.push("engineAttachment must be present");
  } else {
    errors.push(...validateEngineAttachment(ir.engineAttachment));
    if (!["codex", "claude-code"].includes(String(ir.engineAttachment.runtimeHost))) {
      errors.push("engineAttachment.runtimeHost must be codex or claude-code");
    }
  }
  if (!isRecord(ir.economics)) {
    errors.push("economics must be present");
  }
  if (!isRecord(ir.provenance)) {
    errors.push("provenance must be present");
  } else {
    if (!["codex", "claude-code"].includes(String(ir.provenance.sourceRuntime))) {
      errors.push("provenance.sourceRuntime must be codex or claude-code");
    }
    if (!["session", "turn"].includes(String(ir.provenance.captureKind))) {
      errors.push("provenance.captureKind must be session or turn");
    }
  }

  return errors;
};
