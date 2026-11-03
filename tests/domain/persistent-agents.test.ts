import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

import {
  INHERITANCE_BOUNDARY_VERSION,
  LINEAGE_LINK_VERSION,
  PERSISTENT_AGENT_ENTITY_VERSION,
  lineageLinkExample,
  persistentAgentInheritanceBoundaryExample,
  persistentAgentEntityExample,
  toContinuityIdentityReference,
  validateLineageLink,
  validatePersistentAgentInheritanceBoundary,
  validatePersistentAgentEntity,
  validatePersistentAgentReference,
} from "../../src/protocol/persistent-agents";

describe("persistent agent contracts", () => {
  it("accepts the checked-in persistent agent and lineage examples", () => {
    expect(validatePersistentAgentEntity(persistentAgentEntityExample)).toEqual([]);
    expect(validateLineageLink(lineageLinkExample)).toEqual([]);
    expect(validatePersistentAgentInheritanceBoundary(persistentAgentInheritanceBoundaryExample)).toEqual([]);
  });

  it("loads the checked-in schema example and lineage definition", () => {
    const schemaPath = path.resolve("schemas/persistent-agent-entity.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      examples?: unknown[];
      $defs?: Record<string, unknown>;
    };

    expect(Array.isArray(schema.examples)).toBe(true);
    expect(schema.$defs).toHaveProperty("lineageLink");
    expect(schema.$defs).toHaveProperty("inheritanceBoundary");
    expect(validatePersistentAgentEntity(schema.examples?.[0])).toEqual([]);
  });

  it("rejects inconsistent persistent-agent references and lineage links", () => {
    expect(
      validatePersistentAgentReference({
        agentId: "codex-session-1",
        npub: "not-an-npub",
        lineageRoot: "agent_valid_root",
      })
    ).toEqual([
      "agentRef.agentId must match /^agent_[a-z0-9][a-z0-9_-]{2,127}$/",
      "agentRef.npub must be an npub identifier",
    ]);

    expect(
      validateLineageLink({
        ...lineageLinkExample,
        schemaVersion: LINEAGE_LINK_VERSION,
        childAgentId: lineageLinkExample.parentAgentId,
      })
    ).toContain("parentAgentId and childAgentId must differ");

    expect(
      validatePersistentAgentInheritanceBoundary({
        ...persistentAgentInheritanceBoundaryExample,
        schemaVersion: INHERITANCE_BOUNDARY_VERSION,
        inheritedRefs: ["self_model_onlybots_primary"],
        excludedRefs: ["self_model_onlybots_primary"],
      })
    ).toContain("inheritedRefs and excludedRefs must not overlap");
  });

  it("rejects ambiguous timestamps and duplicate runtime attachment ids", () => {
    expect(
      validatePersistentAgentEntity({
	...structuredClone(persistentAgentEntityExample),
	createdAt: "0",
      })
    ).toContain("createdAt must be an ISO date string");

    const impossibleAttachment = structuredClone(persistentAgentEntityExample);
    impossibleAttachment.currentRuntimeAttachments[0]!.attachedAt =
      "2026-02-30T00:00:00Z";
    expect(validatePersistentAgentEntity(impossibleAttachment)).toContain(
      "runtimeAttachment.attachedAt must be an ISO date string"
    );

    const duplicateAttachments = structuredClone(persistentAgentEntityExample);
    duplicateAttachments.status = "suspended";
    duplicateAttachments.currentRuntimeAttachments = [
      duplicateAttachments.currentRuntimeAttachments[0]!,
      structuredClone(duplicateAttachments.currentRuntimeAttachments[0]!),
    ];
    expect(validatePersistentAgentEntity(duplicateAttachments)).toContain(
      "currentRuntimeAttachments attachmentId values must be unique"
    );
  });

  it("keeps the durable agent reference consistent across continuity, passport, and handoff surfaces", () => {
    const agentRef = persistentAgentEntityExample.agentRef;
    const continuityIdentity = toContinuityIdentityReference(agentRef);
    const passport = {
      passportVersion: "agent_passport_v1",
      agentRef,
    };
    const handoff = {
      capsuleVersion: "handoff_capsule_v1",
      agentRef,
      runtimeAttachment: persistentAgentEntityExample.currentRuntimeAttachments[0],
      engineAttachment: persistentAgentEntityExample.currentEngineAttachment,
    };

    expect(persistentAgentEntityExample.schemaVersion).toBe(PERSISTENT_AGENT_ENTITY_VERSION);
    expect(continuityIdentity).toEqual({
      agentId: passport.agentRef.agentId,
      npub: passport.agentRef.npub,
      lineageRoot: passport.agentRef.lineageRoot,
    });
    expect(handoff.agentRef).toEqual(passport.agentRef);
    expect(handoff.runtimeAttachment?.runtimeHost).toBe(handoff.engineAttachment?.runtimeHost);
  });
});
