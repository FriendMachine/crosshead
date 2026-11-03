import { TextEncoder } from "util";
import { schnorr } from "@noble/curves/secp256k1";
import { nip19 } from "nostr-tools";

import { createHash } from "crypto";

const textEncoder = new TextEncoder();
const hasher = { sha256Hex: (data: string): string => createHash("sha256").update(data).digest("hex") };

export const canonicalizeJson = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
    .join(",")}}`;
};

export const sanitizePersistentAgentToken = (value: string, fallback: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
};

export const normalizePersistentAgentId = (value: string): string =>
  value.startsWith("agent_") ? value : `agent_${sanitizePersistentAgentToken(value, "default")}`;

const decodeNsecPrivateKey = (nsec: string): Uint8Array => {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") {
    throw new Error("Expected an nsec secret for lineage signing");
  }
  return decoded.data;
};

const decodeNpubPublicKey = (npub: string): Uint8Array => {
  const decoded = nip19.decode(npub);
  if (decoded.type !== "npub") {
    throw new Error("Expected an npub public key for lineage verification");
  }
  const hex = typeof decoded.data === "string" ? decoded.data : Buffer.from(decoded.data).toString("hex");
  return new Uint8Array(Buffer.from(hex, "hex"));
};

export const hashCanonicalPayload = (payload: unknown): string => `sha256:${hasher.sha256Hex(canonicalizeJson(payload))}`;

export const signCanonicalPayload = async (
  payload: unknown,
  nsec: string
): Promise<{ payloadHash: string; signature: string }> => {
  const canonical = canonicalizeJson(payload);
  const signatureBytes = await schnorr.sign(textEncoder.encode(canonical), decodeNsecPrivateKey(nsec));
  return {
    payloadHash: `sha256:${hasher.sha256Hex(canonical)}`,
    signature: Buffer.from(signatureBytes).toString("hex"),
  };
};

export const verifyCanonicalPayloadSignature = async (
  payload: unknown,
  npub: string,
  signature: string,
  expectedPayloadHash?: string | null
): Promise<boolean> => {
  try {
    const canonical = canonicalizeJson(payload);
    const payloadHash = `sha256:${hasher.sha256Hex(canonical)}`;
    if (typeof expectedPayloadHash === "string" && expectedPayloadHash.length > 0 && expectedPayloadHash !== payloadHash) {
      return false;
    }
    const signatureBytes = new Uint8Array(Buffer.from(signature, "hex"));
    return await schnorr.verify(signatureBytes, textEncoder.encode(canonical), decodeNpubPublicKey(npub));
  } catch {
    return false;
  }
};
