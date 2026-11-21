import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { ORGANIZATION_CHARTER_SCHEMA_VERSION, organizationCharterPayload, validateSignedOrganizationCharter } from "../../src/protocol/organization-charter";
import { buildPersistentOrganizationDraft } from "../../src/protocol/economic-governance";
import { signCanonicalPayload, verifyAgentDealSignature } from "../../src/runtime/agent-deals";

const key = () => {
	const secret = generateSecretKey();
	return { nsec: nip19.nsecEncode(secret), npub: nip19.npubEncode(getPublicKey(secret)) };
};

describe("organization charters", () => {
	it("are signed by a founding agent and verify against their canonical payload", () => {
		const founder = key();
		const outsider = key();
		const document = buildPersistentOrganizationDraft({
			organizationId: "org_charter_test",
			npub: founder.npub,
			displayName: "Charter Test",
			summary: "Test organization",
			founderAgentRefs: [{ agentId: "agent_founder", npub: founder.npub, lineageRoot: "agent_founder" }],
			createdAt: "2026-11-21T00:00:00.000Z",
		});
		const unsigned = { schemaVersion: ORGANIZATION_CHARTER_SCHEMA_VERSION, document, signerNpub: founder.npub } as const;
		const signed = { ...unsigned, signature: signCanonicalPayload(organizationCharterPayload(unsigned), founder.nsec) };
		expect(validateSignedOrganizationCharter(signed)).toEqual([]);
		expect(verifyAgentDealSignature({ canonicalPayload: organizationCharterPayload(signed), signature: signed.signature, signerNpub: founder.npub })).toBe(true);

		const tampered = { ...signed, document: { ...document, identity: { ...document.identity, displayName: "Other" } } };
		expect(verifyAgentDealSignature({ canonicalPayload: organizationCharterPayload(tampered), signature: signed.signature, signerNpub: founder.npub })).toBe(false);
		expect(validateSignedOrganizationCharter({ ...signed, signerNpub: outsider.npub })).toContain("charter must be signed by one of its founding agents");
	});
});
