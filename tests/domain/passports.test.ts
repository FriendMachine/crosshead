import { readFileSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  AGENT_PASSPORT_SCHEMA_VERSION,
  agentPassportExample,
  buildDraftAgentPassport,
  validateAgentPassport,
} from "../../src/protocol/passports";
import { persistentAgentEntityExample } from "../../src/protocol/persistent-agents";

describe("agent passport contracts", () => {
  it("accepts the checked-in passport example and schema example", () => {
    expect(validateAgentPassport(agentPassportExample)).toEqual([]);

    const schemaPath = path.resolve("schemas/agent-passport.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      examples?: unknown[];
      $defs?: Record<string, unknown>;
    };

    expect(schema.$defs).toHaveProperty("passportCompilationTarget");
    expect(schema.$defs).toHaveProperty("passportTrustZone");
    expect(validateAgentPassport(schema.examples?.[0])).toEqual([]);
  });

  it("rejects passports that overclaim runtime enforcement or reference undeclared trust zones", () => {
    const invalid = JSON.parse(JSON.stringify(agentPassportExample)) as typeof agentPassportExample;
    invalid.trustZones = invalid.trustZones.filter((zone) => zone.trustZoneId !== "client");
    invalid.enforcement.compilationTargets[0]!.trustZonePolicies.push({
      trustZoneId: "client",
      compiledArtifacts: [
        {
          artifactId: "artifact_client_prompt",
          surface: "AGENTS.md",
          pathHint: "$WORKSPACE/AGENTS.md",
          honesty: "runtime_enforced",
          sourceOfTruth: "prompt_file",
          notes: ["Invalid: prompt files cannot honestly claim runtime enforcement."],
        },
      ],
      notes: ["Invalid: undeclared trust zone reference."],
    });

    expect(validateAgentPassport(invalid)).toEqual(
      expect.arrayContaining([
        "compiledArtifact.runtime_enforced artifacts must declare onlybots_runtime as the source of truth",
        "compilationTarget.trustZonePolicy client is not declared in trustZones",
      ])
    );
  });

  it("builds a draft passport that stays anchored to the persistent agent identity and provenance contract", () => {
    const draft = buildDraftAgentPassport({
      agentRef: persistentAgentEntityExample.agentRef,
      displayName: "Test Passport Agent",
      continuityPolicyRef: "continuity_policy_v1:sha256:test",
      compilerVersion: "0.3.0",
      allowedWorkspaces: ["repo:test-workspace"],
      createdAt: "2026-04-15T00:00:00Z",
    });

    expect(draft.passportVersion).toBe(AGENT_PASSPORT_SCHEMA_VERSION);
    expect(draft.agentRef).toEqual(persistentAgentEntityExample.agentRef);
    expect(draft.signature.signedBy).toBe(draft.agentRef.npub);
    expect(draft.enforcement.compilationTargets.map((entry) => entry.targetHost)).toEqual(["codex", "claude-code", "pi"]);
    expect(draft.enforcement.compilationTargets.find((entry) => entry.targetHost === "pi")?.trustZonePolicies[0]?.compiledArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: "pi-passport.json",
        }),
      ])
    );
    expect(draft.provenance.requiredCompiledFields).toEqual(
      expect.arrayContaining([
        "passport_version",
        "generated_at",
        "compiler_version",
        "source_passport_hash",
        "trust_zone_id",
        "target_host",
      ])
    );
    expect(validateAgentPassport(draft)).toEqual([]);
  });
});
