import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";
import { generateSecretKey,getPublicKey,nip19 } from "nostr-tools";
import { parsePrivateMemoryErasureChallenge,signPrivateMemoryErasureChallenge } from "../../src/runtime/erasure-proof";
const origin="https://crosshead.sh";
const fixture=()=>{const key=generateSecretKey(),npub=nip19.npubEncode(getPublicKey(key));return{key,npub,nsec:nip19.nsecEncode(key),challenge:{purpose:"crosshead_erase_private_memory_v1" as const,origin,npub,nonce:"7".repeat(64),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}};};
const encode=(c:unknown)=>"crosshead_erase_private_memory_v1:"+Buffer.from(JSON.stringify(c)).toString("base64url");
describe("offline erasure signing",()=>{
	it("signs the domain-separated digest without exporting the private key",()=>{const f=fixture(),c=parsePrivateMemoryErasureChallenge(encode(f.challenge));const proof=signPrivateMemoryErasureChallenge(c,{npub:f.npub,apiBase:origin},f.nsec);const digest=createHash("sha256").update(JSON.stringify([c.purpose,c.origin,c.npub,c.nonce,c.issuedAt,c.expiresAt])).digest();expect(schnorr.verify(proof.signature,digest,getPublicKey(f.key))).toBe(true);expect(JSON.stringify(proof)).not.toContain(f.nsec);});
	it("rejects the wrong profile, wrong server, arbitrary signing payload and expired challenge",()=>{const f=fixture(),other=fixture();expect(()=>signPrivateMemoryErasureChallenge(f.challenge,{npub:other.npub,apiBase:origin},f.nsec)).toThrow();expect(()=>signPrivateMemoryErasureChallenge(f.challenge,{npub:f.npub,apiBase:"https://staging.crosshead.sh"},f.nsec)).toThrow();expect(()=>parsePrivateMemoryErasureChallenge("onlybots_link_"+"x".repeat(32))).toThrow();expect(()=>parsePrivateMemoryErasureChallenge(encode({...f.challenge,purpose:"crosshead_hosted_auth"}))).toThrow();expect(()=>parsePrivateMemoryErasureChallenge(encode({...f.challenge,expiresAt:new Date(Date.now()-1000).toISOString()}))).toThrow();});
});
