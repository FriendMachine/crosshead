import { mkdirSync, realpathSync } from "fs";
import path from "path";

export type OperatorRunClass = "interactive" | "scheduled" | "one_shot";
export type OperatorMountAccess = "ro" | "rw";
export type OperatorManagedMountKind = "scratch" | "state" | "ipc";

export type OperatorReadOnlyMount = {
  name: string;
  sourcePath: string;
  targetPath: string;
};

export type OperatorManagedMount = {
  name: string;
  targetPath: string;
};

export type OperatorExtraMount = {
  name: string;
  sourcePath: string;
  targetPath: string;
  access: OperatorMountAccess;
};

export type OperatorWorkspaceManifest = {
  manifestVersion: string;
  tenantId: string;
  workspaceId: string;
  runClass: OperatorRunClass;
  runtimeId: string;
  runtimeVersion?: string | null;
  workspaceRoot: string;
  readOnlyMounts: OperatorReadOnlyMount[];
  scratchMounts: OperatorManagedMount[];
  stateMounts: OperatorManagedMount[];
  ipcMounts: OperatorManagedMount[];
  extraMounts?: OperatorExtraMount[];
  requestedSecretRefs?: string[];
  rawSecretEnvKeys?: string[];
  requestedAt?: Date | string;
};

export type OperatorMountPolicyRule = {
  sourcePath: string;
  access: OperatorMountAccess;
  tenantIds?: string[];
  workspaceIds?: string[];
};

export type OperatorRuntimePolicy = {
  policyVersion: string;
  policyId: string;
  runtimeClass: "tenant" | "operator";
  secureExecutionRequired: boolean;
  runtimeRoot: string;
  allowReadOnlyRoots: string[];
  approvedExtraMounts?: OperatorMountPolicyRule[];
  brokeredSecretRefs?: string[];
  forceReadOnly?: boolean;
  denySensitivePathSegments?: string[];
};

export type OperatorResolvedMount = {
  name: string;
  kind: "read_only" | OperatorManagedMountKind | "extra";
  sourcePath: string;
  targetPath: string;
  access: OperatorMountAccess;
  managed: boolean;
};

export type OperatorRejectedMount = {
  name: string;
  kind: "read_only" | "extra";
  sourcePath: string;
  targetPath: string;
  reason: string;
};

export type OperatorRuntimeAuditRecord = {
  tenantId: string;
  workspaceId: string;
  runtimeId: string;
  runtimeVersion: string | null;
  runClass: OperatorRunClass;
  policyId: string;
  secureExecutionRequired: boolean;
  secureExecutionAvailable: boolean;
  brokeredSecrets: string[];
  rejectedRawSecretEnvKeys: string[];
  allowedMounts: OperatorResolvedMount[];
  rejectedMounts: OperatorRejectedMount[];
  evaluatedAt: string;
};

export type OperatorPolicyDecision = {
  allowed: true;
  mounts: OperatorResolvedMount[];
  brokeredSecrets: string[];
  audit: OperatorRuntimeAuditRecord;
} | {
  allowed: false;
  reason: string;
  audit: OperatorRuntimeAuditRecord;
};

export class OperatorPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorPolicyValidationError";
  }
}

export class OperatorPolicyDecisionError extends OperatorPolicyValidationError {
  constructor(message: string) {
    super(message);
    this.name = "OperatorPolicyDecisionError";
  }
}

type BrokerOptions = {
  secureExecutionAvailable: boolean;
  createManagedRoots?: boolean;
  now?: Date;
};

const DEFAULT_DENY_SEGMENTS = [
  ".env",
  ".ssh",
  ".aws",
  ".config/gcloud",
  ".kube",
  "id_rsa",
  "id_ed25519",
  "credentials",
  "private_key",
] as const;

const normalizeNonEmpty = (value: string, fieldName: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OperatorPolicyValidationError(`${fieldName} is required`);
  }
  return value.trim();
};

