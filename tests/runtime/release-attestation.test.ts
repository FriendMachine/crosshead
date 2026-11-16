import { describe, expect, it, vi } from "vitest";
import { compress } from "snappyjs";
import { verifyGitHubReleaseAttestation } from "../../src/runtime/release-attestation";

const version = "0.5.0-alpha.14";
const digest = "b".repeat(64);
const identity = `https://github.com/FriendMachine/crosshead/.github/workflows/release.yml@refs/tags/v${version}`;
const bundleUrl = "https://tmaproduction.blob.core.windows.net/test.json.sn?sig=secret";
const statement = () => ({
	_type: "https://in-toto.io/Statement/v1",
	predicateType: "https://slsa.dev/provenance/v1",
	subject: [{ name: `crosshead-runtime-install-${version}.tgz`, digest: { sha256: digest } }],
	predicate: {
		runDetails: { builder: { id: identity } },
		buildDefinition: {
			buildType: "https://actions.github.io/buildtypes/workflow/v1",
			externalParameters: { workflow: {
			ref: `refs/tags/v${version}`,
			repository: "https://github.com/FriendMachine/crosshead",
			path: ".github/workflows/release.yml",
			} },
		},
	},
});
const bundle = (payload = statement()) => ({
	mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
	verificationMaterial: {},
	dsseEnvelope: {
		payloadType: "application/vnd.in-toto+json",
		payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
	},
});
const fixture = (options: { payload?: ReturnType<typeof statement>; url?: string; compressed?: Buffer; signer?: string } = {}) => {
	const compressed = options.compressed ?? Buffer.from(compress(Buffer.from(JSON.stringify(bundle(options.payload)))));
	const fetcher = vi.fn(async (url: string) => new Response(
		url.startsWith("https://api.github.com/")
			? JSON.stringify({ attestations: [{ repository_id: 1443704033, bundle_url: options.url ?? bundleUrl }] })
			: compressed
	)) as unknown as typeof fetch;
	const verifyBundle = vi.fn(async () => ({ identity: {
		subjectAlternativeName: options.signer ?? identity,
		extensions: { issuer: "https://token.actions.githubusercontent.com" },
	} })) as unknown as typeof import("sigstore").verify;
	return { fetcher, verifyBundle };
};

describe("signed GitHub release attestation", () => {
	it("accepts only the exact release workflow, archive digest, and Sigstore signer", async () => {
		const deps = fixture();
		await verifyGitHubReleaseAttestation(version, digest, deps);
		expect(deps.fetcher).toHaveBeenCalledTimes(2);
		expect(deps.verifyBundle).toHaveBeenCalledOnce();
		expect(vi.mocked(deps.verifyBundle).mock.calls[0]?.[1]).toMatchObject({
			certificateIssuer: "https://token.actions.githubusercontent.com",
			certificateIdentityURI: expect.stringContaining("refs/tags/v0\\.5\\.0-alpha\\.14$"),
			tlogThreshold: 1,
			ctLogThreshold: 1,
		});
	});
	it("rejects a provenance subject or workflow that differs from the target release", async () => {
		for (const changed of [
			{ ...statement(), subject: [{ name: `crosshead-runtime-install-${version}.tgz`, digest: { sha256: "a".repeat(64) } }] },
			{ ...statement(), predicate: { ...statement().predicate, runDetails: { builder: { id: identity.replace("FriendMachine", "attacker") } } } },
		]) {
			const deps = fixture({ payload: changed });
			await expect(verifyGitHubReleaseAttestation(version, digest, deps)).rejects.toThrow("No valid signed");
			expect(deps.verifyBundle).not.toHaveBeenCalled();
		}
	});
	it("rejects a mismatched certificate identity or unsafe bundle URL", async () => {
		const wrongSigner = fixture({ signer: identity.replace("FriendMachine", "attacker") });
		await expect(verifyGitHubReleaseAttestation(version, digest, wrongSigner)).rejects.toThrow("No valid signed");
		for (const url of ["http://tmaproduction.blob.core.windows.net/test.json.sn", "https://evil.example/test.json.sn", "https://user:secret@tmaproduction.blob.core.windows.net/test.json.sn"]) {
			const deps = fixture({ url });
			await expect(verifyGitHubReleaseAttestation(version, digest, deps)).rejects.toThrow("No valid signed");
			expect(deps.fetcher).toHaveBeenCalledTimes(1);
		}
	});
	it("rejects a bundle with both DSSE and message-signature content", async () => {
		const mixed = { ...bundle(), messageSignature: { messageDigest: { algorithm: "SHA2_256", digest: "" }, signature: "" } };
		const deps = fixture({ compressed: Buffer.from(compress(Buffer.from(JSON.stringify(mixed)))) });
		await expect(verifyGitHubReleaseAttestation(version, digest, deps)).rejects.toThrow("No valid signed");
		expect(deps.verifyBundle).not.toHaveBeenCalled();
	});
	it("rejects a compressed bundle that expands beyond the limit before verifying it", async () => {
		const deps = fixture({ compressed: Buffer.from(compress(Buffer.alloc(1024 * 1024 + 1))) });
		await expect(verifyGitHubReleaseAttestation(version, digest, deps)).rejects.toThrow("No valid signed");
		expect(deps.verifyBundle).not.toHaveBeenCalled();
	});
});
