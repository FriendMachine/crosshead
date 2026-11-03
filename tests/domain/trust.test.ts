import { readFileSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  capabilityClaimExample,
  negotiationThreadExample,
  persistentOrganizationExample,
  trustEdgeExample,
  trustReceiptExample,
  validateCapabilityClaim,
  validateNegotiationThread,
  validatePersistentOrganization,
  validateTrustEdge,
  validateTrustReceipt,
} from "../../src/protocol/trust";

describe("trust and organization contracts", () => {
  it("accepts the checked-in examples and schema examples", () => {
    expect(validateTrustReceipt(trustReceiptExample)).toEqual([]);
    expect(validateTrustEdge(trustEdgeExample)).toEqual([]);
    expect(validateCapabilityClaim(capabilityClaimExample)).toEqual([]);
    expect(validatePersistentOrganization(persistentOrganizationExample)).toEqual([]);
    expect(validateNegotiationThread(negotiationThreadExample)).toEqual([]);

    const trustReceiptSchema = JSON.parse(
      readFileSync(path.resolve("schemas/trust-receipt.schema.json"), "utf8")
    ) as { examples?: unknown[]; $defs?: Record<string, unknown> };
    const trustEdgeSchema = JSON.parse(
      readFileSync(path.resolve("schemas/trust-edge.schema.json"), "utf8")
    ) as { examples?: unknown[]; $defs?: Record<string, unknown> };
    const capabilityClaimSchema = JSON.parse(
      readFileSync(path.resolve("schemas/capability-claim.schema.json"), "utf8")
    ) as { examples?: unknown[]; $defs?: Record<string, unknown> };
    const organizationSchema = JSON.parse(
      readFileSync(path.resolve("schemas/persistent-organization.schema.json"), "utf8")
    ) as { examples?: unknown[]; $defs?: Record<string, unknown> };
    const negotiationSchema = JSON.parse(
      readFileSync(path.resolve("schemas/negotiation-thread.schema.json"), "utf8")
    ) as { examples?: unknown[]; $defs?: Record<string, unknown> };

    expect(trustReceiptSchema.$defs).toHaveProperty("trustSubjectRef");
    expect(trustEdgeSchema.$defs).toHaveProperty("reputationInfluenceBoundary");
    expect(capabilityClaimSchema.$defs).toHaveProperty("capabilityRoutingHints");
    expect(organizationSchema.$defs).toHaveProperty("persistentOrganizationMember");
    expect(negotiationSchema.$defs).toHaveProperty("negotiationEvent");

    expect(validateTrustReceipt(trustReceiptSchema.examples?.[0])).toEqual([]);
    expect(validateTrustEdge(trustEdgeSchema.examples?.[0])).toEqual([]);
    expect(validateCapabilityClaim(capabilityClaimSchema.examples?.[0])).toEqual([]);
    expect(validatePersistentOrganization(organizationSchema.examples?.[0])).toEqual([]);
    expect(validateNegotiationThread(negotiationSchema.examples?.[0])).toEqual([]);
  });

  it("rejects trust overclaiming, unsupported observed claims, broken org founders, and incomplete settlements", () => {
    const invalidEdge = JSON.parse(JSON.stringify(trustEdgeExample)) as typeof trustEdgeExample;
    invalidEdge.target = invalidEdge.source;
    invalidEdge.influenceBoundary.lineageCarryoverMode = "none";
    invalidEdge.influenceBoundary.lineageLinkRefs = [trustEdgeExample.influenceBoundary.lineageLinkRefs[0]!];
    expect(validateTrustEdge(invalidEdge)).toEqual(
      expect.arrayContaining([
        "source and target must differ",
        "influenceBoundary.lineageLinkRefs must be empty when lineageCarryoverMode is none",
      ])
    );

    const invalidClaim = JSON.parse(JSON.stringify(capabilityClaimExample)) as typeof capabilityClaimExample;
    invalidClaim.supportingReceiptRefs = [];
    expect(validateCapabilityClaim(invalidClaim)).toEqual(
      expect.arrayContaining([
        "supportingReceiptRefs must contain at least one receipt for observed or endorsed claims",
      ])
    );

    const invalidOrganization = JSON.parse(JSON.stringify(persistentOrganizationExample)) as typeof persistentOrganizationExample;
    invalidOrganization.membership[0]!.role = "operator";
    expect(validatePersistentOrganization(invalidOrganization)).toEqual(
      expect.arrayContaining([
        "founderAgentRefs entry agent_onlybots_default must appear in membership with role founder",
      ])
    );

    const invalidNegotiation = JSON.parse(JSON.stringify(negotiationThreadExample)) as typeof negotiationThreadExample;
    invalidNegotiation.currentTerms!.settlementRef = null;
    invalidNegotiation.events = invalidNegotiation.events.filter((event) => event.eventType !== "settlement");
    expect(validateNegotiationThread(invalidNegotiation)).toEqual(
      expect.arrayContaining([
        "settled negotiations must include a settlement event with a settlementRef",
        "currentTerms.settlementRef is required when status is settled",
      ])
    );
  });

  it("keeps trust, organization, and negotiation layers reference-based on top of persistent agents and collaboration contexts", () => {
    const receiptSubject = trustReceiptExample.subject.subjectType === "agent" ? trustReceiptExample.subject.agentRef.agentId : null;
    const claimSubject = capabilityClaimExample.subject.subjectType === "agent" ? capabilityClaimExample.subject.agentRef.agentId : null;
    const organizationBuilder = persistentOrganizationExample.membership[1]?.memberAgentRef.agentId;

    expect(receiptSubject).toBe("agent_onlybots_research_fork");
    expect(claimSubject).toBe(receiptSubject);
    expect(organizationBuilder).toBe(receiptSubject);

    expect(persistentOrganizationExample.publicCapabilityClaimRefs).toContain(capabilityClaimExample.claimId);
    expect(negotiationThreadExample.currentTerms?.requiredCapabilityClaimRefs).toContain(capabilityClaimExample.claimId);
    expect(trustEdgeExample.receiptRefs).toContain(trustReceiptExample.receiptId);
    expect(negotiationThreadExample.trustReceiptRefs).toContain(trustReceiptExample.receiptId);
    expect(negotiationThreadExample.outcomeRef).toBe(trustReceiptExample.evidence.outcomeRef);
    expect(negotiationThreadExample.collaborationContextRef).toBe(trustReceiptExample.evidence.collaborationContextRef);
    expect(persistentOrganizationExample.collaborationContextRefs).toContain(
      trustReceiptExample.evidence.collaborationContextRef as string
    );

    expect("collaborationContext" in (trustReceiptExample as unknown as Record<string, unknown>)).toBe(false);
    expect("handoffCapsule" in (trustEdgeExample as unknown as Record<string, unknown>)).toBe(false);
    expect("continuityState" in (persistentOrganizationExample as unknown as Record<string, unknown>)).toBe(false);
    expect("collaborationContext" in (negotiationThreadExample as unknown as Record<string, unknown>)).toBe(false);
  });
});
