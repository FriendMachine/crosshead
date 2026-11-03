import { createHash } from "crypto";
import { existsSync, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

import { schnorr } from "@noble/curves/secp256k1";
import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { OrganizationAttachmentSigningError, signOrganizationAttachmentChallenge } from "../../src/runtime/agent-organization-attachment";
import { agentFromCli } from "../../src/runtime/cli/agent";
import { generateRuntimeIdentity, setupRuntimeProfile } from "../../src/runtime/local-runtime";

const publicKey = (npub: string): Uint8Array => {
	const decoded = nip19.decode(npub);
	if (decoded.type !== "npub" || typeof decoded.data !== "string") throw new Error("expected npub");
	return new Uint8Array(Buffer.from(decoded.data, "hex"));
};

describe("local Crosshead organization attachment signing", () => {
	it("does not materialize a missing runtime home while rejecting a signing request", async () => {
		const parent = mkdtempSync(path.join(os.tmpdir(), "onlybots-organization-attachment-missing-"));
		try {
			const home = path.join(parent, "missing-runtime-home");
			const identity = generateRuntimeIdentity();
			const challenge = `onlybots_org_attach_v1:org_articul_local:agent_articul_operator:${identity.npub}:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ`;
			await expect(
				agentFromCli([
					"sign-organization-attachment",
					"--home",
					home,
					"--profile",
					"articul-operator",
					"--challenge",
					challenge,
				]),
			).rejects.toMatchObject({ code: "PERSISTENT_AGENT_REQUIRED" });
			expect(existsSync(home)).toBe(false);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("signs only a pending challenge bound to the active local persistent agent", async () => {
		const home = mkdtempSync(path.join(os.tmpdir(), "onlybots-organization-attachment-"));
		try {
			const identity = generateRuntimeIdentity();
			await setupRuntimeProfile({
				home,
				profileName: "articul-operator",
				apiBase: "http://127.0.0.1:0",
				npub: identity.npub,
				nsec: identity.nsec,
				memoryMode: "assist",
				workspaceScope: "repo",
			});
			const inspection = JSON.parse(
				await agentFromCli(["show", "--home", home, "--profile", "articul-operator", "--json"]),
			) as { agent: { agentRef: { agentId: string; npub: string } } };
			const challenge = `onlybots_org_attach_v1:org_articul_local:${inspection.agent.agentRef.agentId}:${identity.npub}:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ`;
			const signed = await signOrganizationAttachmentChallenge({
				home,
				profileName: "articul-operator",
				challenge,
			});
			expect(signed).toMatchObject({
				organizationId: "org_articul_local",
				agentId: inspection.agent.agentRef.agentId,
				npub: identity.npub,
				challengeDigest: `sha256:${createHash("sha256").update(challenge, "utf8").digest("hex")}`,
			});
			expect(JSON.stringify(signed)).not.toContain(identity.nsec);
			expect(signed.signature).toMatch(/^[a-f0-9]{128}$/);
			expect(await schnorr.verify(signed.signature, new TextEncoder().encode(challenge), publicKey(identity.npub))).toBe(true);

			const cli = JSON.parse(
				await agentFromCli([
					"sign-organization-attachment",
					"--home",
					home,
					"--profile",
					"articul-operator",
					"--challenge",
					challenge,
					"--json",
				]),
			) as { signature: string; agentId: string };
			expect(cli.agentId).toBe(inspection.agent.agentRef.agentId);
			expect(cli.signature).toMatch(/^[a-f0-9]{128}$/);
			expect(JSON.stringify(cli)).not.toContain(identity.nsec);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("refuses malformed or differently addressed challenges before signing", async () => {
		const home = mkdtempSync(path.join(os.tmpdir(), "onlybots-organization-attachment-boundary-"));
		try {
			const identity = generateRuntimeIdentity();
			await setupRuntimeProfile({
				home,
				profileName: "articul-operator",
				apiBase: "http://127.0.0.1:0",
				npub: identity.npub,
				nsec: identity.nsec,
				memoryMode: "assist",
				workspaceScope: "repo",
			});
			await agentFromCli(["show", "--home", home, "--profile", "articul-operator", "--json"]);
			for (const challenge of [
				"onlybots_org_attach_v1:org_articul_local:agent_other_operator:npub1invalid:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
				`onlybots_org_attach_v1:org_articul_local:agent_other_operator:${identity.npub}:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ`,
			]) {
				await expect(
					signOrganizationAttachmentChallenge({ home, profileName: "articul-operator", challenge }),
				).rejects.toBeInstanceOf(OrganizationAttachmentSigningError);
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
