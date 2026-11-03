import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  OperatorRuntimePolicyBroker,
  type OperatorRuntimePolicy,
  type OperatorWorkspaceManifest,
  validateOperatorWorkspaceManifest,
} from "../../src/runtime/operator-policy";

const createFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "onlybots-operator-policy-"));
  const workspaceRoot = path.join(root, "workspace");
  const runtimeRoot = path.join(root, "runtime");
  const extrasRoot = path.join(root, "extras");
  const sensitiveRoot = path.join(root, ".ssh");

  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(extrasRoot, { recursive: true });
  mkdirSync(sensitiveRoot, { recursive: true });
  writeFileSync(path.join(workspaceRoot, "README.md"), "workspace");
  writeFileSync(path.join(extrasRoot, "docs.txt"), "docs");
  writeFileSync(path.join(sensitiveRoot, "id_rsa"), "secret");

  const linkTarget = path.join(root, "linked-workspace");
  symlinkSync(workspaceRoot, linkTarget);

  const policy: OperatorRuntimePolicy = {
    policyVersion: "2026-04-02",
    policyId: "tenant-policy",
    runtimeClass: "tenant",
    secureExecutionRequired: true,
    runtimeRoot,
    allowReadOnlyRoots: [workspaceRoot],
    approvedExtraMounts: [
      {
        sourcePath: extrasRoot,
        access: "ro",
        tenantIds: ["npub1tenant"],
        workspaceIds: ["repo-main"],
      },
    ],
    brokeredSecretRefs: ["nostr_identity", "onlybots_session"],
  };

  const manifest: OperatorWorkspaceManifest = {
    manifestVersion: "1",
    tenantId: "npub1tenant",
    workspaceId: "repo-main",
    runClass: "interactive",
    runtimeId: "codex",
    runtimeVersion: "1.2.3",
    workspaceRoot: linkTarget,
    readOnlyMounts: [
      {
        name: "workspace",
        sourcePath: workspaceRoot,
        targetPath: "/workspace",
      },
    ],
    scratchMounts: [{ name: "scratch", targetPath: "/scratch" }],
    stateMounts: [{ name: "state", targetPath: "/state" }],
    ipcMounts: [{ name: "bridge", targetPath: "/ipc" }],
    extraMounts: [
      {
        name: "extra-docs",
        sourcePath: extrasRoot,
        targetPath: "/extra/docs",
        access: "rw",
      },
    ],
    requestedSecretRefs: ["nostr_identity"],
  };

  return { root, workspaceRoot, runtimeRoot, extrasRoot, sensitiveRoot, policy, manifest };
};

describe("OperatorRuntimePolicyBroker", () => {
  it("canonicalizes manifests and resolves tenant-scoped managed mounts", () => {
    const { runtimeRoot, manifest, policy } = createFixture();
    const broker = new OperatorRuntimePolicyBroker();

    const validated = validateOperatorWorkspaceManifest(manifest);
    expect(validated.workspaceRoot).not.toBe(manifest.workspaceRoot);

    const decision = broker.evaluate(manifest, policy, {
      secureExecutionAvailable: true,
      createManagedRoots: true,
      now: new Date("2026-04-02T12:00:00.000Z"),
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
      return;
    }

    expect(decision.mounts.map((mount) => `${mount.kind}:${mount.access}`)).toEqual([
      "read_only:ro",
      "scratch:rw",
      "state:rw",
      "ipc:rw",
      "extra:ro",
    ]);
    expect(decision.mounts[1]?.sourcePath).toContain(path.join(runtimeRoot, "tenants", "npub1tenant", "repo-main"));
    expect(decision.brokeredSecrets).toEqual(["nostr_identity"]);
    expect(decision.audit.rejectedMounts).toEqual([]);
  });

  it("fails closed when secure execution is unavailable", () => {
    const { manifest, policy } = createFixture();
    const broker = new OperatorRuntimePolicyBroker();

    const decision = broker.evaluate(manifest, policy, {
      secureExecutionAvailable: false,
      createManagedRoots: false,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      return;
    }
    expect(decision.reason).toContain("secure execution is unavailable");
  });

  it("rejects raw secret environment injection", () => {
    const { manifest, policy } = createFixture();
    const broker = new OperatorRuntimePolicyBroker();

    const decision = broker.evaluate(
      {
        ...manifest,
        rawSecretEnvKeys: ["OPENAI_API_KEY"],
      },
      policy,
      {
        secureExecutionAvailable: true,
        createManagedRoots: false,
      }
    );

    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      return;
    }
    expect(decision.reason).toContain("raw secret environment injection");
  });

  it("rejects sensitive mount sources and unauthorized extra mounts", () => {
    const { manifest, policy, sensitiveRoot, root } = createFixture();
    const broker = new OperatorRuntimePolicyBroker();

    const unauthorizedExtra = path.join(root, "unauthorized");
    mkdirSync(unauthorizedExtra, { recursive: true });

    const decision = broker.evaluate(
      {
        ...manifest,
        readOnlyMounts: [
          ...manifest.readOnlyMounts,
          {
            name: "ssh",
            sourcePath: sensitiveRoot,
            targetPath: "/workspace/.ssh",
          },
        ],
        extraMounts: [
          ...(manifest.extraMounts ?? []),
          {
            name: "bad-extra",
            sourcePath: unauthorizedExtra,
            targetPath: "/extra/bad",
            access: "rw",
          },
        ],
      },
      policy,
      {
        secureExecutionAvailable: true,
        createManagedRoots: false,
      }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.audit.rejectedMounts.map((mount) => mount.name)).toEqual(["ssh", "bad-extra"]);
  });

  it("forces tenant runtimes into read-only mode when policy requires it", () => {
    const { manifest, policy } = createFixture();
    const broker = new OperatorRuntimePolicyBroker();

    const decision = broker.evaluate(
      manifest,
      {
        ...policy,
        forceReadOnly: true,
      },
      {
        secureExecutionAvailable: true,
        createManagedRoots: false,
      }
    );

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
      return;
    }
    expect(decision.mounts.filter((mount) => mount.kind !== "read_only").every((mount) => mount.access === "ro")).toBe(
      true
    );
  });

  it("checks managed mount containment before creating directories", () => {
    const { root, runtimeRoot, manifest, policy } = createFixture();
    const broker = new OperatorRuntimePolicyBroker();
    const escapedRoot = path.join(root, "escaped");

    expect(() => broker.evaluate(
      {
		...manifest,
		tenantId: "../../escaped",
      },
      policy,
      {
		secureExecutionAvailable: true,
		createManagedRoots: true,
      }
    )).toThrow("must remain under");

    expect(existsSync(escapedRoot)).toBe(false);
    expect(existsSync(path.join(runtimeRoot, "tenants", "npub1tenant"))).toBe(false);
  });
});
