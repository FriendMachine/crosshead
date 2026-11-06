import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";
import { nip19, getPublicKey } from "nostr-tools";
const PURPOSE = "crosshead_erase_private_memory_v1";
export type PrivateMemoryErasureChallenge = { purpose: typeof PURPOSE; origin: string; npub: string; nonce: string; issuedAt: string; expiresAt: string };
export function parsePrivateMemoryErasureChallenge(text: string, now = new Date()): PrivateMemoryErasureChallenge {
	if (text.length > 4096 || !text.startsWith(PURPOSE+":")) throw new Error("Expected a deletion-specific Crosshead challenge");
	const encoded = text.slice(PURPOSE.length+1);
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid deletion challenge encoding");
	const c = JSON.parse(Buffer.from(encoded,"base64url").toString("utf8")) as PrivateMemoryErasureChallenge;
	if (!c || Object.keys(c).sort().join(",") !== "expiresAt,issuedAt,nonce,npub,origin,purpose" || c.purpose !== PURPOSE || typeof c.origin !== "string" || new URL(c.origin).origin !== c.origin || !c.origin.startsWith("https://") || !/^[a-f0-9]{64}$/.test(c.nonce) || nip19.decode(c.npub).type !== "npub") throw new Error("Invalid deletion challenge");
	const issued = Date.parse(c.issuedAt), expires = Date.parse(c.expiresAt);
	if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now.getTime()+60000 || expires <= now.getTime() || expires <= issued || expires-issued > 86400000) throw new Error("Deletion challenge is expired or has invalid lifetime");
	return c;
}
export function signPrivateMemoryErasureChallenge(c: PrivateMemoryErasureChallenge, profile: { npub: string; apiBase: string }, nsec: string) {
	if (c.npub !== profile.npub || c.origin !== new URL(profile.apiBase).origin) throw new Error("Deletion challenge does not match this profile's identity and server");
	const key = nip19.decode(nsec); if (key.type !== "nsec") throw new Error("Invalid local signing key");
	if (nip19.npubEncode(getPublicKey(key.data)) !== profile.npub) throw new Error("Local signing key does not match this profile");
	const message = JSON.stringify([c.purpose,c.origin,c.npub,c.nonce,c.issuedAt,c.expiresAt]);
	const digest = createHash("sha256").update(message).digest();
	return { challenge:c, signature:Buffer.from(schnorr.sign(digest,key.data)).toString("hex") };
}