const normalizeAbsoluteTargetPath = (value: string, fieldName: string): string => {
  const normalized = normalizeNonEmpty(value, fieldName);
  if (!path.posix.isAbsolute(normalized)) {
    throw new OperatorPolicyValidationError(`${fieldName} must be an absolute target path`);
  }
  const cleaned = path.posix.normalize(normalized);
  if (cleaned.includes("..")) {
    throw new OperatorPolicyValidationError(`${fieldName} must not contain parent traversal`);
  }
  return cleaned;
};

const normalizeRequestedAt = (value: Date | string | undefined): Date => {
  if (!value) {
    return new Date();
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new OperatorPolicyValidationError("requestedAt must be a valid ISO timestamp");
  }
  return parsed;
};

const canonicalizeExistingPath = (value: string, fieldName: string): string => {
  const normalized = normalizeNonEmpty(value, fieldName);
  if (!path.isAbsolute(normalized)) {
    throw new OperatorPolicyValidationError(`${fieldName} must be an absolute path`);
  }
  try {
    return realpathSync(normalized);
  } catch (error) {
    throw new OperatorPolicyValidationError(`${fieldName} does not exist or cannot be resolved`);
  }
};

const ensureUnderRoot = (candidate: string, root: string, fieldName: string): void => {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new OperatorPolicyDecisionError(`${fieldName} must remain under ${root}`);
};

const containsSensitiveSegment = (candidate: string, segments: readonly string[]): string | null => {
  const normalized = candidate.replace(/\\/g, "/").toLowerCase();
  for (const segment of segments) {
    const match = segment.toLowerCase();
    if (normalized.includes(match)) {
      return segment;
    }
  }
  return null;
};

const normalizeSecretRefs = (value: string[] | undefined, fieldName: string): string[] => {
  if (!value) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new OperatorPolicyValidationError(`${fieldName} must be an array`);
  }
  return Array.from(
    new Set(value.map((entry, index) => normalizeNonEmpty(String(entry), `${fieldName}[${index}]`)))
  ).sort((left, right) => left.localeCompare(right));
};

const normalizeManagedMounts = (
  value: OperatorManagedMount[],
  fieldName: string
): OperatorManagedMount[] => {
  if (!Array.isArray(value)) {
    throw new OperatorPolicyValidationError(`${fieldName} must be an array`);
  }
  return value.map((mount, index) => ({
    name: normalizeNonEmpty(mount?.name, `${fieldName}[${index}].name`),
    targetPath: normalizeAbsoluteTargetPath(mount?.targetPath, `${fieldName}[${index}].targetPath`),
  }));
};

const normalizeReadOnlyMounts = (
  value: OperatorReadOnlyMount[],
  fieldName: string
): OperatorReadOnlyMount[] => {
  if (!Array.isArray(value)) {
    throw new OperatorPolicyValidationError(`${fieldName} must be an array`);
  }
  return value.map((mount, index) => ({
    name: normalizeNonEmpty(mount?.name, `${fieldName}[${index}].name`),
    sourcePath: canonicalizeExistingPath(mount?.sourcePath, `${fieldName}[${index}].sourcePath`),
    targetPath: normalizeAbsoluteTargetPath(mount?.targetPath, `${fieldName}[${index}].targetPath`),
  }));
};

const normalizeExtraMounts = (
  value: OperatorExtraMount[] | undefined,
  fieldName: string
): OperatorExtraMount[] => {
  if (!value) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new OperatorPolicyValidationError(`${fieldName} must be an array`);
  }
  return value.map((mount, index) => {
    const access = normalizeNonEmpty(String(mount?.access), `${fieldName}[${index}].access`);
    if (access !== "ro" && access !== "rw") {
      throw new OperatorPolicyValidationError(`${fieldName}[${index}].access must be ro or rw`);
    }
    return {
      name: normalizeNonEmpty(mount?.name, `${fieldName}[${index}].name`),
      sourcePath: canonicalizeExistingPath(mount?.sourcePath, `${fieldName}[${index}].sourcePath`),
      targetPath: normalizeAbsoluteTargetPath(mount?.targetPath, `${fieldName}[${index}].targetPath`),
      access,
    };
  });
};

