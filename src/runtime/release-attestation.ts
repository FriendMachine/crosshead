import { verify } from "sigstore";
import { uncompress } from "snappyjs";

const REPOSITORY = "https://github.com/FriendMachine/crosshead";
const WORKFLOW = ".github/workflows/release.yml";
const ISSUER = "https://token.actions.githubusercontent.com";
const REPOSITORY_ID = 1443704033;
const MAX_API_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024;
const MAX_BUNDLES = 5;
const VERIFY_DEADLINE_MS = 30_000;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

type BundleVerifier = typeof verify;
type Fetcher = typeof fetch;

const fetchBounded = async (url: string, maxBytes: number, fetcher: Fetcher, deadline: number): Promise<Buffer> => {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("GitHub release attestation verification timed out");
	let response: Response;
	try {
		response = await fetcher(url, {
			redirect: "error",
			signal: AbortSignal.timeout(Math.min(10_000, remaining)),
			headers: { Accept: "application/vnd.github+json", "User-Agent": "crosshead-runtime-updater" },
		});
	} catch {
		throw new Error("Could not fetch GitHub release attestation");
	}
	if (!response.ok || !response.body) throw new Error("GitHub release attestation is unavailable");
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > maxBytes) throw new Error("GitHub release attestation exceeds size limit");
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > maxBytes) throw new Error("GitHub release attestation exceeds size limit");
			chunks.push(Buffer.from(part.value));
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks);
};

const allowedBundleUrl = (raw: string): boolean => {
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && url.hostname === "tmaproduction.blob.core.windows.net" &&
			url.port === "" && !url.username && !url.password && url.pathname.endsWith(".json.sn") && !url.hash;
	} catch { return false; }
};

const statementMatches = (bundle: any, version: string, digest: string): boolean => {
	if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) ||
		Object.keys(bundle).length !== 3 || !Object.hasOwn(bundle, "verificationMaterial") ||
		!Object.hasOwn(bundle, "dsseEnvelope") || Object.hasOwn(bundle, "messageSignature") ||
		bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json" ||
		bundle.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json" ||
		typeof bundle.dsseEnvelope.payload !== "string") return false;
	let statement: any;
	try { statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8")); }
	catch { return false; }
	const ref = `refs/tags/v${version}`;
	const identity = `${REPOSITORY}/${WORKFLOW}@${ref}`;
	return statement?._type === "https://in-toto.io/Statement/v1" &&
		statement.predicateType === "https://slsa.dev/provenance/v1" &&
		statement.predicate?.runDetails?.builder?.id === identity &&
		statement.predicate?.buildDefinition?.buildType === "https://actions.github.io/buildtypes/workflow/v1" &&
		statement.predicate?.buildDefinition?.externalParameters?.workflow?.repository === REPOSITORY &&
		statement.predicate?.buildDefinition?.externalParameters?.workflow?.path === WORKFLOW &&
		statement.predicate?.buildDefinition?.externalParameters?.workflow?.ref === ref &&
		Array.isArray(statement.subject) && statement.subject.some((subject: any) =>
			subject?.name === `crosshead-runtime-install-${version}.tgz` && subject?.digest?.sha256 === digest);
};

/** Verify the exact release asset was built by this repository's release workflow.
 * The hosted install page and GitHub API may select a candidate, but cannot
 * authorize code installation without a valid Sigstore bundle and provenance. */
export const verifyGitHubReleaseAttestation = async (
	version: string,
	digest: string,
	deps: { fetcher?: Fetcher; verifyBundle?: BundleVerifier } = {}
): Promise<void> => {
	if (!EXACT_VERSION.test(version) || !SHA256.test(digest)) throw new Error("Invalid attested release version or digest");
	const fetcher = deps.fetcher ?? fetch;
	const verifyBundle = deps.verifyBundle ?? verify;
	const deadline = Date.now() + VERIFY_DEADLINE_MS;
	const url = `https://api.github.com/repos/FriendMachine/crosshead/attestations/sha256:${digest}?per_page=${MAX_BUNDLES}`;
	let listing: any;
	try { listing = JSON.parse((await fetchBounded(url, MAX_API_BYTES, fetcher, deadline)).toString("utf8")); }
	catch (error) {
		if (error instanceof SyntaxError) throw new Error("GitHub release attestation response was invalid");
		throw error;
	}
	if (!Array.isArray(listing?.attestations) || listing.attestations.length > MAX_BUNDLES) {
		throw new Error("GitHub release attestation response was invalid");
	}
	const identity = `${REPOSITORY}/${WORKFLOW}@refs/tags/v${version}`;
	const escapedIdentity = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (const entry of listing.attestations) {
		if (entry?.repository_id !== REPOSITORY_ID || typeof entry.bundle_url !== "string" || !allowedBundleUrl(entry.bundle_url)) continue;
		try {
			const compressed = await fetchBounded(entry.bundle_url, MAX_BUNDLE_BYTES, fetcher, deadline);
			const bundle = JSON.parse(Buffer.from(uncompress(compressed, MAX_BUNDLE_BYTES)).toString("utf8"));
			if (!statementMatches(bundle, version, digest)) continue;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("GitHub release attestation verification timed out");
			let timer: NodeJS.Timeout | undefined;
			try {
				const signer = await Promise.race([
					verifyBundle(bundle, {
						certificateIssuer: ISSUER,
						certificateIdentityURI: `^${escapedIdentity}$`,
						tlogThreshold: 1,
						ctLogThreshold: 1,
						timeout: Math.min(5_000, remaining),
						retry: 0,
					}),
					new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Sigstore verification timed out")), remaining); }),
				]);
				if (signer.identity?.subjectAlternativeName === identity && signer.identity.extensions?.issuer === ISSUER) return;
			} finally { if (timer) clearTimeout(timer); }
		} catch { /* A malformed or untrusted bundle cannot authorize installation. */ }
	}
	throw new Error("No valid signed Crosshead release attestation matched the archive digest");
};
