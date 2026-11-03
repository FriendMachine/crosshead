import { describe, expect, it } from "vitest";

import {
  WARM_PROMOTION_CANDIDATE_SCHEMA_VERSION,
  WARM_PROMOTION_CLASSIFIER_SCHEMA_VERSION,
  buildWarmEntryTagsFromCandidate,
  buildWarmPromotionCandidates,
  extractDeterministicWarmPromotionTags,
  parseWarmPromotionCandidate,
  parseWarmPromotionClassifierOutput,
  validateWarmPromotionCandidate,
  validateWarmPromotionClassifierOutput,
  type WarmPromotionEvent,
} from "../../src/runtime/warm-memory-promotion";

const buildEvent = (overrides: Partial<WarmPromotionEvent> = {}): WarmPromotionEvent => ({
  eventId: "evt_123",
  runtime: "codex",
  profileName: "default",
  workspaceId: "repo:/tmp/onlybots",
  sessionId: "sess_123",
  turnId: "turn_123",
  type: "turn.completed",
  occurredAt: "2026-04-05T12:00:00.000Z",
  payload: {},
  metadata: {},
  ...overrides,
});

describe("warm-memory promotion contract", () => {
  it("builds stable promotion candidates from turn-completed facts and commitments", () => {
    const event = buildEvent({
      payload: {
        newFact: "The runtime lifecycle manager owns automatic memory policy.",
        newCommitment: "Verify rollback integrity after adapter updates.",
        taskSucceeded: true,
        taskId: "79",
        filePaths: ["src/runtime/lifecycle-engine.ts", "tests/runtime/runtime-memory-lifecycle.test.ts"],
      },
      metadata: {
        commitSha: "729cfd40c7e3ebc4e574b9e7bd318127b2f41955",
        toolName: "apply_patch",
      },
    });

    const candidates = buildWarmPromotionCandidates(event);
    expect(candidates).toHaveLength(2);

    const factCandidate = candidates.find((candidate) => candidate.inferred.type === "fact");
    expect(factCandidate).toBeTruthy();
    expect(factCandidate?.schemaVersion).toBe(WARM_PROMOTION_CANDIDATE_SCHEMA_VERSION);
    expect(factCandidate?.reason).toContain("new fact");
    expect(factCandidate?.deterministicTags).toEqual(
      expect.arrayContaining([
        "runtime:codex",
        "profile:default",
        "event:turn.completed",
        "candidate:fact",
        "task:79",
        "tool:apply_patch",
        "commit:729cfd40c7e3ebc4e574b9e7bd318127b2f41955",
        "file:src/runtime/lifecycle-engine.ts",
	"continuity-scope:project",
      ])
    );
    expect(factCandidate?.deterministicTags.some((tag) => tag.startsWith("continuity-dedupe:"))).toBe(true);
    expect(factCandidate?.deterministicTags.some((tag) => tag.startsWith("memory-claim:shared-continuity:"))).toBe(true);
    expect(factCandidate?.deterministicTags).toContain("source-event:evt_123");
    expect(factCandidate?.inferred.durabilityRecommendation).toBe("promote");
    expect(factCandidate?.classifierContract.schemaVersion).toBe(WARM_PROMOTION_CLASSIFIER_SCHEMA_VERSION);
    expect(factCandidate?.classifierContract.classifierOwner).toBe("onlybots_server");
    validateWarmPromotionCandidate(factCandidate!);

    const warmTags = buildWarmEntryTagsFromCandidate(factCandidate!);
    expect(warmTags).toEqual(expect.arrayContaining(["runtime:codex", "topic:runtime", "topic:memory"]));

    const commitmentCandidate = candidates.find((candidate) => candidate.inferred.type === "commitment");
    expect(commitmentCandidate?.inferred.topicTags).toContain("workflow");
  });

  it("uses host-neutral project continuity dedupe unless a candidate is explicitly host-specific", () => {
    const projectContent = "Keep deploy validation in the continuity ledger after every main push.";
    const codexProject = buildWarmPromotionCandidates(
      buildEvent({
	eventId: "evt_codex_project",
	runtime: "codex",
	payload: { newCommitment: projectContent, taskSucceeded: true },
      })
    )[0]!;
    const claudeProject = buildWarmPromotionCandidates(
      buildEvent({
	eventId: "evt_claude_project",
	runtime: "claude-code",
	sessionId: "claude-session",
	payload: { newCommitment: projectContent, taskSucceeded: true },
      })
    )[0]!;

    expect(codexProject.scoring.recurrenceKey).toBe(claudeProject.scoring.recurrenceKey);
    expect(codexProject.deterministicTags).toContain("continuity-scope:project");
    expect(claudeProject.deterministicTags).toContain("continuity-scope:project");
    expect(codexProject.deterministicTags).not.toContain("continuity-host:codex");

    const hostSpecific = buildWarmPromotionCandidates(
      buildEvent({
	runtime: "codex",
	payload: {
	  warmCandidates: [
	    {
	      type: "fact",
	      content: "Codex hook settings are host-specific and live under CODEX_HOME.",
	      tags: ["host-specific", "runtime"],
	      confidence: 0.95,
	    },
	  ],
	},
      })
    )[0]!;

    expect(hostSpecific.scoring.recurrenceKey).toContain("runtime-host:codex:");
    expect(hostSpecific.deterministicTags).toContain("continuity-scope:runtime_host");
    expect(hostSpecific.deterministicTags).toContain("continuity-host:codex");
  });

  it("normalizes explicit remember commands into promotion candidates with explicit scoring", () => {
    const event = buildEvent({
      type: "operator.command",
      turnId: null,
      payload: {
        command: "remember",
        entryType: "correction",
        content: "Codex should rely on the local runtime for memory writes.",
        tags: ["Runtime", "memory", "runtime"],
        supersedesEntryIds: ["warm_1"],
        conflictsWithEntryIds: ["warm_legacy"],
      },
    });

    const [candidate] = buildWarmPromotionCandidates(event);
    expect(candidate.inferred.type).toBe("correction");
    expect(candidate.scoring.explicit).toBe(true);
    expect(candidate.scoring.sourceQuality).toBe("explicit_operator");
    expect(candidate.inferred.durabilityRecommendation).toBe("promote");
    expect(candidate.relations.supersedesEntryIds).toEqual(["warm_1"]);
    expect(candidate.relations.conflictsWithEntryIds).toEqual(["warm_legacy"]);
    expect(candidate.inferred.topicTags).toEqual(expect.arrayContaining(["memory", "runtime"]));
    expect(candidate.classifierContract.input.currentInference.type).toBe("correction");
  });

  it("extracts deterministic tags from correction-like events with command, turn, session, and workspace metadata", () => {
    const tags = extractDeterministicWarmPromotionTags(
      buildEvent({
        type: "operator.command",
        payload: {
          command: "remember",
          taskTitle: "Warm memory follow-up",
        },
      }),
      "fact"
    );

    expect(tags).toEqual(
      expect.arrayContaining([
        "runtime:codex",
        "profile:default",
        "event:operator.command",
        "candidate:fact",
        "workspace:repo-/tmp/onlybots",
        "session:sess_123",
        "turn:turn_123",
        "command:remember",
        "task:warm-memory-follow-up",
      ])
    );
  });

  it("validates constrained classifier outputs", () => {
    const output = validateWarmPromotionClassifierOutput({
      schemaVersion: WARM_PROMOTION_CLASSIFIER_SCHEMA_VERSION,
      authoritativeFields: [],
      advisoryFields: [
        "inferredType",
        "topicTags",
        "durabilityRecommendation",
        "confidence",
        "supersedesEntryIds",
        "conflictsWithEntryIds",
      ],
      inferredType: "fact",
      topicTags: ["runtime", "memory"],
      durabilityRecommendation: "promote",
      confidence: 0.93,
      supersedesEntryIds: ["warm_older"],
      conflictsWithEntryIds: [],
    });

    expect(output.confidence).toBe(0.93);
  });

  it("distills successful turn summaries and structured outcomes into durable candidate shapes", () => {
    const summaryOnly = buildWarmPromotionCandidates(
      buildEvent({
        payload: {
          taskSucceeded: true,
          summary: "The runtime now routes structured warm-memory candidates through the server policy engine.",
        },
      })
    );
    expect(summaryOnly).toHaveLength(1);
    expect(summaryOnly[0]?.inferred.type).toBe("fact");
    expect(summaryOnly[0]?.reason).toContain("durable summary");

    const structured = buildWarmPromotionCandidates(
      buildEvent({
        payload: {
          taskSucceeded: true,
          whatChanged: "Warm commits now submit the candidate contract directly to the server.",
          nextStep: "Verify lifecycle activity records the returned server decision.",
          canonicalWorkflow: "Submit structured warm-memory candidates instead of raw warm writes.",
          remainingCaveat: "Do not rely on raw warm writes for automatic promotion in auto mode.",
        },
      })
    );

    expect(structured.map((candidate) => candidate.inferred.type).sort()).toEqual([
      "commitment",
      "correction",
      "fact",
      "pattern",
    ]);
    expect(structured.some((candidate) => candidate.reason.includes("canonical workflow"))).toBe(true);
  });

  it("does not mark durable facts as testing artifacts from host metadata alone", () => {
    const [candidate] = buildWarmPromotionCandidates(
      buildEvent({
        payload: {
          taskSucceeded: true,
          newFact: "The runtime routes durable warm-memory candidates through the server policy.",
        },
        metadata: {
          hostVersion: "codex-test-1.0.0",
        },
      })
    );

    expect(candidate.inferred.topicTags).not.toContain("testing");
    expect(candidate.inferred.durabilityRecommendation).toBe("promote");
  });

  it("rejects malformed candidates", () => {
    const [candidate] = buildWarmPromotionCandidates(
      buildEvent({
        payload: {
          newFact: "The runtime should emit stable promotion candidates.",
        },
      })
    );

    expect(() =>
      validateWarmPromotionCandidate({
        ...candidate,
        content: {
          ...candidate.content,
          hash: "bad-hash",
        },
      })
    ).toThrow("Warm promotion candidate content hash is invalid");
  });

  it("parses a structurally valid candidate from untyped JSON and round-trips it", () => {
    const [candidate] = buildWarmPromotionCandidates(
      buildEvent({
        payload: {
          newFact: "The runtime should emit stable promotion candidates.",
        },
      })
    );

    const parsed = parseWarmPromotionCandidate(JSON.parse(JSON.stringify(candidate)) as unknown);
    expect(parsed).toEqual(candidate);
  });

  it("rejects structurally malformed candidates with field-specific errors instead of TypeErrors", () => {
    const [candidate] = buildWarmPromotionCandidates(
      buildEvent({
        payload: {
          newFact: "The runtime should emit stable promotion candidates.",
        },
      })
    );

    expect(() => parseWarmPromotionCandidate(null)).toThrow("candidate must be an object");
    expect(() => parseWarmPromotionCandidate({ ...candidate, content: "not-an-object" })).toThrow(
      "candidate.content must be an object"
    );
    expect(() =>
      parseWarmPromotionCandidate({ ...candidate, inferred: { ...candidate.inferred, type: "vibe" } })
    ).toThrow("candidate.inferred.type must be one of");
    expect(() => parseWarmPromotionCandidate({ ...candidate, deterministicTags: [42] })).toThrow(
      "candidate.deterministicTags must be an array of strings"
    );
    expect(() =>
      parseWarmPromotionCandidate({ ...candidate, scoring: { ...candidate.scoring, explicit: "yes" } })
    ).toThrow("candidate.scoring.explicit must be a boolean");
  });

  it("parses classifier output from untyped JSON and rejects malformed shapes", () => {
    const output = {
      schemaVersion: WARM_PROMOTION_CLASSIFIER_SCHEMA_VERSION,
      authoritativeFields: [],
      advisoryFields: ["inferredType", "confidence"],
      inferredType: "fact",
      topicTags: [],
      durabilityRecommendation: "promote",
      confidence: 0.8,
      supersedesEntryIds: [],
      conflictsWithEntryIds: [],
    };

    const parsed = parseWarmPromotionClassifierOutput(JSON.parse(JSON.stringify(output)) as unknown);
    expect(parsed).toEqual(output);

    expect(() => parseWarmPromotionClassifierOutput("nope")).toThrow("classifierOutput must be an object");
    expect(() => parseWarmPromotionClassifierOutput({ ...output, confidence: "high" })).toThrow(
      "classifierOutput.confidence must be a finite number"
    );
    expect(() => parseWarmPromotionClassifierOutput({ ...output, inferredType: "vibe" })).toThrow(
      "classifierOutput.inferredType must be one of"
    );
  });
});