const buildManagedSourcePath = (
  runtimeRoot: string,
  tenantId: string,
  workspaceId: string,
  kind: OperatorManagedMountKind,
  mountName: string,
  createManagedRoots: boolean
): string => {
  const sourcePath = path.join(runtimeRoot, "tenants", tenantId, workspaceId, kind, mountName);
  ensureUnderRoot(sourcePath, runtimeRoot, `${kind} mount ${mountName}`);
  if (createManagedRoots) {
    mkdirSync(sourcePath, { recursive: true });
  }
  return sourcePath;
};

const matchesPolicyRule = (
  rule: OperatorMountPolicyRule,
  sourcePath: string,
  tenantId: string,
  workspaceId: string
): boolean => {
  const candidateRoot = canonicalizeExistingPath(rule.sourcePath, "policy rule sourcePath");
  const relative = path.relative(candidateRoot, sourcePath);
  const withinRoot = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!withinRoot) {
    return false;
  }
  if (rule.tenantIds && !rule.tenantIds.includes(tenantId)) {
    return false;
  }
  if (rule.workspaceIds && !rule.workspaceIds.includes(workspaceId)) {
    return false;
  }
  return true;
};

export const validateOperatorWorkspaceManifest = (
  manifest: OperatorWorkspaceManifest
): OperatorWorkspaceManifest => {
  const tenantId = normalizeNonEmpty(manifest?.tenantId, "tenantId");
  const workspaceId = normalizeNonEmpty(manifest?.workspaceId, "workspaceId");
  const runtimeId = normalizeNonEmpty(manifest?.runtimeId, "runtimeId");
  const manifestVersion = normalizeNonEmpty(manifest?.manifestVersion, "manifestVersion");
  const workspaceRoot = canonicalizeExistingPath(manifest?.workspaceRoot, "workspaceRoot");
  const runClass = normalizeNonEmpty(String(manifest?.runClass), "runClass");
  if (!["interactive", "scheduled", "one_shot"].includes(runClass)) {
    throw new OperatorPolicyValidationError("runClass must be interactive, scheduled, or one_shot");
  }

  const readOnlyMounts = normalizeReadOnlyMounts(manifest.readOnlyMounts, "readOnlyMounts");
  const scratchMounts = normalizeManagedMounts(manifest.scratchMounts, "scratchMounts");
  const stateMounts = normalizeManagedMounts(manifest.stateMounts, "stateMounts");
  const ipcMounts = normalizeManagedMounts(manifest.ipcMounts, "ipcMounts");
  const extraMounts = normalizeExtraMounts(manifest.extraMounts, "extraMounts");
  const requestedSecretRefs = normalizeSecretRefs(manifest.requestedSecretRefs, "requestedSecretRefs");
  const rawSecretEnvKeys = normalizeSecretRefs(manifest.rawSecretEnvKeys, "rawSecretEnvKeys");

  const targetPaths = new Set<string>();
  for (const mount of [...readOnlyMounts, ...scratchMounts, ...stateMounts, ...ipcMounts, ...extraMounts]) {
    if (targetPaths.has(mount.targetPath)) {
      throw new OperatorPolicyValidationError(`duplicate targetPath detected: ${mount.targetPath}`);
    }
    targetPaths.add(mount.targetPath);
  }

  return {
    manifestVersion,
    tenantId,
    workspaceId,
    runClass: runClass as OperatorRunClass,
    runtimeId,
    runtimeVersion: manifest.runtimeVersion?.trim() || null,
    workspaceRoot,
    readOnlyMounts,
    scratchMounts,
    stateMounts,
    ipcMounts,
    extraMounts,
    requestedSecretRefs,
    rawSecretEnvKeys,
    requestedAt: normalizeRequestedAt(manifest.requestedAt),
  };
};

