import { createHash } from "crypto";

import { schnorr } from "@noble/curves/secp256k1";
import { nip19 } from "nostr-tools";

import {
	loadPersistentAgentEntity,
	loadProfile,
	loadSecret,
	resolveRuntimePaths,
} from "./runtime-persistence";

const AGENT_ID_PATTERN = /^agent_[a-z0-9][a-z0-9_-]{2,127}$/;
const ORGANIZATION_ID_PATTERN = /^org_[a-z0-9][a-z0-9_-]{2,127}$/;
const ATTACHMENT_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class OrganizationAttachmentSigningError extends Error {
	constructor(readonly code: string) {
		super(`Organization attachment signing rejected: ${code}.`);
		this.name = "OrganizationAttachmentSigningError";
	}
}

const reject = (code: string): never => {
	throw new OrganizationAttachmentSigningError(code);
};

const canonicalNpub = (value: string): Uint8Array => {
	try {
		const decoded = nip19.decode(value);
		if (decoded.type !== "npub" || typeof decoded.data !== "string" || nip19.npubEncode(decoded.data) !== value)
			return reject("CHALLENGE_INVALID");
		return new Uint8Array(Buffer.from(decoded.data, "hex"));
	} catch {
		return reject("CHALLENGE_INVALID");
	}
};

const nsecPrivateKey = (value: string): Uint8Array => {
	try {
		const decoded = nip19.decode(value);
		if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) return reject("PROFILE_SECRET_INVALID");
		return decoded.data;
	} catch {
		return reject("PROFILE_SECRET_INVALID");
	}
};

const challengeParts = (challenge: string) => {
	if (challenge.trim() !== challenge || challenge.length > 512) return reject("CHALLENGE_INVALID");
	const parts = challenge.split(":");
	if (
		parts.length !== 5 ||
		parts[0] !== "onlybots_org_attach_v1" ||
		!ORGANIZATION_ID_PATTERN.test(parts[1] ?? "") ||
		!AGENT_ID_PATTERN.test(parts[2] ?? "") ||
		!ATTACHMENT_NONCE_PATTERN.test(parts[4] ?? "")
	)
		return reject("CHALLENGE_INVALID");
	canonicalNpub(parts[3] ?? "");
	return {
		organizationId: parts[1]!,
		agentId: parts[2]!,
		npub: parts[3]!,
	};
};

/** Signs only the existing organization attachment challenge grammar. It makes
 * no HTTP request and cannot create a membership, host attachment or authority.
 * The returned proof is bound to the active local persistent agent and profile. */
export const signOrganizationAttachmentChallenge = async (input: {
	home: string;
	profileName: string;
	challenge: string;
}): Promise<{
	organizationId: string;
	agentId: string;
	npub: string;
	challengeDigest: string;
	signature: string;
}> => {
	if (!/^[a-z][a-z0-9_-]{2,63}$/.test(input.profileName)) reject("PROFILE_NAME_INVALID");
	const challenge = challengeParts(input.challenge);
	const paths = resolveRuntimePaths(input.home);
	const profile = loadProfile(paths, input.profileName);
	const secret = loadSecret(paths, input.profileName);
	if (profile === null || secret === null || typeof profile.agentId !== "string")
		return reject("PERSISTENT_AGENT_REQUIRED");
	const agentId = profile.agentId;
	const agent = loadPersistentAgentEntity(paths, agentId);
	if (
		agent === null ||
		agent.status !== "active" ||
		agent.agentRef.agentId !== agentId ||
		agent.agentRef.npub !== profile.npub ||
		challenge.agentId !== agentId ||
		challenge.npub !== profile.npub
	)
		return reject("CHALLENGE_SUBJECT_MISMATCH");
	const publicKey = canonicalNpub(profile.npub);
	const signature = Buffer.from(
		await schnorr.sign(new TextEncoder().encode(input.challenge), nsecPrivateKey(secret.nsec)),
	).toString("hex");
	if (!(await schnorr.verify(signature, new TextEncoder().encode(input.challenge), publicKey)))
		reject("SIGNATURE_INVALID");
	return {
		organizationId: challenge.organizationId,
		agentId,
		npub: profile.npub,
		challengeDigest: `sha256:${createHash("sha256").update(input.challenge, "utf8").digest("hex")}`,
		signature,
	};
};
