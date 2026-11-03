import { createHash } from "crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "fs";
import path from "path";

import { nowIso } from "./adapter-utils";
import { hashCanonicalPayload, signCanonicalPayload, verifyCanonicalPayloadSignature } from "./persistent-agent-utils";
import {
	ensureRuntimeHomeLayout,
	loadPersistentAgentEntity,
	loadProfile,
	loadSecret,
	type RuntimePaths,
} from "./runtime-persistence";

export const AGENT_IDENTITY_ATTESTATION_VERSION = "onlybots.agent-identity-attestation/v1" as const;
const MAX_ATTESTATION_BYTES = 64 << 10;
// Baseplate local enrollment caps source evidence references at 128 ASCII bytes.
// This 33-byte prefix plus `sha256:` and 64 lowercase hex is always 104 bytes.
const EVIDENCE_REF_PREFIX = "onlybots.identity-attestation/v1:";

export type AgentIdentityAttestationUnsigned = {
	schemaVersion: typeof AGENT_IDENTITY_ATTESTATION_VERSION;
	attestationId: string;
	issuedAt: string;
	ownerSystem: "onlybots";
	subject: {
		agentId: string;
		npub: string;
		lineageRoot: string;
	};
	localRuntime: {
		profileName: string;
		apiBase: string;
		memoryMode: string;
		workspaceScope: string;
		secureStoreMode: "file";
		persistentAgentStatus: "active";
	};
	claims: {
		keyPossessionAtIssue: true;
		localOnlyProfile: true;
		organizationMembership: "not_attested";
		hostAttachment: "not_attested";
		baseplateAuthority: "none";
		executionAuthority: "none";
	};
};

export type AgentIdentityAttestation = AgentIdentityAttestationUnsigned & {
	signature: {
		scheme: "nostr_schnorr";
		signedBy: string;
		payloadSha256: string;
		value: string;
	};
};

export type BuiltAgentIdentityAttestation = {
	attestation: AgentIdentityAttestation;
	evidenceRef: string;
	evidenceDigest: string;
	bytes: Buffer;
};

export class AgentIdentityAttestationError extends Error {
	constructor(readonly code: string) {
		super(`Agent identity attestation rejected: ${code}.`);
		this.name = "AgentIdentityAttestationError";
	}
}

const reject = (code: string): never => {
	throw new AgentIdentityAttestationError(code);
};

const privateOutputPath = (file: string): string => {
	if (!path.isAbsolute(file) || path.resolve(file) !== file) reject("OUTPUT_PATH_REQUIRED");
	const parent = path.dirname(file);
	let info: ReturnType<typeof lstatSync> | null = null;
	try {
		info = lstatSync(parent);
	} catch {
		reject("PRIVATE_PARENT_REQUIRED");
	}
	let canonicalParent = "";
	try {
		canonicalParent = realpathSync(parent);
	} catch {
		reject("PRIVATE_PARENT_REQUIRED");
	}
	const userID = process.getuid?.();
	if (
		info === null ||
		userID === undefined ||
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		Number(info.uid) !== userID ||
		(Number(info.mode) & 0o077) !== 0 ||
		canonicalParent !== parent
	)
		reject("PRIVATE_PARENT_REQUIRED");
	return file;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
	isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const isExactAttestation = (value: unknown): value is AgentIdentityAttestation => {
	if (
		!exactKeys(value, ["schemaVersion", "attestationId", "issuedAt", "ownerSystem", "subject", "localRuntime", "claims", "signature"]) ||
		!exactKeys(value.subject, ["agentId", "npub", "lineageRoot"]) ||
		!exactKeys(value.localRuntime, ["profileName", "apiBase", "memoryMode", "workspaceScope", "secureStoreMode", "persistentAgentStatus"]) ||
		!exactKeys(value.claims, ["keyPossessionAtIssue", "localOnlyProfile", "organizationMembership", "hostAttachment", "baseplateAuthority", "executionAuthority"]) ||
		!exactKeys(value.signature, ["scheme", "signedBy", "payloadSha256", "value"])
	)
		return false;
	return (
		value.schemaVersion === AGENT_IDENTITY_ATTESTATION_VERSION &&
		typeof value.attestationId === "string" && /^identityattestation_[a-f0-9]{32}$/.test(value.attestationId) &&
		typeof value.issuedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.issuedAt) &&
		value.ownerSystem === "onlybots" &&
		typeof value.subject.agentId === "string" && /^agent_[a-z0-9][a-z0-9_-]{2,127}$/.test(value.subject.agentId) &&
		typeof value.subject.npub === "string" &&
		typeof value.subject.lineageRoot === "string" && /^agent_[a-z0-9][a-z0-9_-]{2,127}$/.test(value.subject.lineageRoot) &&
		typeof value.localRuntime.profileName === "string" && /^[a-z][a-z0-9_-]{2,63}$/.test(value.localRuntime.profileName) &&
		value.localRuntime.apiBase === "http://127.0.0.1:0" &&
		typeof value.localRuntime.memoryMode === "string" &&
		typeof value.localRuntime.workspaceScope === "string" &&
		value.localRuntime.secureStoreMode === "file" &&
		value.localRuntime.persistentAgentStatus === "active" &&
		value.claims.keyPossessionAtIssue === true &&
		value.claims.localOnlyProfile === true &&
		value.claims.organizationMembership === "not_attested" &&
		value.claims.hostAttachment === "not_attested" &&
		value.claims.baseplateAuthority === "none" &&
		value.claims.executionAuthority === "none" &&
		value.signature.scheme === "nostr_schnorr" &&
		value.signature.signedBy === value.subject.npub &&
		typeof value.signature.payloadSha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(value.signature.payloadSha256) &&
		typeof value.signature.value === "string" && /^[a-f0-9]{128}$/.test(value.signature.value)
	);
};