export const validateOperatorRuntimePolicy = (
  policy: OperatorRuntimePolicy
): OperatorRuntimePolicy => {
  const policyVersion = normalizeNonEmpty(policy?.policyVersion, "policyVersion");
  const policyId = normalizeNonEmpty(policy?.policyId, "policyId");
  const runtimeClass = normalizeNonEmpty(String(policy?.runtimeClass), "runtimeClass");
  if (runtimeClass !== "tenant" && runtimeClass !== "operator") {
    throw new OperatorPolicyValidationError("runtimeClass must be tenant or operator");
  }

  const runtimeRoot = path.resolve(normalizeNonEmpty(policy?.runtimeRoot, "runtimeRoot"));
  const allowReadOnlyRoots = (policy.allowReadOnlyRoots ?? []).map((root, index) =>
    canonicalizeExistingPath(root, `allowReadOnlyRoots[${index}]`)
  );
  const approvedExtraMounts = (policy.approvedExtraMounts ?? []).map((rule, index) => ({
    sourcePath: canonicalizeExistingPath(rule.sourcePath, `approvedExtraMounts[${index}].sourcePath`),
    access: rule.access,
    tenantIds: rule.tenantIds ? [...rule.tenantIds].sort((left, right) => left.localeCompare(right)) : undefined,
    workspaceIds: rule.workspaceIds
      ? [...rule.workspaceIds].sort((left, right) => left.localeCompare(right))
      : undefined,
  }));

  return {
    policyVersion,
    policyId,
    runtimeClass: runtimeClass as OperatorRuntimePolicy["runtimeClass"],
    secureExecutionRequired: Boolean(policy.secureExecutionRequired),
    runtimeRoot,
    allowReadOnlyRoots,
    approvedExtraMounts,
    brokeredSecretRefs: normalizeSecretRefs(policy.brokeredSecretRefs, "brokeredSecretRefs"),
    forceReadOnly: Boolean(policy.forceReadOnly),
    denySensitivePathSegments: [
      ...new Set([...(policy.denySensitivePathSegments ?? []), ...DEFAULT_DENY_SEGMENTS]),
    ].sort((left, right) => left.localeCompare(right)),
  };
};

