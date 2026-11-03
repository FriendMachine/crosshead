import { createHash } from "crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "fs";
import os from "os";
import path from "path";

import { describe, expect, it } from "vitest";

import {
	buildAgentIdentityAttestation,
	readAgentIdentityAttestation,
	verifyAgentIdentityAttestation,
	writeAgentIdentityAttestation,
	type AgentIdentityAttestation,
} from "../../src/runtime/agent-identity-attestation";
import { agentFromCli } from "../../src/runtime/cli/agent";
import { generateRuntimeIdentity, setupRuntimeProfile } from "../../src/runtime/local-runtime";

const exactDigest = (bytes: Uint8Array): string =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("local Crosshead agent identity attestation", () => {
	it("signs an active local-only persistent identity without making organization or execution claims", async () => {
		const home = mkdtempSync(path.join(os.tmpdir(), "onlybots-identity-attestation-"));
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
			// Attestation refuses to turn an otherwise valid profile into an identity
			// implicitly. The supported inspection command materializes it first.
			await expect(buildAgentIdentityAttestation({ home, profileName: "articul-operator" })).rejects.toMatchObject({
				code: "PERSISTENT_AGENT_REQUIRED",
			});
			const inspection = JSON.parse(
				await agentFromCli(["show", "--home", home, "--profile", "articul-operator", "--json"]),
			) as { agent: { agentRef: { agentId: string; npub: string } } };
			const built = await buildAgentIdentityAttestation({
				home,
				profileName: "articul-operator",
				now: () => "2026-09-21T04:42:16.033Z",
			});
			expect(built.attestation).toMatchObject({
				subject: inspection.agent.agentRef,
				ownerSystem: "onlybots",
				localRuntime: { apiBase: "http://127.0.0.1:0", persistentAgentStatus: "active" },
				claims: {
					keyPossessionAtIssue: true,
					localOnlyProfile: true,
					organizationMembership: "not_attested",
					hostAttachment: "not_attested",
					baseplateAuthority: "none",
					executionAuthority: "none",
				},
			});
			expect(built.evidenceRef).toBe(
				`onlybots.identity-attestation/v1:${built.attestation.signature.payloadSha256}`,
			);
			expect(built.evidenceRef.length).toBeLessThanOrEqual(128);
			expect(built.evidenceDigest).toBe(exactDigest(built.bytes));
			expect(built.bytes.toString("utf8")).not.toContain(identity.nsec);
			expect(await verifyAgentIdentityAttestation(built.attestation)).toBe(true);

			const output = path.join(home, "identity-evidence.json");
			writeAgentIdentityAttestation(output, built.bytes);
			expect(readFileSync(output)).toEqual(built.bytes);
			expect(statSync(output).mode & 0o777).toBe(0o600);
			const read = await readAgentIdentityAttestation(output);
			expect(read.evidenceDigest).toBe(exactDigest(built.bytes));
			expect(read.evidenceRef).toBe(built.evidenceRef);
			expect(read.attestation).toEqual(built.attestation);
			expect(() => writeAgentIdentityAttestation(output, built.bytes)).toThrow("OUTPUT_UNAVAILABLE");

			const cliOutput = path.join(home, "identity-evidence-cli.json");
			const cliWritten = JSON.parse(
				await agentFromCli([
					"attest-identity",
					"--home",
					home,
					"--profile",
					"articul-operator",
					"--output",
					cliOutput,
					"--json",
				]),
			) as { wrote: boolean; authority: string; agentId: string; npub: string };
			expect(cliWritten).toMatchObject({
				wrote: true,
				authority: "none",
				agentId: inspection.agent.agentRef.agentId,
				npub: inspection.agent.agentRef.npub,
			});
			const cliVerified = JSON.parse(
				await agentFromCli(["verify-identity", "--input", cliOutput, "--json"]),
			) as { valid: boolean; authority: string; agentId: string; npub: string };
			expect(cliVerified).toMatchObject({
				valid: true,
				authority: "none",
				agentId: inspection.agent.agentRef.agentId,
				npub: inspection.agent.agentRef.npub,
			});
			const changedAuthority: AgentIdentityAttestation = {
				...built.attestation,
				claims: { ...built.attestation.claims, executionAuthority: "none" },
			};
			changedAuthority.claims.baseplateAuthority = "unexpected" as never;
			expect(await verifyAgentIdentityAttestation(changedAuthority)).toBe(false);
			const changedSignature: AgentIdentityAttestation = {
				...built.attestation,
				signature: { ...built.attestation.signature, value: "0".repeat(128) },
			};
			expect(await verifyAgentIdentityAttestation(changedSignature)).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("refuses non-private and symlink destinations", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "onlybots-identity-attestation-boundary-"));
		try {
			const home = path.join(root, "home");
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
			const built = await buildAgentIdentityAttestation({ home, profileName: "articul-operator" });
			chmodSync(root, 0o755);
			expect(() => writeAgentIdentityAttestation(path.join(root, "public.json"), built.bytes)).toThrow(
				"PRIVATE_PARENT_REQUIRED",
			);
			chmodSync(root, 0o700);
			const link = path.join(root, "link.json");
			symlinkSync(path.join(home, "config", "runtime.json"), link);
			expect(() => writeAgentIdentityAttestation(link, built.bytes)).toThrow("OUTPUT_UNAVAILABLE");

			const ambiguousHome = path.join(root, "ambiguous-home");
			const ambiguousIdentity = generateRuntimeIdentity();
			await setupRuntimeProfile({
				home: ambiguousHome,
				profileName: "localhost-profile",
				apiBase: "http://localhost:0",
				npub: ambiguousIdentity.npub,
				nsec: ambiguousIdentity.nsec,
				memoryMode: "assist",
				workspaceScope: "repo",
			});
			await agentFromCli(["show", "--home", ambiguousHome, "--profile", "localhost-profile", "--json"]);
			await expect(buildAgentIdentityAttestation({ home: ambiguousHome, profileName: "localhost-profile" })).rejects.toMatchObject({
				code: "LOCAL_PROFILE_REQUIRED",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