/** Writes exact signed owner evidence without exposing the signing secret.
 * Existing files are never overwritten: their bytes may already be pinned in a
 * reviewed Baseplate enrollment manifest. */
export const writeAgentIdentityAttestation = (file: string, bytes: Uint8Array): void => {
	const output = privateOutputPath(file);
	let descriptor: number | null = null;
	let directoryDescriptor: number | null = null;
	try {
		descriptor = openSync(
			output,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = null;
		directoryDescriptor = openSync(path.dirname(output), constants.O_RDONLY);
		fsyncSync(directoryDescriptor);
		closeSync(directoryDescriptor);
		directoryDescriptor = null;
	} catch {
		// A caller must inspect a path before retrying; this command cannot infer
		// whether a lost acknowledgement followed a durable close.
		reject("OUTPUT_UNAVAILABLE");
	} finally {
		try {
			if (descriptor !== null) closeSync(descriptor);
		} catch {
			// Preserve the original write failure.
		}
		try {
			if (directoryDescriptor !== null) closeSync(directoryDescriptor);
		} catch {
			// Preserve the original write failure.
		}
	}
};

/** Reads only this command's exact canonical private file encoding. It does not
 * open a profile or secret, so an administrator can verify a reviewed evidence
 * file without granting an observer access to the runtime signing material. */
export const readAgentIdentityAttestation = async (file: string): Promise<BuiltAgentIdentityAttestation> => {
	if (!path.isAbsolute(file) || path.resolve(file) !== file) reject("EVIDENCE_PATH_REQUIRED");
	let descriptor: number | null = null;
	try {
		descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const before = fstatSync(descriptor);
		if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_ATTESTATION_BYTES)
			reject("EVIDENCE_FILE_INVALID");
		const bytes = readFileSync(descriptor);
		const after = fstatSync(descriptor);
		if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			reject("EVIDENCE_FILE_CHANGED");
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			reject("EVIDENCE_FILE_INVALID");
		}
		if (!isExactAttestation(value)) return reject("EVIDENCE_FILE_INVALID");
		const attestation: AgentIdentityAttestation = value;
		if (!bytes.equals(Buffer.from(JSON.stringify(attestation, null, 2) + "\n"))) reject("EVIDENCE_FILE_INVALID");
		if (!(await verifyAgentIdentityAttestation(attestation))) reject("SIGNATURE_INVALID");
		return {
			attestation,
			evidenceRef: `${EVIDENCE_REF_PREFIX}${attestation.signature.payloadSha256}`,
			evidenceDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
			bytes,
		};
	} catch (error) {
		if (error instanceof AgentIdentityAttestationError) throw error;
		return reject("EVIDENCE_FILE_UNAVAILABLE");
	} finally {
		try {
			if (descriptor !== null) closeSync(descriptor);
		} catch {
			// Preserve the original read/verification failure.
		}
	}
};