export class OperatorRuntimePolicyBroker {
  evaluate(
    manifestInput: OperatorWorkspaceManifest,
    policyInput: OperatorRuntimePolicy,
    options: BrokerOptions
  ): OperatorPolicyDecision {
    const manifest = validateOperatorWorkspaceManifest(manifestInput);
    const policy = validateOperatorRuntimePolicy(policyInput);
    const now = options.now ?? new Date();
    const rejectedMounts: OperatorRejectedMount[] = [];
    const allowedMounts: OperatorResolvedMount[] = [];
    const rejectedRawSecretEnvKeys = [...(manifest.rawSecretEnvKeys ?? [])];

    const audit = {
      tenantId: manifest.tenantId,
      workspaceId: manifest.workspaceId,
      runtimeId: manifest.runtimeId,
      runtimeVersion: manifest.runtimeVersion ?? null,
      runClass: manifest.runClass,
      policyId: policy.policyId,
      secureExecutionRequired: policy.secureExecutionRequired,
      secureExecutionAvailable: options.secureExecutionAvailable,
      brokeredSecrets: [] as string[],
      rejectedRawSecretEnvKeys,
      allowedMounts,
      rejectedMounts,
      evaluatedAt: now.toISOString(),
    } satisfies OperatorRuntimeAuditRecord;

    if (policy.secureExecutionRequired && !options.secureExecutionAvailable) {
      return {
        allowed: false,
        reason: "secure execution is unavailable; refusing to boot with insecure or stub runtime",
        audit,
      };
    }

    if (rejectedRawSecretEnvKeys.length > 0) {
      return {
        allowed: false,
        reason: "raw secret environment injection is not permitted; use brokered secret refs instead",
        audit,
      };
    }

    const sensitiveSegments = policy.denySensitivePathSegments ?? [...DEFAULT_DENY_SEGMENTS];
    const normalizedWorkspaceRoot = canonicalizeExistingPath(manifest.workspaceRoot, "workspaceRoot");

    for (const mount of manifest.readOnlyMounts) {
      const sensitiveMatch = containsSensitiveSegment(mount.sourcePath, sensitiveSegments);
      if (sensitiveMatch) {
        rejectedMounts.push({
          name: mount.name,
          kind: "read_only",
          sourcePath: mount.sourcePath,
          targetPath: mount.targetPath,
          reason: `sourcePath contains sensitive segment ${sensitiveMatch}`,
        });
        continue;
      }

      const withinAllowedRoot = policy.allowReadOnlyRoots.some((root) => {
        const relative = path.relative(root, mount.sourcePath);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      });
      if (!withinAllowedRoot) {
        rejectedMounts.push({
          name: mount.name,
          kind: "read_only",
          sourcePath: mount.sourcePath,
          targetPath: mount.targetPath,
          reason: "sourcePath is outside the approved read-only roots",
        });
        continue;
      }

      if (mount.sourcePath !== normalizedWorkspaceRoot) {
        ensureUnderRoot(mount.sourcePath, normalizedWorkspaceRoot, `readOnly mount ${mount.name}`);
      }

      allowedMounts.push({
        name: mount.name,
        kind: "read_only",
        sourcePath: mount.sourcePath,
        targetPath: mount.targetPath,
        access: "ro",
        managed: false,
      });
    }

    for (const [kind, mounts] of [
      ["scratch", manifest.scratchMounts],
      ["state", manifest.stateMounts],
      ["ipc", manifest.ipcMounts],
    ] as const) {
      for (const mount of mounts) {
        const sourcePath = buildManagedSourcePath(
          policy.runtimeRoot,
          manifest.tenantId,
          manifest.workspaceId,
          kind,
          mount.name,
          Boolean(options.createManagedRoots)
        );
        ensureUnderRoot(sourcePath, policy.runtimeRoot, `${kind} mount ${mount.name}`);
        allowedMounts.push({
          name: mount.name,
          kind,
          sourcePath,
          targetPath: mount.targetPath,
          access: policy.forceReadOnly ? "ro" : "rw",
          managed: true,
        });
      }
    }

    for (const mount of manifest.extraMounts ?? []) {
      const sensitiveMatch = containsSensitiveSegment(mount.sourcePath, sensitiveSegments);
      if (sensitiveMatch) {
        rejectedMounts.push({
          name: mount.name,
          kind: "extra",
          sourcePath: mount.sourcePath,
          targetPath: mount.targetPath,
          reason: `sourcePath contains sensitive segment ${sensitiveMatch}`,
        });
        continue;
      }

      const matchingRule = policy.approvedExtraMounts?.find((rule) =>
        matchesPolicyRule(rule, mount.sourcePath, manifest.tenantId, manifest.workspaceId)
      );
      if (!matchingRule) {
        rejectedMounts.push({
          name: mount.name,
          kind: "extra",
          sourcePath: mount.sourcePath,
          targetPath: mount.targetPath,
          reason: "sourcePath is not present in the approved extra mount policy",
        });
        continue;
      }

      allowedMounts.push({
        name: mount.name,
        kind: "extra",
        sourcePath: mount.sourcePath,
        targetPath: mount.targetPath,
        access: policy.forceReadOnly || matchingRule.access === "ro" ? "ro" : mount.access,
        managed: false,
      });
    }

    const requestedSecretRefs = manifest.requestedSecretRefs ?? [];
    audit.brokeredSecrets = requestedSecretRefs.filter((ref) =>
      (policy.brokeredSecretRefs ?? []).includes(ref)
    );
    const missingSecrets = requestedSecretRefs.filter(
      (ref) => !audit.brokeredSecrets.includes(ref)
    );

    if (missingSecrets.length > 0) {
      return {
        allowed: false,
        reason: `requested brokered secrets are not approved: ${missingSecrets.join(", ")}`,
        audit,
      };
    }

    if (rejectedMounts.length > 0) {
      return {
        allowed: false,
        reason: "one or more requested mounts were rejected by policy",
        audit,
      };
    }

    return {
      allowed: true,
      mounts: allowedMounts,
      brokeredSecrets: audit.brokeredSecrets,
      audit,
    };
  }
}
