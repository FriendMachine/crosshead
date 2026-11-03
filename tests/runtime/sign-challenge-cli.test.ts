import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

import { schnorr } from "@noble/curves/secp256k1";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { afterEach, describe, expect, it } from "vitest";

import { signChallengeFromCli } from "../../src/runtime/cli/organization";
import { setupRuntimeProfile } from "../../src/runtime/local-runtime";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const makeProfile = async (profileName: string, home?: string) => {
	const resolvedHome = home ?? mkdtempSync(path.join(os.tmpdir(), "ob-sign-challenge-"));
	if (!home) homes.push(resolvedHome);
	const key = generateSecretKey();
	const npub = nip19.npubEncode(getPublicKey(key));
	await setupRuntimeProfile({ home: resolvedHome, profileName, apiBase: "http://127.0.0.1:0", npub, nsec: nip19.nsecEncode(key), makeDefault: !home });
	return { home: resolvedHome, npub, pubkey: getPublicKey(key) };
};

const verifies = (signature: string, text: string, pubkey: string) =>
	schnorr.verify(Buffer.from(signature, "hex"), new TextEncoder().encode(text), pubkey);

describe("crosshead sign-challenge", () => {
	it("signs npub-link and organization-attach challenges with the profile key", async () => {
		const { home, npub, pubkey } = await makeProfile("backend");
		const link = "onlybots_link_Ej5skL82CjC81YnsDh7NgdFE-gOMUbiO-7qEZ4pRNCU";
		const linked = JSON.parse(await signChallengeFromCli([link, "--home", home, "--json"]));
		expect(linked.npub).toBe(npub);
		expect(verifies(linked.signature, link, pubkey)).toBe(true);

		const attach = `onlybots_org_attach_v1:org_5b640a22-c7c9-477d-83cd-4bac406e6385:agent_backend:${npub}:VZmT-Mz_w-ZOoDWSz2kXG273Ly8r9t6VpNp7OqWNra0`;
		const text = await signChallengeFromCli([attach, "--home", home]);
		const signature = text.trim().split("\n").at(-1)!;
		expect(text).toContain("Paste this into the console");
		expect(verifies(signature, attach, pubkey)).toBe(true);
	});

	it("refuses anything that isn't a console challenge, and attach challenges for another agent", async () => {
		const { home } = await makeProfile("backend");
		const other = await makeProfile("frontend", home);
		await expect(signChallengeFromCli(["a".repeat(64), "--home", home])).rejects.toThrow("isn't a Crosshead console challenge");
		const forOther = `onlybots_org_attach_v1:org_x:agent_frontend:${other.npub}:VZmT-Mz_w-ZOoDWSz2kXG273Ly8r9t6VpNp7OqWNra0`;
		// Attach challenges name the agent, so the matching profile is picked automatically.
		const picked = JSON.parse(await signChallengeFromCli([forOther, "--home", home, "--json"]));
		expect(picked.profile).toBe("frontend");
		expect(verifies(picked.signature, forOther, other.pubkey)).toBe(true);
		await expect(signChallengeFromCli([forOther, "--home", home, "--profile", "backend"])).rejects.toThrow("but profile backend is");
		const signed = JSON.parse(await signChallengeFromCli([forOther, "--home", home, "--profile", "frontend", "--json"]));
		expect(verifies(signed.signature, forOther, other.pubkey)).toBe(true);
		await expect(signChallengeFromCli(["--home", home])).rejects.toThrow("Usage: crosshead sign-challenge");
	});

	it("uses --npub to pick the right profile for link challenges, and refuses keys it doesn't have", async () => {
		const { home } = await makeProfile("default-agent");
		const other = await makeProfile("claude-agent", home);
		const link = "onlybots_link__F06wZGQ48kkwqndTOnBRlGM3_ImlxBZY-Jhzfgu6MQ";
		const signed = JSON.parse(await signChallengeFromCli([link, "--npub", other.npub, "--home", home, "--json"]));
		expect(signed.profile).toBe("claude-agent");
		expect(verifies(signed.signature, link, other.pubkey)).toBe(true);
		const missing = nip19.npubEncode(getPublicKey(generateSecretKey()));
		await expect(signChallengeFromCli([link, "--npub", missing, "--home", home])).rejects.toThrow("No Crosshead profile on this machine has the key");
		const attach = `onlybots_org_attach_v1:org_x:agent_y:${other.npub}:VZmT-Mz_w-ZOoDWSz2kXG273Ly8r9t6VpNp7OqWNra0`;
		await expect(signChallengeFromCli([attach, "--npub", missing, "--home", home])).rejects.toThrow("This challenge is for");
	});
});