const profileAndAgent = (paths: RuntimePaths, profileName: string) => {
	const profile = loadProfile(paths, profileName);
	const secret = loadSecret(paths, profileName);
	// A local runtime may accept `localhost` for ordinary local development, but
	// owner evidence must not depend on host-name resolution. Baseplate's local
	// enrollment configuration likewise requires a numeric loopback endpoint.
	if (!profile || !secret || profile.apiBase !== "http://127.0.0.1:0") return reject("LOCAL_PROFILE_REQUIRED");
	const agentID = profile.agentId ?? profile.name;
	const agent = loadPersistentAgentEntity(paths, agentID);
	if (!agent) return reject("PERSISTENT_AGENT_REQUIRED");
	if (
		agent.status !== "active" ||
		agent.agentRef.agentId !== agentID ||
		agent.agentRef.npub !== profile.npub ||
		agent.agentRef.lineageRoot !== (profile.lineageRoot ?? agentID)
	)
		return reject("PERSISTENT_AGENT_REQUIRED");
	return { profile, secret, agent };
};

/** Produces signed evidence of a materialized local Crosshead identity. It does
 * not attest hosted organization/federation state, host attachment, Baseplate
 * admission, or an execution capability; those have their own owner evidence. */
export const buildAgentIdentityAttestation = async (
	input: { home: string; profileName: string; now?: () => string },
): Promise<BuiltAgentIdentityAttestation> => {
	if (!/^[a-z][a-z0-9_-]{2,63}$/.test(input.profileName)) reject("PROFILE_NAME_INVALID");
	const paths = ensureRuntimeHomeLayout(input.home);
	const { profile, secret, agent } = profileAndAgent(paths, input.profileName);
	const issuedAt = (input.now ?? nowIso)();
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(issuedAt)) reject("CLOCK_INVALID");
	const seed = hashCanonicalPayload({
		schemaVersion: AGENT_IDENTITY_ATTESTATION_VERSION,
		agentID: agent.agentRef.agentId,
		issuedAt,
	});
	const unsigned: AgentIdentityAttestationUnsigned = {
		schemaVersion: AGENT_IDENTITY_ATTESTATION_VERSION,
		attestationId: `identityattestation_${seed.slice("sha256:".length, "sha256:".length + 32)}`,
		issuedAt,
		ownerSystem: "onlybots",
		subject: {
			agentId: agent.agentRef.agentId,
			npub: agent.agentRef.npub,
			lineageRoot: agent.agentRef.lineageRoot,
		},
		localRuntime: {
			profileName: profile.name,
			apiBase: profile.apiBase,
			memoryMode: profile.memoryMode,
			workspaceScope: profile.workspaceScope,
			secureStoreMode: profile.secureStoreMode,
			persistentAgentStatus: "active",
		},
		claims: {
			keyPossessionAtIssue: true,
			localOnlyProfile: true,
			organizationMembership: "not_attested",
			hostAttachment: "not_attested",
			baseplateAuthority: "none",
			executionAuthority: "none",
		},
	};
	const signed = await signCanonicalPayload(unsigned, secret.nsec);
	if (!(await verifyCanonicalPayloadSignature(unsigned, agent.agentRef.npub, signed.signature, signed.payloadHash)))
		reject("SIGNATURE_INVALID");
	const attestation: AgentIdentityAttestation = {
		...unsigned,
		signature: {
			scheme: "nostr_schnorr",
			signedBy: agent.agentRef.npub,
			payloadSha256: signed.payloadHash,
			value: signed.signature,
		},
	};
	const bytes = Buffer.from(JSON.stringify(attestation, null, 2) + "\n");
	const evidenceDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	return {
		attestation,
		evidenceRef: `${EVIDENCE_REF_PREFIX}${signed.payloadHash}`,
		evidenceDigest,
		bytes,
	};
};

/** A valid signature proves only the exact local identity snapshot. It does not
 * upgrade the deliberately absent organization, host, Baseplate or execution
 * authority claims embedded in the signed record. */
export const verifyAgentIdentityAttestation = async (value: AgentIdentityAttestation): Promise<boolean> => {
	if (
		value.schemaVersion !== AGENT_IDENTITY_ATTESTATION_VERSION ||
		value.ownerSystem !== "onlybots" ||
		value.signature?.scheme !== "nostr_schnorr" ||
		value.signature.signedBy !== value.subject.npub ||
		value.localRuntime?.apiBase !== "http://127.0.0.1:0" ||
		value.claims?.keyPossessionAtIssue !== true ||
		value.claims?.localOnlyProfile !== true ||
		value.claims?.organizationMembership !== "not_attested" ||
		value.claims?.hostAttachment !== "not_attested" ||
		value.claims?.baseplateAuthority !== "none" ||
		value.claims?.executionAuthority !== "none"
	)
		return false;
	const { signature, ...unsigned } = value;
	return verifyCanonicalPayloadSignature(unsigned, value.subject.npub, signature.value, signature.payloadSha256);
};
